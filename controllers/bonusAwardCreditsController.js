const mongoose = require('mongoose');
const User = require('../models/user');
const UserSubscription = require('../models/user_subscription');
const Notification = require('./../models/notification_model');
const { sendPushNotification, getDeviceTokens, initializeFirebase } = require('./../service/firebaseService');


async function awardCreditsToLegacyFreeUsers(targetDate) {

    try {
        const eligibleUsers = await User.find({
            createdAt: { $lt: targetDate },
            planName: 'Free',
            bonusCredits: false,
        }).lean();

        if (eligibleUsers.length === 0) {
            return { success: true, message: 'No eligible users found.', usersUpdated: 0 };
        }

        const BONUS_CREDITS = 10;
        const updateResults = [];
        const userIds = [];

        for (const user of eligibleUsers) {
            try {
                const currentDailyCredits = user.dailyCredits || 0;
                const currentTotalCredits = user.totalCredits || 0;

                const updateResult = await User.updateOne(
                    { _id: user._id },
                    {
                        $inc: {
                            dailyCredits: BONUS_CREDITS,
                            totalCredits: BONUS_CREDITS
                        },
                        $set: {
                            'rewardCount.legacyBonusAwarded': true,
                            'rewardCount.legacyBonusDate': new Date(),
                            'rewardCount.legacyBonusCredits': BONUS_CREDITS,
                            bonusCredits: true,
                        }
                    }
                );

                if (updateResult.modifiedCount > 0) {
                    updateResults.push({
                        userId: user._id,
                        updated: true,
                        newDailyCredits: currentDailyCredits + BONUS_CREDITS,
                        newTotalCredits: currentTotalCredits + BONUS_CREDITS
                    });
                    userIds.push(user._id);
                    await saveNotification(user, BONUS_CREDITS);
                }

            } catch (error) {
                console.error(`Error updating user ${user._id}:`, error);
            }
        }

        if (userIds.length > 0) {
            const subscriptionUpdateResult = await UserSubscription.updateMany(
                {
                    userId: { $in: userIds },
                    isActive: true
                },
                {
                    $inc: {
                        'planSnapshot.totalCredits': BONUS_CREDITS,
                        'planSnapshot.imageGenerationCredits': BONUS_CREDITS
                    }
                }
            );
        }

        const result = {
            success: true,
            usersUpdated: updateResults.length,
            subscriptionsUpdated: userIds.length > 0 ? await UserSubscription.countDocuments({
                userId: { $in: userIds },
                isActive: true
            }) : 0,
            totalEligibleUsers: eligibleUsers.length,
            creditsAwarded: BONUS_CREDITS,
            message: `Successfully awarded ${BONUS_CREDITS} credits to ${updateResults.length} legacy free users.`
        };

        return result;

    } catch (error) {
        console.error('Error in awardCreditsToLegacyFreeUsers:', error);
        throw new Error(`Failed to process credit award: ${error.message}`);
    }
}

async function saveNotification(user, creditsAwarded) {
  try {
    const notification = {
      userId: user._id,
      type: 'user',
      title: '🎉 Free Credits Awarded!',
      body: `You've received ${creditsAwarded} bonus credits for being a valued legacy user!`,
      data: {
        creditsAwarded: String(creditsAwarded),
        reason: 'legacy_user_bonus',
        awardDate: new Date().toISOString(),
      }
    };

    const saved = await Notification.create(notification);

    const tokens = await getDeviceTokens(user._id);

    if (!tokens || tokens.length === 0) {
      console.warn(`⚠️ No device tokens found for user ${user._id}`);
      return saved;
    }

    await sendPushNotification(tokens, {
      title: notification.title,
      body: notification.body,
      data: notification.data,
    });

    return saved;
  } catch (error) {
    console.error(`❌ Notification error for user ${user._id}:`, error.message);
    return null;
  }
}


module.exports = { awardCreditsToLegacyFreeUsers };