import mongoose from 'mongoose';

const configSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, default: 'global' },
    symbols: [{
        name: String,
        category: String,
        isCustom: { type: Boolean, default: true }
    }],
    overrides: {
        type: Map, of: new mongoose.Schema({
            type: String,
            value: Number
        }, { _id: false })
    },
    delay: { type: Number, default: 0 }
});

export default mongoose.model('Config', configSchema);
