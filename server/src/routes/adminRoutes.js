const express = require("express");
const { createAdminAuth } = require("../services/adminAuth");

const router = express.Router();
const adminAuth = createAdminAuth();
const { createCandidateAuth } = require("../services/candidateAuth");
const candidateAuth = createCandidateAuth();
const interviewController = require("../controllers/interviewController");

router.post("/setup", adminAuth.setup);
router.post("/login", adminAuth.login);
router.post("/logout", adminAuth.logout);
router.get("/me", adminAuth.requireAdmin, adminAuth.me);
router.get("/admins", adminAuth.requireAdmin, adminAuth.listAdmins);
router.delete("/admins/:adminId", adminAuth.requireAdmin, adminAuth.deleteAdmin);
router.get("/stats", adminAuth.requireAdmin, interviewController.getAdminStats);
router.get("/candidates", adminAuth.requireAdmin, candidateAuth.list);
router.post("/candidates", adminAuth.requireAdmin, candidateAuth.provision);
router.patch("/candidates/:candidateId/deactivate", adminAuth.requireAdmin, candidateAuth.deactivate);
router.patch("/candidates/:candidateId/activate", adminAuth.requireAdmin, candidateAuth.activate);
router.delete("/candidates/:candidateId", adminAuth.requireAdmin, candidateAuth.deleteAccount);
router.get("/candidates/:candidateId/interviews", adminAuth.requireAdmin, interviewController.listCandidateInterviews);
router.get("/responses", adminAuth.requireAdmin, interviewController.getResponses);

module.exports = { router, adminAuth, candidateAuth };
