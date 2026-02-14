import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { symbolsData } from '../symbols.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.static(path.join(__dirname, '../')));

// HTTP Server
const server = app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda yayında`);
    startTradingViewConnection();
});

// WebSocket Server (Frontend için)
const wss = new WebSocketServer({ server });

let browser = null;
let page = null;
let latestPrices = {};

// Sembol Mapping
function getSymbolForCategory(symbol, category) {
    if (category === 'KRIPTO') {
        const manualMap = {
            'BTC': 'BINANCE:BTCUSDT',
            'ETH': 'BINANCE:ETHUSDT',
            'SOL': 'BINANCE:SOLUSDT',
            'AVAX': 'BINANCE:AVAXUSDT',
            'XRP': 'BINANCE:XRPUSDT',
        };
        return manualMap[symbol] || `BINANCE:${symbol}USDT`;
    }
    if (category === 'BORSA ISTANBUL') return `BIST:${symbol}`;
    if (category === 'EXCHANGE') return `FX_IDC:${symbol}`;
    if (category === 'ENDEKSLER') return `TVC:${symbol}`;
    if (category === 'EMTIA') return `TVC:${symbol}`; // Altın vb.
    if (category === 'STOCKS') return `NASDAQ:${symbol}`;

    return `BINANCE:${symbol}USDT`;
}

function prepareAllSymbols() {
    const formattedSymbols = [];
    Object.entries(symbolsData).forEach(([category, symbols]) => {
        symbols.forEach(sym => {
            formattedSymbols.push(getSymbolForCategory(sym, category));
        });
    });
    return [...new Set(formattedSymbols)];
}

// ---------------------------------------------------------
// CORE LOGIC: Lightweight Browser + Direct Socket Injection
// ---------------------------------------------------------

async function startTradingViewConnection() {
    console.log('🌐 TradingView Bağlantısı Başlatılıyor (Low RAM Mode)...');

    if (browser) await browser.close();

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage', // Memory fix
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--mute-audio',
        '--disable-blink-features=AutomationControlled'
    ];

    browser = await chromium.launch({
        headless: true,
        args: args
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 800, height: 600 }
    });

    // Oturum Cookie'leri (Bununla veri çekmek daha kolay)
    await context.addCookies([
        { name: 'sessionid', value: 'owdl1knxegxizb3jz4jub973l3jf8r5h', domain: '.tradingview.com', path: '/' },
        { name: 'sessionid_sign', value: 'v3:vTg6tTsF73zJMZdotbHAjbi4gIaUtfLj8zpEbrnhJHQ=', domain: '.tradingview.com', path: '/' },
        { name: 'tv_ecuid', value: '5f98ac9a-cd0a-4198-bbde-e643744083fc', domain: '.tradingview.com', path: '/' }
    ]);

    page = await context.newPage();

    // RAM OPTİMİZASYONU: Resim, Font, CSS, Video vs. TAMAMEN ENGELLE
    await page.route('**/*.{png,jpg,jpeg,gif,css,woff,woff2,svg,mp4,webp,ico,js}', route => {
        // Sadece ana document ve gerekli xhr isteklerine izin ver
        // Aslında JS lazım olabilir auth için ama tv-chart.js gibi ağır şeyleri engelleyebiliriz
        // Şimdilik sadece medya ve CSS engelleyelim
        if (route.request().resourceType() === 'image' || route.request().resourceType() === 'stylesheet' || route.request().resourceType() === 'font') {
            return route.abort();
        }
        return route.continue();
    });

    // Console loglarını terminale aktar
    page.on('console', msg => {
        const txt = msg.text();
        if (txt.includes('WS-LOG:')) console.log(txt.replace('WS-LOG:', '📡'));
    });

    // Browser'dan Node.js ortamına veri aktarımı
    await page.exposeFunction('onDataReceived', (data) => {
        processRawData(data); // Veriyi Node.js tarafında işle
    });

    try {
        console.log('⏳ Hafif sayfa açılıyor...');
        // Boş grafik sayfası
        await page.goto('https://www.tradingview.com/chart/', { timeout: 60000, waitUntil: 'domcontentloaded' });
        console.log('✅ Sayfa yüklendi, Soket enjeksiyonu başlıyor...');

        const allSymbols = prepareAllSymbols();
        console.log(`📊 Toplam Sembol Sayısı: ${allSymbols.length}`);

        // TARAYICI İÇİNDE ÇALIŞACAK KOD (Inject)
        await page.evaluate((symbols) => {
            console.log('WS-LOG: Başlatılıyor...');

            // WebSocket helper
            const constructMessage = (func, paramList) => {
                const json = JSON.stringify({ m: func, p: paramList });
                return `~m~${json.length}~m~${json}`;
            };

            // TradingView Data Server Bağlantısı
            // Auth Token al ve bağlan
            fetch('https://www.tradingview.com/auth/token').then(r => r.json()).then(authData => {
                const token = authData.userAuthToken;
                console.log('WS-LOG: Auth Token alındı.');

                const ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket', 'json');

                ws.onopen = async () => {
                    console.log('WS-LOG: Socket Bağlandı!');

                    // 1. Login
                    ws.send(constructMessage('set_auth_token', [token]));

                    // 2. Session
                    const sessionId = 'qs_' + Math.random().toString(36).substring(7);
                    ws.send(constructMessage('quote_create_session', [sessionId]));
                    ws.send(constructMessage('quote_set_fields', [sessionId, 'lp', 'ch', 'chp', 'status', 'currency_code', 'original_name']));

                    // 3. Add Symbols (Chunking to prevent disconnect)
                    const chunkSize = 50;
                    for (let i = 0; i < symbols.length; i += chunkSize) {
                        const chunk = symbols.slice(i, i + chunkSize);
                        ws.send(constructMessage('quote_add_symbols', [sessionId, ...chunk]));
                        // Rate limit gecikmesi
                        await new Promise(r => setTimeout(r, 200));
                    }
                    console.log('WS-LOG: Tüm semboller istendi!');

                    // Keep-alive
                    setInterval(() => {
                        if (ws.readyState === 1) ws.send('~m~0~m~');
                    }, 20000);
                };

                ws.onmessage = (event) => {
                    // Veriyi Node.js'e gönder
                    window.onDataReceived(event.data);
                };

                ws.onerror = (e) => console.log('WS-LOG Error:', e);
                ws.onclose = () => console.log('WS-LOG: Socket Kapandı');

            }).catch(e => {
                console.log('WS-LOG: Auth Token Hatası: ' + e.message);
            });

        }, allSymbols);

    } catch (e) {
        console.error('❌ Browser Hatası:', e);
        // Retry
        setTimeout(startTradingViewConnection, 15000);
    }
}

// Node.js tarafında veriyi parse et
function processRawData(rawData) {
    // Protocol: ~m~len~m~json
    const regex = /~m~(\d+)~m~/g;
    let match;

    while ((match = regex.exec(rawData)) !== null) {
        const length = parseInt(match[1]);
        const start = match.index + match[0].length;
        const jsonStr = rawData.substring(start, start + length);
        regex.lastIndex = start + length;

        try {
            const msg = JSON.parse(jsonStr);
            if (msg.m === 'qsd' && msg.p && msg.p[1]) {
                const data = msg.p[1];
                const symbol = normalizeSymbol(data.n); // TV Symbol -> App Symbol
                const values = data.v;

                if (!latestPrices[symbol]) latestPrices[symbol] = {};

                // Gelen verileri güncelle
                if (values.lp) latestPrices[symbol].price = values.lp;
                if (values.chp) latestPrices[symbol].changePercent = values.chp;
                if (!values.lp && !latestPrices[symbol].price) return; // Fiyat yoksa yayına gerek yok

                // Frontend'e gönder
                const broadcastMsg = JSON.stringify({
                    type: 'price_update',
                    data: {
                        symbol: symbol,
                        price: latestPrices[symbol].price,
                        changePercent: latestPrices[symbol].changePercent
                    }
                });

                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(broadcastMsg);
                });
            }
        } catch (e) { }
    }
}

function normalizeSymbol(tvSymbol) {
    if (!tvSymbol) return '';
    return tvSymbol.split(':').pop()
        .replace(/USDT\.P$/, '')
        .replace(/USDT$/, '')
        .replace(/USD$/, '')
        .replace(/TRY$/, '');
}

// Frontend Bağlantısı
wss.on('connection', (ws) => {
    console.log('👤 Frontend bağlandı');
    // Son verileri gönder
    Object.keys(latestPrices).forEach(sym => {
        const p = latestPrices[sym];
        if (p.price) {
            ws.send(JSON.stringify({
                type: 'price_update',
                data: { symbol: sym, price: p.price, changePercent: p.changePercent }
            }));
        }
    });
});
