const User = require("./../models/user");
const UserSubscription = require("./../models/user_subscription");

const addRewardedAdCredits = async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required"
      });
    }

    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const currentDailyCredits = user.dailyCredits || 0;
    const currentTotalCredits = user.totalCredits || 0;
    const currentDailyRewardCount = user.rewardCount?.dailyCount || 0;
    const currentTotalRewardCount = user.rewardCount?.totalCount || 0;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastRewardDate = user.rewardCount?.lastRewardDate ? 
      new Date(user.rewardCount.lastRewardDate).setHours(0, 0, 0, 0) : null;
    
    let newDailyCount = currentDailyRewardCount;
    let newTotalCount = currentTotalRewardCount + 1;
    
    if (lastRewardDate !== today.getTime()) {
      newDailyCount = 1;
    } else {
      newDailyCount = currentDailyRewardCount + 1;
    }
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $inc: {
          dailyCredits: 2,
          totalCredits: 2
        },
        $set: {
          'rewardCount.dailyCount': newDailyCount,
          'rewardCount.totalCount': newTotalCount,
          'rewardCount.lastRewardDate': new Date()
        }
      },
      { new: true }
    ).select('dailyCredits totalCredits planName username email rewardCount');

    const activeSubscription = await UserSubscription.findOne({
      userId: userId,
      isActive: true,
      endDate: { $gt: new Date() }
    });

    const responseData = {
      userId: userId,
      username: updatedUser.username,
      email: updatedUser.email,
      planName: updatedUser.planName,
      creditsAdded: 2,
      dailyCredits: updatedUser.dailyCredits,
      totalCredits: updatedUser.totalCredits,
      previousDailyCredits: currentDailyCredits,
      previousTotalCredits: currentTotalCredits,
      rewardCount: {
        dailyCount: updatedUser.rewardCount.dailyCount,
        totalCount: updatedUser.rewardCount.totalCount,
        lastRewardDate: updatedUser.rewardCount.lastRewardDate
      },
      timestamp: new Date().toISOString()
    };

    if (activeSubscription) {
      await UserSubscription.findByIdAndUpdate(
        activeSubscription._id,
        {
          $inc: {
            'planSnapshot.totalCredits': 2,
            'planSnapshot.imageGenerationCredits': 2,
            'planSnapshot.promptGenerationCredits': 2
          }
        },
        { new: true }
      );

      responseData.subscriptionUpdated = true;
      responseData.subscriptionPlanId = activeSubscription.planId;
      responseData.subscriptionTotalCredits = activeSubscription.planSnapshot.totalCredits + 2;
    } else {
      responseData.subscriptionUpdated = false;
      responseData.message = "No active subscription found, updated only user credits";
    }

    res.status(200).json({
      success: true,
      message: "Successfully added 2 credits",
      data: responseData
    });

  } catch (error) {
    console.error("Error adding rewarded ad credits:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

const getUserCreditsStatus = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .select('dailyCredits totalCredits planName username rewardCount');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastRewardDate = user.rewardCount?.lastRewardDate ? 
      new Date(user.rewardCount.lastRewardDate).setHours(0, 0, 0, 0) : null;
    
    const canWatchAd = lastRewardDate !== today.getTime() || 
      (user.rewardCount?.dailyCount || 0) < 2;

    const activeSubscription = await UserSubscription.findOne({
      userId: userId,
      isActive: true,
      endDate: { $gt: new Date() }
    }).select('planSnapshot isActive endDate');

    let subscriptionCredits = null;
    if (activeSubscription) {
      subscriptionCredits = {
        totalCredits: activeSubscription.planSnapshot.totalCredits,
        imageGenerationCredits: activeSubscription.planSnapshot.imageGenerationCredits,
        promptGenerationCredits: activeSubscription.planSnapshot.promptGenerationCredits,
        subscriptionActive: activeSubscription.isActive,
        subscriptionEndDate: activeSubscription.endDate
      };
    }

    res.status(200).json({
      success: true,
      data: {
        userId: user._id,
        username: user.username,
        dailyCredits: user.dailyCredits,
        totalCredits: user.totalCredits,
        planName: user.planName,
        rewardCount: {
          dailyCount: user.rewardCount?.dailyCount || 0,
          totalCount: user.rewardCount?.totalCount || 0,
          lastRewardDate: user.rewardCount?.lastRewardDate || null
        },
        canWatchAd: canWatchAd,
        remainingAdsToday: Math.max(0, 2 - (user.rewardCount?.dailyCount || 0)),
        subscription: subscriptionCredits
      }
    });

  } catch (error) {
    console.error("Error getting user credits status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

module.exports = {
  addRewardedAdCredits,
  getUserCreditsStatus,
};