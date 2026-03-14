/**
 * MongoDB Configuration and Connection
 */

import mongoose from 'mongoose';
import logger from '../utils/logger.js';

// MongoDB Configuration
const MONGODB_CONFIG = {
  uri: process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/livementor_db',
  options: {
    // Modern MongoDB driver options
    maxPoolSize: 10, // Maintain up to 10 socket connections
    serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
    socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
    bufferCommands: false, // Disable mongoose buffering
  }
};

/**
 * Initialize MongoDB connection
 */
export const connectMongoDB = async () => {
  try {
    logger.info('Connecting to MongoDB...');
    logger.info(`MongoDB URI: ${MONGODB_CONFIG.uri}`);
    
    // Connect to MongoDB
    await mongoose.connect(MONGODB_CONFIG.uri, MONGODB_CONFIG.options);
    
    logger.info('✅ MongoDB connected successfully');
    
    // Connection event listeners
    mongoose.connection.on('error', (error) => {
      logger.error('MongoDB connection error:', error);
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
    
    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
    });
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed due to application termination');
      process.exit(0);
    });
    
    return mongoose.connection;
    
  } catch (error) {
    logger.error(`Failed to connect to MongoDB: ${error.message}`);
    
    if (error.message.includes('ECONNREFUSED')) {
      logger.error('\n⚠️  MongoDB is not running! ⚠️');
      logger.error('To install and start MongoDB:');
      logger.error('1. Download MongoDB Community Server from: https://www.mongodb.com/try/download/community');
      logger.error('2. Install MongoDB');
      logger.error('3. Start MongoDB service');
      logger.error('   - Windows: net start MongoDB');
      logger.error('   - macOS: brew services start mongodb-community');
      logger.error('   - Linux: sudo systemctl start mongod');
    }
    
    // Throw error to let caller decide what to do
    throw error;
  }
};

/**
 * Get MongoDB connection status
 */
export const getConnectionStatus = () => {
  const state = mongoose.connection.readyState;
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  
  return {
    state: states[state] || 'unknown',
    host: mongoose.connection.host,
    port: mongoose.connection.port,
    name: mongoose.connection.name
  };
};

/**
 * Close MongoDB connection
 */
export const closeMongoDB = async () => {
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (error) {
    logger.error('Error closing MongoDB connection:', error);
  }
};

export default {
  connectMongoDB,
  getConnectionStatus,
  closeMongoDB,
  mongoose
};