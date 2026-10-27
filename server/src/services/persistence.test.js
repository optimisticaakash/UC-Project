const test = require("node:test");
const assert = require("node:assert/strict");
const { createPersistence } = require("./persistence");
const { generateInterviewReportPdf, getReportPdfHash } = require("./reportPdf");
const { persistence } = require("./persistence");
const interviewController = require("../controllers/interviewController");
const interviewService = require("./interview");
const { Readable, PassThrough } = require("node:stream");
const mongoose = require("mongoose");

function makeSessionModel(records = []) {
  const calls = { init: 0, replacements: [] };
  return {
    calls,
    async init() { calls.init += 1; },
    find() {
      return { lean: async () => records.map((state) => ({ state })) };
    },
    async replaceOne(filter, replacement, options) {
      calls.replacements.push({ filter, replacement, options });
    },
  };
}

function makeInitModel() {
  return { async init() {} };
}

test("Mongo persistence loads and saves the existing interview state shape", async () => {
  const priorState = {
    sessionId: "session-existing",
    status: "in_progress",
    startedAt: "2026-01-02T03:04:05.000Z",
    currentQuestionIndex: 2,
    answers: [{ questionId: "A0", answer: "yes", outcome: "agreed" }],
    manualReviewRequired: true,
  };
  const model = makeSessionModel([priorState]);
  const connection = { readyState: 1 };
  const candidateModel = makeInitModel();
  const persistence = createPersistence({
    sessionModel: model,
    candidateModel,
    adminModel: makeInitModel(),
    authSessionModel: makeInitModel(),
    adminBootstrapModel: makeInitModel(),
    connection,
    connectImpl: async () => {},
  });

  await persistence.connect("mongodb://test.invalid/urban_company_ai");
  assert.equal(model.calls.init, 1);
  assert.deepEqual(await persistence.loadSessions(), [priorState]);

  await persistence.saveSession(priorState);
  assert.deepEqual(model.calls.replacements[0].filter, { sessionId: "session-existing" });
  assert.equal(model.calls.replacements[0].replacement.state, priorState);
  assert.equal(model.calls.replacements[0].options.upsert, true);
});

