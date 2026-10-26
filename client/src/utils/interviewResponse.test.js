import assert from "node:assert/strict";
import test from "node:test";
import {
  isLostInterviewSession,
  resolvePromptHandoff,
} from "./interviewResponse.js";
import {
  isCurrentLiveGeneration,
  isCurrentLiveSession,
} from "./liveSessionLifecycle.js";

test("only an explicit missing-session response triggers session recovery", () => {
  assert.equal(
    isLostInterviewSession(404, { code: "SESSION_NOT_FOUND" }),
    true,
  );
  assert.equal(isLostInterviewSession(404, { code: "NOT_FOUND" }), false);
  assert.equal(isLostInterviewSession(409, { code: "SESSION_NOT_FOUND" }), false);
});

test("accepted A2_NAME response hands off the returned A0 consent prompt", () => {
  const handoff = resolvePromptHandoff(200, {
    success: true,
    question: { id: "A0", text: "Consent prompt" },
  });

  assert.deepEqual(handoff, {
    questionId: "A0",
    prompt: "Consent prompt",
    clarificationRequired: false,
    staleRecovery: false,
  });
});

test("A2_NAME to A0 handoff keeps the active Live generation eligible for audio events", () => {
  const handoff = resolvePromptHandoff(200, {
    success: true,
    question: { id: "A0", text: "Consent prompt" },
  });
  const activeGeneration = 4;

  assert.equal(handoff.questionId, "A0");
  assert.equal(
    isCurrentLiveGeneration(activeGeneration, activeGeneration),
    true,
  );
  assert.equal(
    isCurrentLiveGeneration(activeGeneration - 1, activeGeneration),
    false,
  );
});

test("A0 audio handoff remains attached to the same active Live session", () => {
  const liveSession = { sendClientContent() {} };
  const handoff = resolvePromptHandoff(200, {
    success: true,
    question: { id: "A0", text: "Consent prompt" },
  });

  assert.equal(handoff.questionId, "A0");
  assert.equal(
    isCurrentLiveSession(liveSession, 8, liveSession, 8),
    true,
  );
  assert.equal(
    isCurrentLiveSession(liveSession, 8, { sendClientContent() {} }, 9),
    false,
  );
});

test("a late callback from an obsolete Live session cannot target the current session", () => {
  const obsoleteSession = { close() {} };
  const activeSession = { close() {} };

  assert.equal(
    isCurrentLiveSession(obsoleteSession, 7, activeSession, 8),
    false,
  );
  assert.equal(isCurrentLiveGeneration(7, 8), false);
});

test("stale 409 recovers by handing off the server's active prompt", () => {
  const handoff = resolvePromptHandoff(409, {
    success: false,
    staleQuestion: true,
    currentQuestionId: "A1_TRAVEL_CLARIFICATION",
    clarificationRequired: true,
    message: "Please clarify your travel answer.",
    question: {
      id: "A1_TRAVEL_CLARIFICATION",
      text: "Travel clarification prompt",
    },
  });

  assert.deepEqual(handoff, {
    questionId: "A1_TRAVEL_CLARIFICATION",
    prompt: "Travel clarification prompt",
    clarificationRequired: true,
    staleRecovery: true,
  });
});

test("stale 409 without an active question cannot trigger a prompt", () => {
  assert.equal(
    resolvePromptHandoff(409, {
      success: false,
      staleQuestion: true,
      currentQuestionId: "A0",
    }),
    null,
  );
});
