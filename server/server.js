import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import ConfigModel from './models/Config.js';
import TickerCache from './models/TickerCache.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import fs from 'fs';
import { symbolsData } from '../symbols.js';
import { resolveSymbol, clearCache, listCache, manuallySetTicker } from './symbolResolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;
const API_SECRET = 'EsMenkul_Secret_2026';

app.use(cors());
app.use(bodyParser.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'EsMenkul_Secure_2026_Session_Secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.' }
});

const isAuthenticated = (req, res, next) => {

    if (req.session.authenticated) {
        return next();
    }

    const publicPaths = ['/login.html', '/auth/login', '/auth/check', '/auth/logout'];
    if (publicPaths.includes(req.path)) {
        return next();
    }

    if (req.originalUrl.startsWith('/api/')) {

        const publicApis = ['/api/public-symbols', '/api/prices'];
        if (publicApis.some(p => req.originalUrl.startsWith(p))) {
            return next();
        }
        return res.status(401).json({ success: false, message: 'Yetkisiz erişim.' });
    }

    res.redirect('/admin/login.html');
};

app.get('/api/public-symbols', async (req, res) => {
    try {
        let config = await ConfigModel.findOne({ key: 'global' });
        if (config) {
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

app.use('/api/auth', authRoutes);

app.get('/admin/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../admin/login.html'));
});

app.use('/admin', isAuthenticated, express.static(path.join(__dirname, '../admin')));
app.use('/api/admin', isAuthenticated, adminRoutes);

app.use(express.static(path.join(__dirname, '../'), { index: 'index.html' }));

let browser = null;
let page = null;
let latestPrices = {};
let usdTryRate = 34.20;
let lastDataTime = Date.now();
let activeSymbols = [];
let globalDelay = 0;
let priceOverrides = {};
let pausedSymbols = new Set();

app.locals.getMetrics = () => {
    let wsCount = 0;
    if (app.locals.wss) wsCount = app.locals.wss.clients.size;
    return {
        wsClients: wsCount,
        lastDataTime: lastDataTime,
        playwrightStatus: page ? 'Bağlı' : 'Koptu'
    };
};

mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://esmenkuladmin:p0sYDBEw7vST9gH6@cluster0.z2s3t.mongodb.net/karisik?retryWrites=true&w=majority&appName=Cluster0')
    .then(async () => {
        console.log('✅ MongoDB Bağlantısı Başarılı');

        const config = await ConfigModel.findOne({ key: 'global' });
        if (config) {
            if (config.delay) globalDelay = config.delay;
            if (config.overrides) {

                priceOverrides = Object.fromEntries(config.overrides.entries());
            }
            if (config.symbols) {
                config.symbols.forEach(s => {
                    const sName = typeof s === 'string' ? s : s.name;
                    if (s.paused) pausedSymbols.add(sName);
                });
            }
        }

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

        wss.on('connection', (ws) => {
            Object.keys(latestPrices).forEach(sym => {
                const p = latestPrices[sym];
                if (p.price) {
                    ws.send(JSON.stringify({ type: 'price_update', data: { symbol: sym, price: p.price, changePercent: p.changePercent } }));
                }
            });
        });

        app.locals.wss = wss;

    })
    .catch(e => {
        console.error('❌ MongoDB Bağlantı Hatası:', e);
    });

app.locals.addSymbolToStream = async (symbol, category = 'CUSTOM') => {
    console.log(`🆕 Yeni Sembol Eklendi: ${symbol} (Kategori: ${category})`);

    const ticker = await resolveSymbolTicker(symbol, category);
    if (!ticker) { console.log(`⚠️ Ticker dönüştürülemedi: ${symbol}`); return; }
    console.log(`📡 TradingView Ticker: ${ticker}`);

    if (!reverseMapping[ticker]) reverseMapping[ticker] = [];
    if (!reverseMapping[ticker].includes(symbol)) reverseMapping[ticker].push(symbol);

    if (!activeSymbols.includes(ticker)) {
        activeSymbols.push(ticker);
    }

    if (page) {
        page.evaluate(({ tvTicker, allSymbols }) => {
            try {
                if (window.tvSocket && window.tvSocket.readyState === 1 && window._tvSessionId) {
                    const constructMessage = (func, paramList) => {
                        const json = JSON.stringify({ m: func, p: paramList });
                        return `~m~${json.length}~m~${json}`;
                    };

                    const sessionId = window._tvSessionId;
                    window.tvSocket.send(constructMessage('quote_add_symbols', [sessionId, tvTicker]));
                    window.tvSocket.send(constructMessage('quote_fast_symbols', [sessionId, ...allSymbols]));

                    return true;
                }
                return false;
            } catch (e) {
                return false;
            }
        }, { tvTicker: ticker, allSymbols: activeSymbols }).then(success => {
            if (!success) {
                console.log(`⚠️ Anlık enjeksiyon başarısız (${ticker}), reconnect başlatılıyor...`);
                setTimeout(() => startTradingViewConnection(), 1000);
            } else {
                console.log(`✅ Sembol canlı enjekte edildi: ${ticker}`);
            }
        }).catch(() => {
            setTimeout(() => startTradingViewConnection(), 1000);
        });
    } else {
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

app.locals.updatePaused = (symbol, isPaused) => {
    console.log(`⏸️ Sembol Duraklatma Güncellendi: ${symbol} = ${isPaused}`);
    if (isPaused) pausedSymbols.add(symbol);
    else pausedSymbols.delete(symbol);
};

app.locals.updateDelay = (delay) => {
    console.log(`⏱️ Gecikme Ayarlandı: ${delay}ms`);
    globalDelay = delay;
};

app.locals.getActiveSymbols = () => {

    return activeSymbols.map(s => {

        const clean = (reverseMapping[s] && reverseMapping[s].length > 0) ? reverseMapping[s][0] : s.split(':').pop();
        return clean;
    });
};

app.locals.getSymbolsData = () => symbolsData;

const symbolMapping = {

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

const knownCryptos = new Set([
    'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOGE', 'SHIB', 'DOT', 'LINK', 'TRX', 'POL', 'LTC',
    'BCH', 'UNI', 'XLM', 'ATOM', 'ETC', 'FIL', 'HBAR', 'APT', 'ARB', 'OP', 'INJ', 'RENDER', 'GRT', 'STX',
    'NEAR', 'ALGO', 'AAVE', 'SAND', 'GALA', 'MANA', 'EGLD', 'THETA', 'AXS', 'XTZ', 'MINA', 'CHZ', 'NEO',
    'JASMY', 'PEPE', 'FLOKI', 'BONK', 'WIF', '1000SATS', 'FET', 'CFX', 'SUI', 'SEI', 'TIA', 'ORDI',
    'BLUR', 'MEME', 'WLD', 'API3', 'MAGIC', 'GMX', 'LIDO', 'RPL', 'SNX', 'CRV', 'BAL', 'YFI', 'COMP',
    'MKR', 'SUSHI', '1INCH', 'CAKE', 'RAY', 'SRM', 'MATIC', 'FTM', 'ONE', 'ZIL', 'ICX', 'IOTA', 'EOS',
    'NANO', 'ZEC', 'DASH', 'XMR', 'DCR', 'DGB', 'RVN', 'KMD', 'VTC', 'BTG', 'WAVES', 'LSK', 'STEEM', 'ARDR'
]);

const nasdaqStocks = new Set([
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX', 'AMD', 'INTC', 'CSCO', 'ADBE', 'PYPL',
    'CRM', 'ORCL', 'QCOM', 'TXN', 'AVGO', 'MU', 'AMAT', 'LRCX', 'KLAC', 'MRVL', 'NXPI', 'SWKS', 'ZBRA',
    'TEAM', 'DOCU', 'ZS', 'CRWD', 'OKTA', 'NET', 'DDOG', 'MDB', 'SNOW', 'PLTR', 'COIN', 'HOOD', 'RBLX'
]);
const nyseStocksSet = new Set([
    'IBM', 'V', 'MA', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BA', 'DIS', 'KO', 'PEP', 'MCD', 'SBUX', 'NKE',
    'WMT', 'TGT', 'COST', 'PG', 'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'XOM', 'CVX', 'COP', 'SLB',
    'GE', 'F', 'GM', 'TM', 'HMC', 'SONY', 'TMUS', 'VZ', 'T', 'BRK.B', 'JPM', 'HD', 'LOW', 'TJX', 'BABA'
]);

function quickGuessSymbol(sym, category) {
    if (!sym) return null;
    if (sym.includes(':')) return sym.toUpperCase();

    if (symbolMapping[sym]) return symbolMapping[sym];

    if (category === 'BORSA ISTANBUL') return `BIST:${sym}`;
    if (category === 'EXCHANGE') return `FX_IDC:${sym}`;

    if (category === 'KRIPTO') {
        if (sym.endsWith('USDT') || sym.endsWith('TRY')) return `BINANCE:${sym}`;
        if (sym.endsWith('USD')) return `BINANCE:${sym.slice(0, -3)}USDT`;
        return `BINANCE:${sym}USDT`;
    }

    if (category === 'STOCKS') {
        if (nyseStocksSet.has(sym)) return `NYSE:${sym}`;
        return `NASDAQ:${sym}`;
    }

    const cryptoSuffixes = ['USDT', 'USDC', 'USD', 'TRY', 'BTC', 'ETH', 'BNB'];
    for (const suffix of cryptoSuffixes) {
        if (sym.endsWith(suffix)) {
            const base = sym.slice(0, -suffix.length);
            if (knownCryptos.has(base)) {
                return suffix === 'USD' ? `BINANCE:${base}USDT` : `BINANCE:${sym}`;
            }
        }
    }
    if (nasdaqStocks.has(sym)) return `NASDAQ:${sym}`;
    if (nyseStocksSet.has(sym)) return `NYSE:${sym}`;
    if (knownCryptos.has(sym)) return `BINANCE:${sym}USDT`;

    return null;
}

function getSymbolForCategory(symbol, category) {
    if (!symbol) return null;
    const sym = symbol.toUpperCase().trim();
    return quickGuessSymbol(sym, category) || `BIST:${sym}`;
}

async function resolveSymbolTicker(symbol, category) {
    if (!symbol) return null;
    const sym = symbol.toUpperCase().trim();

    const quick = quickGuessSymbol(sym, category);
    if (quick) return quick;

    const resolved = await resolveSymbol(sym, category);
    if (resolved) return resolved;

    console.log(`⚠️ ${sym} çözümlenemedi, BIST fallback kullanılıyor`);
    return `BIST:${sym}`;
}

async function prepareAllSymbols() {
    const formattedSymbols = ['FX_IDC:USDTRY'];
    Object.keys(reverseMapping).forEach(key => delete reverseMapping[key]);

    const addMapping = (ticker, sym) => {
        if (!reverseMapping[ticker]) reverseMapping[ticker] = [];
        if (!reverseMapping[ticker].includes(sym)) reverseMapping[ticker].push(sym);
    };

    addMapping('FX_IDC:USDTRY', 'USDTRY');

    Object.entries(symbolMapping).forEach(([key, value]) => {
        formattedSymbols.push(value);
        addMapping(value, key);
    });

    Object.entries(symbolsData).forEach(([category, symbols]) => {
        symbols.forEach(sym => {
            const cleanSym = sym.replace(/\s*\/\/.*/, '').trim();
            const ticker = getSymbolForCategory(cleanSym, category);
            if (!formattedSymbols.includes(ticker)) {
                formattedSymbols.push(ticker);
            }
            addMapping(ticker, cleanSym);
        });
    });

    try {
        const config = await ConfigModel.findOne({ key: 'global' });
        if (config && config.symbols) {

            const resolvePromises = config.symbols.map(async (s) => {
                const sym = typeof s === 'string' ? s : s.name;
                const cat = typeof s === 'string' ? 'CUSTOM' : (s.category || 'CUSTOM');
                const ticker = await resolveSymbolTicker(sym, cat);
                return { sym, ticker };
            });

            const resolved = await Promise.allSettled(resolvePromises);
            resolved.forEach(r => {
                if (r.status === 'fulfilled' && r.value.ticker) {
                    const { sym, ticker } = r.value;
                    if (!formattedSymbols.includes(ticker)) {
                        formattedSymbols.push(ticker);
                    }
                    addMapping(ticker, sym);
                }
            });
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

    try { await page.exposeFunction('onDataReceived', (data) => processRawData(data)); } catch (e) { }
    try { await page.exposeFunction('onBrowserReloadRequest', () => { setTimeout(startTradingViewConnection, 5000); }); } catch (e) { }

    const allSymbols = await prepareAllSymbols();

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

                window._tvSessionId = sessionId;
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
Object.entries(symbolMapping).forEach(([key, value]) => {
    if (!reverseMapping[value]) reverseMapping[value] = [];
    reverseMapping[value].push(key);
});

function processRawData(rawData) {
    lastDataTime = Date.now();

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
                let mappedSymbols = reverseMapping[tvTicker];
                if (!mappedSymbols || mappedSymbols.length === 0) {
                    mappedSymbols = [tvTicker.split(':').pop()];
                }

                mappedSymbols.forEach(symbol => {

                    if (symbol === 'TKFEN') symbol = 'TEKFEN';
                    if (symbol === 'ARCLK') symbol = 'BEKO';
                    if (symbol === 'XUSIN') symbol = 'XSINA';
                    if (symbol === '399001') symbol = 'SZSE';
                    if (tvTicker === 'FX_IDC:XAUTRYG') symbol = 'GLDGR';

                    let finalPrice = values.lp;
                    if (tvTicker === 'FX_IDC:USDTRY' && values.lp) {
                        usdTryRate = values.lp;

                        if (!mappedSymbols.includes('USDTRY')) {

                            symbol = 'USDTRY';
                        }
                    }

                    let currency = values.currency_code || (tvTicker.includes('TRY') ? 'TRY' : 'USD');

                    if (pausedSymbols.has(symbol)) return;

                    if (priceOverrides[symbol]) {
                        const override = priceOverrides[symbol];
                        if (override.expiresAt && Date.now() > new Date(override.expiresAt).getTime()) {

                        } else {
                            if (override.type === 'fixed') {
                                finalPrice = override.value;
                            } else if (override.type === 'multiplier') {
                                if (finalPrice) {
                                    finalPrice = finalPrice * override.value;
                                }
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
                        if (app.locals.wss) {
                            app.locals.wss.clients.forEach(c => { if (c.readyState === 1) c.send(broadcastMsg); });
                        }

                        if (symbol.endsWith('USDT')) {
                            const withoutT = symbol.slice(0, -1);

                            const broadcastMsgAlt = JSON.stringify({
                                type: 'price_update',
                                data: {
                                    symbol: withoutT,
                                    price: latestPrices[symbol].price,
                                    changePercent: latestPrices[symbol].changePercent,
                                    currency: latestPrices[symbol].currency
                                }
                            });
                            if (app.locals.wss) {
                                app.locals.wss.clients.forEach(c => { if (c.readyState === 1) c.send(broadcastMsgAlt); });
                            }
                        }
                    }
                });
            }
        } catch (e) { }
    }
}
