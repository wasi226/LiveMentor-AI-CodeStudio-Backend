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
import { executeCode } from '../services/codeExecution.js';
import { evaluateSubmissionWithAI } from '../services/aiGrading.js';

const router = express.Router();
const SUBMISSION_RETENTION_HOURS = 48;
const SUBMISSION_RETENTION_MS = SUBMISSION_RETENTION_HOURS * 60 * 60 * 1000;
const FINAL_SUBMISSION_STATUSES = new Set(['submitted', 'grading', 'graded', 'returned', 'running', 'passed', 'failed', 'error']);

const getSubmissionArchiveAfter = (submission) => {
  const archiveAfter = submission?.archive_after || submission?.archiveAfter;
  if (archiveAfter) {
    const parsedArchiveAfter = new Date(archiveAfter);
    if (!Number.isNaN(parsedArchiveAfter.getTime())) {
      return parsedArchiveAfter;
    }
  }

  const submittedAt = submission?.submitted_at || submission?.submittedAt;
  if (!submittedAt) {
    return null;
  }

  const parsedSubmittedAt = new Date(submittedAt);
  if (Number.isNaN(parsedSubmittedAt.getTime())) {
    return null;
  }

  return new Date(parsedSubmittedAt.getTime() + SUBMISSION_RETENTION_MS);
};

const isSubmissionActive = (submission, now = new Date()) => {
  const status = String(submission?.status || '').toLowerCase();

  if (status === 'draft') {
    return true;
  }

  if (!FINAL_SUBMISSION_STATUSES.has(status)) {
    return false;
  }

  const archiveAfter = getSubmissionArchiveAfter(submission);
  if (!archiveAfter) {
    return true;
  }

  return archiveAfter.getTime() > now.getTime();
};

const normalizeSubmissionForResponse = (submission) => {
  const archivedAt = submission?.archived_at || submission?.archivedAt || null;
  const archiveAfter = getSubmissionArchiveAfter(submission);

  return {
    ...submission,
    id: submission.id || submission._id?.toString(),
    archive_after: archiveAfter,
    archived_at: archivedAt ? new Date(archivedAt) : null,
    is_archived: Boolean(archivedAt) || Boolean(archiveAfter && archiveAfter.getTime() <= Date.now())
  };
};

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

const normalizeTestCases = (testCases = []) => {
  return testCases.map((testCase) => ({
    input: testCase.input || '',
    expectedOutput: testCase.expected_output || testCase.expectedOutput || '',
    description: testCase.description || '',
    weight: Number(testCase.weight) || 1
  }));
};

const getLetterGrade = (percentage) => {
  if (percentage >= 90) return 'A+';
  if (percentage >= 80) return 'A';
  if (percentage >= 70) return 'B';
  if (percentage >= 60) return 'C';
  if (percentage >= 40) return 'D';
  return 'F';
};

const getPerformanceCategory = (percentage) => {
  if (percentage >= 75) return 'strong';
  if (percentage >= 40) return 'average';
  return 'weak';
};

