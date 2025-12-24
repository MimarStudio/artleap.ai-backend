const mongoose = require("mongoose");

const userSubscriptionSchema = new mongoose.Schema({
  userId: { type: String, ref: "User", required: true },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SubscriptionPlan",
    required: [true, 'Plan ID is required'],
    index: true,
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  isTrial: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  paymentMethod: { type: String },
  autoRenew: { type: Boolean, default: true },
  cancelledAt: { type: Date },
  planSnapshot: {
    name: { type: String, required: true },
    type: { type: String, required: true },
    price: { type: Number, required: true },
    totalCredits: { type: Number, required: true },
    imageGenerationCredits: { type: Number, required: true },
    promptGenerationCredits: { type: Number, required: true },
    features: [{ type: String }],
    version: { type: Number, required: true },
  },
});

userSubscriptionSchema.index({ userId: 1 });
userSubscriptionSchema.index({ endDate: 1 });
userSubscriptionSchema.index({ isActive: 1 });
userSubscriptionSchema.index({ userId: 1, isActive: 1 });


module.exports = mongoose.model("UserSubscription", userSubscriptionSchema);
