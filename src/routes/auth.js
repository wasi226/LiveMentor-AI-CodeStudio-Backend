/**
 * Authentication Routes
 * Handles user authentication with JWT tokens and MongoDB/Memory hybrid storage
 */

import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { userService } from '../services/userService.js';
import logger from '../utils/logger.js';

const router = express.Router();
const getJwtSecret = () => process.env.JWT_SECRET || 'your-jwt-secret-key-change-this-in-production';

/**
 * POST /api/auth/register
 * Register new user
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, role = 'student', rollNumber } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'Email, password, and full name are required'
      });
    }

    // For students, rollNumber is required
    if (role === 'student' && !rollNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'Roll number is required for students'
      });
    }

    // Check if user already exists
    const existingUser = await userService.findByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'User already exists',
        message: 'An account with this email already exists'
      });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user using hybrid service
    const user = await userService.createUser({
      email,
      password: hashedPassword,
      full_name: fullName,
      role: role === 'admin' ? 'student' : role, // Don't allow admin registration through API
      ...(role === 'student' && rollNumber && { rollNumber })
    });

    res.status(201).json({
      success: true,
      user: {
        id: user._id || user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        rollNumber: user.rollNumber
      },
      message: 'Registration successful'
    });

    logger.info(`User registered: ${email}`);
    
  } catch (error) {
    logger.error('Registration error:', error);
    
    // Handle duplicate key errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        success: false,
        error: 'Duplicate data',
        message: `An account with this ${field} already exists`
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Registration service unavailable'
    });
  }
});

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Missing credentials',
        message: 'Email and password are required'
      });
    }

    // Find user using hybrid service
    const user = await userService.findByEmail(email);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication failed',
        message: 'Invalid email or password'
      });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        error: 'Authentication failed',
        message: 'Invalid email or password'
      });
    }

    // Update last login
    await userService.updateUser(user.email, { lastLogin: new Date() });

    // Generate JWT token
    const token = jwt.sign(
      {
        userId: user._id || user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        rollNumber: user.rollNumber
      },
      getJwtSecret(),
      { expiresIn: '24h' }
    );
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id || user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        rollNumber: user.rollNumber
      },
      message: 'Login successful'
    });

    logger.info(`User logged in: ${email}`);
    
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Authentication service unavailable'
    });
  }
});

/**
 * GET /api/auth/me
 * Get current user profile
 */
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'No authorization header provided'
      });
    }

    const token = authHeader.substring(7);
    
    // Verify JWT token
    const decoded = jwt.verify(token, getJwtSecret());
    
    // Find user using hybrid service
    const user = await userService.findByEmail(decoded.email);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found',
        message: 'User account no longer exists'
      });
    }
    
    res.json({
      success: true,
      user: {
        id: user._id || user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        rollNumber: user.rollNumber
      }
    });
    
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token',
        message: 'Authentication token is invalid'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired',
        message: 'Authentication token has expired'
      });
    }
    
    logger.error('Auth me error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Authentication service unavailable'
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout current user
 */
router.post('/logout', (req, res) => {
  try {
    // JWT is stateless, so we just confirm logout
    // In production, you might want to blacklist the token
    
    res.json({
      success: true,
      message: 'Logout successful'
    });

    logger.info('User logged out');
    
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Logout failed'
    });
  }
});

export default router;