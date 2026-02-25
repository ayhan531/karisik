import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import fs from 'fs';
import { symbolsData } from '../symbols.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;
const API_SECRET = 'EsMenkul_Secret_2026';

app.use(cors());
app.use(bodyParser.json());

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'EsMenkul_Secure_2026_Session_Secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));

// Rate Limiting for Auth
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit each IP to 10 login attempts per window
    message: { success: false, message: 'Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.' }
});

// Authentication Middleware
const isAuthenticated = (req, res, next) => {
    if (req.session.authenticated) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: 'Yetkisiz erişim.' });
    }
    res.redirect('/admin/login.html');
};

// Auth Routes
app.use('/api/auth', authLimiter, authRoutes);

// Static files (Login page should be public)
app.get('/admin/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../admin/login.html'));
});

// Protected Admin Routes
// Explicitly protect the admin directory
app.use('/admin', isAuthenticated, express.static(path.join(__dirname, '../admin')));
app.use('/api/admin', isAuthenticated, adminRoutes);

// Public root
// Be careful not to expose sensitive files from root
app.use(express.static(path.join(__dirname, '../'), { index: 'index.html' }));

app.get('/api/prices', (req, res) => {
    const clientKey = req.headers['x-api-key'];
    if (clientKey !== API_SECRET) {
        return res.status(401).json({ error: 'Yetkisiz erişim! Geçersiz API Anahtarı.' });
    }
    res.json(latestPrices);
});

