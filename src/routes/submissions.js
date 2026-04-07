/**
 * Submission Routes
 * Handles assignment submission operations
 */

import express from 'express';
import { Assignment, Classroom, Submission } from '../models/index.js';
import { validateBody, validateQuery, validateParams, schemas } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../utils/logger.js';
import Joi from 'joi';

const router = express.Router();

const emitSubmissionEvent = (eventName, submission) => {
  const socketServer = globalThis.__socketIO;

  if (!socketServer || !submission?.classroom_id) {
    return;
  }

  socketServer.to(String(submission.classroom_id)).emit(eventName, {
    classroomId: String(submission.classroom_id),
    submissionId: submission.id || submission._id?.toString(),
    studentEmail: submission.student_email,
    status: submission.status,
    score: submission.score,
    createdAt: submission.created_at || submission.createdAt || new Date().toISOString(),
    updatedAt: submission.updated_at || submission.updatedAt || new Date().toISOString()
  });
};

// Submission validation schemas
const submissionSchemas = {
  create: Joi.object({
    assignment_id: Joi.string().required(),
    classroom_id: Joi.string().required(),
    code: Joi.string().max(50000).required(),
    language: schemas.language.required()
  }),

  update: Joi.object({
    code: Joi.string().max(50000),
    language: schemas.language,
    status: Joi.string().valid('draft', 'submitted', 'grading', 'graded', 'returned')
  }).min(1)
};

/**
 * GET /api/submissions
 * Get submissions for a user or assignment
 */
