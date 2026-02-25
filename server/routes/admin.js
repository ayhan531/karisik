import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configFile = path.join(__dirname, '../data/config.json');

// Yardımcı Fonksiyonlar
const getConfig = () => {
    try {
        if (!fs.existsSync(configFile)) {
            fs.writeFileSync(configFile, JSON.stringify({ symbols: [], overrides: {}, delay: 0 }));
        }
        return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
        return { symbols: [], overrides: {}, delay: 0 };
    }
};

const saveConfig = (config) => {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
};

// 1. Mevcut Ayarları ve Aktif Sembolleri Getir
router.get('/config', (req, res) => {
    const config = getConfig();

    // Server'dan aktif sembol listesini al (memory'deki)
    let allSymbols = [];
    if (req.app.locals.getActiveSymbols) {
        allSymbols = req.app.locals.getActiveSymbols();
    }

    // Config'deki özel sembolleri mapleyelim (Array of objects formatında dönelim)
    // s string ise (eski versiyon), name olarak ata. Obj ise zaten name/category vardır.
    const customSymbols = config.symbols.map(s => {
        if (typeof s === 'string') return { name: s.split(':').pop(), category: 'DİĞER', original: s };
        return { name: s.name, category: s.category || 'DİĞER', original: s.name };
    });

    res.json({
        ...config,
        symbols: customSymbols,
        allActiveSymbols: allSymbols // Sadece debug için
    });
});

// 2. Yeni Sembol Ekle
router.post('/symbol', (req, res) => {
    const { symbol, category } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Sembol gerekli' });

    const config = getConfig();

    // Var mı kontrol et
    const exists = config.symbols.some(s => {
        const sName = typeof s === 'string' ? s : s.name;
        return sName === symbol;
    });

    if (!exists) {
        config.symbols.push({ name: symbol, category: category || 'DİĞER' });
        saveConfig(config);

        // Server'a sinyal gönder
        if (req.app.locals.addSymbolToStream) {
            req.app.locals.addSymbolToStream(symbol, category);
        }
    }
    res.json({ success: true, symbols: config.symbols });
});

// 3. Fiyat/Çarpan Override Et
router.post('/override', (req, res) => {
    const { symbol, price, multiplier } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Sembol gerekli' });

    const config = getConfig();

    // Eğer price veya multiplier yoksa, override'ı kaldır (Reset)
    if (price === undefined && multiplier === undefined) {
        delete config.overrides[symbol];
    } else {
        config.overrides[symbol] = {
            type: price !== undefined ? 'fixed' : 'multiplier',
            value: price !== undefined ? parseFloat(price) : parseFloat(multiplier)
        };
    }

    saveConfig(config);
    // Server'a sinyal gönder: Anlık override değişti
    if (req.app.locals.updateOverrides) {
        req.app.locals.updateOverrides(config.overrides);
    }
    res.json({ success: true, overrides: config.overrides });
});

// 4. Gecikme (Delay) Ayarla
router.post('/delay', (req, res) => {
    const { delay } = req.body;
    const config = getConfig();
    config.delay = parseInt(delay) || 0;
    saveConfig(config);

    // Server'a sinyal gönder
    if (req.app.locals.updateDelay) {
        req.app.locals.updateDelay(config.delay);
    }
    res.json({ success: true, delay: config.delay });
});

// 5. Sembol Sil
router.delete('/symbol/:symbol', (req, res) => {
    const { symbol } = req.params;
    const config = getConfig();

    const initialLength = config.symbols.length;
    // Nesne yapısına göre filtrele
    config.symbols = config.symbols.filter(s => {
        const sName = typeof s === 'string' ? s : s.name;
        // Hem tam adı hem de temizlenmiş halini kontrol et
        return sName !== symbol && sName.split(':').pop() !== symbol;
    });

    if (config.symbols.length !== initialLength) {
        delete config.overrides[symbol];
        saveConfig(config);

        if (req.app.locals.removeSymbolFromStream) {
            req.app.locals.removeSymbolFromStream(symbol);
        }
    }

    res.json({ success: true, symbols: config.symbols });
});

export default router;
