/**
 * Cache Service
 * In-memory caching with optional Redis support
 */

import logger from '../utils/logger.js';

// In-memory cache for development/fallback
class MemoryCache {
  constructor() {
    this.cache = new Map();
    this.timers = new Map();
  }

  set(key, value, ttlSeconds = 3600) {
    // Clear existing timer if any
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    // Set value
    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      ttl: ttlSeconds * 1000
    });

    // Set expiration timer
    const timer = setTimeout(() => {
      this.delete(key);
    }, ttlSeconds * 1000);

    this.timers.set(key, timer);

    logger.debug(`Cache SET: ${key} (TTL: ${ttlSeconds}s)`);
    return true;
  }

  get(key) {
    const item = this.cache.get(key);
    
    if (!item) {
      return null;
    }

    // Check if expired
    if (Date.now() - item.createdAt > item.ttl) {
      this.delete(key);
      return null;
    }

    logger.debug(`Cache HIT: ${key}`);
    return item.value;
  }

  delete(key) {
    const deleted = this.cache.delete(key);
    
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }

    if (deleted) {
      logger.debug(`Cache DELETE: ${key}`);
    }

    return deleted;
  }

  clear() {
    // Clear all timers
    this.timers.forEach(timer => clearTimeout(timer));
    
    // Clear cache and timers
    this.cache.clear();
    this.timers.clear();
    
    logger.info('Cache cleared');
    return true;
  }

  keys() {
    return Array.from(this.cache.keys());
  }

  size() {
    return this.cache.size;
  }

  getStats() {
    const stats = {
      keys: this.cache.size,
      memory: 0
    };

    // Rough memory calculation
    this.cache.forEach((value, key) => {
      stats.memory += JSON.stringify(key).length + JSON.stringify(value).length;
    });

    return stats;
  }
}

// Cache instance
let cacheInstance = null;

/**
 * Initialize cache service
 */
export const initializeCache = async () => {
  try {
    logger.info('Initializing cache service...');
    
    // For now, use memory cache
    // In production, this could be extended to use Redis
    cacheInstance = new MemoryCache();
    
    logger.info('Memory cache initialized successfully');
    
    // Setup cache cleanup on process exit
    process.on('SIGTERM', () => {
      if (cacheInstance) {
        cacheInstance.clear();
      }
    });

    process.on('SIGINT', () => {
      if (cacheInstance) {
        cacheInstance.clear();
      }
    });
    
  } catch (error) {
    logger.error('Cache initialization failed:', error);
    throw error;
  }
};

/**
 * Get cache instance
 */
export const getCache = () => {
  if (!cacheInstance) {
    throw new Error('Cache not initialized. Call initializeCache() first.');
  }
  return cacheInstance;
};

/**
 * Cache a value with optional TTL
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttl - Time to live in seconds (default: 1 hour)
 */
export const set = (key, value, ttl = 3600) => {
  const cache = getCache();
  return cache.set(key, value, ttl);
};

/**
 * Get a cached value
 * @param {string} key - Cache key
 * @returns {any} Cached value or null if not found
 */
export const get = (key) => {
  const cache = getCache();
  return cache.get(key);
};

/**
 * Delete a cached value
 * @param {string} key - Cache key
 * @returns {boolean} True if deleted, false if not found
 */
export const del = (key) => {
  const cache = getCache();
  return cache.delete(key);
};

/**
 * Clear all cached values
 */
export const clear = () => {
  const cache = getCache();
  return cache.clear();
};

/**
 * Get cache statistics
 */
export const getStats = () => {
  const cache = getCache();
  return {
    ...cache.getStats(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  };
};

/**
 * Cache wrapper for functions
 * @param {Function} fn - Function to cache
 * @param {number} ttl - Cache TTL in seconds
 * @param {Function} keyGenerator - Function to generate cache key from arguments
 */
export const memoize = (fn, ttl = 3600, keyGenerator) => {
  return async (...args) => {
    const key = keyGenerator ? keyGenerator(...args) : `memoized_${fn.name}_${JSON.stringify(args)}`;
    
    // Try to get from cache first
    const cachedResult = get(key);
    if (cachedResult !== null) {
      logger.debug(`Cache hit for function ${fn.name}`);
      return cachedResult;
    }

    // Execute function and cache result
    try {
      const result = await fn(...args);
      set(key, result, ttl);
      logger.debug(`Cached result for function ${fn.name}`);
      return result;
    } catch (error) {
      logger.error(`Function ${fn.name} failed, not caching error`);
      throw error;
    }
  };
};

/**
 * Predefined cache keys for common operations
 */
export const cacheKeys = {
  userProfile: (userId) => `user_profile_${userId}`,
  classroomData: (classroomId) => `classroom_${classroomId}`,
  assignmentData: (assignmentId) => `assignment_${assignmentId}`,
  submissionData: (submissionId) => `submission_${submissionId}`,
  codeExecution: (codeHash) => `code_execution_${codeHash}`,
  analyticsData: (userId, period) => `analytics_${userId}_${period}`,
  classroomStudents: (classroomId) => `classroom_students_${classroomId}`,
  userSubmissions: (userId, classroomId) => `user_submissions_${userId}_${classroomId}`
};

/**
 * Cache TTL presets (in seconds)
 */
export const cacheTTL = {
  SHORT: 300,      // 5 minutes
  MEDIUM: 1800,    // 30 minutes  
  LONG: 3600,      // 1 hour
  EXTRA_LONG: 86400 // 24 hours
};

/**
 * Get cache health status
 */
export const getCacheHealth = () => {
  try {
    const cache = getCache();
    const stats = cache.getStats();
    
    return {
      status: 'healthy',
      type: 'memory',
      stats,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

export default {
  initializeCache,
  getCache,
  set,
  get,
  del,
  clear,
  getStats,
  memoize,
  cacheKeys,
  cacheTTL,
  getCacheHealth
};