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

const symbolMapping = {
    'XU100': 'BIST:XU100', 'XU030': 'BIST:XU030', 'XBANK': 'BIST:XBANK', 'XSINA': 'BIST:XUSIN',
    'XUTUM': 'BIST:XUTUM', 'X30YVADE': 'BIST:XU0301!', 'NDX': 'TVC:NDX', 'SPX': 'TVC:SPX',
    'DJI': 'TVC:DJI', 'DAX': 'TVC:DAX', 'UKX': 'TVC:UKX', 'CAC40': 'TVC:CAC40',
    'NI225': 'TVC:NI225', 'HSI': 'TVC:HSI', 'SZSE': 'SZSE:399001', 'BRENT': 'TVC:UKOIL',
    'USOIL': 'TVC:USOIL', 'NG1!': 'NYMEX:NG1!', 'NATGAS': 'NYMEX:NG1!', 'NATURALGAS': 'NYMEX:NG1!',
    'NGAS': 'NYMEX:NG1!', 'GOLD': 'FX_IDC:XAUTRY', 'SILVER': 'FX_IDC:XAGTRY',
    'XAUTRY': 'FX_IDC:XAUTRY', 'XAGTRY': 'FX_IDC:XAGTRY', 'GLDGR': 'FX_IDC:XAUTRYG',
    'XAUUSD': 'OANDA:XAUUSD', 'XAGUSD': 'OANDA:XAGUSD', 'BTC': 'BINANCE:BTCUSDT',
    'ETH': 'BINANCE:ETHUSDT', 'SOL': 'BINANCE:SOLUSDT', 'XRP': 'BINANCE:XRPUSDT',
    'BTCUSDT': 'BINANCE:BTCUSDT', 'ETHUSDT': 'BINANCE:ETHUSDT', 'BTCTRY': 'BINANCE:BTCTRY',
    'ETHTRY': 'BINANCE:ETHTRY', 'GBPTRY': 'FX_IDC:GBPTRY', 'USDCHF': 'FX_IDC:USDCHF',
    'TEKFEN': 'BIST:TKFEN', 'KOZAA': 'BIST:KOZAA', 'BEKO': 'BIST:ARCLK', 'ARCLK': 'BIST:ARCLK'
};

