import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
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
    if (category === 'EMTIA') return `TVC:${symbol}`;
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
        '--disable-dev-shm-usage',
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

    await context.addCookies([
        { name: 'sessionid', value: 'owdl1knxegxizb3jz4jub973l3jf8r5h', domain: '.tradingview.com', path: '/' },
        { name: 'sessionid_sign', value: 'v3:vTg6tTsF73zJMZdotbHAjbi4gIaUtfLj8zpEbrnhJHQ=', domain: '.tradingview.com', path: '/' },
        { name: 'tv_ecuid', value: '5f98ac9a-cd0a-4198-bbde-e643744083fc', domain: '.tradingview.com', path: '/' }
    ]);

    page = await context.newPage();

    // RAM OPTİMİZASYONU
    await page.route('**/*.{png,jpg,jpeg,gif,css,woff,woff2,svg,mp4,webp,ico,js}', route => {
        if (route.request().url().includes('socket.io')) return route.continue(); // WebSocket scriptlerine izin ver

        const type = route.request().resourceType();
        if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'media') {
            return route.abort();
        }
        return route.continue();
    });

    page.on('console', msg => {
        const txt = msg.text();
        if (txt.includes('WS-LOG:')) console.log(txt.replace('WS-LOG:', '📡'));
    });

    await page.exposeFunction('onDataReceived', (data) => {
        processRawData(data);
    });

    try {
        console.log('⏳ Hafif sayfa açılıyor...');
        await page.goto('https://www.tradingview.com/chart/', { timeout: 60000, waitUntil: 'domcontentloaded' });
        console.log('✅ Sayfa yüklendi, Soket enjeksiyonu başlıyor...');

        const allSymbols = prepareAllSymbols();
        console.log(`📊 Toplam Sembol Sayısı: ${allSymbols.length}`);

        // TARAYICI İÇİNDE ÇALIŞACAK KOD (Inject)
        await page.evaluate((symbols) => {
            console.log('WS-LOG: Başlatılıyor...');

            const constructMessage = (func, paramList) => {
                const json = JSON.stringify({ m: func, p: paramList });
                return `~m~${json.length}~m~${json}`;
            };

            // WebSocket Bağlantısını Başlat
            const startSocket = (authToken) => {
                const token = authToken || 'unauthorized_user_token';
                console.log('WS-LOG: Socket Bağlanıyor... (Mod: ' + (authToken ? 'User' : 'Anonim') + ')');

                const ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket', 'json');
                window.tvSocket = ws;

                ws.onopen = async () => {
                    console.log('WS-LOG: Socket Açıldı!');

                    // 1. Auth (User Token veya Anonim)
                    ws.send(constructMessage('set_auth_token', [token]));

                    // 2. Session
                    const sessionId = 'qs_' + Math.random().toString(36).substring(7);
                    ws.send(constructMessage('quote_create_session', [sessionId]));
                    ws.send(constructMessage('quote_set_fields', [sessionId, 'lp', 'ch', 'chp', 'status', 'currency_code', 'original_name']));

                    // 3. Add Symbols (Chunked)
                    const chunkSize = 50;
                    for (let i = 0; i < symbols.length; i += chunkSize) {
                        const chunk = symbols.slice(i, i + chunkSize);
                        ws.send(constructMessage('quote_add_symbols', [sessionId, ...chunk]));
                        await new Promise(r => setTimeout(r, 200));
                    }
                    console.log('WS-LOG: ' + symbols.length + ' sembol istendi!');

                    // Keep-alive
                    setInterval(() => {
                        if (ws.readyState === 1) ws.send('~m~0~m~');
                    }, 20000);
                };

                ws.onmessage = (event) => window.onDataReceived(event.data);
                ws.onerror = (e) => console.log('WS-LOG Socket Error:', e);
                ws.onclose = () => console.log('WS-LOG: Socket Kapandı (Yeniden bağlanılması gerekebilir)');
            };

            // Token almaya çalış
            console.log('WS-LOG: Auth Token isteği...');
            fetch('https://www.tradingview.com/auth/token')
                .then(async response => {
                    const text = await response.text();
                    try {
                        const data = JSON.parse(text);
                        if (data.userAuthToken) {
                            startSocket(data.userAuthToken);
                        } else {
                            throw new Error('Token boş');
                        }
                    } catch (e) {
                        console.log('WS-LOG: Token parse hatası (' + e.message + '), Anonim mod ile devam ediliyor.');
                        startSocket(null);
                    }
                })
                .catch(e => {
                    console.log('WS-LOG: Network hatası (' + e.message + '), Anonim mod ile devam ediliyor.');
                    startSocket(null);
                });

        }, allSymbols);

    } catch (e) {
        console.error('❌ Browser Hatası:', e);
        setTimeout(startTradingViewConnection, 15000);
    }
}

// Node.js tarafında veriyi parse et
function processRawData(rawData) {
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
                const symbolRaw = data.n;
                const values = data.v;

                if (!symbolRaw || !values) continue;

                const symbol = normalizeSymbol(symbolRaw);

                if (!latestPrices[symbol]) latestPrices[symbol] = {};

                if (values.lp) latestPrices[symbol].price = values.lp;
                if (values.chp) latestPrices[symbol].changePercent = values.chp;

                // Fiyat varsa yayına hazır
                if (latestPrices[symbol].price) {
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

wss.on('connection', (ws) => {
    console.log('👤 Frontend bağlandı');
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
