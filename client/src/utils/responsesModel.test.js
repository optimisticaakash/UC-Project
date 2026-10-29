import test from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_SHEET_URL,
  formatResponseTimestamp,
  filterResponses,
  groupResponsesBySession,
} from "./responsesModel.js";

const sampleResponses = [
  {
    sessionId: "sess-1",
    candidateId: "cand-1",
    candidateName: "Pooja Sharma",
    questionId: "A0",
    officialQuestion: "Kya hum yeh assessment shuru karein?",
    candidateResponse: "Haan ji",
    interpretedStatus: "accepted",
    followUps: "None",
    validationResult: "accepted",
    manualReviewRequired: "No",
    interviewStatus: "completed",
    timestamp: "2026-10-28T10:00:00.000Z",
    reportReference: "/api/interview/sess-1/report",
  },
  {
    sessionId: "sess-1",
    candidateId: "cand-1",
    candidateName: "Pooja Sharma",
    questionId: "A1",
    officialQuestion: "Aap kahan rehte hain?",
    candidateResponse: "Indiranagar",
    interpretedStatus: "accepted",
    followUps: "None",
    validationResult: "accepted",
    manualReviewRequired: "No",
    interviewStatus: "completed",
    timestamp: "2026-10-28T10:01:00.000Z",
    reportReference: "/api/interview/sess-1/report",
  },
  {
    sessionId: "sess-2",
    candidateId: "cand-2",
    candidateName: "Rekha Verma",
    questionId: "A0",
    officialQuestion: "Kya hum yeh assessment shuru karein?",
    candidateResponse: "Haan",
    interpretedStatus: "accepted",
    followUps: "None",
    validationResult: "accepted",
    manualReviewRequired: "Yes",
    interviewStatus: "manual_review",
    timestamp: "2026-10-28T11:00:00.000Z",
    reportReference: "/api/interview/sess-2/report",
  },
  {
    sessionId: "sess-3",
    candidateId: "cand-3",
    candidateName: "Anita Rao",
    questionId: "A0",
    officialQuestion: "Kya hum yeh assessment shuru karein?",
    candidateResponse: "Haan ji shuru kijiye",
    interpretedStatus: "accepted",
    followUps: "None",
    validationResult: "accepted",
    manualReviewRequired: "No",
    interviewStatus: "in_progress",
    timestamp: "2026-10-28T12:00:00.000Z",
    reportReference: "/api/interview/sess-3/report",
  },
];

test("GOOGLE_SHEET_URL points to the verified interview response spreadsheet", () => {
  assert.equal(
    GOOGLE_SHEET_URL,
    "https://docs.google.com/spreadsheets/d/1N4_FZJMovlwRxtN1HvSGsAhbAmi1GaX1KKqrpZGE-58/edit",
  );
});

test("formatResponseTimestamp safely handles valid, invalid, and empty timestamps", () => {
  assert.equal(formatResponseTimestamp(null), "Date unavailable");
  assert.equal(formatResponseTimestamp(""), "Date unavailable");
  const formatted = formatResponseTimestamp("2026-10-28T10:00:00.000Z");
  assert.ok(formatted && formatted !== "Date unavailable");
});

test("filterResponses searches by candidate name", () => {
  const result = filterResponses(sampleResponses, { search: "Pooja" });
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.candidateName === "Pooja Sharma"));
});

test("filterResponses searches by candidate ID", () => {
  const result = filterResponses(sampleResponses, { search: "cand-2" });
  assert.equal(result.length, 1);
  assert.equal(result[0].candidateId, "cand-2");
});

test("filterResponses searches by session ID", () => {
  const result = filterResponses(sampleResponses, { search: "sess-3" });
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, "sess-3");
});

test("filterResponses filters by interview status", () => {
  const completed = filterResponses(sampleResponses, { statusFilter: "completed" });
  assert.equal(completed.length, 2);
  assert.ok(completed.every((r) => r.interviewStatus === "completed"));

  const inProgress = filterResponses(sampleResponses, { statusFilter: "in_progress" });
  assert.equal(inProgress.length, 1);
  assert.equal(inProgress[0].sessionId, "sess-3");
});

test("filterResponses filters by manual review required", () => {
  const reviewYes = filterResponses(sampleResponses, { manualReviewFilter: "yes" });
  assert.equal(reviewYes.length, 1);
  assert.equal(reviewYes[0].candidateName, "Rekha Verma");

  const reviewNo = filterResponses(sampleResponses, { manualReviewFilter: "no" });
  assert.equal(reviewNo.length, 3);
  assert.ok(reviewNo.every((r) => r.manualReviewRequired === "No"));
});

test("filterResponses sorts newest first by default and oldest first when specified", () => {
  const newestFirst = filterResponses(sampleResponses, { sortOrder: "newest" });
  assert.equal(newestFirst[0].sessionId, "sess-3"); // 12:00:00
  assert.equal(newestFirst[newestFirst.length - 1].sessionId, "sess-1"); // 10:00:00

  const oldestFirst = filterResponses(sampleResponses, { sortOrder: "oldest" });
  assert.equal(oldestFirst[0].sessionId, "sess-1"); // 10:00:00
  assert.equal(oldestFirst[oldestFirst.length - 1].sessionId, "sess-3"); // 12:00:00
});

test("groupResponsesBySession groups responses by session ID with aggregated metadata", () => {
  const groups = groupResponsesBySession(sampleResponses);
  assert.equal(groups.length, 3);

  const sess1Group = groups.find((g) => g.sessionId === "sess-1");
  assert.ok(sess1Group);
  assert.equal(sess1Group.candidateName, "Pooja Sharma");
  assert.equal(sess1Group.responses.length, 2);
  assert.equal(sess1Group.interviewStatus, "completed");
  assert.equal(sess1Group.manualReviewRequired, false);

  const sess2Group = groups.find((g) => g.sessionId === "sess-2");
  assert.ok(sess2Group);
  assert.equal(sess2Group.manualReviewRequired, true);
});

