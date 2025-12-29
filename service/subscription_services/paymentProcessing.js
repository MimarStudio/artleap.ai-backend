const UserSubscription = require("../../models/user_subscription");
const PaymentRecord = require("../../models/recordPayment_model");
const SubscriptionNotificationService = require("./subscriptionNotificationService");
// const SubscriptionManagement = require("./subscriptionsManagement");
// const SubscriptionPlan = require("../../models/subscriptionPlan_model");
const User = require('./../../models/user');
// const mongoose = require('mongoose');

class PaymentProcessing {
  constructor(subscriptionManagement) {
    this.notificationService = new SubscriptionNotificationService();
    this.subscriptionManagement = subscriptionManagement;
  }

  // async processPayment() {
  //   try {
  //     return true;
  //   } catch (error) {
  //     console.error("[PaymentProcessing] processPayment failed:", error);
  //     throw error;
  //   }
  // }

  async renewSubscription(subscriptionId) {
    try {
      const oldSub = await UserSubscription.findById(subscriptionId).populate("planId userId");
      if (!oldSub) {
        console.error("[PaymentProcessing] Subscription not found:", subscriptionId);
        throw new Error("Subscription not found");
      }

      const startDate = new Date();
      let endDate = new Date();

      if (oldSub.planSnapshot.type === "basic") {
        endDate.setDate(startDate.getDate() + 7);
      } else if (oldSub.planSnapshot.type === "standard") {
        endDate.setMonth(startDate.getMonth() + 1);
      } else if (oldSub.planSnapshot.type === "premium") {
        endDate.setFullYear(startDate.getFullYear() + 1);
      }

      const newSub = new UserSubscription({
        userId: oldSub.userId._id,
        planId: oldSub.planId._id,
        startDate,
        endDate,
        isActive: true,
        paymentMethod: oldSub.paymentMethod,
        autoRenew: oldSub.autoRenew,
        planSnapshot: oldSub.planSnapshot,
      });

      await newSub.save();
      await this.subscriptionManagement.updateUserData(
        oldSub.userId._id,
        oldSub.planSnapshot,
        newSub,
        true,
        false,
        false,
      );
      return newSub;
    } catch (error) {
      console.error("[PaymentProcessing] renewSubscription failed:", error);
      throw error;
    }
  }

  async cleanupOrphanedPaymentRecords() {
    try {
      const orphanedPayments = await PaymentRecord.aggregate([
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user"
          }
        },
        {
          $match: {
            "user.0": { $exists: false }
          }
        }
      ]);

      let deleted = 0;
      for (const payment of orphanedPayments) {
        await PaymentRecord.deleteOne({ _id: payment._id });
        deleted++;
      }

      const duplicatePayments = await PaymentRecord.aggregate([
        {
          $group: {
            _id: {
              transactionId: "$transactionId",
              originalTransactionId: "$originalTransactionId",
              receiptData: "$receiptData"
            },
            count: { $sum: 1 },
            payments: { $push: "$$ROOT" }
          }
        },
        {
          $match: {
            $or: [
              { "_id.transactionId": { $ne: null }, "count": { $gt: 1 } },
              { "_id.originalTransactionId": { $ne: null }, "count": { $gt: 1 } },
              { "_id.receiptData": { $ne: null }, "count": { $gt: 1 } }
            ]
          }
        }
      ]);

