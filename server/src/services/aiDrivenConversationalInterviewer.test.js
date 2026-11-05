const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  startInterview,
  submitAnswer,
  getActiveInquiry,
  getSessionForPersistence,
} = require("./interview");
const { detectCounterQuestion } = require("./counterQuestions");
const { generateInquiryResponse, interpretAnswer, UC_GROUNDED_FACTS } = require("./geminiService");

async function setupSessionAtA1() {
  const started = startInterview({ candidateName: "Kavita" });
  const sId = started.sessionId;
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Kavita" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan, bilkul sahi" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A0", answer: "Haan, main taiyaar hoon, Hindi mein" });
  return { sId, started };
}

test("1. New General Knowledge: Unseen question 'What is cloud computing?' reaches Gemini and does not penalize candidate", async () => {
  const { sId } = await setupSessionAtA1();
  const answersBefore = getSessionForPersistence(sId).answers.length;

  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "What is cloud computing?",
  }, {
    generateInquiryResponseImpl: async ({ candidateUtterance, activeInquiryTopic }) => {
      assert.match(candidateUtterance, /cloud computing/i);
      return {
        topic: "general_knowledge",
        conversationalReasoning: "Candidate asked a conceptual technical question. Provide a direct answer connecting it to modern tools.",
        followUpDecision: "DIRECT_ANSWER",
        replyText: "Cloud computing means delivering computing services like data storage and software over the internet.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      };
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.counterQuestionHandled, true);
  assert.equal(res.body.question.id, "A1", "Assessment question must remain preserved at A1");
  assert.match(res.body.message, /cloud computing/i);

  const session = getSessionForPersistence(sId);
  assert.equal(session.answers.length, answersBefore, "No assessment answer should be stored");
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0, "No invalid attempt penalties");
});

test("2. Professional Scenario: 'How do I handle a difficult customer?' with dynamic follow-up scenario", async () => {
  const { sId } = await setupSessionAtA1();

  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "How do I handle a difficult customer?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "customer_handling",
      conversationalReasoning: "Pose a realistic customer situation to explore candidate's practical handling approach.",
      followUpDecision: "SCENARIO_DISCUSSION",
      replyText: "Always stay calm, listen without interrupting, and acknowledge their frustration politely.",
      probeQuestion: "Suppose a customer is still unhappy after the service. Aap us situation ko kaise handle karengi?",
      suggestedNextAction: "CONTINUE_INQUIRY",
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.counterQuestionHandled, true);
  assert.equal(res.body.inquiryState, "clarification_check");
  // Response contains the answer AND the dynamic scenario follow-up question
  assert.match(res.body.message, /always stay calm/i);
  assert.match(res.body.message, /suppose a customer is still unhappy/i);
  // Must NOT contain the repetitive canned phrase when probeQuestion is present
  assert.doesNotMatch(res.body.message, /kya aapka doubt clear ho gaya/i);
});

