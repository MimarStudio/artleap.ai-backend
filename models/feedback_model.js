const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  userId: {
    type: String,
    ref: 'User',
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  userEmail: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['bug', 'feature_request', 'improvement', 'general', 'complaint'],
    required: true
  },
  category: {
    type: String,
    enum: ['ui_ux', 'performance', 'functionality', 'content', 'pricing', 'other'],
    required: true
  },
  title: {
    type: String,
    required: true,
    maxlength: 200
  },
  description: {
    type: String,
    required: true,
    maxlength: 2000
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['pending', 'in_review', 'in_progress', 'resolved', 'wont_fix', 'duplicate'],
    default: 'pending'
  },
  appVersion: {
    type: String,
    required: true
  },
  deviceInfo: {
    platform: String,
    osVersion: String,
    deviceModel: String,
    screenSize: String
  },
  attachments: [{
    fileName: String,
    fileUrl: String,
    fileType: String,
    thumbnailUrl: String
  }],
  rating: {
    type: Number,
    min: 1,
    max: 5,
    default: null
  },
  adminResponse: {
    message: String,
    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    respondedAt: Date
  },
  tags: [String],
  metadata: {
    pageUrl: String,
    featurePath: String,
    interactionFlow: String,
    timeSpent: Number
  },
  upvotes: {
    type: Number,
    default: 0
  },
  isAnonymous: {
    type: Boolean,
    default: false
  },
  allowContact: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  resolvedAt: Date
});

feedbackSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

feedbackSchema.index({ userId: 1, createdAt: -1 });
feedbackSchema.index({ status: 1, priority: -1, createdAt: -1 });
feedbackSchema.index({ type: 1, category: 1 });
feedbackSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('Feedback', feedbackSchema);