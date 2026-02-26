import express from 'express';
import ConfigModel from '../models/Config.js';
import { clearCache, listCache, manuallySetTicker } from '../symbolResolver.js';

const router = express.Router();

const getConfig = async () => {
    let config = await ConfigModel.findOne({ key: 'global' });
    if (!config) {
        config = new ConfigModel({
            key: 'global',
            symbols: [],
            overrides: {},
            delay: 0
        });
        await config.save();
    }

    const obj = config.toObject();
    if (obj.overrides && obj.overrides instanceof Map) {
        obj.overrides = Object.fromEntries(obj.overrides);
    }
    return obj;
};

const saveConfig = async (newConfigData) => {
    await ConfigModel.findOneAndUpdate(
        { key: 'global' },
        newConfigData,
        { upsert: true, new: true }
    );
};

router.get('/config', async (req, res) => {
    const config = await getConfig();

    const customSymbolNames = new Set(
        config.symbols.map(s => (typeof s === 'string' ? s : s.name))
    );

    const customSymbols = config.symbols.map(s => {
        if (typeof s === 'string') {
            return { name: s.split(':').pop(), category: 'DİĞER', isCustom: true, paused: false };
        }
        return { name: s.name, category: s.category || 'DİĞER', isCustom: true, paused: s.paused || false };
    });

    let systemSymbols = [];
    if (req.app.locals.getSymbolsData) {
        const symbolsData = req.app.locals.getSymbolsData();
        Object.entries(symbolsData).forEach(([category, syms]) => {
            syms.forEach(name => {
                const cleanName = name.replace(/\s*\/\/.*/, '').trim();
                if (!customSymbolNames.has(cleanName)) {
                    systemSymbols.push({ name: cleanName, category, isCustom: false, paused: false });
                }
            });
        });
    }

    const allSymbols = [...systemSymbols, ...customSymbols];

    res.json({
        ...config,
        symbols: allSymbols,
        metrics: req.app.locals.getMetrics ? req.app.locals.getMetrics() : null
    });
});

router.post('/symbol', async (req, res) => {
    const { symbol, category } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Sembol gerekli' });

    const config = await getConfig();

    const exists = (config.symbols || []).some(s => {
        const sName = typeof s === 'string' ? s : s.name;
        return sName === symbol;
    });

    if (!exists) {
        if (!config.symbols) config.symbols = [];
        config.symbols.push({ name: symbol, category: category || 'DİĞER', isCustom: true });
        await saveConfig(config);

        if (req.app.locals.addSymbolToStream) {
            req.app.locals.addSymbolToStream(symbol, category);
        }
    }
    res.json({ success: true, symbols: config.symbols });
});

router.post('/override', async (req, res) => {
    const { symbol, price, multiplier } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Sembol gerekli' });

    const config = await getConfig();

    if (price === undefined && multiplier === undefined) {
        if (config.overrides) delete config.overrides[symbol];
    } else {
        if (!config.overrides) config.overrides = {};

        let overrideObj = {
            type: price !== undefined ? 'fixed' : 'multiplier',
            value: price !== undefined ? parseFloat(price) : parseFloat(multiplier)
        };

        if (req.body.expiresIn) {
            overrideObj.expiresAt = new Date(Date.now() + parseInt(req.body.expiresIn) * 60000);
        }

        config.overrides[symbol] = overrideObj;
    }

    await saveConfig(config);

    if (req.app.locals.updateOverrides) {
        req.app.locals.updateOverrides(config.overrides);
    }
    res.json({ success: true, overrides: config.overrides });
});

router.post('/delay', async (req, res) => {
    const { delay } = req.body;
    const config = await getConfig();
    config.delay = parseInt(delay) || 0;
    await saveConfig(config);

    if (req.app.locals.updateDelay) {
        req.app.locals.updateDelay(config.delay);
    }
    res.json({ success: true, delay: config.delay });
});

router.delete('/symbol/:symbol', async (req, res) => {
    const { symbol } = req.params;
    const config = await getConfig();

    const initialLength = (config.symbols || []).length;

    config.symbols = (config.symbols || []).filter(s => {
        const sName = typeof s === 'string' ? s : s.name;

        return sName !== symbol && sName.split(':').pop() !== symbol;
    });

    if (config.symbols.length !== initialLength) {
        if (config.overrides) delete config.overrides[symbol];
        await saveConfig(config);

        if (req.app.locals.removeSymbolFromStream) {
            req.app.locals.removeSymbolFromStream(symbol);
        }
    }

    res.json({ success: true, symbols: config.symbols });
});

