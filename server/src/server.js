const express = require("express");
const cors = require("cors");
require("dotenv").config();

const interviewRoutes = require("./routes/interviewRoutes");
const interviewService = require("./services/interview");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Urban Company Interviewer API is running",
    totalQuestions: interviewService.getTotalQuestions(),
  });
});

app.use("/api/interview", interviewRoutes);

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

    const instructions =
      "You are a friendly, natural voice AI having a live conversation with a salon professional. " +
      "Speak in simple, natural Hindi or Hinglish, warmly and respectfully. " +
      "Listen carefully to what the candidate says and respond directly to their actual words. " +
      "Acknowledge their answers naturally, ask relevant follow-up questions when useful, and keep the conversation flowing. " +
      "Do not remain silent waiting for a controller message after the candidate speaks. " +
      "Do not repeat the same question unnecessarily. " +
      "Do not claim to be human. " +
      "For this temporary conversational demo, do not follow a fixed 49-question interview sequence or make hiring decisions. " +
      "Keep each response concise and conversational.";

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
            systemInstruction: instructions,
          },
        },
      },
    });

    return res.status(200).json({
      success: true,
      token: token.name,
    });
  } catch (error) {
    console.error("Gemini Live session error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not create Gemini Live session",
    });
  }
});

const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Loaded ${interviewService.getTotalQuestions()} questions from questionBank.json`,
  );
});
