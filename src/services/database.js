/**
 * Database Service
 * Handles database initialization and connection using Base44
 */

import { base44 } from './base44.js';
import logger from '../utils/logger.js';

/**
 * Initialize database connection and entities
 */
export const initializeDatabase = async () => {
  try {
    logger.info('Initializing database connection...');
    
    // Test Base44 connection
    const isAuthenticated = await base44.auth.isAuthenticated();
    
    if (!isAuthenticated) {
      logger.warn('Base44 not authenticated, initializing...');
      // Base44 will handle authentication automatically
    }

    // Define entities if they don't exist
    await initializeEntities();
    
    logger.info('Database initialized successfully');
    
  } catch (error) {
    logger.error('Database initialization failed:', error);
    throw new Error(`Database initialization failed: ${error.message}`);
  }
};

/**
 * Initialize Base44 entities for the application
 */
const initializeEntities = async () => {
  try {
    const entities = [
      // Classroom entity
      {
        name: 'Classroom',
        schema: {
          name: 'string',
          code: 'string',
          description: 'string',
          language: 'string',
          faculty_email: 'string',
          student_emails: 'array',
          max_students: 'number',
          is_private: 'boolean',
          created_at: 'datetime',
          updated_at: 'datetime'
        }
      },
      
      // Assignment entity
      {
        name: 'Assignment',
        schema: {
          title: 'string',
          description: 'text',
          classroom_id: 'string',
          starter_code: 'text',
          solution_code: 'text',
          test_cases: 'json',
          difficulty: 'string',
          max_score: 'number',
          time_limit: 'number',
          memory_limit: 'number',
          due_date: 'datetime',
          auto_grade: 'boolean',
          created_at: 'datetime',
          updated_at: 'datetime'
        }
      },
      
      // Submission entity  
      {
        name: 'Submission',
        schema: {
          assignment_id: 'string',
          classroom_id: 'string',
          student_email: 'string',
          code: 'text',
          language: 'string',
          status: 'string',
          score: 'number',
          execution_time: 'number',
          memory_used: 'number',
          test_results: 'json',
          error_message: 'text',
          submitted_at: 'datetime',
          graded_at: 'datetime'
        }
      },
      
      // ChatMessage entity
      {
        name: 'ChatMessage',
        schema: {
          classroom_id: 'string',
          sender_email: 'string',
          sender_name: 'string',
          message: 'text',
          type: 'string',
          metadata: 'json',
          created_at: 'datetime'
        }
      }
    ];

    for (const entity of entities) {
      try {
        // Check if entity exists, create if not
        const exists = await base44.database.entity.exists(entity.name);
        if (!exists) {
          await base44.database.entity.create(entity.name, entity.schema);
          logger.info(`Created entity: ${entity.name}`);
        } else {
          logger.info(`Entity exists: ${entity.name}`);
        }
      } catch (error) {
        logger.warn(`Entity ${entity.name} initialization warning:`, error.message);
        // Continue with other entities even if one fails
      }
    }

  } catch (error) {
    logger.error('Entity initialization failed:', error);
    throw error;
  }
};

/**
 * Get database connection status
 */
export const getDatabaseStatus = async () => {
  try {
    const isAuthenticated = await base44.auth.isAuthenticated();
    return {
      connected: isAuthenticated,
      timestamp: new Date().toISOString(),
      service: 'base44'
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message,
      timestamp: new Date().toISOString(),
      service: 'base44'
    };
  }
};

/**
 * Create a new record in specified entity
 */
export const createRecord = async (entityName, data) => {
  try {
    const record = await base44.database.entity.create(entityName, {
      ...data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    return record;
  } catch (error) {
    logger.error(`Failed to create ${entityName} record:`, error);
    throw error;
  }
};

/**
 * Find records in specified entity
 */
export const findRecords = async (entityName, query = {}, options = {}) => {
  try {
    const records = await base44.database.entity.find(entityName, query, options);
    return records;
  } catch (error) {
    logger.error(`Failed to find ${entityName} records:`, error);
    throw error;
  }
};

/**
 * Update a record in specified entity
 */
export const updateRecord = async (entityName, id, data) => {
  try {
    const updatedRecord = await base44.database.entity.update(entityName, id, {
      ...data,
      updated_at: new Date().toISOString()
    });
    return updatedRecord;
  } catch (error) {
    logger.error(`Failed to update ${entityName} record:`, error);
    throw error;
  }
};

/**
 * Delete a record from specified entity
 */
export const deleteRecord = async (entityName, id) => {
  try {
    const result = await base44.database.entity.delete(entityName, id);
    return result;
  } catch (error) {
    logger.error(`Failed to delete ${entityName} record:`, error);
    throw error;
  }
};

/**
 * Database utilities
 */
export const dbUtils = {
  createRecord,
  findRecords,
  updateRecord,
  deleteRecord,
  getDatabaseStatus
};

export default {
  initializeDatabase,
  getDatabaseStatus,
  createRecord,
  findRecords,
  updateRecord,
  deleteRecord
};