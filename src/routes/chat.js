/**
 * Chat Routes
 * Handles real-time chat messages in classrooms
 */

import express from 'express';
import { base44 } from '../services/base44.js';
import { validateBody, validateQuery, validateParams, schemas } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../utils/logger.js';
import Joi from 'joi';

const router = express.Router();

// Chat validation schemas
const chatSchemas = {
  sendMessage: Joi.object({
    classroom_id: Joi.string().required(),
    message: Joi.string().min(1).max(2000).trim().required(),
    type: Joi.string().valid('message', 'announcement', 'system').default('message')
  }),

  getMessages: Joi.object({
    classroom_id: Joi.string().required(),
    before: Joi.date().iso().optional(),
    after: Joi.date().iso().optional(),
    limit: Joi.number().integer().min(1).max(100).default(50)
  })
};

/**
 * GET /api/chat/messages
 * Get chat messages for a classroom
 */
router.get('/messages',
  validateQuery(chatSchemas.getMessages),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { classroom_id, before, after, limit } = req.query;

      // Verify classroom access
      const classroom = await base44.database.entity.findById('Classroom', classroom_id);
      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      const hasAccess = 
        classroom.faculty_email === user.email ||
        classroom.student_emails.includes(user.email) ||
        user.role === 'admin';

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this classroom'
        });
      }

      // Build query for messages
      let query = { 
        classroom_id,
        type: { $in: ['message', 'announcement', 'system'] }
      };

      if (before) {
        query.created_at = { ...query.created_at, $lt: before };
      }
      if (after) {
        query.created_at = { ...query.created_at, $gt: after };
      }

      const messages = await base44.database.entity.find('ChatMessage', query, {
        limit: parseInt(limit),
        sort: { created_at: -1 }  // Most recent first
      });

      res.json({
        success: true,
        messages: messages.reverse(), // Return oldest first for chat display
        count: messages.length,
        classroom_id
      });

    } catch (error) {
      logger.error('Get chat messages error:', error);
      res.status(500).json({
        error: 'Failed to fetch messages',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/chat/messages
 * Send a new chat message
 */
router.post('/messages',
  validateBody(chatSchemas.sendMessage),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { classroom_id, message, type } = req.body;

      // Verify classroom access
      const classroom = await base44.database.entity.findById('Classroom', classroom_id);
      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      const hasAccess = 
        classroom.faculty_email === user.email ||
        classroom.student_emails.includes(user.email) ||
        user.role === 'admin';

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this classroom'
        });
      }

      // Only faculty can send announcements
      if (type === 'announcement' && classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only faculty can send announcements'
        });
      }

      const messageData = {
        classroom_id,
        sender_email: user.email,
        sender_name: user.full_name || user.name || user.email,
        message,
        type,
        metadata: {
          sender_role: user.role || 'student',
          message_length: message.length,
          client_timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      const chatMessage = await base44.database.entity.create('ChatMessage', messageData);

      res.status(201).json({
        success: true,
        message: chatMessage,
        message_text: 'Message sent successfully'
      });

      logger.info(`Chat message sent in classroom ${classroom_id} by ${user.email}`);

      // TODO: Broadcast to WebSocket clients in the same classroom
      // This would integrate with the WebSocket service
      // broadcastToClassroom(classroom_id, {
      //   type: 'new_message',
      //   message: chatMessage
      // });

    } catch (error) {
      logger.error('Send chat message error:', error);
      res.status(500).json({
        error: 'Failed to send message',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/chat/messages/:id
 * Get specific message details
 */
router.get('/messages/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const message = await base44.database.entity.findById('ChatMessage', req.params.id);

      if (!message) {
        return res.status(404).json({
          error: 'Message not found'
        });
      }

      // Verify classroom access
      const classroom = await base44.database.entity.findById('Classroom', message.classroom_id);
      const hasAccess = 
        classroom.faculty_email === user.email ||
        classroom.student_emails.includes(user.email) ||
        user.role === 'admin';

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this message'
        });
      }

      res.json({
        success: true,
        message
      });

    } catch (error) {
      logger.error('Get chat message error:', error);
      res.status(500).json({
        error: 'Failed to fetch message',
        message: error.message
      });
    }
  })
);

