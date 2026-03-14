/**
 * Hybrid User Service
 * Uses MongoDB when available, falls back to in-memory storage
 */

import { User } from '../models/index.js';
import mongoose from 'mongoose';
import logger from '../utils/logger.js';

// In-memory fallback storage
let memoryUsers = new Map();
let isMongoDBAvailable = false;

// Check if MongoDB is connected
export const isMongoDBConnected = () => {
  return mongoose.connection.readyState === 1 && isMongoDBAvailable;
};

export const setMongoDBAvailable = (available) => {
  isMongoDBAvailable = available;
};

// Initialize with default admin user for memory fallback
export const initializeMemoryStorage = () => {
  if (!isMongoDBConnected()) {
    logger.info('Initializing in-memory user storage...');
    // Add default admin user for testing
    memoryUsers.set('admin@livementor.com', {
      id: 'admin-001',
      email: 'admin@livementor.com',
      password: '$2b$10$rQqW9J8TjOEjq1YKl.IIi.TBSqHVE4d9TI0tGLCHE0eJ5E5GK7Ly2', // "admin123"
      full_name: 'Admin User',
      role: 'admin',
      createdAt: new Date()
    });
    logger.info('✅ Default admin user created in memory');
    logger.info('   Email: admin@livementor.com');
    logger.info('   Password: admin123');
  }
};

// User service methods that work with both MongoDB and memory
export const userService = {
  async findByEmail(email) {
    try {
      if (isMongoDBConnected()) {
        return await User.findOne({ email: email.toLowerCase() });
      } else {
        const user = memoryUsers.get(email.toLowerCase());
        return user || null;
      }
    } catch (error) {
      logger.error('FindByEmail error:', error);
      return null;
    }
  },

  async createUser(userData) {
    try {
      if (isMongoDBConnected()) {
        const user = new User({
          ...userData,
          email: userData.email.toLowerCase()
        });
        return await user.save();
      } else {
        // In-memory storage
        const user = {
          _id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          ...userData,
          email: userData.email.toLowerCase(),
          createdAt: new Date(),
          updatedAt: new Date()
        };
        
        // Check for duplicate email
        if (memoryUsers.has(user.email)) {
          const error = new Error('User already exists');
          error.code = 11000;
          error.keyPattern = { email: 1 };
          throw error;
        }
        
        memoryUsers.set(user.email, user);
        return user;
      }
    } catch (error) {
      logger.error('CreateUser error:', error);
      throw error;
    }
  },

  async updateUser(email, updateData) {
    try {
      if (isMongoDBConnected()) {
        return await User.findOneAndUpdate(
          { email: email.toLowerCase() },
          updateData,
          { new: true }
        );
      } else {
        const user = memoryUsers.get(email.toLowerCase());
        if (user) {
          Object.assign(user, updateData, { updatedAt: new Date() });
          memoryUsers.set(email.toLowerCase(), user);
          return user;
        }
        return null;
      }
    } catch (error) {
      logger.error('UpdateUser error:', error);
      return null;
    }
  },

  async getAllUsers(excludePassword = true) {
    try {
      if (isMongoDBConnected()) {
        const query = excludePassword ? { password: 0 } : {};
        return await User.find({}, query).limit(20);
      } else {
        const users = Array.from(memoryUsers.values()).slice(0, 20);
        if (excludePassword) {
          return users.map(user => {
            const { password, ...userWithoutPassword } = user;
            return userWithoutPassword;
          });
        }
        return users;
      }
    } catch (error) {
      logger.error('GetAllUsers error:', error);
      return [];
    }
  },

  async countUsers() {
    try {
      if (isMongoDBConnected()) {
        return await User.countDocuments();
      } else {
        return memoryUsers.size;
      }
    } catch (error) {
      logger.error('CountUsers error:', error);
      return 0;
    }
  }
};

export default {
  userService,
  isMongoDBConnected,
  setMongoDBAvailable,
  initializeMemoryStorage
};