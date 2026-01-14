const path = require("path");
const fs = require("fs");
const { GoogleGenAI } = require("@google/genai");

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
  try {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ success: false, message: "GEMINI_API_KEY is missing." });
    }

    const ai = new GoogleGenAI({ apiKey: API_KEY });
    const { prompt, ratio = "16:9", duration = "6", model = "veo3" } = req.body;

    if (!prompt?.trim()) {
      return res.status(400).json({ success: false, message: "Prompt is required!" });
    }

    const files = req.files || [];
    const imagesB64 = filesToBase64(files);

    const { modelId, enableAudio } = pickModelId(model);

    const config = {
      aspectRatio: ratio,
      durationSeconds: Number(duration),
      enableAudio,
      image: imagesB64.length > 0 && imagesB64[0],
      last_frame: imagesB64.length > 0 && imagesB64[imagesB64.length - 1],
    };

    const payload = {
      model: modelId,
      prompt: prompt.trim(),
      config,
    };

    console.log("Generate video payload:", {
      modelId,
      ratio,
      duration,
      imagesUploaded: files.length,
      imagesUsed: modelId.includes("veo-2") ? Math.min(imagesB64.length, 1) : imagesB64.length,
    });

    let operation = await ai.models.generateVideos(payload);

    while (!operation.done) {
      await new Promise((r) => setTimeout(r, 8000));
      operation = await ai.operations.getVideosOperation({ operation });
      console.log("Video generation status: still processing...");
    }

    console.log("Video generation completed.");

    const videoRef = operation?.response?.generatedVideos?.[0]?.video;
    if (!videoRef) {
      return res.status(500).json({ success: false, message: "Video not generated." });
    }

    const outputDir = path.resolve(__dirname, "../public/generated");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputFile = `video_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputFile);

    await ai.files.download({ file: videoRef, downloadPath: outputPath });

    return res.status(200).json({
      success: true,
      message: "Video generated successfully.",
      output: {
        video_url: `/generated/${outputFile}`,
        model_used: modelId,
        duration: duration,
        aspect_ratio: ratio,
      }
    });
  } catch (error) {
    console.error("Video generation error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to generate video",
    });
  }
};

module.exports = { videoGenerationController };