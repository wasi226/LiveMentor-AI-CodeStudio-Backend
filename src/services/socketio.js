/**
 * Socket.IO service
 * Provides authenticated real-time collaboration channels for classrooms.
 */

import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Classroom, InterventionRoom, StudentActivity } from '../models/index.js';
import { validateCode } from './codeExecution.js';
import { createCorsOriginChecker } from '../config/cors.js';
import logger from '../utils/logger.js';

let io = null;

// roomKey -> Map<socketId, user>
const classroomPresence = new Map();
const interactiveSessions = new Map();

const DEFAULT_INTERACTIVE_RUN_TIMEOUT = 300000;
const DEFAULT_INTERACTIVE_COMPILE_TIMEOUT = 30000;

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
  sender_role: user.role,
  type: eventType,
  metadata: {
    ...data,
    timestamp: data?.timestamp || Date.now(),
    user_id: user.email
  },
  created_date: new Date().toISOString()
});

const prepareInteractiveSourceCode = (code, language) => {
  const source = String(code || '');
  if (language !== 'java') {
    return source;
  }

  if (/\bpublic\s+class\s+Main\b/.test(source) || /\bclass\s+Main\b/.test(source)) {
    return source;
  }

  if (/\bpublic\s+class\s+\w+\b/.test(source)) {
    return source.replace(/\bpublic\s+class\s+\w+\b/, 'public class Main');
  }

  return source;
};

const getInteractiveRuntimePlan = (language, tempDir) => {
  switch (language) {
    case 'javascript':
      return {
        sourceFilePath: path.join(tempDir, 'main.js'),
        run: { command: process.execPath, args: ['main.js'] }
      };
    case 'python':
      return {
        sourceFilePath: path.join(tempDir, 'main.py'),
        run: { command: 'python', args: ['main.py'] }
      };
    case 'java':
      return {
        sourceFilePath: path.join(tempDir, 'Main.java'),
        compile: { command: 'javac', args: ['Main.java'] },
        run: { command: 'java', args: ['-cp', tempDir, 'Main'] }
      };
    default:
      return null;
  }
};

const stopInteractiveSession = async (socketId, reason = 'stopped') => {
  const session = interactiveSessions.get(socketId);
  if (!session) {
    return;
  }

  interactiveSessions.delete(socketId);

  try {
    if (session.child && !session.child.killed) {
      session.child.kill();
    }
  } catch (error) {
    logger.warn(`Failed to stop child process for ${socketId}: ${error.message}`);
  }

  if (session.timer) {
    clearTimeout(session.timer);
  }

  if (session.tempDir) {
    await fs.rm(session.tempDir, { recursive: true, force: true }).catch(() => {});
  }

  logger.info(`Interactive session cleaned for ${socketId}: ${reason}`);
};

const resetInteractiveSessionTimer = (socket, timeoutMessage = 'Execution timed out while waiting for input/output.') => {
  const session = interactiveSessions.get(socket.id);
  if (!session?.child) {
    return;
  }

  if (session.timer) {
    clearTimeout(session.timer);
  }

  session.timer = setTimeout(() => {
    socket.emit('terminal:error', { message: timeoutMessage });
    try {
      if (!session.child.killed) {
        session.child.kill();
      }
    } catch {
      // noop
    }
  }, DEFAULT_INTERACTIVE_RUN_TIMEOUT);
};

const writeToInteractiveStdin = (socket, text, { appendNewline = false } = {}) => {
  const session = interactiveSessions.get(socket.id);
  if (!session?.child) {
    socket.emit('terminal:error', { message: 'No active terminal session. Click Run Code first.' });
    return false;
  }

  const rawText = text === undefined || text === null ? '' : String(text);
  const normalizedText = rawText.replaceAll('\r\n', '\n');
  const payload = appendNewline && !normalizedText.endsWith('\n')
    ? `${normalizedText}\n`
    : normalizedText;

  try {
    session.child.stdin.write(payload);
    resetInteractiveSessionTimer(socket);
    return true;
  } catch (error) {
    socket.emit('terminal:error', { message: `Unable to send input: ${error.message}` });
    return false;
  }
};

