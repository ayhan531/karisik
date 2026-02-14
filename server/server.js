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

const server = app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda yayında`);
    setTimeout(startTradingViewConnection, 2000);
});

const wss = new WebSocketServer({ server });

let browser = null;
let page = null;
let latestPrices = {};

// 🎯 EKSİKSİZ VE NOKTA ATIŞI MAPPING (SÖZLÜK)
const symbolMapping = {
    // ENDEKSLER (Indices)
    'XSINA': 'BIST:XUSIN',    // Fix: XUSIN doğru koddur
    'CAC40': 'TVC:CAC',       // Fix: TVC kaynağı daha stabildir
    'NI225': 'TVC:NI225',     // Fix: TVC kaynağı
    'DJI': 'TVC:DJI',         // Fix: Dow Jones TVC
    'SZSE': 'TVC:SHCOMP',     // Fix: Shenzhen Composite
    'DAX': 'TVC:DAX',
    'UKX': 'TVC:UKX',
    'HSI': 'TVC:HSI',
    'NDX': 'TVC:NDX',
    'SPX': 'TVC:SPX',

    // EMTIA (Commodities)
    'BRENT': 'TVC:UKOIL',     // Fix: Global Brent kaynağı
    'GLDGR': 'OANDA:XAU_TRY', // Fix: 7/24 Veri (Gram Altın Karşılığı)
    'XAUTRY': 'FX_IDC:XAUTRY',
    'XAGTRY': 'FX_IDC:XAGTRY', // Fix: Gümüş TL Spot

    // BIST HİSSELERİ (Özel Durumlar)
    'TEKFEN': 'BIST:TKFEN',    // TradingView'de TKFEN olarak geçebilir
    'KOZAA': 'BIST:KOZAA',

    // US STOCKS (NYSE/NASDAQ Nokta Atışı)
    'JPM': 'NYSE:JPM',
    'BAC': 'NYSE:BAC',
    'DIS': 'NYSE:DIS',
    'KO': 'NYSE:KO',
    'MA': 'NYSE:MA',
    'WFC': 'NYSE:WFC',
    'C': 'NYSE:C',
    'GS': 'NYSE:GS',
    'MS': 'NYSE:MS',
    'BA': 'NYSE:BA',
    'V': 'NYSE:V',
    'IBM': 'NYSE:IBM',
    'JNJ': 'NYSE:JNJ',
    'PFE': 'NYSE:PFE'
};

function getSymbolForCategory(symbol, category) {
    if (symbolMapping[symbol]) return symbolMapping[symbol];
    if (category === 'BORSA ISTANBUL') return `BIST:${symbol}`;
    if (category === 'KRIPTO') return `BINANCE:${symbol}`;
    if (category === 'EXCHANGE') return `FX_IDC:${symbol}`;
    if (category === 'STOCKS') return `NASDAQ:${symbol}`;
    return symbol;
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

async function startTradingViewConnection() {
    console.log('🌐 TradingView Bağlantısı Başlatılıyor (KESİN ÇÖZÜM VERSİYONU)...');

    if (browser) try { await browser.close(); } catch (e) { }

    browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
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
                const chunkSize = 40;
                const addBatch = () => {
                    if (i >= symbols.length) return;
                    if (ws.readyState !== 1) return;
                    const chunk = symbols.slice(i, i + chunkSize);
                    ws.send(constructMessage('quote_add_symbols', [sessionId, ...chunk]));
                    i += chunkSize;
                    setTimeout(addBatch, 1200);
                };
                setTimeout(addBatch, 5000);
            });

            ws.addEventListener('message', (event) => window.onDataReceived(event.data));
            ws.addEventListener('close', (e) => { if (e.code !== 1000) window.onBrowserReloadRequest(); });
            return ws;
        };
        window.WebSocket.prototype = NativeWebSocket.prototype;
        window.WebSocket.OPEN = NativeWebSocket.OPEN;
    }, allSymbols);

    try {
        await page.goto('https://tr.tradingview.com/chart/', { timeout: 60000 });
    } catch (e) {
        setTimeout(startTradingViewConnection, 10000);
    }
}

// Tersten eşleşme sözlüğü
const reverseMapping = {};
Object.entries(symbolMapping).forEach(([key, value]) => {
    reverseMapping[value] = key;
});

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
                let symbolRaw = data.n;
                const values = data.v;
                if (!symbolRaw || !values) continue;

                let tvTicker = symbolRaw.split(',')[0].trim();

                // 1. Sözlükten bak 2. Prefix at 3. Manuel fixler
                let symbol = reverseMapping[tvTicker] || tvTicker.split(':').pop();

                // TKFEN -> TEKFEN düzeltmesi (Hala eşleşmiyorsa)
                if (symbol === 'TKFEN') symbol = 'TEKFEN';

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
            ws.send(JSON.stringify({
                type: 'price_update',
                data: { symbol: sym, price: p.price, changePercent: p.changePercent }
            }));
        }
    });
});
