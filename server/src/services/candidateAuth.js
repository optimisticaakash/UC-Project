const crypto = require("crypto");
const { promisify } = require("node:util");
const { persistence } = require("./persistence");

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = "uc_candidate_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function readCookie(req) {
  const prefix = `${COOKIE_NAME}=`;
  const item = String(req.headers?.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function normalizeLoginIdentifier(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validLoginIdentifier(value) {
  return typeof value === "string" && value.length <= 160 && (
    /^[a-z0-9._+-]{3,80}$/u.test(value) ||
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value)
  );
}

function validCandidateEmail(value) {
  return typeof value === "string" && value.length <= 160 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value);
}

function candidateProvisionValidationError({ name, loginIdentifier, password }) {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName) return { field: "name", message: "Enter the candidate’s name." };
  if (normalizedName.length > 160) return { field: "name", message: "Candidate name must be 160 characters or fewer." };
  if (!loginIdentifier) return { field: "email", message: "Enter the candidate’s email address." };
  if (!validCandidateEmail(loginIdentifier)) {
    return { field: "email", message: "Enter a valid email address of 160 characters or fewer." };
  }
  if (typeof password !== "string" || !password.length) return { field: "password", message: "Enter an initial password." };
  if (password.length < 8) return { field: "password", message: "Initial password must be at least 8 characters." };
  if (password.length > 1024) return { field: "password", message: "Initial password must be 1,024 characters or fewer." };
  return null;
}

