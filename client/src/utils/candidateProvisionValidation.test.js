import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidCandidateEmail,
  normalizeCandidateLoginIdentifier,
  validateCandidateProvision,
} from "./candidateProvisionValidation.js";

test("candidate email validation accepts valid email and normalizes whitespace and casing", () => {
  assert.equal(isValidCandidateEmail("candidate+ops@example.test"), true);
  assert.equal(normalizeCandidateLoginIdentifier("  CANDIDATE@EXAMPLE.TEST "), "candidate@example.test");
});

test("candidate email validation rejects usernames, malformed addresses, and addresses over the limit", () => {
  for (const email of ["candidate_01", "bad address@example.test", "missing-at.example", `${"a".repeat(148)}@example.test`]) {
    assert.equal(isValidCandidateEmail(email), false, email);
  }
  assert.equal(validateCandidateProvision({ name: "Candidate", loginIdentifier: "bad address", password: "secure-password-123" }).field, "email");
});

test("candidate provision validation accepts exactly eight password characters and retains the maximum", () => {
  assert.equal(validateCandidateProvision({ name: "Candidate", loginIdentifier: "candidate@example.test", password: "1234567" }).field, "password");
  assert.equal(validateCandidateProvision({ name: "Candidate", loginIdentifier: "candidate@example.test", password: "12345678" }), null);
  assert.equal(validateCandidateProvision({ name: "Candidate", loginIdentifier: "candidate@example.test", password: "p".repeat(1024) }), null);
  assert.equal(validateCandidateProvision({ name: "Candidate", loginIdentifier: "candidate@example.test", password: "p".repeat(1025) }).field, "password");
});
