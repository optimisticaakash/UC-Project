const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdminAuth } = require("./adminAuth");

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

function invoke(handler, req) {
  const res = makeResponse();
  handler(req, res, () => { res.nextCalled = true; });
  return res;
}

test("admin login requires configured credentials and rejects wrong credentials", () => {
  const unconfigured = createAdminAuth({ getCredentials: () => ({}) });
  assert.equal(invoke(unconfigured.login, { body: {} }).statusCode, 503);

  const auth = createAdminAuth({
    getCredentials: () => ({ username: "team-admin", password: "a-long-test-secret" }),
  });
  const rejected = invoke(auth.login, { body: { username: "team-admin", password: "wrong" } });
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.body.success, false);
});

test("admin sign-in rate-limits repeated invalid credentials", () => {
  const auth = createAdminAuth({
    getCredentials: () => ({ username: "team-admin", password: "long-test-secret" }),
    maxLoginAttempts: 2,
  });
  const request = { body: { username: "team-admin", password: "wrong" }, ip: "test-admin-ip" };
  assert.equal(invoke(auth.login, request).statusCode, 401);
  assert.equal(invoke(auth.login, request).statusCode, 401);
  const limited = invoke(auth.login, request);
  assert.equal(limited.statusCode, 429);
  assert.match(limited.headers["retry-after"], /\d+/);
});

test("successful login sets a protected expiring cookie without returning its token", () => {
  const auth = createAdminAuth({
    getCredentials: () => ({ username: "team-admin", password: "a-long-test-secret" }),
    isProduction: () => true,
    tokenFactory: () => "opaque-random-session-token",
  });
  const response = invoke(auth.login, {
    body: { username: "team-admin", password: "a-long-test-secret" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true, user: { role: "admin" } });
  assert.doesNotMatch(JSON.stringify(response.body), /opaque-random-session-token/);
  assert.match(response.headers["set-cookie"], /HttpOnly/);
  assert.match(response.headers["set-cookie"], /SameSite=Strict/);
  assert.match(response.headers["set-cookie"], /Secure/);
  assert.match(response.headers["set-cookie"], /Max-Age=/);
});

test("admin middleware returns 401 unauthenticated and 403 for a non-admin role", () => {
  const sessions = new Map([["candidate-token", { role: "candidate", expiresAt: Date.now() + 10000 }]]);
  const auth = createAdminAuth({ sessions });
  const missing = invoke(auth.requireAdmin, { headers: {} });
  assert.equal(missing.statusCode, 401);

  const forbidden = invoke(auth.requireAdmin, {
    headers: { cookie: "uc_admin_session=candidate-token" },
  });
  assert.equal(forbidden.statusCode, 403);
});

test("logout invalidates the session and expires its cookie", () => {
  const sessions = new Map([["admin-token", { role: "admin", expiresAt: Date.now() + 10000 }]]);
  const auth = createAdminAuth({ sessions });
  const response = invoke(auth.logout, {
    headers: { cookie: "other=value; uc_admin_session=admin-token" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(sessions.has("admin-token"), false);
  assert.match(response.headers["set-cookie"], /Max-Age=0/);
  assert.equal(
    invoke(auth.requireAdmin, { headers: { cookie: "uc_admin_session=admin-token" } }).statusCode,
    401,
  );
});

test("internal reports require admin while the candidate interview uses the original direct flow", () => {
  const { router: adminRouter, adminAuth } = require("../routes/adminRoutes");
  const interviewRouter = require("../routes/interviewRoutes");
  const adminRoute = (router, path) =>
    router.stack.find((layer) => layer.route?.path === path)?.route;

  for (const path of ["/sessions", "/:sessionId/report", "/manual-review", "/interpret"]) {
    const route = adminRoute(interviewRouter, path);
    assert.ok(route, `route ${path} should exist`);
    assert.equal(route.stack[0].handle, adminAuth.requireAdmin, `${path} should require admin first`);
  }
  assert.equal(adminRoute(adminRouter, "/me").stack[0].handle, adminAuth.requireAdmin);
  for (const path of ["/start", "/answer", "/end"]) {
    const route = adminRoute(interviewRouter, path);
    assert.ok(route, `route ${path} should exist`);
    assert.equal(route.stack.length, 1, `${path} should use the original direct interview route`);
  }
  for (const path of ["/me"]) {
    assert.equal(adminRoute(adminRouter, path).stack[0].handle, adminAuth.requireAdmin, `${path} should be admin-only`);
  }
  assert.equal(adminRouter.stack.some((layer) => layer.route?.path === "/candidates"), false);
  assert.equal(interviewRouter.stack.some((layer) => layer.route?.path === "/sessions"), true);

  const unauthorized = invoke(adminAuth.requireAdmin, { headers: {} });
  assert.equal(unauthorized.statusCode, 401);
});
