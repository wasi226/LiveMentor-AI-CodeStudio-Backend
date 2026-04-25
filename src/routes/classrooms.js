/**
 * Classroom Routes
 * Handles classroom management operations
 */

import express from 'express';
import Joi from 'joi';
import { Classroom, User, StudentActivity, InterventionRoom } from '../models/index.js';
import { validateBody, validateQuery, validateParams, classroomSchemas, schemas } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getSocketIOServer } from '../services/socketio.js';
import logger from '../utils/logger.js';

const router = express.Router();

const serializeClassroom = (classroom) => {
  const plainClassroom = classroom.toObject ? classroom.toObject({ virtuals: true }) : classroom;

  return {
    ...plainClassroom,
    id: plainClassroom.id || plainClassroom._id?.toString(),
    student_emails: plainClassroom.student_emails || [],
    max_students: plainClassroom.max_students ?? 30,
    created_date: plainClassroom.createdAt ? plainClassroom.createdAt.toISOString() : plainClassroom.created_date,
    updated_date: plainClassroom.updatedAt ? plainClassroom.updatedAt.toISOString() : plainClassroom.updated_date,
    created_at: plainClassroom.createdAt ? plainClassroom.createdAt.toISOString() : plainClassroom.created_at,
    updated_at: plainClassroom.updatedAt ? plainClassroom.updatedAt.toISOString() : plainClassroom.updated_at,
  };
};

const attachStudentDetails = async (classrooms) => {
  const allStudentEmails = classrooms.flatMap((classroom) => classroom.student_emails || []);
  const uniqueStudentEmails = Array.from(new Set(allStudentEmails.filter(Boolean)));

  if (uniqueStudentEmails.length === 0) {
    return classrooms;
  }

  const students = await User.find(
    { email: { $in: uniqueStudentEmails } },
    'email full_name rollNumber role isActive lastLogin'
  ).lean();

  const studentByEmail = new Map(students.map((student) => [student.email, student]));

  return classrooms.map((classroom) => ({
    ...classroom,
    student_details: (classroom.student_emails || []).map((email) => {
      const student = studentByEmail.get(email);

      return {
        email,
        full_name: student?.full_name || email.split('@')[0],
        roll_number: student?.rollNumber || null,
        role: student?.role || 'student',
        is_active: student?.isActive ?? true,
        last_login: student?.lastLogin || null,
      };
    }),
  }));
};

const hasClassroomAccess = (classroom, user) => {
  return (
    user.role === 'admin' ||
    classroom.faculty_email === user.email ||
    classroom.student_emails.includes(user.email)
  );
};

const getCodeStateScope = ({ user, requestedScope }) => {
  if (requestedScope === 'shared') {
    return 'shared';
  }

  if (requestedScope === 'personal') {
    return 'personal';
  }

  return user.role === 'faculty' || user.role === 'admin' ? 'shared' : 'personal';
};

const normalizeCodeState = (state, fallbackLanguage = 'javascript') => {
  if (!state || typeof state !== 'object') {
    return null;
  }

  const code = typeof state.code === 'string' ? state.code : '';
  const language = typeof state.language === 'string' && state.language.trim()
    ? state.language
    : fallbackLanguage;

  return {
    code,
    language,
    updated_at: state.updated_at || null,
    updated_by: state.updated_by || null
  };
};

