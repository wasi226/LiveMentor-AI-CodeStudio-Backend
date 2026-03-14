/**
 * Base44 Service
 * Manages Base44 client instance and provides centralized access
 */

import { createClient } from '@base44/sdk';
import logger from '../utils/logger.js';

let base44Client = null;

/**
 * Initialize Base44 client
 */
export const initializeBase44 = () => {
  try {
    if (!process.env.BASE44_PROJECT_ID || !process.env.BASE44_API_KEY) {
      logger.warn('Base44 credentials not provided, using mock client');
      // Return a mock client for development
      return createMockClient();
    }

    base44Client = createClient({
      projectId: process.env.BASE44_PROJECT_ID,
      apiKey: process.env.BASE44_API_KEY,
      region: process.env.BASE44_REGION || 'us-east-1',
      environment: process.env.BASE44_ENVIRONMENT || 'development'
    });

    logger.info('Base44 client initialized successfully');
    return base44Client;
    
  } catch (error) {
    logger.error('Failed to initialize Base44 client:', error);
    // Return mock client as fallback
    return createMockClient();
  }
};

/**
 * Get Base44 client instance
 */
export const getBase44Client = () => {
  if (!base44Client) {
    base44Client = initializeBase44();
  }
  return base44Client;
};

/**
 * Create a mock Base44 client for development/testing
 */
const createMockClient = () => {
  logger.info('Using mock Base44 client for development');
  
  return {
    auth: {
      login: async (credentials) => ({ token: 'mock-token', user: { id: '1', email: credentials.email } }),
      logout: async () => ({ success: true }),
      me: async () => ({ id: '1', email: 'test@example.com', full_name: 'Test User', role: 'student' }),
      refresh: async () => ({ token: 'refreshed-mock-token' }),
      isAuthenticated: async () => true,
      status: async () => ({ authenticated: true })
    },
    database: {
      entity: {
        create: async (entityName, data) => ({ id: Date.now().toString(), ...data }),
        find: async (entityName, query = {}) => [],
        findById: async (entityName, id) => null,
        findOne: async (entityName, query) => null,
        update: async (entityName, id, data) => ({ id, ...data }),
        delete: async (entityName, id) => ({ success: true }),
        exists: async (entityName) => false
      }
    },
    entities: {
      Classroom: {
        list: async () => [],
        create: async (data) => ({ id: Date.now().toString(), ...data }),
        findById: async (id) => null,
        update: async (id, data) => ({ id, ...data }),
        delete: async (id) => ({ success: true })
      },
      Assignment: {
        list: async () => [],
        create: async (data) => ({ id: Date.now().toString(), ...data }),
        findById: async (id) => null,
        update: async (id, data) => ({ id, ...data }),
        delete: async (id) => ({ success: true })
      },
      Submission: {
        list: async () => [],
        create: async (data) => ({ id: Date.now().toString(), ...data }),
        findById: async (id) => null,
        update: async (id, data) => ({ id, ...data }),
        delete: async (id) => ({ success: true })
      },
      ChatMessage: {
        list: async () => [],
        create: async (data) => ({ id: Date.now().toString(), ...data }),
        findById: async (id) => null,
        update: async (id, data) => ({ id, ...data }),
        delete: async (id) => ({ success: true })
      }
    }
  };
};

// Initialize on module load
export const base44 = initializeBase44();

export default {
  initializeBase44,
  getBase44Client,
  base44
};