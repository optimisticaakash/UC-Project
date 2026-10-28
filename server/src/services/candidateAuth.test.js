const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createCandidateAuth, hashPassword, verifyPassword, validCandidateEmail } = require("./candidateAuth");

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(handler, req) {
  const res = response();
  await handler(req, res, () => { res.nextCalled = true; });
  return res;
}

function fakeStore() {
  const candidates = new Map();
  const sessions = new Map();
  const interviewHistory = new Map();
  return {
    candidates, sessions, interviewHistory, isConnected: () => true,
    async createCandidate(candidate) {
      if ([...candidates.values()].some((item) => item.loginIdentifier === candidate.loginIdentifier)) {
        const error = new Error("duplicate"); error.code = 11000; throw error;
      }
      const saved = { ...candidate, createdAt: new Date() };
      candidates.set(saved.candidateId, saved);
      return saved;
    },
    async listCandidates() { return [...candidates.values()].map(({ passwordHash, ...safe }) => safe); },
    async findCandidateById(candidateId) {
      const candidate = candidates.get(candidateId);
      if (!candidate) return null;
      const { passwordHash, ...safe } = candidate;
      return safe;
    },
    async deactivateCandidateAndSessions(candidateId) {
      const candidate = candidates.get(candidateId);
      if (!candidate?.active) return null;
      candidate.active = false;
      for (const [hash, session] of sessions) if (session.role === "candidate" && session.principalId === candidateId) sessions.delete(hash);
      const { passwordHash, ...safe } = candidate;
      return safe;
    },
    async activateCandidate(candidateId) {
      const candidate = candidates.get(candidateId);
      if (!candidate || candidate.active || candidate.deletedAt) return null;
      candidate.active = true;
      candidate.deletedAt = null;
      const { passwordHash, ...safe } = candidate;
      return safe;
    },
    async deleteCandidateAccountAndSessions(candidateId) {
      const candidate = candidates.get(candidateId);
      if (!candidate || candidate.deletedAt) return null;
      candidate.active = false;
      candidate.deletedAt = new Date();
      for (const [hash, session] of sessions) if (session.role === "candidate" && session.principalId === candidateId) sessions.delete(hash);
      const { passwordHash, ...safe } = candidate;
      return safe;
    },
    async findCandidateByLogin(identifier) { return [...candidates.values()].find((item) => item.loginIdentifier === identifier) || null; },
    async createAuthSession(session) { sessions.set(session.tokenHash, { ...session }); },
    async findAuthSession(hash, now = new Date()) {
      const item = sessions.get(hash);
      return item && new Date(item.expiresAt) > now ? { ...item } : null;
    },
    async deleteAuthSession(hash) { sessions.delete(hash); },
  };
}

test("candidate passwords use salted scrypt hashes and reject wrong passwords", async () => {
  const encoded = await hashPassword("candidate-private-password");
  assert.match(encoded, /^scrypt\$/);
  assert.notEqual(encoded, "candidate-private-password");
  assert.equal(await verifyPassword("candidate-private-password", encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
});

test("candidate provisioning reports invalid email/password fields and accepts the eight-character boundary", async () => {
  for (const email of ["candidate@example.test", "candidate+ops@example.test"]) {
    assert.equal(validCandidateEmail(email), true, email);
  }
  for (const email of ["candidate_01", "bad address@example.test", "missing-at.example", `${"a".repeat(148)}@example.test`]) {
    assert.equal(validCandidateEmail(email), false, email);
  }

  const store = fakeStore();
  const auth = createCandidateAuth({ store, passwordHasher: async (password) => `hashed:${password}` });
  const base = { name: "Candidate", loginIdentifier: "candidate@example.test", password: "valid-password" };
  const cases = [
    { input: { ...base, loginIdentifier: "invalid identifier" }, field: "email", message: "Enter a valid email address" },
    { input: { ...base, password: "1234567" }, field: "password", message: "Initial password must be at least 8 characters." },
    { input: { ...base, password: "p".repeat(1025) }, message: "Initial password must be 1,024 characters or fewer." },
  ];
  for (const item of cases) {
    const result = await invoke(auth.provision, { body: item.input });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.field, item.field || "password");
    assert.ok(result.body.message.includes(item.message));
  }

  const accepted = await invoke(auth.provision, { body: { ...base, password: "12345678", loginIdentifier: " CANDIDATE+OPS@EXAMPLE.TEST " } });
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.body.candidate.loginIdentifier, "candidate+ops@example.test");
  assert.equal([...store.candidates.values()][0].passwordHash, "hashed:12345678");
  const maximumPassword = await invoke(auth.provision, { body: { ...base, loginIdentifier: "maximum@example.test", password: "p".repeat(1024) } });
  assert.equal(maximumPassword.statusCode, 201);
});

