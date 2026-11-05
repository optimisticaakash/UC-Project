const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  startInterview,
  submitAnswer,
  getSessionForPersistence,
} = require("./interview");

const {
  isQuotaExhaustedError,
  markQuotaExhausted,
  isQuotaExhausted,
  resetQuotaExhaustion,
} = require("./geminiService");

function createRateLimitError(msg = "429 Rate limit exceeded: 20 requests per day on Free Tier") {
  const err = new Error(msg);
  err.name = "RateLimitError";
  err.status = 429;
  err.statusCode = 429;
  err.code = "AI_RATE_LIMIT";
  return err;
}

test("Quota Exhaustion 1: isQuotaExhaustedError correctly identifies 429, RateLimitError, and RESOURCE_EXHAUSTED", () => {
  assert.equal(isQuotaExhaustedError(createRateLimitError()), true);
  assert.equal(isQuotaExhaustedError({ name: "RateLimitError" }), true);
  assert.equal(isQuotaExhaustedError({ status: 429 }), true);
  assert.equal(isQuotaExhaustedError({ statusCode: 429 }), true);
  assert.equal(isQuotaExhaustedError({ code: "AI_RATE_LIMIT" }), true);
  assert.equal(isQuotaExhaustedError(new Error("RESOURCE_EXHAUSTED: quota exceeded")), true);
  assert.equal(isQuotaExhaustedError(new Error("Quota limit exceeded for Free Tier")), true);

  // Non-quota errors must NOT be classified as quota exhausted
  assert.equal(isQuotaExhaustedError(new Error("Network timeout")), false);
  assert.equal(isQuotaExhaustedError({ status: 503, message: "Service Unavailable" }), false);
  assert.equal(isQuotaExhaustedError(null), false);
  assert.equal(isQuotaExhaustedError(undefined), false);
});

test("Quota Exhaustion 2: Candidate inquiry during assessment preserves question, score, index, and does not return misleading salon answer", async () => {
  resetQuotaExhaustion();

  const started = startInterview({ candidateName: "Pooja" });
  const sId = started.sessionId;

  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Pooja Sharma" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan sahi hai" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A0", answer: "Ji haan, main taiyaar hoon" });

  const sessionBefore = getSessionForPersistence(sId);
  const qIndexBefore = sessionBefore.currentQuestionIndex;
  const activeQuestionId = sessionBefore.currentQuestionId || "A1";

  // Candidate asks substantive question "Rica wax kya hota hai?" while Gemini returns HTTP 429
  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: activeQuestionId,
    answer: "Rica wax kya hota hai?",
  }, {
    interpretAnswerImpl: async () => {
      throw createRateLimitError();
    },
    generateInquiryResponseImpl: async () => {
      throw createRateLimitError();
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.quotaExhausted, true);
  assert.equal(res.body.code, "AI_RATE_LIMIT");
  assert.equal(res.body.clarificationRequired, true);

  // Must NOT classify as successfully answered
  assert.notEqual(res.body.counterQuestionHandled, true);

  // Must NOT return generic salon answer
  assert.equal(
    res.body.message.includes("Professional salon service mein achhi samajh aur practical anubhav bahut madadgar hota hai"),
    false,
    "Must NOT return generic misleading salon answer"
  );

  // Must return the exact natural Hindi message
  assert.equal(
    res.body.message,
    "Maaf kijiye, abhi mujhe jawab dene mein technical dikkat aa rahi hai. Aapka interview question safe hai. Hum thodi der baad dobara koshish kar sakte hain."
  );

  // Pending assessment question must be strictly preserved
  assert.equal(res.body.question.id, activeQuestionId);

  const sessionAfter = getSessionForPersistence(sId);
  assert.equal(sessionAfter.currentQuestionIndex, qIndexBefore, "Question index must not advance");
  assert.deepEqual(sessionAfter.invalidAttempts || {}, {}, "invalidAttempts must remain unchanged");
  assert.equal(sessionAfter.activeInquiry, null, "activeInquiry must NOT be created on quota failure");

  resetQuotaExhaustion();
});

