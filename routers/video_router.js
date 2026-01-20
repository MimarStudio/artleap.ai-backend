const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { videoGenerationController } = require("../controllers/videoController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB file limit
  fileFilter: (req, file, cb) => {
    const ok = ["image/png", "image/jpeg"].includes(file.mimetype);
    cb(ok ? null : new Error("Only .png and .jpg files are allowed!"), ok);
  },
});

const videoRouter = express.Router();

videoRouter.post(
  "/text-to-video",
  upload.array("images", 3),
  videoGenerationController
);

videoRouter.get("/download-video/:filename", (req, res) => {
  try {
    const { filename } = req.params;

    const videoPath = path.join(
      process.cwd(),
      "public",
      "generated",
      filename
    );

    if (!fs.existsSync(videoPath)) {
      console.log("Video not found:", videoPath);
      return res.status(404).json({ message: "Video not found" });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.sendFile(videoPath);
  } catch (error) {
    console.error("Error downloading video:", error);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
})
module.exports = { videoRouter };