test("admin provisioning normalizes identifiers, hashes credentials, and handles duplicates", async () => {
  const store = fakeStore();
  const auth = createCandidateAuth({ store, passwordHasher: async (password) => `hashed:${password}` });
  const req = { body: { name: "  Candidate One ", loginIdentifier: " CANDIDATE@example.test ", password: "initial-8" } };
  const created = await invoke(auth.provision, req);
  assert.equal(created.statusCode, 201);
  assert.match(created.body.candidate.candidateId, /^[0-9a-f-]{36}$/u);
  assert.equal(created.body.candidate.loginIdentifier, "candidate@example.test");
  assert.equal([...store.candidates.values()][0].candidateId, created.body.candidate.candidateId);
  assert.equal(created.body.candidate.name, "Candidate One");
  assert.equal([...store.candidates.values()][0].passwordHash, "hashed:initial-8");
  assert.doesNotMatch(JSON.stringify(created.body), /passwordHash|initial-8/);
  const duplicate = await invoke(auth.provision, { body: { ...req.body, loginIdentifier: "candidate@example.test" } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.field, "email");
});

test("candidate login restores through a persistent hashed-token session and logout invalidates it", async () => {
  const store = fakeStore();
  const create = createCandidateAuth({
    store,
    passwordHasher: async (password) => `hashed:${password}`,
    passwordVerifier: async (password, hash) => hash === `hashed:${password}`,
    tokenFactory: () => "opaque-candidate-session",
    isProduction: () => true,
  });
  await invoke(create.provision, { body: { name: "Candidate One", loginIdentifier: "candidate@example.test", password: "eight888" } });
  const login = await invoke(create.login, { body: { loginIdentifier: " CANDIDATE@example.test ", password: "eight888" }, ip: "candidate-test" });
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.user.role, "candidate");
  assert.match(login.headers["set-cookie"], /HttpOnly/);
  assert.match(login.headers["set-cookie"], /SameSite=(?:Strict|None)/);
  assert.match(login.headers["set-cookie"], /Secure/);
  const storedHash = crypto.createHash("sha256").update("opaque-candidate-session").digest("hex");
  assert.equal(store.sessions.has(storedHash), true);
  assert.doesNotMatch([...store.sessions.keys()][0], /opaque-candidate-session/);

  const restoredAuth = createCandidateAuth({ store });
  const meRequest = { headers: { cookie: "uc_candidate_session=opaque-candidate-session" }, params: { candidateId: "some-other-candidate" } };
  const me = await invoke(restoredAuth.requireCandidate, meRequest);
  assert.equal(me.nextCalled, true);
  assert.equal(meRequest.candidate.candidateId, login.body.user.candidateId);
  assert.equal(meRequest.candidate.loginIdentifier, "candidate@example.test");
  const profile = await invoke(restoredAuth.me, meRequest);
  assert.deepEqual(profile.body.user, {
    role: "candidate",
    candidateId: login.body.user.candidateId,
    name: "Candidate One",
    loginIdentifier: "candidate@example.test",
  });
  assert.doesNotMatch(JSON.stringify(profile.body), /passwordHash|scrypt|opaque-candidate-session/u);
  assert.equal(login.body.user.candidateId, [...store.candidates.values()][0].candidateId, "candidate ID remains stable across a new auth handler instance");

  const logout = await invoke(restoredAuth.logout, { headers: { cookie: "uc_candidate_session=opaque-candidate-session" } });
  assert.equal(logout.statusCode, 200);
  const rejected = await invoke(restoredAuth.requireCandidate, { headers: { cookie: "uc_candidate_session=opaque-candidate-session" } });
  assert.equal(rejected.statusCode, 401);
});

