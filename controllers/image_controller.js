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

const getAllImagesByAmdin = async (req, res) => {
  try {
    const filter = { $or: [{ privacy: "public" }, { privacy: { $exists: false } }] };
    const totalImages = await Image.countDocuments(filter);
    const images = await Image.find(filter)
      .sort({ createdAt: -1 })
    res.json({
      success: true,
      message: "Images fetched successfully",
      totalImages: totalImages,
      images: images
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
};

module.exports = { getAllImages, getAllImagesByAmdin };
