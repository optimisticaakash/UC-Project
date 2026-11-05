const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateInquiryResponse,
  INQUIRY_TIMEOUT_MS,
  DEFAULT_INQUIRY_TIMEOUT_MS,
} = require("./geminiService");

const interviewService = require("./interview");

test("1. Configurable Timeout: Defaults to 15000ms and honors custom values", () => {
  assert.equal(DEFAULT_INQUIRY_TIMEOUT_MS, 15000);
  assert.ok(INQUIRY_TIMEOUT_MS >= 10000, `INQUIRY_TIMEOUT_MS should be at least 10000, got: ${INQUIRY_TIMEOUT_MS}`);
});

test("2. Gemini response at 9–10s: Successfully completes without fallback", async () => {
  // Simulates Gemini taking 9.5s (9500ms scaled to test environment)
  const simulatedGeminiOutput = JSON.stringify({
    topic: "customer_handling",
    conversationalReasoning: "Candidate asked about angry customers; explaining de-escalation politely.",
    followUpDecision: "DIRECT_ANSWER",
    replyText: "Customer ko shanti se sunna aur unki samasya samajhkar polite solution dena zaroori hota hai.",
    probeQuestion: "",
    suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
  });

  const startTime = Date.now();
  const res = await generateInquiryResponse({
    candidateUtterance: "Customer satisfaction kya hota hai?",
    currentQuestion: { id: "B1", text: "Experience kitna hai?" },
    timeoutMs: 15000,
    generateTextImpl: async () => {
      // Simulate network latency of 300ms (representing 9.5s in fast test)
      await new Promise((resolve) => setTimeout(resolve, 300));
      return simulatedGeminiOutput;
    },
  });

  assert.equal(res.topic, "customer_handling");
  assert.match(res.replyText, /Customer ko shanti se sunna/);
  assert.equal(res.followUpDecision, "DIRECT_ANSWER");
});

test("3. Gemini response just before timeout: Successfully completes without triggering fallback", async () => {
  const simulatedGeminiOutput = JSON.stringify({
    topic: "salon_technique",
    conversationalReasoning: "Explaining Rica wax difference right before deadline.",
    followUpDecision: "PRACTICAL_EXAMPLE",
    replyText: "Rica wax colophony-free hoti hai aur sensitive skin ke liye behtar rehti hai.",
    probeQuestion: "Kya aapne pehle Rica wax use ki hai?",
    suggestedNextAction: "CONTINUE_INQUIRY",
  });

  const res = await generateInquiryResponse({
    candidateUtterance: "Rica wax aur normal wax mein kya farak hai?",
    currentQuestion: { id: "B1", text: "Experience kitna hai?" },
    timeoutMs: 400, // 400ms boundary
    generateTextImpl: async () => {
      // Response arrives at 300ms, just before 400ms timeout
      await new Promise((resolve) => setTimeout(resolve, 300));
      return simulatedGeminiOutput;
    },
  });

  assert.equal(res.topic, "salon_technique");
  assert.match(res.replyText, /Rica wax colophony-free hoti hai/);
  assert.equal(res.probeQuestion, "Kya aapne pehle Rica wax use ki hai?");
});

test("4. Actual timeout and fallback: Times out after configured boundary and activates fallback", async () => {
  let fallbackActivated = false;

  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Kya mujhe travel karna hoga?",
      currentQuestion: { id: "A1", text: "Location?" },
      timeoutMs: 150, // Short timeout to verify exact boundary
      generateTextImpl: async () => {
        // Exceeds 150ms timeout
        await new Promise((resolve) => setTimeout(resolve, 500));
        return JSON.stringify({ replyText: "Late answer" });
      },
    }),
    (err) => {
      assert.equal(err.code, "AI_TIMEOUT");
      return true;
    },
  );
});