test("candidate login keeps credentials errors indistinguishable and preserves legacy username accounts", async () => {
  const store = fakeStore();
  store.candidates.set("legacy-candidate", {
    candidateId: "legacy-candidate",
    name: "Existing Candidate",
    loginIdentifier: "legacy_user",
    passwordHash: "hashed:legacy-password",
    active: true,
  });
  const auth = createCandidateAuth({
    store,
    passwordVerifier: async (password, hash) => hash === `hashed:${password}`,
    tokenFactory: () => "legacy-session",
  });
  const legacyLogin = await invoke(auth.login, { body: { loginIdentifier: " LEGACY_USER ", password: "legacy-password" }, ip: "legacy-test" });
  assert.equal(legacyLogin.statusCode, 200);
  assert.equal(legacyLogin.body.user.candidateId, "legacy-candidate");

  const wrongPassword = await invoke(auth.login, { body: { loginIdentifier: "legacy_user", password: "incorrect" }, ip: "wrong-password-test" });
  const unknownEmail = await invoke(auth.login, { body: { loginIdentifier: "unknown@example.test", password: "incorrect" }, ip: "unknown-email-test" });
  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(unknownEmail.statusCode, 401);
  assert.equal(wrongPassword.body.message, unknownEmail.body.message);
});

test("candidate session middleware rejects admin sessions and expired sessions", async () => {
  const store = fakeStore();
  const auth = createCandidateAuth({ store });
  const adminHash = crypto.createHash("sha256").update("admin-session").digest("hex");
  const expiredHash = crypto.createHash("sha256").update("expired-session").digest("hex");
  store.sessions.set(adminHash, { tokenHash: adminHash, role: "admin", principalId: "admin-1", name: "Admin", expiresAt: new Date(Date.now() + 10000) });
  store.sessions.set(expiredHash, { tokenHash: expiredHash, role: "candidate", principalId: "candidate-1", name: "Candidate", expiresAt: new Date(Date.now() - 10000) });
  assert.equal((await invoke(auth.requireCandidate, { headers: { cookie: "uc_candidate_session=admin-session" } })).statusCode, 403);
  assert.equal((await invoke(auth.requireCandidate, { headers: { cookie: "uc_candidate_session=expired-session" } })).statusCode, 401);
  assert.equal((await invoke(auth.requireCandidate, { headers: {} })).statusCode, 401, "unauthenticated candidate history requests are rejected");
});

test("candidate history is owner-scoped and returns status summaries without report data", async () => {
  const { persistence } = require("./persistence");
  const interviewService = require("./interview");
  const { router } = require("../routes/candidateRoutes");
  const controller = require("../controllers/interviewController");
  const originalConnected = persistence.isConnected;
  const originalList = persistence.listSessionsByCandidate;
  const candidateOne = interviewService.startInterview({ candidateId: "candidate-1" });
  const candidateTwo = interviewService.startInterview({ candidateId: "candidate-2" });
  const storedSessions = [
    interviewService.getSessionForPersistence(candidateOne.sessionId),
    interviewService.getSessionForPersistence(candidateTwo.sessionId),
  ];
  persistence.isConnected = () => true;
  persistence.listSessionsByCandidate = async (candidateId) => storedSessions.filter((session) => session.candidateId === candidateId);
  try {
    const history = await invoke(controller.listCandidateInterviewsForCurrentUser, {
      candidate: { candidateId: "candidate-1", name: "Candidate" },
    });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.body.interviews.map(({ sessionId }) => sessionId), [candidateOne.sessionId]);
    assert.deepEqual(Object.keys(history.body.interviews[0]).sort(), [
      "answeredQuestions", "endedAt", "sessionId", "startedAt", "status", "totalQuestions",
    ]);
    assert.equal("answers" in history.body.interviews[0], false);
    assert.equal("manualReviewRequired" in history.body.interviews[0], false);
    assert.equal("manualChecks" in history.body.interviews[0], false);
    const otherCandidateHistory = await invoke(controller.listCandidateInterviewsForCurrentUser, {
      candidate: { candidateId: "candidate-2", name: "Other Candidate" },
    });
    assert.deepEqual(otherCandidateHistory.body.interviews.map(({ sessionId }) => sessionId), [candidateTwo.sessionId]);
    assert.equal(router.stack.some((layer) => layer.route?.path === "/interviews/:sessionId/report"), false);
  } finally {
    interviewService.restoreSessionSnapshot(candidateOne.sessionId, null);
    interviewService.restoreSessionSnapshot(candidateTwo.sessionId, null);
    persistence.isConnected = originalConnected;
    persistence.listSessionsByCandidate = originalList;
  }
});