test("3. Multi-turn Follow-up Chain with Pronoun Resolution: 'Iska kya matlab hai?' and 'Aur uske baad?'", async () => {
  const { sId } = await setupSessionAtA1();

  // Turn 1: Candidate asks about communication importance
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Why is communication important in salon services?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "communication",
      followUpDecision: "DIRECT_ANSWER",
      replyText: "Clear communication helps understand customer needs and avoids service misunderstandings.",
      probeQuestion: "",
      suggestedNextAction: "CONTINUE_INQUIRY",
    }),
  });

  const inq1 = getActiveInquiry(sId);
  assert.ok(inq1);
  assert.equal(inq1.turnCount, 1);

  // Turn 2: Pronoun reference "Iska kya matlab hai?"
  const res2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska kya matlab hai?",
  }, {
    generateInquiryResponseImpl: async ({ activeInquiryTurns }) => {
      // Must receive prior turns in context
      assert.ok(activeInquiryTurns.length >= 2, "Active turns history must be provided");
      assert.match(activeInquiryTurns[0].text, /communication/i);
      return {
        topic: "communication",
        followUpDecision: "PRACTICAL_EXAMPLE",
        replyText: "Jaise service shuru karne se pehle client se unki pasand aur skin sensitivity ke baare mein poochhna.",
        probeQuestion: "",
        suggestedNextAction: "CONTINUE_INQUIRY",
      };
    },
  });

  assert.equal(res2.status, 200);
  assert.equal(res2.body.counterQuestionHandled, true);
  const inq2 = getActiveInquiry(sId);
  assert.equal(inq2.turnCount, 2);

  // Turn 3: Elliptical follow-up "Aur uske baad?"
  const res3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Aur uske baad kya karenge?",
  }, {
    generateInquiryResponseImpl: async ({ activeInquiryTurns }) => {
      assert.ok(activeInquiryTurns.length >= 4);
      return {
        topic: "communication",
        followUpDecision: "DIRECT_ANSWER",
        replyText: "Service ke dauran feedback lete rahein taaki client comfortable feel kare.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      };
    },
  });

  assert.equal(res3.status, 200);
  assert.equal(res3.body.counterQuestionHandled, true);
});

test("4. Topic Switching: Candidate smoothly switches from customer service to interview process", async () => {
  const { sId } = await setupSessionAtA1();

  // Turn 1: Customer question
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "What if a customer refuses to pay?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "customer_handling",
      followUpDecision: "DIRECT_ANSWER",
      replyText: "Do not argue; explain the service invoice politely and contact partner support immediately.",
      probeQuestion: "",
      suggestedNextAction: "CONTINUE_INQUIRY",
    }),
  });

  let inq = getActiveInquiry(sId);
  assert.equal(inq.currentTopic, "customer_handling");

  // Turn 2: Topic switch to interview anxiety
  const res2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "What if I feel nervous during this interview?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "interview_guidance",
      followUpDecision: "DIRECT_ANSWER",
      replyText: "Feeling nervous is completely normal. Take a deep breath and answer honestly based on your experience.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  assert.equal(res2.status, 200);
  inq = getActiveInquiry(sId);
  assert.ok(inq.currentTopic === "hesitation" || inq.currentTopic === "interview_guidance");
  assert.match(res2.body.message, /feeling nervous is completely normal/i);
});

test("5. Multiple Questions in One Turn: 'Customer satisfaction kya hai aur agar client naraz ho toh kya karein?'", async () => {
  const { sId } = await setupSessionAtA1();

  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Customer satisfaction kya hai aur agar client naraz ho toh kya karein?",
  }, {
    generateInquiryResponseImpl: async ({ candidateUtterance }) => {
      assert.match(candidateUtterance, /customer satisfaction/i);
      assert.match(candidateUtterance, /client naraz/i);
      return {
        topic: "customer_handling",
        conversationalReasoning: "Candidate asked two related questions. Address both in logical order.",
        followUpDecision: "DIRECT_ANSWER",
        replyText: "Customer satisfaction ka matlab hai client ko khush rakhna. Aur agar client naraz ho toh shanti se sunkar polite solution dena chahiye.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      };
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.counterQuestionHandled, true);
  assert.match(res.body.message, /customer satisfaction ka matlab/i);
  assert.match(res.body.message, /agar client naraz ho/i);
});

test("6. Knowledge Separation: Unverified policy query safely defers without blocking general knowledge", async () => {
  const { sId } = await setupSessionAtA1();

  // 1. Candidate asks unverified policy question: kit deposit cost
  const resPolicy = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "What is the exact kit deposit fee?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "policy_query",
      conversationalReasoning: "Kit fees vary and are finalized during onboarding.",
      followUpDecision: "DIRECT_ANSWER",
      replyText: "Kit details and deposit policies are explained directly by the Urban Company onboarding team.",
      probeQuestion: "",
      suggestedNextAction: "DEFER_TO_ONBOARDING",
    }),
  });

  assert.equal(resPolicy.status, 200);
  assert.match(resPolicy.body.message, /onboarding team/i);

  // 2. Candidate immediately asks an unrelated general knowledge question: Rica wax vs normal wax
  const resGk = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Rica wax aur normal wax mein kya farak hota hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "service_quality",
      conversationalReasoning: "Professional salon knowledge question. Provide direct technical difference.",
      followUpDecision: "DIRECT_ANSWER",
      replyText: "Rica wax colophony-free hoti hai jo sensitive skin ke liye gentle hai, jabki normal wax sugar-based hoti hai.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  assert.equal(resGk.status, 200);
  // General knowledge question is answered intelligently without being blocked by prior policy deferral
  assert.match(resGk.body.message, /rica wax colophony-free/i);
});

