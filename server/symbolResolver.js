/**
 * 🔍 Otomatik Sembol Çözümleyici
 * 
 * TradingView'in public arama API'sini kullanarak herhangi bir sembol adını
 * doğru TradingView ticker'ına dönüştürür (örn: "NATGAS" → "NYMEX:NG1!").
 * 
 * Sonuçlar MongoDB'de cache'lenir. Bir kez bulunan sembol tekrar aranmaz.
 */

import TickerCache from './models/TickerCache.js';

// In-memory cache (process restart'a kadar geçerli - DB'ye gerek kalmadan hızlı)
const memoryCache = new Map();

// Aynı anda birden fazla istek gelirse aynı sembol için tek arama yapılsın
const pendingResolutions = new Map();

/**
 * TradingView arama API'sini çağırır
 * @param {string} query - Aranacak sembol
 * @param {string} preferredExchange - Tercihli borsa (opsiyonel)
 * @returns {Array} TV sonuçları
 */
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

/**
 * Sonuçlar arasından en uygun ticker'ı seçer
 * @param {string} sym - Aranan sembol (uppercase)
 * @param {Array} results - TV arama sonuçları
 * @param {string} category - Kategori ipucu
 * @returns {Object|null} En iyi eşleşme
 */
function pickBestMatch(sym, results, category) {
    if (!results || results.length === 0) return null;

    // Kategori → tip ön tercihleri
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

    // Borsa tercihleri (sıraya göre)
    const exchangePriority = {
        'BORSA ISTANBUL': ['BIST'],
        'KRIPTO': ['BINANCE', 'BYBIT', 'OKX', 'COINBASE'],
        'EMTIA': ['NYMEX', 'COMEX', 'CBOT', 'ICEUS', 'TVC'],
        'ENDEKSLER': ['TVC', 'DJ', 'SP', 'NASDAQ'],
        'EXCHANGE': ['FX_IDC', 'FX', 'OANDA', 'FXCM'],
        'STOCKS': ['NASDAQ', 'NYSE', 'AMEX'],
    };

    const preferredExchanges = exchangePriority[category] || [];

    // Sonuçları puanla
    const scored = results.map(r => {
        let score = 0;
        const ticker = r.symbol || '';
        const exchange = r.exchange || '';
        const type = r.type || '';
        const description = (r.description || '').toUpperCase();

        // Tam sembol eşleşmesi (büyük bonus)
        const tickerBase = ticker.split(':').pop() || ticker;
        if (tickerBase === sym) score += 100;
        else if (tickerBase.startsWith(sym)) score += 50;
        else if (description.includes(sym)) score += 20;

        // Tercih edilen tip
        if (preferredTypes && preferredTypes.some(t => type.toLowerCase().includes(t.toLowerCase()))) {
            score += 40;
        }

        // Tercih edilen borsa
        const exIdx = preferredExchanges.findIndex(e => exchange.toUpperCase().includes(e.toUpperCase()));
        if (exIdx !== -1) score += (30 - exIdx * 5);

        // Kripto: USDT çiftlerini tercih et
        if (ticker.endsWith('USDT') && (category === 'KRIPTO' || !category)) score += 15;

        // Popüler/Ana sözleşmeler (!) bonusu
        if (ticker.endsWith('1!') || ticker.endsWith('!')) score += 10;

        // Spot vs CFD - spot tercih (CFD cezalandır biraz)
        if (type === 'cfd') score -= 5;

        return { ...r, score, fullTicker: `${exchange}:${ticker}` };
    });

    // En yüksek puanlıyı seç
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 10) return null;

    return best;
}

/**
 * Ana fonksiyon: sembol → TradingView ticker çözümle
 * @param {string} symbol - Sembol adı (örn: "NATGAS", "RACE", "BTC")
 * @param {string} category - Kategori ipucu (örn: "DİĞER", "KRIPTO")
 * @returns {Promise<string|null>} TradingView ticker (örn: "NYMEX:NG1!") veya null
 */
export async function resolveSymbol(symbol, category = 'DİĞER') {
    const key = symbol.toUpperCase().trim();

    // 1. Memory cache'e bak (en hızlı)
    if (memoryCache.has(key)) {
        return memoryCache.get(key);
    }

    // 2. Aynı anda aynı sembol için duplicate request varsa beklet
    if (pendingResolutions.has(key)) {
        return pendingResolutions.get(key);
    }

    // 3. Promise oluştur ve pending'e ekle
    const resolutionPromise = (async () => {
        try {
            // 3a. MongoDB cache'e bak
            const cached = await TickerCache.findOne({ symbol: key });
            if (cached) {
                memoryCache.set(key, cached.ticker);
                console.log(`📦 Cache hit: ${key} → ${cached.ticker}`);
                return cached.ticker;
            }

            // 3b. TradingView'de ara
            console.log(`🔍 TradingView'de aranıyor: ${key} (kategori: ${category})`);

            let results = await searchTradingView(key);

            // Sonuç az/yok ise farklı variasyonları dene
            if (results.length < 3) {
                // Kriptolar için USDT suffix'i dene
                if (!key.endsWith('USDT') && !key.endsWith('TRY')) {
                    const altResults = await searchTradingView(key + 'USDT');
                    results = [...results, ...altResults];
                }
            }

            const best = pickBestMatch(key, results, category);

            if (!best) {
                console.log(`⚠️ ${key} için TradingView'de eşleşme bulunamadı`);
                // Null cache'le (tekrar aramayı önlemek için, 1 saat sonra tekrar dene)
                memoryCache.set(key, null);
                return null;
            }

            const ticker = best.fullTicker;
            console.log(`✅ Çözümlendi: ${key} → ${ticker} (${best.description || ''}, skor: ${best.score})`);

            // 3c. MongoDB'ye kaydet
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

            // Memory cache'e de al
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

/**
 * Cache'i temizle (belirli semboller veya tümü)
 * @param {string|null} symbol - null ise tümü
 */
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

/**
 * Tüm cache içeriğini listele (admin için)
 */
export async function listCache() {
    return TickerCache.find({}).sort({ resolvedAt: -1 }).lean();
}

/**
 * Manuel ticker set et (admin override)
 * @param {string} symbol 
 * @param {string} ticker 
 */
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
