/**
 * Assignment Routes
 * Handles assignment operations
 */

import express from 'express';
import { Assignment, Classroom } from '../models/index.js';
import { validateBody, validateQuery, validateParams, schemas } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../utils/logger.js';
import Joi from 'joi';

const router = express.Router();

const mapTestCasesFromRequest = (testCases = []) => {
  return testCases.map((testCase) => ({
    input: testCase.input || '',
    expected_output: testCase.expectedOutput || testCase.expected_output || '',
    description: testCase.description || '',
    weight: testCase.weight || 1
  }));
};

const serializeAssignment = (assignment) => {
  const plain = assignment?.toObject ? assignment.toObject() : assignment;

  return {
    ...plain,
    id: plain?._id?.toString() || plain?.id,
    test_cases: (plain?.test_cases || []).map((testCase) => ({
      input: testCase.input || '',
      expectedOutput: testCase.expected_output || testCase.expectedOutput || '',
      description: testCase.description || '',
      weight: testCase.weight || 1
    }))
  };
};

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
  validateQuery(Joi.object({
    classroom_id: Joi.string().required(),
  }).concat(schemas.pagination)),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const { classroom_id, page, limit, sort, sortBy } = req.query;

      // Verify classroom access
      const classroom = await Classroom.findById(classroom_id).lean();
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

      const normalizedPage = Math.max(Number.parseInt(page, 10) || 1, 1);
      const normalizedLimit = Math.max(Number.parseInt(limit, 10) || 20, 1);
      const sortDirection = sort === 'asc' ? 1 : -1;
      const allowedSortFields = new Set(['createdAt', 'updatedAt', 'due_date', 'title', 'difficulty', 'max_score']);
      const sortField = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';

      const assignments = await Assignment.find({ classroom_id })
        .sort({ [sortField]: sortDirection })
        .skip((normalizedPage - 1) * normalizedLimit)
        .limit(normalizedLimit)
        .lean();

      const total = await Assignment.countDocuments({ classroom_id });

      const serializedAssignments = assignments.map((assignment) => ({
        ...assignment,
        id: assignment._id?.toString()
      }));

      res.json({
        success: true,
        assignments: serializedAssignments,
        pagination: {
          page: normalizedPage,
          limit: normalizedLimit,
          total
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
      const user = req.user;
      
      // Verify classroom and permissions
      const classroom = await Classroom.findById(req.body.classroom_id).lean();
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
        title: req.body.title,
        description: req.body.description || '',
        classroom_id: req.body.classroom_id,
        language: classroom.language || 'javascript',
        difficulty: req.body.difficulty,
        starter_code: req.body.starter_code || '',
        solution_code: req.body.solution_code || '',
        test_cases: mapTestCasesFromRequest(req.body.test_cases || []),
        max_score: req.body.max_score,
        time_limit: req.body.time_limit,
        memory_limit: req.body.memory_limit,
        due_date: req.body.due_date,
        is_published: true,
        auto_grade: req.body.auto_grade,
        created_by: user.email,
        metadata: {
          auto_grade: req.body.auto_grade
        }
      };

      const assignment = await Assignment.create(assignmentData);

      res.status(201).json({
        success: true,
        assignment: serializeAssignment(assignment),
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
      const user = req.user;
      const assignment = await Assignment.findById(req.params.id).lean();

      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      // Verify classroom access
      const classroom = await Classroom.findById(assignment.classroom_id).lean();
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
          error: 'Access denied to this assignment'
        });
      }

      // Hide solution code from students
      const safeAssignment = {
        ...assignment
      };

      if (user.role === 'student' && classroom.faculty_email !== user.email) {
        delete safeAssignment.solution_code;
      }

      res.json({
        success: true,
        assignment: serializeAssignment(safeAssignment)
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
      const user = req.user;
      const assignment = await Assignment.findById(req.params.id);

      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      // Verify permissions
      const classroom = await Classroom.findById(assignment.classroom_id).lean();
      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom faculty can update assignments'
        });
      }

      if (req.body.title !== undefined) assignment.title = req.body.title;
      if (req.body.description !== undefined) assignment.description = req.body.description;
      if (req.body.starter_code !== undefined) assignment.starter_code = req.body.starter_code;
      if (req.body.solution_code !== undefined) assignment.solution_code = req.body.solution_code;
      if (req.body.test_cases !== undefined) assignment.test_cases = mapTestCasesFromRequest(req.body.test_cases);
      if (req.body.difficulty !== undefined) assignment.difficulty = req.body.difficulty;
      if (req.body.max_score !== undefined) assignment.max_score = req.body.max_score;
      if (req.body.time_limit !== undefined) assignment.time_limit = req.body.time_limit;
      if (req.body.memory_limit !== undefined) assignment.memory_limit = req.body.memory_limit;
      if (req.body.due_date !== undefined) assignment.due_date = req.body.due_date;
      if (req.body.auto_grade !== undefined) {
        const nextMetadata = assignment.metadata ? { ...assignment.metadata } : {};
        nextMetadata.auto_grade = req.body.auto_grade;
        assignment.metadata = nextMetadata;
      }

      const updatedAssignment = await assignment.save();

      res.json({
        success: true,
        assignment: serializeAssignment(updatedAssignment),
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
      const user = req.user;
      const assignment = await Assignment.findById(req.params.id);

      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      // Verify permissions
      const classroom = await Classroom.findById(assignment.classroom_id).lean();
      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom faculty can delete assignments'
        });
      }

      await Assignment.deleteOne({ _id: req.params.id });

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

