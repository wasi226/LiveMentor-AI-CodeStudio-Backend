/**
 * Admin Routes
 * Provides privileged data management operations for admin users.
 */

import express from 'express';
import Joi from 'joi';
import {
  Assignment,
  ChatMessage,
  Classroom,
  InterventionRoom,
  StudentActivity,
  Submission,
  User
} from '../models/index.js';
import { validateBody, validateParams, schemas } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../utils/logger.js';

const router = express.Router();

const toIdVariants = (id) => {
  if (!id) {
    return [];
  }

  return [id, String(id)];
};

const purgeSchema = Joi.object({
  confirm: Joi.string().valid('DELETE_ALL_ACTIVITY').required(),
  removeUsers: Joi.boolean().default(true),
  removeClassrooms: Joi.boolean().default(true),
  removeAssignments: Joi.boolean().default(true),
  removeSubmissions: Joi.boolean().default(true),
  removeChatMessages: Joi.boolean().default(true),
  removeActivities: Joi.boolean().default(true),
  removeInterventions: Joi.boolean().default(true),
  keepAdminAccounts: Joi.boolean().default(true)
});

const ensureAdmin = (req, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Admin access required'
    });
    return false;
  }

  return true;
};

const deleteClassroomDependencies = async (classroomIds) => {
  if (!classroomIds.length) {
    return {
      assignments: 0,
      submissions: 0,
      chatMessages: 0,
      activities: 0,
      interventions: 0
    };
  }

  const classroomIdVariants = classroomIds.flatMap((id) => toIdVariants(id));

  const [assignmentsDeleted, submissionsDeleted, chatDeleted, activitiesDeleted, interventionsDeleted] = await Promise.all([
    Assignment.deleteMany({ classroom_id: { $in: classroomIdVariants } }),
    Submission.deleteMany({ classroom_id: { $in: classroomIdVariants } }),
    ChatMessage.deleteMany({ classroom_id: { $in: classroomIdVariants } }),
    StudentActivity.deleteMany({ classroom_id: { $in: classroomIdVariants } }),
    InterventionRoom.deleteMany({ classroom_id: { $in: classroomIdVariants } })
  ]);

  return {
    assignments: assignmentsDeleted.deletedCount || 0,
    submissions: submissionsDeleted.deletedCount || 0,
    chatMessages: chatDeleted.deletedCount || 0,
    activities: activitiesDeleted.deletedCount || 0,
    interventions: interventionsDeleted.deletedCount || 0
  };
};

const deleteAssignmentsWithSubmissions = async (assignmentIds) => {
  if (!assignmentIds.length) {
    return {
      assignments: 0,
      submissions: 0
    };
  }

  const assignmentIdVariants = assignmentIds.flatMap((id) => toIdVariants(id));

  const [submissionsDeleted, assignmentsDeleted] = await Promise.all([
    Submission.deleteMany({ assignment_id: { $in: assignmentIdVariants } }),
    Assignment.deleteMany({ _id: { $in: assignmentIds } })
  ]);

  return {
    assignments: assignmentsDeleted.deletedCount || 0,
    submissions: submissionsDeleted.deletedCount || 0
  };
};

/**
 * GET /api/admin/summary
 * Quick counts for admin control panel.
 */
router.get('/summary', asyncHandler(async (req, res) => {
  if (!ensureAdmin(req, res)) {
    return;
  }

  const [users, classrooms, assignments, submissions, chatMessages, activities, interventions] = await Promise.all([
    User.countDocuments(),
    Classroom.countDocuments(),
    Assignment.countDocuments(),
    Submission.countDocuments(),
    ChatMessage.countDocuments(),
    StudentActivity.countDocuments(),
    InterventionRoom.countDocuments()
  ]);

  res.json({
    success: true,
    counts: {
      users,
      classrooms,
      assignments,
      submissions,
      chatMessages,
      activities,
      interventions
    }
  });
}));

/**
 * GET /api/admin/users
 * Get users for admin management.
 */
router.get('/users', asyncHandler(async (req, res) => {
  if (!ensureAdmin(req, res)) {
    return;
  }

  const users = await User.find(
    {},
    {
      password: 0,
      __v: 0
    }
  )
    .sort({ createdAt: -1 })
    .lean();

  res.json({
    success: true,
    users: users.map((user) => ({
      ...user,
      id: user._id?.toString() || user.id
    }))
  });
}));

/**
 * DELETE /api/admin/users/:id
 * Remove a user and cleanup related data.
 */
