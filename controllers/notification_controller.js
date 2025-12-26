const mongoose = require("mongoose");
const Notification = require("./../models/notification_model");
const User = require("./../models/user");
const admin = require("firebase-admin");
const {
  saveNotification,
  getDeviceTokens,
  sendPushNotification,
} = require("./../service/firebaseService");

const isValidObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(id);
};

const getUserNotifications = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 40 } = req.query;


    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required",
      });
    }

    const user = await User.findById(userId).select('hiddenNotifications');

    const hiddenNotifications = user?.hiddenNotifications || [];

    const hiddenIds = hiddenNotifications.map(id => {
      const isValid = isValidObjectId(id);
      return isValid ? new mongoose.Types.ObjectId(id) : id;
    });

    const aggregate = Notification.aggregate([
      {
        $match: {
          $and: [
            {
              $or: [
                { userId: userId },
                { type: 'general' }
              ]
            },
            {
              _id: { $nin: hiddenIds }
            }
          ]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $project: {
          _id: 1,
          userId: 1,
          type: 1,
          title: 1,
          body: 1,
          data: 1,
          isRead: 1,
          createdAt: 1
        }
      }
    ]);

    const options = {
      page: 1,
      limit: Number.MAX_SAFE_INTEGER,
      sort: { createdAt: -1 }
    };

    const notifications = await Notification.aggregatePaginate(aggregate, options);

    res.status(200).json({
      success: true,
      data: notifications,
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while fetching notifications",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const markAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const { userId } = req.user;


    if (!notificationId) {
      return res.status(400).json({
        success: false,
        message: "Notification ID is required",
      });
    }

    const query = {
      $or: [{ userId }, { type: "general" }],
    };

    if (isValidObjectId(notificationId)) {
      query._id = new mongoose.Types.ObjectId(notificationId);
    } else {
      query._id = notificationId;
    }

    const notification = await Notification.findOneAndUpdate(
      query,
      { isRead: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found or not accessible by user",
      });
    }
    res.status(200).json({
      success: true,
      data: notification,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while marking notification as read",
    });
  }
};

const deleteNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const { userId } = req.body;

    if (!notificationId) {
      return res.status(400).json({
        success: false,
        message: "Notification ID is required",
      });
    }

    const idToQuery = isValidObjectId(notificationId)
      ? new mongoose.Types.ObjectId(notificationId)
      : notificationId;

    const notification = await Notification.findOne({ _id: idToQuery });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    if (notification.type === "general") {
      const updateResult = await User.findOneAndUpdate(
        { _id: userId },
        { $addToSet: { hiddenNotifications: notification._id } },
        { new: true }
      );

      if (!updateResult) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      return res.status(200).json({
        success: true,
        message: "General notification hidden for this user",
        data: {
          hiddenNotificationId: notification._id,
          hiddenCount: updateResult.hiddenNotifications.length,
        },
      });
    }

    if (notification.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to delete this notification",
      });
    }

    const deleteResult = await Notification.deleteOne({
      _id: notification._id,
    });

    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Notification not found or already deleted",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Notification deleted successfully",
      data: {
        deletedNotificationId: notification._id,
      },
    });
  } catch (error) {
    console.error("Error deleting notification:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while deleting notification",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

const createNotification = async (req, res) => {
  try {
    const { userId: rawUserId, type = "general", title, body, data } = req.body;
    const userId = rawUserId || req.user?._id || null;

    // Validate inputs
    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: "Title and body are required",
      });
    }

    if (!["general", "user"].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification type. Must be 'general' or 'user'",
      });
    }

    if (type === "general" && userId) {
      return res.status(400).json({
        success: false,
        message: "General notifications cannot have a userId",
      });
    }

    if (type === "user" && !userId) {
      return res.status(400).json({
        success: false,
        message: "User-specific notifications require a userId",
      });
    }

    // Prevent duplicate general notifications
    if (type === "general") {
      const existing = await Notification.findOne({
        type: "general",
        title: title.trim(),
        body: body.trim(),
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });

      if (existing) {
        return res.status(200).json({
          success: true,
          data: existing,
          message: "Similar general notification already exists",
        });
      }
    }

    // Save notification in DB
    const notification = new Notification({
      title: title.trim(),
      body: body.trim(),
      data: data || {},
      type,
      userId: type === "user" ? userId : null,
    });

    await notification.save();

    // 🔔 Push notification logic
    try {
      if (type === "general") {
        // Push to all users subscribed to topic "all"
        await admin.messaging().send({
          notification: { title, body },
          data: data || {},
          topic: "all",
        });
      } else {
        // Push to specific user(s)
        const tokens = await getDeviceTokens(userId);

        if (tokens.length > 0) {
          await sendPushNotification(tokens, { title, body, data });
        } else {
          console.warn(`⚠️ No device tokens found for user ${userId}`);
        }
      }
    } catch (pushError) {
      console.error("❌ Error sending push notification:", pushError.message || pushError);
    }

    res.status(201).json({
      success: true,
      data: notification,
    });
  } catch (error) {
    console.error("Error creating notification:", error);
    const status = error.message.includes("Duplicate") ? 409 : 500;
    res.status(status).json({
      success: false,
      message: error.message || "Internal server error while creating notification",
    });
  }
};


const markAllAsRead = async (req, res) => {
  try {
    const { userId } = req.user;
    const { notificationIds } = req.body;

    if (!notificationIds || !Array.isArray(notificationIds)) {
      return res.status(400).json({
        success: false,
        message: "Notification IDs array is required",
      });
    }

    if (notificationIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Notification IDs array cannot be empty",
      });
    }

    const ids = notificationIds.map((id) => {
      const isValid = isValidObjectId(id);
      return isValid ? new mongoose.Types.ObjectId(id) : id;
    });

    const userNotifications = await Notification.find({
      _id: { $in: ids },
      $or: [{ userId: userId }, { type: "general" }],
    });

    if (userNotifications.length !== notificationIds.length) {
      return res.status(403).json({
        success: false,
        message: "Some notifications do not belong to user",
      });
    }

    const result = await Notification.updateMany(
      {
        _id: { $in: ids },
        isRead: false,
      },
      { $set: { isRead: true } }
    );

    res.status(200).json({
      success: true,
      data: {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while marking notifications as read",
    });
  }
};

module.exports = {
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  createNotification,
};