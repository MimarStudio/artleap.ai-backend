const axios = require("axios");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const PaymentRecord = require("../../models/recordPayment_model");
const User = require("../../models/user");
const UserSubscription = require("../../models/user_subscription");
const SubscriptionPlan = require("../../models/subscriptionPlan_model");
const SubscriptionManagement = require("./../subscription_services/subscriptionsManagement");

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildPlanSnapshot(plan) {
  return {
    name: plan?.name || "",
    type: plan?.type || "",
    price: num(plan?.price),
    totalCredits: num(plan?.totalCredits),
    imageGenerationCredits: num(plan?.imageGenerationCredits),
    promptGenerationCredits: num(plan?.promptGenerationCredits),
    features: Array.isArray(plan?.features) ? plan.features : [],
    version: (plan?.version ?? "").toString() || "1",
  };
}

class AppleCancellationHandler {
  constructor() {
    this.bundleId = process.env.PACKAGE_NAME;
    this.issuerId = process.env.APPLE_ISSUER_ID;
    this.keyId = process.env.APPLE_KEY_ID;
    this.privateKey = fs.readFileSync(
      process.env.APPLE_PRIVATE_KEY_PATH,
      "utf8"
    );
    this.subscriptionService = new SubscriptionManagement();
  }

  logError(message, error) {
    console.error(`[AppleCancellationHandler][ERROR] ${message}`, {
      error: error.message,
      stack: error.stack,
      response: error.response?.data,
    });
  }

  async generateToken() {
    try {
      const now = Math.floor(Date.now() / 1000);
      return jwt.sign(
        {
          iss: this.issuerId,
          iat: now,
          exp: now + 20 * 60,
          aud: "appstoreconnect-v1",
          bid: this.bundleId,
        },
        this.privateKey,
        {
          algorithm: "ES256",
          header: { kid: this.keyId, typ: "JWT" },
        }
      );
    } catch (error) {
      throw new Error("Failed to generate App Store Connect API token");
    }
  }

