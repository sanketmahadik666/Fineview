import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/fineview';

  try {
    await mongoose.connect(uri, {
      maxPoolSize: 20, // Keep multiple connections per worker to handle spikes
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[Database] Connected to MongoDB at ${uri}`);
  } catch (error) {
    console.error(`[Database] Failed to connect:`, error.message);
    process.exit(1);
  }
}
