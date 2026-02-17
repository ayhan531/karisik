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
    if (req.app.locals.getActiveSymbols) {
        const activeSymbols = req.app.locals.getActiveSymbols();
        // Config'deki sembollerle birleştir (Eşsiz liste)
        const allSymbols = [...new Set([...config.symbols, ...activeSymbols])];

        // Response yapısını güncelle: symbols artık tümünü içerir
        return res.json({
            ...config,
            symbols: allSymbols
        });
    }
    res.json(config);
});

// 2. Yeni Sembol Ekle
router.post('/symbol', (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Sembol gerekli' });

    const config = getConfig();
    if (!config.symbols.includes(symbol)) {
        config.symbols.push(symbol);
        saveConfig(config);
        // Server'a sinyal gönder: Yeni sembol eklendi, TradingView'den çekmeye başla
        if (req.app.locals.addSymbolToStream) {
            req.app.locals.addSymbolToStream(symbol);
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

export default router;
