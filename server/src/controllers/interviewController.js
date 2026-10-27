const interviewService = require("../services/interview");
const { persistence } = require("../services/persistence");
const { isDeepStrictEqual } = require("node:util");
const crypto = require("node:crypto");
const { generateInterviewReportPdf, getReportPdfHash } = require("../services/reportPdf");
const reportPdfJobs = new Map();

const sessionWrites = new Map();

function reportPdfFilename(sessionId) {
  const safeSessionId = String(sessionId || "report").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120) || "report";
  return `interview-report-${safeSessionId}.pdf`;
}

function reportPdfErrorDiagnostic(error, report) {
  let message = String(error?.message || "Unknown PDF error").slice(0, 500);
  const sensitiveValues = new Set([report?.sessionId, report?.candidateName]);
  const visit = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (value.length >= 4) sensitiveValues.add(value);
      return;
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1));
    else if (typeof value === "object") Object.values(value).forEach((item) => visit(item, depth + 1));
  };
  visit(report);
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length >= 4) message = message.split(value).join("[report text redacted]");
  }
  message = message
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/giu, "[database URI redacted]")
    .replace(/(bearer\s+)[^\s]+/giu, "$1[redacted]");
  const stackFrames = String(error?.stack || "")
    .split("\n")
    .slice(1)
    .filter((line) => /^\s+at\s/u.test(line))
    .slice(0, 6)
    .map((line) => line.trim());
  return {
    errorName: String(error?.name || "Error").slice(0, 100),
    message,
    stackFrames,
  };
}

function ensureSessionLoaded(session) {
  if (session && !interviewService.getSessionForPersistence(session.sessionId)) {
    interviewService.restoreSessionSnapshot(session.sessionId, session);
  }
}