test("admin deactivation invalidates candidate sessions while preserving interview and report records", async () => {
  const store = fakeStore();
  const candidateId = "33333333-3333-4333-8333-333333333333";
  const sessionHash = crypto.createHash("sha256").update("candidate-session").digest("hex");
  store.candidates.set(candidateId, { candidateId, name: "Candidate", loginIdentifier: "candidate@example.test", passwordHash: "not-returned", active: true });
  store.sessions.set(sessionHash, { tokenHash: sessionHash, role: "candidate", principalId: candidateId, name: "Candidate", expiresAt: new Date(Date.now() + 60000) });
  const persistedInterview = { sessionId: "interview-kept", candidateId, reportPdfRef: { fileId: "pdf-kept" }, answers: [{ answer: "persisted answer" }] };
  store.interviewHistory.set(persistedInterview.sessionId, persistedInterview);
  const auth = createCandidateAuth({ store });
  const response = await invoke(auth.deactivate, { params: { candidateId } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.candidate.active, false);
  assert.doesNotMatch(JSON.stringify(response.body), /passwordHash|not-returned/);
  assert.equal(store.sessions.has(sessionHash), false);
  assert.deepEqual(store.interviewHistory.get("interview-kept"), persistedInterview);
  assert.equal((await invoke(auth.requireCandidate, { headers: { cookie: "uc_candidate_session=candidate-session" } })).statusCode, 401);
  assert.equal((await invoke(auth.login, { body: { loginIdentifier: "candidate@example.test", password: "any-password" }, ip: "deactivated-login" })).statusCode, 401);
});

test("admin can reactivate a candidate and the candidate can sign in again with existing credentials", async () => {
  const store = fakeStore();
  const candidateId = "44444444-4444-4444-8444-444444444444";
  store.candidates.set(candidateId, { candidateId, name: "Candidate", loginIdentifier: "candidate@example.test", passwordHash: "hashed:password-8", active: false });
  const auth = createCandidateAuth({ store, passwordVerifier: async (password, hash) => hash === `hashed:${password}`, tokenFactory: () => "reactivated-session" });
  const activated = await invoke(auth.activate, { params: { candidateId } });
  assert.equal(activated.statusCode, 200);
  assert.equal(store.candidates.get(candidateId).active, true);
  assert.equal(activated.body.candidate.deletedAt, null);
  const login = await invoke(auth.login, { body: { loginIdentifier: "candidate@example.test", password: "password-8" }, ip: "reactivated-candidate" });
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.user.candidateId, candidateId);
});

test("candidate account deletion is a recoverable sign-in tombstone and retains linked interview records", async () => {
  const store = fakeStore();
  const candidateId = "55555555-5555-4555-8555-555555555555";
  const tokenHash = crypto.createHash("sha256").update("old-candidate-session").digest("hex");
  store.candidates.set(candidateId, { candidateId, name: "Candidate", loginIdentifier: "candidate@example.test", passwordHash: "private-hash", active: true });
  store.sessions.set(tokenHash, { tokenHash, role: "candidate", principalId: candidateId, expiresAt: new Date(Date.now() + 60000) });
  const interview = { sessionId: "retained-interview", candidateId, reportPdfRef: { fileId: "retained-pdf" }, answers: [{ answer: "retained" }] };
  store.interviewHistory.set(interview.sessionId, interview);
  const auth = createCandidateAuth({ store });
  const removed = await invoke(auth.deleteAccount, { params: { candidateId } });
  assert.equal(removed.statusCode, 200);
  assert.ok(removed.body.candidate.deletedAt);
  assert.equal(store.candidates.get(candidateId).active, false);
  assert.equal(store.sessions.has(tokenHash), false);
  assert.deepEqual(store.interviewHistory.get(interview.sessionId), interview);
  assert.doesNotMatch(JSON.stringify(removed.body), /private-hash|passwordHash/u);
  assert.equal((await invoke(auth.activate, { params: { candidateId } })).statusCode, 404);
  assert.equal((await invoke(auth.login, { body: { loginIdentifier: "candidate@example.test", password: "valid-password" }, ip: "deleted-candidate-login" })).statusCode, 401);
  assert.equal((await invoke(auth.deleteAccount, { params: { candidateId } })).statusCode, 404);
});
