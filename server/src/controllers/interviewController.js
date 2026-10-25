const interviewService = require("../services/interview");

function startInterview(req, res) {
  try {
    return res.status(200).json(interviewService.startInterview());
  } catch (error) {
    console.error("Start interview error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to start the interview.",
    });
  }
}


async function submitAnswer(req, res) {
  try {
    const result = await interviewService.submitAnswer(req.body || {});

    if (!result || typeof result.status !== "number" || !result.body) {
      console.error(
        "Invalid submitAnswer service result:",
        JSON.stringify(result),
      );

      return res.status(500).json({
        success: false,
        message: "Interview service returned an invalid response.",
      });
    }

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Submit answer error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to submit the answer.",
    });
  }
}


function flagManualReview(req, res) {
  try {
    const result = interviewService.flagManualReview(
      req.body?.sessionId,
      req.body?.reason,
    );

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Flag manual review error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to flag manual review.",
    });
  }
}

function getReport(req, res) {
  try {
    const result = interviewService.getReport(req.params.sessionId);

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Get report error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve the interview report.",
    });
  }
}

async function interpretCandidateAnswer(req, res) {
  try {
    const { interpretAnswer } = require("../services/geminiService");

    const result = await interpretAnswer({
      question: req.body.question,
      answer: req.body.answer,
    });

    return res.status(200).json({
      success: true,
      interpretation: result,
    });
  } catch (error) {
    const message = error?.message || "";
    const isRateLimit =
      message.includes("429") ||
      message.toLowerCase().includes("rate limit") ||
      message.toLowerCase().includes("quota");

    console.error("Answer interpretation error:", message);

    if (isRateLimit) {
      return res.status(429).json({
        success: false,
        code: "AI_RATE_LIMIT",
        message:
          "AI service ki request limit poori ho gayi hai. Candidate ka answer reject nahi hua; interpretation service unavailable hai.",
      });
    }

    return res.status(503).json({
      success: false,
      code: "AI_INTERPRETATION_UNAVAILABLE",
      message:
        "Answer interpretation service abhi unavailable hai. Please retry later.",
    });
  }
}

module.exports = {
  startInterview,
  submitAnswer,
  getReport,
  interpretCandidateAnswer,
  flagManualReview,
};
