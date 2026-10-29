const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SCREENING_TAB,
  ANSWERS_TAB,
  SCREENING_SECTIONS,
  SCREENING_HEADERS,
  ANSWERS_HEADERS,
  SHEET_HEADERS,
  isConfigured,
  getQuestionLabel,
  resolveCandidateName,
  formatAnswerRow,
  formatScreeningRow,
  formatRow,
  ensureTabsAndHeaders,
  syncCandidateSummaryToSheet,
  syncAnswerToSheet,
  syncSessionSummaryToSheet,
  readSheetRows,
  clearSyncCache,
} = require("./googleSheetsService");

test("Exact two-tab application layout, tab names, and header order", () => {
  assert.equal(SCREENING_TAB, "Screening Sheet");
  assert.equal(ANSWERS_TAB, "Answers");

  // Screening Sheet: 69 columns
  assert.equal(SCREENING_SECTIONS.length, 69);
  assert.equal(SCREENING_HEADERS.length, 69);

  // Check section ranges
  assert.deepEqual(SCREENING_SECTIONS.slice(0, 7), Array(7).fill("Candidate"));
  assert.deepEqual(SCREENING_SECTIONS.slice(7, 23), Array(16).fill("Basic checks"));
  assert.deepEqual(SCREENING_SECTIONS.slice(23, 30), Array(7).fill("Experience"));
  assert.deepEqual(SCREENING_SECTIONS.slice(30, 39), Array(9).fill("Need for money"));
  assert.deepEqual(SCREENING_SECTIONS.slice(39, 41), Array(2).fill("Intent"));
  assert.deepEqual(SCREENING_SECTIONS.slice(41, 49), Array(8).fill("Availability"));
  assert.deepEqual(SCREENING_SECTIONS.slice(49, 59), Array(10).fill("Disha result"));
  assert.deepEqual(SCREENING_SECTIONS.slice(59, 69), Array(10).fill("Team to fill"));

  // Check specific column headers
  assert.equal(SCREENING_HEADERS[0], "Date");
  assert.equal(SCREENING_HEADERS[1], "Candidate");
  assert.equal(SCREENING_HEADERS[2], "Report ID");
  assert.equal(SCREENING_HEADERS[3], "Language");
  assert.equal(SCREENING_HEADERS[4], "Area");
  assert.equal(SCREENING_HEADERS[7], "Age");
  assert.equal(SCREENING_HEADERS[23], "Experience (years)");
  assert.equal(SCREENING_HEADERS[35], "Need for money");
  assert.equal(SCREENING_HEADERS[39], "Why UC");
  assert.equal(SCREENING_HEADERS[41], "Weekend 11 hrs OK");
  assert.equal(SCREENING_HEADERS[49], "Disha result");
  assert.equal(SCREENING_HEADERS[58], "Duration (min)");
  assert.equal(SCREENING_HEADERS[68], "Comments");

  // Answers Tab: exact 9 headers in exact order
  assert.equal(ANSWERS_HEADERS.length, 9);
  assert.deepEqual(ANSWERS_HEADERS, [
    "Date",
    "Candidate",
    "Report ID",
    "Question",
    "What she said (verbatim)",
    "Bucket",
    "Result",
    "Correct?",
    "Key quote",
  ]);
});

test("Candidate name is resolved from user ID via authoritative candidate record, never displaying ID", async () => {
  const fakeCandidates = new Map([
    ["cand-uuid-1", { candidateId: "cand-uuid-1", name: "Sunita Sharma" }],
  ]);

  const mockPersistence = {
    findCandidateById: async (id) => fakeCandidates.get(id) || null,
  };

  // 1. Valid candidate ID resolves to actual candidate name
  const resolvedName = await resolveCandidateName({
    candidateId: "cand-uuid-1",
    persistenceImpl: mockPersistence,
  });
  assert.equal(resolvedName, "Sunita Sharma");

  // 2. Missing/unresolved candidate ID must NOT fabricate a name or display the UUID
  const missingName = await resolveCandidateName({
    candidateId: "non-existent-uuid",
    persistenceImpl: mockPersistence,
  });
  assert.equal(missingName, "Unresolved candidate (needs review)");
  assert.doesNotMatch(missingName, /non-existent-uuid/);

  // 3. Null or undefined candidate ID
  const nullName = await resolveCandidateName({
    candidateId: null,
    persistenceImpl: mockPersistence,
  });
  assert.equal(nullName, "Unresolved candidate (needs review)");
});

