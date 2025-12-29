const SubscriptionService = require("../service/subscriptionService");
const HistoryService = require("../service/userHistoryService");
const PaymentReversalService = require("../service/paymentReversalService");
const SendNotificationService = require("./../service/sendNotificationService");
const { google } = require("googleapis");
const androidpublisher = google.androidpublisher("v3");
const PaymentRecord = require("../models/recordPayment_model");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const jwt = require("jsonwebtoken");

class SubscriptionController {
  async getPlans(req, res)
 {
    try {
      const plans = await SubscriptionService.getAvailablePlans();
      res.json({ success: true, data: plans });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async checkAllCancellations(req, res)
 {
    try {
      await SubscriptionService.checkAndHandleSubscriptionCancellations();
      res.json({
        success: true,
        message: "All subscription cancellations checked successfully"
      });
    } catch (error) {
      console.error("Error checking all cancellations:", error);
      res.status(500).json({ 
        success: false,
        error: error.message 
      });
    }
  }

  async syncPlans(req, res)
 {
    try {
      await SubscriptionService.syncPlansWithGooglePlay();
      res.json({ success: true, message: "Plans synchronized successfully" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async syncApplePlans(req, res) {
    try {
      await SubscriptionService.syncPlansWithAppStore();
      res.json({
        success: true,
        message: "Apple plans synchronized successfully",
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async subscribe(req, res) {
    try {
      const { userId, planId, paymentMethod, verificationData } = req.body;
      if (!userId) {
        return res.status(400).json({
          success: false,
          error: "User ID is required",
        });
      }

      if (!planId) {
        return res.status(400).json({
          success: false,
          error: "Plan ID is required",
        });
      }

      let verificationResult = await this.verifyPurchase(paymentMethod, verificationData);

      if (!verificationResult || verificationResult.success === false) {
        return res.status(400).json({
          success: false,
          error: "Purchase verification failed",
        });
      }

      if (paymentMethod === "apple") {
        return this.subscribeApple(req, res, userId, planId, verificationResult, verificationData);
      }

      const txId = this.getTransactionId(paymentMethod, verificationData);
      const existingPayment = await PaymentRecord.findOne({
        transactionId: txId,
        planId: planId,
      });

      if (existingPayment) {
        const currentSubscription = await SubscriptionService.getUserActiveSubscription(userId);
        return res.json({
          success: true,
          data: currentSubscription,
          message: "Already subscribed",
        });
      }
      const subscription = await SubscriptionService.createSubscription(
        userId,
        planId,
        paymentMethod,
        false
      );


      await this.recordPayment(userId, planId, paymentMethod, {
        ...verificationData,
        transactionId: txId,
      });

      await HistoryService.recordSubscription(userId, {
        planId: subscription.planId,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        status: "active",
        paymentMethod,
        action: "subscription_created",
        planSnapshot: subscription.planSnapshot,
      });

      await HistoryService.updateCreditUsage(userId);

      await SendNotificationService.sendCustomNotification(
        userId,
        userId,
        {
          title: "Subscription Activated 🎉",
          body: `Your ${subscription.planSnapshot?.name || 'premium'} subscription is now active!`,
          type: "system",
          action: "subscription_activated",
          data: {
            type: "subscription",
            planId: planId,
            subscriptionId: subscription._id.toString(),
          }
        }
      );
      
      res.json({
        success: true,
        data: subscription,
        message: "Subscription created successfully",
      });

    } catch (error) {
      console.error(`[subscribe] Error:`, error);
      
      const { userId, planId, paymentMethod, verificationData } = req.body;
      
      if (userId && planId && paymentMethod && verificationData) {
        const reversalResult = await PaymentReversalService.handleFailedSubscription(
          userId, 
          planId, 
          paymentMethod, 
          verificationData, 
          error
        );

        return res.status(500).json({ 
          success: false, 
          error: `Subscription failed: ${error.message}`,
          refundStatus: reversalResult
        });
      } else {
        return res.status(500).json({ 
          success: false, 
          error: error.message
        });
      }
    }
  }

  async subscribeApple(req, res, userId, planId, verificationResult, verificationData) {
    try {
      const txId = verificationResult.transactionId || verificationResult.originalTransactionId;
      const productId = verificationResult.productId;

      if (!planId) {
        return res.status(400).json({
          success: false,
          error: "Plan ID is required for Apple subscription",
        });
      }
      const existingPayment = await PaymentRecord.findOne({
        transactionId: txId,
        planId: planId,
      });

      if (existingPayment) {
        const currentSubscription = await SubscriptionService.getUserActiveSubscription(userId);
        return res.json({
          success: true,
          data: currentSubscription,
          message: "Already subscribed to this product",
        });
      }
      const subscription = await SubscriptionService.createSubscription(
        userId,
        planId,
        "apple",
        false
      );

      await this.recordPayment(userId, planId, "apple", {
        ...verificationData,
        transactionId: txId,
        productId,
      });

      await HistoryService.recordSubscription(userId, {
        planId: subscription.planId,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        status: "active",
        paymentMethod: "apple",
        action: "subscription_created",
        planSnapshot: subscription.planSnapshot,
      });

      await HistoryService.updateCreditUsage(userId);

      await SendNotificationService.sendCustomNotification(
        userId,
        userId,
        {
          title: "Subscription Activated 🎉",
          body: `Your ${subscription.planSnapshot?.name || 'premium'} subscription is now active!`,
          type: "system",
          action: "subscription_activated",
          data: {
            type: "subscription",
            planId: planId,
            subscriptionId: subscription._id.toString(),
          }
        }
      );
      
      return res.json({
        success: true,
        data: subscription,
        message: "Apple subscription created successfully",
      });

    } catch (error) {
      console.error("[subscribeApple] Error:", error);
      
      const { userId, planId, verificationData } = req.body;
      
      if (userId && planId && verificationData) {
        const reversalResult = await PaymentReversalService.handleFailedSubscription(
          userId, 
          planId, 
          "apple", 
          verificationData, 
          error
        );

        return res.status(500).json({ 
          success: false, 
          error: `Apple subscription failed: ${error.message}`,
          refundStatus: reversalResult
        });
      } else {
        return res.status(500).json({ 
          success: false, 
          error: error.message
        });
      }
    }
  }

  async verifyPurchase(paymentMethod, verificationData) {
    switch (paymentMethod) {
      case "google_play":
        return await this.verifyGooglePurchase(verificationData);
      case "google_pay":
        return await this.verifyGooglePurchase(verificationData);
      case "stripe":
        return await this.verifyStripePurchase(verificationData);
      case "apple":
        return await this.verifyApplePurchase(verificationData);
      default:
        return { success: false };
    }
  }

  getTransactionId(paymentMethod, verificationData) {
    switch (paymentMethod) {
      case "stripe":
        return verificationData.paymentIntentId;
      case "google_play":
      case "google_pay":
        return verificationData.transactionId;
      case "apple":
        return verificationData.transactionId || verificationData.originalTransactionId;
      default:
        return null;
    }
  }

  async verifyGooglePurchase(verificationData) {
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_KEY_PATH,
        scopes: ["https://www.googleapis.com/auth/androidpublisher"],
      });

      const authClient = await auth.getClient();
      google.options({ auth: authClient });

      const response = await androidpublisher.purchases.subscriptionsv2.get({
        packageName: process.env.PACKAGE_NAME,
        token: verificationData.purchaseToken,
      });

      const isActive = response.data.subscriptionState === "SUBSCRIPTION_STATE_ACTIVE";
      const isTestPurchase = !!response.data.testPurchase;

      if (isActive && (isTestPurchase || response.data.paymentState === 1)) {
        if (response.data.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
          await androidpublisher.purchases.subscriptions.acknowledge({
            packageName: process.env.PACKAGE_NAME,
            subscriptionId: verificationData.productId,
            token: verificationData.purchaseToken,
          });
        }
        return { success: true };
      } else {
        console.warn(`[verifyGooglePurchase] Payment NOT verified. Subscription state: ${response.data.subscriptionState}, Payment state: ${response.data.paymentState}`);
        return { success: false };
      }
    } catch (error) {
      console.error(`[verifyGooglePurchase] Google verification error: ${error.message || error}`);
      if (error.response?.data) {
        console.error("Google API Error Response:", error.response.data);
      }
      return { success: false };
    }
  }

  async verifyStripePurchase(verificationData) {
    try {
      const { paymentIntentId } = verificationData;

      if (!paymentIntentId) {
        console.error("[verifyStripePurchase] Missing paymentIntentId");
        return { success: false };
      }
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status === "succeeded") {
        return { success: true };
      } else {
        console.warn(`[verifyStripePurchase] Payment NOT verified. Status: ${paymentIntent.status}`);
        return { success: false };
      }
    } catch (error) {
      console.error(`[verifyStripePurchase] Stripe verification error: ${error.message || error}`);
      return { success: false };
    }
  }

  async verifyApplePurchase(verificationData) {
    try {
      const { receiptData, productId } = verificationData;

      if (!receiptData) {
        console.error("[verifyApplePurchase] Missing receiptData");
        return { success: false };
      }

      if (receiptData.startsWith("eyJ")) {
        const tx = this.decodeJWS(receiptData);

        const isActive = this.isAppStoreSubscriptionActive(tx);

        if (tx.productId === productId && isActive) {
          return {
            success: true,
            transactionId: tx.transactionId,
            originalTransactionId: tx.originalTransactionId,
            productId: tx.productId,
            expiresDate: tx.expiresDate,
          };
        }
        return { success: false };
      }

      const url = process.env.APPLE_SANDBOX === "true"
        ? "https://sandbox.itunes.apple.com/verifyReceipt"
        : "https://buy.itunes.apple.com/verifyReceipt";

      const response = await axios.post(url, {
        "receipt-data": receiptData,
        password: process.env.APPLE_SHARED_SECRET,
        "exclude-old-transactions": true,
      });

      const { status, latest_receipt_info } = response.data;

      if (status !== 0) {
        console.error(`[verifyApplePurchase] Receipt validation failed. Status: ${status}`);
        return { success: false };
      }

      const activeTransaction = latest_receipt_info?.find(
        (tx) => tx.product_id === productId && new Date(parseInt(tx.expires_date_ms)) > new Date()
      );

      if (activeTransaction) {
        return {
          success: true,
          transactionId: activeTransaction.transaction_id,
          originalTransactionId: activeTransaction.original_transaction_id,
          productId: activeTransaction.product_id,
          expiresDate: activeTransaction.expires_date_ms,
        };
      }
      return { success: false };
    } catch (error) {
      console.error(`[verifyApplePurchase] Apple verification error: ${error.message}`);
      return { success: false };
    }
  }

  decodeJWS(jws) {
    const parts = jws.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWS format");
    const payload = Buffer.from(parts[1], "base64").toString("utf8");
    return JSON.parse(payload);
  }

  isAppStoreSubscriptionActive(transactionInfo) {
    if (!transactionInfo) {
      return false;
    }

    if (transactionInfo.revocationDate) {
      return false;
    }

    if (!transactionInfo.expiresDate) {
      return true;
    }

    const expires = new Date(transactionInfo.expiresDate);
    const now = new Date();
    const isActive = expires > now;
   
    return isActive;
  }

  async recordPayment(userId, planId, paymentMethod, verificationData) {
  try {
    const plan = await SubscriptionService.getPlanById(planId);
    const transactionId = this.getTransactionId(paymentMethod, verificationData);

    const paymentRecord = new PaymentRecord({
      userId,
      planId,
      paymentMethod,
      transactionId: transactionId,
      amount: plan ? plan.price : verificationData.amount,
      platform: verificationData.platform || (paymentMethod === "apple" ? "ios" : "android"),
      receiptData: paymentMethod === "stripe" ? verificationData.paymentIntentId 
               : paymentMethod === "apple" ? verificationData.receiptData 
               : verificationData.purchaseToken,
      status: "completed",
      planSnapshot: plan ? {
        name: plan.name,
        type: plan.type,
        price: plan.price,
        totalCredits: plan.totalCredits,
        imageGenerationCredits: plan.imageGenerationCredits,
        promptGenerationCredits: plan.promptGenerationCredits,
        features: plan.features,
        version: plan.version,
      } : null,
    });

    if (paymentMethod === "apple" && verificationData.originalTransactionId) {
      paymentRecord.originalTransactionId = verificationData.originalTransactionId;
    }
    await paymentRecord.save();
  } catch (error) {
    console.error(`[recordPayment] Error saving payment record:`, error);
    throw error;
  }
}

  async refundPayment(req, res) {
    try {
      const { transactionId, paymentMethod, userId, planId, reason } = req.body;

      if (!transactionId || !paymentMethod || !userId || !planId) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: transactionId, paymentMethod, userId, planId"
        });
      }

      let refundResult;
      switch (paymentMethod) {
        case 'apple':
          refundResult = await PaymentReversalService.reverseApplePayment(transactionId, userId, planId, reason);
          break;
        case 'google_play':
        case 'google_pay':
          refundResult = await PaymentReversalService.reverseGooglePayment(transactionId, userId, planId, reason);
          break;
        case 'stripe':
          refundResult = await PaymentReversalService.reverseStripePayment(transactionId, userId, planId, reason);
          break;
        default:
          return res.status(400).json({ 
            success: false, 
            error: "Unsupported payment method" 
          });
      }

      if (refundResult.success) {
        await SendNotificationService.sendCustomNotification(
          userId,
          userId,
          {
            title: "Refund Processed",
            body: `Your subscription payment has been refunded. Reason: ${reason}`,
            type: "system",
            action: "refund_processed",
            data: {
              type: "refund",
              transactionId: transactionId,
              planId: planId,
            }
          }
        );
      }

      res.json({
        success: refundResult.success,
        data: refundResult,
        message: refundResult.success ? "Refund processed successfully" : "Refund failed"
      });

    } catch (error) {
      console.error(`[refundPayment] Error:`, error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async getRefundStatus(req, res) {
    try {
      const { transactionId, paymentMethod } = req.query;

      if (!transactionId || !paymentMethod) {
        return res.status(400).json({
          success: false,
          error: "Missing required parameters: transactionId, paymentMethod"
        });
      }

      const status = await PaymentReversalService.getRefundStatus(transactionId, paymentMethod);

      res.json({
        success: status.success,
        data: status
      });

    } catch (error) {
      console.error(`[getRefundStatus] Error:`, error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async startTrial(req, res) {
    try {
      const { paymentMethod } = req.body;
      const userId = req.user.userId;

      const trial = await SubscriptionService.startFreeTrial(
        userId,
        paymentMethod
      );

      await HistoryService.recordSubscription(userId, {
        planId: trial.planId,
        startDate: trial.startDate,
        endDate: trial.endDate,
        status: "trial",
        paymentMethod,
        action: "trial_started",
        planSnapshot: trial.planSnapshot,
      });

      await HistoryService.updateCreditUsage(userId);

      await SendNotificationService.sendCustomNotification(
        userId,
        userId,
        {
          title: "Free Trial Started 🚀",
          body: "Your free trial has started! Enjoy premium features.",
          type: "system",
          action: "trial_started",
          data: {
            type: "trial",
            planId: trial.planId,
            endDate: trial.endDate,
          }
        }
      );

      res.json({
        success: true,
        data: trial,
        message: "Free trial started successfully",
      });
    } catch (error) {
      console.error(`[startTrial] Error:`, error);
      res.status(400).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async cancelSubscription(req, res) {
    try {
      const { immediate, userId } = req.body;
      const currentSubscription = await SubscriptionService.getUserActiveSubscription(userId);

      const result = await SubscriptionService.cancelSubscription(
        userId,
        immediate
      );

      await HistoryService.recordSubscription(userId, {
        planId: currentSubscription?.planId,
        startDate: currentSubscription?.startDate,
        endDate: new Date(),
        status: immediate ? "cancelled" : "pending_cancellation",
        paymentMethod: currentSubscription?.paymentMethod,
        action: "subscription_cancelled",
        adminNotes: immediate ? "Immediate cancellation" : "End of period cancellation",
        planSnapshot: currentSubscription?.planSnapshot,
      });

      await HistoryService.updateCreditUsage(userId);

      await SendNotificationService.sendCustomNotification(
        userId,
         userId,
        {
          title: immediate ? "Subscription Cancelled" : "Subscription Will Not Renew",
          body: immediate ? 
            "Your subscription has been cancelled immediately." : 
            "Your subscription will not renew at the end of the current period.",
          type: "system",
          action: "subscription_cancelled",
          data: {
            type: "subscription",
            planId: currentSubscription?.planId,
            immediate: immediate,
          }
        }
      );

      res.json({
        success: true,
        data: result,
        message: immediate ? "Subscription cancelled immediately" : "Subscription set to not renew",
      });
    } catch (error) {
      console.error(`[cancelSubscription] Error:`, error);
      res.status(400).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async getCurrentSubscription(req, res) {
    try {
      const userId = req.query.userId;
      const subscription = await SubscriptionService.getUserActiveSubscription(userId);
      
      if (!subscription) {
        return res.json({
          success: true,
          data: null,
          message: "No active subscription",
        });
      }

      res.json({ 
        success: true, 
        data: subscription 
      });
    } catch (error) {
      console.error(`[getCurrentSubscription] Error:`, error);
      res.status(400).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async checkGeneration(req, res) {
    try {
      const { generationType } = req.params;
      const userId = req.user.userId;
      const limits = await SubscriptionService.checkGenerationLimits(
        userId,
        generationType
      );

      if (limits.allowed) {
        await HistoryService.updateCreditUsage(userId);
      }

      if (!limits.allowed && limits.reason === "credits_exhausted") {
        await SendNotificationService.sendCustomNotification(
          userId,
          userId,
          {
            title: "Credits Exhausted",
            body: "You've used all your generation credits. Upgrade your plan to continue.",
            type: "system",
            action: "credits_exhausted",
            data: {
              type: "credits",
              generationType: generationType,
            }
          }
        );
      }

      res.json({ 
        success: true, 
        data: limits 
      });
    } catch (error) {
      console.error(`[checkGeneration] Error:`, error);
      res.status(400).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async getSubscriptionHistory(req, res) {
    try {
      const { userId } = req.params;
      const history = await HistoryService.getUserHistory(userId);

      res.json({
        success: true,
        data: history?.subscriptions || [],
      });
    } catch (error) {
      console.error(`[getSubscriptionHistory] Error:`, error);
      res.status(400).json({ 
        success: false, 
        error: error.message 
      });
    }
  }
}

module.exports = new SubscriptionController();