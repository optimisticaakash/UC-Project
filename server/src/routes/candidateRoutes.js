const express = require("express");
const { createCandidateAuth } = require("../services/candidateAuth");
const interviewController = require("../controllers/interviewController");

const router = express.Router();
const candidateAuth = createCandidateAuth();

router.post("/login", candidateAuth.login);
router.post("/logout", candidateAuth.logout);
router.get("/me", candidateAuth.requireCandidate, candidateAuth.me);
router.get("/interviews", candidateAuth.requireCandidate, interviewController.listCandidateInterviewsForCurrentUser);

module.exports = { router, candidateAuth };
