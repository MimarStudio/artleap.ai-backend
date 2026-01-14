const UserHistory = require('../models/user_history_model');
const User = require('../models/user');
const UserSubscription = require('../models/user_subscription');
const SubscriptionPlan = require('../models/subscriptionPlan_model');

exports.getAllUsersHistory = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      search = '', 
      sortBy = 'createdAt', 
      sortOrder = 'desc',
      subscriptionStatus = 'all',
      planType = 'all'
    } = req.query;
    
    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    // Build search query - handle email safely
    let searchQuery = {};
    
    if (search) {
      searchQuery = {
        $or: [
          { username: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      };
    }

    // Add subscription status filter if not 'all'
    if (subscriptionStatus !== 'all') {
      if (subscriptionStatus === 'none') {
        searchQuery.subscriptionStatus = 'none';
      } else {
        searchQuery.subscriptionStatus = subscriptionStatus;
      }
    }

    // Add plan type filter if not 'all'
    if (planType !== 'all') {
      searchQuery.planName = { $regex: planType, $options: 'i' };
    }

    try {
      // Get users with pagination - use find with no email filter first
      const users = await User.find(searchQuery)
        .select('-password')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean();

      const totalUsers = await User.countDocuments(searchQuery);

      // Process users with error handling for each
      const usersHistory = [];
      
      for (const user of users) {
        try {
          const userHistory = await UserHistory.findOne({ userId: user._id }).lean();
          
          const subscriptions = await UserSubscription.find({ userId: user._id, isActive: true })
            .populate('planId', 'name type price')
            .sort({ startDate: -1 })
            .lean();

          const allSubscriptions = await UserSubscription.find({ userId: user._id })
            .populate('planId', 'name type price')
            .sort({ startDate: -1 })
            .lean();

          const currentSubscription = subscriptions.length > 0 ? subscriptions[0] : null;

          // Calculate usage with safe defaults
          const usedImageCredits = user.usedImageCredits || 0;
          const usedPromptCredits = user.usedPromptCredits || 0;
          const totalGenerations = usedImageCredits + usedPromptCredits;
          const totalCredits = user.totalCredits || 4;
          const usedCredits = totalGenerations;
          const remainingCredits = Math.max(0, totalCredits - usedCredits);

          let historyData = userHistory;
          if (!historyData) {
            historyData = {
              userId: user._id,
              accountCreated: user.createdAt,
              imageGenerations: {
                total: totalGenerations,
                byPrompt: usedPromptCredits,
                byImage: usedImageCredits,
                lastGenerated: null
              },
              creditUsage: {
                totalCredits: totalCredits,
                usedCredits: usedCredits,
                remainingCredits: remainingCredits,
                lastUpdated: new Date()
              },
              lastUpdated: new Date()
            };
          }

          usersHistory.push({
            userProfile: {
              _id: user._id,
              username: user.username || 'Unknown',
              email: user.email || 'No email', // Provide default if email is missing
              profilePic: user.profilePic || '',
              isSubscribed: user.isSubscribed || false,
              subscriptionStatus: user.subscriptionStatus || 'none',
              planName: user.planName || 'Free',
              watermarkEnabled: user.watermarkEnabled !== false,
              interests: user.interests || { selected: [] },
              rewardCount: user.rewardCount || { dailyCount: 0, totalCount: 0 },
              bonusCredits: user.bonusCredits || false,
              createdAt: user.createdAt || new Date(),
              totalCredits: totalCredits,
              usedImageCredits: usedImageCredits,
              usedPromptCredits: usedPromptCredits
            },
            history: historyData,
            currentSubscription,
            allSubscriptions: allSubscriptions || [],
            subscriptionCount: allSubscriptions.length || 0
          });
        } catch (userError) {
          console.warn(`Skipping user ${user._id} due to error:`, userError.message);
          continue;
        }
      }

      const subscriptionPlans = await SubscriptionPlan.find({ isActive: true }).lean();

      // Calculate statistics
      const totalActiveSubscriptions = await UserSubscription.countDocuments({ isActive: true });
      
      // Recalculate totals from successfully processed users
      const totalGenerations = usersHistory.reduce((sum, user) => {
        return sum + (user.userProfile.usedImageCredits || 0) + (user.userProfile.usedPromptCredits || 0);
      }, 0);
      
      const totalCredits = usersHistory.reduce((sum, user) => sum + (user.userProfile.totalCredits || 4), 0);
      const usedCredits = usersHistory.reduce((sum, user) => {
        return sum + (user.userProfile.usedImageCredits || 0) + (user.userProfile.usedPromptCredits || 0);
      }, 0);

      const statistics = {
        totalUsers,
        totalPages: Math.ceil(totalUsers / limit),
        currentPage: parseInt(page),
        totalActiveSubscriptions,
        totalGenerations,
        totalCredits,
        usedCredits,
        averageCreditsPerUser: usersHistory.length > 0 ? 
          (totalCredits / usersHistory.length).toFixed(2) : '0.00'
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
    } catch (dbError) {
      // If there's a database error, try to get users without email filter
      console.error('Database error, trying alternative query:', dbError);
      
      // Use a more forgiving query
      const users = await User.find({})
        .select('-password')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean();

      // Process users (similar to above but simpler)
      const usersHistory = users.map(user => ({
        userProfile: {
          _id: user._id,
          username: user.username || 'Unknown',
          email: user.email || 'No email',
          // ... other fields with defaults
        },
        history: {
          imageGenerations: {
            total: (user.usedImageCredits || 0) + (user.usedPromptCredits || 0),
            byPrompt: user.usedPromptCredits || 0,
            byImage: user.usedImageCredits || 0
          },
          creditUsage: {
            totalCredits: user.totalCredits || 4,
            usedCredits: (user.usedImageCredits || 0) + (user.usedPromptCredits || 0),
            remainingCredits: Math.max(0, (user.totalCredits || 4) - ((user.usedImageCredits || 0) + (user.usedPromptCredits || 0)))
          }
        }
      }));

      res.status(200).json({
        success: true,
        users: usersHistory,
        statistics: {
          totalUsers: users.length,
          totalPages: 1,
          currentPage: 1
        },
        availablePlans: [],
        pagination: {
          total: users.length,
          page: 1,
          limit: parseInt(limit),
          totalPages: 1
        }
      });
    }
  } catch (error) {
    console.error('Error in getAllUsersHistory:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch users history',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
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

    // Calculate with defaults
    const usedImageCredits = user.usedImageCredits || 0;
    const usedPromptCredits = user.usedPromptCredits || 0;
    const totalGenerations = usedImageCredits + usedPromptCredits;
    const totalCredits = user.totalCredits || 4;
    const usedCredits = totalGenerations;
    const remainingCredits = Math.max(0, totalCredits - usedCredits);

    let historyData = userHistory;
    if (!historyData) {
      historyData = {
        userId,
        accountCreated: user.createdAt,
        imageGenerations: {
          total: totalGenerations,
          byPrompt: usedPromptCredits,
          byImage: usedImageCredits,
          lastGenerated: null
        },
        creditUsage: {
          totalCredits: totalCredits,
          usedCredits: usedCredits,
          remainingCredits: remainingCredits,
          lastUpdated: new Date()
        },
        lastUpdated: new Date()
      };
    }

    const response = {
      success: true,
      userProfile: {
        _id: user._id,
        username: user.username || 'Unknown',
        email: user.email || '',
        profilePic: user.profilePic || '',
        isSubscribed: user.isSubscribed || false,
        subscriptionStatus: user.subscriptionStatus || 'none',
        planName: user.planName || 'Free',
        watermarkEnabled: user.watermarkEnabled !== false,
        interests: user.interests || { selected: [] },
        rewardCount: user.rewardCount || { dailyCount: 0, totalCount: 0 },
        bonusCredits: user.bonusCredits || false,
        createdAt: user.createdAt || new Date(),
        totalCredits: totalCredits,
        usedImageCredits: usedImageCredits,
        usedPromptCredits: usedPromptCredits
      },
      history: historyData,
      currentSubscription: subscriptions.length > 0 ? subscriptions[0] : null,
      allSubscriptions: allSubscriptions || [],
      subscriptionCount: allSubscriptions.length || 0,
      availablePlans: subscriptionPlans
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching user history by ID:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch user history',
      message: error.message 
    });
  }
};