/**
 * Database Initialization Script
 * Prepares user storage and ensures Mongo-backed persistence is ready
 */

import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { userService, setMongoDBAvailable, initializeMemoryStorage } from './userService.js';
import logger from '../utils/logger.js';

/**
 * Create default admin user using hybrid service
 */
export const createDefaultAdmin = async () => {
  try {
    // Check if admin user already exists
    const existingAdmin = await userService.findByEmail('admin@livementor.com');
    
    if (existingAdmin) {
      logger.info('Default admin user already exists');
      return;
    }

    logger.info('Creating default admin user...');

    // Hash the password
    const hashedPassword = await bcrypt.hash('admin123', 10);

    // Create admin user using hybrid service
    await userService.createUser({
      email: 'admin@livementor.com',
      password: hashedPassword,
      full_name: 'Admin User',
      role: 'admin',
      isActive: true
    });

    logger.info('✅ Default admin user created successfully');
    logger.info('   Email: admin@livementor.com');
    logger.info('   Password: admin123');
  } catch (error) {
    logger.error('Failed to create default admin user:', error.message);
  }
};

/**
 * Initialize database with default data and ensure indexes
 */
export const initializeDatabase = async () => {
  try {
    logger.info('Initializing database...');
    
    // Check if MongoDB is connected
    if (mongoose.connection.readyState === 1) {
      logger.info('MongoDB is connected - using persistent storage');
      setMongoDBAvailable(true);
    } else {
      logger.info('MongoDB not available - using in-memory storage');
      setMongoDBAvailable(false);
      initializeMemoryStorage();
    }
    
    logger.info('✅ Database initialization completed');
    
  } catch (error) {
    logger.error('Database initialization failed:', error.message);
    throw error;
  }
};

export default {
  createDefaultAdmin,
  initializeDatabase
};