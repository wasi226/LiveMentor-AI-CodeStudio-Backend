/**
 * Debug Routes - View current data status
 */

import express from 'express';
import { Classroom, Assignment, Submission, ChatMessage } from '../models/index.js';
import { getConnectionStatus } from '../config/mongodb.js';
import { userService, isMongoDBConnected } from '../services/userService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Get all registered users (excluding passwords)
router.get('/users', async (req, res) => {
  try {
    const userCount = await userService.countUsers();
    const users = await userService.getAllUsers(true); // Exclude passwords
    const storageType = isMongoDBConnected() ? 'MongoDB' : 'In-Memory';
    
    res.json({
      success: true,
      data: {
        total_users: userCount,
        storage_type: storageType,
        persistence: isMongoDBConnected() ? 'Permanent' : 'Temporary (lost on restart)',
        recent_users: users.map(user => ({
          id: user._id || user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
          rollNumber: user.rollNumber,
          created: user.createdAt
        }))
      }
    });
  } catch (error) {
    logger.error('Debug users error:', error);
    res.status(500).json({ error: 'Unable to access user data: ' + error.message });
  }
});

// Get database status
router.get('/database-status', async (req, res) => {
  try {
    const dbStatus = getConnectionStatus();
    const isConnected = isMongoDBConnected();
    
    let collections = {};
    if (isConnected) {
      collections = {
        users: await userService.countUsers(),
        classrooms: await Classroom.countDocuments(),
        assignments: await Assignment.countDocuments(),
        submissions: await Submission.countDocuments(),
        chat_messages: await ChatMessage.countDocuments()
      };
    } else {
      collections = {
        users: await userService.countUsers(),
        classrooms: 0,
        assignments: 0,
        submissions: 0,
        chat_messages: 0
      };
    }
    
    res.json({
      success: true,
      database_info: {
        type: isConnected ? 'MongoDB' : 'In-Memory Storage',
        status: isConnected ? dbStatus.state : 'disconnected',
        host: isConnected ? dbStatus.host : 'localhost',
        port: isConnected ? dbStatus.port : 27017,
        database: isConnected ? dbStatus.name : 'memory',
        persistence: isConnected ? 'All data is permanently saved' : 'Data lost on server restart',
        collections_count: collections
      },
      recommendations: isConnected ? [
        'Data is permanently stored in MongoDB',
        'You can view data using MongoDB Compass or CLI',
        'All user registrations and app data persist between server restarts'
      ] : [
        'MongoDB is not connected - using in-memory storage',
        'To enable persistent storage, install and start MongoDB',
        'User registrations will be lost when server restarts'
      ]
    });
  } catch (error) {
    logger.error('Database status error:', error);
    res.status(500).json({ error: 'Unable to get database status: ' + error.message });
  }
});

// Get current environment info
router.get('/environment', (req, res) => {
  try {
    const dbStatus = getConnectionStatus();
    const isConnected = isMongoDBConnected();
    
    res.json({
      success: true,
      environment: {
        node_env: process.env.NODE_ENV || 'development',
        database_type: isConnected ? 'MongoDB' : 'In-Memory Storage',
        database_connected: isConnected,
        mongodb_uri: process.env.MONGODB_URI ? 'Set' : 'Using default (localhost)',
        database_host: isConnected ? (dbStatus.host || 'localhost') : 'N/A',
        database_port: isConnected ? (dbStatus.port || 27017) : 'N/A',
        database_name: isConnected ? (dbStatus.name || 'livementor_db') : 'memory',
        storage_note: isConnected ? 
          'All data persists between server restarts' : 
          'Data is temporary and will be lost on restart'
      }
    });
  } catch (error) {
    logger.error('Environment info error:', error);
    res.status(500).json({ error: 'Unable to get environment info: ' + error.message });
  }
});

// Get all collections data (for development only)
router.get('/collections/:collection?', async (req, res) => {
  try {
    const { collection } = req.params;
    const isConnected = isMongoDBConnected();
    
    if (!isConnected) {
      return res.json({
        success: true,
        message: 'MongoDB not connected - only user data available in memory',
        available_collections: {
          users: {
            count: await userService.countUsers(),
            endpoint: '/api/debug/users'
          }
        },
        note: 'Install and start MongoDB to access all collections'
      });
    }
    
    const collections = {
      users: userService,
      classrooms: Classroom,
      assignments: Assignment,
      submissions: Submission,
      chat_messages: ChatMessage
    };
    
    if (collection && collections[collection]) {
      if (collection === 'users') {
        // Handle users collection specially
        const data = await userService.getAllUsers(true);
        const count = await userService.countUsers();
        
        res.json({
          success: true,
          collection: collection,
          total_count: count,
          data: data
        });
      } else {
        // Get specific collection data
        const Model = collections[collection];
        const data = await Model.find({}).limit(20); // Limit to 20 records
        const count = await Model.countDocuments();
        
        res.json({
          success: true,
          collection: collection,
          total_count: count,
          data: data
        });
      }
    } else {
      // Get all collections summary
      const summary = {
        users: {
          count: await userService.countUsers(),
          endpoint: '/api/debug/collections/users'
        }
      };
      
      if (isConnected) {
        for (const [name, Model] of Object.entries(collections)) {
          if (name !== 'users') {
            summary[name] = {
              count: await Model.countDocuments(),
              endpoint: `/api/debug/collections/${name}`
            };
          }
        }
      }
      
      res.json({
        success: true,
        message: 'All collections summary',
        storage_type: isConnected ? 'MongoDB' : 'In-Memory',
        collections: summary,
        available_endpoints: Object.keys(summary).map(name => `/api/debug/collections/${name}`)
      });
    }
  } catch (error) {
    logger.error('Collections debug error:', error);
    res.status(500).json({ error: 'Unable to fetch collection data: ' + error.message });
  }
});

export default router;