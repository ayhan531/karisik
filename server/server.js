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
const API_SECRET = 'EsMenkul_Secret_2026';

app.use(cors());
app.use(express.static(path.join(__dirname, '../')));

app.get('/api/prices', (req, res) => {
    const clientKey = req.headers['x-api-key'];
    if (clientKey !== API_SECRET) {
        return res.status(401).json({ error: 'Yetkisiz erişim! Geçersiz API Anahtarı.' });
    }
    res.json(latestPrices);
});

const server = app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda yayında`);
    setTimeout(startTradingViewConnection, 2000);
});

const wss = new WebSocketServer({
    server,
    verifyClient: (info, callback) => {
        const url = new URL(info.req.url, `http://${info.req.headers.host}`);
        const token = url.searchParams.get('token');
        if (token === API_SECRET) {
            callback(true);
        } else {
            callback(false, 401, 'Yetkisiz WebSocket Bağlantısı');
        }
    }
});

let browser = null;
let page = null;
let latestPrices = {};
let usdTryRate = 34.20;
let lastDataTime = Date.now();

const symbolMapping = {
    'XSINA': 'BIST:XUSIN',
    'CAC40': 'TVC:CAC40',
    'NI225': 'TVC:NI225',
    'DJI': 'TVC:DJI',
    'SZSE': 'SZSE:399001',
    'DAX': 'TVC:DAX',
    'UKX': 'TVC:UKX',
    'HSI': 'TVC:HSI',
    'NDX': 'TVC:NDX',
    'SPX': 'TVC:SPX',
    'BRENT': 'TVC:UKOIL',
    'GLDGR': 'FX_IDC:XAUTRYG',
    'XAUTRY': 'FX_IDC:XAUTRY',
    'XAGTRY': 'FX_IDC:XAGTRY',
    'USOIL': 'TVC:USOIL',
    'NG1!': 'NYMEX:NG1!',
    'COPPER': 'COMEX:HG1!',
    'GOLD': 'TVC:GOLD',
    'SILVER': 'TVC:SILVER',
    'TEKFEN': 'BIST:TKFEN',
    'KOZAA': 'BIST:KOZAA',
    'BEKO': 'BIST:ARCLK',
    'MKRTRY': 'BINANCE:MKRUSDT',
    'FTMTRY': 'BINANCE:FTMUSDT',
    'EOSTRY': 'BINANCE:EOSUSDT',
    'FLOWTRY': 'BINANCE:FLOWUSDT',
    'KAVATRY': 'BINANCE:KAVAUSDT',
    'QNTTRY': 'BINANCE:QNTUSDT',
    'FXSTRY': 'BINANCE:FXSUSDT',
    'SSVTRY': 'BINANCE:SSVUSDT',
    'RUNETRY': 'BINANCE:RUNEUSDT'
};

const nyseStocks = [
    'IBM', 'V', 'MA', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BA', 'DIS', 'KO', 'MCD',
    'NKE', 'WMT', 'TGT', 'PG', 'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'XOM', 'CVX',
    'COP', 'SLB', 'GE', 'F', 'GM', 'TM', 'HMC', 'SONY', 'VZ', 'T', 'ORCL', 'CRM'
];

function getSymbolForCategory(symbol, category) {
    if (symbolMapping[symbol]) return symbolMapping[symbol];
    if (category === 'BORSA ISTANBUL') return `BIST:${symbol}`;
    if (category === 'KRIPTO') return `BINANCE:${symbol}`;
    if (category === 'EXCHANGE') return `FX_IDC:${symbol}`;
    if (category === 'STOCKS') {
        return nyseStocks.includes(symbol) ? `NYSE:${symbol}` : `NASDAQ:${symbol}`;
    }
    return symbol;
}

function prepareAllSymbols() {
    const formattedSymbols = ['FX_IDC:USDTRY'];
    Object.entries(symbolsData).forEach(([category, symbols]) => {
        symbols.forEach(sym => { formattedSymbols.push(getSymbolForCategory(sym, category)); });
    });
    return [...new Set(formattedSymbols)];
}

