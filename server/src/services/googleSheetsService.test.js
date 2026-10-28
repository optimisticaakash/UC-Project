const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatRow,
  syncAnswerToSheet,
  clearSyncCache,
  SHEET_HEADERS,
  isConfigured,
} = require("./googleSheetsService");

test("Google Sheets formatRow maps all required stakeholder fields", () => {
  assert.equal(SHEET_HEADERS.length, 13);
  assert.deepEqual(SHEET_HEADERS, [
    "Session ID",
    "Candidate ID",
    "Candidate Name",
    "Question ID",
    "Official Question",
    "Candidate Response",
    "Interpreted Status",
    "Follow-ups",
    "Validation Result",
    "Manual Review Required",
    "Interview Status",
    "Timestamp",
    "Report Reference",
  ]);

  const session = {
    sessionId: "test-session-123",
    candidateId: "cand-456",
    candidateName: "Pooja Sharma",
    status: "in_progress",
    manualReviewRequired: false,
  };

  const answerRecord = {
    questionId: "A1",
    questionText: "Where do you live?",
    answer: "Indiranagar, Bangalore",
    locationOutcome: "manual_review",
    answeredAt: "2026-10-28T10:00:00.000Z",
  };

  const row = formatRow({
    session,
    answerRecord,
    candidateName: "Pooja Sharma",
  });

  assert.equal(row.length, 13);
  assert.equal(row[0], "test-session-123");
  assert.equal(row[1], "cand-456");
  assert.equal(row[2], "Pooja Sharma");
  assert.equal(row[3], "A1");
  assert.equal(row[4], "Where do you live?");
  assert.equal(row[5], "Indiranagar, Bangalore");
  assert.equal(row[6], "manual_review");
  assert.equal(row[7], "None");
  assert.equal(row[8], "manual_review");
  assert.equal(row[9], "No");
  assert.equal(row[10], "in_progress");
  assert.equal(row[11], "2026-10-28T10:00:00.000Z");
  assert.equal(row[12], "/api/interview/test-session-123/report");
});

test("Google Sheets formatRow records follow-up context when present", () => {
  const session = {
    sessionId: "test-session-followup",
    candidateId: "cand-789",
    status: "in_progress",
  };

  const followUpRecord = {
    questionId: "A1_MOVE_TIMELINE",
    parentQuestionId: "A1",
    questionText: "When can you shift?",
    answer: "Within 2 weeks",
    isFollowUp: true,
  };

  const row = formatRow({ session, answerRecord: followUpRecord });
  assert.equal(row[7], "Follow-up to A1: Within 2 weeks");
});

test("Google Sheets sync safely no-ops when unconfigured without throwing", async () => {
  clearSyncCache();
  delete process.env.GOOGLE_SHEET_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PRIVATE_KEY;

  assert.equal(isConfigured(), false);

  const result = await syncAnswerToSheet({
    session: { sessionId: "unconf-session" },
    answerRecord: { questionId: "A0", answer: "Haan" },
  });

  assert.equal(result.success, true);
  assert.equal(result.synced, false);
  assert.equal(result.reason, "unconfigured");
});

test("Google Sheets sync sends formatted row and prevents duplicate submissions", async () => {
  clearSyncCache();
  process.env.GOOGLE_SHEET_ID = "mock-sheet-id";
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "mock@service.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = "mock-key";

  let appendedBody = null;
  const mockFetch = async (url, options) => {
    assert.match(url, /mock-sheet-id/);
    appendedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ updates: { updatedRows: 1 } }),
    };
  };

  const mockJwtClientFactory = () => ({
    getAccessToken: async () => ({ token: "mock-access-token" }),
  });

  const session = {
    sessionId: "session-abc",
    candidateId: "cand-1",
    candidateName: "Pooja",
    status: "in_progress",
  };

  const answerRecord = {
    questionId: "A0",
    questionText: "Consent",
    answer: "Haan bilkul",
    consentOutcome: "accepted",
  };

  const firstSync = await syncAnswerToSheet({
    session,
    answerRecord,
    candidateName: "Pooja",
    fetchImpl: mockFetch,
    jwtClientFactory: mockJwtClientFactory,
  });

  assert.equal(firstSync.success, true);
  assert.equal(firstSync.synced, true);
  assert.equal(appendedBody?.values?.[0]?.[5], "Haan bilkul");

  // Submitting the identical answer is idempotent and does not duplicate
  const duplicateSync = await syncAnswerToSheet({
    session,
    answerRecord,
    candidateName: "Pooja",
    fetchImpl: mockFetch,
    jwtClientFactory: mockJwtClientFactory,
  });

  assert.equal(duplicateSync.success, true);
  assert.equal(duplicateSync.synced, false);
  assert.equal(duplicateSync.reason, "already_synced");

  delete process.env.GOOGLE_SHEET_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PRIVATE_KEY;
  clearSyncCache();
});

test("Google Sheets sync handles API errors without rethrowing or losing data", async () => {
  clearSyncCache();
  process.env.GOOGLE_SHEET_ID = "mock-sheet-id";
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "mock@service.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = "mock-key";

  const failingFetch = async () => ({
    ok: false,
    status: 503,
  });

  const mockJwtClientFactory = () => ({
    getAccessToken: async () => ({ token: "mock-token" }),
  });

  const result = await syncAnswerToSheet({
    session: { sessionId: "session-err" },
    answerRecord: { questionId: "A1", answer: "test" },
    fetchImpl: failingFetch,
    jwtClientFactory: mockJwtClientFactory,
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "http_503");

  delete process.env.GOOGLE_SHEET_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PRIVATE_KEY;
  clearSyncCache();
});

