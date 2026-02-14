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
    setTimeout(startTradingViewConnection, 3000);
});

// WebSocket Server (Frontend)
const wss = new WebSocketServer({ server });

let browser = null;
let page = null;
let latestPrices = {};

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

// PREMIUM BAĞLANTI MANTIĞI
async function startTradingViewConnection() {
    console.log('🌐 TradingView Premium Bağlantısı Başlatılıyor (Yavaş Mod)...');

    if (browser) await browser.close();

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        // '--disable-gpu', 
        '--mute-audio',
        '--disable-blink-features=AutomationControlled'
    ];

    browser = await chromium.launch({
        headless: true,
        args: args
    });

    // BROWSER AYARLARI (User-Agent ÇOK ÖNEMLİ)
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'tr-TR',
        timezoneId: 'Europe/Istanbul',
        extraHTTPHeaders: {
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Ch-Ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"'
        }
    });

    // KULLANICI ÇEREZLERİ (Kalıcı Oturum İçin)
    await context.addCookies([
        { name: 'sessionid', value: 'owdl1knxegxizb3jz4jub973l3jf8r5h', domain: '.tradingview.com', path: '/' },
        { name: 'sessionid_sign', value: 'v3:vTg6tTsF73zJMZdotbHAjbi4gIaUtfLj8zpEbrnhJHQ=', domain: '.tradingview.com', path: '/' },
        { name: 'device_t', value: 'MDQ2N0J3OjA.JXVjSY6qcyTzNumI9qHDD3OcCnepyIaG3KbmPmE0Cy4', domain: '.tradingview.com', path: '/' },
        { name: 'tv_ecuid', value: '5f98ac9a-cd0a-4198-bbde-e643744083fc', domain: '.tradingview.com', path: '/' }
    ]);

    page = await context.newPage();

    // RAM Tasarrufu
    await page.route('**/*', route => {
        const url = route.request().url();
        const type = route.request().resourceType();
        if (url.includes('socket.io') || type === 'script' || type === 'xhr' || type === 'fetch') {
            return route.continue();
        }
        if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'media') {
            return route.abort();
        }
        return route.continue();
    });

    page.on('console', msg => {
        const txt = msg.text();
        if (txt.includes('WS-LOG:')) console.log(txt.replace('WS-LOG:', '📡'));
    });

    await page.exposeFunction('onDataReceived', (data) => processRawData(data));
    await page.exposeFunction('onBrowserReloadRequest', () => {
        console.log('♻️ Bağlantı koptu, yeniden deneniyor...');
        setTimeout(startTradingViewConnection, 5000); // 5sn bekle
    });

    try {
        console.log('⏳ TradingView Ana Sayfası Yükleniyor...');
        // Chart yerine ana sayfadan gidelim, belki daha hafiftir
        await page.goto('https://tr.tradingview.com/chart/', { timeout: 60000, waitUntil: 'domcontentloaded' });

        console.log('✅ Sayfa Açıldı. Token ve Bağlantı Bekleniyor...');

        const allSymbols = prepareAllSymbols();
        console.log(`📊 Hedef: ${allSymbols.length} Sembol`);

        await page.evaluate((symbols) => {
            console.log('WS-LOG: Script Başlatıldı.');
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));

            const waitForToken = async () => {
                let attempts = 0;
                while (attempts < 20) {
                    // Kullanıcı tokenı
                    if (window.user && window.user.auth_token) return window.user.auth_token;
                    await sleep(500);
                    attempts++;
                }
                return null;
            };

            const initSocket = async () => {
                const token = await waitForToken();
                console.log('WS-LOG: Token Durumu: ' + (token ? '✅ ALINDI' : '❌ BULUNAMADI'));

                let finalToken = token;
                if (!finalToken) {
                    try {
                        const r = await fetch('/auth/token');
                        const d = await r.json();
                        finalToken = d.userAuthToken;
                    } catch (e) { finalToken = 'unauthorized_user_token'; }
                }

                // WebSocket (PRO DATA DENEMESİ)
                // data.tradingview.com -> Genelde herkese açık
                // prodata.tradingview.com -> Premium için (Daha stabil olabilir)
                const wsUrl = 'wss://prodata.tradingview.com/socket.io/?EIO=3&transport=websocket';
                console.log('WS-LOG: Bağlanılıyor -> ' + wsUrl);

                const ws = new WebSocket(wsUrl);
                window.tvSocket = ws;

                const constructMessage = (func, paramList) => {
                    const json = JSON.stringify({ m: func, p: paramList });
                    return `~m~${json.length}~m~${json}`;
                };

                ws.onopen = async () => {
                    console.log('WS-LOG: SOKET BAĞLANDI! 🟢');

                    ws.send(constructMessage('set_auth_token', [finalToken]));

                    const sessionId = 'qs_' + Math.random().toString(36).substring(7);
                    ws.send(constructMessage('quote_create_session', [sessionId]));
                    ws.send(constructMessage('quote_set_fields', [sessionId, 'lp', 'ch', 'chp', 'status', 'currency_code', 'original_name']));

                    // ÇOK YAVAŞ EKLEME (Rate Limit Koruması)
                    // Her 1 saniyede sadece 20 sembol gönder
                    const chunkSize = 20;
                    for (let i = 0; i < symbols.length; i += chunkSize) {
                        const chunk = symbols.slice(i, i + chunkSize);

                        if (ws.readyState !== 1) {
                            console.log('WS-LOG: Soket hazır değil, durduruluyor...');
                            break;
                        }

                        ws.send(constructMessage('quote_add_symbols', [sessionId, ...chunk]));

                        // ÖNEMLİ: Hızlı istek atmamak için bekle
                        await sleep(1000);
                    }
                    console.log('WS-LOG: Tüm semboller sıraya alındı ve veri akıyor!');

                    setInterval(() => {
                        if (ws.readyState === 1) ws.send('~m~0~m~');
                    }, 20000);
                };

                ws.onmessage = (e) => window.onDataReceived(e.data);

                ws.onclose = (event) => {
                    console.log('WS-LOG: Socket Koptu 🔴 Kod: ' + event.code);
                    window.onBrowserReloadRequest();
                };

                ws.onerror = (e) => console.log('WS-LOG: Socket Hatası');
            };

            initSocket();

        }, allSymbols);

    } catch (e) {
        console.error('❌ Hata:', e.message);
        setTimeout(startTradingViewConnection, 10000);
    }
}

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

                if (latestPrices[symbol].price) {
                    const broadcastMsg = JSON.stringify({
                        type: 'price_update',
                        data: {
                            symbol: symbol,
                            price: latestPrices[symbol].price,
                            changePercent: latestPrices[symbol].changePercent
                        }
                    });

                    wss.clients.forEach(c => {
                        if (c.readyState === 1) c.send(broadcastMsg);
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
