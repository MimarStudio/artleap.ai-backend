const mongoose = require("mongoose");

const ImageSchema = new mongoose.Schema({
  userId: { type: String, ref: "User", required: true },
  username: { type: String, required: true },
  creatorEmail: { type: String },
  imageUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  modelName: { type: String },
  prompt: { type: String },
  privacy: { type: String, enum: ["public", "private", "followers", "personal"], default: "public", index: true },
  likeCount: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 }
});

ImageSchema.virtual("likes", {
  ref: "Like",
  localField: "_id",
  foreignField: "image"
});

ImageSchema.virtual("comments", {
  ref: "Comment",
  localField: "_id",
  foreignField: "image"
});

ImageSchema.virtual('savedCount', {
  ref: 'SavedImage',
  localField: '_id',
  foreignField: 'image',
  count: true
});

ImageSchema.set("toJSON", { virtuals: true });
ImageSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Image", ImageSchema);