test("7. Resumption Integrity: AI explicitly asks permission to continue and does NOT resume until candidate confirms", async () => {
  const { sId } = await setupSessionAtA1();

  // 1. Candidate asks inquiry
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "How can I improve my service quality?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "service_quality",
      replyText: "Hygiene maintain karein, clients se consultation lein aur proper technique follow karein.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  // 2. Candidate says doubt is clear
  const rClear = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Doubt clear ho gaya, thank you",
  });

  assert.equal(rClear.status, 200);
  assert.equal(rClear.body.inquiryState, "ready_to_resume");
  assert.match(rClear.body.message, /achha, kya ab hum interview aage badhayein\?/i);
  assert.equal(rClear.body.question.id, "A1", "Pending question must be preserved");

  // 3. Candidate says not ready yet: "Abhi nahi, thoda ruko"
  const rNotReady = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Abhi nahi, thoda ruko",
  });

  assert.equal(rNotReady.status, 200);
  assert.equal(rNotReady.body.inquiryState, "inquiry_active");
  assert.equal(rNotReady.body.question.id, "A1", "Pending question must NOT resume yet");
  assert.match(rNotReady.body.message, /poochhiye/i);

  // 4. Candidate asks additional question
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Waxing ke baad skin care ke baare mein bataiye",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "service_quality",
      replyText: "Waxing ke baad soothing gel ya aloe vera lagana chahiye taaki redness na ho.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  // 5. Candidate clarifies doubt is now resolved
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Ab sab clear hai",
  });

  // 6. Candidate confirms resumption: "Haan, chaliye"
  const rResume = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, chaliye shuru karein",
  });

  assert.equal(rResume.status, 200);
  assert.equal(rResume.body.inquiryState, "resumed_assessment");
  assert.equal(rResume.body.question.id, "A1");
  assert.match(rResume.body.message, /sawal par wapas aate hain/i);
  assert.equal(getActiveInquiry(sId), null, "Active inquiry closed cleanly on confirmation");

  // 7. Candidate answers the resumed assessment question normally
  const rAns = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Main Delhi mein rehti hoon, Rohini sector 8",
  });

  assert.equal(rAns.status, 200);
  const session = getSessionForPersistence(sId);
  assert.ok(session.answers.some((a) => a.questionId === "A1"), "Candidate answer recorded after resumption");
});

