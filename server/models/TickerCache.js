import mongoose from 'mongoose';

const tickerCacheSchema = new mongoose.Schema({

    symbol: { type: String, required: true, unique: true, uppercase: true },

    ticker: { type: String, required: true },

    exchange: { type: String },
    description: { type: String },
    type: { type: String },
    currency: { type: String },

    resolvedAt: { type: Date, default: Date.now },

    isManual: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.model('TickerCache', tickerCacheSchema);