app.get('/api/public-symbols', (req, res) => {
    try {
        const configFile = path.join(__dirname, 'data/config.json');
        if (fs.existsSync(configFile)) {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            return res.json({ symbols: config.symbols || [] });
        }
    } catch (e) { }
    res.json({ symbols: [] });
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
let activeSymbols = [];
let globalDelay = 0;
let priceOverrides = {};

// Admin Hooks
app.locals.addSymbolToStream = (symbol) => {
    console.log(`🆕 Yeni Sembol Eklendi: ${symbol}`);
    if (page && !activeSymbols.includes(symbol)) {
        activeSymbols.push(symbol);
        startTradingViewConnection();
    }
};

app.locals.removeSymbolFromStream = (symbol) => {
    console.log(`🗑️ Sembol Silindi: ${symbol}`);
    activeSymbols = activeSymbols.filter(s => s !== symbol && s !== getSymbolForCategory(symbol, 'CUSTOM'));
    startTradingViewConnection();
};

app.locals.updateOverrides = (overrides) => {
    console.log('✏️ Fiyat Override Güncellendi');
    priceOverrides = overrides;
};

app.locals.updateDelay = (delay) => {
    console.log(`⏱️ Gecikme Ayarlandı: ${delay}ms`);
    globalDelay = delay;
};

app.locals.getActiveSymbols = () => {
    // Return all symbols being monitored (simplified list)
    return activeSymbols.map(s => {
        // Reverse map if possible for clean names
        const clean = reverseMapping[s] || s.split(':').pop();
        return clean;
    });
};

const symbolMapping = {
    // Sadece özel/istisna durumlar için burayı kullanıyoruz
    'XSINA': 'BIST:XUSIN',
    'BRENT': 'TVC:UKOIL',
    'GLDGR': 'FX_IDC:XAUTRYG',
    'SZSE': 'SZSE:399001',
    'X30YVADE': 'BIST:XU0301!',
    'TEKFEN': 'BIST:TKFEN',
    'KOZAA': 'BIST:KOZAA',
    'BEKO': 'BIST:ARCLK'
};

const nyseStocks = [
    'IBM', 'V', 'MA', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BA', 'DIS', 'KO', 'MCD',
    'NKE', 'WMT', 'TGT', 'PG', 'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'XOM', 'CVX',
    'COP', 'SLB', 'GE', 'F', 'GM', 'TM', 'HMC', 'SONY', 'VZ', 'T', 'ORCL', 'CRM'
];

function getSymbolForCategory(symbol, category) {
    if (symbolMapping[symbol]) return symbolMapping[symbol];

    // Akıllı Tahminleme (Smart Guessing)
    const sym = symbol.toUpperCase();

    // 1. Kategoriye göre öncelik
    if (category === 'BORSA ISTANBUL' || category === 'ENDEKSLER') return `BIST:${sym}`;
    if (category === 'KRIPTO') return `BINANCE:${sym}`;
    if (category === 'EXCHANGE') return `FX_IDC:${sym}`;
    if (category === 'STOCKS') return nyseStocks.includes(sym) ? `NYSE:${sym}` : `NASDAQ:${sym}`;

    // 2. Sembol yapısına göre tahmin (CUSTOM eklemeler için)
    if (sym.endsWith('TRY')) {
        // Eğer USD, EUR gibi bir döviz ise FX_IDC, değilse (BTC vb) BINANCE
        const currencies = ['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'];
        const base = sym.replace('TRY', '');
        return currencies.includes(base) ? `FX_IDC:${sym}` : `BINANCE:${sym}`;
    }

    // Altın/Gümüş gibi emtialar için TVC veya FX_IDC
    if (['GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM'].includes(sym)) return `TVC:${sym}`;

    // Eğer 5 karakterden kısaysa ve sadece harfse büyük ihtimalle BIST hissesidir
    if (sym.length >= 3 && sym.length <= 6 && /^[A-Z0-9]+$/.test(sym)) {
        return `BIST:${sym}`;
    }

    return sym;
}

function prepareAllSymbols() {
    const formattedSymbols = ['FX_IDC:USDTRY'];

    // Default Symbols
    Object.entries(symbolsData).forEach(([category, symbols]) => {
        symbols.forEach(sym => {
            formattedSymbols.push(getSymbolForCategory(sym, category));
        });
    });

    // Config Symbols (Admin'den eklenenler)
    try {
        const configFile = path.join(__dirname, 'data/config.json');
        if (fs.existsSync(configFile)) {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (config.symbols) {
                config.symbols.forEach(sym => {
                    // Kategori belirtilmediği için tahminleme kullanacak
                    formattedSymbols.push(getSymbolForCategory(sym, 'CUSTOM'));
                });
            }
            if (config.overrides) priceOverrides = config.overrides;
            if (config.delay) globalDelay = config.delay;
        }
    } catch (e) { console.error('Config load error:', e); }

    const uniqueSymbols = [...new Set(formattedSymbols)];
    activeSymbols = uniqueSymbols;

    // Reverse mapping'i de her hazırlıkta temizleyip yeniden kuralım
    Object.keys(reverseMapping).forEach(key => delete reverseMapping[key]);
    uniqueSymbols.forEach(fullTicker => {
        const parts = fullTicker.split(':');
        const cleanName = parts.pop();

        // Eğer özel bir mapleme yoksa, son parçayı (THYAO vb.) anahtar olarak kullan
        // Ama özel bir mapleme varsa o kalsın
        let foundSpecial = false;
        for (const [key, value] of Object.entries(symbolMapping)) {
            if (value === fullTicker) {
                reverseMapping[fullTicker] = key;
                foundSpecial = true;
                break;
            }
        }
        if (!foundSpecial) {
            reverseMapping[fullTicker] = cleanName;
        }
    });

    return uniqueSymbols;
}

async function startTradingViewConnection() {
    console.log('🌐 TradingView Bağlantısı Başlatılıyor (ADMIN CONTROLLED)...');
    lastDataTime = Date.now();

    if (browser) try { await browser.close(); } catch (e) { }

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext();
    await context.addCookies([
        { name: 'sessionid', value: 'owdl1knxegxizb3jz4jub973l3jf8r5h', domain: '.tradingview.com', path: '/' },
        { name: 'sessionid_sign', value: 'v3:vTg6tTsF73zJMZdotbHAjbi4gIaUtfLj8zpEbrnhJHQ=', domain: '.tradingview.com', path: '/' }
    ]);

    page = await context.newPage();

    // Safety check for already registered functions
    try { await page.exposeFunction('onDataReceived', (data) => processRawData(data)); } catch (e) { }
    try { await page.exposeFunction('onBrowserReloadRequest', () => { setTimeout(startTradingViewConnection, 5000); }); } catch (e) { }

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

    // Global Delay implementation
    if (globalDelay > 0) {
        setTimeout(() => {
            _processDataInternal(rawData);
        }, globalDelay);
    } else {
        _processDataInternal(rawData);
    }
}

function _processDataInternal(rawData) {
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

                if (symbol === 'TKFEN') symbol = 'TEKFEN';
                if (symbol === 'ARCLK') symbol = 'BEKO';
                if (symbol === 'XAUTRYG' && !reverseMapping[tvTicker]) symbol = 'GLDGR';
                if (symbol === '399001') symbol = 'SZSE';

                if (tvTicker === 'FX_IDC:USDTRY' && values.lp) {
                    usdTryRate = values.lp;
                    symbol = 'USDTRY';
                }

                let finalPrice = values.lp;

                if (finalPrice && symbol !== 'USDTRY') {
                    if (tvTicker.includes('USDT') && symbol.endsWith('TRY')) {
                        finalPrice = finalPrice * usdTryRate;
                    }
                    else if (tvTicker.startsWith('NYSE:') || tvTicker.startsWith('NASDAQ:')) {
                        finalPrice = finalPrice * usdTryRate;
                    }
                    else if (['BRENT', 'USOIL', 'GOLD', 'SILVER', 'CORN', 'WHEAT', 'COPPER', 'PLATINUM', 'PALLADIUM', 'SOYBEAN', 'SUGAR', 'COFFEE', 'COTTON', 'XAUUSD', 'XAGUSD'].includes(symbol)) {
                        finalPrice = finalPrice * usdTryRate;
                    }
                    else if (['NDX', 'SPX', 'DJI', 'DAX', 'UKX', 'CAC40', 'NI225', 'SZSE', 'HSI'].includes(symbol)) {
                        finalPrice = finalPrice * usdTryRate;
                    }
                }

                // 🛑 OVERRIDE KONTROLÜ
                if (priceOverrides[symbol]) {
                    const override = priceOverrides[symbol];
                    if (override.type === 'fixed') {
                        finalPrice = override.value;
                    } else if (override.type === 'multiplier') {
                        if (finalPrice) {
                            finalPrice = finalPrice * override.value;
                        }
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
