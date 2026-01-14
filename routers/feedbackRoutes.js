const express = require('express');
const router = express.Router();
const FeedbackController = require('./../controllers/feedbackController');

// Public routes
router.post('/submit', FeedbackController.createFeedback);
router.post('/:id/upvote', FeedbackController.addUpvote);

// User routes
router.get('/user/:userId', FeedbackController.getUserFeedback);

// Admin routes
router.get('/stats', FeedbackController.getFeedbackStats);
router.get('/', FeedbackController.getAllFeedback);
router.get('/:id', FeedbackController.getFeedbackById);
router.put('/:id', FeedbackController.updateFeedback);
router.delete('/:id',FeedbackController.deleteFeedback);

module.exports = router;