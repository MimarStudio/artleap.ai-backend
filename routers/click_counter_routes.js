const express = require('express');
const router = express.Router();
const ClickCounterController = require('./../controllers/click_counter_controller');


router.post('/clicks/record', ClickCounterController.recordClick);
router.get('/clicks/user/:userId/stats', ClickCounterController.getUserStats);
router.post('/clicks/batch', ClickCounterController.getMultipleCounters);
router.post('/clicks/admin/reset-daily', ClickCounterController.resetDailyCounters);

module.exports = router;