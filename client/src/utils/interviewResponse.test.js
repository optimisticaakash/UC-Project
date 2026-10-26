import assert from "node:assert/strict";
import test from "node:test";
import {
  isLostInterviewSession,
  recoverMissingPrompt,
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

test("missing prompt recovery performs one empty state-reconciliation request", async () => {
  const calls = [];
  const recovery = await recoverMissingPrompt({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 409,
        async json() {
          return {
            success: false,
            staleQuestion: true,
            currentQuestionId: "A8",
            question: { id: "A8", text: "Current authorized question" },
          };
        },
      };
    },
    apiUrl: "http://localhost:5001",
    sessionId: "session-123",
    expectedQuestionId: "A7",
    requestId: "p9-a1",
    promptTurn: 9,
    sessionGeneration: 2,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:5001/api/interview/answer");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.answer, "");
  assert.equal(payload.expectedQuestionId, "A7");
  assert.equal(payload.diagnosticRequestId, "p9-a1-r1");
  assert.equal("candidateAnswer" in payload, false);
  assert.equal(recovery.promptHandoff.questionId, "A8");
  assert.equal(recovery.promptHandoff.staleRecovery, true);
});

test("failed missing-prompt recovery does not loop or return a question", async () => {
  let calls = 0;
  const recovery = await recoverMissingPrompt({
    fetchImpl: async () => {
      calls += 1;
      return {
        status: 400,
        async json() {
          return { success: false, message: "Invalid answer" };
        },
      };
    },
    apiUrl: "http://localhost:5001",
    sessionId: "session-123",
    expectedQuestionId: "A7",
    requestId: "p9-a1",
    promptTurn: 9,
    sessionGeneration: 2,
  });

  assert.equal(calls, 1);
  assert.equal(recovery.promptHandoff, null);
});
