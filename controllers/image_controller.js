const Image = require("../models/image_model");

const getAllImages = async (req, res) => {
  try {
    let page = parseInt(req.query.page) || 1;
    if (page < 1) page = 1;

    const limit = 40;
    const filter = { $or: [{ privacy: "public" }, { privacy: { $exists: false } }] };

    const totalImages = await Image.countDocuments(filter);
    const totalPages = Math.ceil(totalImages / limit);
    const skip = (page - 1) * limit;

    const images = await Image.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      message: "Images fetched successfully",
      currentPage: page,
      totalPages: totalPages,
      totalImages: totalImages,
      images: images
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
};

const getAllImagesByAdmin = async (req, res) => {
  try {
    const images = await Image.find({})
      .populate('creator', 'username email')
      .populate('likes', '_id')
      .populate('comments', '_id')
      .populate('saves', '_id')
      .lean();

    // Transform images with proper counts
    const transformedImages = images.map(image => ({
      _id: image._id,
      imageUrl: image.url,
      prompt: image.prompt,
      modelName: image.model,
      privacy: image.privacy,
      username: image.creator?.username,
      creatorEmail: image.creator?.email,
      likeCount: image.likes?.length || 0,
      commentCount: image.comments?.length || 0,
      savedCount: image.saves?.length || 0,
      viewCount: image.views || 0,
      createdAt: image.createdAt,
      updatedAt: image.updatedAt
    }));

    // Calculate total statistics
    const totalImages = transformedImages.length;
    const totalLikes = transformedImages.reduce((sum, img) => sum + img.likeCount, 0);
    const totalComments = transformedImages.reduce((sum, img) => sum + img.commentCount, 0);
    const totalSaves = transformedImages.reduce((sum, img) => sum + img.savedCount, 0);
    const totalViews = transformedImages.reduce((sum, img) => sum + img.viewCount, 0);

    // Group by privacy
    const privacyStats = transformedImages.reduce((acc, img) => {
      acc[img.privacy] = (acc[img.privacy] || 0) + 1;
      return acc;
    }, {});

    // Get trending images (last 7 days with likes)
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const trendingImages = transformedImages.filter(img => 
      new Date(img.createdAt) >= oneWeekAgo && img.likeCount > 0
    ).length;

    res.status(200).json({
      success: true,
      images: transformedImages,
      statistics: {
        totalImages,
        totalLikes,
        totalComments,
        totalSaves,
        totalViews,
        privacyStats,
        trendingImages,
        avgLikesPerImage: totalImages > 0 ? (totalLikes / totalImages).toFixed(1) : 0,
        avgCommentsPerImage: totalImages > 0 ? (totalComments / totalImages).toFixed(1) : 0,
        avgSavesPerImage: totalImages > 0 ? (totalSaves / totalImages).toFixed(1) : 0,
        publicImages: privacyStats.public || 0,
        privateImages: privacyStats.private || 0,
        followersImages: privacyStats.followers || 0
      },
      pagination: {
        total: totalImages
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching images',
      error: error.message
    });
  }
};

module.exports = { getAllImages, getAllImagesByAdmin };
