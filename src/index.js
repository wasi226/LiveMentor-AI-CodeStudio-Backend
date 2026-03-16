/**
 * liveMentor AI CodeStudio - Backend Server
 * Main application entry point using Base44 BaaS
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import dotenv from 'dotenv';
import { connectMongoDB, getConnectionStatus } from './config/mongodb.js';

// Import routes
import authRoutes from './routes/auth.js';
import aiRoutes from './routes/ai.js';
import classroomRoutes from './routes/classrooms.js';
import assignmentRoutes from './routes/assignments.js';
import submissionRoutes from './routes/submissions.js';
import chatRoutes from './routes/chat.js';
import codeRoutes from './routes/code.js';
import analyticsRoutes from './routes/analytics.js';
import healthRoutes from './routes/health.js';
import debugRoutes from './routes/debug.js';

// Import middleware
import errorHandler from './middleware/errorHandler.js';
import authMiddleware from './middleware/auth.js';

// Import services
import { startSocketIOServer } from './services/socketio.js';
import { initializeCache } from './services/cache.js';
import { initializeDatabase } from './services/database_init.js';
import logger from './utils/logger.js';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Rate limiting configuration
const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.ip,
  points: process.env.RATE_LIMIT_MAX_REQUESTS || 100,
  duration: process.env.RATE_LIMIT_WINDOW_MS || 900, // 15 minutes
});

// Rate limiting middleware
const rateLimitMiddleware = async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch (error) {
    const secs = Math.round((error?.msBeforeNext || 1000) / 1000) || 1;
    res.set('Retry-After', String(secs));
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: secs
    });
  }
};

// Base44 client is initialized in services/base44.js
logger.info('Using Base44 client for backend services');

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || 'http://localhost:5173',
  credentials: process.env.CORS_CREDENTIALS === 'true',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));

// Compression and parsing middleware
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
if (process.env.ENABLE_REQUEST_LOGGING === 'true') {
  app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
}

// Apply rate limiting
app.use(rateLimitMiddleware);

// Health check (before auth middleware)
app.use('/health', healthRoutes);

// API documentation (if enabled)
if (process.env.ENABLE_SWAGGER_DOCS === 'true') {
  try {
    const swaggerUi = await import('swagger-ui-express');
    const swaggerDocument = await import('../docs/api.json', { assert: { type: 'json' } });
    
    app.use('/api-docs', swaggerUi.default.serve, swaggerUi.default.setup(swaggerDocument.default));
    logger.info('Swagger documentation available at /api-docs');
  } catch (error) {
    logger.warn(`Swagger documentation disabled: ${error.message}`);
  }
}

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/ai', authMiddleware, aiRoutes);
app.use('/api/classrooms', authMiddleware, classroomRoutes);
app.use('/api/assignments', authMiddleware, assignmentRoutes);
app.use('/api/submissions', authMiddleware, submissionRoutes);
app.use('/api/chat', authMiddleware, chatRoutes);
app.use('/api/code', authMiddleware, codeRoutes);
app.use('/api/analytics', authMiddleware, analyticsRoutes);
app.use('/api/debug', debugRoutes); // Debug endpoints for development

// Default route
app.get('/', (req, res) => {
  res.json({
    message: 'liveMentor AI CodeStudio Backend API',
    version: process.env.APP_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      docs: process.env.ENABLE_SWAGGER_DOCS === 'true' ? '/api-docs' : 'disabled',
      auth: '/api/auth',
      ai: '/api/ai',
      classrooms: '/api/classrooms',
      assignments: '/api/assignments',
      submissions: '/api/submissions',
      chat: '/api/chat',
      code: '/api/code',
      analytics: '/api/analytics',
      debug: '/api/debug' // Development only
    },
    database: {
      type: 'MongoDB',
      status: getConnectionStatus()
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use(errorHandler);

// Initialize services
async function initializeServices() {
  try {
    logger.info('Initializing MongoDB and services...');
    
    // Try to initialize MongoDB connection
    try {
      await connectMongoDB();
      
      // If MongoDB connected successfully, initialize database
      await initializeDatabase();
      logger.info('Database initialized with MongoDB');
    } catch (error) {
      // MongoDB connection failed
      logger.warn(`MongoDB connection failed, running without persistent storage: ${error.message}`);
      logger.warn('User data will be stored in memory only');
    }

    // Initialize caching if enabled
    if (process.env.ENABLE_CACHING === 'true') {
      await initializeCache();
      logger.info('Cache initialized');
    }

    // Start Socket.IO server if enabled
    if (process.env.ENABLE_WEBSOCKETS === 'true') {
      await startSocketIOServer(server);
      logger.info('Socket.IO server started');
    }

  } catch (error) {
    logger.error('Failed to initialize services:', error);
    // Don't exit in development mode
    if (process.env.NODE_ENV !== 'development') {
      process.exit(1);
    }
  }
}

// Start server
const server = app.listen(PORT, async () => {
  logger.info(`🚀 liveMentor Backend server running on port ${PORT}`);
  logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🔗 CORS enabled for: ${process.env.CORS_ORIGIN || 'http://localhost:5173'}`);
  
  // Initialize services after server starts
  await initializeServices();
  
  logger.info('✅ All services initialized successfully');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed. Process terminated.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed. Process terminated.');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

export default app;