/**
 * DELETE /api/chat/messages/:id
 * Delete a chat message (sender or faculty only)
 */
router.delete('/messages/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const message = await base44.database.entity.findById('ChatMessage', req.params.id);

      if (!message) {
        return res.status(404).json({
          error: 'Message not found'
        });
      }

      // Check permissions - sender or faculty can delete
      const classroom = await base44.database.entity.findById('Classroom', message.classroom_id);
      const canDelete = 
        message.sender_email === user.email ||
        classroom.faculty_email === user.email ||
        user.role === 'admin';

      if (!canDelete) {
        return res.status(403).json({
          error: 'Cannot delete this message'
        });
      }

      await base44.database.entity.delete('ChatMessage', req.params.id);

      res.json({
        success: true,
        message: 'Message deleted successfully'
      });

      logger.info(`Chat message deleted: ${req.params.id} by ${user.email}`);

      // TODO: Broadcast deletion to WebSocket clients
      // broadcastToClassroom(message.classroom_id, {
      //   type: 'message_deleted',
      //   message_id: req.params.id
      // });

    } catch (error) {
      logger.error('Delete chat message error:', error);
      res.status(500).json({
        error: 'Failed to delete message',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/chat/active-users
 * Get active users in a classroom chat
 */
router.get('/active-users',
  validateQuery({
    classroom_id: Joi.string().required(),
    since: Joi.date().iso().default(() => {
      // Default to last 5 minutes
      const fiveMinutesAgo = new Date();
      fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);
      return fiveMinutesAgo;
    })
  }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { classroom_id, since } = req.query;

      // Verify classroom access
      const classroom = await base44.database.entity.findById('Classroom', classroom_id);
      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      const hasAccess = 
        classroom.faculty_email === user.email ||
        classroom.student_emails.includes(user.email) ||
        user.role === 'admin';

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this classroom'
        });
      }

      // Get recent messages to determine active users
      const recentMessages = await base44.database.entity.find('ChatMessage', {
        classroom_id,
        created_at: { $gte: since }
      });

      // Extract unique active users
      const activeUsers = [];
      const seenEmails = new Set();

      recentMessages.forEach(msg => {
        if (!seenEmails.has(msg.sender_email)) {
          seenEmails.add(msg.sender_email);
          activeUsers.push({
            email: msg.sender_email,
            name: msg.sender_name,
            role: msg.metadata?.sender_role || 'student',
            last_activity: msg.created_at
          });
        }
      });

      res.json({
        success: true,
        active_users: activeUsers,
        count: activeUsers.length,
        since,
        classroom_id
      });

    } catch (error) {
      logger.error('Get active users error:', error);
      res.status(500).json({
        error: 'Failed to fetch active users',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/chat/typing
 * Send typing indicator
 */
router.post('/typing',
  validateBody({
    classroom_id: Joi.string().required(),
    is_typing: Joi.boolean().required()
  }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { classroom_id, is_typing } = req.body;

      // Verify classroom access
      const classroom = await base44.database.entity.findById('Classroom', classroom_id);
      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      const hasAccess = 
        classroom.faculty_email === user.email ||
        classroom.student_emails.includes(user.email) ||
        user.role === 'admin';

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this classroom'
        });
      }

      res.json({
        success: true,
        message: `Typing indicator ${is_typing ? 'started' : 'stopped'}`
      });

      // TODO: Broadcast typing indicator to WebSocket clients
      // broadcastToClassroom(classroom_id, {
      //   type: is_typing ? 'user_typing_start' : 'user_typing_stop',
      //   user: {
      //     email: user.email,
      //     name: user.full_name || user.name
      //   }
      // });

      logger.debug(`Typing indicator ${is_typing ? 'started' : 'stopped'} by ${user.email} in ${classroom_id}`);

    } catch (error) {
      logger.error('Typing indicator error:', error);
      res.status(500).json({
        error: 'Failed to update typing status',
        message: error.message
      });
    }
  })
);

export default router;