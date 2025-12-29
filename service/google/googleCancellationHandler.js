const { google } = require("googleapis");
const androidpublisher = google.androidpublisher("v3");
const googleCredentials = require("../../google-credentials.json");
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

class GoogleCancellationHandler {
  constructor() {
    this.auth = new google.auth.GoogleAuth({
      credentials: googleCredentials,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });

    this.subscriptionService = new SubscriptionManagement();
  }

  logError(message, error) {
    console.error(`[GoogleCancellationHandler][ERROR] ${message}`, {
      error: error.message,
      stack: error.stack,
      response: error.response?.data,
    });
  }

  async getBillingClient() {
    try {
      await this.auth.getClient();
      return androidpublisher;
    } catch (error) {
      throw new Error("Failed to initialize Google Play Billing client.");
    }
  }

  async getAllSubscriptionsFromPlayStore(
    packageName = "com.XrDIgital.ImaginaryVerse"
  ) {
    try {
      await this.getBillingClient();
      const allPaymentRecords = await PaymentRecord.aggregate([
        {
          $match: {
            platform: "android",
            receiptData: { $exists: true, $ne: null, $nin: ["", " "] },
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
        if (
          !paymentRecord ||
          !paymentRecord.userId ||
          !paymentRecord.receiptData ||
          !paymentRecord.receiptData.trim()
        ) {
          results.skipped++;
          continue;
        }

        try {
          const playStoreStatus = await this.getSubscriptionStatusFromPlayStore(
            packageName,
            paymentRecord.receiptData,
            paymentRecord.userId
          );

          if (playStoreStatus) {
            const needsUpdate = await this.compareAndUpdateLocalRecords(
              paymentRecord,
              playStoreStatus
            );
            if (needsUpdate) results.updated++;
            results.details.push({
              paymentId: paymentRecord._id,
              purchaseToken: paymentRecord.receiptData,
              localStatus: paymentRecord.status,
              playStoreStatus: playStoreStatus.finalStatus,
              updated: needsUpdate,
            });
          }

          results.processed++;
          await new Promise((r) => setTimeout(r, 50));
        } catch (error) {
          if (error.message.includes("expired for too long")) {
            await this.handleExpiredSubscription(paymentRecord);
            results.updated++;
          } else {
            results.errors++;
            this.logError(
              `Error processing payment record ${paymentRecord._id}`,
              error
            );
          }
        }
      }

      return results;
    } catch (error) {
      this.logError("Failed to sync subscriptions", error);
      throw error;
    }
  }

  async handleExpiredSubscription(paymentRecord) {
    try {
      await PaymentRecord.updateOne(
        { _id: paymentRecord._id },
        {
          $set: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancellationType: "expired_too_long",
            lastChecked: new Date(),
          },
        }
      );

      await this.subscriptionService.cancelSubscription(
        paymentRecord.userId,
        true,
      );
    } catch (error) {
      this.logError(
        `Error handling expired subscription for user ${paymentRecord.userId}`,
        error
      );
    }
  }

  async getSubscriptionStatusFromPlayStore(
    packageName = "com.XrDIgital.ImaginaryVerse",
    purchaseToken,
    userId
  ) {
    try {
      const client = await this.getBillingClient();
      if (!purchaseToken) {
        console.error(
          "[GoogleCancellationHandler] ❌ Missing purchaseToken in receiptData",
          {
            userId,
            purchaseToken,
          }
        );
        return {
          finalStatus: "error",
          error: "Missing purchaseToken",
          isExpired: true,
        };
      }

      const response = await client.purchases.subscriptionsv2.get({
        packageName,
        token: purchaseToken,
        auth: this.auth,
      });
      const subscription = response.data;

      if (!subscription) return null;
      const lineItem = subscription.lineItems?.[0];
      if (!lineItem) return null;

      return this.analyzePlayStoreSubscriptionStatus(lineItem, subscription);
    } catch (error) {
      const message = error.response?.data?.error?.message || error.message;

      if (message.includes("not found") || message.includes("invalid")) {
        return {
          isCancelledOrExpired: true,
          cancellationType: "expired",
          isInGracePeriod: false,
          isExpired: true,
          expiryTime: new Date(),
          finalStatus: "cancelled",
          autoRenewing: false,
          foundInPlayStore: false,
        };
      }

      if (message.includes("expired for too long")) {
        throw new Error("expired for too long");
      }

      this.logError("Error fetching subscription status", error);
      return null;
    }
  }

  analyzePlayStoreSubscriptionStatus(lineItem, subscription) {
    const now = new Date();

    const expiryRaw = lineItem.expiryTime;
    let expiryTime = null;

    if (expiryRaw) {
      expiryTime =
        typeof expiryRaw === "number"
          ? new Date(expiryRaw > 1e12 ? expiryRaw : expiryRaw * 1000)
          : new Date(expiryRaw);
    }

    const autoRenewing = lineItem.autoRenewingPlan?.autoRenewEnabled ?? false;
    let isExpired = expiryTime ? expiryTime.getTime() < now.getTime() : true;
    const cancellationReason = lineItem.canceledReason;
    const userCancellationTime = lineItem.userCancellationTime
      ? new Date(lineItem.userCancellationTime)
      : null;
    const isRefunded = lineItem.refunded ?? false;
    const isRevoked = !!subscription.revocationReason;

    const isInGracePeriod =
      !!userCancellationTime && !isExpired && expiryTime
        ? now <=
          new Date(new Date(expiryTime).setDate(expiryTime.getDate() + 7))
        : false;

    let cancellationType = "active";
    let finalStatus = "active";

    if (autoRenewing) {
      cancellationType = "active";
      finalStatus = "active";
      isExpired = false;
    } else if (isExpired) {
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
    } else if (cancellationReason) {
      cancellationType = cancellationReason;
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
      cancellationReason,
      finalStatus,
      foundInPlayStore: true,
    };
  }

  async compareAndUpdateLocalRecords(paymentRecord, playStoreStatus) {
    try {
      const userId = paymentRecord.userId;
      await PaymentRecord.updateOne(
        { _id: paymentRecord._id },
        {
          $set: {
            status: playStoreStatus.finalStatus,
            cancelledAt:
              playStoreStatus.finalStatus === "cancelled"
                ? new Date()
                : paymentRecord.cancelledAt,
            cancellationType: playStoreStatus.cancellationType,
            lastChecked: new Date(),
            expiryDate: playStoreStatus.expiryTime,
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
      if (
        playStoreStatus.finalStatus === "cancelled" &&
        playStoreStatus.isExpired &&
        !playStoreStatus.autoRenewing
      ) {
        const activeRecord = await PaymentRecord.findOne({
          userId,
          platform: "android",
          status: { $in: ["active", "grace_period"] },
        });

        if (activeRecord) {
          console.log(
            `⏩ Skipping cancellation: user ${userId} has another active subscription`
          );
          return false;
        }

        await this.subscriptionService.cancelSubscription(
          userId,
          true,
        );
        return true;
      }

      if (playStoreStatus.finalStatus === "cancelled" && !playStoreStatus.isExpired ) {
        await this.subscriptionService.cancelSubscription(
          userId,
          true
        );
        return true;
      }

      if (playStoreStatus.finalStatus === "grace_period") {
        if (userSubscription) {
          await UserSubscription.updateOne(
            { _id: userSubscription._id },
            {
              $set: {
                autoRenew: false,
                isActive: true,
                cancelledAt: new Date(),
                cancellationReason: playStoreStatus.cancellationType,
                status: "grace_period",
                endDate: playStoreStatus.expiryTime,
                lastUpdated: new Date(),
              },
            }
          );
        }
        return true;
      }

      if (playStoreStatus.finalStatus === "active") {
        const prevEnd = userSubscription?.endDate
          ? new Date(userSubscription.endDate)
          : null;
        const nextEnd = playStoreStatus.expiryTime
          ? new Date(playStoreStatus.expiryTime)
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
                autoRenew: playStoreStatus.autoRenewing,
                isActive: true,
                status: "active",
                endDate: nextEnd,
                lastUpdated: new Date(),
              },
            }
          );
        }
        await this.updateUserForActiveSubscription(
          userId,
          userSubscription,
          expiryChanged
        );

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

  isInGracePeriod(expiryTime, isExpired) {
    if (isExpired) return false;
    if (!expiryTime) return false;
    const now = new Date();
    const gracePeriodEnd = new Date(expiryTime);
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 7);
    return now <= gracePeriodEnd;
  }

  async syncAllSubscriptionsWithPlayStore() {
    return await this.getAllSubscriptionsFromPlayStore();
  }

  async checkAllActiveSubscriptions() {
    return await this.getAllSubscriptionsFromPlayStore();
  }

  async forceExpireSubscription(purchaseToken) {
    const paymentRecord = await PaymentRecord.findOne({
      receiptData: purchaseToken,
    });
    if (paymentRecord) {
      await this.subscriptionService.cancelSubscription(
        paymentRecord.userId,
        true,
      );
    }
  }
}

module.exports = GoogleCancellationHandler;