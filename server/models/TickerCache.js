import mongoose from 'mongoose';

// TradingView'den otomatik bulunan ticker'ların cache modeli
const tickerCacheSchema = new mongoose.Schema({
    // Kullanıcının girdiği sembol adı (örn: "NATGAS", "RACE", "BTC")
    symbol: { type: String, required: true, unique: true, uppercase: true },

    // TradingView'den bulunan tam ticker (örn: "NYMEX:NG1!", "NYSE:RACE")
    ticker: { type: String, required: true },

    // TradingView'den gelen ek bilgiler
    exchange: { type: String },
    description: { type: String },
    type: { type: String }, // 'stock', 'futures', 'crypto', 'forex', 'index' etc.
    currency: { type: String },

    // Cache metadata
    resolvedAt: { type: Date, default: Date.now },

    // Manuel override - admin elle set ettiyse bunu kullan, otomatik güncelleme
    isManual: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.model('TickerCache', tickerCacheSchema);