const getPersonalCodeState = (metadata, email, fallbackLanguage) => {
  const items = Array.isArray(metadata?.user_code_states) ? metadata.user_code_states : [];
  const found = items.find((entry) => String(entry?.email || '').toLowerCase() === String(email || '').toLowerCase());
  return normalizeCodeState(found, fallbackLanguage);
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const isStudentEnrolled = (classroom, studentEmail) => {
  const normalizedEmail = normalizeEmail(studentEmail);
  if (!normalizedEmail) {
    return false;
  }

  return (classroom.student_emails || []).some((email) => normalizeEmail(email) === normalizedEmail);
};

const setPersonalCodeState = (metadata, email, nextState) => {
  const items = Array.isArray(metadata?.user_code_states) ? [...metadata.user_code_states] : [];
  const index = items.findIndex((entry) => String(entry?.email || '').toLowerCase() === String(email || '').toLowerCase());
  const nextEntry = {
    email,
    code: nextState.code,
    language: nextState.language,
    updated_at: nextState.updated_at,
    updated_by: nextState.updated_by
  };

  if (index >= 0) {
    items[index] = nextEntry;
  } else {
    items.push(nextEntry);
  }

  if (metadata && typeof metadata === 'object') {
    const updatedMetadata = { ...metadata };
    updatedMetadata.user_code_states = items;
    return updatedMetadata;
  }

  return {
    user_code_states: items
  };
};

const versionSchemas = {
  create: Joi.object({
    code: Joi.string().max(500000).allow('').required(),
    language: schemas.language.required(),
    version_type: Joi.string().valid('initial', 'auto', 'manual', 'checkpoint', 'submission').default('manual'),
    description: Joi.string().max(300).allow('').default(''),
    related_submission_id: Joi.string().allow('').optional()
  }),
  cleanupQuery: Joi.object({
    user_email: schemas.email.optional(),
    userEmail: schemas.email.optional(),
    max_total_history: Joi.number().integer().min(20).max(1000).optional(),
    maxTotalHistory: Joi.number().integer().min(20).max(1000).optional(),
    max_auto_snapshots: Joi.number().integer().min(10).max(1000).optional(),
    maxAutoSnapshots: Joi.number().integer().min(10).max(1000).optional(),
    dry_run: Joi.boolean().optional(),
    dryRun: Joi.boolean().optional()
  })
};

const serializeVersionEvent = (event, fallbackLanguage = 'javascript') => {
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};

  return {
    id: event?._id?.toString?.() || event?.id,
    timestamp: event?.createdAt ? new Date(event.createdAt).toISOString() : new Date().toISOString(),
    description: String(metadata.description || event?.event_type || 'Version saved'),
    version_type: String(metadata.version_type || 'manual'),
    language: String(metadata.language || fallbackLanguage),
    code_content: String(metadata.code_content || ''),
    metadata: JSON.stringify(metadata),
    created_by: event?.sender_email || null
  };
};

const VERSION_EVENT_TYPE = 'code_version';
const DEFAULT_MAX_TOTAL_HISTORY = Number.parseInt(process.env.VERSION_HISTORY_MAX_TOTAL || '200', 10);
const DEFAULT_MAX_AUTO_SNAPSHOTS = Number.parseInt(process.env.VERSION_HISTORY_MAX_AUTO || '120', 10);

const getVersionTypeFromEvent = (event) => {
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  return String(metadata.version_type || 'manual');
};

const enforceVersionRetention = async ({
  classroomId,
  userEmail,
  maxTotalHistory = DEFAULT_MAX_TOTAL_HISTORY,
  maxAutoSnapshots = DEFAULT_MAX_AUTO_SNAPSHOTS,
  dryRun = false
}) => {
  const normalizedMaxTotal = Math.max(20, Number.parseInt(String(maxTotalHistory), 10) || DEFAULT_MAX_TOTAL_HISTORY);
  const normalizedMaxAuto = Math.max(10, Number.parseInt(String(maxAutoSnapshots), 10) || DEFAULT_MAX_AUTO_SNAPSHOTS);

  const events = await StudentActivity.find({
    classroom_id: classroomId,
    event_type: VERSION_EVENT_TYPE,
    sender_email: userEmail
  })
    .sort({ createdAt: -1 })
    .select('_id metadata createdAt')
    .lean();

  const idsMarkedForDeletion = new Set();

  let autoSeenCount = 0;
  events.forEach((event) => {
    const versionType = getVersionTypeFromEvent(event);
    if (versionType !== 'auto') {
      return;
    }

    autoSeenCount += 1;
    if (autoSeenCount > normalizedMaxAuto && event?._id) {
      idsMarkedForDeletion.add(String(event._id));
    }
  });

  const keptAfterAutoTrim = events.filter((event) => !idsMarkedForDeletion.has(String(event?._id)));

  if (keptAfterAutoTrim.length > normalizedMaxTotal) {
    keptAfterAutoTrim.slice(normalizedMaxTotal).forEach((event) => {
      if (event?._id) {
        idsMarkedForDeletion.add(String(event._id));
      }
    });
  }

  const removedIds = Array.from(idsMarkedForDeletion);

  if (!dryRun && removedIds.length > 0) {
    await StudentActivity.deleteMany({
      _id: { $in: removedIds },
      classroom_id: classroomId,
      event_type: VERSION_EVENT_TYPE,
      sender_email: userEmail
    });
  }

  const resultingCount = Math.max(0, events.length - removedIds.length);

  return {
    total_before: events.length,
    removed_count: removedIds.length,
    total_after: resultingCount,
    removed_ids: removedIds,
    dry_run: Boolean(dryRun),
    limits: {
      max_total_history: normalizedMaxTotal,
      max_auto_snapshots: normalizedMaxAuto
    }
  };
};

/**
 * GET /api/classrooms
 * Get all classrooms for the authenticated user
 */
