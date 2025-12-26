const Notification = require("../../models/notification_model");
const User = require("../../models/user");
const mongoose = require("mongoose");

class NotificationService {
  async sendSubscriptionNotification(userId, eventType, subscription) {
    try {
      const user = await User.findOne({
        _id: mongoose.Types.ObjectId.isValid(userId) ? mongoose.Types.ObjectId(userId) : userId,
      });
      if (!user) {
        console.error("[NotificationService] User not found:", userId);
        return;
      }

      let title, body;

      switch (eventType) {
        case "new":
          title = "🎉 Subscription Activated!";
          body = `Your ${subscription.planSnapshot.name} subscription has started. Enjoy your premium features!`;
          break;
        case "trial_started":
          title = "🎉 Free Trial Started!";
          body = `Your ${subscription.planSnapshot.name} trial has started. Enjoy premium features for 7 days!`;
          break;
        case "upgraded":
          title = "🚀 Plan Upgraded!";
          body = `Your subscription has been upgraded to ${subscription.planSnapshot.name}. Your unused credits have been carried over!`;
          break;
        case "cancelled":
          title = "Subscription Cancelled";
          body = "Your subscription has been cancelled. You've been downgraded to the free plan.";
          break;
        case "pending_cancellation":
          title = "Subscription Update";
          body = "Your subscription will not renew at the end of the current period.";
          break;
        case "renewal_reminder":
          title = "Subscription Renewal Reminder";
          body = `Your ${subscription.planSnapshot.name} subscription will renew in 3 days.`;
          break;
        case "renewed":
          title = "Subscription Renewed";
          body = `Your ${subscription.planSnapshot.name} subscription has been renewed. Thank you!`;
          break;
        case "payment_failed":
          title = "Payment Failed";
          body = "We couldn't process your subscription payment. You've been downgraded to the free plan.";
          break;
        case "expired":
          title = "Subscription Expired";
          body = "Your subscription has expired. You've been downgraded to the free plan.";
          break;
        default:
          console.debug("[NotificationService] Unknown event type:", eventType);
          return;
      }

      const notification = new Notification({
        userId: userId,
        title,
        body,
        type: "user",
        data: {
          eventType,
          subscriptionId: subscription._id,
          planName: subscription.planSnapshot.name,
        },
      });

      await notification.save();

    } catch (error) {
      console.error("[NotificationService] sendSubscriptionNotification failed:", error);
      throw error;
    }
  }
}

module.exports = NotificationService;