router.delete('/users/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    if (!ensureAdmin(req, res)) {
      return;
    }

    const targetUser = await User.findById(req.params.id).lean();
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    if (String(targetUser.email).toLowerCase() === String(req.user.email).toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid operation',
        message: 'Admin cannot delete own account'
      });
    }

    if (targetUser.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Invalid operation',
          message: 'Cannot delete the last admin account'
        });
      }
    }

    const userEmail = String(targetUser.email || '').toLowerCase();

    // Remove student from enrollments.
    await Classroom.updateMany(
      { student_emails: userEmail },
      { $pull: { student_emails: userEmail } }
    );

    // Remove all data tied to the user as student.
    await Promise.all([
      Submission.deleteMany({ student_email: userEmail }),
      ChatMessage.deleteMany({ sender_email: userEmail }),
      StudentActivity.deleteMany({ sender_email: userEmail }),
      InterventionRoom.deleteMany({ student_email: userEmail })
    ]);

    // If user is faculty, delete all their classrooms and dependent records.
    const facultyClassrooms = await Classroom.find({ faculty_email: userEmail }, { _id: 1 }).lean();
    const facultyClassroomIds = facultyClassrooms.map((item) => item._id);

    const classroomDependencyResult = await deleteClassroomDependencies(facultyClassroomIds);

    let deletedClassrooms = 0;
    if (facultyClassroomIds.length) {
      const classroomDeleteResult = await Classroom.deleteMany({ _id: { $in: facultyClassroomIds } });
      deletedClassrooms = classroomDeleteResult.deletedCount || 0;
    }

    // Remove assignments created by this user and associated submissions.
    const ownedAssignments = await Assignment.find({ created_by: userEmail }, { _id: 1 }).lean();
    const ownedAssignmentIds = ownedAssignments.map((item) => item._id);
    const ownedAssignmentDeleteResult = await deleteAssignmentsWithSubmissions(ownedAssignmentIds);

    const deletedUserResult = await User.deleteOne({ _id: targetUser._id });

    logger.info(`Admin ${req.user.email} deleted user ${targetUser.email} (${targetUser.role})`);

    res.json({
      success: true,
      message: 'User and related activity removed successfully',
      deleted: {
        users: deletedUserResult.deletedCount || 0,
        classrooms: deletedClassrooms,
        assignments: classroomDependencyResult.assignments + ownedAssignmentDeleteResult.assignments,
        submissions: classroomDependencyResult.submissions + ownedAssignmentDeleteResult.submissions,
        chatMessages: classroomDependencyResult.chatMessages,
        activities: classroomDependencyResult.activities,
        interventions: classroomDependencyResult.interventions
      }
    });
  })
);

/**
 * DELETE /api/admin/classrooms/:id
 * Remove a classroom and all dependent classroom activity.
 */
router.delete('/classrooms/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    if (!ensureAdmin(req, res)) {
      return;
    }

    const classroom = await Classroom.findById(req.params.id).lean();
    if (!classroom) {
      return res.status(404).json({
        success: false,
        error: 'Classroom not found'
      });
    }

    const dependencyDeleteResult = await deleteClassroomDependencies([classroom._id]);
    const classroomDeleteResult = await Classroom.deleteOne({ _id: classroom._id });

    logger.info(`Admin ${req.user.email} deleted classroom ${classroom._id}`);

    res.json({
      success: true,
      message: 'Classroom and related activity removed successfully',
      deleted: {
        classrooms: classroomDeleteResult.deletedCount || 0,
        assignments: dependencyDeleteResult.assignments,
        submissions: dependencyDeleteResult.submissions,
        chatMessages: dependencyDeleteResult.chatMessages,
        activities: dependencyDeleteResult.activities,
        interventions: dependencyDeleteResult.interventions
      }
    });
  })
);

/**
 * DELETE /api/admin/assignments/:id
 * Remove assignment and all related submissions.
 */
router.delete('/assignments/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    if (!ensureAdmin(req, res)) {
      return;
    }

    const assignment = await Assignment.findById(req.params.id).lean();
    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: 'Assignment not found'
      });
    }

    const assignmentDeleteResult = await deleteAssignmentsWithSubmissions([assignment._id]);

    logger.info(`Admin ${req.user.email} deleted assignment ${assignment._id}`);

    res.json({
      success: true,
      message: 'Assignment and related submissions removed successfully',
      deleted: assignmentDeleteResult
    });
  })
);

/**
 * POST /api/admin/purge
 * Purge platform activity and optionally non-admin users.
 */
router.post('/purge',
  validateBody(purgeSchema),
  asyncHandler(async (req, res) => {
    if (!ensureAdmin(req, res)) {
      return;
    }

    const {
      removeUsers,
      removeClassrooms,
      removeAssignments,
      removeSubmissions,
      removeChatMessages,
      removeActivities,
      removeInterventions,
      keepAdminAccounts
    } = req.body;

    const result = {
      users: 0,
      classrooms: 0,
      assignments: 0,
      submissions: 0,
      chatMessages: 0,
      activities: 0,
      interventions: 0
    };

    if (removeInterventions) {
      const deleted = await InterventionRoom.deleteMany({});
      result.interventions = deleted.deletedCount || 0;
    }

    if (removeActivities) {
      const deleted = await StudentActivity.deleteMany({});
      result.activities = deleted.deletedCount || 0;
    }

    if (removeChatMessages) {
      const deleted = await ChatMessage.deleteMany({});
      result.chatMessages = deleted.deletedCount || 0;
    }

    if (removeSubmissions) {
      const deleted = await Submission.deleteMany({});
      result.submissions = deleted.deletedCount || 0;
    }

    if (removeAssignments) {
      const deleted = await Assignment.deleteMany({});
      result.assignments = deleted.deletedCount || 0;
    }

    if (removeClassrooms) {
      const deleted = await Classroom.deleteMany({});
      result.classrooms = deleted.deletedCount || 0;
    }

    if (removeUsers) {
      const userFilter = keepAdminAccounts
        ? { role: { $ne: 'admin' } }
        : {};
      const deleted = await User.deleteMany(userFilter);
      result.users = deleted.deletedCount || 0;
    }

    logger.warn(`Admin ${req.user.email} executed purge`, result);

    res.json({
      success: true,
      message: 'Admin purge completed successfully',
      deleted: result
    });
  })
);

export default router;