const knownCryptos = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOGE', 'SHIB', 'DOT', 'LINK', 'TRX', 'POL', 'LTC']);
const nasdaqStocks = new Set(['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX', 'AMD', 'INTC']);
const nyseStocksSet = new Set(['IBM', 'V', 'MA', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BA', 'DIS', 'KO', 'PEP']);

app.use(cors());
app.use(bodyParser.json());
app.use(session({
    secret: 'EsMenkul_Secure_2026_Session_Secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 1000 * 60 * 60 * 24 }
}));

const isAuthenticated = (req, res, next) => {
    if (req.session.authenticated || req.path.startsWith('/api/auth/')) return next();
    if (req.path === '/api/public-symbols' || req.path === '/api/prices') return next();
    return next();
};

app.get('/api/public-symbols', async (req, res) => {
    try {
        let config = await ConfigModel.findOne({ key: 'global' });
        const customSymbols = config?.symbols || [];
        res.json({ symbols: customSymbols.map(s => typeof s === 'string' ? { name: s, category: 'DİĞER' } : s) });
    } catch (e) { res.json({ symbols: [] }); }
});

app.use('/api/auth', authRoutes);
app.use('/admin', isAuthenticated, express.static(path.join(__dirname, '../admin')));
app.use('/api/admin', isAuthenticated, adminRoutes);
app.use(express.static(path.join(__dirname, '../'), { index: 'index.html' }));

let browser, page, activeSymbols = [], priceOverrides = {}, pausedSymbols = new Set(), latestPrices = {}, reverseMapping = {};

function quickGuessSymbol(sym, category) {
    if (!sym) return null;
    const s = sym.toUpperCase().trim();
    if (s.includes(':')) return s;
    if (symbolMapping[s]) return symbolMapping[s];
    if (category === 'BORSA ISTANBUL') return `BIST:${s}`;
    if (category === 'KRIPTO' || knownCryptos.has(s)) return `BINANCE:${s}USDT`;
    if (nasdaqStocks.has(s)) return `NASDAQ:${s}`;
    if (nyseStocksSet.has(s)) return `NYSE:${s}`;
    return null;
}

async function resolveSymbolTicker(symbol, category) {
    const sym = symbol.toUpperCase().trim();
    return quickGuessSymbol(sym, category) || await resolveSymbol(sym, category) || `BIST:${sym}`;
}

async function prepareAllSymbols() {
    const formattedSymbols = ['FX_IDC:USDTRY'];
    Object.keys(reverseMapping).forEach(k => delete reverseMapping[k]);
    const addMap = (t, s) => {
        const tick = t.toUpperCase().trim();
        const symb = s.toUpperCase().trim();
        if (!reverseMapping[tick]) reverseMapping[tick] = [];
        if (!reverseMapping[tick].includes(symb)) reverseMapping[tick].push(symb);
    };
    addMap('FX_IDC:USDTRY', 'USDTRY');

    const allWork = [];
    for (const [category, symbols] of Object.entries(symbolsData)) {
        symbols.forEach(sym => {
            const cleanSym = sym.split('//')[0].trim().toUpperCase();
            allWork.push((async () => {
                const ticker = await resolveSymbolTicker(cleanSym, category);
                if (ticker) {
                    if (!formattedSymbols.includes(ticker)) formattedSymbols.push(ticker);
                    addMap(ticker, cleanSym);
                }
            })());
        }
    }

    try {
        const config = await ConfigModel.findOne({ key: 'global' });
        if (config && config.symbols) {
            config.symbols.forEach(sObj => {
                const sName = (typeof sObj === 'string' ? sObj : sObj.name).toUpperCase().trim();
                const sCat = typeof sObj === 'string' ? 'CUSTOM' : (sObj.category || 'CUSTOM');
                allWork.push((async () => {
                    const ticker = await resolveSymbolTicker(sName, sCat);
                    if (ticker) {
                        if (!formattedSymbols.includes(ticker)) formattedSymbols.push(ticker);
                        addMap(ticker, sName);
                    }
                })());
            });
        }
    } catch (e) { }

    await Promise.all(allWork);
    activeSymbols = [...new Set(formattedSymbols)];
    console.log(`📡 Toplam ${activeSymbols.length} sembol TradingView'den izleniyor.`);
    return activeSymbols;
}

async function startTradingViewConnection() {
    console.log('🔌 TradingView Bağlantısı Başlatılıyor...');
    if (browser) try { await browser.close(); } catch (e) { }
    try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const context = await browser.newContext();
        await context.addCookies([
            { name: 'sessionid', value: 'owdl1knxegxizb3jz4jub973l3jf8r5h', domain: '.tradingview.com', path: '/' },
            { name: 'sessionid_sign', value: 'v3:vTg6tTsF73zJMZdotbHAjbi4gIaUtfLj8zpEbrnhJHQ=', domain: '.tradingview.com', path: '/' }
        ]);
        page = await context.newPage();
        await page.exposeFunction('onDataReceived', (d) => processRawData(d));
        const symbols = await prepareAllSymbols();
        await page.addInitScript((ss) => {
            const NativeWS = window.WebSocket;
            window.WebSocket = function (url, protocols) {
                const ws = new NativeWS(url, protocols);
                window.tvSocket = ws;
                ws.addEventListener('open', () => {
                    const msg = (f, p) => { const j = JSON.stringify({ m: f, p }); return `~m~${j.length}~m~${j}`; };
                    const sid = 'qs_' + Math.random().toString(36).substring(7);
                    window._tvSessionId = sid;
                    ws.send(msg('quote_create_session', [sid]));
                    ws.send(msg('quote_set_fields', [sid, 'lp', 'ch', 'chp', 'status', 'currency_code']));
                    let i = 0;
                    const batch = () => {
                        if (i >= ss.length) return;
                        ws.send(msg('quote_add_symbols', [sid, ...ss.slice(i, i + 15)]));
                        i += 15; setTimeout(batch, 1200);
                    };
                    setTimeout(batch, 3000);
                });
                ws.addEventListener('message', (e) => window.onDataReceived(e.data));
                return ws;
            };
        }, symbols);
        await page.goto('https://tr.tradingview.com/chart/', { timeout: 60000 });
        console.log('✅ TradingView Bağlantısı Aktif.');
    } catch (e) {
        console.error('❌ Playwright Hatası:', e);
        setTimeout(startTradingViewConnection, 10000);
    }
}

function processRawData(rawData) {
    const regex = /~m~(\d+)~m~/g;
    let match;
    while ((match = regex.exec(rawData)) !== null) {
        const start = match.index + match[0].length;
        try {
            const msg = JSON.parse(rawData.substring(start, start + parseInt(match[1])));
            if (msg.m === 'qsd' && msg.p && msg.p[1]) {
                const ticker = msg.p[1].n.split(',')[0].trim().toUpperCase();
                const values = msg.p[1].v;
                const mapped = reverseMapping[ticker] || [ticker.split(':').pop().toUpperCase()];
                mapped.forEach(s => {
                    if (pausedSymbols.has(s)) return;
                    let price = values.lp;
                    if (priceOverrides[s]) price = priceOverrides[s].type === 'fixed' ? priceOverrides[s].value : price * priceOverrides[s].value;
                    if (price) {
                        latestPrices[s] = { price, changePercent: values.chp, currency: values.currency_code || 'USD' };
                        const out = JSON.stringify({ type: 'price_update', data: { symbol: s, price, changePercent: values.chp, currency: latestPrices[s].currency } });
                        if (app.locals.wss) app.locals.wss.clients.forEach(c => { if (c.readyState === 1) c.send(out); });
                    }
                });
            }
        } catch (e) { }
    }
}

mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://esmenkuladmin:p0sYDBEw7vST9gH6@cluster0.z2s3t.mongodb.net/karisik?retryWrites=true&w=majority&appName=Cluster0')
    .then(async () => {
        const config = await ConfigModel.findOne({ key: 'global' });
        if (config) {
            if (config.overrides) priceOverrides = Object.fromEntries(config.overrides.entries());
            if (config.symbols) config.symbols.forEach(s => { if (s.paused) pausedSymbols.add((typeof s === 'string' ? s : s.name).toUpperCase()); });
        }
        const server = app.listen(PORT, () => {
            console.log(`🚀 Server ${PORT} üzerinde çalışıyor.`);
            app.locals.wss = new WebSocketServer({
                server,
                verifyClient: (info, callback) => {
                    try {
                        const url = new URL(info.req.url, 'http://localhost');
                        callback(url.searchParams.get('token') === API_SECRET);
                    } catch (e) { callback(false); }
                }
            });
            startTradingViewConnection();
            app.locals.wss.on('connection', (ws) => {
                Object.keys(latestPrices).forEach(s => {
                    const p = latestPrices[s];
                    ws.send(JSON.stringify({ type: 'price_update', data: { symbol: s, price: p.price, changePercent: p.changePercent, currency: p.currency } }));
                });
            });
        });
    });

app.locals.addSymbolToStream = async (symbol, category) => {
    const sym = symbol.toUpperCase().trim();
    const ticker = await resolveSymbolTicker(sym, category);
    if (ticker) {
        if (!reverseMapping[ticker]) reverseMapping[ticker] = [];
        if (!reverseMapping[ticker].includes(sym)) reverseMapping[ticker].push(sym);
        if (!activeSymbols.includes(ticker)) {
            activeSymbols.push(ticker);
            if (page) {
                await page.evaluate(({ sid, t }) => {
                    const msg = (f, p) => { const j = JSON.stringify({ m: f, p }); return `~m~${j.length}~m~${j}`; };
                    if (window.tvSocket && window.tvSocket.readyState === 1 && sid) {
                        window.tvSocket.send(msg('quote_add_symbols', [sid, t]));
                    }
                }, { sid: await page.evaluate(() => window._tvSessionId), t: ticker });
            }
        }
        if (app.locals.wss) app.locals.wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_symbol', symbol: sym })); });
    }
};
