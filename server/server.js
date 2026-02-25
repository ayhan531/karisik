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
    // Session kontrolü
    if (req.session.authenticated) {
        return next();
    }

    // Eğer zaten login sayfasındaysa veya API'ler üzerinden check/login/logout yapıyorsa izin ver
    const publicPaths = ['/login.html', '/auth/login', '/auth/check', '/auth/logout'];
    if (publicPaths.includes(req.path)) {
        return next();
    }

    // API istekleri için 401 dön, düz sayfalar için redirect et
    if (req.originalUrl.startsWith('/api/')) {
        // Ama public API'leri dışarıda tut
        const publicApis = ['/api/public-symbols', '/api/prices'];
        if (publicApis.some(p => req.originalUrl.startsWith(p))) {
            return next();
        }
        return res.status(401).json({ success: false, message: 'Yetkisiz erişim.' });
    }

    res.redirect('/admin/login.html');
};

// --- ROUTES ---

// 1. PUBLIC API'ler (Middleware'den önce gelsin ki takılmasın)
app.get('/api/public-symbols', (req, res) => {
    try {
        const configFile = path.join(__dirname, 'data/config.json');
        if (fs.existsSync(configFile)) {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            // Normalize symbols to objects for frontend
            const normalized = (config.symbols || []).map(s => {
                if (typeof s === 'string') return { name: s, category: 'DİĞER' };
                return s;
            });
            return res.json({ symbols: normalized });
        }
    } catch (e) { console.error('Public symbols error:', e); }
    res.json({ symbols: [] });
});

app.get('/api/prices', (req, res) => {
    const clientKey = req.headers['x-api-key'];
    if (clientKey !== API_SECRET) {
        return res.status(401).json({ error: 'Yetkisiz erişim! Geçersiz API Anahtarı.' });
    }
    res.json(latestPrices);
});

// 2. AUTH API'leri (Giriş için şart)
app.use('/api/auth', authRoutes);

// 3. ADMIN / PROTECTED
app.get('/admin/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../admin/login.html'));
});

app.use('/admin', isAuthenticated, express.static(path.join(__dirname, '../admin')));
app.use('/api/admin', isAuthenticated, adminRoutes);

// 4. GENERAL STATIC
app.use(express.static(path.join(__dirname, '../'), { index: 'index.html' }));

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

// Admin panelinin tüm kategorilere erişebilmesi için
app.locals.getSymbolsData = () => symbolsData;

const symbolMapping = {
    // ENDEKSLER (TVC her zaman veri verir)
    'XU100': 'BIST:XU100',
    'XU030': 'BIST:XU030',
    'XBANK': 'BIST:XBANK',
    'XSINA': 'BIST:XUSIN',
    'XUTUM': 'BIST:XUTUM',
    'X30YVADE': 'BIST:XU0301!',
    'NDX': 'TVC:NDX',
    'SPX': 'TVC:SPX',
    'DJI': 'TVC:DJI',
    'DAX': 'TVC:DAX',
    'UKX': 'TVC:UKX',
    'CAC40': 'TVC:CAC40',
    'NI225': 'TVC:NI225',
    'HSI': 'TVC:HSI',
    'SZSE': 'SZSE:399001',

    // EMTIA (TL BAZLI OLANLARI SEÇİYORUZ)
    'BRENT': 'TVC:UKOIL',
    'USOIL': 'TVC:USOIL',
    'NG1!': 'NYMEX:NG1!',
    'GOLD': 'FX_IDC:XAUTRY',
    'SILVER': 'FX_IDC:XAGTRY',
    'COPPER': 'COMEX:HG1!',
    'PLATINUM': 'NYMEX:PL1!',
    'PALLADIUM': 'NYMEX:PA1!',
    'CORN': 'CBOT:ZC1!',
    'WHEAT': 'CBOT:ZW1!',
    'SOYBEAN': 'CBOT:ZS1!',
    'SUGAR': 'ICEUS:SB1!',
    'COFFEE': 'ICEUS:KC1!',
    'COTTON': 'ICEUS:CT1!',
    'XAUTRY': 'FX_IDC:XAUTRY',
    'XAGTRY': 'FX_IDC:XAGTRY',
    'GLDGR': 'FX_IDC:XAUTRYG',

    // BIST ÖZEL
    'TEKFEN': 'BIST:TKFEN',
    'KOZAA': 'BIST:KOZAA',
    'BEKO': 'BIST:ARCLK',
    'ARCLK': 'BIST:ARCLK'
};

