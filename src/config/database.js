/**
 * Database Configuration for Base44 BaaS
 * Entity definitions and database setup
 */

import { base44 } from '../services/base44.js';
import logger from '../utils/logger.js';

// Entity Schemas for Base44
export const ENTITY_SCHEMAS = {
  // Classroom Entity
  Classroom: {
    name: 'Classroom',
    fields: {
      id: { type: 'string', primary: true },
      name: { type: 'string', required: true, indexed: true },
      code: { type: 'string', required: true, unique: true, indexed: true },
      language: { type: 'string', required: true, default: 'javascript' },
      faculty_email: { type: 'string', required: true, indexed: true },
      student_emails: { type: 'array', default: [] },
      settings: { type: 'json', default: {} },
      is_active: { type: 'boolean', default: true },
      created_date: { type: 'datetime', auto: true },
      updated_date: { type: 'datetime', auto: true },
      metadata: { type: 'json', default: {} }
    },
    indexes: [
      { fields: ['faculty_email'], type: 'btree' },
      { fields: ['code'], type: 'unique' },
      { fields: ['created_date'], type: 'btree' },
      { fields: ['is_active', 'faculty_email'], type: 'composite' }
    ]
  },

  // Assignment Entity  
  Assignment: {
    name: 'Assignment',
    fields: {
      id: { type: 'string', primary: true },
      title: { type: 'string', required: true, indexed: true },
      description: { type: 'text', required: true },
      classroom_id: { type: 'string', required: true, indexed: true },
      language: { type: 'string', required: true },
      difficulty: { type: 'enum', values: ['easy', 'medium', 'hard'], default: 'medium' },
      starter_code: { type: 'text', default: '' },
      solution_code: { type: 'text', default: '' },
      test_cases: { type: 'json', default: [] },
      max_score: { type: 'number', default: 100 },
      time_limit: { type: 'number', default: 300 }, // seconds
      memory_limit: { type: 'number', default: 128 }, // MB
      due_date: { type: 'datetime' },
      is_published: { type: 'boolean', default: false },
      allow_multiple_submissions: { type: 'boolean', default: true },
      auto_grade: { type: 'boolean', default: false },
      created_date: { type: 'datetime', auto: true },
      updated_date: { type: 'datetime', auto: true },
      metadata: { type: 'json', default: {} }
    },
    indexes: [
      { fields: ['classroom_id'], type: 'btree' },
      { fields: ['created_date'], type: 'btree' },
      { fields: ['due_date'], type: 'btree' },
      { fields: ['is_published', 'classroom_id'], type: 'composite' }
    ]
  },

  // Submission Entity
  Submission: {
    name: 'Submission',
    fields: {
      id: { type: 'string', primary: true },
      assignment_id: { type: 'string', required: true, indexed: true },
      classroom_id: { type: 'string', required: true, indexed: true },
      student_email: { type: 'string', required: true, indexed: true },
      code: { type: 'text', required: true },
      language: { type: 'string', required: true },
      score: { type: 'number', default: 0 },
      max_score: { type: 'number', default: 100 },
      status: { type: 'enum', values: ['draft', 'submitted', 'graded', 'returned'], default: 'draft' },
      error_count: { type: 'number', default: 0 },
      execution_time: { type: 'number' }, // milliseconds
      memory_usage: { type: 'number' }, // bytes
      test_results: { type: 'json', default: [] },
      feedback: { type: 'text', default: '' },
      grade_breakdown: { type: 'json', default: {} },
      attempts_count: { type: 'number', default: 1 },
      is_final: { type: 'boolean', default: false },
      submitted_date: { type: 'datetime' },
      graded_date: { type: 'datetime' },
      created_date: { type: 'datetime', auto: true },
      updated_date: { type: 'datetime', auto: true },
      metadata: { type: 'json', default: {} }
    },
    indexes: [
      { fields: ['assignment_id'], type: 'btree' },
      { fields: ['classroom_id'], type: 'btree' },
      { fields: ['student_email'], type: 'btree' },
      { fields: ['status'], type: 'btree' },
      { fields: ['submitted_date'], type: 'btree' },
      { fields: ['student_email', 'assignment_id'], type: 'composite' },
      { fields: ['classroom_id', 'status'], type: 'composite' }
    ]
  },

  // ChatMessage Entity (also used for version control and collaboration)
  ChatMessage: {
    name: 'ChatMessage',
    fields: {
      id: { type: 'string', primary: true },
      classroom_id: { type: 'string', required: true, indexed: true },
      sender_email: { type: 'string', required: true, indexed: true },
      sender_name: { type: 'string', required: true },
      message: { type: 'text', required: true },
      type: { 
        type: 'enum', 
        values: ['text', 'code', 'system', 'ai_request', 'ai_response', 'code_version', 'heartbeat', 'system_join', 'system_leave', 'code_sync', 'cursor_move', 'user_typing', 'language_change', 'execution_start', 'execution_result'], 
        default: 'text' 
      },
      reply_to: { type: 'string' }, // ID of message being replied to
      attachments: { type: 'json', default: [] },
      reactions: { type: 'json', default: {} },
      is_edited: { type: 'boolean', default: false },
      is_deleted: { type: 'boolean', default: false },
      priority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
      created_date: { type: 'datetime', auto: true },
      edited_date: { type: 'datetime' },
      metadata: { type: 'json', default: {} } // For version control data, collaboration info
    },
    indexes: [
      { fields: ['classroom_id'], type: 'btree' },
      { fields: ['sender_email'], type: 'btree' },
      { fields: ['type'], type: 'btree' },
      { fields: ['created_date'], type: 'btree' },
      { fields: ['classroom_id', 'type'], type: 'composite' },
      { fields: ['classroom_id', 'created_date'], type: 'composite' },
      { fields: ['sender_email', 'type'], type: 'composite' }
    ]
  },

  // User Profile Entity (extended user information)
  UserProfile: {
    name: 'UserProfile',
    fields: {
      id: { type: 'string', primary: true },
      email: { type: 'string', required: true, unique: true, indexed: true },
      full_name: { type: 'string', required: true },
      avatar_url: { type: 'string' },
      role: { type: 'enum', values: ['student', 'faculty', 'admin'], default: 'student' },
      institution: { type: 'string' },
      department: { type: 'string' },
      bio: { type: 'text' },
      skills: { type: 'json', default: [] },
      preferences: { type: 'json', default: {} },
      statistics: { type: 'json', default: {} },
      is_active: { type: 'boolean', default: true },
      last_login: { type: 'datetime' },
      created_date: { type: 'datetime', auto: true },
      updated_date: { type: 'datetime', auto: true },
      metadata: { type: 'json', default: {} }
    },
    indexes: [
      { fields: ['email'], type: 'unique' },
      { fields: ['role'], type: 'btree' },
      { fields: ['institution'], type: 'btree' },
      { fields: ['is_active'], type: 'btree' },
      { fields: ['last_login'], type: 'btree' }
    ]
  },

  // Performance Analytics Entity
  PerformanceAnalytics: {
    name: 'PerformanceAnalytics',
    fields: {
      id: { type: 'string', primary: true },
      student_email: { type: 'string', required: true, indexed: true },
      classroom_id: { type: 'string', indexed: true },
      assignment_id: { type: 'string', indexed: true },
      metric_type: { type: 'enum', values: ['daily', 'weekly', 'assignment', 'concept'], required: true },
      metric_data: { type: 'json', required: true },
      score: { type: 'number' },
      category: { type: 'enum', values: ['weak', 'average', 'strong'] },
      improvement_trend: { type: 'number' }, // -100 to +100
      concept_scores: { type: 'json', default: {} },
      warnings: { type: 'json', default: [] },
      recommendations: { type: 'json', default: [] },
      calculation_date: { type: 'datetime', auto: true },
      period_start: { type: 'datetime' },
      period_end: { type: 'datetime' },
      metadata: { type: 'json', default: {} }
    },
    indexes: [
      { fields: ['student_email'], type: 'btree' },
      { fields: ['classroom_id'], type: 'btree' },
      { fields: ['metric_type'], type: 'btree' },
      { fields: ['calculation_date'], type: 'btree' },
      { fields: ['student_email', 'classroom_id'], type: 'composite' },
      { fields: ['classroom_id', 'metric_type'], type: 'composite' }
    ]
  }
};