router.get('/',
  validateQuery(Joi.object({
    assignment_id: Joi.string().optional(),
    classroom_id: Joi.string().optional(),
    student_email: Joi.string().email().optional(),
    status: Joi.string().valid('draft', 'submitted', 'grading', 'graded', 'returned').optional(),
  }).concat(schemas.pagination)),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { assignment_id, classroom_id, student_email, status, page, limit, sort, sortBy } = req.query;

      // Build query based on user role and filters
      let query = {};
      
      if (user.role === 'student') {
        // Students can only see their own submissions
        query.student_email = user.email;
      } else if (user.role === 'faculty') {
        // Faculty can see submissions in their classrooms
        if (classroom_id) {
          const classroom = await base44.database.entity.findById('Classroom', classroom_id);
          if (!classroom?.faculty_email || classroom.faculty_email !== user.email) {
            return res.status(403).json({
              error: 'Access denied to this classroom'
            });
          }
          query.classroom_id = classroom_id;
        }
        
        if (student_email) {
          query.student_email = student_email;
        }
      }
      // Admin can see all submissions

      if (assignment_id) query.assignment_id = assignment_id;
      if (status) query.status = status;

      const submissions = await base44.database.entity.find('Submission', query, {
        page,
        limit,
        sort: { [sortBy]: sort === 'asc' ? 1 : -1 }
      });

      res.json({
        success: true,
        submissions,
        pagination: {
          page: Number.parseInt(page, 10),
          limit: Number.parseInt(limit, 10),
          total: submissions.length
        }
      });

    } catch (error) {
      logger.error('Get submissions error:', error);
      res.status(500).json({
        error: 'Failed to fetch submissions',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/submissions
 * Create new submission
 */
router.post('/',
  validateBody(submissionSchemas.create),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      
      // Verify assignment exists and user has access
      const assignment = await Assignment.findById(req.body.assignment_id).lean();
      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      // Verify classroom access
      const classroom = await Classroom.findById(req.body.classroom_id).lean();
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

      // Check if assignment is past due
      if (assignment.due_date && new Date(assignment.due_date) < new Date()) {
        return res.status(400).json({
          error: 'Assignment submission deadline has passed'
        });
      }

      const submissionData = {
        assignment_id: req.body.assignment_id,
        classroom_id: req.body.classroom_id,
        code: req.body.code,
        language: req.body.language,
        student_email: user.email,
        status: 'draft',
        score: 0,
        submitted_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const submission = await Submission.create(submissionData);
      const serializedSubmission = {
        ...submission.toObject(),
        id: submission._id.toString()
      };

      res.status(201).json({
        success: true,
        submission: serializedSubmission,
        message: 'Submission created successfully'
      });

      emitSubmissionEvent('submission:created', serializedSubmission);

      logger.info(`Submission created for assignment ${assignment.title} by ${user.email}`);

    } catch (error) {
      logger.error('Create submission error:', error);
      res.status(500).json({
        error: 'Failed to create submission',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/submissions/:id
 * Get specific submission
 */
router.get('/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const submission = await base44.database.entity.findById('Submission', req.params.id);

      if (!submission) {
        return res.status(404).json({
          error: 'Submission not found'
        });
      }

      // Check access permissions
      const classroom = await base44.database.entity.findById('Classroom', submission.classroom_id);
      const hasAccess = 
        submission.student_email === user.email ||
        classroom.faculty_email === user.email ||
        user.role === 'admin';

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this submission'
        });
      }

      res.json({
        success: true,
        submission
      });

    } catch (error) {
      logger.error('Get submission error:', error);
      res.status(500).json({
        error: 'Failed to fetch submission',
        message: error.message
      });
    }
  })
);

/**
 * PUT /api/submissions/:id
 * Update submission
 */
router.put('/:id',
  validateParams({ id: schemas.objectId }),
  validateBody(submissionSchemas.update),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const submission = await base44.database.entity.findById('Submission', req.params.id);

      if (!submission) {
        return res.status(404).json({
          error: 'Submission not found'
        });
      }

      // Students can only update their own draft submissions
      // Faculty can update status for grading
      let canUpdate = false;
      
      if (user.role === 'student' && submission.student_email === user.email && submission.status === 'draft') {
        canUpdate = true;
        // Students can't change status
        delete req.body.status;
      } else if (user.role === 'faculty' || user.role === 'admin') {
        const classroom = await base44.database.entity.findById('Classroom', submission.classroom_id);
        if (classroom.faculty_email === user.email || user.role === 'admin') {
          canUpdate = true;
        }
      }

      if (!canUpdate) {
        return res.status(403).json({
          error: 'Cannot update this submission'
        });
      }

      const updatedSubmission = await base44.database.entity.update('Submission', req.params.id, {
        ...req.body,
        updated_at: new Date().toISOString()
      });

      res.json({
        success: true,
        submission: updatedSubmission,
        message: 'Submission updated successfully'
      });

    } catch (error) {
      logger.error('Update submission error:', error);
      res.status(500).json({
        error: 'Failed to update submission',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/submissions/:id/submit
 * Submit a draft for grading
 */
router.post('/:id/submit',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const submission = await Submission.findById(req.params.id);

      if (!submission) {
        return res.status(404).json({
          error: 'Submission not found'
        });
      }

      // Only submission owner can submit
      if (submission.student_email !== user.email) {
        return res.status(403).json({
          error: 'Can only submit your own work'
        });
      }

      if (submission.status !== 'draft') {
        return res.status(400).json({
          error: 'Only draft submissions can be submitted'
        });
      }

      // Check assignment deadline
      const assignment = await Assignment.findById(submission.assignment_id).lean();
      if (!assignment) {
        return res.status(404).json({
          error: 'Assignment not found'
        });
      }

      if (assignment.due_date && new Date(assignment.due_date) < new Date()) {
        return res.status(400).json({
          error: 'Assignment submission deadline has passed'
        });
      }

      submission.status = assignment.auto_grade ? 'grading' : 'submitted';
      submission.submitted_at = new Date();
      submission.updated_at = new Date();
      await submission.save();

      const updatedSubmission = {
        ...submission.toObject(),
        id: submission._id.toString()
      };

      res.json({
        success: true,
        submission: updatedSubmission,
        message: 'Submission submitted successfully'
      });

      emitSubmissionEvent('submission:updated', updatedSubmission);

      if (assignment.auto_grade) {
        logger.info(`Auto-grading triggered for submission ${req.params.id}`);
        // This would integrate with the code execution service
      }

    } catch (error) {
      logger.error('Submit submission error:', error);
      res.status(500).json({
        error: 'Failed to submit submission',
        message: error.message
      });
    }
  })
);

/**
 * DELETE /api/submissions/:id
 * Delete submission (students can delete drafts, faculty can delete any)
 */
router.delete('/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const submission = await base44.database.entity.findById('Submission', req.params.id);

      if (!submission) {
        return res.status(404).json({
          error: 'Submission not found'
        });
      }

      // Check permissions
      let canDelete = false;
      
      if (user.role === 'student' && submission.student_email === user.email && submission.status === 'draft') {
        canDelete = true;
      } else if (user.role === 'faculty' || user.role === 'admin') {
        const classroom = await base44.database.entity.findById('Classroom', submission.classroom_id);
        if (classroom.faculty_email === user.email || user.role === 'admin') {
          canDelete = true;
        }
      }

      if (!canDelete) {
        return res.status(403).json({
          error: 'Cannot delete this submission'
        });
      }

      await base44.database.entity.delete('Submission', req.params.id);

      emitSubmissionEvent('submission:updated', {
        ...submission,
        status: 'deleted'
      });

      res.json({
        success: true,
        message: 'Submission deleted successfully'
      });

      logger.info(`Submission deleted: ${req.params.id} by ${user.email}`);

    } catch (error) {
      logger.error('Delete submission error:', error);
      res.status(500).json({
        error: 'Failed to delete submission',
        message: error.message
      });
    }
  })
);

export default router;