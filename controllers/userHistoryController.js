const UserHistory = require('../models/user_history_model');
const User = require('../models/user');
const UserSubscription = require('../models/user_subscription');
const SubscriptionPlan = require('../models/subscriptionPlan_model');

exports.getUserHistory = async (req, res) => {
  try {
    const userId = req.params.userId;
    
    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userHistory = await UserHistory.findOne({ userId });
    
    const subscriptions = await UserSubscription.find({ userId, isActive: true })
      .populate('planId', 'name type price')
      .sort({ startDate: -1 });

    const allSubscriptions = await UserSubscription.find({ userId })
      .populate('planId', 'name type price')
      .sort({ startDate: -1 });

    const subscriptionPlans = await SubscriptionPlan.find({ isActive: true });

    let historyData;
    if (!userHistory) {
      historyData = new UserHistory({
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
        subscriptions: allSubscriptions.map(sub => ({
          planId: sub.planId?._id || sub.planSnapshot?.name,
          startDate: sub.startDate,
          endDate: sub.endDate,
          status: sub.isActive ? 'active' : 'inactive',
          paymentMethod: sub.paymentMethod
        }))
      });
      await historyData.save();
    } else {
      historyData = userHistory;
    }

    const response = {
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
        createdAt: user.createdAt
      },
      history: {
        accountCreated: historyData.accountCreated,
        subscriptions: historyData.subscriptions,
        imageGenerations: {
          total: user.usedImageCredits + user.usedPromptCredits,
          byPrompt: user.usedPromptCredits,
          byImage: user.usedImageCredits,
          lastGenerated: historyData.imageGenerations.lastGenerated
        },
        creditUsage: {
          totalCredits: user.totalCredits,
          usedCredits: user.usedImageCredits + user.usedPromptCredits,
          remainingCredits: user.totalCredits - (user.usedImageCredits + user.usedPromptCredits),
          lastUpdated: new Date()
        },
        lastUpdated: historyData.lastUpdated
      },
      currentSubscription: subscriptions.length > 0 ? subscriptions[0] : null,
      allSubscriptions: allSubscriptions,
      availablePlans: subscriptionPlans
    };

    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};