const express = require("express");
const interviewController = require("../controllers/interviewController");
const { adminAuth } = require("./adminRoutes");

const router = express.Router();

router.post("/start", interviewController.startInterview);
router.post("/end", interviewController.endInterview);
router.post("/answer", interviewController.submitAnswer);
router.post("/manual-review", adminAuth.requireAdmin, interviewController.flagManualReview);
router.post("/interpret", adminAuth.requireAdmin, interviewController.interpretCandidateAnswer);
router.get("/sessions", adminAuth.requireAdmin, interviewController.listReports);
router.get("/:sessionId/report", adminAuth.requireAdmin, interviewController.getReport);

module.exports = router;
