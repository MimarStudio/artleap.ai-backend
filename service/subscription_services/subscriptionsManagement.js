const UserSubscription = require("../../models/user_subscription");
const User = require("../../models/user");
const mongoose = require("mongoose");
const SubscriptionNotificationService = require("./subscriptionNotificationService");
const PlanManagement = require("./plansManagement");

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

class SubscriptionManagement {
  constructor() {
    this.notificationService = new SubscriptionNotificationService();
    this.planManagement = new PlanManagement();
  }

  async _validateUserAndPlan(userId, planId = null) {
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found");

    if (planId) {
      const plan = await this.planManagement.getPlanById(planId);
      if (!plan) throw new Error("Plan not found");
      return { user, plan };
    }

    return { user };
  }

  _calculateEndDate(startDate, planType) {
    const endDate = new Date(startDate);

    switch (planType) {
      case "basic":
        endDate.setDate(endDate.getDate() + 7);
        break;
      case "trial":
        endDate.setDate(endDate.getDate() + 7);
        break;
      case "standard":
        endDate.setMonth(endDate.getMonth() + 1);
        break;
      case "premium":
        endDate.setFullYear(endDate.getFullYear() + 1);
        break;
      case "free":
        endDate.setFullYear(endDate.getFullYear() + 1);
        break;
      default:
        endDate.setMonth(endDate.getMonth() + 1);
    }

    return endDate;
  }

  _createPlanSnapshot(plan) {
    return {
      name: plan.name,
      type: plan.type,
      price: plan.price,
      totalCredits: plan.totalCredits,
      imageGenerationCredits: plan.imageGenerationCredits,
      promptGenerationCredits: plan.promptGenerationCredits,
      features: plan.features,
      version: plan.version,
    };
  }

  async getUserActiveSubscription(userId) {
    try {
      return await UserSubscription.findOne({
        userId,
      })
        .populate("planId")
        .populate({ path: "userId" });
    } catch (error) {
      console.error(
        "[SubscriptionManagement] getUserActiveSubscription failed:",
        error
      );
      throw error;
    }
  }

  async createOrUpdateSubscription(
    userId,
    planId,
    paymentMethod,
    isTrial = false,
    isUpgrade = false
  ) {
    try {
      const { plan } = await this._validateUserAndPlan(userId, planId);

      if (isTrial && plan.type !== "trial") {
        throw new Error("Only trial plans can be marked as trial");
      }

      const activeSub = await this.getUserActiveSubscription(userId);
      const startDate = new Date();
      const endDate = this._calculateEndDate(startDate, plan.type);

      let subscription;

      if ((activeSub && isUpgrade) || activeSub !== null) {
        subscription = activeSub;
        subscription.planId = planId;
        subscription.startDate = startDate;
        subscription.endDate = endDate;
        subscription.paymentMethod = paymentMethod;
        subscription.autoRenew = true;
        subscription.cancelledAt = null;
        subscription.planSnapshot = this._createPlanSnapshot(plan);
        await subscription.save();

        await this.updateUserData(
          userId,
          plan,
          subscription,
          true,
          false,
          true
        );
        await this.notificationService.sendSubscriptionNotification(
          userId,
          "upgraded",
          subscription
        );
      } else {
        if (activeSub && !isTrial) {
          throw new Error("User already has an active subscription");
        }

        subscription = new UserSubscription({
          userId,
          planId,
          startDate,
          endDate,
          isTrial,
          isActive: true,
          paymentMethod,
          autoRenew: true,
          planSnapshot: this._createPlanSnapshot(plan),
        });

        await subscription.save();
        await this.updateUserData(
          userId,
          plan,
          subscription,
          true,
          isTrial,
          false
        );

        const notificationType = isTrial ? "trial_started" : "new";
        await this.notificationService.sendSubscriptionNotification(
          userId,
          notificationType,
          subscription
        );
      }

      return subscription;
    } catch (error) {
      console.error(
        "[SubscriptionManagement] createOrUpdateSubscription failed:",
        error
      );
      throw error;
    }
  }

