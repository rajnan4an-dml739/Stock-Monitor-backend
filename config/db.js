import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let memoryServer;

const connectDB = async () => {
  const candidates = [
    process.env.MONGODB_URI,
    'mongodb://127.0.0.1:27017/stockmonitor'
  ].filter(Boolean);

  for (const uri of candidates) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        family: 4
      });
      const label = uri.includes('127.0.0.1') ? 'local' : 'remote';
      console.log(`MongoDB Connected (${label})`);
      return;
    } catch (error) {
      console.warn(`MongoDB connection failed: ${error.message}`);
      await mongoose.disconnect().catch(() => {});
    }
  }

  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri());
  console.log('MongoDB Connected (in-memory fallback)');
};

export default connectDB;
