/**
 * Authentication Middleware for liveMentor Backend
 * Handles JWT token validation and user authorization using Base44
 */

import jwt from 'jsonwebtoken';
import { base44 } from '../services/base44.js';
import logger from '../utils/logger.js';

const getJwtSecret = () => process.env.JWT_SECRET || 'your-jwt-secret-key-change-this-in-production';

/**
 * JWT Authentication Middleware
 * Validates JWT tokens and sets user context
 */
export default async function authMiddleware(req, res, next) {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'No authorization header provided'
      });
    }

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid authorization header format. Expected: Bearer <token>'
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'No token provided'
      });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, getJwtSecret());
    } catch (jwtError) {
      logger.warn(`JWT verification failed: ${jwtError.message}`);
      
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Token Expired',
          message: 'Your session has expired. Please login again.'
        });
      }
      
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          error: 'Invalid Token',
          message: 'The provided token is invalid.'
        });
      }
      
      return res.status(401).json({
        error: 'Token Verification Failed',
        message: 'Could not verify the provided token.'
      });
    }

    // Extract user information from token
    const { email, role, name } = decoded;
    
    if (!email) {
      return res.status(401).json({
        error: 'Invalid Token',
        message: 'Token does not contain required user information.'
      });
    }

    // Optionally verify user still exists in database
    if (process.env.ENABLE_USER_VERIFICATION === 'true') {
      try {
        const userProfile = await base44.entities.UserProfile.findByField('email', email);
        
        if (!userProfile?.length || !userProfile[0].is_active) {
          logger.warn(`Authentication failed for inactive user: ${email}`);
          return res.status(401).json({
            error: 'Account Inactive',
            message: 'Your account has been deactivated. Please contact support.'
          });
        }
        
        // Update last login time
        await base44.entities.UserProfile.update(userProfile[0].id, {
          last_login: new Date().toISOString()
        });
      } catch (dbError) {
        logger.error('User verification failed:', dbError);
        // Continue with token-based auth if database check fails
      }
    }

    // Set user context on request object
    req.user = {
      email,
      role: role || 'student',
      name: name || email.split('@')[0],
      isAuthenticated: true
    };

    // Set Base44 context for this request
    if (process.env.BASE44_USER_CONTEXT === 'true') {
      req.base44Context = {
        user_email: email,
        user_role: role || 'student',
        request_id: req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      };
    }

    logger.debug(`User authenticated: ${email} (${role || 'student'})`);
    next();

  } catch (error) {
    logger.error('Authentication middleware error:', error);
    res.status(500).json({
      error: 'Authentication Error',
      message: 'An error occurred during authentication.'
    });
  }
}

/**
 * Role-based authorization middleware
 * @param {string[]} allowedRoles - Array of allowed roles
 * @returns {Function} Express middleware function
 */
export function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user || !req.user.isAuthenticated) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
    }

    const userRole = req.user.role;
    
    if (!allowedRoles.includes(userRole)) {
      logger.warn(`Authorization failed for user ${req.user.email}: required roles ${allowedRoles}, got ${userRole}`);
      return res.status(403).json({
        error: 'Forbidden',
        message: `Access denied. Required role: ${allowedRoles.join(' or ')}`
      });
    }

    next();
  };
}

/**
 * Classroom access authorization middleware
 * Checks if user has access to a specific classroom
 * @param {string} classroomIdParam - Request parameter name containing classroom ID
 * @returns {Function} Express middleware function
 */
export function requireClassroomAccess(classroomIdParam = 'classroomId') {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.isAuthenticated) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required'
        });
      }

      const classroomId = req.params[classroomIdParam] || req.body.classroom_id || req.query.classroom_id;
      
      if (!classroomId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Classroom ID is required'
        });
      }

      // Fetch classroom from database
      const classroom = await base44.entities.Classroom.findById(classroomId);
      
      if (!classroom) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Classroom not found'
        });
      }

      const userEmail = req.user.email;
      const userRole = req.user.role;
      
      // Check access permissions
      const hasAccess = 
        userRole === 'admin' || // Admins have access to all classrooms
        classroom.faculty_email === userEmail || // Faculty owner
        (classroom.student_emails && classroom.student_emails.includes(userEmail)); // Enrolled student

      if (!hasAccess) {
        logger.warn(`Classroom access denied for user ${userEmail} to classroom ${classroomId}`);
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have access to this classroom'
        });
      }

      // Add classroom to request context
      req.classroom = classroom;
      req.userClassroomRole = classroom.faculty_email === userEmail ? 'faculty' : 'student';

      next();

    } catch (error) {
      logger.error('Classroom access middleware error:', error);
      res.status(500).json({
        error: 'Authorization Error',
        message: 'An error occurred during authorization.'
      });
    }
  };
}

/**
 * Optional authentication middleware
 * Sets user context if token is present, but doesn't require authentication
 */
export async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = {
          email: decoded.email,
          role: decoded.role || 'student',
          name: decoded.name || decoded.email.split('@')[0],
          isAuthenticated: true
        };
        logger.debug(`Optional auth: User ${decoded.email} authenticated`);
      } catch (jwtError) {
        logger.debug('Optional auth: Invalid token, continuing as anonymous');
        req.user = { isAuthenticated: false };
      }
    } else {
      req.user = { isAuthenticated: false };
    }
    
    next();
    
  } catch (error) {
    logger.error('Optional auth middleware error:', error);
    req.user = { isAuthenticated: false };
    next();
  }
}

/**
 * API Key authentication middleware (for external integrations)
 */
export function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required'
    });
  }
  
  if (apiKey !== process.env.API_SECRET_KEY) {
    logger.warn(`Invalid API key attempt from IP: ${req.ip}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }
  
  req.user = {
    isAuthenticated: true,
    role: 'api',
    email: 'api@system',
    name: 'API Client'
  };
  
  next();
}

export { authMiddleware };