  async cancelSubscription(userId, immediate = true) {
    try {
      const activeSub = await this.getUserActiveSubscription(userId);
      if (activeSub === null) {
        throw new Error("No active subscription found");
      }

      const alreadyCancelled =
        activeSub.cancelledAt ||
        (activeSub.autoRenew === false &&
          activeSub.planSnapshot?.type === "free");
      if (alreadyCancelled) {
        return activeSub;
      }

      if (immediate) {
        const freePlan = await this.planManagement.getPlanByType("free");

        if (freePlan) {
          activeSub.autoRenew = false;
          activeSub.cancelledAt = new Date();
          activeSub.isActive = true;
          activeSub.planId = freePlan._id;
          (activeSub.planSnapshot.name = freePlan.name),
            (activeSub.planSnapshot.type = freePlan.type),
            (activeSub.planSnapshot.price = freePlan.price),
            (activeSub.planSnapshot.dailyCredits = freePlan.dailyCredits),
            (activeSub.planSnapshot.totalCredits = freePlan.totalCredits),
            (activeSub.planSnapshot.imageGenerationCredits =
              freePlan.imageGenerationCredits),
            (activeSub.planSnapshot.promptGenerationCredits =
              freePlan.promptGenerationCredits),
            (activeSub.planSnapshot.features = freePlan.features),
            (activeSub.planSnapshot.version = freePlan.version),
            (activeSub.paymentMethod = null);

          await activeSub.save();
          await this.updateUserData(
            userId,
            freePlan,
            null,
            false,
            false,
            false
          );
        }
      }

      await this.notificationService.sendSubscriptionNotification(
        userId,
        "cancelled",
        activeSub
      );

      return activeSub;
    } catch (error) {
      console.error(
        "[SubscriptionManagement] cancelSubscription failed:",
        error
      );
      throw error;
    }
  }

  async updateUserData(
    userId,
    plan,
    subscription = null,
    isSubscribed = true,
    isTrial = false,
    carryOverCredits = false
  ) {
    try {
      const { user } = await this._validateUserAndPlan(userId);

      user.subscriptionStatus = isSubscribed ? "active" : "cancelled";
      user.isSubscribed = isSubscribed;
      user.watermarkEnabled = plan.type === "free";
      user.hasActiveTrial = isTrial;
      user.planName = plan.name;

      if (plan.type === "free") {
        this._applyFreePlanSettings(user);
      } else {
        this._applyPaidPlanSettings(user, plan, subscription, carryOverCredits);
      }

      await user.save();

      return user;
    } catch (error) {
      console.error("[SubscriptionManagement] updateUserData failed:", error);
      throw error;
    }
  }

  _applyFreePlanSettings(user) {
    user.totalCredits = 4;
    user.dailyCredits = 4;
    user.imageGenerationCredits = 0;
    user.promptGenerationCredits = 4;
    user.usedImageCredits = 0;
    user.usedPromptCredits = 0;
  }

  _applyPaidPlanSettings(user, plan, subscription, carryOverCredits) {
    const planImg = num(plan?.imageGenerationCredits);
    const planPr = num(plan?.promptGenerationCredits);
    const planTot = num(plan?.totalCredits);

    user.dailyCredits = 0;

    if (carryOverCredits === true && user.planType !== "free") {
      const remainingImageCredits = Math.max(
        0,
        num(user.imageGenerationCredits) - num(user.usedImageCredits)
      );
      const remainingPromptCredits = Math.max(
        0,
        num(user.promptGenerationCredits) - num(user.usedPromptCredits)
      );
      const remainingTotalCredits = Math.max(
        0,
        num(user.totalCredits) -
          (num(user.usedImageCredits) + num(user.usedPromptCredits))
      );

      user.imageGenerationCredits = remainingImageCredits + planImg;
      user.promptGenerationCredits = remainingPromptCredits + planPr;
      user.totalCredits = remainingTotalCredits + planTot;

      if (subscription) {
        subscription.cancelledAt = null;
        subscription.planSnapshot.totalCredits =
          remainingTotalCredits + planTot;
        subscription.planSnapshot.imageGenerationCredits =
          remainingImageCredits + planImg;
        subscription.planSnapshot.promptGenerationCredits =
          remainingPromptCredits + planPr;
      }
    } else {
      user.imageGenerationCredits = planImg;
      user.promptGenerationCredits = planPr;
      user.totalCredits = planTot;
      user.usedImageCredits = 0;
      user.usedPromptCredits = 0;
    }
  }