async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = await scrypt(password, salt, 64, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password, encoded) {
  if (typeof encoded !== "string") return false;
  const [scheme, saltText, hashText, extra] = encoded.split("$");
  if (scheme !== "scrypt" || !saltText || !hashText || extra !== undefined) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await scrypt(password, salt, expected.length, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createCandidateAuth({
  store = persistence,
  now = () => Date.now(),
  tokenFactory = () => crypto.randomBytes(32).toString("base64url"),
  isProduction = () => process.env.NODE_ENV === "production",
  passwordHasher = hashPassword,
  passwordVerifier = verifyPassword,
} = {}) {
  const loginAttempts = new Map();

  function cookie(token, maxAge) {
    const attributes = [
      `${COOKIE_NAME}=${token}`,
      "HttpOnly",
      "SameSite=None",
      "Path=/api",
      `Max-Age=${maxAge}`,
    ];
    if (isProduction()) attributes.push("Secure");
    return attributes.join("; ");
  }

  async function provision(req, res) {
    if (!store.isConnected()) {
      return res.status(503).json({ success: false, code: "CANDIDATE_STORAGE_UNAVAILABLE", message: "Candidate account storage is unavailable." });
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const loginIdentifier = normalizeLoginIdentifier(req.body?.loginIdentifier);
    const password = req.body?.password;
    const validationError = candidateProvisionValidationError({ name, loginIdentifier, password });
    if (validationError) return res.status(400).json({ success: false, field: validationError.field, message: validationError.message });

    try {
      const candidate = await store.createCandidate({
        candidateId: crypto.randomUUID(),
        name,
        loginIdentifier,
        passwordHash: await passwordHasher(password),
        role: "candidate",
        active: true,
      });
      return res.status(201).json({
        success: true,
        candidate: {
          candidateId: candidate.candidateId,
          name: candidate.name,
          loginIdentifier: candidate.loginIdentifier,
          role: "candidate",
          active: candidate.active,
          createdAt: candidate.createdAt,
        },
      });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({ success: false, field: "email", message: "An account already uses this email address." });
      }
      console.error("Candidate provisioning failed:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "CANDIDATE_STORAGE_UNAVAILABLE", message: "Candidate account could not be saved." });
    }
  }

  async function list(req, res) {
    try {
      const candidates = await store.listCandidates();
      return res.status(200).json({ success: true, candidates });
    } catch (error) {
      console.error("Candidate list unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "CANDIDATE_STORAGE_UNAVAILABLE", message: "Candidate account list is unavailable." });
    }
  }

  async function deactivate(req, res) {
    const { candidateId } = req.params || {};
    if (!ACCOUNT_ID_PATTERN.test(String(candidateId || ""))) return res.status(400).json({ success: false, message: "Enter a valid candidate account ID." });
    if (!store.isConnected()) return res.status(503).json({ success: false, message: "Candidate account update is unavailable." });
    try {
      const candidate = await store.deactivateCandidateAndSessions(candidateId);
      if (!candidate) return res.status(404).json({ success: false, message: "Active candidate account was not found." });
      return res.status(200).json({
        success: true,
        message: "Candidate account deactivated. Existing interview history and reports have been preserved.",
        candidate: { candidateId: candidate.candidateId, name: candidate.name, loginIdentifier: candidate.loginIdentifier, active: false, createdAt: candidate.createdAt },
      });
    } catch (error) {
      console.error("Candidate deactivation unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, message: "Candidate account could not be deactivated. Try again later." });
    }
  }

  async function activate(req, res) {
    const { candidateId } = req.params || {};
    if (!ACCOUNT_ID_PATTERN.test(String(candidateId || ""))) return res.status(400).json({ success: false, message: "Enter a valid candidate account ID." });
    if (!store.isConnected()) return res.status(503).json({ success: false, message: "Candidate account update is unavailable." });
    try {
      const candidate = await store.activateCandidate(candidateId);
      if (!candidate) return res.status(404).json({ success: false, message: "Inactive candidate account was not found." });
      return res.status(200).json({
        success: true,
        message: "Candidate account activated. The candidate can sign in again.",
        candidate: { candidateId: candidate.candidateId, name: candidate.name, loginIdentifier: candidate.loginIdentifier, active: true, deletedAt: null, createdAt: candidate.createdAt },
      });
    } catch (error) {
      console.error("Candidate activation unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, message: "Candidate account could not be activated. Try again later." });
    }
  }

  async function deleteAccount(req, res) {
    const { candidateId } = req.params || {};
    if (!ACCOUNT_ID_PATTERN.test(String(candidateId || ""))) return res.status(400).json({ success: false, message: "Enter a valid candidate account ID." });
    if (!store.isConnected()) return res.status(503).json({ success: false, message: "Candidate account removal is unavailable." });
    try {
      const candidate = await store.deleteCandidateAccountAndSessions(candidateId);
      if (!candidate) return res.status(404).json({ success: false, message: "Candidate account was not found or has already been removed." });
      return res.status(200).json({
        success: true,
        message: "Candidate sign-in account removed. Interview history, reports, and PDFs remain preserved.",
        candidate: { candidateId: candidate.candidateId, name: candidate.name, loginIdentifier: candidate.loginIdentifier, active: false, deletedAt: candidate.deletedAt, createdAt: candidate.createdAt },
      });
    } catch (error) {
      console.error("Candidate account removal unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, message: "Candidate account could not be removed. Try again later." });
    }
  }

  async function login(req, res) {
    if (!store.isConnected()) {
      return res.status(503).json({ success: false, code: "CANDIDATE_STORAGE_UNAVAILABLE", message: "Candidate sign-in is temporarily unavailable." });
    }
    const ip = String(req.ip || "unknown");
    const attempt = loginAttempts.get(ip) || { count: 0, startedAt: now() };
    if (now() - attempt.startedAt > LOGIN_WINDOW_MS) {
      attempt.count = 0;
      attempt.startedAt = now();
    }
    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
      res.setHeader("Retry-After", String(Math.ceil((LOGIN_WINDOW_MS - (now() - attempt.startedAt)) / 1000)));
      return res.status(429).json({ success: false, message: "Too many sign-in attempts. Try again later." });
    }

    const loginIdentifier = normalizeLoginIdentifier(req.body?.loginIdentifier);
    const password = req.body?.password;
    if (!validLoginIdentifier(loginIdentifier) || typeof password !== "string" || password.length > 1024) {
      attempt.count += 1;
      loginAttempts.set(ip, attempt);
      return res.status(401).json({ success: false, message: "Login identifier or password is incorrect." });
    }

    try {
      const candidate = await store.findCandidateByLogin(loginIdentifier);
      const passwordMatches = candidate?.active
        ? await passwordVerifier(password, candidate.passwordHash)
        : false;
      if (!candidate || !candidate.active || !passwordMatches) {
        attempt.count += 1;
        loginAttempts.set(ip, attempt);
        return res.status(401).json({ success: false, message: "Login identifier or password is incorrect." });
      }

      const token = tokenFactory();
      await store.createAuthSession({
        tokenHash: tokenHash(token),
        role: "candidate",
        principalId: candidate.candidateId,
        name: candidate.name,
        expiresAt: new Date(now() + SESSION_TTL_MS),
      });
      loginAttempts.delete(ip);
      res.setHeader("Set-Cookie", cookie(token, Math.floor(SESSION_TTL_MS / 1000)));
      return res.status(200).json({
        success: true,
        user: { role: "candidate", candidateId: candidate.candidateId, name: candidate.name },
      });
    } catch (error) {
      console.error("Candidate sign-in unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "CANDIDATE_STORAGE_UNAVAILABLE", message: "Candidate sign-in is temporarily unavailable." });
    }
  }

  async function requireCandidate(req, res, next) {
    const token = readCookie(req);
    if (!token) {
      return res.status(401).json({ success: false, message: "Candidate sign-in is required." });
    }
    try {
      const session = await store.findAuthSession(tokenHash(token), new Date(now()));
      if (!session) return res.status(401).json({ success: false, message: "Candidate sign-in is required." });
      if (session.role !== "candidate") {
        return res.status(403).json({ success: false, message: "This account cannot access candidate interviews." });
      }
      const candidate = await store.findCandidateById(session.principalId);
      if (!candidate?.active || candidate.deletedAt) {
        return res.status(401).json({ success: false, message: "Candidate sign-in is required." });
      }
      req.candidate = {
        role: "candidate",
        candidateId: candidate.candidateId,
        name: candidate.name,
        loginIdentifier: candidate.loginIdentifier,
      };
      return next();
    } catch (error) {
      console.error("Candidate session lookup unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "CANDIDATE_STORAGE_UNAVAILABLE", message: "Candidate session verification is temporarily unavailable." });
    }
  }

  function me(req, res) {
    return res.status(200).json({ success: true, user: req.candidate });
  }

  async function logout(req, res) {
    const token = readCookie(req);
    try {
      if (token && store.isConnected()) await store.deleteAuthSession(tokenHash(token));
      else if (token) return res.status(503).json({ success: false, code: "CANDIDATE_STORAGE_UNAVAILABLE", message: "Candidate sign-out could not be confirmed." });
      res.setHeader("Set-Cookie", cookie("", 0));
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Candidate sign-out unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "CANDIDATE_STORAGE_UNAVAILABLE", message: "Candidate sign-out could not be confirmed." });
    }
  }

  return { provision, list, deactivate, activate, deleteAccount, login, logout, me, requireCandidate, loginAttempts };
}

module.exports = {
  createCandidateAuth,
  normalizeLoginIdentifier,
  validLoginIdentifier,
  validCandidateEmail,
  candidateProvisionValidationError,
  hashPassword,
  verifyPassword,
  COOKIE_NAME,
  SESSION_TTL_MS,
};
