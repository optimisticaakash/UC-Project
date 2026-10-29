import test from "node:test";
import assert from "node:assert/strict";
import {
  getAdminDeletionConfirmation,
  getCandidateDeletionConfirmation,
  getCandidateDeactivationConfirmation,
  getCandidateStatusAction,
  getReportDeletionConfirmation,
} from "./accountDeletion.js";

test("admin deletion confirmation is unavailable for self and explains destructive effect for another admin", () => {
  const current = { adminId: "admin-a", name: "Current", loginIdentifier: "current@example.test", active: true };
  assert.equal(getAdminDeletionConfirmation(current, "admin-a"), null);
  assert.equal(getAdminDeletionConfirmation({ ...current, adminId: "admin-b" }, "admin-a"), "Delete admin account for Current (current@example.test)? Its existing sessions will be invalidated. This action cannot be undone.");
  assert.equal(getAdminDeletionConfirmation({ ...current, active: false }, "admin-a"), null);
});

test("candidate confirmation clearly states account access ends while history and PDFs remain", () => {
  const candidate = { candidateId: "candidate-a", name: "Candidate", loginIdentifier: "candidate@example.test", active: true };
  assert.match(getCandidateDeactivationConfirmation(candidate), /history, reports, and PDFs will be preserved/u);
  assert.equal(getCandidateDeactivationConfirmation({ ...candidate, active: false }), null);
});

test("candidate status action switches between Activate and Deactivate", () => {
  assert.equal(getCandidateStatusAction({ active: true }), "deactivate");
  assert.equal(getCandidateStatusAction({ active: false }), "activate");
  assert.equal(getCandidateStatusAction({ active: false, deletedAt: "2026-10-27T00:00:00.000Z" }), "removed");
});

test("candidate delete confirmation explains the soft-delete and retained historical data", () => {
  const candidate = { candidateId: "candidate-a", name: "Candidate", loginIdentifier: "candidate@example.test" };
  const message = getCandidateDeletionConfirmation(candidate);
  assert.match(message, /marked deleted/u);
  assert.match(message, /history, reports, and PDFs will be retained/u);
  assert.equal(getCandidateDeletionConfirmation({ ...candidate, deletedAt: "2026-01-01" }), null);
});

test("report deletion confirmation identifies candidate name, session ID, and warns of permanent removal", () => {
  const session = { sessionId: "sess-12345", candidateName: "Priya Sharma" };
  const message = getReportDeletionConfirmation(session);
  assert.match(message, /Priya Sharma/);
  assert.match(message, /sess-12345/);
  assert.match(message, /permanently deleted/);
  assert.match(message, /cannot be undone/);
  assert.equal(getReportDeletionConfirmation(null), null);
  assert.equal(getReportDeletionConfirmation({}), null);
});