function serializeSessionWrite(sessionId, operation) {
  const previous = sessionWrites.get(sessionId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  sessionWrites.set(sessionId, current);
  return current.finally(() => {
    if (sessionWrites.get(sessionId) === current) sessionWrites.delete(sessionId);
  });
}

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

async function persistMutation(sessionId, operation) {
  const before = interviewService.getSessionSnapshot(sessionId);
  const result = await operation();
  const current = interviewService.getSessionForPersistence(sessionId);
  if (current && !isDeepStrictEqual(before, current)) {
    try {
      await persistence.saveSession(current);
    } catch (error) {
      interviewService.restoreSessionSnapshot(sessionId, before);
      error.persistenceFailure = true;
      throw error;
    }
  }
  return result;
}

async function generateAndPersistReportPdf(sessionId) {
  if (reportPdfJobs.has(sessionId)) return reportPdfJobs.get(sessionId);
  const job = (async () => {
    const storedSession = await persistence.findSessionById(sessionId);
    if (!storedSession) return null;
    ensureSessionLoaded(storedSession);
    const result = interviewService.getReport(sessionId);
    if (!result.body?.report) return null;
    const report = result.body.report;
    if (report.candidateId) {
      const candidate = await persistence.findCandidateById(report.candidateId);
      report.candidateName = candidate?.name || "Name not recorded";
    }
    const reportHash = getReportPdfHash(report);
    const filename = reportPdfFilename(sessionId);
    const liveSession = interviewService.getSessionForPersistence(sessionId);
    try {
      if (liveSession) {
        liveSession.reportPdfStatus = { status: "generating", attemptedAt: new Date().toISOString() };
        await persistence.saveSession(liveSession);
      }
      const pdf = await persistence.getOrCreateReportPdf({
        sessionId,
        reportHash,
        filename,
        generatePdf: () => generateInterviewReportPdf(report),
      });
      if (!pdf) throw new Error("The interview report PDF was not persisted.");
      if (liveSession) {
        liveSession.reportPdfRef = { fileId: pdf.fileId, reportHash, filename };
        liveSession.reportPdfStatus = { status: "generated", generatedAt: new Date().toISOString() };
        await persistence.saveSession(liveSession);
      }
      return pdf;
    } catch (error) {
      error.reportPdfDiagnostic = reportPdfErrorDiagnostic(error, report);
      if (liveSession) {
        liveSession.reportPdfStatus = {
          status: "failed",
          attemptedAt: new Date().toISOString(),
          errorCode: typeof error?.code === "string" ? error.code : "PDF_GENERATION_FAILED",
        };
        await persistence.saveSession(liveSession).catch(() => {});
      }
      throw error;
    }
  })();
  reportPdfJobs.set(sessionId, job);
  try {
    return await job;
  } finally {
    if (reportPdfJobs.get(sessionId) === job) reportPdfJobs.delete(sessionId);
  }
}

function persistenceUnavailable(res) {
  return res.status(503).json({
    success: false,
    code: "INTERVIEW_STORAGE_UNAVAILABLE",
    message: "Interview storage is temporarily unavailable. Please retry.",
  });
}

async function startInterview(req, res) {
  let started;
  try {
    started = interviewService.startInterview({
      candidateId: req.candidate?.candidateId,
    });
    try {
      await persistence.saveSession(interviewService.getSessionForPersistence(started.sessionId));
    } catch (error) {
      error.persistenceFailure = true;
      throw error;
    }
    return res.status(200).json(started);
  } catch (error) {
    if (started?.sessionId) interviewService.restoreSessionSnapshot(started.sessionId, null);
    if (error?.persistenceFailure || error?.name?.startsWith("Mongo")) {
      console.error("Interview start persistence failed:", error?.name || "Error", error?.code || null);
      return persistenceUnavailable(res);
    }
    console.error("Start interview error:", error?.name || "Error");

    return res.status(500).json({
      success: false,
      message: "Unable to start the interview.",
    });
  }
}


async function submitAnswer(req, res) {
  const sessionId = req.body?.sessionId;
  return serializeSessionWrite(sessionId, () => submitAnswerUnlocked(req, res));
}

async function submitAnswerUnlocked(req, res) {
  const requestStartedAt = process.hrtime.bigint();
  try {
    const submittedAnswer = req.body?.answer;
    if (req.candidate) {
      const ownedSession = interviewService.getSessionForPersistence(req.body?.sessionId);
      if (!ownedSession || ownedSession.candidateId !== req.candidate.candidateId) {
        return res.status(404).json({ success: false, message: "Interview session not found." });
      }
    }
    console.info("[UC Interview Diagnostics] answer_request_received", {
      requestId:
        typeof req.body?.diagnosticRequestId === "string" &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(req.body.diagnosticRequestId)
          ? req.body.diagnosticRequestId
          : null,
      receivedAt: new Date().toISOString(),
      sessionKey:
        typeof req.body?.sessionId === "string"
          ? req.body.sessionId.slice(-8)
          : null,
      expectedQuestionId:
        typeof req.body?.expectedQuestionId === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(req.body.expectedQuestionId)
          ? req.body.expectedQuestionId
          : null,
      promptTurn:
        Number.isSafeInteger(req.body?.diagnosticPromptTurn) &&
        req.body.diagnosticPromptTurn >= 0
          ? req.body.diagnosticPromptTurn
          : null,
      sessionGeneration:
        Number.isSafeInteger(req.body?.diagnosticSessionGeneration) &&
        req.body.diagnosticSessionGeneration >= 0
          ? req.body.diagnosticSessionGeneration
          : null,
      answerFieldPresent: Object.prototype.hasOwnProperty.call(
        req.body || {},
        "answer",
      ),
      answerFieldType: typeof submittedAnswer,
      answerChars:
        typeof submittedAnswer === "string" ? submittedAnswer.length : null,
    });

    const sessionId = req.body?.sessionId;
    const result = await persistMutation(sessionId, () =>
      interviewService.submitAnswer(req.body || {}),
    );

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
      promptTurn:
        Number.isSafeInteger(req.body?.diagnosticPromptTurn) &&
        req.body.diagnosticPromptTurn >= 0
          ? req.body.diagnosticPromptTurn
          : null,
      sessionGeneration:
        Number.isSafeInteger(req.body?.diagnosticSessionGeneration) &&
        req.body.diagnosticSessionGeneration >= 0
          ? req.body.diagnosticSessionGeneration
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
      serviceElapsedMs: Number(
        (Number(process.hrtime.bigint() - requestStartedAt) / 1e6).toFixed(1),
      ),
    });

    if (body.completed && result.status < 400) {
      await generateAndPersistReportPdf(sessionId).catch((error) => {
        console.error("Final report PDF generation failed:", error?.name || "Error", error?.code || null);
      });
    }

    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error?.persistenceFailure || error?.name?.startsWith("Mongo")) {
      console.error("Interview answer persistence failed:", error?.name || "Error", error?.code || null);
      return persistenceUnavailable(res);
    }
    console.error("[UC Interview Diagnostics] answer_error", {
      errorName: error?.name || "Error",
      httpStatus: error?.status || null,
      serviceElapsedMs: Number(
        (Number(process.hrtime.bigint() - requestStartedAt) / 1e6).toFixed(1),
      ),
    });

    return res.status(500).json({
      success: false,
      message: "Unable to submit the answer.",
    });
  }
}


