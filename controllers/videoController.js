const path = require("path");
const fs = require("fs");
const { GoogleGenAI } = require("@google/genai");
const { uploadVideoToS3 } = require("../utils/s3Uploader");
const User = require("../models/user");
console
function filesToBase64(files = []) {
  return files
    .filter(Boolean)
    .slice(0, 3)
    .map((f) => f.buffer.toString("base64"));
}

function pickModelId(model) {
  if (model === "veo2") {
    return { modelId: "veo-2.0-generate-001", enableAudio: false };
  }
  return { modelId: "veo-3.1-generate-preview", enableAudio: true };
}

const videoGenerationController = async (req, res) => {
  let localFilePath = null;

  try {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API configuration error: GEMINI_API_KEY is missing."
      });
    }

    const { prompt, ratio = "16:9", duration = "6", model = "veo3", userId } = req.body;

    if (!prompt?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Validation error: Prompt is required and cannot be empty."
      });
    }

    if (!userId?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Validation error: User ID is required."
      });
    }

    const durationNum = Number(duration);
    if (isNaN(durationNum) || durationNum < 1 || durationNum > 120) {
      return res.status(400).json({
        success: false,
        message: "Validation error: Duration must be a number between 1 and 120 seconds."
      });
    }

    const validRatios = ["1:1", "9:16", "16:9"];
    if (!validRatios.includes(ratio)) {
      return res.status(400).json({
        success: false,
        message: `Validation error: Invalid aspect ratio.
      `});
    };

    const files = req.files || [];
    const imagesB64 = filesToBase64(files);
    const ai = new GoogleGenAI({ apiKey: API_KEY });
    const { modelId, enableAudio } = pickModelId(model);

    const config = {
      aspectRatio: ratio,
      durationSeconds: durationNum,
      enableAudio,
      image: imagesB64.length > 0 && imagesB64[0],
      last_frame: imagesB64.length > 0 && imagesB64[imagesB64.length - 1],
    };

    const payload = {
      model: modelId,
      prompt: prompt.trim(),
      config,
    };

    let operation = await ai.models.generateVideos(payload);
    let pollingAttempts = 0;
    const maxAttempts = 50;

    while (!operation.done && pollingAttempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 8000));
      operation = await ai.operations.getVideosOperation({ operation });
      pollingAttempts++;
      console.log(`[Video Generation] Status check ${pollingAttempts}/${maxAttempts}: processing...`);
    }

    if (!operation.done) {
      throw new Error("Video generation timeout: exceeded maximum polling attempts.");
    }
    const videoRef = operation?.response?.generatedVideos?.[0]?.video;
    if (!videoRef) {
      throw new Error("Video generation completed but no video reference returned from API.");
    }

    const outputDir = path.resolve(__dirname, "../public/generated");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFile = `video_${Date.now()}_${userId}.mp4`;
    localFilePath = path.join(outputDir, outputFile);

    await ai.files.download({ file: videoRef, downloadPath: localFilePath });

    if (!fs.existsSync(localFilePath)) {
      throw new Error("Video download failed: file was not created at expected path.");
    }

    const bucketName = "artleap-videos";
    let s3Url;
    try {
      s3Url = await uploadVideoToS3(localFilePath, userId, bucketName);
    } catch (s3Error) {
      console.error(`[Video Generation] S3 upload failed: ${s3Error.message}`);
      throw new Error(`Failed to upload video to S3: ${s3Error.message}`);
    }

    try {
      await User.findByIdAndUpdate(
        userId,
        {
          $push: {
            videos: {
              url: s3Url,
              model: modelId,
              prompt: prompt.trim(),
              aspectRatio: ratio,
              duration: durationNum
            }
          }
        },
        { new: true }
      );
    } catch (dbError) {
      console.error(`[Video Generation] Failed to save video URL to user schema: ${dbError.message}`);
      throw new Error(`Failed to save video URL to user profile: ${dbError.message}`);
    }

    try {
      fs.unlinkSync(localFilePath);
      localFilePath = null;
    } catch (cleanupError) {
      console.warn(`[Video Generation] Warning: Failed to cleanup local file: ${cleanupError.message}`);
    }

    return res.status(200).json({
      success: true,
      message: "Video generated and uploaded successfully.",
      output: {
        video_url: s3Url,
        model_used: modelId,
        duration: durationNum,
        aspect_ratio: ratio,
        user_id: userId,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (localFilePath && fs.existsSync(localFilePath)) {
      try {
        fs.unlinkSync(localFilePath);
        console.log(`[Video Generation] Local file cleaned up after error: ${localFilePath}`);
      } catch (cleanupError) {
        console.warn(`[Video Generation] Warning: Failed to cleanup local file: ${cleanupError.message}`);
      }
    }

    console.error("[Video Generation] Error:", error);
    const statusCode = error.message.includes("Validation error") ? 400 : 500;
    const message = error.message.includes("Validation error")
      ? error.message
      : "Video generation failed. Please try again later.";

    return res.status(statusCode).json({
      success: false,
      message,
      ...(process.env.NODE_ENV === "development" && { error: error.message })
    });
  }
};

module.exports = { videoGenerationController };