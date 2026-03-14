/**
 * Classroom Routes
 * Handles classroom management operations
 */

import express from 'express';
import { Classroom } from '../models/index.js';
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

    res.json({
      success: true,
      classrooms: classrooms.map(serializeClassroom),
      count: classrooms.length
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

      res.json({
        success: true,
        classroom: serializeClassroom(classroom)
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

      res.json({
        success: true,
        classroom: serializeClassroom(classroom),
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

      res.json({
        success: true,
        classroom: serializeClassroom(updatedClassroom),
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