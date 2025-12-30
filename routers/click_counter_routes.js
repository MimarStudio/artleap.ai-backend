const express = require('express');
const router = express.Router();
const ClickCounterController = require('./../controllers/click_counter_controller');


router.post('/click/record', ClickCounterController.recordClick);
router.get('/click/user/:userId/stats', ClickCounterController.getUserStats);
router.post('/click/batch', ClickCounterController.getMultipleCounters);
router.post('/click/admin/reset-daily', ClickCounterController.resetDailyCounters);

module.exports = router;