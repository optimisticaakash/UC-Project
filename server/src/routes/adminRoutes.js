const express = require("express");
const { createAdminAuth } = require("../services/adminAuth");

const router = express.Router();
const adminAuth = createAdminAuth();

router.post("/login", adminAuth.login);
router.post("/logout", adminAuth.logout);
router.get("/me", adminAuth.requireAdmin, adminAuth.me);

module.exports = { router, adminAuth };
