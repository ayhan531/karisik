import { chromium } from 'playwright';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { symbolsData } from '../symbols.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..')));

const PORT = process.env.PORT || 3001;
const clients = new Set();
const priceCache = new Map();

let browser = null;
let page = null;

// Sembol formatını TradingView formatına çevir
function getSymbolForCategory(symbol, category) {
    switch (category) {
        case 'BORSA ISTANBUL':
            return `BIST:${symbol}`;
        case 'KRIPTO':
            return `BINANCE:${symbol}USDT`;
        case 'STOCKS':
            return `NASDAQ:${symbol}`;
        case 'EXCHANGE':
            return `FX_IDC:${symbol}`;
        case 'EMTIA':
            if (symbol === 'GOLD GRAM') return 'TVC:GOLD';
            if (symbol === 'XAUUSD') return 'FX:XAUUSD';
            if (symbol === 'BRENT') return 'TVC:UKOIL';
            if (symbol === 'WTI') return 'TVC:USOIL';
            return `TVC:${symbol}`;
        case 'ENDEKSLER':
            if (symbol === 'BIST100') return 'BIST:XU100';
            if (symbol === 'US30') return 'DJ:DJI';
            if (symbol === 'US100') return 'NASDAQ:NDX';
            if (symbol === 'US500') return 'SP:SPX';
            return `TVC:${symbol}`;
        default:
            return symbol;
    }
}

// TradingView'e gerçek browser ile bağlan
async function connectToTradingView() {
    console.log('🌐 Gerçek browser başlatılıyor...');

    browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });

    page = await context.newPage();

    // Cookie'leri yükle
    await context.addCookies([
        { name: 'sessionid', value: 'owdl1knxegxizb3jz4jub973l3jf8r5h', domain: '.tradingview.com', path: '/' },
        { name: 'sessionid_sign', value: 'v3:vTg6tTsF73zJMZdotbHAjbi4gIaUtfLj8zpEbrnhJHQ=', domain: '.tradingview.com', path: '/' },
        { name: 'device_t', value: 'MDQ2N0J3OjA.JXVjSY6qcyTzNumI9qHDD3OcCnepyIaG3KbmPmE0Cy4', domain: '.tradingview.com', path: '/' },
        { name: 'tv_ecuid', value: '5f98ac9a-cd0a-4198-bbde-e643744083fc', domain: '.tradingview.com', path: '/' }
    ]);

    console.log('📊 TradingView watchlist sayfası açılıyor...');

    // WebSocket listener'ı sayfa yüklenmeden önce kur
    page.on('websocket', ws => {
        console.log('🔌 WebSocket bağlantısı yakalandı!');

        ws.on('framereceived', event => {
            try {
                const payload = event.payload;
                if (typeof payload === 'string') {
                    handleTradingViewMessage(payload);
                }
            } catch (err) {
                // Silent
            }
        });
    });

    // Daha hızlı yüklenen bir sayfa kullan
    try {
        await page.goto('https://www.tradingview.com/markets/cryptocurrencies/', {
            timeout: 60000,
            waitUntil: 'domcontentloaded'
        });
        console.log('✅ Sayfa yüklendi');
    } catch (e) {
        console.log('⚠️ Sayfa tam yüklenemedi ama WebSocket dinleniyor');
    }

    // WebSocket mesajlarını dinle
    page.on('websocket', ws => {
        console.log('🔌 WebSocket bağlantısı yakalandı:', ws.url());

        ws.on('framereceived', event => {
            try {
                const payload = event.payload;
                if (typeof payload === 'string' && payload.includes('quote')) {
                    handleTradingViewMessage(payload);
                }
            } catch (err) {
                // Silent error
            }
        });
    });

    // Sembolleri subscribe et (sayfa üzerinde)
    await subscribeSymbols();

    console.log('✅ Browser bağlantısı aktif ve veriler dinleniyor!');
}

// Sembolleri sayfada subscribe et
async function subscribeSymbols() {
    console.log('📌 Semboller subscribe ediliyor...');

    // İlk 50 sembol ile başla (rate limiting için)
    const allSymbols = [];
    Object.entries(symbolsData).forEach(([category, symbols]) => {
        symbols.slice(0, 20).forEach(sym => {
            allSymbols.push(getSymbolForCategory(sym, category));
        });
    });

    // Watchlist oluştur
    await page.evaluate((symbols) => {
        if (window.TradingView && window.TradingView.ChartApi) {
            symbols.forEach((sym, idx) => {
                setTimeout(() => {
                    try {
                        window.TradingView.ChartApi.getChart().setSymbol(sym);
                    } catch (e) { }
                }, idx * 100);
            });
        }
    }, allSymbols.slice(0, 10));

    console.log(`✅ ${allSymbols.length} sembol işleme alındı`);
}