router.get('/', asyncHandler(async (req, res) => {
  try {
    const user = req.user;
    let classrooms = [];

    if (user.role === 'faculty' || user.role === 'admin') {
      classrooms = await Classroom.find({ faculty_email: user.email }).sort({ createdAt: -1 });
    } else {
      classrooms = await Classroom.find({ student_emails: user.email }).sort({ createdAt: -1 });
    }

    const serializedClassrooms = classrooms.map(serializeClassroom);
    const classroomsWithDetails = await attachStudentDetails(serializedClassrooms);

    res.json({
      success: true,
      classrooms: classroomsWithDetails,
      count: classroomsWithDetails.length
    });

  } catch (error) {
    logger.error(`Get classrooms error: ${error.message}`);
    res.status(500).json({
      error: 'Failed to fetch classrooms',
      message: error.message
    });
  }
}));

/**
 * POST /api/classrooms
 * Create a new classroom (faculty only)
 */
router.post('/', 
  validateBody(classroomSchemas.create),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      
      if (user.role !== 'faculty' && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Only faculty members can create classrooms'
        });
      }

      const code = await generateUniqueClassroomCode();
      
      const classroomData = {
        name: req.body.name,
        description: req.body.description,
        language: req.body.language,
        code,
        faculty_email: user.email,
        student_emails: [],
        max_students: req.body.maxStudents,
        settings: {
          isPrivate: req.body.isPrivate
        }
      };

      const classroom = await Classroom.create(classroomData);

      res.status(201).json({
        success: true,
        classroom: serializeClassroom(classroom),
        message: 'Classroom created successfully'
      });

      logger.info(`Classroom created: ${classroom.name} by ${user.email}`);

    } catch (error) {
      logger.error(`Create classroom error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to create classroom',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/classrooms/:id
 * Get specific classroom details
 */
router.get('/:id', 
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      if (!hasClassroomAccess(classroom, user)) {
        return res.status(403).json({
          error: 'Access denied to this classroom'
        });
      }

      const serializedClassroom = serializeClassroom(classroom);
      const [classroomWithDetails] = await attachStudentDetails([serializedClassroom]);

      res.json({
        success: true,
        classroom: classroomWithDetails
      });

    } catch (error) {
      logger.error(`Get classroom error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to fetch classroom',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/classrooms/:id/code-state
 * Get persistent classroom code state (shared for faculty/admin, personal for student by default)
 */
router.get('/:id/code-state',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const requestedScope = String(req.query.scope || '').toLowerCase();
      const targetStudentEmail = normalizeEmail(req.query.targetStudentEmail || req.query.target_student_email);
      const classroom = await Classroom.findById(req.params.id);

      if (!classroom) {
        return res.status(404).json({ error: 'Classroom not found' });
      }

      if (!hasClassroomAccess(classroom, user)) {
        return res.status(403).json({ error: 'Access denied to this classroom' });
      }

      const scope = getCodeStateScope({ user, requestedScope });
      const isFacultyOrAdmin = user.role === 'faculty' || user.role === 'admin';

      const fallbackLanguage = classroom.language || 'javascript';
      const metadata = classroom.metadata || {};
      const shouldUseTargetedStudentState = Boolean(targetStudentEmail && isFacultyOrAdmin && isStudentEnrolled(classroom, targetStudentEmail));
      const effectiveScope = shouldUseTargetedStudentState ? 'personal' : scope;
      const effectiveEmail = shouldUseTargetedStudentState ? targetStudentEmail : user.email;
      const sharedState = normalizeCodeState(metadata.shared_code_state, fallbackLanguage);
      const personalState = getPersonalCodeState(metadata, effectiveEmail, fallbackLanguage);
      const state = effectiveScope === 'shared'
        ? sharedState
        : personalState || sharedState;

      return res.json({
        success: true,
        scope: effectiveScope,
        state,
        targetStudentEmail: shouldUseTargetedStudentState ? targetStudentEmail : null
      });
    } catch (error) {
      logger.error(`Get classroom code-state error: ${error.message}`);
      return res.status(500).json({
        error: 'Failed to load code state',
        message: error.message
      });
    }
  })
);

/**
 * PUT /api/classrooms/:id/code-state
 * Persist classroom code state. Faculty/admin can write shared state; any participant can write personal state.
 */
