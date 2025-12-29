const GooglePlanSyncService = require("./google/googlePlanSync");
const PlanManagement = require("./subscription_services/plansManagement");
const SubscriptionManagement = require("./subscription_services/subscriptionsManagement");
const PaymentProcessing = require("./subscription_services/paymentProcessing");
const SubscriptionNotificationService = require("./subscription_services/subscriptionNotificationService");
const CreditManagement = require("./subscription_services/creditsManagement");
const ApplePlanSync = require('./apple/applePlanSync');
const GoogleCancellationHandler = require("./google/googleCancellationHandler");
const AppleCancellationHandler = require("./apple/appleCancellationHandler");

class SubscriptionService {
  constructor() {
    this.planSync = new GooglePlanSyncService();
    this.applePlanSync = new ApplePlanSync();
    this.planManagement = new PlanManagement();
    this.subscriptionManagement = new SubscriptionManagement();
    this.paymentProcessing = new PaymentProcessing();
    this.notificationService = new SubscriptionNotificationService();
    this.creditManagement = new CreditManagement();
    this.googleCancellationHandler = new GoogleCancellationHandler();
    this.appleCancellationHandler = new AppleCancellationHandler();
  }

  async fixSubscriptionDataIssues() {
    try {
      const nullEndDateFix = await this.subscriptionManagement.fixNullEndDates();
      const orphanedCleanup = await this.subscriptionManagement.cleanupOrphanedSubscriptions();
      
      return {
        success: true,
        message: "Subscription data issues fixed successfully",
        fixes: {
          nullEndDates: nullEndDateFix,
          orphanedSubscriptions: orphanedCleanup
        }
      };
    } catch (error) {
      console.error("[SubscriptionService] Error fixing subscription data issues:", error);
      throw error;
    }
  }

  async checkAndHandleSubscriptionCancellations() {
    try {
      const googleResults = await this.googleCancellationHandler.getAllSubscriptionsFromPlayStore();
      const appleResults = await this.appleCancellationHandler.getAllSubscriptionsFromAppStore();
      await this.subscriptionManagement.processExpiredSubscriptions();
      await this.subscriptionManagement.processGracePeriodSubscriptions();
      await this.syncAllSubscriptionStatus();
      await this.cleanupOrphanedSubscriptions();
      
      return {
        google: googleResults,
        apple: appleResults
      };
    } catch (error) {
      console.error("[SubscriptionService] Error checking subscription cancellations:", error);
      throw error;
    }
  }

  async syncAllSubscriptionStatus() {
    try {
      const googleResults = await this.googleCancellationHandler.syncAllSubscriptionsWithPlayStore();
      const appleResults = await this.appleCancellationHandler.syncAllSubscriptionsWithAppStore();
      await this.subscriptionManagement.syncLocalSubscriptionStatus();
      
      return {
        google: googleResults,
        apple: appleResults
      };
    } catch (error) {
      console.error("[SubscriptionService] Error syncing subscription status:", error);
      throw error;
    }
  }

  async cleanupOrphanedSubscriptions() {
    try {
      const subscriptionCleanup = await this.subscriptionManagement.cleanupOrphanedSubscriptions();
      const paymentCleanup = await this.paymentProcessing.cleanupOrphanedPaymentRecords();
      
      return {
        subscriptionCleanup,
        paymentCleanup
      };
    } catch (error) {
      console.error("[SubscriptionService] Error cleaning up orphaned subscriptions:", error);
      throw error;
    }
  }

  async handleGoogleSubscriptionCancellation(purchaseToken) {
    try {
      return await this.googleCancellationHandler.processGoogleSubscriptionCancellation(purchaseToken);
    } catch (error) {
      console.error("[SubscriptionService] Error handling Google cancellation:", error);
      throw error;
    }
  }