const gradeSubmission = async ({ code, language, assignment }) => {
  const testCases = normalizeTestCases(assignment?.test_cases || []);
  const executionResult = await executeCode({
    code,
    language,
    testCases
  });

  const hasTestCases = testCases.length > 0;
  const maxScore = Number(assignment?.max_score) || 100;
  let score = 0;
  let gradingRule = hasTestCases ? 'legacy' : 'no-test-cases';
  let aiEvaluation = null;

  if (hasTestCases) {
    const totalTests = Number(executionResult.totalTests) || testCases.length;
    const passedTests = Number(executionResult.passedTests) || 0;
    const allTestsPassed = totalTests > 0 && passedTests === totalTests;
    const anyRuntimeOrCompileError = (executionResult.testResults || []).some((testResult) => {
      const testStatus = String(testResult?.status || '').toLowerCase();
      return Boolean(testResult?.error) || (testStatus && testStatus !== 'completed');
    });

    if (allTestsPassed) {
      score = maxScore;
      gradingRule = 'all-tests-passed';
    } else {
      aiEvaluation = await evaluateSubmissionWithAI({
        assignment,
        code,
        language,
        executionResult
      });

      if (aiEvaluation) {
        const aiBasedScore = Math.round((aiEvaluation.scorePercentage * maxScore) / 100);
        const minimumScoreForMismatch = anyRuntimeOrCompileError ? 0 : Math.round(maxScore * 0.4);

        score = Math.max(minimumScoreForMismatch, aiBasedScore);
        gradingRule = anyRuntimeOrCompileError ? 'ai-validated-after-execution-error' : 'ai-validated-tests-mismatch';
      } else {
        // Deterministic fallback: never force 0 for non-empty submissions when AI is unavailable.
        score = Math.round(maxScore * 0.4);
        gradingRule = anyRuntimeOrCompileError ? 'fallback-partial-after-execution-error' : 'tests-mismatch-executable';
      }
    }
  } else {
    score = executionResult.success ? maxScore : 0;
    gradingRule = executionResult.success ? 'no-tests-success' : 'no-tests-failure';
  }

  const normalizedScore = Math.max(0, Math.min(maxScore, score));
  const percentageScore = maxScore > 0 ? Math.round((normalizedScore / maxScore) * 100) : 0;
  const letterGrade = getLetterGrade(percentageScore);
  const performanceCategory = getPerformanceCategory(percentageScore);

  const feedbackMessage =
    gradingRule === 'all-tests-passed'
      ? 'All test cases passed. Full marks awarded.'
      : gradingRule === 'tests-mismatch-executable'
        ? 'Code executed successfully but outputs did not match all test cases. Partial marks (40%) awarded.'
        : gradingRule === 'ai-validated-tests-mismatch'
          ? 'Tests did not fully match, but AI code evaluation detected substantial correctness. Score awarded based on code quality and logic.'
          : gradingRule === 'ai-validated-after-execution-error'
            ? 'Execution had issues, but AI code evaluation identified correct/partially correct logic. Score awarded based on semantic correctness.'
            : gradingRule === 'fallback-partial-after-execution-error'
            ? 'Execution had issues and AI grading is unavailable. Baseline partial credit awarded to avoid unfair zero for attempted logic.'
        : executionResult.error || executionResult.output || 'Submission graded.';

  return {
    score: normalizedScore,
    status: 'graded',
    test_results: executionResult.testResults || [],
    execution_time: executionResult.executionTime || 0,
    memory_used: executionResult.memoryUsage || 0,
    feedback: feedbackMessage,
    graded_at: new Date(),
    graded_by: 'system',
    grading_details: {
      rule: gradingRule,
      score_percentage: percentageScore,
      letter_grade: letterGrade,
      performance_category: performanceCategory,
      passed_tests: Number(executionResult.passedTests) || 0,
      total_tests: Number(executionResult.totalTests) || testCases.length,
      ai_confidence: aiEvaluation?.confidence || null,
      ai_reason: aiEvaluation?.reason || null
    }
  };
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

const addRetentionWindow = (submission, status = submission?.status) => {
  const normalizedStatus = String(status || submission?.status || '').toLowerCase();
  if (!FINAL_SUBMISSION_STATUSES.has(normalizedStatus)) {
    return submission;
  }

  const now = new Date();
  submission.archive_after = submission.archive_after || new Date(now.getTime() + SUBMISSION_RETENTION_MS);
  submission.archived_at = submission.archived_at || null;
  submission.archive_reason = submission.archive_reason || '48-hour live feed retention';
  return submission;
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
    active_only: Joi.boolean().default(false),
    latest_per_assignment: Joi.boolean().default(false),
  }).concat(schemas.pagination)),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const { assignment_id, classroom_id, student_email, status, active_only, latest_per_assignment, page, limit, sort, sortBy } = req.query;

      // Build query based on user role and filters
      let query = {};
      const normalizedActiveOnly = String(active_only) === 'true';
      const normalizedLatestPerAssignment = String(latest_per_assignment) === 'true';
      const retentionCutoff = new Date(Date.now() - SUBMISSION_RETENTION_MS);
      
      if (user.role === 'student') {
        // Students can only see their own submissions
        query.student_email = user.email;
      } else if (user.role === 'faculty') {
        // Faculty can see submissions in their classrooms
        if (classroom_id) {
          const classroom = await Classroom.findById(classroom_id).lean();
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

      if (normalizedActiveOnly) {
        query.status = query.status || { $ne: 'draft' };

        const activeWindow = {
          $or: [
            { archive_after: { $gt: new Date() } },
            { archive_after: null, submitted_at: { $gte: retentionCutoff } },
            { archive_after: { $exists: false }, submitted_at: { $gte: retentionCutoff } }
          ]
        };

        if (query.$and) {
          query.$and.push(activeWindow);
        } else {
          query.$and = [activeWindow];
        }
      }

      const normalizedPage = Math.max(Number.parseInt(page, 10) || 1, 1);
      const normalizedLimit = Math.max(Number.parseInt(limit, 10) || 20, 1);
      const sortDirection = sort === 'asc' ? 1 : -1;
      const allowedSortFields = new Set(['createdAt', 'updatedAt', 'submitted_at', 'score', 'status']);
      const sortField = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';

      let submissions = [];
      let total = 0;

      if (normalizedLatestPerAssignment) {
        const groupedSubmissions = await Submission.aggregate([
          { $match: query },
          { $sort: { [sortField]: -1, _id: -1 } },
          {
            $group: {
              _id: '$assignment_id',
              submission: { $first: '$$ROOT' }
            }
          },
          { $replaceRoot: { newRoot: '$submission' } },
          { $sort: { [sortField]: sortDirection, _id: sortDirection } },
          { $skip: (normalizedPage - 1) * normalizedLimit },
          { $limit: normalizedLimit }
        ]);

        submissions = groupedSubmissions;
        total = groupedSubmissions.length;
      } else {
        submissions = await Submission.find(query)
          .sort({ [sortField]: sortDirection })
          .skip((normalizedPage - 1) * normalizedLimit)
          .limit(normalizedLimit)
          .lean();

        total = await Submission.countDocuments(query);
      }

      const serializedSubmissions = submissions.map((submission) => normalizeSubmissionForResponse(submission));

      res.json({
        success: true,
        submissions: serializedSubmissions,
        pagination: {
          page: normalizedPage,
          limit: normalizedLimit,
          total
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
        updated_at: new Date().toISOString(),
        archive_after: null,
        archived_at: null,
        archive_reason: null
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
      const user = req.user;
      const submission = await Submission.findById(req.params.id).lean();

      if (!submission) {
        return res.status(404).json({
          error: 'Submission not found'
        });
      }

      // Check access permissions
      const classroom = await Classroom.findById(submission.classroom_id).lean();
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
        submission: {
          ...submission,
          id: submission._id?.toString()
        }
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
      const user = req.user;
      const submission = await Submission.findById(req.params.id);

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
        const classroom = await Classroom.findById(submission.classroom_id).lean();
        if (classroom.faculty_email === user.email || user.role === 'admin') {
          canUpdate = true;
        }
      }

      if (!canUpdate) {
        return res.status(403).json({
          error: 'Cannot update this submission'
        });
      }

      if (req.body.code !== undefined) submission.code = req.body.code;
      if (req.body.language !== undefined) submission.language = req.body.language;
      if (req.body.status !== undefined) submission.status = req.body.status;
      if (FINAL_SUBMISSION_STATUSES.has(String(req.body.status || submission.status || '').toLowerCase())) {
        addRetentionWindow(submission, req.body.status || submission.status);
      }
      submission.updated_at = new Date();

      const updatedSubmission = await submission.save();
      const serializedSubmission = {
        ...updatedSubmission.toObject(),
        id: updatedSubmission._id.toString()
      };

      res.json({
        success: true,
        submission: serializedSubmission,
        message: 'Submission updated successfully'
      });

      emitSubmissionEvent('submission:updated', serializedSubmission);

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

      const shouldAutoGrade = assignment.auto_grade !== false || (assignment.test_cases || []).length > 0;
      let gradingResult = null;

      if (shouldAutoGrade) {
        gradingResult = await gradeSubmission({
          code: submission.code,
          language: submission.language,
          assignment
        });
      }

      submission.status = shouldAutoGrade ? 'grading' : 'submitted';
      submission.submitted_at = new Date();
      submission.updated_at = new Date();
      addRetentionWindow(submission, submission.status);

      if (gradingResult) {
        submission.status = gradingResult.status;
        submission.score = gradingResult.score;
        submission.max_score = Number(assignment.max_score) || submission.max_score || 100;
        submission.test_results = gradingResult.test_results;
        submission.execution_time = gradingResult.execution_time;
        submission.memory_used = gradingResult.memory_used;
        submission.feedback = gradingResult.feedback;
        submission.graded_at = gradingResult.graded_at;
        submission.graded_by = gradingResult.graded_by;

        const nextMetadata = submission.metadata ? { ...submission.metadata } : {};
        nextMetadata.grading_rule = gradingResult.grading_details?.rule;
        nextMetadata.score_percentage = gradingResult.grading_details?.score_percentage;
        nextMetadata.grade = gradingResult.grading_details?.letter_grade;
        nextMetadata.performance_category = gradingResult.grading_details?.performance_category;
        nextMetadata.passed_tests = gradingResult.grading_details?.passed_tests;
        nextMetadata.total_tests = gradingResult.grading_details?.total_tests;
        nextMetadata.ai_confidence = gradingResult.grading_details?.ai_confidence;
        nextMetadata.ai_reason = gradingResult.grading_details?.ai_reason;
        submission.metadata = nextMetadata;
        addRetentionWindow(submission, submission.status);
      }

      await submission.save();

      const updatedSubmission = {
        ...normalizeSubmissionForResponse(submission.toObject())
      };

      res.json({
        success: true,
        submission: updatedSubmission,
        message: 'Submission submitted successfully'
      });

      emitSubmissionEvent('submission:updated', updatedSubmission);

      if (gradingResult) {
        logger.info(`Auto-grading completed for submission ${req.params.id} with score ${gradingResult.score}`);
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
      const user = req.user;
      const submission = await Submission.findById(req.params.id).lean();

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
        const classroom = await Classroom.findById(submission.classroom_id).lean();
        if (classroom.faculty_email === user.email || user.role === 'admin') {
          canDelete = true;
        }
      }

      if (!canDelete) {
        return res.status(403).json({
          error: 'Cannot delete this submission'
        });
      }

      await Submission.deleteOne({ _id: req.params.id });

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