router.put('/:id/code-state',
  validateParams({ id: schemas.objectId }),
  validateBody(Joi.object({
    code: Joi.string().max(500000).allow('').required(),
    language: schemas.language.required(),
    scope: Joi.string().valid('shared', 'personal').optional(),
    targetStudentEmail: schemas.email.optional()
  })),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);

      if (!classroom) {
        return res.status(404).json({ error: 'Classroom not found' });
      }

      if (!hasClassroomAccess(classroom, user)) {
        return res.status(403).json({ error: 'Access denied to this classroom' });
      }

      const requestedScope = String(req.body.scope || '').toLowerCase();
      const targetStudentEmail = normalizeEmail(req.body.targetStudentEmail);
      const scope = getCodeStateScope({ user, requestedScope });
      const isFacultyOrAdmin = user.role === 'faculty' || user.role === 'admin';

      if (scope === 'shared' && !isFacultyOrAdmin) {
        return res.status(403).json({ error: 'Only faculty can update shared classroom code state' });
      }

      const nowIso = new Date().toISOString();
      const nextState = {
        code: String(req.body.code || ''),
        language: String(req.body.language || classroom.language || 'javascript').toLowerCase(),
        updated_at: nowIso,
        updated_by: user.email
      };

      const shouldSaveTargetedStudentState = Boolean(targetStudentEmail);

      if (shouldSaveTargetedStudentState) {
        if (!isFacultyOrAdmin) {
          return res.status(403).json({ error: 'Only faculty can update targeted student code state' });
        }

        if (!isStudentEnrolled(classroom, targetStudentEmail)) {
          return res.status(400).json({ error: 'targetStudentEmail is not enrolled in this classroom' });
        }

        classroom.metadata = setPersonalCodeState(classroom.metadata, targetStudentEmail, nextState);
        await classroom.save();

        return res.json({
          success: true,
          scope: 'personal',
          state: nextState,
          targetStudentEmail
        });
      }

      if (scope === 'shared') {
        const currentMetadata = classroom.metadata && typeof classroom.metadata === 'object'
          ? classroom.metadata
          : {};

        classroom.metadata = {
          ...currentMetadata,
          shared_code_state: nextState
        };
      } else {
        classroom.metadata = setPersonalCodeState(classroom.metadata, user.email, nextState);
      }

      classroom.markModified('metadata');
      await classroom.save();

      return res.json({
        success: true,
        scope,
        state: nextState
      });
    } catch (error) {
      logger.error(`Update classroom code-state error: ${error.message}`);
      return res.status(500).json({
        error: 'Failed to save code state',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/classrooms/join
 * Join a classroom using invite code
 */
router.post('/join',
  validateBody(classroomSchemas.join),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const code = String(req.body.code || '').trim().split(/\s+/).join('').toUpperCase();
      const normalizedUserEmail = String(user.email || '').trim().toLowerCase();

      const classroom = await Classroom.findOne({ code });

      if (!classroom) {
        logger.warn(`Join classroom failed: no classroom found for code ${code} requested by ${normalizedUserEmail}`);
        return res.status(404).json({
          error: 'Invalid classroom code'
        });
      }

      if (String(classroom.faculty_email || '').toLowerCase() === normalizedUserEmail) {
        return res.status(409).json({
          error: 'Already owns this classroom',
          message: 'You are the creator of this classroom'
        });
      }

      const alreadyJoined = (classroom.student_emails || []).some(
        (email) => String(email || '').toLowerCase() === normalizedUserEmail
      );

      if (alreadyJoined) {
        return res.status(409).json({
          error: 'Already joined this classroom'
        });
      }

      if (classroom.student_emails.length >= classroom.max_students) {
        return res.status(400).json({
          error: 'Classroom is full'
        });
      }

      const updated = await Classroom.findOneAndUpdate(
        {
          _id: classroom._id,
          student_emails: { $ne: normalizedUserEmail }
        },
        {
          $addToSet: { student_emails: normalizedUserEmail }
        },
        { new: true }
      );

      if (!updated) {
        return res.status(409).json({
          error: 'Already joined this classroom'
        });
      }

      const serializedClassroom = serializeClassroom(updated);
      const [classroomWithDetails] = await attachStudentDetails([serializedClassroom]);

      res.json({
        success: true,
        classroom: classroomWithDetails,
        message: 'Successfully joined classroom'
      });

      logger.info(`User ${normalizedUserEmail} joined classroom ${updated.name}`);

    } catch (error) {
      logger.error(`Join classroom error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to join classroom',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/classrooms/:id/students/remove
 * Remove a student from a classroom (faculty/admin only)
 */
router.post('/:id/students/remove',
  validateParams({ id: schemas.objectId }),
  validateBody(classroomSchemas.removeStudent),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);
      const studentEmail = String(req.body.student_email || '').trim().toLowerCase();

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom creator can remove students'
        });
      }

      const isEnrolled = (classroom.student_emails || []).includes(studentEmail);
      if (!isEnrolled) {
        return res.status(404).json({
          error: 'Student is not enrolled in this classroom'
        });
      }

      const updatedClassroom = await Classroom.findByIdAndUpdate(
        classroom._id,
        {
          $pull: { student_emails: studentEmail }
        },
        { new: true }
      );

      const io = getSocketIOServer();
      if (io) {
        io.sockets.sockets.forEach((activeSocket) => {
          const isRemovedStudent = activeSocket.user?.email === studentEmail;
          const inSameClassroom = String(activeSocket.data?.classroomId || '') === String(classroom._id);

          if (isRemovedStudent && inSameClassroom) {
            activeSocket.emit('collaboration:error', {
              message: 'You were removed from this classroom by faculty.'
            });

            activeSocket.emit('collaboration:removed', {
              classroomId: String(classroom._id),
              removedBy: user.email,
              timestamp: Date.now()
            });

            activeSocket.disconnect(true);
          }
        });
      }

      await InterventionRoom.updateMany(
        {
          classroom_id: classroom._id,
          student_email: studentEmail,
          status: 'active'
        },
        {
          $set: {
            status: 'closed',
            ended_at: new Date(),
            ended_by: user.email,
            ended_reason: 'student_removed'
          }
        }
      );

      const serializedClassroom = serializeClassroom(updatedClassroom);
      const [classroomWithDetails] = await attachStudentDetails([serializedClassroom]);

      res.json({
        success: true,
        classroom: classroomWithDetails,
        message: `${studentEmail} was removed from classroom`
      });

      logger.info(`Faculty ${user.email} removed ${studentEmail} from classroom ${classroom._id}`);
    } catch (error) {
      logger.error(`Remove student from classroom error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to remove student from classroom',
        message: error.message
      });
    }
  })
);