const runCompileStep = ({ command, args, cwd, socket }) => {
  return new Promise((resolve) => {
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      resolve({ success: false, message: 'Compilation timed out.' });
    }, DEFAULT_INTERACTIVE_COMPILE_TIMEOUT);

    child.stdout.on('data', (chunk) => {
      socket.emit('terminal:output', {
        stream: 'stdout',
        chunk: chunk.toString(),
        timestamp: Date.now()
      });
    });

    child.stderr.on('data', (chunk) => {
      socket.emit('terminal:output', {
        stream: 'stderr',
        chunk: chunk.toString(),
        timestamp: Date.now()
      });
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({ success: false, message: error.message || 'Compilation command failed.' });
    });

    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({ success: exitCode === 0, message: exitCode === 0 ? '' : `Compilation failed with code ${exitCode}.` });
    });
  });
};

const startInteractiveTerminalSession = async (socket, payload = {}) => {
  const roomKey = socket.data.roomKey;
  if (!roomKey) {
    socket.emit('terminal:error', { message: 'Join a classroom before starting terminal execution.' });
    return;
  }

  const language = String(payload.language || '').toLowerCase();
  const rawCode = String(payload.code || '');
  const initialInput = String(payload.initialInput || '');

  if (!rawCode.trim()) {
    socket.emit('terminal:error', { message: 'Code cannot be empty.' });
    return;
  }

  const runtimePlan = getInteractiveRuntimePlan(language, '');
  if (!runtimePlan) {
    socket.emit('terminal:error', {
      message: `Interactive terminal currently supports JavaScript, Python, and Java. Received: ${language}`
    });
    return;
  }

  const validation = validateCode(rawCode, language);
  if (!validation.isValid) {
    socket.emit('terminal:error', {
      message: `Code validation failed:\n${validation.errors.join('\n')}`
    });
    return;
  }

  await stopInteractiveSession(socket.id, 'new_session_started');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-live-'));
  const preparedCode = prepareInteractiveSourceCode(rawCode, language);
  const plan = getInteractiveRuntimePlan(language, tempDir);

  await fs.writeFile(plan.sourceFilePath, preparedCode, 'utf8');

  if (plan.compile) {
    const compileResult = await runCompileStep({
      command: plan.compile.command,
      args: plan.compile.args,
      cwd: tempDir,
      socket
    });

    if (!compileResult.success) {
      socket.emit('terminal:error', { message: compileResult.message || 'Compilation failed.' });
      socket.emit('terminal:ended', { exitCode: 1, signal: null, timestamp: Date.now() });
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return;
    }
  }

  const child = spawn(plan.run.command, plan.run.args, {
    cwd: tempDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const session = {
    socketId: socket.id,
    roomKey,
    child,
    tempDir,
    language,
    timer: null
  };

  interactiveSessions.set(socket.id, session);

  let sessionEnded = false;

  const cleanupAndNotify = async (payloadData) => {
    if (sessionEnded) {
      return;
    }
    sessionEnded = true;

    const activeSession = interactiveSessions.get(socket.id);
    if (activeSession?.timer) {
      clearTimeout(activeSession.timer);
    }

    interactiveSessions.delete(socket.id);
    socket.emit('terminal:ended', {
      exitCode: payloadData.exitCode,
      signal: payloadData.signal || null,
      timestamp: Date.now()
    });
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  resetInteractiveSessionTimer(socket);

  child.stdout.on('data', (chunk) => {
    resetInteractiveSessionTimer(socket);
    socket.emit('terminal:output', {
      stream: 'stdout',
      chunk: chunk.toString(),
      timestamp: Date.now()
    });
  });

  child.stderr.on('data', (chunk) => {
    resetInteractiveSessionTimer(socket);
    socket.emit('terminal:output', {
      stream: 'stderr',
      chunk: chunk.toString(),
      timestamp: Date.now()
    });
  });

  child.on('error', async (error) => {
    socket.emit('terminal:error', {
      message: error?.code === 'ENOENT'
        ? `Runtime not available on server for ${language}.`
        : (error.message || 'Interactive execution failed to start.')
    });

    await cleanupAndNotify({ exitCode: 1, signal: null });
  });

  child.on('close', async (exitCode, signal) => {
    await cleanupAndNotify({ exitCode: exitCode ?? 0, signal });
  });

  socket.emit('terminal:started', {
    language,
    timestamp: Date.now()
  });

  if (initialInput.length > 0) {
    writeToInteractiveStdin(socket, initialInput, { appendNewline: true });
  }
};

const handleInteractiveInput = (socket, payload = {}) => {
  if (!Object.hasOwn(payload, 'input')) {
    return;
  }

  const input = payload.input;
  writeToInteractiveStdin(socket, input, { appendNewline: true });
};

const handleInteractiveStop = async (socket) => {
  await stopInteractiveSession(socket.id, 'stopped_by_user');
};

const emitPresence = (roomKey) => {
  if (!io) {
    return;
  }

  const participants = Array.from((classroomPresence.get(roomKey) || new Map()).values());

  io.to(roomKey).emit('collaboration:presence', {
    roomKey,
    participants,
    totalParticipants: participants.length,
    timestamp: Date.now()
  });
};

const canJoinPrivateIntervention = async (user, roomId) => {
  const room = await InterventionRoom.findOne({ room_id: roomId, status: 'active' }).lean();

  if (!room) {
    return { allowed: false, reason: 'Intervention room not found or closed.' };
  }

  const email = user?.email;
  const allowed = email === room.faculty_email || email === room.student_email || user?.role === 'admin';

  if (!allowed) {
    return { allowed: false, reason: 'You are not allowed in this intervention room.' };
  }

  return { allowed: true, room };
};

const canJoinClassroomRoom = async (user, classroomId) => {
  const classroom = await Classroom.findById(classroomId).lean();

  if (!classroom) {
    return { allowed: false, reason: 'Classroom not found.' };
  }

  const email = user?.email;
  const allowed =
    user?.role === 'admin' ||
    classroom.faculty_email === email ||
    (classroom.student_emails || []).includes(email);

  if (!allowed) {
    return { allowed: false, reason: 'Access denied to this classroom room.' };
  }

  return { allowed: true, classroom };
};

const persistActivity = async (payload) => {
  try {
    await StudentActivity.create(payload);
  } catch (error) {
    logger.warn(`Failed to persist student activity: ${error.message}`);
  }
};

const removeSocketFromClassroom = (socket, reason = 'left') => {
  const roomKey = socket.data.roomKey;
  if (!roomKey) {
    return;
  }

  const roomPresence = classroomPresence.get(roomKey);
  const participant = roomPresence?.get(socket.id);

  if (roomPresence) {
    roomPresence.delete(socket.id);

    if (roomPresence.size === 0) {
      classroomPresence.delete(roomKey);
    }
  }

  socket.leave(roomKey);

  if (participant) {
    socket.to(roomKey).emit('collaboration:event', buildCollaborationPayload({
      classroomId: socket.data.classroomId,
      eventType: 'user_leave',
      user: participant,
      data: {
        reason
      }
    }));
  }

  emitPresence(roomKey);
  socket.data.roomKey = null;
  socket.data.classroomId = null;
  socket.data.isPrivateRoom = false;
  socket.data.interventionRoomId = null;

  void stopInteractiveSession(socket.id, `socket_${reason}`);
};

const resolveJoinContext = async (socket, payload = {}) => {
  const classroomId = payload.classroomId;
  const roomId = payload.roomId;
  const roomType = payload.roomType || (roomId ? 'intervention' : 'classroom');

  if (!classroomId) {
    return {
      ok: false,
      message: 'classroomId is required to join collaboration session.'
    };
  }

  if (roomType === 'intervention' && roomId) {
    const privateAccess = await canJoinPrivateIntervention(socket.user, roomId);
    if (!privateAccess.allowed) {
      return {
        ok: false,
        message: privateAccess.reason
      };
    }

    if (privateAccess.room.classroom_id?.toString() !== classroomId) {
      return {
        ok: false,
        message: 'Intervention room does not belong to this classroom.'
      };
    }
  } else {
    const classroomAccess = await canJoinClassroomRoom(socket.user, classroomId);
    if (!classroomAccess.allowed) {
      return {
        ok: false,
        message: classroomAccess.reason
      };
    }
  }

  const roomKey = roomType === 'intervention' && roomId ? roomId : classroomId;
  const isPrivateRoom = roomType === 'intervention' && Boolean(roomId);

  return {
    ok: true,
    classroomId,
    roomId,
    roomKey,
    isPrivateRoom
  };
};

const handleJoinClassroom = async (socket, payload = {}) => {
  const joinContext = await resolveJoinContext(socket, payload);

  if (!joinContext.ok) {
    socket.emit('collaboration:error', { message: joinContext.message });
    return;
  }

  const { classroomId, roomId, roomKey, isPrivateRoom } = joinContext;

  if (socket.data.roomKey) {
    removeSocketFromClassroom(socket, 'switched_classroom');
  }

  socket.join(roomKey);
  socket.data.classroomId = classroomId;
  socket.data.roomKey = roomKey;
  socket.data.isPrivateRoom = isPrivateRoom;
  socket.data.interventionRoomId = isPrivateRoom ? roomId : null;

  if (!classroomPresence.has(roomKey)) {
    classroomPresence.set(roomKey, new Map());
  }

  const roomPresence = classroomPresence.get(roomKey);
  const participant = {
    ...socket.user,
    socketId: socket.id,
    joinedAt: new Date().toISOString()
  };

  roomPresence.set(socket.id, participant);

  socket.emit('collaboration:joined', {
    classroomId,
    roomKey,
    isPrivateRoom,
    participant,
    timestamp: Date.now()
  });

  socket.to(roomKey).emit('collaboration:event', buildCollaborationPayload({
    classroomId,
    eventType: 'user_join',
    user: participant,
    data: {
      participant,
      room_id: isPrivateRoom ? roomId : null,
      is_private: isPrivateRoom
    }
  }));

  emitPresence(roomKey);

  logger.info(`Socket ${socket.id} joined room ${roomKey} (classroom ${classroomId}) as ${participant.email}`);
};

const handleCollaborationEvent = async (socket, payload = {}) => {
  const classroomId = socket.data.classroomId;
  const roomKey = socket.data.roomKey;

  if (!classroomId || !roomKey) {
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

  const restrictedToFacultyEvents = new Set(['code_change', 'language_change']);
  const isFacultyOrAdmin = socket.user?.role === 'faculty' || socket.user?.role === 'admin';

  if (restrictedToFacultyEvents.has(eventType) && !isFacultyOrAdmin) {
    socket.emit('collaboration:error', {
      message: 'Only faculty can broadcast code or language updates.'
    });
    return;
  }

  const message = buildCollaborationPayload({
    classroomId,
    eventType,
    user: socket.user,
    data: payload.data || {}
  });

  socket.to(roomKey).emit('collaboration:event', {
    ...message,
    room_id: socket.data.interventionRoomId || null,
    is_private: Boolean(socket.data.isPrivateRoom)
  });

  await persistActivity({
    classroom_id: classroomId,
    room_id: socket.data.interventionRoomId || null,
    sender_email: socket.user.email,
    sender_name: socket.user.name,
    event_type: eventType,
    is_private: Boolean(socket.data.isPrivateRoom),
    metadata: payload.data || {}
  });
};

export const startSocketIOServer = (httpServer) => {
  if (io) {
    return io;
  }

  io = new Server(httpServer, {
    path: process.env.SOCKET_IO_PATH || '/socket.io',
    cors: {
      origin: createCorsOriginChecker(process.env.CORS_ORIGIN),
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
    socket.data.roomKey = null;
    socket.data.isPrivateRoom = false;
    socket.data.interventionRoomId = null;

    socket.on('collaboration:join', (payload) => handleJoinClassroom(socket, payload));
    socket.on('collaboration:leave', () => removeSocketFromClassroom(socket, 'left'));
    socket.on('collaboration:event', (payload) => handleCollaborationEvent(socket, payload));
    socket.on('terminal:start', (payload) => {
      void startInteractiveTerminalSession(socket, payload);
    });
    socket.on('terminal:input', (payload) => handleInteractiveInput(socket, payload));
    socket.on('terminal:stop', () => {
      void handleInteractiveStop(socket);
    });

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