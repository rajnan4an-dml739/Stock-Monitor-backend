import { Schema, model } from 'mongoose';

const stockSchema = new Schema({
  ticker: { type: String, required: true },
  name: { type: String, default: '' },
  price: { type: Number, required: true },
  high: { type: Number },
  low: { type: Number },
  faceValue: { type: Number },
  marketCap: { type: Number },
  currency: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now }
});

stockSchema.index({ ticker: 1, timestamp: -1 });

export default model('Stock', stockSchema);