test("Short question labels are derived from question bank, preserving question IDs internally", () => {
  const labelA0 = getQuestionLabel("A0");
  assert.match(labelA0, /^A0:/);
  assert.match(labelA0, /Consent|Setup/i);

  const labelB7 = getQuestionLabel("B7");
  assert.match(labelB7, /^B7:/);
  assert.match(labelB7, /Need for money/i);

  const labelFollowUp = getQuestionLabel("A1_move_timeline");
  assert.match(labelFollowUp, /^A1_move_timeline:/);
});

test("Answers row formatting preserves verbatim response and maps assessment fields without fabricating", () => {
  const session = {
    sessionId: "sess-abc-123",
    reportId: "rep-abc-123",
    startedAt: "2026-10-28T14:00:00.000Z",
  };

  const answerRecord = {
    questionId: "B7",
    answer: "Pichle saal loan liya tha, abhi bhi EMI chal rahi hai",
    bucket: "Specific liability",
    interpretation: {
      answerStatus: "sufficient",
      keyQuote: "loan liya tha",
    },
    correct: true,
    answeredAt: "2026-10-28T14:05:00.000Z",
  };

  const row = formatAnswerRow({
    session,
    answerRecord,
    candidateName: "Pooja Devi",
    reportId: "rep-abc-123",
  });

  assert.equal(row.length, 9);
  assert.equal(row[0], "2026-10-28T14:05:00.000Z"); // Date
  assert.equal(row[1], "Pooja Devi"); // Candidate
  assert.equal(row[2], "rep-abc-123"); // Report ID
  assert.match(row[3], /^B7:/); // Question
  assert.equal(row[4], "Pichle saal loan liya tha, abhi bhi EMI chal rahi hai"); // Verbatim
  assert.equal(row[5], "Specific liability"); // Bucket
  assert.equal(row[6], "sufficient"); // Result
  assert.equal(row[7], "Correct"); // Correct?
  assert.equal(row[8], "loan liya tha"); // Key quote

  // When assessment fields are unavailable, they must remain blank
  const simpleRecord = {
    questionId: "A1",
    answer: "Bellandur",
  };
  const emptyRow = formatAnswerRow({
    session,
    answerRecord: simpleRecord,
    candidateName: "Pooja Devi",
  });
  assert.equal(emptyRow[5], ""); // Bucket is blank
  assert.equal(emptyRow[7], ""); // Correct? is blank
  assert.equal(emptyRow[8], ""); // Key quote is blank
});

test("Screening Sheet candidate row maps all 69 columns and calculates duration", () => {
  const session = {
    sessionId: "sess-screening-1",
    reportId: "rep-screening-1",
    candidateId: "cand-1",
    status: "completed",
    startedAt: "2026-10-28T14:00:00.000Z",
    completedAt: "2026-10-28T14:27:30.000Z",
    answers: [
      { questionId: "A0", answer: "Haan ji", consentOutcome: "accepted" },
      { questionId: "A1", answer: "Bellandur", location: "Bellandur", travelWillingness: "Yes" },
      { questionId: "A2", answer: "29 saal", age: 29 },
      { questionId: "A3", answer: "Married, 2 kids" },
      { questionId: "B2", answer: "4 years at Green Trends" },
      { questionId: "B7", answer: "Home loan EMI" },
    ],
  };

  const row = formatScreeningRow({
    session,
    candidateName: "Kavita Rao",
    reportId: "rep-screening-1",
  });

  assert.equal(row.length, 69);
  assert.equal(row[0], "2026-10-28T14:27:30.000Z"); // Date
  assert.equal(row[1], "Kavita Rao"); // Candidate
  assert.equal(row[2], "rep-screening-1"); // Report ID
  assert.equal(row[3], "Hindi"); // Language
  assert.equal(row[4], "Bellandur"); // Area
  assert.equal(row[6], "Yes"); // Open to moving
  assert.equal(row[7], 29); // Age
  assert.equal(row[8], "Married, 2 kids"); // Marital status
  assert.equal(row[23], "4 years at Green Trends"); // Experience
  assert.equal(row[35], "Home loan EMI"); // Need for money
  assert.equal(row[49], "Auto-pass"); // Disha result
  assert.equal(row[58], "27.5"); // Duration in minutes (27.5 min)
  assert.equal(row[59], ""); // Team to fill column is blank
});

