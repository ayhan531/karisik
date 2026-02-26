

import TickerCache from './models/TickerCache.js';

const memoryCache = new Map();

const pendingResolutions = new Map();

async function searchTradingView(query, preferredExchange = '') {
    const url = new URL('https://symbol-search.tradingview.com/symbol_search/v3/');
    url.searchParams.set('text', query);
    url.searchParams.set('hl', '0');
    url.searchParams.set('exchange', preferredExchange);
    url.searchParams.set('lang', 'tr');
    url.searchParams.set('search_type', 'undefined');
    url.searchParams.set('domain', 'production');
    url.searchParams.set('sort_by_country', 'TR');

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Origin': 'https://tr.tradingview.com',
            'Referer': 'https://tr.tradingview.com/'
        },
        signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error(`TV Search HTTP ${response.status}`);
    const data = await response.json();
    return data.symbols || [];
}

function pickBestMatch(sym, results, category) {
    if (!results || results.length === 0) return null;

    const categoryTypePrefs = {
        'BORSA ISTANBUL': ['stock'],
        'KRIPTO': ['crypto'],
        'EMTIA': ['futures', 'commodity', 'CFD'],
        'ENDEKSLER': ['index'],
        'EXCHANGE': ['forex'],
        'STOCKS': ['stock'],
        'DİĞER': null,
        'CUSTOM': null
    };

    const preferredTypes = categoryTypePrefs[category] || null;

    const exchangePriority = {
        'BORSA ISTANBUL': ['BIST'],
        'KRIPTO': ['BINANCE', 'BYBIT', 'OKX', 'COINBASE'],
        'EMTIA': ['NYMEX', 'COMEX', 'CBOT', 'ICEUS', 'TVC'],
        'ENDEKSLER': ['TVC', 'DJ', 'SP', 'NASDAQ'],
        'EXCHANGE': ['FX_IDC', 'FX', 'OANDA', 'FXCM'],
        'STOCKS': ['NASDAQ', 'NYSE', 'AMEX'],
    };

    const preferredExchanges = exchangePriority[category] || [];

    const scored = results.map(r => {
        let score = 0;
        const ticker = r.symbol || '';
        const exchange = r.exchange || '';
        const type = r.type || '';
        const description = (r.description || '').toUpperCase();

        const tickerBase = ticker.split(':').pop() || ticker;
        if (tickerBase === sym) score += 100;
        else if (tickerBase.startsWith(sym)) score += 50;
        else if (description.includes(sym)) score += 20;

        if (preferredTypes && preferredTypes.some(t => type.toLowerCase().includes(t.toLowerCase()))) {
            score += 40;
        }

        const exIdx = preferredExchanges.findIndex(e => exchange.toUpperCase().includes(e.toUpperCase()));
        if (exIdx !== -1) score += (30 - exIdx * 5);

        if (ticker.endsWith('USDT') && (category === 'KRIPTO' || !category)) score += 15;

        if (ticker.endsWith('1!') || ticker.endsWith('!')) score += 10;

        if (type === 'cfd') score -= 5;

        return { ...r, score, fullTicker: `${exchange}:${ticker}` };
    });

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 10) return null;

    return best;
}

export async function resolveSymbol(symbol, category = 'DİĞER') {
    const key = symbol.toUpperCase().trim();

    if (memoryCache.has(key)) {
        return memoryCache.get(key);
    }

    if (pendingResolutions.has(key)) {
        return pendingResolutions.get(key);
    }

    const resolutionPromise = (async () => {
        try {

            const cached = await TickerCache.findOne({ symbol: key });
            if (cached) {
                memoryCache.set(key, cached.ticker);
                console.log(`📦 Cache hit: ${key} → ${cached.ticker}`);
                return cached.ticker;
            }

            console.log(`🔍 TradingView'de aranıyor: ${key} (kategori: ${category})`);

            let results = await searchTradingView(key);

            if (results.length < 3) {

                if (!key.endsWith('USDT') && !key.endsWith('TRY')) {
                    const altResults = await searchTradingView(key + 'USDT');
                    results = [...results, ...altResults];
                }
            }

            const best = pickBestMatch(key, results, category);

            if (!best) {
                console.log(`⚠️ ${key} için TradingView'de eşleşme bulunamadı`);

                memoryCache.set(key, null);
                return null;
            }

            const ticker = best.fullTicker;
            console.log(`✅ Çözümlendi: ${key} → ${ticker} (${best.description || ''}, skor: ${best.score})`);

            await TickerCache.findOneAndUpdate(
                { symbol: key },
                {
                    symbol: key,
                    ticker: ticker,
                    exchange: best.exchange,
                    description: best.description,
                    type: best.type,
                    currency: best.currency_code,
                    resolvedAt: new Date()
                },
                { upsert: true, new: true }
            );

            memoryCache.set(key, ticker);
            return ticker;

        } catch (err) {
            console.error(`❌ Symbol resolve hatası (${key}):`, err.message);
            return null;
        } finally {
            pendingResolutions.delete(key);
        }
    })();

    pendingResolutions.set(key, resolutionPromise);
    return resolutionPromise;
}

export async function clearCache(symbol = null) {
    if (symbol) {
        const key = symbol.toUpperCase().trim();
        memoryCache.delete(key);
        await TickerCache.deleteOne({ symbol: key });
        console.log(`🗑️ Cache temizlendi: ${key}`);
    } else {
        memoryCache.clear();
        await TickerCache.deleteMany({});
        console.log('🗑️ Tüm ticker cache temizlendi');
    }
}

export async function listCache() {
    return TickerCache.find({}).sort({ resolvedAt: -1 }).lean();
}

export async function manuallySetTicker(symbol, ticker) {
    const key = symbol.toUpperCase().trim();
    memoryCache.set(key, ticker);
    await TickerCache.findOneAndUpdate(
        { symbol: key },
        { symbol: key, ticker, isManual: true, resolvedAt: new Date() },
        { upsert: true, new: true }
    );
    console.log(`✏️ Manuel ticker set edildi: ${key} → ${ticker}`);
}