/**
 * Initialize database schemas and create entities
 */
export async function initializeDatabase() {
  try {
    logger.info('Initializing database schemas...');
    
    // Create or update entities in Base44
    for (const [entityName, schema] of Object.entries(ENTITY_SCHEMAS)) {
      try {
        // Check if entity exists
        const existingEntity = await base44.entities[entityName]?.list?.({ limit: 1 });
        
        if (existingEntity) {
          logger.info(`Entity ${entityName} already exists`);
        } else {
          logger.info(`Creating entity ${entityName}...`);
          // Note: Base44 entity creation is typically done through the dashboard
          // This is a placeholder for entity validation
        }
      } catch (error) {
        logger.warn(`Could not verify entity ${entityName}:`, error.message);
      }
    }
    
    // Validate database connection
    await validateDatabaseConnection();
    
    logger.info('Database initialization completed successfully');
    
  } catch (error) {
    logger.error('Database initialization failed:', error);
    throw error;
  }
}

/**
 * Validate database connection
 */
export async function validateDatabaseConnection() {
  try {
    // Test connection by attempting to read from a known entity
    const testQuery = await base44.entities.Classroom.list({ limit: 1 });
    logger.info('Database connection validated successfully');
    return true;
  } catch (error) {
    logger.error('Database connection validation failed:', error);
    throw new Error('Cannot connect to Base44 database');
  }
}

/**
 * Get database statistics
 */
export async function getDatabaseStats() {
  try {
    const stats = {};
    
    for (const entityName of Object.keys(ENTITY_SCHEMAS)) {
      try {
        const count = await base44.entities[entityName].count?.();
        stats[entityName.toLowerCase()] = count || 0;
      } catch (error) {
        stats[entityName.toLowerCase()] = 'error';
      }
    }
    
    return {
      timestamp: new Date().toISOString(),
      entities: stats,
      status: 'healthy'
    };
  } catch (error) {
    logger.error('Failed to get database stats:', error);
    return {
      timestamp: new Date().toISOString(),
      entities: {},
      status: 'error',
      error: error.message
    };
  }
}

export default {
  ENTITY_SCHEMAS,
  initializeDatabase,
  validateDatabaseConnection,
  getDatabaseStats
};