  async syncLocalSubscriptionStatus() {
    try {
      const allSubscriptions = await UserSubscription.find({
        isActive: true,
      }).populate("userId planId");

      let updated = 0;
      let errors = 0;

      for (const subscription of allSubscriptions) {
        try {
          const now = new Date();
          const user = await User.findById(subscription.userId?._id);

          if (!user) continue;

          if (!subscription.endDate) {
            subscription.endDate = new Date();
            await subscription.save();
          }
          if (subscription.endDate < now && subscription.isActive) {
            await this._handleExpiredSubscription(subscription);
            updated++;
            continue;
          }
          if (user.isSubscribed !== subscription.isActive) {
            user.isSubscribed = subscription.isActive;
            user.subscriptionStatus = subscription.isActive
              ? "active"
              : "cancelled";
            await user.save();
            updated++;
          }
        } catch (error) {
          errors++;
          console.error(
            `[SubscriptionManagement] Error syncing subscription ${subscription._id}:`,
            error
          );
        }
      }

      return { updated, errors };
    } catch (error) {
      console.error(
        "[SubscriptionManagement] Error syncing local subscription status:",
        error
      );
      throw error;
    }
  }

  async _handleExpiredSubscription(subscription) {
    subscription.isActive = true;
    subscription.cancelledAt = new Date();
    await subscription.save();

    const freePlan = await this.planManagement.getPlanByType("free");
    if (freePlan && subscription.userId) {
      await this.updateUserData(
        subscription.userId._id,
        freePlan,
        null,
        false,
        false,
        false
      );
    }
  }

  async fixNullEndDates() {
    try {
      const subscriptionsWithNullEndDate = await UserSubscription.find({
        endDate: null,
      });

      let fixed = 0;
      let errors = 0;

      for (const subscription of subscriptionsWithNullEndDate) {
        try {
          const planType = subscription.planSnapshot?.type || "standard";
          const newEndDate = this._calculateEndDate(new Date(), planType);

          await UserSubscription.updateOne(
            { _id: subscription._id },
            {
              $set: {
                endDate: newEndDate,
                isActive: true,
              },
            }
          );
          fixed++;
        } catch (error) {
          errors++;
          console.error(
            `[SubscriptionManagement] Error fixing subscription ${subscription._id}:`,
            error
          );
        }
      }

      return { fixed, errors };
    } catch (error) {
      console.error(
        "[SubscriptionManagement] Error fixing null endDates:",
        error
      );
      throw error;
    }
  }

  async cleanupOrphanedSubscriptions() {
    try {
      const currentHour = new Date().getHours();
      if (currentHour >= 2 && currentHour <= 5) {
        return await this._performDeepCleanup();
      } else {
        return await this._performSimpleCleanup();
      }
    } catch (error) {
      console.error("[SubscriptionManagement] Cleanup failed:", error);
      return { deleted: 0, fixed: 0 };
    }
  }

  async _performDeepCleanup() {
    try {
      let deleted = 0;
      let fixed = 0;

      const orphanedSubscriptions = await UserSubscription.aggregate([
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        {
          $match: {
            "user.0": { $exists: false },
          },
        },
        {
          $project: { _id: 1 },
        },
      ]).option({ maxTimeMS: 15000 });

      if (orphanedSubscriptions.length > 0) {
        const idsToDelete = orphanedSubscriptions.map((sub) => sub._id);
        await UserSubscription.deleteMany({ _id: { $in: idsToDelete } });
        deleted += idsToDelete.length;
      }

      const duplicateSubscriptions = await UserSubscription.aggregate([
        {
          $match: { isActive: true },
        },
        {
          $group: {
            _id: "$userId",
            count: { $sum: 1 },
            docs: { $push: "$$ROOT" },
          },
        },
        {
          $match: { count: { $gt: 1 } },
        },
        {
          $project: {
            userId: "$_id",
            docs: 1,
          },
        },
        { $limit: 100 },
      ]).option({ maxTimeMS: 15000 });

      for (const group of duplicateSubscriptions) {
        const sortedDocs = group.docs.sort(
          (a, b) =>
            new Date(b.startDate || b.createdAt) -
            new Date(a.startDate || a.createdAt)
        );

        const idsToDeactivate = sortedDocs.slice(1).map((doc) => doc._id);
        if (idsToDeactivate.length > 0) {
          await UserSubscription.updateMany(
            { _id: { $in: idsToDeactivate } },
            {
              $set: {
                isActive: true,
                cancelledAt: new Date(),
                autoRenew: false,
              },
            }
          );
          fixed += idsToDeactivate.length;
        }
      }

      return { deleted, fixed };
    } catch (error) {
      console.error("[SubscriptionManagement] Deep cleanup failed:", error);
      return await this._performSimpleCleanup();
    }
  }

