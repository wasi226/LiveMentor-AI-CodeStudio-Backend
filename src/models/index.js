/**
 * MongoDB Models using Mongoose
 * All entity schemas for the liveMentor application
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

// User Model (for authentication)
const UserSchema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  full_name: {
    type: String,
    required: true,
    trim: true
  },
  role: {
    type: String,
    enum: ['student', 'faculty', 'admin'],
    default: 'student'
  },
  rollNumber: {
    type: String,
    sparse: true, // Only for students
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true, // Adds createdAt and updatedAt
  collection: 'users'
});

// Indexes for User
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ role: 1 });
UserSchema.index({ rollNumber: 1 }, { sparse: true });

// Classroom Model
const ClassroomSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  language: {
    type: String,
    required: true,
    default: 'javascript',
    enum: ['javascript', 'python', 'java', 'cpp', 'typescript', 'go', 'rust', 'c', 'csharp']
  },
  faculty_email: {
    type: String,
    required: true,
    ref: 'User'
  },
  student_emails: [{
    type: String,
    ref: 'User'
  }],
  max_students: {
    type: Number,
    default: 30,
    min: 1,
    max: 100
  },
  settings: {
    type: Schema.Types.Mixed,
    default: {}
  },
  is_active: {
    type: Boolean,
    default: true
  },
  description: {
    type: String,
    trim: true
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  collection: 'classrooms'
});

// Indexes for Classroom
ClassroomSchema.index({ code: 1 }, { unique: true });
ClassroomSchema.index({ faculty_email: 1 });
ClassroomSchema.index({ is_active: 1, faculty_email: 1 });

// Assignment Model
const AssignmentSchema = new Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  classroom_id: {
    type: Schema.Types.ObjectId,
    ref: 'Classroom',
    required: true
  },
  language: {
    type: String,
    required: true,
    enum: ['javascript', 'python', 'java', 'cpp', 'typescript', 'go', 'rust', 'c', 'csharp']
  },
  difficulty: {
    type: String,
    enum: ['easy', 'medium', 'hard'],
    default: 'medium'
  },
  starter_code: {
    type: String,
    default: ''
  },
  solution_code: {
    type: String,
    default: ''
  },
  test_cases: [{
    input: String,
    expected_output: String,
    description: String,
    weight: { type: Number, default: 1 }
  }],
  max_score: {
    type: Number,
    default: 100,
    min: 0
  },
  time_limit: {
    type: Number,
    default: 300, // seconds
    min: 30,
    max: 3600
  },
  memory_limit: {
    type: Number,
    default: 128, // MB
    min: 64,
    max: 1024
  },
  due_date: {
    type: Date
  },
  is_published: {
    type: Boolean,
    default: false
  },
  is_assigned: {
    type: Boolean,
    default: false
  },
  assigned_to: {
    type: String,
    enum: ['all', 'specific'],
    default: null,
    sparse: true
  },
  assigned_date: {
    type: Date,
    sparse: true
  },
  assigned_by: {
    type: String,
    ref: 'User',
    sparse: true
  },
  created_by: {
    type: String,
    required: true,
    ref: 'User'
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  collection: 'assignments'
});

// Indexes for Assignment
AssignmentSchema.index({ classroom_id: 1 });
AssignmentSchema.index({ created_by: 1 });
AssignmentSchema.index({ is_published: 1, due_date: 1 });
AssignmentSchema.index({ is_assigned: 1, classroom_id: 1 });

// Submission Model
const SubmissionSchema = new Schema({
  assignment_id: {
    type: Schema.Types.ObjectId,
    ref: 'Assignment',
    required: true
  },
  classroom_id: {
    type: Schema.Types.ObjectId,
    ref: 'Classroom',
    required: true
  },
  student_email: {
    type: String,
    required: true,
    ref: 'User'
  },
  code: {
    type: String,
    required: true
  },
  language: {
    type: String,
    required: true,
    enum: ['javascript', 'python', 'java', 'cpp', 'typescript', 'go', 'rust', 'c', 'csharp']
  },
  status: {
    type: String,
    enum: ['draft', 'submitted', 'grading', 'graded', 'returned', 'running', 'passed', 'failed', 'error'],
    default: 'submitted'
  },
  submitted_at: {
    type: Date
  },
  score: {
    type: Number,
    default: 0,
    min: 0
  },
  max_score: {
    type: Number,
    default: 100
  },
  test_results: [{
    test_case_id: String,
    passed: Boolean,
    input: String,
    expected_output: String,
    actual_output: String,
    execution_time: Number,
    memory_used: Number,
    error_message: String
  }],
  execution_time: {
    type: Number, // milliseconds
    default: 0
  },
  memory_used: {
    type: Number, // MB
    default: 0
  },
  error_count: {
    type: Number,
    default: 0
  },
  feedback: {
    type: String
  },
  graded_by: {
    type: String,
    ref: 'User'
  },
  graded_at: {
    type: Date
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  collection: 'submissions'
});

// Indexes for Submission
SubmissionSchema.index({ assignment_id: 1, student_email: 1 });
SubmissionSchema.index({ classroom_id: 1, student_email: 1 });
SubmissionSchema.index({ student_email: 1 });
SubmissionSchema.index({ status: 1 });
SubmissionSchema.index({ createdAt: -1 });

// ChatMessage Model
const ChatMessageSchema = new Schema({
  classroom_id: {
    type: Schema.Types.ObjectId,
    ref: 'Classroom',
    required: true
  },
  sender_email: {
    type: String,
    required: true,
    ref: 'User'
  },
  sender_name: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  message_type: {
    type: String,
    enum: ['text', 'code', 'file', 'system', 'announcement'],
    default: 'text'
  },
  code_language: {
    type: String,
    enum: ['javascript', 'python', 'java', 'cpp', 'typescript', 'go', 'rust', 'c', 'csharp']
  },
  is_private: {
    type: Boolean,
    default: false
  },
  reply_to: {
    type: Schema.Types.ObjectId,
    ref: 'ChatMessage'
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  collection: 'chatmessages'
});

// Indexes for ChatMessage
ChatMessageSchema.index({ classroom_id: 1, createdAt: -1 });
ChatMessageSchema.index({ sender_email: 1 });

// StudentActivity Model
const StudentActivitySchema = new Schema({
  classroom_id: {
    type: Schema.Types.ObjectId,
    ref: 'Classroom',
    required: true,
    index: true
  },
  room_id: {
    type: String,
    index: true
  },
  sender_email: {
    type: String,
    required: true,
    index: true
  },
  sender_name: {
    type: String,
    required: true
  },
  event_type: {
    type: String,
    required: true,
    index: true
  },
  is_private: {
    type: Boolean,
    default: false,
    index: true
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  collection: 'student_activities'
});

StudentActivitySchema.index({ classroom_id: 1, createdAt: -1 });
StudentActivitySchema.index({ classroom_id: 1, sender_email: 1, createdAt: -1 });

// InterventionRoom Model
const InterventionRoomSchema = new Schema({
  room_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  classroom_id: {
    type: Schema.Types.ObjectId,
    ref: 'Classroom',
    required: true,
    index: true
  },
  faculty_email: {
    type: String,
    required: true,
    index: true
  },
  student_email: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'closed'],
    default: 'active',
    index: true
  },
  closed_at: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  collection: 'intervention_rooms'
});

InterventionRoomSchema.index({ classroom_id: 1, student_email: 1, status: 1, createdAt: -1 });

// Create and export models
export const User = mongoose.model('User', UserSchema);
export const Classroom = mongoose.model('Classroom', ClassroomSchema);
export const Assignment = mongoose.model('Assignment', AssignmentSchema);
export const Submission = mongoose.model('Submission', SubmissionSchema);
export const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);
export const StudentActivity = mongoose.model('StudentActivity', StudentActivitySchema);
export const InterventionRoom = mongoose.model('InterventionRoom', InterventionRoomSchema);

// Export all models as default
export default {
  User,
  Classroom,
  Assignment,
  Submission,
  ChatMessage,
  StudentActivity,
  InterventionRoom
};