/**
 * POST /api/assignments/:id/assign-to-class
 * Assign assignment to all students in a classroom (faculty only)
 */
router.post('/:id/assign-to-class',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const assignmentId = req.params.id;

      // Get the assignment
      const assignment = await Assignment.findById(assignmentId);
      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      // Get the classroom
      const classroom = await Classroom.findById(assignment.classroom_id);
      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      // Check permissions - only faculty or admin can assign
      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only faculty can assign assignments to students'
        });
      }

      // Update assignment to mark as assigned to all students
      assignment.assigned_to = 'all'; // Mark as assigned to all students in classroom
      assignment.is_assigned = true;
      assignment.assigned_date = new Date();
      assignment.assigned_by = user.email;

      const updatedAssignment = await assignment.save();

      logger.info(`Assignment ${assignment.title} assigned to all students in classroom ${classroom.name} by ${user.email}`);

      res.json({
        success: true,
        assignment: serializeAssignment(updatedAssignment),
        message: `Assignment "${assignment.title}" has been assigned to all ${classroom.student_emails?.length || 0} students in the classroom`,
        students_count: classroom.student_emails?.length || 0
      });

    } catch (error) {
      logger.error('Assign assignment error:', error);
      res.status(500).json({
        error: 'Failed to assign assignment',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/assignments/classroom/:classroomId/assigned
 * Get assignments assigned to current student in a classroom
 */
router.get('/classroom/:classroomId/assigned',
  validateParams({ classroomId: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroomId = req.params.classroomId;

      // Verify classroom access
      const classroom = await Classroom.findById(classroomId).lean();
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

      // Get assigned assignments for this classroom
      const assignments = await Assignment.find({
        classroom_id: classroomId,
        is_assigned: true,
        is_published: true
      })
        .sort({ assigned_date: -1 })
        .lean();

      const serializedAssignments = assignments.map((assignment) => ({
        ...assignment,
        id: assignment._id?.toString()
      }));

      res.json({
        success: true,
        assignments: serializedAssignments
      });

    } catch (error) {
      logger.error('Get assigned assignments error:', error);
      res.status(500).json({
        error: 'Failed to fetch assigned assignments',
        message: error.message
      });
    }
  })
);

export default router;