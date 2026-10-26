import test from "node:test";
import assert from "node:assert/strict";
import {
  createInterviewReportView,
  isFinalInterviewReport,
} from "./interviewReport.js";

test("in-progress reports are not treated as completed reports", () => {
  const report = {
    status: "in_progress",
    totalQuestions: 50,
    answeredQuestions: 3,
    answers: [],
  };

  assert.equal(isFinalInterviewReport(report), false);
  assert.equal(createInterviewReportView(report).isFinal, false);
});

test("report view preserves recorded follow-ups and review flags without scores", () => {
  const followUp = {
    questionId: "A1_move_timeline",
    questionText: "Official follow-up prompt",
    answer: "Recorded follow-up answer",
    manualReviewRequired: true,
  };
  const view = createInterviewReportView({
    status: "completed",
    totalQuestions: 50,
    answeredQuestions: 2,
    manualReviewRequired: true,
    manualReviewReason: "Offline check",
    consentOutcome: "accepted",
    eligibilityOutcome: "manual_review",
    locationOutcome: "manual_review",
    manualChecks: [{ questionId: "A1", required: true }],
    answers: [followUp],
  });

  assert.equal(view.isFinal, true);
  assert.equal(view.statusLabel, "Interview completed");
  assert.equal(view.manualReviewRequired, true);
  assert.equal(view.answers[0], followUp);
  assert.equal("score" in view, false);
  assert.equal("score" in view.answers[0], false);
});

test("manual-review and rejected terminal reports retain their status", () => {
  assert.equal(
    createInterviewReportView({ status: "manual_review" }).statusLabel,
    "Manual review required",
  );
  assert.equal(
    createInterviewReportView({ status: "rejected" }).statusLabel,
    "Interview ended with an eligibility outcome",
  );
});

test("incomplete ended sessions remain available as finalized internal reports", () => {
  const report = {
    sessionId: "ended-session",
    status: "incomplete",
    answeredQuestions: 2,
    answers: [{ questionId: "A2_NAME", answer: "Name recorded" }],
    manualReviewRequired: true,
  };
  const view = createInterviewReportView(report);
  assert.equal(isFinalInterviewReport(report), true);
  assert.equal(view.isFinal, true);
  assert.equal(view.statusLabel, "Interview ended before completion");
  assert.equal(view.answeredQuestions, 2);
  assert.equal(view.manualReviewRequired, true);
});
