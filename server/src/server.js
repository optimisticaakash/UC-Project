const express = require("express");
const cors = require("cors");
require("dotenv").config();

const interviewRoutes = require("./routes/interviewRoutes");
const adminRoutes = require("./routes/adminRoutes").router;
const candidateRoutes = require("./routes/candidateRoutes").router;
const { candidateAuth } = require("./routes/candidateRoutes");
const interviewService = require("./services/interview");
const { persistence } = require("./services/persistence");
const { liveVoiceInstructions } = require("./services/liveVoiceInstructions");
const { GoogleGenAI } = require("@google/genai");

const app = express();

// --- FIXED CORS CONFIGURATION ---
const allowedOrigins = [
  process.env.ADMIN_ALLOWED_ORIGIN,
  "https://uc-project-nu.vercel.app",
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Server-to-server ya direct requests bina origin ke hoti hain
      if (!origin) return callback(null, true);

      // Localhost checks (development ke liye)
      const isLocalDev =
        process.env.NODE_ENV !== "production" &&
        /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);

      // Vercel ke kisi bhi sub-domain (.vercel.app) ko allow karein
      const isVercel = origin.endsWith(".vercel.app");

      // Environment variable se match
      const isConfigured = allowedOrigins.includes(origin);

      if (isLocalDev || isVercel || isConfigured) {
        return callback(null, true);
      }

      return callback(new Error("Blocked by CORS policy"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-candidate-token"],
  }),
);

// Preflight OPTIONS requests ke liye
app.options("*", cors());

app.use(express.json());

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Urban Company Interviewer API is running",
    totalQuestions: interviewService.getTotalQuestions(),
    storageMode: "mongodb",
    storageConnected: persistence.isConnected(),
  });
});

app.use("/api/interview", interviewRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/candidate", candidateRoutes);

app.post(
  "/api/voice/session",
  candidateAuth.requireCandidate,
  async (req, res) => {
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
  },
);

async function startServer() {
  const PORT = process.env.PORT || 5001;
  try {
    await persistence.connect(process.env.MONGODB_URI);
    const restoredCount = interviewService.restoreSessions(
      await persistence.loadSessions(),
    );
    console.log(
      `[UC Persistence] MongoDB connected; restored ${restoredCount} interview sessions.`,
    );
  } catch (error) {
    const code = error?.code ?? error?.cause?.code ?? null;
    const failureKind =
      code === 8000 || code === "8000"
        ? "authentication_failed"
        : code === "MONGODB_URI_REQUIRED"
          ? "configuration_missing"
          : "mongodb_unavailable";
    console.error("[UC Persistence] MongoDB startup connection failed.", {
      failureKind,
      errorName: error?.name || "Error",
      errorCode: code,
      causeCode: error?.cause?.code ?? null,
    });
    console.error(
      "[UC Persistence] Starting API in degraded mode; interview writes and reports remain unavailable until MongoDB reconnects.",
    );
  }
  return app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(
      `Loaded ${interviewService.getTotalQuestions()} questions from questionBank.json`,
    );
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Server failed to start:", error?.name || "Error");
    process.exitCode = 1;
  });
}

module.exports = { app, startServer };
