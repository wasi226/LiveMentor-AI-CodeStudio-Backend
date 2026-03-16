/**
 * Socket.IO service
 * Provides authenticated real-time collaboration channels for classrooms.
 */

import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger.js';

let io = null;

// classroomId -> Map<socketId, user>
const classroomPresence = new Map();

const getJwtSecret = () => process.env.JWT_SECRET || 'your-jwt-secret-key-change-this-in-production';

const sanitizeUser = (decodedUser = {}) => {
  const email = decodedUser.email;
  const fallbackName = email ? email.split('@')[0] : 'anonymous';

  return {
    email,
    name: decodedUser.name || decodedUser.full_name || fallbackName,
    role: decodedUser.role || 'student'
  };
};

const buildCollaborationPayload = ({ classroomId, eventType, user, data }) => ({
  id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  classroom_id: classroomId,
  sender_email: user.email,
  sender_name: user.name,
  type: eventType,
  metadata: {
    ...data,
    timestamp: data?.timestamp || Date.now(),
    user_id: user.email
  },
  created_date: new Date().toISOString()
});

const emitPresence = (classroomId) => {
  if (!io) {
    return;
  }

  const participants = Array.from((classroomPresence.get(classroomId) || new Map()).values());

  io.to(classroomId).emit('collaboration:presence', {
    classroomId,
    participants,
    totalParticipants: participants.length,
    timestamp: Date.now()
  });
};

const removeSocketFromClassroom = (socket, reason = 'left') => {
  const classroomId = socket.data.classroomId;
  if (!classroomId) {
    return;
  }

  const roomPresence = classroomPresence.get(classroomId);
  const participant = roomPresence?.get(socket.id);

  if (roomPresence) {
    roomPresence.delete(socket.id);

    if (roomPresence.size === 0) {
      classroomPresence.delete(classroomId);
    }
  }

  socket.leave(classroomId);

  if (participant) {
    socket.to(classroomId).emit('collaboration:event', buildCollaborationPayload({
      classroomId,
      eventType: 'user_leave',
      user: participant,
      data: {
        reason
      }
    }));
  }

  emitPresence(classroomId);
  socket.data.classroomId = null;
};

const handleJoinClassroom = (socket, payload = {}) => {
  const classroomId = payload.classroomId;

  if (!classroomId) {
    socket.emit('collaboration:error', {
      message: 'classroomId is required to join collaboration session.'
    });
    return;
  }

  if (socket.data.classroomId && socket.data.classroomId !== classroomId) {
    removeSocketFromClassroom(socket, 'switched_classroom');
  }

  socket.join(classroomId);
  socket.data.classroomId = classroomId;

  if (!classroomPresence.has(classroomId)) {
    classroomPresence.set(classroomId, new Map());
  }

  const roomPresence = classroomPresence.get(classroomId);
  const participant = {
    ...socket.user,
    socketId: socket.id,
    joinedAt: new Date().toISOString()
  };

  roomPresence.set(socket.id, participant);

  socket.emit('collaboration:joined', {
    classroomId,
    participant,
    timestamp: Date.now()
  });

  socket.to(classroomId).emit('collaboration:event', buildCollaborationPayload({
    classroomId,
    eventType: 'user_join',
    user: participant,
    data: {
      participant
    }
  }));

  emitPresence(classroomId);

  logger.info(`Socket ${socket.id} joined classroom ${classroomId} as ${participant.email}`);
};

const handleCollaborationEvent = (socket, payload = {}) => {
  const classroomId = socket.data.classroomId;

  if (!classroomId) {
    socket.emit('collaboration:error', {
      message: 'Join a classroom before sending collaboration events.'
    });
    return;
  }

  const eventType = payload.eventType;

  if (!eventType) {
    socket.emit('collaboration:error', {
      message: 'eventType is required for collaboration events.'
    });
    return;
  }

  const message = buildCollaborationPayload({
    classroomId,
    eventType,
    user: socket.user,
    data: payload.data || {}
  });

  socket.to(classroomId).emit('collaboration:event', message);
};

export const startSocketIOServer = (httpServer) => {
  if (io) {
    return io;
  }

  io = new Server(httpServer, {
    path: process.env.SOCKET_IO_PATH || '/socket.io',
    cors: {
      origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173'],
      credentials: process.env.CORS_CREDENTIALS === 'true'
    },
    transports: ['websocket', 'polling']
  });

  io.use((socket, next) => {
    try {
      const rawToken = socket.handshake.auth?.token || socket.handshake.headers?.authorization || '';
      const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const decoded = jwt.verify(token, getJwtSecret());
      socket.user = sanitizeUser(decoded);

      if (!socket.user.email) {
        return next(new Error('Invalid token payload'));
      }

      return next();
    } catch (error) {
      logger.warn(`Socket authentication failed: ${error.message}`);
      return next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (${socket.user.email})`);

    socket.data.classroomId = null;

    socket.on('collaboration:join', (payload) => handleJoinClassroom(socket, payload));
    socket.on('collaboration:leave', () => removeSocketFromClassroom(socket, 'left'));
    socket.on('collaboration:event', (payload) => handleCollaborationEvent(socket, payload));

    socket.on('disconnect', (reason) => {
      removeSocketFromClassroom(socket, reason || 'disconnected');
      logger.info(`Socket disconnected: ${socket.id} (${socket.user.email})`);
    });
  });

  logger.info(`Socket.IO server started on path: ${process.env.SOCKET_IO_PATH || '/socket.io'}`);

  return io;
};

export const getSocketIOStats = () => {
  const classrooms = {};

  classroomPresence.forEach((users, classroomId) => {
    classrooms[classroomId] = Array.from(users.values());
  });

  return {
    totalConnections: io?.engine?.clientsCount || 0,
    classrooms
  };
};

export const getSocketIOServer = () => io;

export default {
  startSocketIOServer,
  getSocketIOStats,
  getSocketIOServer
};