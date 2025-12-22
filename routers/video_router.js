const express = require("express");
const multer = require("multer");
const { videoGenerationController } = require("../controllers/videoController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
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

module.exports = { videoRouter };