/**
 * PUT /api/classrooms/:id
 * Update classroom (faculty only)
 */
router.put('/:id',
  validateParams({ id: schemas.objectId }),
  validateBody(classroomSchemas.update),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      // Check permissions
      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom creator can update it'
        });
      }

      if (req.body.name !== undefined) classroom.name = req.body.name;
      if (req.body.description !== undefined) classroom.description = req.body.description;
      if (req.body.maxStudents !== undefined) classroom.max_students = req.body.maxStudents;
      if (req.body.isPrivate !== undefined) {
        classroom.settings = {
          ...classroom.settings,
          isPrivate: req.body.isPrivate
        };
      }

      const updatedClassroom = await classroom.save();

      const serializedClassroom = serializeClassroom(updatedClassroom);
      const [classroomWithDetails] = await attachStudentDetails([serializedClassroom]);

      res.json({
        success: true,
        classroom: classroomWithDetails,
        message: 'Classroom updated successfully'
      });

    } catch (error) {
      logger.error(`Update classroom error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to update classroom',
        message: error.message
      });
    }
  })
);

/**
 * DELETE /api/classrooms/:id
 * Delete classroom (faculty only)
 */
router.delete('/:id',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      // Check permissions
      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom creator can delete it'
        });
      }

      await Classroom.deleteOne({ _id: req.params.id });

      res.json({
        success: true,
        message: 'Classroom deleted successfully'
      });

      logger.info(`Classroom ${classroom.name} deleted by ${user.email}`);

    } catch (error) {
      logger.error(`Delete classroom error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to delete classroom',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/classrooms/:id/interventions
 * Create or return an active private faculty-student intervention room
 */
router.post('/:id/interventions',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);
      const requesterEmail = String(user?.email || '').trim().toLowerCase();
      const facultyEmail = String(classroom?.faculty_email || '').trim().toLowerCase();
      const studentEmail = String(req.body?.student_email || '').trim().toLowerCase();

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      if (facultyEmail !== requesterEmail && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom faculty can create intervention rooms'
        });
      }

      if (!studentEmail) {
        return res.status(400).json({
          error: 'student_email is required'
        });
      }

      const isEnrolledStudent = (classroom.student_emails || []).some(
        (email) => String(email || '').trim().toLowerCase() === studentEmail
      );

      if (!isEnrolledStudent) {
        return res.status(400).json({
          error: 'Student is not enrolled in this classroom'
        });
      }

      const existingRoom = await InterventionRoom.findOne({
        classroom_id: classroom._id,
        student_email: studentEmail,
        faculty_email: classroom.faculty_email,
        status: 'active'
      }).sort({ createdAt: -1 });

      if (existingRoom) {
        const socketServer = getSocketIOServer();
        if (socketServer) {
          socketServer.to(String(classroom._id)).emit('collaboration:event', {
            id: `evt_${Date.now()}`,
            classroom_id: classroom._id,
            sender_email: user.email,
            sender_name: user.full_name || user.name || user.email,
            type: 'intervention_opened',
            metadata: {
              room_id: existingRoom.room_id,
              student_email: existingRoom.student_email,
              classroom_id: classroom._id.toString(),
              timestamp: Date.now()
            },
            created_date: new Date().toISOString(),
            is_private: false,
            room_id: null
          });
        }

        return res.json({
          success: true,
          room: {
            room_id: existingRoom.room_id,
            classroom_id: classroom._id,
            student_email: existingRoom.student_email,
            faculty_email: existingRoom.faculty_email,
            status: existingRoom.status
          }
        });
      }

      const sanitizedStudentEmail = Array.from(studentEmail).map((char) => (
        /[a-z0-9]/i.test(char) ? char : '_'
      )).join('');
      const roomId = `intervention_${classroom._id}_${sanitizedStudentEmail}_${Date.now()}`;

      const room = await InterventionRoom.create({
        room_id: roomId,
        classroom_id: classroom._id,
        faculty_email: classroom.faculty_email,
        student_email: studentEmail,
        status: 'active'
      });

      const socketServer = getSocketIOServer();
      if (socketServer) {
        socketServer.to(String(classroom._id)).emit('collaboration:event', {
          id: `evt_${Date.now()}`,
          classroom_id: classroom._id,
          sender_email: user.email,
          sender_name: user.full_name || user.name || user.email,
          type: 'intervention_opened',
          metadata: {
            room_id: room.room_id,
            student_email: room.student_email,
            classroom_id: classroom._id.toString(),
            timestamp: Date.now()
          },
          created_date: new Date().toISOString(),
          is_private: false,
          room_id: null
        });
      }

      res.status(201).json({
        success: true,
        room: {
          room_id: room.room_id,
          classroom_id: classroom._id,
          student_email: room.student_email,
          faculty_email: room.faculty_email,
          status: room.status
        }
      });

      logger.info(`Intervention room created: ${room.room_id} by ${user.email}`);
    } catch (error) {
      logger.error(`Create intervention room error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to create intervention room',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/classrooms/:id/interventions/active
 * Get current active intervention room for authenticated user in a classroom
 */
router.get('/:id/interventions/active',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);
      const requesterEmail = String(user?.email || '').trim().toLowerCase();
      const facultyEmail = String(classroom?.faculty_email || '').trim().toLowerCase();
      const requestedStudentEmail = String(req.query?.student_email || '').trim().toLowerCase();

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      const hasAccess =
        user.role === 'admin' ||
        facultyEmail === requesterEmail ||
        (classroom.student_emails || []).some(
          (email) => String(email || '').trim().toLowerCase() === requesterEmail
        );

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this classroom'
        });
      }

      const query = {
        classroom_id: classroom._id,
        status: 'active'
      };

      if (user.role === 'faculty') {
        query.faculty_email = classroom.faculty_email;

        if (requestedStudentEmail) {
          query.student_email = requestedStudentEmail;
        }
      }

      if (user.role === 'student') {
        query.student_email = requesterEmail;
      }

      const activeRoom = await InterventionRoom.findOne(query).sort({ createdAt: -1 }).lean();

      res.json({
        success: true,
        room: activeRoom
          ? {
              room_id: activeRoom.room_id,
              classroom_id: activeRoom.classroom_id,
              faculty_email: activeRoom.faculty_email,
              student_email: activeRoom.student_email,
              status: activeRoom.status
            }
          : null
      });
    } catch (error) {
      logger.error(`Get active intervention room error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to fetch active intervention room',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/classrooms/:id/interventions/:roomId/close
 * Close an active intervention room and notify connected participants
 */
router.post('/:id/interventions/:roomId/close',
  validateParams({
    id: schemas.objectId,
    roomId: Joi.string().min(1).required()
  }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);
      const roomId = String(req.params.roomId || '').trim();

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom faculty can close intervention rooms'
        });
      }

      const room = await InterventionRoom.findOne({
        room_id: roomId,
        classroom_id: classroom._id,
        status: 'active'
      });

      if (!room) {
        return res.status(404).json({
          error: 'Active intervention room not found'
        });
      }

      room.status = 'closed';
      room.closed_at = new Date();
      await room.save();

      const socketServer = globalThis.__socketIO;
      if (socketServer) {
        socketServer.to(room.room_id).emit('collaboration:event', {
          id: `evt_${Date.now()}`,
          classroom_id: classroom._id,
          sender_email: user.email,
          sender_name: user.full_name || user.name || user.email,
          type: 'intervention_closed',
          metadata: {
            room_id: room.room_id,
            student_email: room.student_email,
            classroom_id: classroom._id.toString(),
            timestamp: Date.now()
          },
          created_date: new Date().toISOString(),
          is_private: true,
          room_id: room.room_id
        });
      }

      res.json({
        success: true,
        room: {
          room_id: room.room_id,
          classroom_id: classroom._id,
          faculty_email: room.faculty_email,
          student_email: room.student_email,
          status: room.status,
          closed_at: room.closed_at
        }
      });

      logger.info(`Intervention room closed: ${room.room_id} by ${user.email}`);
    } catch (error) {
      logger.error(`Close intervention room error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to close intervention room',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/classrooms/:id/activity-history
 * Fetch persistent classroom activity with filters for faculty dashboard
 */
router.get('/:id/activity-history',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 200, 500);
      const onlyErrors = String(req.query.only_errors || 'false') === 'true';
      const onlyActive = String(req.query.only_active || 'false') === 'true';
      const topStruggling = String(req.query.top_struggling || 'false') === 'true';

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      const hasAccess = user.role === 'admin' || classroom.faculty_email === user.email;
      if (!hasAccess) {
        return res.status(403).json({
          error: 'Only faculty can view classroom activity history'
        });
      }

      const query = {
        classroom_id: classroom._id
      };

      if (onlyErrors) {
        query.$or = [
          { event_type: 'execution_result', 'metadata.success': false },
          { event_type: 'execution_error' }
        ];
      }

      const events = await StudentActivity.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      const aggregates = new Map();

      events.forEach((event) => {
        const email = event.sender_email;
        if (!email) {
          return;
        }

        const current = aggregates.get(email) || {
          email,
          name: event.sender_name || email.split('@')[0],
          total_events: 0,
          issues: 0,
          last_event_type: 'activity',
          last_seen: null,
          last_code: '',
          last_error: '',
          last_language: classroom.language || 'javascript'
        };

        current.total_events += 1;
        current.last_event_type = event.event_type || current.last_event_type;
        current.last_seen = current.last_seen || event.createdAt;

        if (event.event_type === 'execution_result' && event.metadata?.success === false) {
          current.issues += 1;
          if (!current.last_error && typeof event.metadata?.error === 'string') {
            current.last_error = event.metadata.error;
          }
        }

        if (
          (event.event_type === 'code_change' || event.event_type === 'personal_code_change') &&
          !current.last_code &&
          typeof event.metadata?.code === 'string'
        ) {
          current.last_code = event.metadata.code;
          current.last_language = event.metadata?.language || current.last_language;
        }

        aggregates.set(email, current);
      });

      let students = Array.from(aggregates.values());

      if (onlyActive) {
        const activeWindowMs = 10 * 60 * 1000;
        const now = Date.now();
        students = students.filter((student) => student.last_seen && (now - new Date(student.last_seen).getTime()) <= activeWindowMs);
      }

      if (topStruggling) {
        students.sort((a, b) => b.issues - a.issues || b.total_events - a.total_events);
        students = students.slice(0, 10);
      }

      res.json({
        success: true,
        classroom: {
          id: classroom._id,
          name: classroom.name
        },
        students,
        events: events.map((event) => ({
          id: event._id?.toString(),
          sender_email: event.sender_email,
          sender_name: event.sender_name,
          type: event.event_type,
          metadata: event.metadata || {},
          room_id: event.room_id || null,
          is_private: event.is_private,
          created_date: event.createdAt
        }))
      });
    } catch (error) {
      logger.error(`Get activity history error: ${error.message}`);
      res.status(500).json({
        error: 'Failed to fetch activity history',
        message: error.message
      });
    }
  })
);

/**
 * GET /api/classrooms/:id/versions
 * Get code version history for classroom/user
 */
router.get('/:id/versions',
  validateParams({ id: schemas.objectId }),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);

      if (!classroom) {
        return res.status(404).json({ error: 'Classroom not found' });
      }

      if (!hasClassroomAccess(classroom, user)) {
        return res.status(403).json({ error: 'Access denied to this classroom' });
      }

      const isFacultyOrAdmin = user.role === 'faculty' || user.role === 'admin';
      const requestedUserEmail = normalizeEmail(req.query.user_email || req.query.userEmail || user.email);
      const effectiveUserEmail = isFacultyOrAdmin ? requestedUserEmail : normalizeEmail(user.email);

      const query = {
        classroom_id: classroom._id,
        event_type: 'code_version',
        sender_email: effectiveUserEmail
      };

      const events = await StudentActivity.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      const versions = events.map((event) => serializeVersionEvent(event, classroom.language || 'javascript'));

      return res.json({
        success: true,
        versions,
        count: versions.length,
        classroom_id: classroom._id.toString(),
        user_email: effectiveUserEmail
      });
    } catch (error) {
      logger.error(`Get version history error: ${error.message}`);
      return res.status(500).json({
        error: 'Failed to fetch version history',
        message: error.message
      });
    }
  })
);

/**
 * DELETE /api/classrooms/:id/versions/cleanup
 * Remove stale auto snapshots and enforce max history retention.
 */
router.delete('/:id/versions/cleanup',
  validateParams({ id: schemas.objectId }),
  validateQuery(versionSchemas.cleanupQuery),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);

      if (!classroom) {
        return res.status(404).json({ error: 'Classroom not found' });
      }

      if (!hasClassroomAccess(classroom, user)) {
        return res.status(403).json({ error: 'Access denied to this classroom' });
      }

      const isFacultyOrAdmin = user.role === 'faculty' || user.role === 'admin';
      const requestedUserEmail = normalizeEmail(req.query.user_email || req.query.userEmail || user.email);

      if (!isFacultyOrAdmin && requestedUserEmail !== normalizeEmail(user.email)) {
        return res.status(403).json({ error: 'Students can only cleanup their own version history' });
      }

      const dryRun = String(req.query.dry_run ?? req.query.dryRun ?? 'false') === 'true';
      const maxTotalHistory = req.query.max_total_history ?? req.query.maxTotalHistory ?? DEFAULT_MAX_TOTAL_HISTORY;
      const maxAutoSnapshots = req.query.max_auto_snapshots ?? req.query.maxAutoSnapshots ?? DEFAULT_MAX_AUTO_SNAPSHOTS;

      const result = await enforceVersionRetention({
        classroomId: classroom._id,
        userEmail: requestedUserEmail,
        maxTotalHistory,
        maxAutoSnapshots,
        dryRun
      });

      return res.json({
        success: true,
        classroom_id: classroom._id.toString(),
        user_email: requestedUserEmail,
        retention: result
      });
    } catch (error) {
      logger.error(`Cleanup version history error: ${error.message}`);
      return res.status(500).json({
        error: 'Failed to cleanup version history',
        message: error.message
      });
    }
  })
);

/**
 * POST /api/classrooms/:id/versions
 * Create a new code version snapshot
 */
router.post('/:id/versions',
  validateParams({ id: schemas.objectId }),
  validateBody(versionSchemas.create),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const classroom = await Classroom.findById(req.params.id);

      if (!classroom) {
        return res.status(404).json({ error: 'Classroom not found' });
      }

      if (!hasClassroomAccess(classroom, user)) {
        return res.status(403).json({ error: 'Access denied to this classroom' });
      }

      const code = String(req.body.code || '');
      const language = String(req.body.language || classroom.language || 'javascript').toLowerCase();
      const versionType = String(req.body.version_type || 'manual');
      const description = String(req.body.description || '').trim();
      const metadata = {
        version_type: versionType,
        description: description || `Version saved (${versionType})`,
        language,
        code_content: code,
        code_length: code.length,
        line_count: code.split('\n').length,
        related_submission_id: String(req.body.related_submission_id || '').trim() || null,
        client_timestamp: Date.now()
      };

      const createdEvent = await StudentActivity.create({
        classroom_id: classroom._id,
        sender_email: user.email,
        sender_name: user.full_name || user.name || user.email,
        event_type: 'code_version',
        is_private: true,
        metadata
      });

      const retention = await enforceVersionRetention({
        classroomId: classroom._id,
        userEmail: user.email
      });

      return res.status(201).json({
        success: true,
        version: serializeVersionEvent(createdEvent, classroom.language || 'javascript'),
        retention
      });
    } catch (error) {
      logger.error(`Create version error: ${error.message}`);
      return res.status(500).json({
        error: 'Failed to create version snapshot',
        message: error.message
      });
    }
  })
);

/**
 * Generate random 6-character classroom code
 */
const generateClassroomCode = () => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
};

const generateUniqueClassroomCode = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateClassroomCode();
    const existingClassroom = await Classroom.exists({ code });

    if (!existingClassroom) {
      return code;
    }
  }

  throw new Error('Unable to generate a unique classroom code');
};

export default router;