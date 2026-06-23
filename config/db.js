import mongoose from 'mongoose';
// import { MongoMemoryServer } from 'mongodb-memory-server';

// let memoryServer;

const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not defined");
    }

    console.log("Connecting to MongoDB Atlas...");

    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      family: 4,
    });

    console.log("MongoDB Connected Successfully");
  } catch (error) {
    console.error("MongoDB Connection Failed:");
    console.error(error.message);

    process.exit(1);
  }

//   memoryServer = await MongoMemoryServer.create();
// //   await mongoose.connect(memoryServer.getUri());
// //   console.log('MongoDB Connected (in-memory fallback)');
};

export default connectDB;