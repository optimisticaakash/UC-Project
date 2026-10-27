const express = require("express");
const interviewController = require("../controllers/interviewController");
const { adminAuth } = require("./adminRoutes");
const { candidateAuth } = require("./candidateRoutes");

const router = express.Router();

router.post("/start", candidateAuth.requireCandidate, interviewController.startInterview);
router.post("/end", candidateAuth.requireCandidate, interviewController.endInterview);
router.post("/answer", candidateAuth.requireCandidate, interviewController.submitAnswer);
router.post("/manual-review", adminAuth.requireAdmin, interviewController.flagManualReview);
router.post("/interpret", adminAuth.requireAdmin, interviewController.interpretCandidateAnswer);
router.get("/sessions", adminAuth.requireAdmin, interviewController.listReports);
router.get("/:sessionId/report", adminAuth.requireAdmin, interviewController.getReport);
router.get("/:sessionId/report.pdf", adminAuth.requireAdmin, interviewController.downloadReportPdf);

module.exports = router;
