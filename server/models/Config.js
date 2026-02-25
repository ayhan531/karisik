import mongoose from 'mongoose';

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, default: 'global' },
    symbols: [{
        name: String,
        category: String,
        isCustom: { type: Boolean, default: true },
        paused: { type: Boolean, default: false }
    }],
    categories: {
        type: [String],
        default: ['BORSA ISTANBUL', 'KRIPTO', 'EMTIA', 'ENDEKSLER', 'EXCHANGE', 'STOCKS', 'DİĞER']
    },
    overrides: {
        type: Map, of: new mongoose.Schema({
            type: String,
            value: Number,
            expiresAt: { type: Date }
        }, { _id: false })
    },
    delay: { type: Number, default: 0 }
});

export default mongoose.model('Config', configSchema);