async function flagManualReview(req, res) {
  const sessionId = req.body?.sessionId;
  try {
    const result = await serializeSessionWrite(sessionId, () =>
      persistMutation(sessionId, () => interviewService.flagManualReview(
        sessionId,
        req.body?.reason,
      )),
    );
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error?.persistenceFailure || error?.name?.startsWith("Mongo")) {
      console.error("Manual-review persistence failed:", error?.name || "Error", error?.code || null);
      return persistenceUnavailable(res);
    }
    console.error("Flag manual review error:", error?.name || "Error");

    return res.status(500).json({
      success: false,
      message: "Unable to flag manual review.",
    });
  }
}

async function getReport(req, res) {
  try {
    if (!persistence.isConnected()) return persistenceUnavailable(res);
    const storedSession = await persistence.findSessionById(req.params.sessionId);
    if (!storedSession) return res.status(404).json({ success: false, message: "Interview session not found." });
    ensureSessionLoaded(storedSession);
    const result = interviewService.getReport(req.params.sessionId);
    if (result.body.report?.candidateId) {
      const candidate = await persistence.findCandidateById(result.body.report.candidateId);
      result.body.report.candidateName = candidate?.name || "Name not recorded";
    }

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Get report error:", error?.name || "Error");
    if (error?.name?.startsWith("Mongo") || !persistence.isConnected()) return persistenceUnavailable(res);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve the interview report.",
    });
  }
}

async function downloadReportPdf(req, res) {
  try {
    if (!persistence.isConnected()) return persistenceUnavailable(res);
    const sessionId = req.params.sessionId;
    const pdf = await generateAndPersistReportPdf(sessionId);
    if (!pdf) return res.status(404).json({ success: false, message: "Interview report not found." });
    const filename = reportPdfFilename(req.params.sessionId);
    if (!Buffer.isBuffer(pdf.buffer)) throw new TypeError("The report PDF service returned invalid data.");
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(pdf.buffer.length));
    return res.end(pdf.buffer);
  } catch (error) {
    console.error("Report PDF unavailable:", error?.reportPdfDiagnostic || reportPdfErrorDiagnostic(error));
    if (error?.name?.startsWith("Mongo") || !persistence.isConnected()) return persistenceUnavailable(res);
    return res.status(500).json({ success: false, message: "Unable to generate the interview PDF." });
  }
}

async function listReports(req, res) {
  try {
    if (!persistence.isConnected()) return persistenceUnavailable(res);
    const result = interviewService.listReports();
    const candidates = await persistence.listCandidates();
    const candidateNames = new Map(candidates.map((candidate) => [candidate.candidateId, candidate.name]));
    result.body.sessions = result.body.sessions.map((session) => ({
      ...session,
      candidateName: candidateNames.get(session.candidateId) || session.candidateName,
    }));
    result.body.storageMode = "mongodb";
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("List reports error:", error?.name || "Error");
    if (error?.name?.startsWith("Mongo") || !persistence.isConnected()) return persistenceUnavailable(res);
    return res.status(500).json({
      success: false,
      message: "Unable to list interview sessions.",
    });
  }
}

