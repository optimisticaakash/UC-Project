const interviewService = require("../services/interview");

function classifyDiagnosticResponse(status, body) {
  if (status >= 400 || !body.success) return "error";
  if (body.completed && body.manualReviewRequired) return "manual_review_terminal";
  if (body.completed && body.eligibilityOutcome === "reject") return "rejected_terminal";
  if (body.completed) return "completed_terminal";
  if (body.clarificationRequired && body.followUpRequired) return "clarification_follow_up";
  if (body.clarificationRequired) return "clarification";
  if (body.followUpRequired) return "follow_up";
  if (body.manualReviewRequired) return "manual_review_continuing";
  if (body.question) return "question_progression";
  return "response_without_question";
}

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
    const submittedAnswer = req.body?.answer;
    console.info("[UC Interview Diagnostics] answer_request_received", {
      requestId:
        typeof req.body?.diagnosticRequestId === "string" &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(req.body.diagnosticRequestId)
          ? req.body.diagnosticRequestId
          : null,
      sessionKey:
        typeof req.body?.sessionId === "string"
          ? req.body.sessionId.slice(-8)
          : null,
      expectedQuestionId:
        typeof req.body?.expectedQuestionId === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(req.body.expectedQuestionId)
          ? req.body.expectedQuestionId
          : null,
      answerFieldPresent: Object.prototype.hasOwnProperty.call(
        req.body || {},
        "answer",
      ),
      answerFieldType: typeof submittedAnswer,
      answerChars:
        typeof submittedAnswer === "string" ? submittedAnswer.length : null,
    });

    const result = await interviewService.submitAnswer(req.body || {});

    if (!result || typeof result.status !== "number" || !result.body) {
      console.error("[UC Interview Diagnostics] invalid_service_result", {
        resultType: typeof result,
        hasStatus: typeof result?.status === "number",
        hasBody: Boolean(result?.body),
      });

      return res.status(500).json({
        success: false,
        message: "Interview service returned an invalid response.",
      });
    }

    const body = result.body;
    console.info("[UC Interview Diagnostics] answer_response", {
      requestId:
        typeof req.body?.diagnosticRequestId === "string" &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(req.body.diagnosticRequestId)
          ? req.body.diagnosticRequestId
          : null,
      sessionKey:
        typeof req.body?.sessionId === "string"
          ? req.body.sessionId.slice(-8)
          : null,
      expectedQuestionId:
        typeof req.body?.expectedQuestionId === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(req.body.expectedQuestionId)
          ? req.body.expectedQuestionId
          : null,
      httpStatus: result.status,
      responseType: classifyDiagnosticResponse(result.status, body),
      questionId: body.question?.id || null,
      questionNumber: body.questionNumber ?? null,
      totalQuestions: body.totalQuestions ?? null,
      completed: Boolean(body.completed),
      clarificationRequired: Boolean(body.clarificationRequired),
      followUpRequired: Boolean(body.followUpRequired),
      manualReviewRequired: Boolean(body.manualReviewRequired),
      consentOutcome: body.consentOutcome || null,
      locationOutcome: body.locationOutcome || null,
      eligibilityOutcome: body.eligibilityOutcome || null,
      sessionStatus: body.sessionStatus || null,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("[UC Interview Diagnostics] answer_error", {
      errorName: error?.name || "Error",
      httpStatus: error?.status || null,
    });

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