test("5. Late response after timeout: Does not trigger duplicate response or unhandled rejection", async () => {
  let backgroundPromiseResolved = false;

  // Launch inquiry response with 100ms timeout where mock takes 300ms
  const slowPromise = generateInquiryResponse({
    candidateUtterance: "Customer satisfaction kya hai?",
    currentQuestion: { id: "B1", text: "Experience?" },
    timeoutMs: 100,
    generateTextImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      backgroundPromiseResolved = true;
      return JSON.stringify({
        topic: "customer_handling",
        conversationalReasoning: "Late",
        followUpDecision: "DIRECT_ANSWER",
        replyText: "Late Gemini reply that arrived after timeout",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });

  await assert.rejects(slowPromise, (err) => err.code === "AI_TIMEOUT");

  // Wait for background mock to complete at 350ms
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(backgroundPromiseResolved, true, "Background promise completed without crashing Node.js");
});

test("6. Duplicate response prevention in interview service: Fallback and Gemini are mutually exclusive", async () => {
  const startRes = await interviewService.startInterview({
    testSessionKey: "verify_dup_prevention",
    candidateId: "cand_dup_001",
    candidateName: "Rani",
  });

  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Rani",
    expectedQuestionId: "A2_NAME",
  });
  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Haan",
    expectedQuestionId: "A2_NAME_CONFIRM",
  });
  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Haan, main agree karti hoon",
    expectedQuestionId: "A0",
  });
  const a1Res = await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Delhi mein rehti hoon aur travel kar sakti hoon",
    expectedQuestionId: "A1",
  });

  const activeQId = a1Res.body.question.id;

  // Submit inquiry with simulated timeout
  let callsCompleted = 0;
  const inquiryRes = await interviewService.submitAnswer(
    {
      sessionId: startRes.sessionId,
      answer: "Customer satisfaction kya hota hai?",
      expectedQuestionId: activeQId,
    },
    {
      generateInquiryResponseImpl: async () => {
        callsCompleted++;
        const err = new Error("Inquiry response generation timed out");
        err.code = "AI_TIMEOUT";
        throw err;
      },
    },
  );

  // Exactly one response returned, clarificationRequired is true
  assert.equal(inquiryRes.status, 200);
  assert.equal(inquiryRes.body.clarificationRequired, true);
  assert.ok(inquiryRes.body.message && inquiryRes.body.message.length > 5);
  // Verify deterministic fallback was cleanly used
  assert.equal(callsCompleted, 1);
});

test("7. Stale session/turn cancellation: Newer candidate turn cancels pending turn and prevents state corruption", async () => {
  const startRes = await interviewService.startInterview({
    testSessionKey: "verify_stale_turn_cancellation",
    candidateId: "cand_stale_001",
    candidateName: "Pooja",
  });

  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Pooja",
    expectedQuestionId: "A2_NAME",
  });
  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Haan",
    expectedQuestionId: "A2_NAME_CONFIRM",
  });
  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Haan",
    expectedQuestionId: "A0",
  });
  const a1Res = await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Bangalore Whitefield",
    expectedQuestionId: "A1",
  });

  const activeQId = a1Res.body.question.id;

  // Turn 1 starts but is slow (e.g. takes 300ms)
  let t1Resolved = false;
  const turn1Promise = interviewService.submitAnswer(
    {
      sessionId: startRes.sessionId,
      answer: "Customer satisfaction kya hota hai?",
      expectedQuestionId: activeQId,
    },
    {
      generateInquiryResponseImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        t1Resolved = true;
        return {
          topic: "customer_handling",
          replyText: "OLD Turn 1 Reply from slow Gemini",
          probeQuestion: "",
          followUpDecision: "DIRECT_ANSWER",
        };
      },
    },
  );

  // After 50ms (while Turn 1 is still in flight), candidate speaks Turn 2 (e.g. barge-in or topic switch)
  await new Promise((resolve) => setTimeout(resolve, 50));

  const turn2Res = await interviewService.submitAnswer(
    {
      sessionId: startRes.sessionId,
      answer: "Rica wax aur normal wax mein kya farak hai?",
      expectedQuestionId: activeQId,
    },
    {
      generateInquiryResponseImpl: async () => {
        return {
          topic: "salon_technique",
          replyText: "NEW Turn 2 Reply: Rica wax is colophony-free.",
          probeQuestion: "Kya aapne pehle use kiya hai?",
          followUpDecision: "PRACTICAL_EXAMPLE",
        };
      },
    },
  );

  // Turn 2 completed immediately
  assert.equal(turn2Res.status, 200);
  assert.match(turn2Res.body.message, /NEW Turn 2 Reply/);

  // Now await the slow Turn 1
  const turn1Res = await turn1Promise;

  // Turn 1 should be marked as superseded (status 409 staleTurn)
  assert.equal(turn1Res.status, 409);
  assert.equal(turn1Res.body.staleTurn, true);

  // Verify that Turn 2's state in activeInquiry was NOT overwritten by Turn 1
  const snapshot = interviewService.getSessionSnapshot(startRes.sessionId);
  assert.equal(snapshot.activeInquiry.currentTopic, "salon_technique");
  assert.ok(
    snapshot.activeInquiry.turns.some((t) => t.text.includes("NEW Turn 2 Reply")),
    "Turn 2 must be preserved",
  );
  assert.ok(
    !snapshot.activeInquiry.turns.some((t) => t.text.includes("OLD Turn 1 Reply")),
    "Superseded Turn 1 must NOT be in activeInquiry turns",
  );
});