test("Quota Exhaustion 3: English session returns natural English message and preserves state", async () => {
  resetQuotaExhaustion();

  const started = startInterview({ candidateName: "Pooja" });
  const sId = started.sessionId;

  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Pooja Sharma" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Yes" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A0", answer: "Yes I am ready, in English" });

  const sessionBefore = getSessionForPersistence(sId);
  assert.equal(sessionBefore.language, "English");

  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "What is Rica wax?",
  }, {
    interpretAnswerImpl: async () => {
      throw createRateLimitError();
    },
    generateInquiryResponseImpl: async () => {
      throw createRateLimitError();
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.quotaExhausted, true);
  assert.equal(res.body.code, "AI_RATE_LIMIT");
  assert.equal(
    res.body.message,
    "I'm sorry, I am currently facing a technical issue with answering. Your interview question is safe. We can try again in a little while."
  );
  assert.equal(res.body.question.id, "A1");

  resetQuotaExhaustion();
});

test("Quota Exhaustion 4: Different questions do not get generic salon responses", async () => {
  resetQuotaExhaustion();

  const questionsToTest = [
    "Customer satisfaction kya hota hai?",
    "Rica wax kya hota hai?",
    "Agar customer service se khush na ho toh kya karna chahiye?",
    "Cloud computing kya hoti hai?",
  ];

  for (const q of questionsToTest) {
    const started = startInterview({ candidateName: "Geeta" });
    const sId = started.sessionId;

    await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Geeta" });
    await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });
    await submitAnswer({ sessionId: sId, expectedQuestionId: "A0", answer: "Haan" });

    const res = await submitAnswer({
      sessionId: sId,
      expectedQuestionId: "A1",
      answer: q,
    }, {
      interpretAnswerImpl: async () => {
        throw createRateLimitError();
      },
      generateInquiryResponseImpl: async () => {
        throw createRateLimitError();
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.quotaExhausted, true);
    assert.notEqual(res.body.counterQuestionHandled, true);
    assert.equal(
      res.body.message.includes("Professional salon service mein achhi samajh aur practical anubhav bahut madadgar hota hai"),
      false,
      `Question "${q}" must NOT receive generic salon fallback`
    );
    assert.match(res.body.message, /technical dikkat|safe/i);
    assert.equal(res.body.question.id, "A1");
  }

  resetQuotaExhaustion();
});

test("Quota Exhaustion 5: Circuit-breaker blocks repeated requests and recovers after resetQuotaExhaustion", async () => {
  resetQuotaExhaustion();
  assert.equal(isQuotaExhausted(), false);

  // Manually trip the circuit breaker
  markQuotaExhausted(5000);
  assert.equal(isQuotaExhausted(), true);

  // Reset circuit breaker
  resetQuotaExhaustion();
  assert.equal(isQuotaExhausted(), false);

  // Verify normal operation recovers after quota becomes available
  const started = startInterview({ candidateName: "Reena" });
  const sId = started.sessionId;

  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Reena" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A0", answer: "Haan" });

  // Normal Gemini interpretation succeeds
  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Main Bangalore mein 5 saal se rehti hoon aur aana-jaana aasaani se kar sakti hoon",
  }, {
    interpretAnswerImpl: async () => ({
      intent: "INTERVIEW_ANSWER",
      unifiedIntent: "ASSESSMENT_ANSWER",
      answerStatus: "sufficient",
      confidence: 0.95,
      extractedFacts: { location: "Bangalore", willingToTravel: true },
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(Boolean(res.body.quotaExhausted), false);

  resetQuotaExhaustion();
});

test("Quota Exhaustion 6: Operator diagnostic warning is emitted when quota is exhausted", async () => {
  resetQuotaExhaustion();

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args);
    origWarn(...args);
  };

  try {
    const started = startInterview({ candidateName: "Pooja" });
    const sId = started.sessionId;
    await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
    await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });
    await submitAnswer({ sessionId: sId, expectedQuestionId: "A0", answer: "Haan" });

    await submitAnswer({
      sessionId: sId,
      expectedQuestionId: "A1",
      answer: "Waxing kaunsi achhi hoti hai?",
    }, {
      interpretAnswerImpl: async () => {
        throw createRateLimitError();
      },
    });

    const emittedExhaustedWarn = warnings.some(
      (args) => typeof args[0] === "string" && args[0].includes("GEMINI_FREE_TIER_QUOTA_EXHAUSTED")
    );
    assert.equal(emittedExhaustedWarn, true, "Must log GEMINI_FREE_TIER_QUOTA_EXHAUSTED diagnostic");
  } finally {
    console.warn = origWarn;
    resetQuotaExhaustion();
  }
});
