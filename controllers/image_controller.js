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
      .populate({
        path: 'userId',
        select: 'username email',
        model: 'User'
      })
      .populate({
        path: 'likes',
        select: '_id',
        model: 'Like' 
      })
      .populate({
        path: 'comments',
        select: '_id',
        model: 'Comment'
      })
      .lean();

    // Transform images with proper counts
    const transformedImages = images.map(image => {
      return {
        _id: image._id,
        imageUrl: image.imageUrl,
        prompt: image.prompt,
        modelName: image.modelName,
        privacy: image.privacy,
        username: image.userId?.username || image.username || 'Unknown',
        creatorEmail: image.userId?.email || image.creatorEmail || 'Unknown',
        likeCount: image.likes?.length || image.likeCount || 0,
        commentCount: image.comments?.length || image.commentCount || 0,
        savedCount: 0,
        viewCount: image.viewCount || 0,
        createdAt: image.createdAt,
        updatedAt: image.updatedAt
      };
    });

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

    // Also, get a simple version for debugging
    const simpleImages = await Image.find({}).lean();
    console.log(`Found ${simpleImages.length} total images in database`);
    console.log('Sample image:', simpleImages[0]);

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
        followersImages: privacyStats.followers || 0,
        personalImages: privacyStats.personal || 0
      },
      pagination: {
        total: totalImages
      },
      debug: {
        totalImagesInDB: simpleImages.length,
        sampleImage: simpleImages[0]
      }
    });
  } catch (error) {
    console.error('Error in getAllImagesByAdmin:', error);
    console.error('Error stack:', error.stack);
    
    // Try a simpler query as fallback
    try {
      console.log('Trying simpler query...');
      const simpleImages = await Image.find({}).lean();
      
      const transformedImages = simpleImages.map(image => ({
        _id: image._id,
        imageUrl: image.imageUrl,
        prompt: image.prompt,
        modelName: image.modelName,
        privacy: image.privacy,
        username: image.username || 'Unknown',
        creatorEmail: image.creatorEmail || 'Unknown',
        likeCount: image.likeCount || 0,
        commentCount: image.commentCount || 0,
        savedCount: 0,
        viewCount: 0,
        createdAt: image.createdAt,
        updatedAt: image.updatedAt
      }));

      res.status(200).json({
        success: true,
        images: transformedImages,
        statistics: {
          totalImages: transformedImages.length,
          totalLikes: transformedImages.reduce((sum, img) => sum + img.likeCount, 0),
          totalComments: transformedImages.reduce((sum, img) => sum + img.commentCount, 0),
          totalSaves: 0,
          totalViews: 0,
          publicImages: transformedImages.filter(img => img.privacy === 'public').length,
          privateImages: transformedImages.filter(img => img.privacy === 'private').length,
          followersImages: transformedImages.filter(img => img.privacy === 'followers').length,
          personalImages: transformedImages.filter(img => img.privacy === 'personal').length,
          trendingImages: 0
        },
        message: 'Using fallback query (some data may be incomplete)'
      });
    } catch (fallbackError) {
      console.error('Fallback query also failed:', fallbackError);
      res.status(500).json({
        success: false,
        message: 'Error fetching images',
        error: error.message,
        fallbackError: fallbackError.message
      });
    }
  }
};

module.exports = { getAllImages, getAllImagesByAdmin };
