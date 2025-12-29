const mongoose = require("mongoose");
const User = require("../models/user");
const { getDeviceTokens, sendPushNotification, saveNotification } = require("./../service/firebaseService");

const toggleFollowUser = async (req, res) => {
  try {
    const { userId, followId } = req.body;

    if (userId === followId) {
      return res.status(400).json({ error: "You cannot follow yourself" });
    }

    const user = await User.findById(userId);
    const followUser = await User.findById(followId);

    if (!user || !followUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const isFollowing = user.following.some((id) => id.toString() === followId);

    if (isFollowing) {
      user.following = user.following.filter((id) => id.toString() !== followId);
      followUser.followers = followUser.followers.filter((id) => id.toString() !== userId);
      await user.save();
      await followUser.save();

      return res.status(200).json({
        success: true,
        message: `You have unfollowed ${followUser.username}`,
      });
    } else {
      user.following.push(followId);
      followUser.followers.push(userId);
      await user.save();
      await followUser.save();

      try {
        const deviceTokens = await getDeviceTokens(followId);

        const notifData = {
          title: "New Follower 👥",
          body: `${user.username || "Someone"} started following you`,
          data: {
            type: "follow",
            followerId: user._id.toString(),
            followerName: user.username,
          },
        };

        const contextInfo = {
          action: "followUser",
          receiverUserId: followId,
          followerId: userId,
          tokenCount: deviceTokens?.length || 0,
        };

        if (deviceTokens && deviceTokens.length > 0) {
          await sendPushNotification(deviceTokens, notifData, contextInfo);
        } else {
          
        }

        await saveNotification({
          userId: followId,
          type: "user",
          title: notifData.title,
          body: notifData.body,
          data: notifData.data,
        });
      } catch (notifyError) {
        console.error("⚠️ [Push Debug] Follow notification error:", notifyError);
      }

      return res.status(200).json({
        success: true,
        message: `You are now following ${followUser.username}`,
      });
    }
  } catch (error) {
    console.error("❌ Toggle Follow error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = { toggleFollowUser };