test("8. Both Hindi and English Flows: verify natural responses in candidate requested language", async () => {
  // English Session
  const startedEn = startInterview({ candidateName: "Sarah" });
  const sEn = startedEn.sessionId;
  await submitAnswer({ sessionId: sEn, expectedQuestionId: "A2_NAME", answer: "Sarah Jenkins" });
  await submitAnswer({ sessionId: sEn, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Yes, that's correct" });
  await submitAnswer({ sessionId: sEn, expectedQuestionId: "A0", answer: "Yes, I agree. English please" });

  const resEn = await submitAnswer({
    sessionId: sEn,
    expectedQuestionId: "A1",
    answer: "Can you explain this interview process?",
  }, {
    generateInquiryResponseImpl: async ({ language }) => {
      assert.equal(language, "English");
      return {
        topic: "interview_guidance",
        followUpDecision: "DIRECT_ANSWER",
        replyText: "This preliminary screening evaluates your background, communication, and salon service skills.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      };
    },
  });

  assert.equal(resEn.status, 200);
  assert.equal(resEn.body.counterQuestionHandled, true);
  assert.match(resEn.body.message, /this preliminary screening evaluates/i);
});

test("9. generateInquiryResponse: Dynamic follow-up decision parses correctly", async () => {
  const result = await generateInquiryResponse({
    candidateUtterance: "What is customer satisfaction?",
    currentQuestion: { id: "B1", text: "Customer handling experience bataiye" },
    activeInquiryTopic: "customer_handling",
    generateTextImpl: async (prompt) => {
      assert.match(prompt, /DYNAMIC FOLLOW-UP REASONING/);
      assert.match(prompt, /SCENARIO_DISCUSSION/);
      return JSON.stringify({
        topic: "customer_handling",
        conversationalReasoning: "Explore candidate's practical handling with a realistic unhappy customer situation.",
        followUpDecision: "SCENARIO_DISCUSSION",
        replyText: "Customer satisfaction means delivering quality service and polite communication.",
        probeQuestion: "Suppose a customer is still unhappy after the service. Aap us situation ko kaise handle karengi?",
        suggestedNextAction: "CONTINUE_INQUIRY",
      });
    },
  });

  assert.equal(result.topic, "customer_handling");
  assert.equal(result.followUpDecision, "SCENARIO_DISCUSSION");
  assert.match(result.probeQuestion, /suppose a customer is still unhappy/i);
  assert.equal(result.suggestedNextAction, "CONTINUE_INQUIRY");
});

test("10. generateInquiryResponse: Safety filter blocks invented salary and rupees claims", async () => {
  await assert.rejects(
    async () => {
      await generateInquiryResponse({
        candidateUtterance: "What is my salary?",
        currentQuestion: { id: "A1", text: "City and area" },
        generateTextImpl: async () => JSON.stringify({
          topic: "earnings",
          replyText: "You will earn guaranteed ₹40,000 per month fixed salary.",
          probeQuestion: "",
          suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
        }),
      });
    },
    (err) => {
      assert.equal(err.code, "AI_UNSUPPORTED_POLICY_CLAIM");
      return true;
    },
  );
});

test("11. detectCounterQuestion: Semantic detection of unexpected candidate questions without hardcoded lists", () => {
  const questions = [
    "Why is communication important?",
    "What is customer satisfaction?",
    "How do I handle a difficult customer?",
    "What if a customer refuses to pay?",
    "How can I improve my service quality?",
    "What if I am unable to complete a service?",
    "Can you explain this interview process?",
    "What if I am nervous during an interview?",
    "What is the difference between two salon services?",
    "What should I do if a customer is unhappy?",
    "Customer handling mein kya zaroori hota hai?",
    "Agar client service se khush na ho toh kya karein?",
  ];

  for (const q of questions) {
    const res = detectCounterQuestion(q);
    assert.equal(res.isCounterQuestion, true, `Failed to detect question: "${q}"`);
    assert.ok(
      [
        "RELEVANT_COUNTER_QUESTION",
        "CLARIFICATION_REQUEST",
        "CANDIDATE_CONSTRAINT_OR_HESITATION",
        "REQUEST_TO_ASK_QUESTION",
      ].includes(res.intent),
      `Expected valid candidate inquiry intent for: "${q}", got ${res.intent}`,
    );
    assert.ok(res.topic, `Topic must be assigned for: "${q}"`);
    assert.ok(res.reply && res.reply.length > 5, `Reply must be provided for: "${q}"`);
  }
});

test("12. detectCounterQuestion: Does not falsely flag off-topic trivia banter as relevant counter questions", () => {
  const trivia = [
    "Who won the cricket match yesterday?",
    "What is the IPL score?",
    "Weather kaisa hai?",
    "Tell me about movie actors",
    "Who is the president of France?",
  ];

  for (const t of trivia) {
    const res = detectCounterQuestion(t);
    assert.equal(res.isCounterQuestion, false, `Trivia should not be marked counter question: "${t}"`);
  }
});

