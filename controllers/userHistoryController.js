const UserHistory = require('../models/user_history_model');
const User = require('../models/user');
const UserSubscription = require('../models/user_subscription');
const SubscriptionPlan = require('../models/subscriptionPlan_model');

exports.getAllUsersHistory = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    
    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const searchQuery = search ? {
      $or: [
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ]
    } : {};

    const users = await User.find(searchQuery)
      .select('-password')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalUsers = await User.countDocuments(searchQuery);

    const usersHistory = await Promise.all(users.map(async (user) => {
      const userHistory = await UserHistory.findOne({ userId: user._id });
      
      const subscriptions = await UserSubscription.find({ userId: user._id, isActive: true })
        .populate('planId', 'name type price')
        .sort({ startDate: -1 })
        .lean();

      const allSubscriptions = await UserSubscription.find({ userId: user._id })
        .populate('planId', 'name type price')
        .sort({ startDate: -1 })
        .lean();

      const currentSubscription = subscriptions.length > 0 ? subscriptions[0] : null;

      let historyData = userHistory;
      if (!historyData) {
        historyData = {
          userId: user._id,
          accountCreated: user.createdAt,
          imageGenerations: {
            total: user.usedImageCredits + user.usedPromptCredits,
            byPrompt: user.usedPromptCredits,
            byImage: user.usedImageCredits,
            lastGenerated: null
          },
          creditUsage: {
            totalCredits: user.totalCredits,
            usedCredits: user.usedImageCredits + user.usedPromptCredits,
            remainingCredits: user.totalCredits - (user.usedImageCredits + user.usedPromptCredits),
            lastUpdated: new Date()
          },
          lastUpdated: new Date()
        };
      }

      return {
        userProfile: {
          _id: user._id,
          username: user.username,
          email: user.email,
          profilePic: user.profilePic,
          isSubscribed: user.isSubscribed,
          subscriptionStatus: user.subscriptionStatus,
          planName: user.planName,
          watermarkEnabled: user.watermarkEnabled,
          interests: user.interests,
          rewardCount: user.rewardCount,
          bonusCredits: user.bonusCredits,
          createdAt: user.createdAt,
          totalCredits: user.totalCredits,
          usedImageCredits: user.usedImageCredits,
          usedPromptCredits: user.usedPromptCredits
        },
        history: historyData,
        currentSubscription,
        allSubscriptions,
        subscriptionCount: allSubscriptions.length
      };
    }));

    const subscriptionPlans = await SubscriptionPlan.find({ isActive: true }).lean();

    const statistics = {
      totalUsers,
      totalPages: Math.ceil(totalUsers / limit),
      currentPage: parseInt(page),
      totalActiveSubscriptions: await UserSubscription.countDocuments({ isActive: true }),
      totalGenerations: users.reduce((sum, user) => sum + user.usedImageCredits + user.usedPromptCredits, 0),
      totalCredits: users.reduce((sum, user) => sum + user.totalCredits, 0),
      usedCredits: users.reduce((sum, user) => sum + user.usedImageCredits + user.usedPromptCredits, 0),
      averageCreditsPerUser: users.length > 0 ? 
        (users.reduce((sum, user) => sum + user.totalCredits, 0) / users.length).toFixed(2) : 0
    };

    res.status(200).json({
      success: true,
      users: usersHistory,
      statistics,
      availablePlans: subscriptionPlans,
      pagination: {
        total: totalUsers,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalUsers / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

exports.getUserHistoryById = async (req, res) => {
  try {
    const userId = req.params.userId;
    
    const user = await User.findById(userId).select('-password').lean();
    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    const userHistory = await UserHistory.findOne({ userId }).lean();
    
    const subscriptions = await UserSubscription.find({ userId, isActive: true })
      .populate('planId', 'name type price')
      .sort({ startDate: -1 })
      .lean();

    const allSubscriptions = await UserSubscription.find({ userId })
      .populate('planId', 'name type price')
      .sort({ startDate: -1 })
      .lean();

    const subscriptionPlans = await SubscriptionPlan.find({ isActive: true }).lean();

    let historyData = userHistory;
    if (!historyData) {
      historyData = {
        userId,
        accountCreated: user.createdAt,
        imageGenerations: {
          total: user.usedImageCredits + user.usedPromptCredits,
          byPrompt: user.usedPromptCredits,
          byImage: user.usedImageCredits,
          lastGenerated: null
        },
        creditUsage: {
          totalCredits: user.totalCredits,
          usedCredits: user.usedImageCredits + user.usedPromptCredits,
          remainingCredits: user.totalCredits - (user.usedImageCredits + user.usedPromptCredits),
          lastUpdated: new Date()
        },
        lastUpdated: new Date()
      };
    }

    const response = {
      success: true,
      userProfile: {
        _id: user._id,
        username: user.username,
        email: user.email,
        profilePic: user.profilePic,
        isSubscribed: user.isSubscribed,
        subscriptionStatus: user.subscriptionStatus,
        planName: user.planName,
        watermarkEnabled: user.watermarkEnabled,
        interests: user.interests,
        rewardCount: user.rewardCount,
        bonusCredits: user.bonusCredits,
        createdAt: user.createdAt,
        totalCredits: user.totalCredits,
        usedImageCredits: user.usedImageCredits,
        usedPromptCredits: user.usedPromptCredits
      },
      history: historyData,
      currentSubscription: subscriptions.length > 0 ? subscriptions[0] : null,
      allSubscriptions,
      subscriptionCount: allSubscriptions.length,
      availablePlans: subscriptionPlans
    };

    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};