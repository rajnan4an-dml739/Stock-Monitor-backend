import { Schema, model } from 'mongoose';

const watchlistSchema = new Schema({
  ticker: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, default: '' },
  exchange: { type: String, default: '' }
}, { timestamps: true });

export default model('Watchlist', watchlistSchema);
