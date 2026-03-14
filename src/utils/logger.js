/**
 * Centralized Logging Utility
 * Configures Winston logger with multiple transports and log levels
 */

import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Get current directory (ESM equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let logMessage = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    // Add stack trace for errors
    if (stack) {
      logMessage += `\n${stack}`;
    }
    
    // Add metadata if present
    const metaString = Object.keys(meta).length > 0 ? `\n${JSON.stringify(meta, null, 2)}` : '';
    
    return logMessage + metaString;
  })
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let logMessage = `${timestamp} ${level}: ${message}`;
    
    if (stack && process.env.NODE_ENV === 'development') {
      logMessage += `\n${stack}`;
    }
    
    return logMessage;
  })
);

// Configure transports based on environment
const transports = [];

// Console transport
transports.push(new winston.transports.Console({
  level: process.env.LOG_LEVEL || 'info',
  format: consoleFormat,
  handleExceptions: true,
  handleRejections: true
}));

// File transport for all logs
transports.push(new winston.transports.File({
  filename: path.join(logsDir, 'app.log'),
  level: 'info',
  format: logFormat,
  maxsize: parseInt(process.env.LOG_MAX_SIZE) || 10485760, // 10MB
  maxFiles: parseInt(process.env.LOG_MAX_FILES) || 5,
  tailable: true,
  handleExceptions: true,
  handleRejections: true
}));

// Error-only file transport
transports.push(new winston.transports.File({
  filename: path.join(logsDir, 'error.log'),
  level: 'error',
  format: logFormat,
  maxsize: 5242880, // 5MB
  maxFiles: 10,
  tailable: true
}));

// Combined debug file for development
if (process.env.NODE_ENV === 'development' || process.env.ENABLE_DEBUG_LOGGING === 'true') {
  transports.push(new winston.transports.File({
    filename: path.join(logsDir, 'debug.log'),
    level: 'debug',
    format: logFormat,
    maxsize: 10485760, // 10MB
    maxFiles: 3,
    tailable: true
  }));
}

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'development' ? 'debug' : 'info'),
  transports,
  exitOnError: false,
  defaultMeta: {
    service: 'livementor-backend',
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '1.0.0'
  }
});

// Add request ID tracking for HTTP requests
logger.addRequestId = (req) => {
  const requestId = req.headers['x-request-id'] || 
    `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  return logger.child({ requestId, ip: req.ip, userAgent: req.headers['user-agent'] });
};

// Performance monitoring
logger.startTimer = (label) => {
  const start = process.hrtime.bigint();
  return {
    end: (metadata = {}) => {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1000000; // Convert to milliseconds
      logger.info(`Performance: ${label} completed in ${duration.toFixed(2)}ms`, { 
        duration, 
        label, 
        ...metadata 
      });
      return duration;
    }
  };
};

// Database query logging
logger.query = (query, params = {}, executionTime = 0) => {
  logger.debug('Database Query', {
    query: query.replace(/\s+/g, ' ').trim(),
    params: Object.keys(params).length > 0 ? params : undefined,
    executionTime: `${executionTime}ms`,
    type: 'database'
  });
};

// API request logging
logger.apiRequest = (req, res, responseTime) => {
  const logLevel = res.statusCode >= 400 ? 'warn' : 'info';
  
  logger.log(logLevel, 'API Request', {
    method: req.method,
    url: req.originalUrl,
    statusCode: res.statusCode,
    responseTime: `${responseTime}ms`,
    userEmail: req.user?.email,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    type: 'api-request'
  });
};

// Error context helper
logger.errorWithContext = (message, error, context = {}) => {
  logger.error(message, {
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack
    },
    context,
    timestamp: new Date().toISOString()
  });
};

// Security event logging
logger.security = (event, details = {}) => {
  logger.warn('Security Event', {
    event,
    details,
    timestamp: new Date().toISOString(),
    type: 'security'
  });
};

// Business logic event logging
logger.business = (event, metadata = {}) => {
  logger.info('Business Event', {
    event,
    metadata,
    timestamp: new Date().toISOString(),
    type: 'business'
  });
};

// Health check logging
logger.health = (service, status, details = {}) => {
  const logLevel = status === 'healthy' ? 'info' : 'warn';
  logger.log(logLevel, `Health Check: ${service}`, {
    service,
    status,
    details,
    timestamp: new Date().toISOString(),
    type: 'health-check'
  });
};

// Graceful shutdown logging
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM signal. Graceful shutdown initiated.');
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT signal. Graceful shutdown initiated.');
});

// Uncaught exception handling
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { 
    reason: reason?.message || reason, 
    stack: reason?.stack,
    promise: promise.toString()
  });
});

// Log startup information
logger.info('Logger initialized', {
  level: logger.level,
  environment: process.env.NODE_ENV || 'development',
  logsDirectory: logsDir,
  transports: transports.map(t => t.constructor.name)
});

export default logger;