import express from 'express';
import ConfigModel from '../models/Config.js';

const router = express.Router();

// Yardımcı Fonksiyonlar (MongoDB)
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
    // Mongoose belgesini düz objeye çevir
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

// 1. Mevcut Ayarları ve Aktif Sembolleri Getir
router.get('/config', async (req, res) => {
    const config = await getConfig();

    // Admin'in el ile eklediği semboller (Veritabanından)
    const customSymbolNames = new Set(
        config.symbols.map(s => (typeof s === 'string' ? s : s.name))
    );

    // Özel sembolleri obje formatında hazırla (silinebilir)
    const customSymbols = config.symbols.map(s => {
        if (typeof s === 'string') {
            return { name: s.split(':').pop(), category: 'DİĞER', isCustom: true };
        }
        return { name: s.name, category: s.category || 'DİĞER', isCustom: true };
    });

    // Server'daki tüm aktif sembolleri al (symbols.js'den gelenler)
    let systemSymbols = [];
    if (req.app.locals.getSymbolsData) {
        const symbolsData = req.app.locals.getSymbolsData();
        Object.entries(symbolsData).forEach(([category, syms]) => {
            syms.forEach(name => {
                const cleanName = name.replace(/\s*\/\/.*/, '').trim(); // yorum satırlarını temizle
                if (!customSymbolNames.has(cleanName)) {
                    systemSymbols.push({ name: cleanName, category, isCustom: false });
                }
            });
        });
    }

    // Hepsini birleştir: önce sistem, sonra özel
    const allSymbols = [...systemSymbols, ...customSymbols];

    res.json({
        ...config,
        symbols: allSymbols
    });
});

// 2. Yeni Sembol Ekle
router.post('/symbol', async (req, res) => {
    const { symbol, category } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Sembol gerekli' });

    const config = await getConfig();

    // Var mı kontrol et
    const exists = (config.symbols || []).some(s => {
        const sName = typeof s === 'string' ? s : s.name;
        return sName === symbol;
    });

    if (!exists) {
        if (!config.symbols) config.symbols = [];
        config.symbols.push({ name: symbol, category: category || 'DİĞER', isCustom: true });
        await saveConfig(config);

        // Server'a sinyal gönder
        if (req.app.locals.addSymbolToStream) {
            req.app.locals.addSymbolToStream(symbol, category);
        }
    }
    res.json({ success: true, symbols: config.symbols });
});

// 3. Fiyat/Çarpan Override Et
router.post('/override', async (req, res) => {
    const { symbol, price, multiplier } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Sembol gerekli' });

    const config = await getConfig();

    // Eğer price veya multiplier yoksa, override'ı kaldır (Reset)
    if (price === undefined && multiplier === undefined) {
        if (config.overrides) delete config.overrides[symbol];
    } else {
        if (!config.overrides) config.overrides = {};
        config.overrides[symbol] = {
            type: price !== undefined ? 'fixed' : 'multiplier',
            value: price !== undefined ? parseFloat(price) : parseFloat(multiplier)
        };
    }

    await saveConfig(config);
    // Server'a sinyal gönder: Anlık override değişti
    if (req.app.locals.updateOverrides) {
        req.app.locals.updateOverrides(config.overrides);
    }
    res.json({ success: true, overrides: config.overrides });
});

// 4. Gecikme (Delay) Ayarla
router.post('/delay', async (req, res) => {
    const { delay } = req.body;
    const config = await getConfig();
    config.delay = parseInt(delay) || 0;
    await saveConfig(config);

    // Server'a sinyal gönder
    if (req.app.locals.updateDelay) {
        req.app.locals.updateDelay(config.delay);
    }
    res.json({ success: true, delay: config.delay });
});

// 5. Sembol Sil
router.delete('/symbol/:symbol', async (req, res) => {
    const { symbol } = req.params;
    const config = await getConfig();

    const initialLength = (config.symbols || []).length;
    // Nesne yapısına göre filtrele
    config.symbols = (config.symbols || []).filter(s => {
        const sName = typeof s === 'string' ? s : s.name;
        // Hem tam adı hem de temizlenmiş halini kontrol et
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

// 6. Toplu Sembol Sil
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

// 7. Toplu Override (Fiyat/Çarpan) Ekle
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
            config.overrides[symbol] = {
                type: price !== undefined ? 'fixed' : 'multiplier',
                value: price !== undefined ? parseFloat(price) : parseFloat(multiplier)
            };
        }
    });

    await saveConfig(config);

    if (req.app.locals.updateOverrides) {
        req.app.locals.updateOverrides(config.overrides);
    }

    res.json({ success: true, overrides: config.overrides });
});

export default router;