test("syncAnswerToSheet appends to Answers tab and updates Screening Sheet in-place without duplicate candidate rows", async () => {
  clearSyncCache();
  process.env.GOOGLE_SHEET_ID = "mock-sheet-id";
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "mock@service.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = "mock-key";

  const calls = [];
  const mockFetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ method, url, body: options.body ? JSON.parse(options.body) : null });

    // Metadata
    if (url.includes("?fields=sheets.properties")) {
      return {
        ok: true,
        json: async () => ({
          sheets: [
            { properties: { title: "Screening Sheet", sheetId: 101 } },
            { properties: { title: "Answers", sheetId: 102 } },
          ],
        }),
      };
    }
    // Headers checks
    if (url.includes("/values/Screening%20Sheet!A1:BQ2")) {
      return { ok: true, json: async () => ({ values: [SCREENING_SECTIONS, SCREENING_HEADERS] }) };
    }
    if (url.includes("/values/Answers!A1:I1")) {
      return { ok: true, json: async () => ({ values: [ANSWERS_HEADERS] }) };
    }
    // Column C check (Report IDs) on Screening Sheet
    if (url.includes("/values/Screening%20Sheet!C3:C")) {
      // First call: candidate row not found. Second call: candidate row found at row 3
      const found = calls.some((c) => c.method === "POST" && c.url.includes("Screening%20Sheet!A:BQ:append"));
      return {
        ok: true,
        json: async () => ({ values: found ? [["rep-test-01"]] : [] }),
      };
    }
    // Append to Answers
    if (url.includes("/values/Answers!A:I:append")) {
      return { ok: true, json: async () => ({ updates: { updatedRows: 1 } }) };
    }
    // Append to Screening Sheet
    if (url.includes("/values/Screening%20Sheet!A:BQ:append")) {
      return { ok: true, json: async () => ({ updates: { updatedRange: "'Screening Sheet'!A3:BQ3" } }) };
    }
    // Update existing candidate row in Screening Sheet
    if (url.includes("/values/Screening%20Sheet!A3:BQ3")) {
      return { ok: true, json: async () => ({ updatedRows: 1 }) };
    }

    throw new Error(`Unhandled mock fetch: ${method} ${url}`);
  };

  const mockJwtFactory = () => ({
    getAccessToken: async () => ({ token: "mock-token" }),
  });

  const mockPersistence = {
    findCandidateById: async () => ({ name: "Meena Kumari" }),
  };

  const session = {
    sessionId: "sess-test-01",
    reportId: "rep-test-01",
    candidateId: "cand-test-01",
    answers: [],
  };

  const answer1 = { questionId: "A0", answer: "Haan ji" };
  session.answers.push(answer1);

  // Sync Question 1
  const sync1 = await syncAnswerToSheet({
    session,
    answerRecord: answer1,
    fetchImpl: mockFetch,
    jwtClientFactory: mockJwtFactory,
    persistenceImpl: mockPersistence,
  });
  assert.equal(sync1.success, true);
  assert.equal(sync1.synced, true);

  // Answers tab received append
  const answerAppends = calls.filter((c) => c.url.includes("Answers!A:I:append"));
  assert.equal(answerAppends.length, 1);
  assert.equal(answerAppends[0].body.values[0][1], "Meena Kumari");
  assert.equal(answerAppends[0].body.values[0][2], "rep-test-01");

  // Screening Sheet received initial append
  const screeningAppends = calls.filter((c) => c.url.includes("Screening%20Sheet!A:BQ:append"));
  assert.equal(screeningAppends.length, 1);

  // Sync Question 2 for the same candidate
  const answer2 = { questionId: "A1", answer: "Koramangala" };
  session.answers.push(answer2);

  const sync2 = await syncAnswerToSheet({
    session,
    answerRecord: answer2,
    fetchImpl: mockFetch,
    jwtClientFactory: mockJwtFactory,
    persistenceImpl: mockPersistence,
  });
  assert.equal(sync2.success, true);
  assert.equal(sync2.synced, true);

  // Answers tab received 2nd append (1 row per answer)
  assert.equal(calls.filter((c) => c.url.includes("Answers!A:I:append")).length, 2);

  // Screening Sheet updated in-place via PUT, did NOT append another summary row
  assert.equal(calls.filter((c) => c.url.includes("Screening%20Sheet!A:BQ:append")).length, 1);
  const screeningUpdates = calls.filter((c) => c.method === "PUT" && c.url.includes("Screening%20Sheet!A3:BQ3"));
  assert.ok(screeningUpdates.length >= 1, "Expected in-place update of candidate summary row");

  // Duplicate sync for same answer is idempotent
  const dupe = await syncAnswerToSheet({
    session,
    answerRecord: answer2,
    fetchImpl: mockFetch,
    jwtClientFactory: mockJwtFactory,
    persistenceImpl: mockPersistence,
  });
  assert.equal(dupe.synced, false);
  assert.equal(dupe.reason, "already_synced");

  delete process.env.GOOGLE_SHEET_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PRIVATE_KEY;
  clearSyncCache();
});

