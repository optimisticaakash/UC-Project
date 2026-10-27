const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdminAuth } = require("./adminAuth");

function createStore() {
  const admins = new Map();
  const sessions = new Map();
  let bootstrapClaimed = false;
  return {
    admins,
    sessions,
    isConnected: () => true,
    async createAdmin(admin) {
      if ([...admins.values()].some((item) => item.loginIdentifier === admin.loginIdentifier)) {
        const error = new Error("duplicate"); error.code = 11000; throw error;
      }
      admins.set(admin.adminId, { ...admin });
      return { ...admin };
    },
    async findAdminByLogin(identifier) { return [...admins.values()].find((item) => item.loginIdentifier === identifier) || null; },
    async countAdmins() { return admins.size; },
    async listAdmins() { return [...admins.values()].map(({ passwordHash, ...safe }) => safe); },
    async deleteAdminAndSessions(adminId) {
      const target = admins.get(adminId);
      if (!target?.active) return "missing";
      if ([...admins.values()].filter((item) => item.active).length <= 1) return "last-admin";
      admins.delete(adminId);
      for (const [hash, session] of sessions) if (session.role === "admin" && session.principalId === adminId) sessions.delete(hash);
      return "deleted";
    },
    async claimFirstAdminSetup() { if (bootstrapClaimed) return false; bootstrapClaimed = true; return true; },
    async releaseFirstAdminSetup() { bootstrapClaimed = false; },
    async createAuthSession(session) { sessions.set(session.tokenHash, { ...session }); },
    async findAuthSession(hash, now = new Date()) {
      const session = sessions.get(hash);
      return session && new Date(session.expiresAt) > now ? { ...session } : null;
    },
    async deleteAuthSession(hash) { sessions.delete(hash); },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function invoke(handler, req) {
  const res = makeResponse();
  await handler(req, res, () => { res.nextCalled = true; });
  return res;
}

test("legacy configured admin migrates to a hashed Mongo-style record and gets a persistent cookie session", async () => {
  const store = createStore();
  const auth = createAdminAuth({
    store,
    getCredentials: () => ({ username: "team-admin", password: "a-long-test-secret" }),
    passwordHasher: async (password) => `hashed:${password}`,
    passwordVerifier: async (password, encoded) => encoded === `hashed:${password}`,
    isProduction: () => true,
    tokenFactory: () => "opaque-random-session-token",
  });
  const response = await invoke(auth.login, {
    body: { username: "TEAM-ADMIN", password: "a-long-test-secret" }, ip: "login-test",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.role, "admin");
  assert.equal(store.admins.size, 1);
  assert.equal([...store.admins.values()][0].passwordHash, "hashed:a-long-test-secret");
  assert.doesNotMatch(JSON.stringify(response.body), /opaque-random-session-token|a-long-test-secret/);
  assert.match(response.headers["set-cookie"], /HttpOnly/);
  assert.match(response.headers["set-cookie"], /SameSite=Strict/);
  assert.match(response.headers["set-cookie"], /Secure/);
  assert.equal(store.sessions.size, 1);
});

test("admin login rejects invalid credentials and rate-limits repeated attempts", async () => {
  const auth = createAdminAuth({
    store: createStore(),
    getCredentials: () => ({ username: "team-admin", password: "long-test-secret" }),
    maxLoginAttempts: 2,
  });
  const request = { body: { username: "team-admin", password: "wrong" }, ip: "bad-admin-ip" };
  assert.equal((await invoke(auth.login, request)).statusCode, 401);
  assert.equal((await invoke(auth.login, request)).statusCode, 401);
  const limited = await invoke(auth.login, request);
  assert.equal(limited.statusCode, 429);
  assert.match(limited.headers["retry-after"], /\d+/);
});

test("first-admin setup requires the configured token, creates once, and establishes login", async () => {
  const store = createStore();
  const auth = createAdminAuth({
    store,
    getSetupToken: () => "private-bootstrap-token-with-more-than-thirty-two-chars",
    passwordHasher: async (password) => `hashed:${password}`,
    passwordVerifier: async (password, encoded) => encoded === `hashed:${password}`,
    tokenFactory: () => "new-admin-session-token",
  });
  const denied = await invoke(auth.setup, { body: { name: "Admin", loginIdentifier: "owner@example.test", password: "long-bootstrap-password", setupToken: "wrong" } });
  assert.equal(denied.statusCode, 401);
  const setup = await invoke(auth.setup, { body: { name: "Admin Owner", loginIdentifier: " OWNER@example.test ", password: "long-bootstrap-password", setupToken: "private-bootstrap-token-with-more-than-thirty-two-chars" } });
  assert.equal(setup.statusCode, 201);
  assert.equal(setup.body.user.role, "admin");
  assert.equal([...store.admins.values()][0].loginIdentifier, "owner@example.test");
  assert.equal([...store.admins.values()][0].passwordHash, "hashed:long-bootstrap-password");
  const repeated = await invoke(auth.setup, { body: { name: "Other", loginIdentifier: "other@example.test", password: "long-bootstrap-password", setupToken: "private-bootstrap-token-with-more-than-thirty-two-chars" } });
  assert.equal(repeated.statusCode, 409);
});

test("admin sessions restore from persistent storage, reject other roles, and logout invalidates the session", async () => {
  const store = createStore();
  const session = { tokenHash: require("crypto").createHash("sha256").update("admin-token").digest("hex"), role: "admin", principalId: "admin-1", name: "Admin", expiresAt: new Date(Date.now() + 10000) };
  store.sessions.set(session.tokenHash, session);
  const auth = createAdminAuth({ store });
  const restored = await invoke(auth.requireAdmin, { headers: { cookie: "uc_admin_session=admin-token" } });
  assert.equal(restored.nextCalled, true);
  assert.equal(restored.body, null);

  const candidateHash = require("crypto").createHash("sha256").update("candidate-token").digest("hex");
  store.sessions.set(candidateHash, { ...session, tokenHash: candidateHash, role: "candidate" });
  const forbidden = await invoke(auth.requireAdmin, { headers: { cookie: "uc_admin_session=candidate-token" } });
  assert.equal(forbidden.statusCode, 403);

  const logout = await invoke(auth.logout, { headers: { cookie: "uc_admin_session=admin-token" } });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers["set-cookie"], /Max-Age=0/);
  const rejected = await invoke(auth.requireAdmin, { headers: { cookie: "uc_admin_session=admin-token" } });
  assert.equal(rejected.statusCode, 401);
});

test("internal reports require admin and interview routes require candidate sessions", async () => {
  const { router: adminRouter, adminAuth, candidateAuth: provisioningAuth } = require("../routes/adminRoutes");
  const { router: candidateRouter, candidateAuth } = require("../routes/candidateRoutes");
  const interviewRouter = require("../routes/interviewRoutes");
  const route = (router, path) => router.stack.find((layer) => layer.route?.path === path)?.route;

  for (const path of ["/sessions", "/:sessionId/report", "/:sessionId/report.pdf", "/manual-review", "/interpret"]) {
    assert.equal(route(interviewRouter, path).stack[0].handle, adminAuth.requireAdmin, `${path} should require admin first`);
  }
  assert.equal(route(adminRouter, "/me").stack[0].handle, adminAuth.requireAdmin);
  assert.equal(route(adminRouter, "/admins").stack[0].handle, adminAuth.requireAdmin);
  assert.equal(route(adminRouter, "/admins/:adminId").stack[0].handle, adminAuth.requireAdmin);
  assert.equal(route(adminRouter, "/candidates/:candidateId/deactivate").stack[0].handle, adminAuth.requireAdmin);
  assert.equal(route(adminRouter, "/candidates/:candidateId/activate").stack[0].handle, adminAuth.requireAdmin);
  assert.equal(route(adminRouter, "/candidates/:candidateId").stack[0].handle, adminAuth.requireAdmin);
  for (const path of ["/start", "/answer", "/end"]) {
    assert.equal(route(interviewRouter, path).stack[0].handle, candidateAuth.requireCandidate, `${path} should require candidate auth first`);
  }
  const candidateListRoute = route(adminRouter, "/candidates");
  assert.equal(candidateListRoute.stack[0].handle, adminAuth.requireAdmin);
  assert.equal(candidateListRoute.stack[1].handle, provisioningAuth.list);
  const candidateCreateRoute = adminRouter.stack.find((layer) => layer.route?.path === "/candidates" && layer.route.methods.post)?.route;
  assert.equal(candidateCreateRoute.stack[0].handle, adminAuth.requireAdmin);
  assert.equal(candidateCreateRoute.stack[1].handle, provisioningAuth.provision);
  assert.equal(route(adminRouter, "/stats").stack[0].handle, adminAuth.requireAdmin);
  assert.equal(route(adminRouter, "/candidates/:candidateId/interviews").stack[0].handle, adminAuth.requireAdmin);
  assert.equal(route(candidateRouter, "/interviews/:sessionId/report"), undefined, "candidate API must not expose full reports");
  assert.equal(route(candidateRouter, "/interviews").stack[0].handle, candidateAuth.requireCandidate, "candidate history must require candidate authentication");
  assert.equal((await invoke(adminAuth.requireAdmin, { headers: {} })).statusCode, 401);
});

test("admin deletion blocks self-deletion, invalid IDs, and deletion of the last active admin", async () => {
  const store = createStore();
  const selfId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  await store.createAdmin({ adminId: selfId, name: "Current", loginIdentifier: "current@example.test", active: true });
  const auth = createAdminAuth({ store });
  assert.equal((await invoke(auth.deleteAdmin, { params: { adminId: selfId }, admin: { adminId: selfId } })).statusCode, 409);
  assert.equal((await invoke(auth.deleteAdmin, { params: { adminId: "bad-id" }, admin: { adminId: selfId } })).statusCode, 400);
  assert.equal((await invoke(auth.deleteAdmin, { params: { adminId: selfId }, admin: { adminId: otherId } })).statusCode, 409);
  assert.equal(store.admins.has(selfId), true);
});

test("admin deletion removes another admin and invalidates every session for that admin", async () => {
  const store = createStore();
  const currentId = "11111111-1111-4111-8111-111111111111";
  const targetId = "22222222-2222-4222-8222-222222222222";
  await store.createAdmin({ adminId: currentId, name: "Current", loginIdentifier: "current@example.test", active: true });
  await store.createAdmin({ adminId: targetId, name: "Target", loginIdentifier: "target@example.test", active: true });
  store.sessions.set("target-session-a", { role: "admin", principalId: targetId });
  store.sessions.set("target-session-b", { role: "admin", principalId: targetId });
  store.sessions.set("current-session", { role: "admin", principalId: currentId });
  const auth = createAdminAuth({ store });
  const response = await invoke(auth.deleteAdmin, { params: { adminId: targetId }, admin: { adminId: currentId } });
  assert.equal(response.statusCode, 200);
  assert.equal(store.admins.has(targetId), false);
  assert.equal(store.sessions.has("target-session-a"), false);
  assert.equal(store.sessions.has("target-session-b"), false);
  assert.equal(store.sessions.has("current-session"), true);
  assert.equal((await invoke(auth.requireAdmin, { headers: { cookie: "uc_admin_session=target-session-a" } })).statusCode, 401);
});