const nyseStocks = [
    'IBM', 'V', 'MA', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BA', 'DIS', 'KO', 'MCD',
    'NKE', 'WMT', 'TGT', 'PG', 'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'XOM', 'CVX',
    'COP', 'SLB', 'GE', 'F', 'GM', 'TM', 'HMC', 'SONY', 'VZ', 'T', 'ORCL', 'CRM'
];

function getSymbolForCategory(symbol, category) {
    if (symbolMapping[symbol]) return symbolMapping[symbol];

    const sym = symbol.toUpperCase();

    // Kategoriye göre borsa ata
    if (category === 'BORSA ISTANBUL') return `BIST:${sym}`;

    if (category === 'KRIPTO') {
        // Direkt BINANCE:BTCBRY gibi TRY çiftlerini kullan
        return `BINANCE:${sym.replace('TRY', '')}TRY`;
    }

    if (category === 'EXCHANGE') return `FX_IDC:${sym}`;
    if (category === 'STOCKS') return nyseStocks.includes(sym) ? `NYSE:${sym}` : `NASDAQ:${sym}`;

    // Default Tahmin
    if (sym.length >= 3 && sym.length <= 5 && /^[A-Z]+$/.test(sym)) {
        return `BIST:${sym}`;
    }

    return sym;
}

function prepareAllSymbols() {
    const formattedSymbols = ['FX_IDC:USDTRY'];
    Object.keys(reverseMapping).forEach(key => delete reverseMapping[key]);

    reverseMapping['FX_IDC:USDTRY'] = 'USDTRY';

    // 1. Sabit Mapped Sembolleri Ekle
    Object.entries(symbolMapping).forEach(([key, value]) => {
        formattedSymbols.push(value);
        reverseMapping[value] = key;
    });

    // 2. symbols.js'deki her şeyi kategorisine göre ekle
    Object.entries(symbolsData).forEach(([category, symbols]) => {
        symbols.forEach(sym => {
            const ticker = getSymbolForCategory(sym, category);
            if (!formattedSymbols.includes(ticker)) {
                formattedSymbols.push(ticker);
                reverseMapping[ticker] = sym;
            }
        });
    });

    // 3. Admin'den gelenleri ekle
    try {
        const configFile = path.join(__dirname, 'data/config.json');
        if (fs.existsSync(configFile)) {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (config.symbols) {
                config.symbols.forEach(s => {
                    const sym = typeof s === 'string' ? s : s.name;
                    const cat = typeof s === 'string' ? 'CUSTOM' : (s.category || 'CUSTOM');

                    const ticker = getSymbolForCategory(sym, cat);
                    if (!formattedSymbols.includes(ticker)) {
                        formattedSymbols.push(ticker);
                        reverseMapping[ticker] = sym;
                    }
                });
            }
        }
    } catch (e) { console.error('Prepare custom symbols error:', e); }

    const uniqueSymbols = [...new Set(formattedSymbols)];
    activeSymbols = uniqueSymbols;
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
                let currency = values.currency_code || (tvTicker.includes('TRY') ? 'TRY' : 'USD');

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
                latestPrices[symbol].currency = currency;

                if (latestPrices[symbol].price) {
                    const broadcastMsg = JSON.stringify({
                        type: 'price_update',
                        data: {
                            symbol: symbol,
                            price: latestPrices[symbol].price,
                            changePercent: latestPrices[symbol].changePercent,
                            currency: latestPrices[symbol].currency
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
            ws.send(JSON.stringify({ type: 'price_update', data: { symbol: sym, price: p.price, changePercent: p.changePercent } }));
        }
    });
});
