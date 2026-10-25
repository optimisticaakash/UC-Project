const express = require("express");
const interviewController = require("../controllers/interviewController");

const router = express.Router();

router.post("/start", interviewController.startInterview);
router.post("/answer", interviewController.submitAnswer);
router.post("/interpret", interviewController.interpretCandidateAnswer);
router.post("/manual-review", interviewController.flagManualReview);
router.get("/:sessionId/report", interviewController.getReport);

module.exports = router;