test("candidate ID backfill assigns stable collision-resistant IDs before unique indexes initialize", async () => {
  const records = [
    { _id: "legacy-one", loginIdentifier: "one@example.test" },
    { _id: "legacy-two", candidateId: null, loginIdentifier: "two@example.test" },
    { _id: "existing", candidateId: "candidate-stable", loginIdentifier: "three@example.test" },
  ];
  const candidateModel = {
    async init() {},
    find() {
      return { lean: async () => records.filter((record) => !record.candidateId).map(({ _id }) => ({ _id })) };
    },
    async updateOne(filter, update) {
      const record = records.find((item) => item._id === filter._id);
      if (!record || record.candidateId) return { matchedCount: 0, modifiedCount: 0 };
      record.candidateId = update.$set.candidateId;
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const storeOptions = {
    sessionModel: makeSessionModel(), candidateModel,
    adminModel: makeInitModel(), authSessionModel: makeInitModel(), adminBootstrapModel: makeInitModel(),
    connection: { readyState: 1 }, connectImpl: async () => {},
  };
  await createPersistence(storeOptions).connect("mongodb://test.invalid/urban_company_ai");
  const assigned = records.slice(0, 2).map((record) => record.candidateId);
  assert.ok(assigned.every((id) => /^[0-9a-f-]{36}$/u.test(id)));
  assert.notEqual(assigned[0], assigned[1]);
  await createPersistence(storeOptions).connect("mongodb://test.invalid/urban_company_ai");
  assert.deepEqual(records.slice(0, 2).map((record) => record.candidateId), assigned);
  assert.equal(records[2].candidateId, "candidate-stable");
});

test("Mongo report PDF storage reuses a matching GridFS file and refreshes changed reports", async () => {
  const record = { state: { sessionId: "pdf-session" } };
  const files = new Map();
  const calls = { uploads: 0, deletes: 0, updates: 0 };
  const sessionModel = {
    async init() {},
    findOne() { return { lean: async () => ({ state: structuredClone(record.state) }) }; },
    async updateOne(_filter, update) {
      calls.updates += 1;
      record.state.reportPdfRef = update.$set["state.reportPdfRef"];
    },
  };
  const bucket = {
    openUploadStream(filename) {
      calls.uploads += 1;
      const stream = new PassThrough();
      stream.id = new mongoose.Types.ObjectId();
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("finish", () => files.set(stream.id.toString(), Buffer.concat(chunks)));
      return stream;
    },
    openDownloadStream(id) { return Readable.from(files.get(id.toString())); },
    async delete() { calls.deletes += 1; },
  };
  const connection = { readyState: 1, db: {} };
  const store = createPersistence({
    sessionModel,
    candidateModel: makeInitModel(), adminModel: makeInitModel(),
    authSessionModel: makeInitModel(), adminBootstrapModel: makeInitModel(),
    connection,
    gridFsBucketFactory: () => bucket,
    connectImpl: async () => {},
  });
  await store.connect("mongodb://test.invalid/urban_company_ai");
  let generated = 0;
  const request = { sessionId: "pdf-session", reportHash: "hash-1", filename: "report.pdf", generatePdf: async () => { generated += 1; return Buffer.from("%PDF-one"); } };
  const first = await store.getOrCreateReportPdf(request);
  const cached = await store.getOrCreateReportPdf(request);
  assert.equal(first.buffer.toString(), "%PDF-one");
  assert.equal(cached.buffer.toString(), "%PDF-one");
  assert.equal(generated, 1);
  assert.equal(calls.uploads, 1);

  const restartedStore = createPersistence({
    sessionModel,
    candidateModel: makeInitModel(), adminModel: makeInitModel(),
    authSessionModel: makeInitModel(), adminBootstrapModel: makeInitModel(),
    connection,
    gridFsBucketFactory: () => bucket,
    connectImpl: async () => {},
  });
  await restartedStore.connect("mongodb://test.invalid/urban_company_ai");
  const afterRestart = await restartedStore.getOrCreateReportPdf({
    ...request,
    generatePdf: async () => { throw new Error("cached PDF should survive a service restart"); },
  });
  assert.equal(afterRestart.buffer.toString(), "%PDF-one");

  const persistedReport = {
    sessionId: "pdf-session",
    candidateName: "दिन",
    status: "completed",
    answers: [{ questionId: "A3", questionText: "हां मैं सहमत हूं।", answer: "हाँ, मैं दिल्ली में रहती हूं। I work in Delhi." }],
  };
  const changed = await store.getOrCreateReportPdf({
    ...request,
    reportHash: getReportPdfHash(persistedReport),
    generatePdf: () => generateInterviewReportPdf(persistedReport),
  });
  assert.equal(changed.buffer.subarray(0, 5).toString(), "%PDF-");
  assert.match(changed.buffer.toString("latin1"), /FontFile2/);
  assert.equal(calls.uploads, 2);
  assert.equal(calls.deletes, 1);
  assert.equal(record.state.reportPdfRef.reportHash, getReportPdfHash(persistedReport));
  const regeneratedAfterRestart = await restartedStore.getOrCreateReportPdf({
    ...request,
    reportHash: getReportPdfHash(persistedReport),
    generatePdf: async () => assert.fail("regenerated PDF should be persisted and reused after restart"),
  });
  assert.deepEqual(regeneratedAfterRestart.buffer, changed.buffer);
  assert.equal(calls.uploads, 2, "regeneration replaces the stale file instead of adding duplicates");
});

test("Mongo report PDF storage propagates GridFS upload failures without recording a false PDF reference", async () => {
  const record = { state: { sessionId: "pdf-upload-failure" } };
  let updated = false;
  const sessionModel = {
    async init() {},
    findOne() { return { lean: async () => structuredClone(record) }; },
    async updateOne() { updated = true; },
  };
  const bucket = {
    openUploadStream() {
      const upload = new PassThrough();
      upload.id = new mongoose.Types.ObjectId();
      upload.end = () => {
        process.nextTick(() => upload.emit("error", new Error("simulated GridFS upload failure")));
        return upload;
      };
      return upload;
    },
  };
  const store = createPersistence({
    sessionModel,
    candidateModel: makeInitModel(), adminModel: makeInitModel(),
    authSessionModel: makeInitModel(), adminBootstrapModel: makeInitModel(),
    connection: { readyState: 1, db: {} },
    gridFsBucketFactory: () => bucket,
    connectImpl: async () => {},
  });
  await store.connect("mongodb://test.invalid/urban_company_ai");
  await assert.rejects(store.getOrCreateReportPdf({
    sessionId: "pdf-upload-failure",
    reportHash: "new-report-hash",
    filename: "interview-report.pdf",
    generatePdf: async () => Buffer.from("%PDF-real"),
  }), /simulated GridFS upload failure/);
  assert.equal(updated, false);
  assert.equal(record.state.reportPdfRef, undefined);
});

test("Mongo persistence requires a configured URI and never falls back to memory", async () => {
  const model = makeSessionModel();
  const persistence = createPersistence({
    sessionModel: model,
    connection: { readyState: 0 },
    connectImpl: async () => assert.fail("connect must not run without a URI"),
  });

  await assert.rejects(persistence.connect(""), { code: "MONGODB_URI_REQUIRED" });
  await assert.rejects(persistence.loadSessions(), /not connected/);
  await assert.rejects(persistence.saveSession({ sessionId: "s" }), /not connected/);
});

test("Mongo persistence stores admin accounts and hashed-token auth sessions", async () => {
  const admins = new Map();
  const authSessions = new Map();
  let bootstrapClaimed = false;
  const adminModel = {
    async init() {},
    async create(admin) { admins.set(admin.loginIdentifier, admin); return admin; },
    findOne({ loginIdentifier }) { return { select: () => ({ lean: async () => admins.get(loginIdentifier) || null }) }; },
    async countDocuments() { return admins.size; },
  };
  const authSessionModel = {
    async init() {},
    async create(session) { authSessions.set(session.tokenHash, session); },
    findOne({ tokenHash, expiresAt }) {
      return { lean: async () => {
        const session = authSessions.get(tokenHash);
        return session && session.expiresAt > expiresAt.$gt ? session : null;
      } };
    },
    async deleteOne({ tokenHash }) { authSessions.delete(tokenHash); },
  };
  const adminBootstrapModel = {
    async init() {},
    async findOneAndUpdate() {
      if (bootstrapClaimed) throw Object.assign(new Error("duplicate"), { code: 11000 });
      bootstrapClaimed = true;
      return { _id: "first-admin" };
    },
    async deleteOne() { bootstrapClaimed = false; },
  };
  const connection = { readyState: 1 };
  const store = createPersistence({
    sessionModel: makeInitModel(), candidateModel: makeInitModel(), adminModel,
    authSessionModel, adminBootstrapModel, connection, connectImpl: async () => {},
  });

  const admin = { adminId: "admin-1", name: "Admin", loginIdentifier: "owner@example.test", passwordHash: "scrypt-hash", role: "admin", active: true };
  await store.createAdmin(admin);
  assert.equal((await store.findAdminByLogin(admin.loginIdentifier)).passwordHash, "scrypt-hash");
  assert.equal(await store.countAdmins(), 1);
  assert.equal(await store.claimFirstAdminSetup(), true);
  assert.equal(await store.claimFirstAdminSetup(), false);

  const session = { tokenHash: "hashed-opaque-token", role: "admin", principalId: "admin-1", name: "Admin", expiresAt: new Date(Date.now() + 10000) };
  await store.createAuthSession(session);
  assert.equal((await store.findAuthSession(session.tokenHash)).principalId, "admin-1");
  await store.deleteAuthSession(session.tokenHash);
  assert.equal(await store.findAuthSession(session.tokenHash), null);
});

test("Mongo account cleanup uses transactions to revoke sessions without touching interview records", async () => {
  const admins = new Map([
    ["admin-one", { adminId: "admin-one", active: true, name: "One" }],
    ["admin-two", { adminId: "admin-two", active: true, name: "Two" }],
  ]);
  const candidates = new Map([[
    "candidate-one", { candidateId: "candidate-one", active: true, name: "Candidate", loginIdentifier: "candidate@example.test" },
  ]]);
  const sessions = new Map([
    ["admin-token", { role: "admin", principalId: "admin-two" }],
    ["candidate-token", { role: "candidate", principalId: "candidate-one" }],
  ]);
  const interviewRecords = [{ candidateId: "candidate-one", state: { sessionId: "kept", reportPdfRef: { fileId: "kept-pdf" } } }];
  const candidateCalls = { activationFilter: null };
  const transactionSession = { async withTransaction(callback) { await callback(); }, async endSession() {} };
  const query = (value) => ({ session() { return this; }, async lean() { return value; } });
  const adminModel = {
    findOne({ adminId }) { return query(admins.get(adminId)); },
    countDocuments() { return { session() { return this; }, then(resolve, reject) { return Promise.resolve([...admins.values()].filter((item) => item.active).length).then(resolve, reject); } }; },
    async deleteOne({ adminId }) { admins.delete(adminId); },
    find() { return { sort() { return this; }, lean: async () => [...admins.values()] }; },
  };
  const candidateModel = {
    findOneAndUpdate(filter, update) {
      const { candidateId } = filter;
      if (update.$set?.active === true) candidateCalls.activationFilter = filter;
      return { ...query(candidates.get(candidateId)), lean: async () => {
        const item = candidates.get(candidateId);
        if (!item) return null;
        if (update.$set?.active === false && update.$set.deletedAt) {
          if (item.deletedAt) return null;
          item.active = false;
          item.deletedAt = update.$set.deletedAt;
        } else if (update.$set?.active === false) {
          if (!item.active) return null;
          item.active = false;
        } else if (update.$set?.active === true) {
          if (item.active || item.deletedAt) return null;
          item.active = true;
          item.deletedAt = null;
        }
        return item;
      } };
    },
  };
  const authSessionModel = {
    async deleteMany({ role, principalId }) { for (const [key, value] of sessions) if (value.role === role && value.principalId === principalId) sessions.delete(key); },
  };
  const adminBootstrapModel = { async updateOne() {} };
  const connection = { readyState: 1, startSession: async () => transactionSession };
  const store = createPersistence({
    sessionModel: { ...makeInitModel(), find: () => ({ lean: async () => interviewRecords }) },
    candidateModel, adminModel, authSessionModel, adminBootstrapModel, connection,
  });
  assert.equal(await store.deleteAdminAndSessions("admin-two"), "deleted");
  assert.equal(admins.has("admin-two"), false);
  assert.equal(sessions.has("admin-token"), false);
  assert.equal(await store.deactivateCandidateAndSessions("candidate-one").then((candidate) => candidate.active), false);
  assert.equal(sessions.has("candidate-token"), false);
  assert.equal((await store.activateCandidate("candidate-one")).active, true);
  assert.equal(candidates.get("candidate-one").deletedAt, null);
  assert.equal((await store.deactivateCandidateAndSessions("candidate-one")).active, false);
  sessions.set("candidate-token-2", { role: "candidate", principalId: "candidate-one" });
  const removed = await store.deleteCandidateAccountAndSessions("candidate-one");
  assert.equal(removed.active, false);
  assert.ok(removed.deletedAt instanceof Date);
  assert.equal(candidates.has("candidate-one"), true, "candidate record remains as a stable historical identity");
  assert.equal(sessions.has("candidate-token-2"), false);
  assert.equal(await store.activateCandidate("candidate-one"), null);
  assert.equal(candidateCalls.activationFilter.deletedAt, null, "the persisted activation query excludes soft-deleted candidates");
  assert.deepEqual(interviewRecords[0].state.reportPdfRef, { fileId: "kept-pdf" });
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

function pdfResponseRecorder() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end(body) { this.body = body; return this; },
  };
}

test("admin PDF download regenerates a missing file and returns PDF bytes with safe headers", async () => {
  const original = {
    isConnected: persistence.isConnected,
    findSessionById: persistence.findSessionById,
    getOrCreateReportPdf: persistence.getOrCreateReportPdf,
    saveSession: persistence.saveSession,
  };
  const started = interviewService.startInterview();
  const sessionId = started.sessionId;
  let generateCalls = 0;
  persistence.isConnected = () => true;
  persistence.findSessionById = async () => interviewService.getSessionForPersistence(sessionId);
  persistence.saveSession = async () => {};
  persistence.getOrCreateReportPdf = async ({ generatePdf, filename }) => {
    generateCalls += 1;
    return { buffer: await generatePdf(), fileId: "test-gridfs-file", filename };
  };

  try {
    const response = pdfResponseRecorder();
    await interviewController.downloadReportPdf({ params: { sessionId } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/pdf");
    assert.equal(response.headers["content-disposition"], `attachment; filename="interview-report-${sessionId}.pdf"`);
    assert.equal(response.headers["content-length"], String(response.body.length));
    assert.equal(response.body.subarray(0, 5).toString(), "%PDF-");
    assert.equal(generateCalls, 1);
  } finally {
    interviewService.restoreSessionSnapshot(sessionId, null);
    Object.assign(persistence, original);
  }
});

test("admin PDF download returns a visible safe error and logs diagnostic context for GridFS failure", async () => {
  const original = {
    isConnected: persistence.isConnected,
    findSessionById: persistence.findSessionById,
    getOrCreateReportPdf: persistence.getOrCreateReportPdf,
    saveSession: persistence.saveSession,
  };
  const started = interviewService.startInterview();
  const sessionId = started.sessionId;
  const session = interviewService.getSessionForPersistence(sessionId);
  session.answers.push({ questionId: "A3", questionText: "A persisted question", answer: "private-answer-marker" });
  persistence.isConnected = () => true;
  persistence.findSessionById = async () => session;
  persistence.saveSession = async () => {};
  persistence.getOrCreateReportPdf = async () => { throw new Error("GridFS failed for private-answer-marker"); };
  const originalConsoleError = console.error;
  let logArgs;
  console.error = (...args) => { logArgs = args; };

  try {
    const response = pdfResponseRecorder();
    await interviewController.downloadReportPdf({ params: { sessionId } }, response);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { success: false, message: "Unable to generate the interview PDF." });
    assert.equal(response.headers["content-type"], undefined, "failed generation must not return PDF headers");
    assert.equal(logArgs[0], "Report PDF unavailable:");
    assert.equal(logArgs[1].errorName, "Error");
    assert.ok(logArgs[1].message.includes("GridFS failed"));
    assert.ok(Array.isArray(logArgs[1].stackFrames));
    assert.doesNotMatch(JSON.stringify(logArgs), /private-answer-marker/);
  } finally {
    console.error = originalConsoleError;
    interviewService.restoreSessionSnapshot(sessionId, null);
    Object.assign(persistence, original);
  }
});

test("interview start, answer, and end are written before successful responses", async () => {
  const originalConnected = persistence.isConnected;
  const originalSave = persistence.saveSession;
  const originalFindSession = persistence.findSessionById;
  const originalGetOrCreatePdf = persistence.getOrCreateReportPdf;
  const writes = [];
  persistence.isConnected = () => true;
  persistence.saveSession = async (session) => writes.push(structuredClone(session));
  persistence.findSessionById = async (id) => interviewService.getSessionForPersistence(id);
  persistence.getOrCreateReportPdf = async ({ generatePdf, filename, reportHash }) => ({
    buffer: await generatePdf(), fileId: "pdf-test-file", filename, reportHash,
  });
  let sessionId;

  try {
    const startResponse = responseRecorder();
    await interviewController.startInterview({}, startResponse);
    assert.equal(startResponse.statusCode, 200);
    sessionId = startResponse.body.sessionId;
    assert.equal(writes.at(-1).sessionId, sessionId);

    const answerResponse = responseRecorder();
    await interviewController.submitAnswer(
      { body: { sessionId, expectedQuestionId: "A2_NAME", answer: "Sunita" } },
      answerResponse,
    );
    assert.equal(answerResponse.statusCode, 200);
    assert.equal(answerResponse.body.question.id, "A0");
    assert.equal(writes.at(-1).answers[0].questionId, "A2_NAME");

    const reviewResponse = responseRecorder();
    await interviewController.flagManualReview(
      { body: { sessionId, reason: "Persisted review marker" } },
      reviewResponse,
    );
    assert.equal(reviewResponse.statusCode, 200);
    assert.equal(writes.at(-1).manualReviewRequired, true);

    const endResponse = responseRecorder();
    await interviewController.endInterview({ body: { sessionId } }, endResponse);
    assert.equal(endResponse.statusCode, 200);
    assert.equal(writes.at(-1).status, "incomplete");
    assert.equal(writes.at(-1).reportPdfStatus.status, "generated");
    assert.equal(writes.at(-1).reportPdfRef.fileId, "pdf-test-file");

    interviewService.restoreSessions([writes.at(-1)]);
    const restoredReport = interviewService.getReport(sessionId).body.report;
    assert.equal(restoredReport.status, "incomplete");
    assert.equal(restoredReport.manualReviewRequired, true);
    assert.equal(restoredReport.answers[0].questionId, "A2_NAME");
  } finally {
    if (sessionId) interviewService.restoreSessionSnapshot(sessionId, null);
    persistence.isConnected = originalConnected;
    persistence.saveSession = originalSave;
    persistence.findSessionById = originalFindSession;
    persistence.getOrCreateReportPdf = originalGetOrCreatePdf;
  }
});

test("failed Mongo persistence rejects interview start without retaining volatile state", async () => {
  const originalSave = persistence.saveSession;
  const originalStart = interviewService.startInterview;
  let createdSessionId;
  persistence.saveSession = async () => { throw new Error("simulated storage outage"); };
  interviewService.startInterview = () => {
    const result = originalStart();
    createdSessionId = result.sessionId;
    return result;
  };

  try {
    const response = responseRecorder();
    await interviewController.startInterview({}, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, "INTERVIEW_STORAGE_UNAVAILABLE");
    assert.equal(interviewService.getSessionSnapshot(createdSessionId), null);
  } finally {
    if (createdSessionId) interviewService.restoreSessionSnapshot(createdSessionId, null);
    persistence.saveSession = originalSave;
    interviewService.startInterview = originalStart;
  }
});
