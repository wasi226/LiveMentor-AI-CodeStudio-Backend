/**
 * Analytics Routes
 * Handles student performance analytics and reporting
 */

import express from 'express';
import { base44 } from '../services/base44.js';
import { validateBody, validateQuery, validateParams, schemas } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../utils/logger.js';
import Joi from 'joi';

const router = express.Router();

// Analytics validation schemas
const analyticsSchemas = {
  getPerformance: Joi.object({
    classroom_id: Joi.string().optional(),
    student_email: Joi.string().email().optional(),
    period: Joi.string().valid('week', 'month', 'semester', 'all').default('month'),
    start_date: Joi.date().iso().optional(),
    end_date: Joi.date().iso().optional(),
    metrics: Joi.array().items(
      Joi.string().valid(
        'submissions', 'scores', 'completion_rate', 'error_rate', 
        'time_spent', 'help_requests', 'concept_progress'
      )
    ).default(['submissions', 'scores', 'completion_rate'])
  }),

  getClassroomStats: Joi.object({
    classroom_id: Joi.string().required(),
    include_individual: Joi.boolean().default(false)
  })
};

/**
 * GET /api/analytics/performance
 * Get student performance analytics
 */
router.get('/performance',
  validateQuery(analyticsSchemas.getPerformance),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { classroom_id, student_email, period, start_date, end_date, metrics } = req.query;

      // Determine target student email
      let targetStudentEmail = student_email;
      
      if (user.role === 'student') {
        // Students can only view their own analytics
        targetStudentEmail = user.email;
      } else if (!targetStudentEmail) {
        // Faculty without specifying student gets classroom aggregate
        targetStudentEmail = null;
      }

      // Verify permissions for classroom access
      if (classroom_id) {
        const classroom = await base44.database.entity.findById('Classroom', classroom_id);
        if (!classroom) {
          return res.status(404).json({
            error: 'Classroom not found'
          });
        }

        if (user.role === 'faculty' && classroom.faculty_email !== user.email) {
          return res.status(403).json({
            error: 'Access denied to this classroom'
          });
        }

        if (user.role === 'student' && !classroom.student_emails.includes(user.email)) {
          return res.status(403).json({
            error: 'Access denied to this classroom'
          });
        }
      }

      // Calculate date range
      const dateRange = calculateDateRange(period, start_date, end_date);
      
      // Get performance data
      const performanceData = await calculatePerformanceMetrics({
        student_email: targetStudentEmail,
        classroom_id,
        dateRange,
        metrics
      });

      res.json({
        success: true,
        analytics: performanceData,
        period,
        date_range: dateRange,
        requested_metrics: metrics
      });

    } catch (error) {
      logger.error('Get performance analytics error:', error);
      res.status(500).json({
        error: 'Failed to fetch performance analytics',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/analytics/classroom/:id
 * Get classroom-wide analytics (faculty only)
 */
router.get('/classroom/:id',
  validateParams({ id: schemas.objectId }),
  validateQuery(analyticsSchemas.getClassroomStats),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { include_individual } = req.query;

      const classroom = await base44.database.entity.findById('Classroom', req.params.id);
      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      // Only faculty and admin can access classroom analytics
      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only faculty can access classroom analytics'
        });
      }

      const classroomStats = await calculateClassroomStatistics(req.params.id, include_individual);

      res.json({
        success: true,
        classroom_analytics: classroomStats,
        classroom_info: {
          id: classroom.id,
          name: classroom.name,
          student_count: classroom.student_emails.length,
          language: classroom.language
        }
      });

    } catch (error) {
      logger.error('Get classroom analytics error:', error);
      res.status(500).json({
        error: 'Failed to fetch classroom analytics',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/analytics/student-progress
 * Get detailed student progress tracking
 */
router.get('/student-progress',
  validateQuery({
    student_email: Joi.string().email().optional(),
    classroom_id: Joi.string().optional(),
    concept: Joi.string().optional()
  }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { student_email, classroom_id, concept } = req.query;

      let targetStudentEmail = student_email;
      
      if (user.role === 'student') {
        targetStudentEmail = user.email;
      }

      if (!targetStudentEmail) {
        return res.status(400).json({
          error: 'Student email is required'
        });
      }

      // Verify permissions
      if (user.role === 'faculty' && classroom_id) {
        const classroom = await base44.database.entity.findById('Classroom', classroom_id);
        if (classroom.faculty_email !== user.email) {
          return res.status(403).json({
            error: 'Access denied to this classroom'
          });
        }
      }

      const progressData = await calculateStudentProgress({
        student_email: targetStudentEmail,
        classroom_id,
        concept
      });

      res.json({
        success: true,
        student_progress: progressData,
        student_email: targetStudentEmail
      });

    } catch (error) {
      logger.error('Get student progress error:', error);
      res.status(500).json({
        error: 'Failed to fetch student progress',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/analytics/trends
 * Get performance trends over time
 */
router.get('/trends',
  validateQuery({
    classroom_id: Joi.string().optional(),
    metric: Joi.string().valid('scores', 'submissions', 'errors', 'completion_time').default('scores'),
    granularity: Joi.string().valid('daily', 'weekly', 'monthly').default('weekly'),
    period_days: Joi.number().integer().min(7).max(365).default(30)
  }),
  asyncHandler(async (req, res) => {
    try {
      const user = await base44.auth.me();
      const { classroom_id, metric, granularity, period_days } = req.query;

      // Verify classroom access if specified
      if (classroom_id) {
        const classroom = await base44.database.entity.findById('Classroom', classroom_id);
        if (!classroom) {
          return res.status(404).json({
            error: 'Classroom not found'
          });
        }

        if (user.role === 'faculty' && classroom.faculty_email !== user.email) {
          return res.status(403).json({
            error: 'Access denied to this classroom'
          });
        }

        if (user.role === 'student' && !classroom.student_emails.includes(user.email)) {
          return res.status(403).json({
            error: 'Access denied to this classroom'
          });
        }
      }

      const trendData = await calculateTrends({
        classroom_id,
        student_email: user.role === 'student' ? user.email : null,
        metric,
        granularity,
        period_days
      });

      res.json({
        success: true,
        trends: trendData,
        metric,
        granularity,
        period_days
      });

    } catch (error) {
      logger.error('Get trends error:', error);
      res.status(500).json({
        error: 'Failed to fetch trends',
        message: error.message
      });
    }
  })
);

/**
 * Helper function to calculate date range based on period
 */
const calculateDateRange = (period, startDate, endDate) => {
  if (startDate && endDate) {
    return { start: new Date(startDate), end: new Date(endDate) };
  }

  const now = new Date();
  const ranges = {
    week: { days: 7 },
    month: { days: 30 },
    semester: { days: 120 },
    all: { days: 365 }
  };

  const range = ranges[period] || ranges.month;
  const start = new Date(now.getTime() - (range.days * 24 * 60 * 60 * 1000));

  return { start, end: now };
};

/**
 * Calculate performance metrics for a student
 */
const calculatePerformanceMetrics = async ({ student_email, classroom_id, dateRange, metrics }) => {
  try {
    // Build query for submissions
    let submissionQuery = {
      created_at: {
        $gte: dateRange.start.toISOString(),
        $lte: dateRange.end.toISOString()
      }
    };

    if (student_email) submissionQuery.student_email = student_email;
    if (classroom_id) submissionQuery.classroom_id = classroom_id;

    const submissions = await base44.database.entity.find('Submission', submissionQuery);
    
    const performanceData = {
      total_submissions: submissions.length,
      graded_submissions: submissions.filter(s => s.status === 'graded').length,
      average_score: 0,
      completion_rate: 0,
      error_rate: 0,
      concepts_progress: {}
    };

    if (submissions.length > 0) {
      // Calculate average score
      const scoredSubmissions = submissions.filter(s => s.score !== undefined && s.score !== null);
      if (scoredSubmissions.length > 0) {
        performanceData.average_score = scoredSubmissions.reduce((sum, s) => sum + s.score, 0) / scoredSubmissions.length;
      }

      // Calculate completion rate
      const completedSubmissions = submissions.filter(s => s.status === 'graded' || s.status === 'returned');
      performanceData.completion_rate = (completedSubmissions.length / submissions.length) * 100;

      // Calculate error rate
      const errorSubmissions = submissions.filter(s => s.error_message);
      performanceData.error_rate = (errorSubmissions.length / submissions.length) * 100;
    }

    return performanceData;

  } catch (error) {
    logger.error('Calculate performance metrics error:', error);
    throw error;
  }
};

/**
 * Calculate classroom-wide statistics
 */
const calculateClassroomStatistics = async (classroomId, includeIndividual) => {
  try {
    const classroom = await base44.database.entity.findById('Classroom', classroomId);
    const assignments = await base44.database.entity.find('Assignment', { classroom_id: classroomId });
    const submissions = await base44.database.entity.find('Submission', { classroom_id: classroomId });

    const stats = {
      total_students: classroom.student_emails.length,
      total_assignments: assignments.length,
      total_submissions: submissions.length,
      average_class_score: 0,
      completion_statistics: {},
      difficulty_breakdown: {
        easy: assignments.filter(a => a.difficulty === 'easy').length,
        medium: assignments.filter(a => a.difficulty === 'medium').length,
        hard: assignments.filter(a => a.difficulty === 'hard').length
      }
    };

    // Calculate average class score
    const gradedSubmissions = submissions.filter(s => s.score !== undefined && s.score !== null);
    if (gradedSubmissions.length > 0) {
      stats.average_class_score = gradedSubmissions.reduce((sum, s) => sum + s.score, 0) / gradedSubmissions.length;
    }

    // Individual student stats if requested
    if (includeIndividual) {
      stats.individual_performance = {};
      
      for (const studentEmail of classroom.student_emails) {
        const studentSubmissions = submissions.filter(s => s.student_email === studentEmail);
        const studentGradedSubmissions = studentSubmissions.filter(s => s.score !== undefined);
        
        stats.individual_performance[studentEmail] = {
          submissions: studentSubmissions.length,
          average_score: studentGradedSubmissions.length > 0 
            ? studentGradedSubmissions.reduce((sum, s) => sum + s.score, 0) / studentGradedSubmissions.length 
            : 0,
          completion_rate: assignments.length > 0 
            ? (studentSubmissions.filter(s => s.status === 'graded').length / assignments.length) * 100 
            : 0
        };
      }
    }

    return stats;

  } catch (error) {
    logger.error('Calculate classroom statistics error:', error);
    throw error;
  }
};

/**
 * Calculate detailed student progress
 */
const calculateStudentProgress = async ({ student_email, classroom_id, concept }) => {
  try {
    const progress = {
      overall_progress: 0,
      concept_mastery: {},
      recent_activity: [],
      improvement_areas: []
    };

    // This would implement detailed progress tracking
    // For now, return basic structure
    return progress;

  } catch (error) {
    logger.error('Calculate student progress error:', error);
    throw error;
  }
};

/**
 * Calculate performance trends over time
 */
const calculateTrends = async ({ classroom_id, student_email, metric, granularity, period_days }) => {
  try {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (period_days * 24 * 60 * 60 * 1000));

    const trends = {
      data_points: [],
      trend_direction: 'stable',
      percentage_change: 0,
      period: { start: startDate, end: endDate }
    };

    // This would implement trend calculation logic
    // For now, return basic structure
    return trends;

  } catch (error) {
    logger.error('Calculate trends error:', error);
    throw error;
  }
};

export default router;