router.post('/symbols/bulk-delete', async (req, res) => {
    const { symbols } = req.body;
    if (!Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({ error: 'Silinecek semboller gerekli' });
    }

    const config = await getConfig();
    const initialLength = (config.symbols || []).length;

    config.symbols = (config.symbols || []).filter(s => {
        const sName = typeof s === 'string' ? s : s.name;
        const cleanName = sName.split(':').pop();
        return !symbols.includes(sName) && !symbols.includes(cleanName);
    });

    if (config.symbols.length !== initialLength) {
        symbols.forEach(symbol => {
            if (config.overrides) delete config.overrides[symbol];
        });
        await saveConfig(config);

        if (req.app.locals.removeSymbolFromStream) {
            symbols.forEach(symbol => req.app.locals.removeSymbolFromStream(symbol));
        }
    }

    res.json({ success: true, symbols: config.symbols });
});

router.post('/symbols/bulk-override', async (req, res) => {
    const { symbols, price, multiplier } = req.body;
    if (!Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({ error: 'Düzenlenecek semboller gerekli' });
    }

    const config = await getConfig();
    if (!config.overrides) config.overrides = {};

    symbols.forEach(symbol => {
        if (price === undefined && multiplier === undefined) {
            delete config.overrides[symbol];
        } else {
            let overrideObj = {
                type: price !== undefined ? 'fixed' : 'multiplier',
                value: price !== undefined ? parseFloat(price) : parseFloat(multiplier)
            };
            if (req.body.expiresIn) {
                overrideObj.expiresAt = new Date(Date.now() + parseInt(req.body.expiresIn) * 60000);
            }
            config.overrides[symbol] = overrideObj;
        }
    });

    await saveConfig(config);

    if (req.app.locals.updateOverrides) {
        req.app.locals.updateOverrides(config.overrides);
    }

    res.json({ success: true, overrides: config.overrides });
});

router.post('/symbol/category', async (req, res) => {
    const { symbol, category } = req.body;
    if (!symbol || !category) return res.status(400).json({ error: 'Eksik veri' });

    const config = await getConfig();
    let found = false;

    if (config.symbols) {
        config.symbols = config.symbols.map(s => {
            const sName = typeof s === 'string' ? s : s.name;
            if (sName === symbol || sName.split(':').pop() === symbol) {
                found = true;
                return { name: sName, category: category, isCustom: typeof s === 'string' ? true : s.isCustom };
            }
            return s;
        });
    }

    if (!found) {
        if (!config.symbols) config.symbols = [];
        config.symbols.push({ name: symbol, category: category, isCustom: false });
    }

    await saveConfig(config);

    if (req.app.locals.removeSymbolFromStream) {
        req.app.locals.removeSymbolFromStream(symbol);
    }
    if (req.app.locals.addSymbolToStream) {
        setTimeout(() => req.app.locals.addSymbolToStream(symbol, category), 500);
    }

    res.json({ success: true, symbols: config.symbols });
});

router.post('/symbol/pause', async (req, res) => {
    const { symbol, paused } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Sembol gerekli' });

    const config = await getConfig();
    let found = false;

    if (config.symbols) {
        config.symbols = config.symbols.map(s => {
            const sName = typeof s === 'string' ? s : s.name;
            if (sName === symbol || sName.split(':').pop() === symbol) {
                found = true;
                return {
                    name: sName,
                    category: s.category || 'DİĞER',
                    isCustom: typeof s === 'string' ? true : s.isCustom,
                    paused: paused
                };
            }
            return s;
        });
    }

    if (!found) {
        if (!config.symbols) config.symbols = [];
        config.symbols.push({ name: symbol, category: 'DİĞER', isCustom: false, paused: paused });
    }

    await saveConfig(config);

    if (req.app.locals.updatePaused) {
        req.app.locals.updatePaused(symbol, paused);
    }

    res.json({ success: true, paused: paused });
});

router.post('/categories', async (req, res) => {
    const { action, category } = req.body;
    if (!category) return res.status(400).json({ error: 'Kategori adı gerekli' });

    const config = await getConfig();
    if (!config.categories) {
        config.categories = ['BORSA ISTANBUL', 'KRIPTO', 'EMTIA', 'ENDEKSLER', 'EXCHANGE', 'STOCKS', 'DİĞER'];
    }

    if (action === 'add' && !config.categories.includes(category)) {
        config.categories.push(category);
    } else if (action === 'delete') {
        config.categories = config.categories.filter(c => c !== category);
    }

    await saveConfig(config);
    res.json({ success: true, categories: config.categories });
});

router.get('/ticker-cache', async (req, res) => {
    try {
        const cache = await listCache();
        res.json({ success: true, cache });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/ticker-cache/set', async (req, res) => {
    const { symbol, ticker } = req.body;
    if (!symbol || !ticker) return res.status(400).json({ error: 'symbol ve ticker gerekli' });
    try {
        await manuallySetTicker(symbol, ticker);

        if (req.app.locals.addSymbolToStream) {
            req.app.locals.addSymbolToStream(symbol);
        }
        res.json({ success: true, symbol, ticker });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/ticker-cache', async (req, res) => {
    const { symbol } = req.query;
    try {
        await clearCache(symbol || null);
        res.json({ success: true, cleared: symbol || 'all' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

export default router;