  async getSubscriptionStatus(originalTransactionId) {
    try {
      if (!this.isValidTransactionId(originalTransactionId)) {
        return { status: "INVALID_ID" };
      }

      const token = await this.generateToken();
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      const url = `https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/${originalTransactionId}`;

      const response = await axios.get(url, { headers });
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return {
          status: "NOT_FOUND",
          errorCode: error.response?.data?.errorCode,
          errorMessage: error.response?.data?.errorMessage,
        };
      }

      if (error.response?.status === 401) {
        throw new Error("Invalid App Store Connect API credentials");
      }

      throw error;
    }
  }

  isValidTransactionId(transactionId) {
    if (!transactionId) return false;
    if (typeof transactionId !== "string") return false;
    if (transactionId.length < 10) return false;

    return /^\d+$/.test(transactionId);
  }

  async getAllSubscriptionsFromAppStore() {
    try {
      const allPaymentRecords = await PaymentRecord.aggregate([
        {
          $match: {
            platform: "ios",
            $or: [
              {
                originalTransactionId: {
                  $exists: true,
                  $ne: null,
                  $nin: ["", " "],
                },
              },
              { transactionId: { $exists: true, $ne: null, $nin: ["", " "] } },
            ],
          },
        },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$userId", latestRecord: { $first: "$$ROOT" } } },
      ]);

      const results = {
        processed: 0,
        updated: 0,
        errors: 0,
        details: [],
        skipped: 0,
      };

      for (const record of allPaymentRecords) {
        const paymentRecord = record.latestRecord;
        if (!paymentRecord || !paymentRecord.userId) {
          results.skipped++;
          continue;
        }

        const transactionId =
          paymentRecord.originalTransactionId || paymentRecord.transactionId;
        if (!transactionId || !transactionId.trim()) {
          results.skipped++;
          continue;
        }

        try {
          const appStoreStatus = await this.getSubscriptionStatusFromAppStore(
            transactionId
          );

          if (appStoreStatus) {
            const needsUpdate = await this.compareAndUpdateLocalRecords(
              paymentRecord,
              appStoreStatus
            );
            if (needsUpdate) results.updated++;
            results.details.push({
              paymentId: paymentRecord._id,
              transactionId: transactionId,
              localStatus: paymentRecord.status,
              appStoreStatus: appStoreStatus.finalStatus,
              updated: needsUpdate,
            });
          }

          results.processed++;
          await new Promise((r) => setTimeout(r, 100));
        } catch (error) {
          if (
            error.message.includes("Invalid App Store Connect API credentials")
          ) {
            throw error;
          }
          results.errors++;
          this.logError(
            `Error processing payment record ${paymentRecord._id}`,
            error
          );
        }
      }

      return results;
    } catch (error) {
      this.logError("Failed to sync subscriptions", error);
      throw error;
    }
  }

  async getSubscriptionStatusFromAppStore(transactionId) {
    try {
      const subscriptionStatus = await this.getSubscriptionStatus(
        transactionId
      );

      if (subscriptionStatus.status === "NOT_FOUND") {
        const shouldDowngrade = await this.shouldDowngradeNotFoundSubscription(
          transactionId
        );

        return {
          isCancelledOrExpired: shouldDowngrade,
          cancellationType: shouldDowngrade
            ? "subscription_not_found"
            : "active",
          isInGracePeriod: false,
          isExpired: shouldDowngrade,
          expiryTime: shouldDowngrade ? new Date() : null,
          finalStatus: shouldDowngrade ? "cancelled" : "active",
          autoRenewing: !shouldDowngrade,
          foundInAppStore: false,
        };
      }

      if (subscriptionStatus.status === "INVALID_ID") {
        return {
          isCancelledOrExpired: false,
          cancellationType: "active",
          isInGracePeriod: false,
          isExpired: false,
          expiryTime: null,
          finalStatus: "active",
          autoRenewing: true,
          foundInAppStore: false,
        };
      }

      return this.analyzeAppleSubscriptionStatus(subscriptionStatus);
    } catch (error) {
      this.logError(
        `Error fetching subscription status for ${transactionId}`,
        error
      );
      return null;
    }
  }

  analyzeAppleSubscriptionStatus(subscriptionData) {
    const now = new Date();

    if (
      !subscriptionData ||
      !subscriptionData.data ||
      !Array.isArray(subscriptionData.data) ||
      subscriptionData.data.length === 0
    ) {
      return {
        isCancelledOrExpired: false,
        cancellationType: "active",
        autoRenewing: true,
        expiryTime: null,
        isExpired: false,
        isInGracePeriod: false,
        finalStatus: "active",
        foundInAppStore: true,
      };
    }

    const latestTransaction = subscriptionData.data[0];
    const lastSubscriptionEvent = latestTransaction.lastTransactions?.[0];

    const expiryTime = lastSubscriptionEvent?.expiresDate
      ? new Date(lastSubscriptionEvent.expiresDate)
      : null;
    const isExpired = expiryTime ? expiryTime.getTime() < now.getTime() : true;
    const autoRenewing = latestTransaction.autoRenewStatus === 1;

    const userCancellationTime = lastSubscriptionEvent?.signedDate
      ? new Date(lastSubscriptionEvent.signedDate)
      : null;
    const isRefunded = lastSubscriptionEvent?.revocationReason !== undefined;
    const isRevoked = lastSubscriptionEvent?.revocationReason !== undefined;

    const isInGracePeriod = this.isInGracePeriod(expiryTime, isExpired);

    let cancellationType = "active";
    let finalStatus = "active";

    if (isExpired) {
      cancellationType = "expired";
      finalStatus = "cancelled";
    } else if (!autoRenewing && userCancellationTime) {
      cancellationType = "user_cancelled";
      finalStatus = isInGracePeriod ? "grace_period" : "cancelled";
    } else if (isRefunded) {
      cancellationType = "refunded";
      finalStatus = "cancelled";
    } else if (isRevoked) {
      cancellationType = "revoked";
      finalStatus = "cancelled";
    } else if (lastSubscriptionEvent?.revocationReason) {
      cancellationType = lastSubscriptionEvent.revocationReason;
      finalStatus = "cancelled";
    } else {
      finalStatus = "active";
    }

    return {
      isCancelledOrExpired: finalStatus !== "active",
      cancellationType,
      autoRenewing,
      expiryTime,
      isExpired,
      isInGracePeriod,
      userCancellationTime,
      isRefunded,
      isRevoked,
      finalStatus,
      foundInAppStore: true,
    };
  }

  async shouldDowngradeNotFoundSubscription(transactionId) {
    try {
      const paymentRecord = await PaymentRecord.findOne({
        $or: [
          { originalTransactionId: transactionId },
          { transactionId: transactionId },
        ],
      });

      if (!paymentRecord) {
        return false;
      }

      const createdAt = new Date(paymentRecord.createdAt);
      const now = new Date();
      const daysSinceCreation = (now - createdAt) / (1000 * 60 * 60 * 24);

      if (paymentRecord.expiryDate) {
        const expiryDate = new Date(paymentRecord.expiryDate);
        return expiryDate < now && daysSinceCreation > 30;
      }

      return daysSinceCreation > 60;
    } catch (error) {
      return false;
    }
  }

  async compareAndUpdateLocalRecords(paymentRecord, appStoreStatus) {
    try {
      const userId = paymentRecord.userId;

      // Update payment record
      await PaymentRecord.updateOne(
        { _id: paymentRecord._id },
        {
          $set: {
            status: appStoreStatus.finalStatus,
            cancelledAt:
              appStoreStatus.finalStatus === "cancelled"
                ? new Date()
                : paymentRecord.cancelledAt,
            cancellationType: appStoreStatus.cancellationType,
            lastChecked: new Date(),
            expiryDate: appStoreStatus.expiryTime,
          },
        }
      );

      const user = await User.findById(userId);
      if (!user) return true;

      let userSubscription = await UserSubscription.findOne({
        userId: userId,
        $or: [
          { isActive: true },
          { status: { $in: ["active", "grace_period", "cancelled"] } },
        ],
      }).populate("planId");

      // Handle different cancellation statuses
      if (
        appStoreStatus.finalStatus === "cancelled" &&
        appStoreStatus.isExpired
      ) {
        // Check for other active subscriptions
        const activeRecord = await PaymentRecord.findOne({
          userId,
          platform: "ios",
          status: { $in: ["active", "grace_period"] },
        });

        if (activeRecord) {
          console.log(
            `⏩ Skipping cancellation: user ${userId} has another active iOS subscription`
          );
          return false;
        }

        // Use subscription service for cancellation
        await this.subscriptionService.cancelSubscription(
          userId,
          true,
        );
        return true;
      }

      if (
        appStoreStatus.finalStatus === "cancelled" && !appStoreStatus.isExpired
      ) {
        // User cancelled but subscription is still active until expiry
        if (userSubscription) {
          await UserSubscription.updateOne(
            { _id: userSubscription._id },
            {
              $set: {
                autoRenew: false,
                isActive: true,
                cancelledAt: new Date(),
                cancellationReason: appStoreStatus.cancellationType,
                status: "cancelled",
                endDate: appStoreStatus.expiryTime,
                lastUpdated: new Date(),
              },
            }
          );
        }
        
        // Update user subscription status
        await this.subscriptionService.cancelSubscription(
          userId,
          true,
        );
        return true;
      }

      if (appStoreStatus.finalStatus === "grace_period") {
        if (userSubscription) {
          await UserSubscription.updateOne(
            { _id: userSubscription._id },
            {
              $set: {
                autoRenew: false,
                isActive: true,
                cancelledAt: new Date(),
                cancellationReason: appStoreStatus.cancellationType,
                status: "grace_period",
                endDate: appStoreStatus.expiryTime,
                lastUpdated: new Date(),
              },
            }
          );
        }
        return true;
      }

      if (appStoreStatus.finalStatus === "active") {
        const prevEnd = userSubscription?.endDate
          ? new Date(userSubscription.endDate)
          : null;
        const nextEnd = appStoreStatus.expiryTime
          ? new Date(appStoreStatus.expiryTime)
          : null;
        const expiryChanged = !!(
          prevEnd &&
          nextEnd &&
          nextEnd.getTime() !== prevEnd.getTime()
        );

        if (userSubscription) {
          await UserSubscription.updateOne(
            { _id: userSubscription._id },
            {
              $set: {
                autoRenew: appStoreStatus.autoRenewing,
                isActive: true,
                status: "active",
                endDate: nextEnd,
                lastUpdated: new Date(),
              },
            }
          );
        }

        // Update user for active subscription
        await this.updateUserForActiveSubscription(
          userId,
          userSubscription,
          expiryChanged
        );

        if (!userSubscription) {
          await this.ensureActiveSubscriptionRecord(userId, nextEnd);
        }

        return true;
      }

      return false;
    } catch (error) {
      this.logError(
        `Error updating records for user ${paymentRecord.userId}`,
        error
      );
      return false;
    }
  }

  async updateUserForActiveSubscription(
    userId,
    userSubscriptionDoc,
    expiryChanged
  ) {
    try {
      const user = await User.findById(userId);
      if (!user) return;

      let planDoc = null;
      if (userSubscriptionDoc?.planId) {
        planDoc =
          typeof userSubscriptionDoc.planId === "object" &&
          userSubscriptionDoc.planId._id
            ? userSubscriptionDoc.planId
            : await SubscriptionPlan.findById(userSubscriptionDoc.planId);
      }
      if (!planDoc) {
        const activeSub = await UserSubscription.findOne({
          userId,
          isActive: true,
          status: "active",
        }).populate("planId");
        planDoc = activeSub?.planId || null;
      }
      if (!planDoc) return;

      const snap = buildPlanSnapshot(planDoc);

      if (expiryChanged && user.lastCreditReset && user.planName != "Free") {
        const resetDate = new Date(user.lastCreditReset);
        const now = new Date();
        const timeDiff = now.getTime() - resetDate.getTime();
        const hoursDiff = timeDiff / (1000 * 60 * 60);

        if (hoursDiff >= 24) {
          user.totalCredits = num(planDoc.totalCredits, 0);
          user.imageGenerationCredits = num(planDoc.imageGenerationCredits, 0);
          user.promptGenerationCredits = num(
            planDoc.promptGenerationCredits,
            0
          );
          user.lastCreditReset = now;
        }
      } else if (!user.lastCreditReset) {
        user.totalCredits = num(planDoc.totalCredits, 0);
        user.imageGenerationCredits = num(planDoc.imageGenerationCredits, 0);
        user.promptGenerationCredits = num(planDoc.promptGenerationCredits, 0);
        user.lastCreditReset = new Date();
      }

      user.isSubscribed = true;
      user.subscriptionStatus = "active";
      user.planName = planDoc.name || "";
      user.planType = planDoc.type || "";
      await user.save();

      if (userSubscriptionDoc) {
        await UserSubscription.updateOne(
          { _id: userSubscriptionDoc._id },
          { $set: { planSnapshot: snap, isActive: true } }
        );
      }
    } catch (error) {
      throw error;
    }
  }

  async ensureActiveSubscriptionRecord(userId, endDate) {
    try {
      const existing = await UserSubscription.findOne({
        userId,
        isActive: true,
        status: "active",
      });
      if (existing) return;

      const paidSub = await UserSubscription.findOne({ userId })
        .sort({ createdAt: -1 })
        .populate("planId");
      if (!paidSub?.planId) return;

      const snap = buildPlanSnapshot(paidSub.planId);

      const sub = new UserSubscription({
        userId,
        planId: paidSub.planId._id,
        startDate: new Date(),
        endDate: endDate || new Date(),
        isTrial: false,
        isActive: true,
        paymentMethod: paidSub.paymentMethod || "apple",
        autoRenew: true,
        status: "active",
        planSnapshot: snap,
      });
      await sub.save();
    } catch (error) {
      throw error;
    }
  }

  isInGracePeriod(expiryTime, isExpired) {
    if (isExpired) return false;
    if (!expiryTime) return false;
    const now = new Date();
    const gracePeriodEnd = new Date(expiryTime);
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 7);
    return now <= gracePeriodEnd;
  }

  async syncAllSubscriptionsWithAppStore() {
    return await this.getAllSubscriptionsFromAppStore();
  }

  async checkAllActiveSubscriptions() {
    return await this.getAllSubscriptionsFromAppStore();
  }

  async forceExpireSubscription(transactionId) {
    const paymentRecord = await PaymentRecord.findOne({
      $or: [
        { originalTransactionId: transactionId },
        { transactionId: transactionId },
      ],
    });
    if (paymentRecord) {
      await this.subscriptionService.cancelSubscription(
        paymentRecord.userId,
        true,
      );
    }
  }

  async getSubscriptionStats() {
    try {
      const totalSubscriptions = await PaymentRecord.countDocuments({
        platform: "ios",
      });
      const activeSubscriptions = await PaymentRecord.countDocuments({
        platform: "ios",
        status: "active",
      });
      const cancelledSubscriptions = await PaymentRecord.countDocuments({
        platform: "ios",
        status: "cancelled",
      });
      const gracePeriodSubscriptions = await PaymentRecord.countDocuments({
        platform: "ios",
        status: "grace_period",
      });

      return {
        total: totalSubscriptions,
        active: activeSubscriptions,
        cancelled: cancelledSubscriptions,
        gracePeriod: gracePeriodSubscriptions,
      };
    } catch (error) {
      return {};
    }
  }
}

module.exports = AppleCancellationHandler;