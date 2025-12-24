const UserSubscription = require("../../models/user_subscription");
const User = require("../../models/user");
const mongoose = require("mongoose");
const NotificationService = require("./notificationService");
const PlanManagement = require("./plansManagement");
const PaymentProcessing = require("./paymentProcessing");

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

class SubscriptionManagement {
  constructor() {
    this.notificationService = new NotificationService();
    this.planManagement = new PlanManagement();
    this.paymentProcessing = new PaymentProcessing(this);
    // this.createSubscriptionIndexes().catch(console.error);
  }

  // async createSubscriptionIndexes() {
  //   try {
  //     await UserSubscription.collection.createIndex({ userId: 1 });
  //     await UserSubscription.collection.createIndex({ isActive: 1 });
  //     await UserSubscription.collection.createIndex({ endDate: 1 });
  //     await UserSubscription.collection.createIndex({ userId: 1, isActive: 1 });
  //     await User.collection.createIndex({ _id: 1 });
  //   } catch (error) {
  //     console.error("[SubscriptionManagement] Error creating indexes:", error);
  //   }
  // }

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
          const user = await User.findById(subscription.userId._id);

          if (!user) {
            continue;
          }

          if (!subscription.endDate) {
            subscription.endDate = new Date();
            await subscription.save();
          }

