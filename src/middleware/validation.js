/**
 * Request Validation Middleware
 * Validates request data using Joi schemas
 */

import Joi from 'joi';
import logger from '../utils/logger.js';

/**
 * Validate request body against a Joi schema
 * @param {Object} schema - Joi validation schema
 * @returns {Function} Express middleware function
 */
export const validateBody = (schema) => {
  return (req, res, next) => {
    const validationSchema = schema && typeof schema.validate === 'function'
      ? schema
      : Joi.object(schema || {});

    const { error, value } = validationSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
      allowUnknown: false
    });

    if (error) {
      const validationErrors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message.replaceAll('"', ''),
        value: detail.context?.value
      }));

      logger.warn('Request validation failed:', {
        url: req.originalUrl,
        method: req.method,
        errors: validationErrors,
        body: req.body
      });

      return res.status(400).json({
        error: 'Validation Error',
        message: 'Request body validation failed',
        details: validationErrors,
        timestamp: new Date().toISOString()
      });
    }

    req.body = value;
    next();
  };
};

/**
 * Validate request query parameters against a Joi schema
 * @param {Object} schema - Joi validation schema
 * @returns {Function} Express middleware function
 */
export const validateQuery = (schema) => {
  return (req, res, next) => {
    const validationSchema = schema && typeof schema.validate === 'function'
      ? schema
      : Joi.object(schema || {});

    const { error, value } = validationSchema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true,
      allowUnknown: false
    });

    if (error) {
      const validationErrors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message.replaceAll('"', ''),
        value: detail.context?.value
      }));

      logger.warn('Query validation failed:', {
        url: req.originalUrl,
        method: req.method,
        errors: validationErrors,
        query: req.query
      });

      return res.status(400).json({
        error: 'Validation Error',
        message: 'Query parameters validation failed',
        details: validationErrors,
        timestamp: new Date().toISOString()
      });
    }

    req.query = value;
    next();
  };
};

/**
 * Validate request path parameters against a Joi schema
 * @param {Object} schema - Joi validation schema
 * @returns {Function} Express middleware function
 */
export const validateParams = (schema) => {
  return (req, res, next) => {
    const validationSchema = schema && typeof schema.validate === 'function'
      ? schema
      : Joi.object(schema || {});

    const { error, value } = validationSchema.validate(req.params, {
      abortEarly: false,
      stripUnknown: true,
      allowUnknown: false
    });

    if (error) {
      const validationErrors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message.replaceAll('"', ''),
        value: detail.context?.value
      }));

      logger.warn('Params validation failed:', {
        url: req.originalUrl,
        method: req.method,
        errors: validationErrors,
        params: req.params
      });

      return res.status(400).json({
        error: 'Validation Error',
        message: 'Path parameters validation failed',
        details: validationErrors,
        timestamp: new Date().toISOString()
      });
    }

    req.params = value;
    next();
  };
};

/**
 * Common validation schemas
 */
export const schemas = {
  // MongoDB ObjectId validation
  objectId: Joi.string().length(24).hex(),
  
  // Email validation
  email: Joi.string().email().lowercase().trim(),
  
  // Password validation
  password: Joi.string().min(8).max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .message('Password must contain at least one lowercase letter, one uppercase letter, and one number'),
  
  // Name validation
  name: Joi.string().min(2).max(100).trim(),
  
  // Classroom code validation
  classroomCode: Joi.string().length(6).alphanum().uppercase(),
  
  // Programming language validation
  language: Joi.string().valid('javascript', 'python', 'java'),
  
  // Pagination schema
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(200).default(20),
    sort: Joi.string().valid('asc', 'desc').default('desc'),
    sortBy: Joi.string().default('createdAt')
  }),
  
  // Date range schema 
  dateRange: Joi.object({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso().greater(Joi.ref('startDate'))
  }).with('startDate', 'endDate')
};

/**
 * Authentication validation schemas
 */
export const authSchemas = {
  login: Joi.object({
    email: schemas.email.required(),
    password: Joi.string().required()
  }),

  register: Joi.object({
    email: schemas.email.required(),
    password: schemas.password.required(),
    fullName: schemas.name.required(),
    role: Joi.string().valid('student', 'faculty', 'admin').default('student')
  }),

  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: schemas.password.required(),
    confirmPassword: Joi.string().valid(Joi.ref('newPassword')).required()
      .messages({ 'any.only': 'Passwords do not match' })
  })
};

/**
 * Classroom validation schemas
 */
export const classroomSchemas = {
  create: Joi.object({
    name: Joi.string().min(3).max(100).trim().required(),
    description: Joi.string().max(500).trim().allow(''),
    language: schemas.language.required(),
    maxStudents: Joi.number().integer().min(1).max(1000).default(50),
    isPrivate: Joi.boolean().default(false)
  }),

  join: Joi.object({
    code: Joi.string().custom((value, helpers) => {
      const normalized = String(value || '').trim().replaceAll(/\s+/g, '').toUpperCase();

      if (!/^[A-Z0-9]{6}$/.test(normalized)) {
        return helpers.message('Invalid classroom code');
      }

      return normalized;
    }).required()
  }),

  removeStudent: Joi.object({
    student_email: schemas.email.required()
  }),

  update: Joi.object({
    name: Joi.string().min(3).max(100).trim(),
    description: Joi.string().max(500).trim().allow(''),
    maxStudents: Joi.number().integer().min(1).max(1000),
    isPrivate: Joi.boolean()
  }).min(1) // At least one field to update
};

/**
 * Code execution validation schemas
 */
export const codeSchemas = {
  execute: Joi.object({
    code: Joi.string().max(50000).required(),
    language: schemas.language.required(),
    input: Joi.string().max(10000).allow(''),
    timeLimit: Joi.number().min(1).max(30).default(5),
    memoryLimit: Joi.number().min(16).max(512).default(128)
  }),

  save: Joi.object({
    code: Joi.string().max(50000).required(),
    language: schemas.language.required(),
    title: Joi.string().min(1).max(200).trim(),
    description: Joi.string().max(1000).trim().allow('')
  })
};

export default {
  validateBody,
  validateQuery,
  validateParams,
  schemas,
  authSchemas,
  classroomSchemas,
  codeSchemas
};