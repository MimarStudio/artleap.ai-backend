const User = require("../../models/user");
const mongoose = require("mongoose");
const SendNotificationService = require("./../sendNotificationService");

class SubscriptionNotificationService {
  async sendSubscriptionNotification(userId, eventType, subscription) {
    try {
      const user = await User.findOne({
        _id: mongoose.Types.ObjectId.isValid(userId)
          ? mongoose.Types.ObjectId(userId)
          : userId,
      });
      if (!user) {
        return;
      }

      let title, body, action;

      switch (eventType) {
        case "new":
          title = "🎉 Subscription Activated!";
          body = `Your ${subscription.planSnapshot.name} subscription has started. Enjoy your premium features!`;
          action = "subscription_activated";
          break;
        case "trial_started":
          title = "🎉 Free Trial Started!";
          body = `Your ${subscription.planSnapshot.name} trial has started. Enjoy premium features for 7 days!`;
          action = "trial_started";
          break;
        case "upgraded":
          title = "🚀 Plan Upgraded!";
          body = `Your subscription has been upgraded to ${subscription.planSnapshot.name}. Your unused credits have been carried over!`;
          action = "plan_upgraded";
          break;
        case "cancelled":
          title = "Subscription Cancelled";
          body =
            "Your subscription has been cancelled. You've been downgraded to the free plan.";
          action = "subscription_cancelled";
          break;
        case "pending_cancellation":
          title = "Subscription Update";
          body =
            "Your subscription will not renew at the end of the current period.";
          action = "pending_cancellation";
          break;
        case "renewal_reminder":
          title = "Subscription Renewal Reminder";
          body = `Your ${subscription.planSnapshot.name} subscription will renew in 3 days.`;
          action = "renewal_reminder";
          break;
        case "renewed":
          title = "Subscription Renewed";
          body = `Your ${subscription.planSnapshot.name} subscription has been renewed. Thank you!`;
          action = "subscription_renewed";
          break;
        case "payment_failed":
          title = "Payment Failed";
          body =
            "We couldn't process your subscription payment. You've been downgraded to the free plan.";
          action = "payment_failed";
          break;
        case "expired":
          title = "Subscription Expired";
          body =
            "Your subscription has expired. You've been downgraded to the free plan.";
          action = "subscription_expired";
          break;
        default:
          return;
      }

      const notificationConfig = {
        title,
        body,
        type: "user",
        action: action,
        data: {
          eventType,
          subscriptionId: subscription._id.toString(),
          planName: subscription.planSnapshot.name,
          planId: subscription.planSnapshot._id?.toString(),
          action: action,
          timestamp: new Date().toISOString(),
        },
        contextInfo: {
          action: action,
          eventType: eventType,
          planName: subscription.planSnapshot.name,
          planId: subscription.planSnapshot._id?.toString(),
        },
      };
      await SendNotificationService.sendCustomNotification(
        userId,
        userId,
        notificationConfig
      );
    } catch (error) {
      throw error;
    }
  }
}

module.exports = SubscriptionNotificationService;
