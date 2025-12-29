const express = require('express');
const router = express.Router();
const notificationController = require('./../controllers/notification_controller');
const { authenticateUser } = require('./../middleware/auth_middleware');
const fcmController = require("./../controllers/fcm_token_controller");

// 🔓 Public route (no middleware)
router.get('/notifications/user/:userId', notificationController.getUserNotifications);

// 🔐 Authenticated routes only
router.patch('/notifications/:notificationId/read', authenticateUser, notificationController.markAsRead);
router.patch('/notifications/mark-all-read', authenticateUser, notificationController.markAllAsRead);
router.delete('/notifications/:notificationId',authenticateUser,notificationController.deleteNotification);
// router.post('/notifications/', authenticateUser, notificationController.createNotification);
router.post("/notifications/register-token", fcmController.registerToken);

module.exports = router;