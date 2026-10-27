const crypto = require("crypto");
const { persistence } = require("./persistence");
const {
  normalizeLoginIdentifier,
  validLoginIdentifier,
  hashPassword,
  verifyPassword,
} = require("./candidateAuth");

const COOKIE_NAME = "uc_admin_session";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function readCookie(req, name = COOKIE_NAME) {
  const prefix = `${name}=`;
  const item = String(req.headers?.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function safeEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left)).digest();
  const rightDigest = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function createAdminAuth({
  store = persistence,
  getCredentials = () => ({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }),
  getSetupToken = () => process.env.ADMIN_SETUP_TOKEN,
  isProduction = () => process.env.NODE_ENV === "production",
  now = () => Date.now(),
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  tokenFactory = () => crypto.randomBytes(32).toString("base64url"),
  passwordHasher = hashPassword,
  passwordVerifier = verifyPassword,
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

  function rateLimit(req, res) {
    const ip = String(req.ip || "unknown");
    const attempt = loginAttempts.get(ip) || { count: 0, startedAt: now() };
    if (now() - attempt.startedAt > loginWindowMs) {
      attempt.count = 0;
      attempt.startedAt = now();
    }
    if (attempt.count >= maxLoginAttempts) {
      res.setHeader("Retry-After", String(Math.ceil((loginWindowMs - (now() - attempt.startedAt)) / 1000)));
      return { limited: true, ip, attempt };
    }
    return { limited: false, ip, attempt };
  }

  function invalidLogin(req, res, rate) {
    rate.attempt.count += 1;
    loginAttempts.set(rate.ip, rate.attempt);
    return res.status(401).json({ success: false, message: "Username or password is incorrect." });
  }

  async function establishSession(admin, res) {
    const token = tokenFactory();
    const expiresAt = new Date(now() + sessionTtlMs);
    await store.createAuthSession({
      tokenHash: tokenHash(token),
      role: "admin",
      principalId: admin.adminId,
      name: admin.name,
      expiresAt,
    });
    res.setHeader("Set-Cookie", sessionCookie(token, Math.floor(sessionTtlMs / 1000)));
    return { role: "admin", adminId: admin.adminId, name: admin.name };
  }

  async function login(req, res) {
    if (!store.isConnected()) {
      return res.status(503).json({ success: false, code: "ADMIN_STORAGE_UNAVAILABLE", message: "Admin sign-in is temporarily unavailable." });
    }
    const rate = rateLimit(req, res);
    if (rate.limited) return res.status(429).json({ success: false, message: "Too many sign-in attempts. Try again later." });
    const loginIdentifier = normalizeLoginIdentifier(req.body?.loginIdentifier ?? req.body?.username);
    const password = req.body?.password;
    if (!validLoginIdentifier(loginIdentifier) || typeof password !== "string" || password.length > 1024) {
      return invalidLogin(req, res, rate);
    }

    try {
      let admin = await store.findAdminByLogin(loginIdentifier);
      if (admin?.active && await passwordVerifier(password, admin.passwordHash)) {
        loginAttempts.delete(rate.ip);
        const user = await establishSession(admin, res);
        return res.status(200).json({ success: true, user });
      }

      // Migrate the prior env-configured administrator only while no database
      // admin exists. Once migrated or bootstrapped, that legacy credential is disabled.
      const adminCount = admin ? 1 : await store.countAdmins();
      if (!admin && adminCount === 0) {
        const configured = getCredentials();
        if ((!configured?.username || !configured?.password) && !getSetupToken()) {
          return res.status(503).json({
            success: false,
            code: "ADMIN_AUTH_NOT_CONFIGURED",
            message: "Configure the legacy admin credentials or ADMIN_SETUP_TOKEN on this server.",
          });
        }
        const configuredIdentifier = normalizeLoginIdentifier(configured?.username);
        const legacyMatch = Boolean(
          configuredIdentifier && typeof configured?.password === "string" &&
          safeEqual(loginIdentifier, configuredIdentifier) && safeEqual(password, configured.password),
        );
        if (legacyMatch) {
          const claimed = await store.claimFirstAdminSetup();
          if (!claimed) {
            admin = await store.findAdminByLogin(configuredIdentifier);
            if (!admin) {
              return res.status(503).json({ success: false, code: "ADMIN_SETUP_IN_PROGRESS", message: "Admin account setup is in progress. Try again shortly." });
            }
          }
          try {
            if (!admin) {
              admin = await store.createAdmin({
                adminId: crypto.randomUUID(),
                name: "Administrator",
                loginIdentifier: configuredIdentifier,
                passwordHash: await passwordHasher(configured.password),
                role: "admin",
                active: true,
              });
            }
          } catch (error) {
            if (claimed) await store.releaseFirstAdminSetup();
            if (error?.code !== 11000) throw error;
            admin = await store.findAdminByLogin(configuredIdentifier);
          }
          if (admin?.active && await passwordVerifier(password, admin.passwordHash)) {
            loginAttempts.delete(rate.ip);
            const user = await establishSession(admin, res);
            return res.status(200).json({ success: true, user });
          }
        }
      }
      return invalidLogin(req, res, rate);
    } catch (error) {
      console.error("Admin sign-in unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "ADMIN_STORAGE_UNAVAILABLE", message: "Admin sign-in is temporarily unavailable." });
    }
  }

  async function setup(req, res) {
    if (!store.isConnected()) {
      return res.status(503).json({ success: false, code: "ADMIN_STORAGE_UNAVAILABLE", message: "Admin setup is temporarily unavailable." });
    }
    const configuredToken = getSetupToken();
    if (typeof configuredToken !== "string" || configuredToken.length < 32) {
      return res.status(503).json({ success: false, code: "ADMIN_SETUP_NOT_CONFIGURED", message: "Configure ADMIN_SETUP_TOKEN with at least 32 characters before first-admin setup." });
    }
    const rate = rateLimit(req, res);
    if (rate.limited) return res.status(429).json({ success: false, message: "Too many setup attempts. Try again later." });
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const loginIdentifier = normalizeLoginIdentifier(req.body?.loginIdentifier ?? req.body?.username);
    const password = req.body?.password;
    const providedToken = req.body?.setupToken;
    if (!safeEqual(typeof providedToken === "string" ? providedToken : "", configuredToken)) {
      rate.attempt.count += 1;
      loginAttempts.set(rate.ip, rate.attempt);
      return res.status(401).json({ success: false, message: "Setup token is incorrect." });
    }
    loginAttempts.delete(rate.ip);
    if (!name || name.length > 160 || !validLoginIdentifier(loginIdentifier) || typeof password !== "string" || password.length < 12 || password.length > 1024) {
      return res.status(400).json({ success: false, message: "Enter a name, valid login identifier, and a password of at least 12 characters." });
    }

    let claimed = false;
    try {
      if ((await store.countAdmins()) > 0) {
        return res.status(409).json({ success: false, message: "First-admin setup has already been completed." });
      }
      claimed = await store.claimFirstAdminSetup();
      if (!claimed || (await store.countAdmins()) > 0) {
        if (claimed) await store.releaseFirstAdminSetup();
        return res.status(409).json({ success: false, message: "First-admin setup has already been completed." });
      }
      const admin = await store.createAdmin({
        adminId: crypto.randomUUID(),
        name,
        loginIdentifier,
        passwordHash: await passwordHasher(password),
        role: "admin",
        active: true,
      });
      const user = await establishSession(admin, res);
      return res.status(201).json({ success: true, user });
    } catch (error) {
      if (claimed) {
        try { await store.releaseFirstAdminSetup(); } catch { /* keep the original failure */ }
      }
      if (error?.code === 11000) return res.status(409).json({ success: false, message: "An admin account with that login identifier already exists." });
      console.error("Admin setup failed:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "ADMIN_STORAGE_UNAVAILABLE", message: "Admin setup could not be completed." });
    }
  }

  async function requireAdmin(req, res, next) {
    const token = readCookie(req);
    if (!token) return res.status(401).json({ success: false, message: "Admin sign-in is required." });
    try {
      const session = await store.findAuthSession(tokenHash(token), new Date(now()));
      if (!session) return res.status(401).json({ success: false, message: "Admin sign-in is required." });
      if (session.role !== "admin") {
        return res.status(403).json({ success: false, message: "This account cannot access admin reports." });
      }
      req.admin = { role: "admin", adminId: session.principalId, name: session.name };
      return next();
    } catch (error) {
      console.error("Admin session lookup unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "ADMIN_STORAGE_UNAVAILABLE", message: "Admin session verification is temporarily unavailable." });
    }
  }

  function me(req, res) {
    return res.status(200).json({ success: true, user: req.admin });
  }

  async function listAdmins(req, res) {
    if (!store.isConnected()) return res.status(503).json({ success: false, message: "Admin account list is unavailable." });
    try {
      const admins = await store.listAdmins();
      return res.status(200).json({ success: true, admins: admins.map(({ adminId, name, loginIdentifier, active, createdAt }) => ({ adminId, name, loginIdentifier, active, createdAt })) });
    } catch (error) {
      console.error("Admin account list unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, message: "Admin account list is unavailable." });
    }
  }

  async function deleteAdmin(req, res) {
    const { adminId } = req.params || {};
    if (!ACCOUNT_ID_PATTERN.test(String(adminId || ""))) return res.status(400).json({ success: false, message: "Enter a valid admin account ID." });
    if (adminId === req.admin?.adminId) return res.status(409).json({ success: false, message: "You cannot delete the admin account you are currently using." });
    if (!store.isConnected()) return res.status(503).json({ success: false, message: "Admin account deletion is unavailable." });
    try {
      const result = await store.deleteAdminAndSessions(adminId);
      if (result === "last-admin") return res.status(409).json({ success: false, message: "The last active admin account cannot be deleted." });
      if (result !== "deleted") return res.status(404).json({ success: false, message: "Active admin account was not found." });
      return res.status(200).json({ success: true, message: "Admin account deleted and its existing sessions invalidated." });
    } catch (error) {
      console.error("Admin account deletion unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, message: "Admin account could not be deleted. Try again later." });
    }
  }

  async function logout(req, res) {
    const token = readCookie(req);
    try {
      if (token && store.isConnected()) await store.deleteAuthSession(tokenHash(token));
      else if (token) return res.status(503).json({ success: false, code: "ADMIN_STORAGE_UNAVAILABLE", message: "Admin sign-out could not be confirmed." });
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Admin sign-out unavailable:", error?.name || "Error", error?.code || null);
      return res.status(503).json({ success: false, code: "ADMIN_STORAGE_UNAVAILABLE", message: "Admin sign-out could not be confirmed." });
    }
  }

  return { login, setup, logout, me, requireAdmin, listAdmins, deleteAdmin, loginAttempts };
}

module.exports = { createAdminAuth, COOKIE_NAME, DEFAULT_SESSION_TTL_MS, tokenHash };