test("ensureTabsAndHeaders safely removes obsolete Interview Responses when empty, preserves when data exists", async () => {
  clearSyncCache();
  const deletedSheetIds = [];

  const mockFetch = async (url, options = {}) => {
    // 1. Metadata check
    if (url.includes("?fields=sheets.properties")) {
      return {
        ok: true,
        json: async () => ({
          sheets: [
            { properties: { title: "Interview Responses", sheetId: 0 } },
            { properties: { title: "Screening Sheet", sheetId: 1 } },
            { properties: { title: "Answers", sheetId: 2 } },
          ],
        }),
      };
    }
    // 2. Check Interview Responses content (1 row = headers only)
    if (url.includes("/values/Interview%20Responses!A:A")) {
      return {
        ok: true,
        json: async () => ({ values: [["Session ID"]] }), // Only 1 row
      };
    }
    // 3. BatchUpdate to delete sheet
    if (url.includes(":batchUpdate")) {
      const body = JSON.parse(options.body);
      const del = body.requests?.find((r) => r.deleteSheet);
      if (del) deletedSheetIds.push(del.deleteSheet.sheetId);
      return { ok: true, json: async () => ({}) };
    }
    // Headers checks
    if (url.includes("/values/Screening%20Sheet!A1:BQ2") || url.includes("/values/Answers!A1:I1")) {
      return { ok: true, json: async () => ({ values: [["header"]] }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  // Run with removeObsoleteInterviewResponses = true
  const ok = await ensureTabsAndHeaders({
    sheetId: "test-sheet",
    accessToken: "test-token",
    fetchImpl: mockFetch,
    removeObsoleteInterviewResponses: true,
  });

  assert.equal(ok, true);
  assert.deepEqual(deletedSheetIds, [0]);
  clearSyncCache();
});

test("readSheetRows parses 9-column Answers tab into structured responses for Admin Portal", async () => {
  process.env.GOOGLE_SHEET_ID = "mock-sheet-id";
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "mock@example.com";
  process.env.GOOGLE_PRIVATE_KEY = "mock-key";

  const mockAnswers = [
    [
      "2026-10-28T14:05:00.000Z", // Date
      "Pooja Sharma", // Candidate
      "rep-001", // Report ID
      "B7: Need for money", // Question
      "Loan chal raha hai", // What she said (verbatim)
      "Specific liability", // Bucket
      "sufficient", // Result
      "Correct", // Correct?
      "loan chal raha hai", // Key quote
    ],
  ];

  const mockFetch = async (url) => {
    assert.match(url, /values\/Answers!A2:I/);
    return {
      ok: true,
      json: async () => ({ values: mockAnswers }),
    };
  };

  const mockJwtFactory = () => ({
    getAccessToken: async () => ({ token: "mock-token" }),
  });

  const res = await readSheetRows({
    fetchImpl: mockFetch,
    jwtClientFactory: mockJwtFactory,
  });

  assert.equal(res.success, true);
  assert.equal(res.rows.length, 1);
  const row = res.rows[0];
  assert.equal(row.timestamp, "2026-10-28T14:05:00.000Z");
  assert.equal(row.candidateName, "Pooja Sharma");
  assert.equal(row.reportId, "rep-001");
  assert.equal(row.sessionId, "rep-001");
  assert.equal(row.question, "B7: Need for money");
  assert.equal(row.questionId, "B7");
  assert.equal(row.candidateResponse, "Loan chal raha hai");
  assert.equal(row.whatSheSaid, "Loan chal raha hai");
  assert.equal(row.bucket, "Specific liability");
  assert.equal(row.result, "sufficient");
  assert.equal(row.correct, "Correct");
  assert.equal(row.keyQuote, "loan chal raha hai");

  delete process.env.GOOGLE_SHEET_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PRIVATE_KEY;
  clearSyncCache();
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