async function getAdminStats(req, res) {
  try {
    if (!persistence.isConnected()) return persistenceUnavailable(res);
    const [candidateCount] = await Promise.all([
      persistence.countCandidates(),
    ]);
    const reportResult = interviewService.listReports();
    const sessions = reportResult.body.sessions || [];
    return res.status(200).json({
      success: true,
      stats: {
        totalCandidates: candidateCount,
        totalInterviews: sessions.length,
        completedInterviews: sessions.filter((item) => item.status === "completed").length,
        pendingInterviews: sessions.filter((item) => item.status === "in_progress").length,
        incompleteInterviews: sessions.filter((item) => item.status === "incomplete").length,
        manualReviewInterviews: sessions.filter((item) => item.manualReviewRequired).length,
      },
    });
  } catch (error) {
    console.error("Admin dashboard statistics unavailable:", error?.name || "Error", error?.code || null);
    return persistenceUnavailable(res);
  }
}

async function listCandidateInterviews(req, res) {
  try {
    if (!persistence.isConnected()) return persistenceUnavailable(res);
    const candidate = await persistence.findCandidateById(req.params.candidateId);
    if (!candidate) return res.status(404).json({ success: false, message: "Candidate account not found." });
    const sessions = await persistence.listSessionsByCandidate(candidate.candidateId);
    const interviews = sessions.map((session) => {
      ensureSessionLoaded(session);
      return { ...interviewService.getReport(session.sessionId).body.report, candidateName: candidate.name };
    });
    return res.status(200).json({ success: true, interviews });
  } catch (error) {
    console.error("Candidate interview history unavailable:", error?.name || "Error", error?.code || null);
    return persistenceUnavailable(res);
  }
}

async function listCandidateInterviewsForCurrentUser(req, res) {
  try {
    if (!persistence.isConnected()) return persistenceUnavailable(res);
    const sessions = await persistence.listSessionsByCandidate(req.candidate.candidateId);
    const interviews = sessions.map((session) => {
      ensureSessionLoaded(session);
      const report = interviewService.getReport(session.sessionId).body.report;
      // Candidate history is intentionally a status summary, not an assessment
      // report. Keep answers and internal review fields on admin-only routes.
      return {
        sessionId: report.sessionId,
        status: report.status,
        startedAt: report.startedAt,
        endedAt: report.endedAt,
        answeredQuestions: report.answeredQuestions,
        totalQuestions: report.totalQuestions,
      };
    });
    return res.status(200).json({ success: true, interviews });
  } catch (error) {
    console.error("Candidate interview history unavailable:", error?.name || "Error", error?.code || null);
    return persistenceUnavailable(res);
  }
}

async function endInterview(req, res) {
  const sessionId = req.body?.sessionId;
  return serializeSessionWrite(sessionId, async () => {
  try {
    if (req.candidate) {
      const ownedSession = interviewService.getSessionForPersistence(sessionId);
      if (!ownedSession || ownedSession.candidateId !== req.candidate.candidateId) {
        return res.status(404).json({ success: false, message: "Interview session not found." });
      }
    }
    const result = await persistMutation(sessionId, () => interviewService.endInterview(sessionId));
    if (result.status < 400 && result.body?.sessionStatus && result.body.sessionStatus !== "in_progress") {
      await generateAndPersistReportPdf(sessionId).catch((error) => {
        console.error("Final report PDF generation failed:", error?.name || "Error", error?.code || null);
      });
    }
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error?.persistenceFailure || error?.name?.startsWith("Mongo")) {
      console.error("Interview end persistence failed:", error?.name || "Error", error?.code || null);
      return persistenceUnavailable(res);
    }
    console.error("End interview error:", error?.name || "Error");
    return res.status(500).json({
      success: false,
      message: "Unable to end the interview session.",
    });
  }
  });
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
    const errorName = error?.name || "Error";
    const errorMessage = typeof error?.message === "string" ? error.message : "";
    const isRateLimit =
      errorMessage.includes("429") ||
      errorMessage.toLowerCase().includes("rate limit") ||
      errorMessage.toLowerCase().includes("quota");

    console.error("Answer interpretation error:", errorName);

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
  downloadReportPdf,
  listReports,
  getAdminStats,
  listCandidateInterviews,
  listCandidateInterviewsForCurrentUser,
  endInterview,
  interpretCandidateAnswer,
  flagManualReview,
};
