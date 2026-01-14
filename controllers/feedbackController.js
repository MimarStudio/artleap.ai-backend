const Feedback = require('./../models/feedback_model.js');
const mongoose = require('mongoose');

class FeedbackController {
  static async createFeedback(req, res) {
    try {
      const {
        userId,
        userName,
        userEmail,
        type,
        category,
        title,
        description,
        priority,
        appVersion,
        deviceInfo,
        attachments,
        rating,
        tags,
        metadata,
        isAnonymous,
        allowContact
      } = req.body;

      const feedback = new Feedback({
        userId,
        userName: isAnonymous ? 'Anonymous' : userName,
        userEmail: isAnonymous ? null : userEmail,
        type,
        category,
        title,
        description,
        priority,
        appVersion,
        deviceInfo,
        attachments: attachments || [],
        rating,
        tags: tags || [],
        metadata: metadata || {},
        isAnonymous,
        allowContact: isAnonymous ? false : allowContact,
        status: 'pending'
      });

      await feedback.save();

      res.status(201).json({
        success: true,
        message: 'Feedback submitted successfully',
        data: feedback
      });
    } catch (error) {
      console.error('Create feedback error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to submit feedback',
        error: error.message
      });
    }
  }

  static async getAllFeedback(req, res) {
    try {
      const {
        page = 1,
        limit = 20,
        type,
        category,
        status,
        priority,
        sortBy = 'createdAt',
        sortOrder = 'desc',
        search,
        userId
      } = req.query;

      const query = {};

      if (type) query.type = type;
      if (category) query.category = category;
      if (status) query.status = status;
      if (priority) query.priority = priority;
      if (userId) query.userId = userId;

      if (search) {
        query.$or = [
          { title: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } },
          { tags: { $regex: search, $options: 'i' } }
        ];
      }

      const sortOptions = {};
      sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

      const skip = (page - 1) * limit;

      const [feedbacks, total] = await Promise.all([
        Feedback.find(query)
          .sort(sortOptions)
          .skip(skip)
          .limit(parseInt(limit))
          .populate('userId', 'name email profilePicture')
          .populate('adminResponse.respondedBy', 'name email')
          .lean(),
        Feedback.countDocuments(query)
      ]);

      res.json({
        success: true,
        data: feedbacks,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      console.error('Get all feedback error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch feedback',
        error: error.message
      });
    }
  }

  static async getFeedbackById(req, res) {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid feedback ID'
        });
      }

      const feedback = await Feedback.findById(id)
        .populate('userId', 'name email profilePicture')
        .populate('adminResponse.respondedBy', 'name email')
        .lean();

      if (!feedback) {
        return res.status(404).json({
          success: false,
          message: 'Feedback not found'
        });
      }

      res.json({
        success: true,
        data: feedback
      });
    } catch (error) {
      console.error('Get feedback by ID error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch feedback',
        error: error.message
      });
    }
  }

  static async updateFeedback(req, res) {
    try {
      const { id } = req.params;
      const {
        status,
        priority,
        adminResponse,
        tags,
        resolvedAt
      } = req.body;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid feedback ID'
        });
      }

      const updateData = {};

      if (status) updateData.status = status;
      if (priority) updateData.priority = priority;
      if (tags) updateData.tags = tags;
      if (resolvedAt) updateData.resolvedAt = resolvedAt;

      if (adminResponse) {
        updateData.adminResponse = {
          message: adminResponse.message,
          respondedBy: req.user._id,
          respondedAt: new Date()
        };
      }

      const feedback = await Feedback.findByIdAndUpdate(
        id,
        updateData,
        { new: true, runValidators: true }
      )
        .populate('userId', 'name email profilePicture')
        .populate('adminResponse.respondedBy', 'name email');

      if (!feedback) {
        return res.status(404).json({
          success: false,
          message: 'Feedback not found'
        });
      }

      res.json({
        success: true,
        message: 'Feedback updated successfully',
        data: feedback
      });
    } catch (error) {
      console.error('Update feedback error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update feedback',
        error: error.message
      });
    }
  }

  static async deleteFeedback(req, res) {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid feedback ID'
        });
      }

      const feedback = await Feedback.findByIdAndDelete(id);

      if (!feedback) {
        return res.status(404).json({
          success: false,
          message: 'Feedback not found'
        });
      }

      res.json({
        success: true,
        message: 'Feedback deleted successfully'
      });
    } catch (error) {
      console.error('Delete feedback error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete feedback',
        error: error.message
      });
    }
  }

  static async getFeedbackStats(req, res) {
    try {
      const { startDate, endDate } = req.query;
      const dateFilter = {};

      if (startDate || endDate) {
        dateFilter.createdAt = {};
        if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
        if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
      }

      const stats = await Feedback.aggregate([
        { $match: dateFilter },
        {
          $facet: {
            byType: [
              { $group: { _id: '$type', count: { $sum: 1 } } }
            ],
            byStatus: [
              { $group: { _id: '$status', count: { $sum: 1 } } }
            ],
            byCategory: [
              { $group: { _id: '$category', count: { $sum: 1 } } }
            ],
            byPriority: [
              { $group: { _id: '$priority', count: { $sum: 1 } } }
            ],
            averageRating: [
              { $match: { rating: { $ne: null } } },
              { $group: { _id: null, average: { $avg: '$rating' } } }
            ],
            recentCount: [
              {
                $match: {
                  createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
                }
              },
              { $count: 'count' }
            ]
          }
        }
      ]);

      res.json({
        success: true,
        data: stats[0]
      });
    } catch (error) {
      console.error('Get feedback stats error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch feedback statistics',
        error: error.message
      });
    }
  }

  static async addUpvote(req, res) {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid feedback ID'
        });
      }

      const feedback = await Feedback.findByIdAndUpdate(
        id,
        { $inc: { upvotes: 1 } },
        { new: true }
      );

      if (!feedback) {
        return res.status(404).json({
          success: false,
          message: 'Feedback not found'
        });
      }

      res.json({
        success: true,
        message: 'Upvote added successfully',
        data: { upvotes: feedback.upvotes }
      });
    } catch (error) {
      console.error('Add upvote error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to add upvote',
        error: error.message
      });
    }
  }

  static async getUserFeedback(req, res) {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 20 } = req.query;

      const skip = (page - 1) * limit;

      const [feedbacks, total] = await Promise.all([
        Feedback.find({ userId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate('adminResponse.respondedBy', 'name email')
          .lean(),
        Feedback.countDocuments({ userId })
      ]);

      res.json({
        success: true,
        data: feedbacks,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      console.error('Get user feedback error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch user feedback',
        error: error.message
      });
    }
  }
}

module.exports = FeedbackController;