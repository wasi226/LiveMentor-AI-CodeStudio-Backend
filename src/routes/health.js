/**
 * Health Check Routes
 * System health monitoring and status endpoints
 */

import express from 'express';
import { base44 } from '../services/base44.js';
import os from 'os';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /health
 * Basic health check endpoint
 */
router.get('/', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Test Base44 connection
    let base44Status = 'unknown';
    let base44ResponseTime = null;
    
    try {
      const base44StartTime = Date.now();
      await base44.auth.status();
      base44ResponseTime = Date.now() - base44StartTime;
      base44Status = 'connected';
    } catch (error) {
      base44Status = 'disconnected';
      logger.warn('Base44 health check failed:', error.message);
    }
    
    const responseTime = Date.now() - startTime;
    
    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      responseTime: `${responseTime}ms`,
      environment: process.env.NODE_ENV || 'development',
      version: process.env.APP_VERSION || '1.0.0',
      services: {
        base44: {
          status: base44Status,
          responseTime: base44ResponseTime ? `${base44ResponseTime}ms` : null
        },
        node: {
          version: process.version,
          status: 'running'
        }
      },
      system: {
        platform: os.platform(),
        architecture: os.arch(),
        freeMemory: `${Math.round(os.freemem() / 1024 / 1024)} MB`,
        totalMemory: `${Math.round(os.totalmem() / 1024 / 1024)} MB`,
        loadAverage: os.loadavg()
      }
    };
    
    res.json(healthData);
    
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      uptime: process.uptime()
    });
  }
});

/**
 * GET /health/ready
 * Readiness probe for Kubernetes/Docker
 */
router.get('/ready', async (req, res) => {
  try {
    // Check if all critical services are ready
    const checks = [];
    
    // Check Base44 connectivity
    try {
      await base44.auth.status();
      checks.push({ service: 'base44', status: 'ready' });
    } catch (error) {
      checks.push({ 
        service: 'base44', 
        status: 'not-ready',
        error: error.message
      });
    }
    
    // Check if all required environment variables are set
    const requiredEnvVars = [
      'BASE44_PROJECT_ID',
      'BASE44_API_KEY',
      'JWT_SECRET'
    ];
    
    const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
    
    if (missingEnvVars.length > 0) {
      checks.push({
        service: 'environment',
        status: 'not-ready',
        missing: missingEnvVars
      });
    } else {
      checks.push({ service: 'environment', status: 'ready' });
    }
    
    const allReady = checks.every(check => check.status === 'ready');
    
    if (allReady) {
      res.json({
        status: 'ready',
        timestamp: new Date().toISOString(),
        checks
      });
    } else {
      res.status(503).json({
        status: 'not-ready',
        timestamp: new Date().toISOString(),
        checks
      });
    }
    
  } catch (error) {
    logger.error('Readiness check error:', error);
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

/**
 * GET /health/live
 * Liveness probe for Kubernetes
 */
router.get('/live', (req, res) => {
  // Simple liveness check - just respond if server is running
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    pid: process.pid
  });
});

/**
 * GET /health/metrics
 * Basic performance metrics
 */
router.get('/metrics', (req, res) => {
  try {
    const memoryUsage = process.memoryUsage();
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`
      },
      cpu: {
        usage: process.cpuUsage(),
        loadAverage: os.loadavg()
      },
      system: {
        platform: os.platform(),
        freeMemory: `${Math.round(os.freemem() / 1024 / 1024)} MB`,
        totalMemory: `${Math.round(os.totalmem() / 1024 / 1024)} MB`
      }
    });
    
  } catch (error) {
    logger.error('Metrics error:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;