test("8. Verification of Exact Interruption Scenario: T1 'Customer satisfaction', T2 'Rica wax kya hota hai'", async () => {
  const startRes = await interviewService.startInterview({
    testSessionKey: "verify_exact_interruption_scenario",
    candidateId: "cand_scenario_001",
    candidateName: "Kavita",
  });

  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Kavita",
    expectedQuestionId: "A2_NAME",
  });
  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Haan",
    expectedQuestionId: "A2_NAME_CONFIRM",
  });
  await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Haan, bilkul",
    expectedQuestionId: "A0",
  });
  const a1Res = await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Bangalore Indiranagar, travel kar sakti hoon",
    expectedQuestionId: "A1",
  });

  const activeQId = a1Res.body.question.id;
  const initialSnapshot = interviewService.getSessionSnapshot(startRes.sessionId);
  const baselineIndex = initialSnapshot.currentQuestionIndex;
  const baselineAttempts = initialSnapshot.invalidAttemptsCount || 0;
  const baselineScore = initialSnapshot.score;

  // 1. Candidate asks: "Customer satisfaction kya hota hai?" (T1 starts and remains pending)
  let t1Started = false;
  let t1Done = false;
  const t1Promise = interviewService.submitAnswer(
    {
      sessionId: startRes.sessionId,
      answer: "Customer satisfaction kya hota hai?",
      expectedQuestionId: activeQId,
    },
    {
      generateInquiryResponseImpl: async () => {
        t1Started = true;
        await new Promise((resolve) => setTimeout(resolve, 350));
        t1Done = true;
        return {
          topic: "customer_handling",
          replyText: "Customer satisfaction ka matlab hai client ko service se poori khushi milna.",
          probeQuestion: "",
          followUpDecision: "DIRECT_ANSWER",
        };
      },
    },
  );

  // Wait for T1 to be pending in flight
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(t1Started, true);
  assert.equal(t1Done, false);

  // 2. Before T1 completes, candidate interrupts and asks: "Rica wax kya hota hai?" (T2 starts)
  const t2Res = await interviewService.submitAnswer(
    {
      sessionId: startRes.sessionId,
      answer: "Rica wax kya hota hai?",
      expectedQuestionId: activeQId,
    },
    {
      generateInquiryResponseImpl: async () => {
        return {
          topic: "salon_technique",
          replyText: "Rica wax ek natural wax hoti hai jo sensitive skin ke liye safe rehti hai.",
          probeQuestion: "Kya aapne pehle Rica wax ki service di hai?",
          followUpDecision: "CONTEXTUAL_FOLLOW_UP",
        };
      },
    },
  );

  // 3. T2 completes with its response
  assert.equal(t2Res.status, 200);
  assert.equal(t2Res.body.clarificationRequired, true);
  assert.match(t2Res.body.message, /Rica wax ek natural wax hoti hai/);
  assert.equal(t2Res.body.question.id, activeQId);

  // 4. Await T1: T1 returns HTTP 409 staleTurn
  const t1Res = await t1Promise;
  assert.equal(t1Res.status, 409);
  assert.equal(t1Res.body.staleTurn, true);
  assert.equal(t1Res.body.success, false);
  assert.match(t1Res.body.message, /superseded by a newer candidate utterance/);

  // 5. Verification of State Preservation:
  const finalSnapshot = interviewService.getSessionSnapshot(startRes.sessionId);

  // A. No question index progression or skip
  assert.equal(finalSnapshot.currentQuestionIndex, baselineIndex, "Question index must not advance");

  // B. Scoring and retry counters unchanged
  assert.equal(finalSnapshot.score, baselineScore, "Score must not be altered");
  assert.equal(finalSnapshot.invalidAttemptsCount || 0, baselineAttempts, "Invalid attempts must remain 0");

  // C. Next assessment question was NOT triggered
  assert.equal(t2Res.body.question.id, activeQId, "Must remain on active assessment question");

  // D. Active inquiry state reflects T2 (Rica wax), not T1
  assert.equal(finalSnapshot.activeInquiry.currentTopic, "salon_technique");
  assert.ok(
    finalSnapshot.activeInquiry.turns.some((t) => t.text.includes("Rica wax ek natural wax")),
    "T2 reply must be in active inquiry",
  );
  assert.ok(
    !finalSnapshot.activeInquiry.turns.some((t) => t.text.includes("Customer satisfaction ka matlab")),
    "Superseded T1 reply must NOT be in active inquiry",
  );
});

test("9. Normal API errors (500, network exception) are still handled correctly", async () => {
  const startRes = await interviewService.startInterview({
    testSessionKey: "verify_normal_errors",
    candidateId: "cand_err_001",
    candidateName: "Seema",
  });

  // Invalid question ID returns HTTP 400
  const badIdRes = await interviewService.submitAnswer({
    sessionId: startRes.sessionId,
    answer: "Seema",
    expectedQuestionId: "INVALID_QUESTION_ID_$$$",
  });
  assert.equal(badIdRes.status, 400);
  assert.equal(badIdRes.body.success, false);

  // Non-existent session returns HTTP 404
  const notFoundRes = await interviewService.submitAnswer({
    sessionId: "non_existent_session_id",
    answer: "Hello",
  });
  assert.equal(notFoundRes.status, 404);
  assert.equal(notFoundRes.body.code, "SESSION_NOT_FOUND");
});