          if (subscription.endDate < now && subscription.isActive) {
            subscription.isActive = true;
            subscription.cancelledAt = new Date();
            await subscription.save();

            const freePlan = await this.planManagement.getPlanByType("free");
            if (freePlan) {
              await this.updateUserData(
                subscription.userId._id,
                freePlan,
                null,
                false,
                false,
                false
              );
              updated++;
            }
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

  async fixNullEndDates() {
    try {
      const subscriptionsWithNullEndDate = await UserSubscription.find({
        endDate: null,
      });

      let fixed = 0;
      let errors = 0;

      for (const subscription of subscriptionsWithNullEndDate) {
        try {
          let newEndDate = new Date();

          if (subscription.planSnapshot && subscription.planSnapshot.type) {
            switch (subscription.planSnapshot.type) {
              case "basic":
                newEndDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                break;
              case "standard":
                newEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                break;
              case "premium":
                newEndDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
                break;
              case "trial":
                newEndDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                break;
              default:
                newEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            }
          }

          await UserSubscription.updateOne(
            { _id: subscription._id },
            {
              $set: {
                endDate: newEndDate,
                isActive: newEndDate > new Date(),
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
      let deleted = 0;
      let fixed = 0;

      const batchSize = 50;
      let skip = 0;
      let hasMore = true;

      while (hasMore) {
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
            $project: {
              _id: 1,
              userId: 1,
            },
          },
          { $skip: skip },
          { $limit: batchSize },
        ]).option({ maxTimeMS: 15000 });

        if (orphanedSubscriptions.length === 0) {
          hasMore = false;
          break;
        }

        const idsToDelete = orphanedSubscriptions.map((sub) => sub._id);

        if (idsToDelete.length > 0) {
          await UserSubscription.deleteMany({ _id: { $in: idsToDelete } });
          deleted += idsToDelete.length;
        }

        skip += batchSize;

        if (hasMore) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      const duplicateSubscriptions = await UserSubscription.aggregate([
        {
          $match: {
            isActive: true,
          },
        },
        {
          $group: {
            _id: "$userId",
            count: { $sum: 1 },
            docs: { $push: "$$ROOT" },
          },
        },
        {
          $match: {
            count: { $gt: 1 },
          },
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
      if (
        error.name === "MongoNetworkTimeoutError" ||
        error.name === "MongoServerSelectionError" ||
        error.codeName === "MaxTimeMSExpired"
      ) {
        return await this.simpleCleanupOrphanedSubscriptions();
      }

      console.error(
        "[SubscriptionManagement] Error cleaning up orphaned subscriptions:",
        error
      );
      return { deleted: 0, fixed: 0 };
    }
  }

  async simpleCleanupOrphanedSubscriptions() {
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
              if (!userSubscriptionsMap.has(sub.userId.toString())) {
                userSubscriptionsMap.set(sub.userId.toString(), []);
              }
              userSubscriptionsMap.get(sub.userId.toString()).push(sub);
            }
          } catch (error) {
            console.warn(
              `[SubscriptionManagement] Error checking user for subscription ${sub._id}:`,
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
      console.error("[SubscriptionManagement] Error in simple cleanup:", error);
      return { deleted: 0, fixed: 0 };
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
            sub.isActive = true;
            sub.cancelledAt = new Date();
            await sub.save();
          }
        } catch (error) {
          console.warn(
            `[SubscriptionManagement] Error verifying user reference for subscription ${sub._id}:`,
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

  async runCleanup() {
    try {
      const currentHour = new Date().getHours();
      if (currentHour >= 2 && currentHour <= 5) {
        await this.cleanupOrphanedSubscriptions();
      } else {
        await this.simpleCleanupOrphanedSubscriptions();
      }
    } catch (error) {
      console.error("[SubscriptionManagement] Cleanup failed:", error);
    }
  }

  async verifyUserSubscriptionStatus(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

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
      const totalSubscriptions = await UserSubscription.countDocuments();
      const activeSubscriptions = await UserSubscription.countDocuments({
        isActive: true,
        endDate: { $gt: new Date() },
      });
      const expiredSubscriptions = await UserSubscription.countDocuments({
        isActive: true,
        endDate: { $lte: new Date() },
      });
      const gracePeriodSubscriptions = await UserSubscription.countDocuments({
        isActive: true,
        autoRenew: false,
        cancelledAt: { $exists: true },
      });
      const trialSubscriptions = await UserSubscription.countDocuments({
        isActive: true,
        isTrial: true,
      });

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
        {
          $match: {
            "user.0": { $exists: false },
          },
        },
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

  async getUserActiveSubscription(userId) {
    try {
      const paidSubscription = await UserSubscription.findOne({
        userId,
        endDate: { $gt: new Date() },
      }).populate("planId").populate({ path: "userId" });

      return paidSubscription || null;
    } catch (error) {
      console.error(
        "[SubscriptionManagement] getUserActiveSubscription failed:",
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
      const user = await User.findOne({
        _id: mongoose.Types.ObjectId.isValid(userId)
          ? mongoose.Types.ObjectId(userId)
          : userId,
      });

      if (!user) throw new Error("User not found");

      const planImg = num(plan?.imageGenerationCredits);
      const planPr = num(plan?.promptGenerationCredits);
      const planTot = num(plan?.totalCredits);

      if (!user.currentSubscription && subscription) {
        user.currentSubscription = subscription._id;
      }

      user.subscriptionStatus = isSubscribed ? "active" : "cancelled";
      user.isSubscribed = isSubscribed;
      user.watermarkEnabled = plan.type === "free";
      user.hasActiveTrial = isTrial;
      user.planName = plan.name;
      user.planType = plan.type;

      if (plan.type === "free") {
        user.imageGenerationCredits = 0;
      } else {
        if (carryOverCredits) {
          const previouslyFree = user.planType === "free";

          if (!previouslyFree) {
            const uImg = num(user.imageGenerationCredits);
            const uPr = num(user.promptGenerationCredits);
            const uTot = num(user.totalCredits);
            const uUsedI = num(user.usedImageCredits);
            const uUsedP = num(user.usedPromptCredits);

            const remainingImageCredits = Math.max(0, uImg - uUsedI);
            const remainingPromptCredits = Math.max(0, uPr - uUsedP);
            const remainingTotalCredits = Math.max(0, uTot - (uUsedI + uUsedP));

            user.imageGenerationCredits = remainingImageCredits + planImg;
            user.promptGenerationCredits = remainingPromptCredits + planPr;
            user.totalCredits = remainingTotalCredits + planTot;

            if (subscription && subscription.planSnapshot) {
              subscription.cancelledAt = null;
              subscription.planSnapshot.totalCredits =
                remainingTotalCredits + planTot;
              subscription.planSnapshot.imageGenerationCredits =
                remainingImageCredits + planImg;
              subscription.planSnapshot.promptGenerationCredits =
                remainingPromptCredits + planPr;
              await subscription.save();
            }
          } else {
            // If previous plan was FREE → reset credits fully
            user.imageGenerationCredits = planImg;
            user.promptGenerationCredits = planPr;
            user.totalCredits = planTot;
            user.usedImageCredits = 0;
            user.usedPromptCredits = 0;
          }
        } else {
          // No carry over → full reset
          user.imageGenerationCredits = planImg;
          user.promptGenerationCredits = planPr;
          user.totalCredits = planTot;
          user.usedImageCredits = 0;
          user.usedPromptCredits = 0;
        }

        user.dailyCredits = 0;
      }

      await user.save();
      return user;
    } catch (error) {
      console.error("[SubscriptionManagement] updateUserData failed:", error);
      throw error;
    }
  }

  async createSubscription(userId, planId, paymentMethod, isTrial = false) {
    try {
      const user = await User.findOne({
        _id: mongoose.Types.ObjectId.isValid(userId)
          ? mongoose.Types.ObjectId(userId)
          : userId,
      });
      if (!user) {
        throw new Error("User not found");
      }

      const plan = await this.planManagement.getPlanById(planId);
      if (!plan) {
        throw new Error("Plan not found");
      }

      if (isTrial && plan.type !== "trial") {
        throw new Error("Only trial plans can be marked as trial");
      }

      const activeSub = await this.getUserActiveSubscription(userId);
      let subscription;

      if (activeSub && !isTrial) {
        subscription = activeSub;
        subscription.planId = planId;
        subscription.startDate = new Date();

        if (plan.type === "basic") {
          subscription.endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        } else if (plan.type === "standard") {
          subscription.endDate = new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000
          );
        } else if (plan.type === "premium") {
          subscription.endDate = new Date(
            Date.now() + 365 * 24 * 60 * 60 * 1000
          );
        } else if (plan.type === "trial") {
          subscription.endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        } else if (plan.type === "free") {
          subscription.endDate = new Date(
            Date.now() + 365 * 24 * 60 * 60 * 1000
          );
        } else {
          subscription.endDate = new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000
          );
        }

        subscription.paymentMethod = paymentMethod;
        subscription.autoRenew = true;
        subscription.cancelledAt = null;
        subscription.planSnapshot = {
          name: plan.name,
          type: plan.type,
          price: plan.price,
          totalCredits: plan.totalCredits,
          imageGenerationCredits: plan.imageGenerationCredits,
          promptGenerationCredits: plan.promptGenerationCredits,
          features: plan.features,
          version: plan.version,
        };
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
        if (activeSub && !isTrial && activeSub.planId) {
          throw new Error("User already has an active subscription");
        }

        const startDate = new Date();
        let endDate = new Date();

        if (plan.type === "basic") {
          endDate.setDate(startDate.getDate() + 7);
        } else if (plan.type === "standard") {
          endDate.setMonth(startDate.getMonth() + 1);
        } else if (plan.type === "premium") {
          endDate.setFullYear(startDate.getFullYear() + 1);
        } else if (plan.type === "trial") {
          endDate.setDate(startDate.getDate() + 7);
        } else if (plan.type === "free") {
          endDate.setFullYear(startDate.getFullYear() + 1);
        } else {
          endDate.setMonth(startDate.getMonth() + 1);
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
          planSnapshot: {
            name: plan.name,
            type: plan.type,
            price: plan.price,
            totalCredits: plan.totalCredits,
            imageGenerationCredits: plan.imageGenerationCredits,
            promptGenerationCredits: plan.promptGenerationCredits,
            features: plan.features,
            version: plan.version,
          },
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
        await this.notificationService.sendSubscriptionNotification(
          userId,
          isTrial ? "trial_started" : "new",
          subscription
        );
      }

      return subscription;
    } catch (error) {
      console.error(
        "[SubscriptionManagement] createSubscription failed:",
        error
      );
      throw error;
    }
  }

  async cancelSubscription(userId, immediate, allowExpired = false) {
    try {
      const query = {
        userId,
        isActive: true,
        isTrial: false,
      };

      if (!allowExpired) {
        query.endDate = { $gt: new Date() };
      }

      const subscription = await UserSubscription.findOne(query);

      if (!subscription) {
        const user = await User.findOne({ _id: userId });
        if (!user) {
          throw new Error("User not found");
        }
        const freePlan = await this.planManagement.getPlanByType("free");
        if (freePlan) {
          await this.updateUserData(
            userId,
            freePlan,
            null,
            false,
            false,
            false
          );
          await this.notificationService.sendSubscriptionNotification(
            userId,
            "cancelled",
            null
          );
        }
        return null;
      }

      if (!subscription.planId) {
        const freePlan = await this.planManagement.getPlanByType("free");
        if (freePlan) {
          subscription.planId = freePlan._id;
          subscription.planSnapshot = {
            name: freePlan.name,
            type: freePlan.type,
            price: freePlan.price,
            totalCredits: freePlan.totalCredits,
            imageGenerationCredits: freePlan.imageGenerationCredits,
            promptGenerationCredits: freePlan.promptGenerationCredits,
            features: freePlan.features,
            version: freePlan.version,
          };
          await subscription.save();
        }
      }

      if (immediate) {
        subscription.isActive = false;
        subscription.cancelledAt = new Date();
        subscription.autoRenew = false;
        subscription.endDate = new Date();
        await subscription.save();

        const freePlan = await this.planManagement.getPlanByType("free");
        if (freePlan) {
          await this.updateUserData(
            userId,
            freePlan,
            null,
            false,
            false,
            false
          );
        }
        await this.notificationService.sendSubscriptionNotification(
          userId,
          "cancelled_immediate",
          subscription
        );
      } else {
        subscription.autoRenew = false;
        subscription.cancelledAt = new Date();
        await subscription.save();
        await this.notificationService.sendSubscriptionNotification(
          userId,
          "pending_cancellation",
          subscription
        );
      }

      return subscription;
    } catch (error) {
      console.error(
        "[SubscriptionManagement] cancelSubscription failed for user:",
        userId,
        error
      );
      throw error;
    }
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
            sub.isActive = false;
            await sub.save();

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
            `[SubscriptionManagement] Error processing grace period subscription: ${sub._id}`,
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

  async processExpiredSubscriptions() {
    try {
      const now = new Date();

      await this.processGracePeriodSubscriptions();

      const invalidSubscriptions = await UserSubscription.find({
        planId: null,
        isActive: true,
      });

      for (const sub of invalidSubscriptions) {
        const freePlan = await this.planManagement.getPlanByType("free");
        if (freePlan) {
          sub.planId = freePlan._id;
          sub.planSnapshot = {
            name: freePlan.name,
            type: freePlan.type,
            price: freePlan.price,
            totalCredits: freePlan.totalCredits,
            imageGenerationCredits: freePlan.imageGenerationCredits,
            promptGenerationCredits: freePlan.promptGenerationCredits,
            features: freePlan.features,
            version: freePlan.version,
          };
          await sub.save();
        } else {
          await this.cancelSubscription(sub.userId, true, true);
        }
      }

      const expiringSoon = await UserSubscription.find({
        endDate: { $lte: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000) },
        isActive: true,
        autoRenew: true,
        isTrial: false,
        planId: { $ne: null },
      }).populate("userId planId");

      for (const sub of expiringSoon) {
        if (!sub.userId) continue; // Skip if userId is null
        await this.notificationService.sendSubscriptionNotification(
          sub.userId._id,
          "renewal_reminder",
          sub
        );
      }

      const expiredSubs = await UserSubscription.find({
        endDate: { $lte: now },
        isActive: true,
        isTrial: false,
        autoRenew: true,
        planId: { $ne: null },
      }).populate("userId planId");

      for (const sub of expiredSubs) {
        try {
          // Check for null userId
          if (!sub.userId) {
            sub.isActive = false;
            sub.cancelledAt = new Date();
            await sub.save();
            continue;
          }

          const paymentSuccess = await this.paymentProcessing.processPayment(
            sub.userId._id,
            sub.paymentMethod,
            sub.planSnapshot?.price || 0
          );

          if (paymentSuccess) {
            const plan = sub.planId;
            sub.startDate = new Date();

            if (plan.type === "basic") {
              sub.endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            } else if (plan.type === "standard") {
              sub.endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            } else if (plan.type === "premium") {
              sub.endDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
            }

            sub.planSnapshot = {
              name: plan.name,
              type: plan.type,
              price: plan.price,
              totalCredits: plan.totalCredits,
              imageGenerationCredits: plan.imageGenerationCredits,
              promptGenerationCredits: plan.promptGenerationCredits,
              features: plan.features,
              version: plan.version,
            };

            await sub.save();

            await this.updateUserData(
              sub.userId._id,
              plan,
              sub,
              true,
              false,
              true
            );

            await this.notificationService.sendSubscriptionNotification(
              sub.userId._id,
              "renewed",
              sub
            );
          } else {
            await this.cancelSubscription(sub.userId._id, true, true);
          }
        } catch (error) {
          console.error(
            `[SubscriptionManagement] Error renewing subscription: ${sub._id}`,
            error
          );
          if (sub.userId) {
            await this.cancelSubscription(sub.userId._id, true, true);
          } else {
            sub.isActive = false;
            sub.cancelledAt = new Date();
            await sub.save();
          }
        }
      }

      const expiredNonAutoRenew = await UserSubscription.find({
        endDate: { $lte: now },
        isActive: true,
        $or: [{ isTrial: true }, { autoRenew: false }],
        planId: { $ne: null },
      }).populate("userId planId");

      for (const sub of expiredNonAutoRenew) {
        try {
          sub.isActive = false;
          sub.cancelledAt = new Date();
          await sub.save();

          if (sub.userId) {
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
                sub.isTrial ? "trial_expired" : "expired",
                sub
              );
            }
          }
        } catch (error) {
          console.error(
            `[SubscriptionManagement] Error processing expired subscription: ${sub._id}`,
            error
          );
        }
      }
    } catch (error) {
      console.error(
        "[SubscriptionManagement] processExpiredSubscriptions failed:",
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

      const user = await User.findOne({ _id: userId });
      if (!user) {
        throw new Error("User not found");
      }

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

      const subscription = await this.createSubscription(
        userId,
        trialPlan._id,
        paymentMethod,
        true
      );
      return subscription;
    } catch (error) {
      console.error("[SubscriptionManagement] startFreeTrial failed:", error);
      throw error;
    }
  }
}

module.exports = SubscriptionManagement;
