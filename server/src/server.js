const express = require("express");
const cors = require("cors");
require("dotenv").config();

const interviewRoutes = require("./routes/interviewRoutes");
const adminRoutes = require("./routes/adminRoutes").router;
const interviewService = require("./services/interview");
const { liveVoiceInstructions } = require("./services/liveVoiceInstructions");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(cors({
  origin(origin, callback) {
    const localDevOrigin =
      process.env.NODE_ENV !== "production" &&
      /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin || "");
    const configuredOrigin = Boolean(
      origin && process.env.ADMIN_ALLOWED_ORIGIN && origin === process.env.ADMIN_ALLOWED_ORIGIN,
    );
    callback(null, !origin || localDevOrigin || configuredOrigin ? origin || false : false);
  },
  credentials: true,
}));
app.use(express.json());

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Urban Company Interviewer API is running",
    totalQuestions: interviewService.getTotalQuestions(),
  });
});

app.use("/api/interview", interviewRoutes);
app.use("/api/admin", adminRoutes);

app.post("/api/voice/session", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "GEMINI_API_KEY is missing",
      });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: "gemini-3.8-live",
          config: {
            responseModalities: ["AUDIO"],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: liveVoiceInstructions,
          },
        },
      },
    });

    return res.status(200).json({
      success: true,
      token: token.name,
    });
  } catch (error) {
    console.error("Gemini Live session error:", error?.name || "Error");

    return res.status(500).json({
      success: false,
      message: "Could not create Gemini Live session",
    });
  }
});

async function startServer() {
  const PORT = process.env.PORT || 5001;
  return app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Loaded ${interviewService.getTotalQuestions()} questions from questionBank.json`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Server failed to start:", error?.name || "Error");
    process.exitCode = 1;
  });
}

module.exports = { app, startServer };
