const crypto = require("crypto");

const COOKIE_NAME = "uc_admin_session";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function readCookie(req, name) {
  const prefix = `${name}=`;
  const item = String(req.headers?.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function createAdminAuth({
  sessions = new Map(),
  getCredentials = () => ({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  }),
  isProduction = () => process.env.NODE_ENV === "production",
  now = () => Date.now(),
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  tokenFactory = () => crypto.randomBytes(32).toString("base64url"),
  loginWindowMs = 15 * 60 * 1000,
  maxLoginAttempts = 10,
} = {}) {
  const loginAttempts = new Map();
  function sessionCookie(token, maxAge) {
    const parts = [
      `${COOKIE_NAME}=${token}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/api",
      `Max-Age=${maxAge}`,
    ];
    if (isProduction()) parts.push("Secure");
    return parts.join("; ");
  }

  function login(req, res) {
    const configured = getCredentials();
    if (!configured?.username || !configured?.password) {
      return res.status(503).json({
        success: false,
        code: "ADMIN_AUTH_NOT_CONFIGURED",
        message: "Admin sign-in is not configured on this server.",
      });
    }

    const username = req.body?.username;
    const password = req.body?.password;
    const validInput =
      typeof username === "string" &&
      typeof password === "string" &&
      username.length <= 256 &&
      password.length <= 1024;
    const ip = String(req.ip || "unknown");
    const attempt = loginAttempts.get(ip) || { count: 0, startedAt: now() };
    if (now() - attempt.startedAt > loginWindowMs) {
      attempt.count = 0;
      attempt.startedAt = now();
    }
    if (attempt.count >= maxLoginAttempts) {
      res.setHeader("Retry-After", String(Math.ceil((loginWindowMs - (now() - attempt.startedAt)) / 1000)));
      return res.status(429).json({ success: false, message: "Too many sign-in attempts. Try again later." });
    }
    const usernameMatches = safeEqual(validInput ? username : "", configured.username);
    const passwordMatches = safeEqual(validInput ? password : "", configured.password);
    if (!validInput || !usernameMatches || !passwordMatches) {
      attempt.count += 1;
      loginAttempts.set(ip, attempt);
      return res.status(401).json({
        success: false,
        message: "Username or password is incorrect.",
      });
    }

    const token = tokenFactory();
    loginAttempts.delete(ip);
    const expiresAt = now() + sessionTtlMs;
    sessions.set(token, { role: "admin", expiresAt });
    res.setHeader("Set-Cookie", sessionCookie(token, Math.floor(sessionTtlMs / 1000)));
    return res.status(200).json({ success: true, user: { role: "admin" } });
  }

  function requireAdmin(req, res, next) {
    const token = readCookie(req, COOKIE_NAME);
    const session = token ? sessions.get(token) : null;
    if (!session || session.expiresAt <= now()) {
      if (token) sessions.delete(token);
      return res.status(401).json({
        success: false,
        message: "Admin sign-in is required.",
      });
    }
    if (session.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "This account cannot access admin reports.",
      });
    }
    req.admin = { role: session.role };
    return next();
  }

  function me(req, res) {
    return res.status(200).json({ success: true, user: req.admin });
  }

  function logout(req, res) {
    const token = readCookie(req, COOKIE_NAME);
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    return res.status(200).json({ success: true });
  }

  return { login, logout, me, requireAdmin, sessions, loginAttempts };
}

module.exports = { createAdminAuth, COOKIE_NAME, DEFAULT_SESSION_TTL_MS };