  async handleAppleSubscriptionCancellation(originalTransactionId) {
    try {
      return await this.appleCancellationHandler.processAppleSubscriptionCancellation(originalTransactionId);
    } catch (error) {
      console.error("[SubscriptionService] Error handling Apple cancellation:", error);
      throw error;
    }
  }

  async forceSyncUserSubscription(userId) {
    try {
      const userSubscription = await this.subscriptionManagement.getUserActiveSubscription(userId);
  
      if (userSubscription && userSubscription.platform === 'android') {
        const paymentRecord = await this.paymentProcessing.getLatestPaymentRecord(userId);
        if (paymentRecord && paymentRecord.receiptData) {
          await this.googleCancellationHandler.processGoogleSubscriptionCancellation(paymentRecord.receiptData);
        }
      }
      
      if (userSubscription && userSubscription.platform === 'ios') {
        const paymentRecord = await this.paymentProcessing.getLatestPaymentRecord(userId);
        if (paymentRecord && paymentRecord.originalTransactionId) {
          await this.appleCancellationHandler.processAppleSubscriptionCancellation(paymentRecord.originalTransactionId);
        }
      }
      
      await this.subscriptionManagement.verifyUserSubscriptionStatus(userId);
      
      return await this.getUserActiveSubscription(userId);
    } catch (error) {
      console.error("[SubscriptionService] Error force syncing user subscription:", error);
      throw error;
    }
  }

  async syncPlansWithGooglePlay() {
    try {
      return await this.planSync.syncPlansWithGooglePlay();
    } catch (error) {
      console.error("[SubscriptionService] syncPlansWithGooglePlay failed:", error);
      throw error;
    }
  }

  async syncPlansWithAppStore() {
    try {
      return await this.applePlanSync.syncPlansWithAppStore();
    } catch (error) {
      console.error('[SubscriptionService] syncPlansWithAppStore failed:', error);
      throw error;
    }
  }

  async initializeDefaultPlans() {
    try {
      return await this.planManagement.initializeDefaultPlans();
    } catch (error) {
      console.error("[SubscriptionService] initializeDefaultPlans failed:", error);
      throw error;
    }
  }

  async getAvailablePlans() {
    try {
      const plans = await this.planManagement.getAvailablePlans();
      return plans;
    } catch (error) {
      console.error("[SubscriptionService] getAvailablePlans failed:", error);
      throw error;
    }
  }

  async getPlanById(planId) {
    try {
      const plan = await this.planManagement.getPlanById(planId);
      return plan;
    } catch (error) {
      console.error("[SubscriptionService] getPlanById failed:", error);
      throw error;
    }
  }

  async getPlanByType(type) {
    try {
      const plan = await this.planManagement.getPlanByType(type);
      return plan;
    } catch (error) {
      console.error("[SubscriptionService] getPlanByType failed:", error);
      throw error;
    }
  }

  async getUserActiveSubscription(userId) {
    try {
      const subscription = await this.subscriptionManagement.getUserActiveSubscription(userId);
      return subscription;
    } catch (error) {
      console.error("[SubscriptionService] getUserActiveSubscription failed:", error);
      throw error;
    }
  }

  async updateUserData(userId, plan, subscription = null, isSubscribed = true, isTrial = false, carryOverCredits = false) {
    try {
      const user = await this.subscriptionManagement.updateUserData(userId, plan, subscription, isSubscribed, isTrial, carryOverCredits);
      return user;
    } catch (error) {
      console.error("[SubscriptionService] updateUserData failed:", error);
      throw error;
    }
  }

  async createSubscription(userId, planId, paymentMethod, isTrial = false) {
    try {
      const subscription = await this.subscriptionManagement.createSubscription(userId, planId, paymentMethod, isTrial);
      return subscription;
    } catch (error) {
      console.error("[SubscriptionService] createSubscription failed:", error);
      throw error;
    }
  }

