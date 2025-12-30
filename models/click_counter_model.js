const mongoose = require('mongoose');

const clickSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  pageName: {
    type: String,
    required: true,
    index: true
  },
  counters: {
    daily: {
      type: Number,
      default: 0
    },
    total: {
      type: Number,
      default: 0
    }
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  dailyResetDate: {
    type: Date,
    default: () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return today;
    }
  },
  history: [{
    date: {
      type: Date,
      default: Date.now
    },
    count: {
      type: Number,
      default: 0
    }
  }]
}, {
  timestamps: true
});

clickSchema.index({ userId: 1, pageName: 1 }, { unique: true });

clickSchema.pre('save', function(next) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastReset = new Date(this.dailyResetDate);
  
  if (today > lastReset) {
    this.counters.daily = 0;
    this.dailyResetDate = today;
  }
  
  this.lastUpdated = now;
  next();
});

clickSchema.methods.incrementCount = function() {
  this.counters.daily += 1;
  this.counters.total += 1;
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const existingHistory = this.history.find(
    h => h.date.getTime() === today.getTime()
  );
  
  if (existingHistory) {
    existingHistory.count += 1;
  } else {
    this.history.push({
      date: today,
      count: 1
    });
  }
  
  return this.save();
};

clickSchema.statics.getOrCreateCounter = async function(userId, pageName) {
  let counter = await this.findOne({ userId, pageName });
  
  if (!counter) {
    counter = new this({
      userId,
      pageName,
      counters: {
        daily: 0,
        total: 0
      }
    });
    await counter.save();
  }
  
  return counter;
};

module.exports = mongoose.model('ClickCounter', clickSchema);