  async _performSimpleCleanup() {
    try {
      let deleted = 0;
      let fixed = 0;

      const totalSubscriptions =
        await UserSubscription.countDocuments().maxTimeMS(10000);
      const batchSize = 100;
      const totalBatches = Math.ceil(totalSubscriptions / batchSize);

      for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
        const subscriptionsBatch = await UserSubscription.find({})
          .select("userId _id isActive startDate")
          .skip(batchNum * batchSize)
          .limit(batchSize)
          .maxTime(10000);

        const orphanedIds = [];
        const userSubscriptionsMap = new Map();

        for (const sub of subscriptionsBatch) {
          try {
            const userExists = await User.exists({ _id: sub.userId }).maxTime(
              5000
            );
            if (!userExists) {
              orphanedIds.push(sub._id);
            } else {
              const userIdStr = sub.userId.toString();
              if (!userSubscriptionsMap.has(userIdStr)) {
                userSubscriptionsMap.set(userIdStr, []);
              }
              userSubscriptionsMap.get(userIdStr).push(sub);
            }
          } catch (error) {
            console.warn(
              `Error checking user for subscription ${sub._id}:`,
              error.message
            );
          }
        }
        if (orphanedIds.length > 0) {
          await UserSubscription.deleteMany({ _id: { $in: orphanedIds } });
          deleted += orphanedIds.length;
        }

        for (const [userId, subscriptions] of userSubscriptionsMap) {
          if (subscriptions.length > 1) {
            const activeSubscriptions = subscriptions.filter(
              (sub) => sub.isActive
            );
            if (activeSubscriptions.length > 1) {
              const sortedSubs = activeSubscriptions.sort(
                (a, b) =>
                  new Date(b.startDate || b.createdAt) -
                  new Date(a.startDate || a.createdAt)
              );

              const idsToDeactivate = sortedSubs.slice(1).map((sub) => sub._id);
              await UserSubscription.updateMany(
                { _id: { $in: idsToDeactivate } },
                {
                  $set: {
                    isActive: true,
                    cancelledAt: new Date(),
                    autoRenew: false,
                  },
                }
              );
              fixed += idsToDeactivate.length;
            }
          }
        }
        if (batchNum < totalBatches - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      return { deleted, fixed };
    } catch (error) {
      console.error("[SubscriptionManagement] Simple cleanup failed:", error);
      return { deleted: 0, fixed: 0 };
    }
  }

  async processExpiredSubscriptions() {
    try {
      await this.processGracePeriodSubscriptions();
      await this._renewAutoRenewSubscriptions();
      await this._handleExpiredNonRenewingSubscriptions();
    } catch (error) {
      console.error(
        "[SubscriptionManagement] processExpiredSubscriptions failed:",
        error
      );
      throw error;
    }
  }

  async _renewAutoRenewSubscriptions() {
    const now = new Date();
    const expiredSubs = await UserSubscription.find({
      endDate: { $lte: now },
      isActive: true,
      isTrial: false,
      autoRenew: true,
      planId: { $ne: null },
    }).populate("userId planId");

    for (const sub of expiredSubs) {
      try {
        if (!sub.userId) {
          await this._cleanupInvalidSubscription(sub);
          continue;
        }

        const paymentSuccess = true;

        if (paymentSuccess) {
          await this._renewSubscription(sub);
        } else {
          await this.cancelSubscription(sub.userId._id, false, false);
        }
      } catch (error) {
        console.error(`Error renewing subscription ${sub._id}:`, error);
        if (sub.userId) {
          await this.cancelSubscription(sub.userId._id, false, false);
        } else {
          await this._cleanupInvalidSubscription(sub);
        }
      }
    }
  }

  async _renewSubscription(subscription) {
    const plan = subscription.planId;
    subscription.startDate = new Date();
    subscription.endDate = this._calculateEndDate(new Date(), plan.type);
    subscription.planSnapshot = this._createPlanSnapshot(plan);

    await subscription.save();

    await this.updateUserData(
      subscription.userId._id,
      plan,
      subscription,
      true,
      false,
      true
    );

    await this.notificationService.sendSubscriptionNotification(
      subscription.userId._id,
      "renewed",
      subscription
    );
  }

  async _handleExpiredNonRenewingSubscriptions() {
    const now = new Date();
    const expiredNonAutoRenew = await UserSubscription.find({
      endDate: { $lte: now },
      isActive: true,
      $or: [{ isTrial: true }, { autoRenew: false }],
      planId: { $ne: null },
    }).populate("userId planId");

    for (const sub of expiredNonAutoRenew) {
      try {
        await this.cancelSubscription(sub.userId._id, false, false);

        const freePlan = await this.planManagement.getPlanByType("free");
        if (freePlan) {
          await this.updateUserData(
            sub.userId._id,
            freePlan,
            null,
            false,
            false,
            false
          );
        }

        const notificationType = sub.isTrial ? "trial_expired" : "expired";
        await this.notificationService.sendSubscriptionNotification(
          sub.userId._id,
          notificationType,
          sub
        );
      } catch (error) {
        console.error(
          `Error processing expired subscription ${sub._id}:`,
          error
        );
      }
    }
  }

  async _cleanupInvalidSubscription(subscription) {
    subscription.isActive = true;
    subscription.cancelledAt = new Date();
    await subscription.save();
  }

  async processGracePeriodSubscriptions() {
    try {
      const now = new Date();
      const gracePeriodSubs = await UserSubscription.find({
        isActive: true,
        autoRenew: false,
        cancelledAt: { $exists: true },
        endDate: { $lte: now },
      }).populate("userId planId");

      for (const sub of gracePeriodSubs) {
        try {
          if (!sub.endDate) {
            sub.endDate = new Date();
            await sub.save();
          }

          const gracePeriodEnd = new Date(sub.endDate);
          gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 7);

          if (now > gracePeriodEnd) {
            await this.cancelSubscription(sub.userId._id, false, false);

            const freePlan = await this.planManagement.getPlanByType("free");
            if (freePlan) {
              await this.updateUserData(
                sub.userId._id,
                freePlan,
                null,
                false,
                false,
                false
              );
              await this.notificationService.sendSubscriptionNotification(
                sub.userId._id,
                "grace_period_ended",
                sub
              );
            }
          }
        } catch (error) {
          console.error(
            `Error processing grace period subscription ${sub._id}:`,
            error
          );
        }
      }
    } catch (error) {
      console.error(
        "[SubscriptionManagement] processGracePeriodSubscriptions failed:",
        error
      );
      throw error;
    }
  }