  async cancelSubscription(userId, immediate) {
    try {
      const subscription = await this.subscriptionManagement.cancelSubscription(userId, immediate);
      return subscription;
    } catch (error) {
      console.error("[SubscriptionService] cancelSubscription failed:", error);
      throw error;
    }
  }

  async processExpiredSubscriptions() {
    try {
      return await this.subscriptionManagement.processExpiredSubscriptions();
    } catch (error) {
      console.error("[SubscriptionService] processExpiredSubscriptions failed:", error);
      throw error;
    }
  }

  async renewSubscription(subscriptionId) {
    try {
      const subscription = await this.paymentProcessing.renewSubscription(subscriptionId);
      return subscription;
    } catch (error) {
      console.error("[SubscriptionService] renewSubscription failed:", error);
      throw error;
    }
  }

  // async processPayment(userId, paymentMethod, amount) {
  //   try {
  //     const result = await this.paymentProcessing.processPayment(userId, paymentMethod, amount);
  //     return result;
  //   } catch (error) {
  //     console.error("[SubscriptionService] processPayment failed:", error);
  //     throw error;
  //   }
  // }

  async sendSubscriptionNotification(userId, eventType, subscription) {
    try {
      await this.notificationService.sendSubscriptionNotification(userId, eventType, subscription);
    } catch (error) {
      console.error("[SubscriptionService] sendSubscriptionNotification failed:", error);
      throw error;
    }
  }

  async checkGenerationLimits(userId, generationType) {
    try {
      const result = await this.creditManagement.checkGenerationLimits(userId, generationType);
      return result;
    } catch (error) {
      console.error("[SubscriptionService] checkGenerationLimits failed:", error);
      throw error;
    }
  }

  async recordGenerationUsage(userId, generationType, num_images) {
    try {
      await this.creditManagement.recordGenerationUsage(userId, generationType, num_images);
    } catch (error) {
      console.error("[SubscriptionService] recordGenerationUsage failed:", error);
      throw error;
    }
  }

  async startFreeTrial(userId, paymentMethod) {
    try {
      const subscription = await this.subscriptionManagement.startFreeTrial(userId, paymentMethod);
      return subscription;
    } catch (error) {
      console.error("[SubscriptionService] startFreeTrial failed:", error);
      throw error;
    }
  }

  async forceExpireGoogleSubscription(purchaseToken) {
    try {
      return await this.googleCancellationHandler.forceExpireSubscription(purchaseToken);
    } catch (error) {
      console.error("[SubscriptionService] Error force expiring Google subscription:", error);
      throw error;
    }
  }

  async forceExpireAppleSubscription(transactionId) {
    try {
      return await this.appleCancellationHandler.forceExpireSubscription(transactionId);
    } catch (error) {
      console.error("[SubscriptionService] Error force expiring Apple subscription:", error);
      throw error;
    }
  }

  async getSubscriptionStats() {
    try {
      const googleStats = await this.googleCancellationHandler.getSubscriptionStats();
      const appleStats = await this.appleCancellationHandler.getSubscriptionStats();
      
      return {
        google: googleStats,
        apple: appleStats
      };
    } catch (error) {
      console.error("[SubscriptionService] Error getting subscription stats:", error);
      throw error;
    }
  }

  // async getSubscriptionHealthReport() {
  //   try {
  //     const report = {
  //       timestamp: new Date(),
  //       googleSubscriptions: await this.googleCancellationHandler.getSubscriptionStats(),
  //       appleSubscriptions: await this.appleCancellationHandler.getSubscriptionStats(),
  //       localSubscriptions: await this.subscriptionManagement.getSubscriptionStats(),
  //       paymentRecords: await this.paymentProcessing.getPaymentStats(),
  //       issues: await this.subscriptionManagement.getSubscriptionIssues()
  //     };
      
  //     return report;
  //   } catch (error) {
  //     console.error("[SubscriptionService] Error getting subscription health report:", error);
  //     throw error;
  //   }
  // }
}

module.exports = new SubscriptionService();