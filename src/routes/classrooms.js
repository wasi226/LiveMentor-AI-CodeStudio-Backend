/**
 * Classroom Routes
 * Handles classroom management operations
 */

import express from 'express';
import { Classroom, User, StudentActivity, InterventionRoom } from '../models/index.js';
import { validateBody, validateParams, classroomSchemas, schemas } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
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
 * POST /api/classrooms/join
 * Join a classroom using invite code
 */
router.post('/join',
  validateBody(classroomSchemas.join),
  asyncHandler(async (req, res) => {
    try {
      const user = req.user;
      const { code } = req.body;

      const classroom = await Classroom.findOne({ code: code.toUpperCase() });

      if (!classroom) {
        return res.status(404).json({
          error: 'Invalid classroom code'
        });
      }

      if (classroom.faculty_email === user.email) {
        return res.status(409).json({
          error: 'Already owns this classroom',
          message: 'You are the creator of this classroom'
        });
      }

      if (classroom.student_emails.includes(user.email)) {
        return res.status(409).json({
          error: 'Already joined this classroom'
        });
      }

      if (classroom.student_emails.length >= classroom.max_students) {
        return res.status(400).json({
          error: 'Classroom is full'
        });
      }

      classroom.student_emails.push(user.email);
      await classroom.save();

      const serializedClassroom = serializeClassroom(classroom);
      const [classroomWithDetails] = await attachStudentDetails([serializedClassroom]);

      res.json({
        success: true,
        classroom: classroomWithDetails,
        message: 'Successfully joined classroom'
      });

      logger.info(`User ${user.email} joined classroom ${classroom.name}`);

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
      const studentEmail = String(req.body?.student_email || '').trim().toLowerCase();

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      if (classroom.faculty_email !== user.email && user.role !== 'admin') {
        return res.status(403).json({
          error: 'Only the classroom faculty can create intervention rooms'
        });
      }

      if (!studentEmail) {
        return res.status(400).json({
          error: 'student_email is required'
        });
      }

      if (!classroom.student_emails.includes(studentEmail)) {
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

      const roomId = `intervention_${classroom._id}_${studentEmail.replaceAll(/[^a-z0-9]/gi, '_')}_${Date.now()}`;

      const room = await InterventionRoom.create({
        room_id: roomId,
        classroom_id: classroom._id,
        faculty_email: classroom.faculty_email,
        student_email: studentEmail,
        status: 'active'
      });

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
      const requestedStudentEmail = String(req.query?.student_email || '').trim().toLowerCase();
      const classroom = await Classroom.findById(req.params.id);

      if (!classroom) {
        return res.status(404).json({
          error: 'Classroom not found'
        });
      }

      const hasAccess =
        user.role === 'admin' ||
        classroom.faculty_email === user.email ||
        classroom.student_emails.includes(user.email);

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
        query.faculty_email = user.email;

        if (requestedStudentEmail) {
          query.student_email = requestedStudentEmail;
        }
      }

      if (user.role === 'student') {
        query.student_email = user.email;
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
  validateParams({ id: schemas.objectId }),
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

        if (event.event_type === 'code_change' && !current.last_code && typeof event.metadata?.code === 'string') {
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