// TradingView sembolünü frontend formatına çevir
function normalizeSymbol(tvSymbol) {
    // TradingView formatı: EXCHANGE:SYMBOLPAIR veya CRYPTO:SYMBOLUSD
    // Bizim format: SYMBOL (sadece)

    // Exchange prefix'ini kaldır (CRYPTO:, BINANCE:, BITSTAMP:, etc.)
    let symbol = tvSymbol.split(':').pop();

    // USD, USDT, TRY gibi suffixleri kaldır
    symbol = symbol
        .replace(/USDT\.P$/, '')  // BINANCE perpetual futures
        .replace(/USDT$/, '')
        .replace(/USD$/, '')
        .replace(/TRY$/, '')
        .replace(/EUR$/, '')
        .replace(/\.P$/, '');     // Perpetual marker

    return symbol;
}

// TradingView mesajlarını işle
function handleTradingViewMessage(message) {
    try {
        // TradingView birkaç farklı format kullanıyor
        // Format 1: JSON array içinde quote data
        if (message.includes('"n"') && message.includes('"v"')) {
            // Regex ile fiyat parse et
            const symbolMatch = message.match(/"n":"([^"]+)"/);
            const priceMatch = message.match(/"lp":([0-9.]+)/);
            const chMatch = message.match(/"ch":([-.0-9]+)/);
            const chpMatch = message.match(/"chp":([-.0-9]+)/);

            if (symbolMatch && priceMatch) {
                const tvSymbol = symbolMatch[1];
                const normalizedSymbol = normalizeSymbol(tvSymbol);
                const price = parseFloat(priceMatch[1]);
                const change = chMatch ? parseFloat(chMatch[1]) : 0;
                const changePercent = chpMatch ? parseFloat(chpMatch[1]) : 0;

                const priceData = {
                    symbol: normalizedSymbol,  // Frontend'in anlayacağı format
                    tvSymbol: tvSymbol,        // Orijinal TradingView sembolü (debug için)
                    price: price,
                    bid: price * 0.9995,
                    ask: price * 1.0005,
                    change: change,
                    changePercent: changePercent,
                    timestamp: Date.now()
                };

                // Her iki sembolle de cache'le (frontend arama için)
                priceCache.set(normalizedSymbol, priceData);
                priceCache.set(tvSymbol, priceData);

                broadcastToClients({ type: 'price_update', data: priceData });

                console.log(`📈 ${normalizedSymbol} (${tvSymbol}): $${price} (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`);
            }
        }

        // Format 2: Simple price update
        if (message.includes('price') || message.includes('last')) {
            try {
                const json = JSON.parse(message);
                if (json.data && json.data.symbol && json.data.price) {
                    const priceData = {
                        symbol: json.data.symbol,
                        price: json.data.price,
                        bid: json.data.bid || json.data.price * 0.9995,
                        ask: json.data.ask || json.data.price * 1.0005,
                        changePercent: json.data.changePercent || 0,
                        timestamp: Date.now()
                    };

                    priceCache.set(json.data.symbol, priceData);
                    broadcastToClients({ type: 'price_update', data: priceData });

                    console.log(`📊 ${json.data.symbol}: $${json.data.price}`);
                }
            } catch (e) {
                // Not pure JSON
            }
        }
    } catch (err) {
        // Silent - too many messages to log errors
    }
}

// Client'lara broadcast
function broadcastToClients(message) {
    const data = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(data);
        }
    });
}

// REST endpoint
app.get('/api/prices', (req, res) => {
    const prices = {};
    priceCache.forEach((value, key) => {
        prices[key] = value;
    });
    res.json(prices);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Server kapatılıyor...');
    if (browser) await browser.close();
    process.exit(0);
});

// Create HTTP server and attach WebSocket
const httpServer = app.listen(PORT, async () => {
    console.log(`🚀 Server çalışıyor: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
    await connectToTradingView();
});

// Attach WebSocket to HTTP server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    console.log('👤 Yeni client bağlandı');
    clients.add(ws);

    // Mevcut cache'i gönder
    priceCache.forEach((price) => {
        ws.send(JSON.stringify({
            type: 'price_update',
            data: price
        }));
    });

    ws.on('close', () => {
        console.log('👤 Client ayrıldı');
        clients.delete(ws);
    });
});
