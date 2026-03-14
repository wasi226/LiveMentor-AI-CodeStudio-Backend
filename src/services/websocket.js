/**
 * WebSocket Service
 * Handles real-time communication using WebSockets
 */

import { WebSocketServer } from 'ws';
import logger from '../utils/logger.js';

let wss = null;
let connectedClients = new Map();

/**
 * Start WebSocket server
 * @param {Object} server - HTTP server instance
 */
export const startWebSocketServer = (server) => {
  try {
    wss = new WebSocketServer({ 
      server,
      path: process.env.WS_PATH || '/websocket'
    });

    wss.on('connection', handleConnection);
    
    logger.info(`WebSocket server started on path: ${process.env.WS_PATH || '/websocket'}`);
    
    // Cleanup on server shutdown
    process.on('SIGTERM', () => {
      if (wss) {
        wss.close(() => {
          logger.info('WebSocket server closed');
        });
      }
    });
    
    return wss;
    
  } catch (error) {
    logger.error('Failed to start WebSocket server:', error);
    throw error;
  }
};

/**
 * Handle new WebSocket connection
 * @param {WebSocket} ws - WebSocket connection
 * @param {Request} req - HTTP request object
 */
const handleConnection = (ws, req) => {
  const clientId = generateClientId();
  const clientInfo = {
    id: clientId,
    ip: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    connectedAt: new Date(),
    lastPing: new Date()
  };
  
  connectedClients.set(clientId, { ws, ...clientInfo });
  
  logger.info(`WebSocket client connected: ${clientId} from ${clientInfo.ip}`);
  
  // Send connection confirmation
  sendMessage(ws, {
    type: 'connection',
    clientId,
    message: 'Connected to liveMentor server',
    timestamp: new Date().toISOString()
  });

  // Handle messages from client
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(clientId, message);
    } catch (error) {
      logger.error(`Invalid message from client ${clientId}:`, error);
      sendError(ws, 'Invalid message format');
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    connectedClients.delete(clientId);
    logger.info(`WebSocket client disconnected: ${clientId}`);
    
    // Notify other clients in same classroom
    broadcastToClassroom(null, {
      type: 'user_disconnected',
      clientId,
      timestamp: new Date().toISOString()
    });
  });

  // Handle WebSocket errors
  ws.on('error', (error) => {
    logger.error(`WebSocket error for client ${clientId}:`, error);
    connectedClients.delete(clientId);
  });

  // Setup ping/pong for connection health
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
      connectedClients.delete(clientId);
    }
  }, 30000); // Ping every 30 seconds

  ws.on('pong', () => {
    const client = connectedClients.get(clientId);
    if (client) {
      client.lastPing = new Date();
    }
  });
};

/**
 * Handle messages from WebSocket clients
 * @param {string} clientId - Client identifier
 * @param {Object} message - Parsed message object
 */
const handleMessage = (clientId, message) => {
  const client = connectedClients.get(clientId);
  if (!client) {
    logger.warn(`Message from unknown client: ${clientId}`);
    return;
  }

  logger.debug(`Message from ${clientId}:`, message);

  switch (message.type) {
    case 'join_classroom':
      handleJoinClassroom(clientId, message.classroomId, message.userInfo);
      break;
      
    case 'leave_classroom':
      handleLeaveClassroom(clientId, message.classroomId);
      break;
      
    case 'code_change':
      handleCodeChange(clientId, message);
      break;
      
    case 'cursor_position':
      handleCursorPosition(clientId, message);
      break;
      
    case 'chat_message':
      handleChatMessage(clientId, message);
      break;
      
    case 'typing_start':
    case 'typing_stop':
      handleTypingIndicator(clientId, message);
      break;
      
    case 'ping':
      sendMessage(client.ws, { type: 'pong', timestamp: new Date().toISOString() });
      break;
      
    default:
      logger.warn(`Unknown message type from ${clientId}: ${message.type}`);
  }
};

/**
 * Handle client joining a classroom
 */
const handleJoinClassroom = (clientId, classroomId, userInfo) => {
  const client = connectedClients.get(clientId);
  if (!client) return;

  client.classroomId = classroomId;
  client.userInfo = userInfo;

  logger.info(`Client ${clientId} joined classroom ${classroomId}`);

  // Notify other clients in the classroom
  broadcastToClassroom(classroomId, {
    type: 'user_joined',
    user: userInfo,
    clientId,
    timestamp: new Date().toISOString()
  }, clientId);

  // Send current classroom state to new user
  sendMessage(client.ws, {
    type: 'classroom_joined',
    classroomId,
    connectedUsers: getClassroomUsers(classroomId),
    timestamp: new Date().toISOString()
  });
};