  async startFreeTrial(userId, paymentMethod) {
    try {
      const trialPlan = await this.planManagement.getPlanByType("trial");
      if (!trialPlan) {
        throw new Error("Trial plan not configured");
      }

      const { user } = await this._validateUserAndPlan(userId);

      const previousTrial = await UserSubscription.findOne({
        userId,
        "planSnapshot.type": "trial",
      });

      if (previousTrial) {
        throw new Error("You've already used your free trial");
      }

      if (!paymentMethod) {
        throw new Error("Payment method required for trial");
      }

      return await this.createOrUpdateSubscription(
        userId,
        trialPlan._id,
        paymentMethod,
        true,
        false
      );
    } catch (error) {
      console.error("[SubscriptionManagement] startFreeTrial failed:", error);
      throw error;
    }
  }

  async verifyUserSubscriptionStatus(userId) {
    try {
      const { user } = await this._validateUserAndPlan(userId);
      const activeSubscription = await this.getUserActiveSubscription(userId);

      if (activeSubscription && !user.isSubscribed) {
        user.isSubscribed = true;
        user.subscriptionStatus = "active";
        await user.save();
        return { fixed: true, previousStatus: false, newStatus: true };
      }

      if (!activeSubscription && user.isSubscribed) {
        user.isSubscribed = false;
        user.subscriptionStatus = "cancelled";
        await user.save();
        return { fixed: true, previousStatus: true, newStatus: false };
      }

      return { fixed: false, currentStatus: user.isSubscribed };
    } catch (error) {
      console.error(
        "[SubscriptionManagement] Error verifying user subscription status:",
        error
      );
      throw error;
    }
  }

