/**
 * Assignment Routes
 * Handles assignment operations
 */

import express from 'express';
import { base44 } from '../services/base44.js';
import { validateBody, validateQuery, validateParams, schemas } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../utils/logger.js';
import Joi from 'joi';

const router = express.Router();

// Assignment validation schemas
const assignmentSchemas = {
  create: Joi.object({
    title: Joi.string().min(3).max(200).trim().required(),
    description: Joi.string().max(2000).trim().allow(''),
    classroom_id: Joi.string().required(),
    starter_code: Joi.string().max(10000).allow(''),
    solution_code: Joi.string().max(10000).allow(''),
    test_cases: Joi.array().items(
      Joi.object({
        input: Joi.string().allow(''),
        expectedOutput: Joi.string().required(),
        weight: Joi.number().min(1).default(1)
      })
    ).default([]),
    difficulty: Joi.string().valid('easy', 'medium', 'hard').default('medium'),
    max_score: Joi.number().min(1).max(1000).default(100),
    time_limit: Joi.number().min(1).max(300).default(30),
    memory_limit: Joi.number().min(16).max(1024).default(256),
    due_date: Joi.date().iso().greater('now'),
    auto_grade: Joi.boolean().default(true)
  }),

  update: Joi.object({
    title: Joi.string().min(3).max(200).trim(),
    description: Joi.string().max(2000).trim().allow(''),
    starter_code: Joi.string().max(10000).allow(''),
    solution_code: Joi.string().max(10000).allow(''),
    test_cases: Joi.array().items(
      Joi.object({
        input: Joi.string().allow(''),
        expectedOutput: Joi.string().required(),
        weight: Joi.number().min(1).default(1)
      })
    ),
    difficulty: Joi.string().valid('easy', 'medium', 'hard'),
    max_score: Joi.number().min(1).max(1000),
    time_limit: Joi.number().min(1).max(300),
    memory_limit: Joi.number().min(16).max(1024),
    due_date: Joi.date().iso(),
    auto_grade: Joi.boolean()
  }).min(1)
};

/**
 * GET /api/assignments
 * Get assignments for a classroom
 */
router.get('/', 
  validateQuery({
    classroom_id: Joi.string().required(),
    ...schemas.pagination
  }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { classroom_id, page, limit, sort, sortBy } = req.query;

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

      const assignments = await base44.database.entity.find('Assignment', 
        { classroom_id },
        {
          page,
          limit,
          sort: { [sortBy]: sort === 'asc' ? 1 : -1 }
        }
      );

      res.json({
        success: true,
        assignments,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: assignments.length
        }
      });

    } catch (error) {
      logger.error('Get assignments error:', error);
      res.status(500).json({
        error: 'Failed to fetch assignments',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/assignments
 * Create new assignment (faculty only)
 */
router.post('/',
  validateBody(assignmentSchemas.create),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      
      // Verify classroom and permissions
      const classroom = await base44.database.entity.findById('Classroom', req.body.classroom_id);
      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only faculty can create assignments'
        });
      }

      const assignmentData = {
        ...req.body,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const assignment = await base44.database.entity.create('Assignment', assignmentData);

      res.status(201).json({
        success: true,
        assignment,
        message: 'Assignment created successfully'
      });

      logger.info(`Assignment created: ${assignment.title} by ${user.email}`);

    } catch (error) {
      logger.error('Create assignment error:', error);
      res.status(500).json({
        error: 'Failed to create assignment',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/assignments/:id
 * Get specific assignment
 */
router.get('/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const assignment = await base44.database.entity.findById('Assignment', req.params.id);

      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      // Verify classroom access
      const classroom = await base44.database.entity.findById('Classroom', assignment.classroom_id);
      const hasAccess = 
        classroom.faculty_email === user.email ||
        classroom.student_emails.includes(user.email) ||
        user.role === 'admin';

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this assignment'
        });
      }

      // Hide solution code from students
      if (user.role === 'student' && classroom.faculty_email !== user.email) {
        delete assignment.solution_code;
      }

      res.json({
        success: true,
        assignment
      });

    } catch (error) {
      logger.error('Get assignment error:', error);
      res.status(500).json({
        error: 'Failed to fetch assignment',
        message: error.message
      });
    }
  })
);

/**
 * PUT /api/assignments/:id
 * Update assignment (faculty only)
 */
router.put('/:id',
  validateParams({ id: schemas.objectId }),
  validateBody(assignmentSchemas.update),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const assignment = await base44.database.entity.findById('Assignment', req.params.id);

      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      // Verify permissions
      const classroom = await base44.database.entity.findById('Classroom', assignment.classroom_id);
      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom faculty can update assignments'
        });
      }

      const updatedAssignment = await base44.database.entity.update('Assignment', req.params.id, {
        ...req.body,
        updated_at: new Date().toISOString()
      });

      res.json({
        success: true,
        assignment: updatedAssignment,
        message: 'Assignment updated successfully'
      });

    } catch (error) {
      logger.error('Update assignment error:', error);
      res.status(500).json({
        error: 'Failed to update assignment',
        message: error.message
      });
    }
  })
);

/**
 * DELETE /api/assignments/:id
 * Delete assignment (faculty only)
 */
router.delete('/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const assignment = await base44.database.entity.findById('Assignment', req.params.id);

      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      // Verify permissions
      const classroom = await base44.database.entity.findById('Classroom', assignment.classroom_id);
      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom faculty can delete assignments'
        });
      }

      await base44.database.entity.delete('Assignment', req.params.id);

      res.json({
        success: true,
        message: 'Assignment deleted successfully'
      });

      logger.info(`Assignment ${assignment.title} deleted by ${user.email}`);

    } catch (error) {
      logger.error('Delete assignment error:', error);
      res.status(500).json({
        error: 'Failed to delete assignment',
        message: error.message
      });
    }
  })
);

export default router;