const express = require('express');
const router = express.Router();
const userHistoryController = require('../controllers/userHistoryController');

router.get('/', userHistoryController.getAllUsersHistory);
router.get('/:userId', userHistoryController.getUserHistoryById);

module.exports = router;