      let fixed = 0;
      for (const group of duplicatePayments) {
        const sortedPayments = group.payments.sort((a, b) => 
          new Date(b.createdAt) - new Date(a.createdAt)
        );
        
        for (let i = 1; i < sortedPayments.length; i++) {
          await PaymentRecord.deleteOne({ _id: sortedPayments[i]._id });
          fixed++;
        }
      }
      return { deleted, fixed };

    } catch (error) {
      console.error("[PaymentProcessing] Error cleaning up orphaned payment records:", error);
      throw error;
    }
  }

  async getLatestPaymentRecord(userId) {
    try {
      const paymentRecord = await PaymentRecord.findOne({
        userId: userId
      }).sort({ createdAt: -1 });

      return paymentRecord;
    } catch (error) {
      console.error("[PaymentProcessing] Error getting latest payment record:", error);
      throw error;
    }
  }

  async getPaymentStats() {
    try {
      const totalPayments = await PaymentRecord.countDocuments();
      const completedPayments = await PaymentRecord.countDocuments({ 
        status: "completed" 
      });
      const cancelledPayments = await PaymentRecord.countDocuments({ 
        status: "cancelled" 
      });
      const gracePeriodPayments = await PaymentRecord.countDocuments({ 
        status: "grace_period" 
      });
      const androidPayments = await PaymentRecord.countDocuments({ 
        platform: "android" 
      });
      const iosPayments = await PaymentRecord.countDocuments({ 
        platform: "ios" 
      });

      return {
        total: totalPayments,
        completed: completedPayments,
        cancelled: cancelledPayments,
        gracePeriod: gracePeriodPayments,
        android: androidPayments,
        ios: iosPayments
      };
    } catch (error) {
      console.error("[PaymentProcessing] Error getting payment stats:", error);
      return {};
    }
  }

  async validatePaymentRecord(paymentRecordId) {
    try {
      const paymentRecord = await PaymentRecord.findById(paymentRecordId).populate("userId");
      
      if (!paymentRecord) {
        return { valid: false, reason: "Payment record not found" };
      }

      if (!paymentRecord.userId) {
        return { valid: false, reason: "No associated user" };
      }

      if (paymentRecord.platform === "android" && !paymentRecord.receiptData) {
        return { valid: false, reason: "Android payment missing receipt data" };
      }

      if (paymentRecord.platform === "ios" && !paymentRecord.originalTransactionId && !paymentRecord.transactionId) {
        return { valid: false, reason: "iOS payment missing transaction IDs" };
      }

      return { valid: true, paymentRecord };

    } catch (error) {
      console.error("[PaymentProcessing] Error validating payment record:", error);
      return { valid: false, reason: "Validation error" };
    }
  }

  async fixInvalidPaymentRecords() {
    try {
      const invalidPayments = await PaymentRecord.find({
        $or: [
          { userId: { $exists: false } },
          { platform: { $exists: false } },
          { 
            $and: [
              { platform: "android" },
              { receiptData: { $exists: false } }
            ]
          },
          {
            $and: [
              { platform: "ios" },
              { originalTransactionId: { $exists: false } },
              { transactionId: { $exists: false } }
            ]
          }
        ]
      });

      let fixed = 0;
      let deleted = 0;

      for (const payment of invalidPayments) {
        try {
          if (!payment.userId) {
            await PaymentRecord.deleteOne({ _id: payment._id });
            deleted++;
            continue;
          }

          const user = await User.findById(payment.userId);
          if (!user) {
            await PaymentRecord.deleteOne({ _id: payment._id });
            deleted++;
            continue;
          }

          if (!payment.platform) {
            if (payment.receiptData) {
              payment.platform = "android";
            } else if (payment.originalTransactionId || payment.transactionId) {
              payment.platform = "ios";
            } else {
              await PaymentRecord.deleteOne({ _id: payment._id });
              deleted++;
              continue;
            }
          }

          if (payment.platform === "android" && !payment.receiptData) {
            await PaymentRecord.deleteOne({ _id: payment._id });
            deleted++;
            continue;
          }

          if (payment.platform === "ios" && !payment.originalTransactionId && !payment.transactionId) {
            await PaymentRecord.deleteOne({ _id: payment._id });
            deleted++;
            continue;
          }

          await payment.save();
          fixed++;

        } catch (error) {
          console.error(`[PaymentProcessing] Error fixing payment record ${payment._id}:`, error);
        }
      }
      return { fixed, deleted };

    } catch (error) {
      console.error("[PaymentProcessing] Error fixing invalid payment records:", error);
      throw error;
    }
  }
}

module.exports = PaymentProcessing;