  async getSubscriptionStats() {
    try {
      const [
        totalSubscriptions,
        activeSubscriptions,
        expiredSubscriptions,
        gracePeriodSubscriptions,
        trialSubscriptions,
      ] = await Promise.all([
        UserSubscription.countDocuments(),
        UserSubscription.countDocuments({
          isActive: true,
          endDate: { $gt: new Date() },
        }),
        UserSubscription.countDocuments({
          isActive: true,
          endDate: { $lte: new Date() },
        }),
        UserSubscription.countDocuments({
          isActive: true,
          autoRenew: false,
          cancelledAt: { $exists: true },
        }),
        UserSubscription.countDocuments({
          isActive: true,
          isTrial: true,
        }),
      ]);

      return {
        total: totalSubscriptions,
        active: activeSubscriptions,
        expired: expiredSubscriptions,
        gracePeriod: gracePeriodSubscriptions,
        trial: trialSubscriptions,
      };
    } catch (error) {
      console.error(
        "[SubscriptionManagement] Error getting subscription stats:",
        error
      );
      return {};
    }
  }

  async getSubscriptionIssues() {
    try {
      const issues = [];

      const orphanedSubs = await UserSubscription.aggregate([
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        { $match: { "user.0": { $exists: false } } },
      ]);

      if (orphanedSubs.length > 0) {
        issues.push({
          type: "orphaned_subscriptions",
          count: orphanedSubs.length,
          message: `Found ${orphanedSubs.length} subscriptions without valid users`,
        });
      }

      const expiredActiveSubs = await UserSubscription.countDocuments({
        isActive: true,
        endDate: { $lte: new Date() },
      });

      if (expiredActiveSubs > 0) {
        issues.push({
          type: "expired_but_active",
          count: expiredActiveSubs,
          message: `Found ${expiredActiveSubs} subscriptions that are expired but still marked as active`,
        });
      }

      const nullEndDateSubs = await UserSubscription.countDocuments({
        endDate: null,
      });

      if (nullEndDateSubs > 0) {
        issues.push({
          type: "null_endDate",
          count: nullEndDateSubs,
          message: `Found ${nullEndDateSubs} subscriptions with null endDate`,
        });
      }

      const mismatchedUsers = await User.aggregate([
        {
          $lookup: {
            from: "usersubscriptions",
            localField: "_id",
            foreignField: "userId",
            as: "subscriptions",
          },
        },
        {
          $match: {
            $or: [
              {
                isSubscribed: true,
                subscriptions: {
                  $not: {
                    $elemMatch: {
                      isActive: true,
                      endDate: { $gt: new Date() },
                    },
                  },
                },
              },
              {
                isSubscribed: false,
                subscriptions: {
                  $elemMatch: {
                    isActive: true,
                    endDate: { $gt: new Date() },
                  },
                },
              },
            ],
          },
        },
      ]);

      if (mismatchedUsers.length > 0) {
        issues.push({
          type: "status_mismatch",
          count: mismatchedUsers.length,
          message: `Found ${mismatchedUsers.length} users with mismatched subscription status`,
        });
      }

      return issues;
    } catch (error) {
      console.error(
        "[SubscriptionManagement] Error getting subscription issues:",
        error
      );
      return [];
    }
  }

  async preventiveCleanupMeasures() {
    try {
      const invalidUserRefs = await UserSubscription.find({
        userId: { $exists: true, $ne: null },
        isActive: true,
      });

      for (const sub of invalidUserRefs) {
        try {
          const user = await User.findById(sub.userId);
          if (!user) {
            await this.cancelSubscription(sub.userId, false, false);
          }
        } catch (error) {
          console.warn(
            `Error verifying user reference for subscription ${sub._id}:`,
            error.message
          );
        }
      }
    } catch (error) {
      console.error(
        "[SubscriptionManagement] Error in preventive cleanup:",
        error
      );
    }
  }

  async createSubscription(userId, planId, paymentMethod, isTrial = false) {
    return this.createOrUpdateSubscription(
      userId,
      planId,
      paymentMethod,
      isTrial,
      false
    );
  }

  async runCleanup() {
    return this.cleanupOrphanedSubscriptions();
  }

  async simpleCleanupOrphanedSubscriptions() {
    return this._performSimpleCleanup();
  }
}

module.exports = SubscriptionManagement;
