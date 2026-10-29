const express = require("express");
const interviewController = require("../controllers/interviewController");
const { adminAuth } = require("./adminRoutes");
const { candidateAuth } = require("./candidateRoutes");

const router = express.Router();

router.post("/start", candidateAuth.requireCandidate, interviewController.startInterview);
router.post("/end", candidateAuth.requireCandidate, interviewController.endInterview);
router.post("/pause", candidateAuth.requireCandidate, interviewController.pauseInterview);
router.post("/resume", candidateAuth.requireCandidate, interviewController.resumeInterview);
router.get("/active", candidateAuth.requireCandidate, interviewController.getActiveSession);
router.post("/answer", candidateAuth.requireCandidate, interviewController.submitAnswer);
router.post("/manual-review", adminAuth.requireAdmin, interviewController.flagManualReview);
router.post("/interpret", adminAuth.requireAdmin, interviewController.interpretCandidateAnswer);
router.get("/sessions", adminAuth.requireAdmin, interviewController.listReports);
router.get("/responses", adminAuth.requireAdmin, interviewController.getResponses);
router.get("/:sessionId/report", adminAuth.requireAdmin, interviewController.getReport);
router.delete("/:sessionId/report", adminAuth.requireAdmin, interviewController.deleteReport);
router.delete("/sessions/:sessionId", adminAuth.requireAdmin, interviewController.deleteReport);
router.get("/:sessionId/report.pdf", adminAuth.requireAdmin, interviewController.downloadReportPdf);

module.exports = router;