async function startTradingViewConnection() {
    console.log('🌐 TradingView Bağlantısı Başlatılıyor (MAX FLOW V2)...');
    lastDataTime = Date.now();

    if (browser) try { await browser.close(); } catch (e) { }

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext();
    await context.addCookies([
        { name: 'sessionid', value: 'owdl1knxegxizb3jz4jub973l3jf8r5h', domain: '.tradingview.com', path: '/' },
        { name: 'sessionid_sign', value: 'v3:vTg6tTsF73zJMZdotbHAjbi4gIaUtfLj8zpEbrnhJHQ=', domain: '.tradingview.com', path: '/' }
    ]);

    page = await context.newPage();
    await page.exposeFunction('onDataReceived', (data) => processRawData(data));
    await page.exposeFunction('onBrowserReloadRequest', () => { setTimeout(startTradingViewConnection, 5000); });

    const allSymbols = prepareAllSymbols();

    await page.addInitScript((symbols) => {
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = function (url, protocols) {
            const ws = new NativeWebSocket(url, protocols);
            window.tvSocket = ws;
            ws.addEventListener('open', () => {
                const constructMessage = (func, paramList) => {
                    const json = JSON.stringify({ m: func, p: paramList });
                    return `~m~${json.length}~m~${json}`;
                };
                const sessionId = 'qs_' + Math.random().toString(36).substring(7);
                ws.send(constructMessage('quote_create_session', [sessionId]));
                ws.send(constructMessage('quote_set_fields', [sessionId, 'lp', 'ch', 'chp', 'status', 'currency_code', 'original_name']));
                let i = 0;
                const addBatch = () => {
                    if (i >= symbols.length) return;
                    const chunk = symbols.slice(i, i + 35);
                    ws.send(constructMessage('quote_add_symbols', [sessionId, ...chunk]));
                    i += 35;
                    setTimeout(addBatch, 1500);
                };
                setTimeout(addBatch, 5000);
            });
            ws.addEventListener('message', (event) => window.onDataReceived(event.data));
            ws.addEventListener('close', (e) => { if (e.code !== 1000) window.onBrowserReloadRequest(); });
            return ws;
        };
        window.WebSocket.prototype = NativeWebSocket.prototype;
        window.WebSocket.OPEN = NativeWebSocket.OPEN;

        // HEARTBEAT: Keep the page interaction alive
        setInterval(() => {
            window.scrollBy(0, 1);
            window.scrollBy(0, -1);
        }, 15000);
    }, allSymbols);

    try {
        await page.goto('https://tr.tradingview.com/chart/', { timeout: 60000 });
        console.log('✅ TradingView Sayfası Açıldı.');
    } catch (e) {
        console.log('❌ Sayfa yükleme hatası, tekrar denenecek.');
        setTimeout(startTradingViewConnection, 10000);
    }
}

// Watchdog: If no data for 5 minutes, restart
setInterval(() => {
    if (Date.now() - lastDataTime > 300000) {
        console.log('⚠️ Veri akışı durdu! Yeniden bağlanılıyor...');
        startTradingViewConnection();
    }
}, 60000);

const reverseMapping = {};
Object.entries(symbolMapping).forEach(([key, value]) => { reverseMapping[value] = key; });

function processRawData(rawData) {
    lastDataTime = Date.now();
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
                let symbolRaw = data.n;
                const values = data.v;
                if (!symbolRaw || !values) continue;

                let tvTicker = symbolRaw.split(',')[0].trim();
                let symbol = reverseMapping[tvTicker] || tvTicker.split(':').pop();

                // Normalizasyon ve TL Dönüşümü
                if (symbol === 'TKFEN') symbol = 'TEKFEN';
                if (symbol === 'ARCLK') symbol = 'BEKO';
                if (symbol === 'XAUTRYG' && !reverseMapping[tvTicker]) symbol = 'GLDGR';
                if (symbol === '399001') symbol = 'SZSE';

                // Dolar/TL kurunu güncelle ama kendine conversion yapma
                if (tvTicker === 'FX_IDC:USDTRY' && values.lp) {
                    usdTryRate = values.lp;
                    symbol = 'USDTRY'; // Sembol adını zorla sabitle
                }

                let finalPrice = values.lp;
                
                // 💰 TL DÖNÜŞÜM MANTIĞI 💰
                if (finalPrice && symbol !== 'USDTRY') { // USDTRY'yi dönüştürme
                    // 1. Kripto USDT'den TRY'ye çevrim
                    if (tvTicker.includes('USDT') && symbol.endsWith('TRY')) {
                        finalPrice = finalPrice * usdTryRate;
                    }
                    // 2. Amerikan Hisseleri (STOCKS) -> TL
                    else if (tvTicker.startsWith('NYSE:') || tvTicker.startsWith('NASDAQ:')) {
                        finalPrice = finalPrice * usdTryRate;
                    }
                    // 3. Global Emtialar (USD olanlar) -> TL
                    else if (['BRENT', 'USOIL', 'GOLD', 'SILVER', 'CORN', 'WHEAT', 'COPPER'].includes(symbol)) {
                        finalPrice = finalPrice * usdTryRate;
                    }
                }

                if (!latestPrices[symbol]) latestPrices[symbol] = {};
                if (finalPrice) latestPrices[symbol].price = finalPrice;
                if (values.chp) latestPrices[symbol].changePercent = values.chp;

                if (latestPrices[symbol].price) {
                    const broadcastMsg = JSON.stringify({
                        type: 'price_update',
                        data: { symbol: symbol, price: latestPrices[symbol].price, changePercent: latestPrices[symbol].changePercent }
                    });
                    wss.clients.forEach(c => { if (c.readyState === 1) c.send(broadcastMsg); });
                }
            }
        } catch (e) { }
    }
}

wss.on('connection', (ws) => {
    Object.keys(latestPrices).forEach(sym => {
        const p = latestPrices[sym];
        if (p.price) {
            ws.send(JSON.stringify({ type: 'price_update', data: { symbol: sym, price: p.price, changePercent: p.changePercent } }));
        }
    });
});
