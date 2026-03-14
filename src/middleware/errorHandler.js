/**
 * Global Error Handler Middleware
 * Centralized error handling for the application
 */

import logger from '../utils/logger.js';

/**
 * Express error handling middleware
 * @param {Error} error - The error object
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object  
 * @param {Function} next - Express next function
 */
const errorHandler = (error, req, res, next) => {
  // Log the error with context
  logger.error('Error occurred:', {
    message: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });

  // Default error response
  let statusCode = 500;
  let errorResponse = {
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
    timestamp: new Date().toISOString(),
    requestId: req.headers['x-request-id'] || 'unknown'
  };

  // Handle specific error types
  if (error.name === 'ValidationError') {
    statusCode = 400;
    errorResponse = {
      error: 'Validation Error',
      message: error.message,
      details: error.details || null,
      timestamp: new Date().toISOString()
    };
  } else if (error.name === 'UnauthorizedError' || error.message.includes('unauthorized')) {
    statusCode = 401;
    errorResponse = {
      error: 'Unauthorized',
      message: 'Authentication required',
      timestamp: new Date().toISOString()
    };
  } else if (error.name === 'ForbiddenError' || error.message.includes('forbidden')) {
    statusCode = 403;
    errorResponse = {
      error: 'Forbidden',
      message: 'Insufficient permissions',
      timestamp: new Date().toISOString()
    };
  } else if (error.name === 'NotFoundError' || error.message.includes('not found')) {
    statusCode = 404;
    errorResponse = {
      error: 'Not Found',
      message: error.message || 'Resource not found',
      timestamp: new Date().toISOString()
    };
  } else if (error.name === 'ConflictError' || error.message.includes('already exists')) {
    statusCode = 409;
    errorResponse = {
      error: 'Conflict',
      message: error.message || 'Resource already exists',
      timestamp: new Date().toISOString()
    };
  } else if (error.name === 'RateLimitError') {
    statusCode = 429;
    errorResponse = {
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: error.retryAfter || 60,
      timestamp: new Date().toISOString()
    };
  } else if (error.name === 'ServiceUnavailableError') {
    statusCode = 503;
    errorResponse = {
      error: 'Service Unavailable',
      message: 'External service temporarily unavailable',
      timestamp: new Date().toISOString()
    };
  }

  // Handle Joi validation errors  
  if (error.isJoi) {
    statusCode = 400;
    errorResponse = {
      error: 'Validation Error',
      message: 'Request data validation failed',
      details: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value
      })),
      timestamp: new Date().toISOString()
    };
  }

  // Handle Base44 API errors
  if (error.response?.data) {
    statusCode = error.response.status || 500;
    errorResponse = {
      error: 'External API Error', 
      message: error.response.data.message || error.message,
      service: 'base44',
      timestamp: new Date().toISOString()
    };
  }

  // Handle MongoDB/Database errors
  if (error.code === 11000) { // Duplicate key error
    statusCode = 409;
    errorResponse = {
      error: 'Duplicate Entry',
      message: 'A record with this information already exists',
      timestamp: new Date().toISOString()
    };
  }

  // Handle JWT errors
  if (error.name === 'JsonWebTokenError') {
    statusCode = 401;
    errorResponse = {
      error: 'Invalid Token',
      message: 'Authentication token is invalid',
      timestamp: new Date().toISOString()
    };
  } else if (error.name === 'TokenExpiredError') {
    statusCode = 401;
    errorResponse = {
      error: 'Token Expired',
      message: 'Authentication token has expired',
      timestamp: new Date().toISOString()
    };
  }

  // Include error details in development mode
  if (process.env.NODE_ENV === 'development') {
    errorResponse.stack = error.stack;
    errorResponse.details = {
      name: error.name,
      code: error.code,
      statusCode: error.statusCode
    };
  }

  // Set appropriate cache headers for error responses
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  // Send error response
  res.status(statusCode).json(errorResponse);
};

/**
 * Handle 404 Not Found errors
 */
export const notFoundHandler = (req, res) => {
  const errorResponse = {
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    method: req.method,
    timestamp: new Date().toISOString()
  };

  logger.warn('404 Not Found:', {
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.status(404).json(errorResponse);
};

/**
 * Async error wrapper - catches async errors and passes to error handler
 */
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export default errorHandler;