/**
 * Handle client leaving a classroom
 */
const handleLeaveClassroom = (clientId, classroomId) => {
  const client = connectedClients.get(clientId);
  if (!client) return;

  logger.info(`Client ${clientId} left classroom ${classroomId}`);

  // Notify other clients
  broadcastToClassroom(classroomId, {
    type: 'user_left',
    clientId,
    userInfo: client.userInfo,
    timestamp: new Date().toISOString()
  }, clientId);

  client.classroomId = null;
  client.userInfo = null;
};

/**
 * Handle code changes
 */
const handleCodeChange = (clientId, message) => {
  const client = connectedClients.get(clientId);
  if (!client || !client.classroomId) return;

  broadcastToClassroom(client.classroomId, {
    type: 'code_change',
    code: message.code,
    language: message.language,
    user: client.userInfo,
    clientId,
    timestamp: new Date().toISOString()
  }, clientId);
};

/**
 * Handle cursor position updates
 */
const handleCursorPosition = (clientId, message) => {
  const client = connectedClients.get(clientId);
  if (!client || !client.classroomId) return;

  broadcastToClassroom(client.classroomId, {
    type: 'cursor_position',
    position: message.position,
    user: client.userInfo,
    clientId,
    timestamp: new Date().toISOString()
  }, clientId);
};

/**
 * Handle chat messages
 */
const handleChatMessage = (clientId, message) => {
  const client = connectedClients.get(clientId);
  if (!client || !client.classroomId) return;

  broadcastToClassroom(client.classroomId, {
    type: 'chat_message',
    message: message.message,
    user: client.userInfo,
    clientId,
    timestamp: new Date().toISOString()
  });
};

/**
 * Handle typing indicators
 */
const handleTypingIndicator = (clientId, message) => {
  const client = connectedClients.get(clientId);
  if (!client || !client.classroomId) return;

  broadcastToClassroom(client.classroomId, {
    type: message.type,
    user: client.userInfo,
    clientId,
    timestamp: new Date().toISOString()
  }, clientId);
};

/**
 * Broadcast message to all clients in a classroom
 * @param {string} classroomId - Classroom identifier  
 * @param {Object} message - Message to broadcast
 * @param {string} excludeClientId - Client ID to exclude from broadcast
 */
const broadcastToClassroom = (classroomId, message, excludeClientId = null) => {
  connectedClients.forEach((client, clientId) => {
    if (
      clientId !== excludeClientId &&
      client.classroomId === classroomId &&
      client.ws.readyState === client.ws.OPEN
    ) {
      sendMessage(client.ws, message);
    }
  });
};

/**
 * Send message to specific WebSocket
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} message - Message object
 */
const sendMessage = (ws, message) => {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  } catch (error) {
    logger.error('Failed to send WebSocket message:', error);
  }
};

/**
 * Send error message to client
 * @param {WebSocket} ws - WebSocket connection
 * @param {string} error - Error message
 */
const sendError = (ws, error) => {
  sendMessage(ws, {
    type: 'error',
    error,
    timestamp: new Date().toISOString()
  });
};

/**
 * Get all connected users in a classroom
 * @param {string} classroomId - Classroom identifier
 * @returns {Array} Array of user info objects
 */
const getClassroomUsers = (classroomId) => {
  const users = [];
  connectedClients.forEach((client) => {
    if (client.classroomId === classroomId && client.userInfo) {
      users.push({
        ...client.userInfo,
        clientId: client.id,
        connectedAt: client.connectedAt
      });
    }
  });
  return users;
};

/**
 * Generate unique client ID
 * @returns {string} Unique client identifier
 */
const generateClientId = () => {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Get WebSocket server statistics
 * @returns {Object} Server statistics
 */
export const getWebSocketStats = () => {
  const stats = {
    totalConnections: connectedClients.size,
    connections: [],
    classrooms: {}
  };

  connectedClients.forEach((client, clientId) => {
    stats.connections.push({
      clientId,
      ip: client.ip,
      connectedAt: client.connectedAt,
      lastPing: client.lastPing,
      classroomId: client.classroomId,
      user: client.userInfo
    });

    if (client.classroomId) {
      if (!stats.classrooms[client.classroomId]) {
        stats.classrooms[client.classroomId] = [];
      }
      stats.classrooms[client.classroomId].push(clientId);
    }
  });

  return stats;
};

export default {
  startWebSocketServer,
  getWebSocketStats,
  broadcastToClassroom
};