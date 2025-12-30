const ClickCounter = require('./../models/click_counter_model');

class ClickCounterController {
  static async recordClick(req, res) {
    try {
      const { userId, pageName } = req.body;
      
      if (!userId || !pageName) {
        return res.status(400).json({
          success: false,
          message: 'User ID and page name are required'
        });
      }
      
      const counter = await ClickCounter.getOrCreateCounter(userId, pageName);
      const updatedCounter = await counter.incrementCount();
      
      return res.status(200).json({
        success: true,
        data: {
          dailyCount: updatedCounter.counters.daily,
          totalCount: updatedCounter.counters.total,
          lastUpdated: updatedCounter.lastUpdated
        }
      });
    } catch (error) {
      console.error('Error recording click:', error);
      return res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message
      });
    }
  }
  
  static async getUserStats(req, res) {
    try {
      const { userId } = req.params;
      const { pageName } = req.query;
      
      let query = { userId };
      if (pageName) {
        query.pageName = pageName;
      }
      
      const counters = await ClickCounter.find(query)
        .select('pageName counters.daily counters.total lastUpdated')
        .lean();
      
      return res.status(200).json({
        success: true,
        data: counters
      });
    } catch (error) {
      console.error('Error getting user stats:', error);
      return res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message
      });
    }
  }
  
  static async getMultipleCounters(req, res) {
    try {
      const { userId, pageNames } = req.body;
      
      if (!userId || !Array.isArray(pageNames)) {
        return res.status(400).json({
          success: false,
          message: 'User ID and pageNames array are required'
        });
      }
      
      const counters = await ClickCounter.find({
        userId,
        pageName: { $in: pageNames }
      }).lean();
      
      const counterMap = {};
      counters.forEach(counter => {
        counterMap[counter.pageName] = {
          daily: counter.counters.daily,
          total: counter.counters.total
        };
      });
      
      pageNames.forEach(pageName => {
        if (!counterMap[pageName]) {
          counterMap[pageName] = {
            daily: 0,
            total: 0
          };
        }
      });
      
      return res.status(200).json({
        success: true,
        data: counterMap
      });
    } catch (error) {
      console.error('Error getting multiple counters:', error);
      return res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message
      });
    }
  }
  
  static async resetDailyCounters(req, res) {
    try {
      const result = await ClickCounter.updateMany(
        { 'counters.daily': { $gt: 0 } },
        { 
          $set: { 
            'counters.daily': 0,
            dailyResetDate: new Date()
          } 
        }
      );
      
      return res.status(200).json({
        success: true,
        message: `Reset ${result.modifiedCount} counters`,
        data: result
      });
    } catch (error) {
      console.error('Error resetting counters:', error);
      return res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message
      });
    }
  }
}

module.exports = ClickCounterController;