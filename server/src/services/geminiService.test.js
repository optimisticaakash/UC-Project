const test = require("node:test");
const assert = require("node:assert/strict");
const {
  interpretAnswer,
  fallbackInterpretation,
  INTERPRETATION_REQUEST_OPTIONS,
} = require("./geminiService");

test("Gemini answer interpretation disables automatic retries and has a bounded timeout", () => {
  assert.deepEqual(INTERPRETATION_REQUEST_OPTIONS, {
    retries: { strategy: "none" },
    timeout_ms: 15000,
  });
});

test("Gemini rate limit remains a failed interpretation and never returns fallback success", async () => {
  const rateLimit = Object.assign(new Error("RESOURCE_EXHAUSTED"), {
    name: "RateLimitError",
    status: 429,
  });
  await assert.rejects(
    interpretAnswer({
      question: "How do you handle a customer concern?",
      answer: "I listen calmly and help them.",
      questionId: "B1",
      generateTextImpl: async () => { throw rateLimit; },
    }),
    (error) => error === rateLimit && error.code === "AI_RATE_LIMIT",
  );
});

test("interpretAnswer sends prompt instructing model that bare yes/no on open-ended questions is insufficient", async () => {
  let capturedPrompt = "";
  await interpretAnswer({
    question: "Customer app ke bahar discount maang rahi hai. Kya karengi?",
    answer: "haan",
    questionId: "C6",
    generateTextImpl: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        understanding: "Candidate only said haan to a scenario question.",
        answerStatus: "unclear",
        needsClarification: true,
        clarificationQuestion: "Aap customer ko kya samjhayengi?",
      });
    },
  });

  assert.match(capturedPrompt, /open-ended questions asking for explanations/i);
  assert.match(capturedPrompt, /bare "yes", "no", "haan", or "nahi" is NOT sufficient/i);
  assert.match(capturedPrompt, /gibberish/i);
});

test("fallbackInterpretation rejects bare yes/no on open-ended customer scenarios and technical questions", () => {
  const scenarios = [
    { q: "Customer app ke bahar discount maang rahi hai. Kya karengi?", a: "haan" },
    { q: "Facial mask ke time acne wali customer kehti hai jalan ho rahi hai. Aap kya karengi?", a: "yes" },
    { q: "Pedicure ke baad tools aur baaki saamaan ka kya karti hain?", a: "haan" },
    { q: "Rica jaise lipo wax aur normal honey wax mein kya farak hota hai?", a: "yes" },
    { q: "Aapka beauty ka safar kaise shuru hua? Kahan kahan kaam kiya hai?", a: "haan" },
  ];

  for (const { q, a } of scenarios) {
    const res = fallbackInterpretation({ question: q, answer: a });
    assert.equal(res.needsClarification, true, `Question "${q}" should require clarification on bare answer "${a}"`);
    assert.equal(res.answerStatus, "unclear");
  }

  // Confirmation questions MUST accept bare yes/no
  const confirmations = [
    { q: "Kya kabhi pehle UC, Yes Madam ya kisi aur app ke through kaam kiya hai?", a: "Haan" },
    { q: "Kya aap poori training attend kar sakti hain?", a: "Nahi" },
    { q: "Kya aapka PAN, Aadhaar se linked hai aur dono mein naam same hai?", a: "Haan" },
  ];

  for (const { q, a } of confirmations) {
    const res = fallbackInterpretation({ question: q, answer: a });
    assert.equal(res.needsClarification, false, `Confirmation question "${q}" should accept "${a}"`);
    assert.equal(res.answerStatus, "sufficient");
  }
});

test("fallbackInterpretation recognizes counter-questions regarding travel, terms, and salary", () => {
  const travelCq = fallbackInterpretation({
    question: "Aap Bangalore mein kis area mein rehti hain?",
    answer: "Where would I need to travel?",
  });
  assert.equal(travelCq.answerStatus, "counter_question");
  assert.equal(travelCq.needsClarification, true);
  assert.match(travelCq.counterQuestionAnswer, /3-4 km cluster/i);

  const termCq = fallbackInterpretation({
    question: "Facial mask ke time acne wali customer kehti hai jalan ho rahi hai. Aap kya karengi?",
    answer: "What do you mean by customer handling?",
  });
  assert.equal(termCq.answerStatus, "counter_question");
  assert.equal(termCq.needsClarification, true);
  assert.match(termCq.counterQuestionAnswer, /politely/i);

  const salaryCq = fallbackInterpretation({
    question: "Pichli job mein ek din mein kitne ghante kaam hota tha?",
    answer: "Salary kitni milegi?",
  });
  assert.equal(salaryCq.answerStatus, "counter_question");
  assert.equal(salaryCq.needsClarification, true);
  assert.match(salaryCq.counterQuestionAnswer, /partner team/i);
});

test("fallbackInterpretation recognizes partial answers and provides relevant follow-up questions", () => {
  const customerPartial = fallbackInterpretation({
    question: "Facial mask ke time acne wali customer kehti hai jalan ho rahi hai. Aap kya karengi?",
    answer: "I would talk to her.",
  });
  assert.equal(customerPartial.answerStatus, "partial");
  assert.equal(customerPartial.needsClarification, true);
  assert.match(customerPartial.clarificationQuestion, /customer was still unhappy/i);

  const expPartial = fallbackInterpretation({
    question: "Pichli jagah aap sabse zyada kaun si services karti thi?",
    answer: "Yes, I have experience.",
  });
  assert.equal(expPartial.answerStatus, "partial");
  assert.equal(expPartial.needsClarification, true);
  assert.match(expPartial.clarificationQuestion, /which salon services/i);
});

test("fallbackInterpretation accepts detailed answers as sufficient without follow-up", () => {
  const detailed = fallbackInterpretation({
    question: "Customer app ke bahar discount maang rahi hai. Aap kya karengi?",
    answer: "I will politely explain to the client that app rates are fixed and I cannot offer outside discounts.",
  });
  assert.equal(detailed.answerStatus, "sufficient");
  assert.equal(detailed.needsClarification, false);
});

test("Candidate asking question purpose ('Aap mujhse ye question kyun pooch rahe ho?') receives relevant grounded explanation", () => {
  const purposeHindi = fallbackInterpretation({
    question: "Aapka beauty ka safar kaise shuru hua? Kahan kahan kaam kiya hai?",
    answer: "Aap mujhse ye question kyun pooch rahe ho?",
    language: "Hindi",
  });
  assert.equal(purposeHindi.intent, "RELEVANT_COUNTER_QUESTION");
  assert.equal(purposeHindi.answerStatus, "counter_question");
  assert.equal(purposeHindi.needsClarification, true);
  assert.match(purposeHindi.counterQuestionAnswer, /experience|skills|preferences|bookings/i);

  const purposeEnglish = fallbackInterpretation({
    question: "How did your journey in beauty begin?",
    answer: "Why are you asking this question?",
    language: "English",
  });
  assert.equal(purposeEnglish.intent, "RELEVANT_COUNTER_QUESTION");
  assert.match(purposeEnglish.counterQuestionAnswer, /understand your experience/i);
});

test("Clarification requests ('Iska matlab kya hai?', 'Aap thoda explain kar sakte ho?') return CLARIFICATION_REQUEST without warning", () => {
  const clar1 = fallbackInterpretation({
    question: "Rica jaise lipo wax aur normal honey wax mein kya farak hota hai?",
    answer: "Iska matlab kya hai?",
    language: "Hindi",
  });
  assert.equal(clar1.intent, "CLARIFICATION_REQUEST");
  assert.equal(clar1.answerStatus, "counter_question");
  assert.equal(clar1.needsClarification, true);

  const clar2 = fallbackInterpretation({
    question: "Facial mask ke time acne wali customer kehti hai jalan ho rahi hai. Aap kya karengi?",
    answer: "Aap thoda explain kar sakte ho?",
    language: "Hindi",
  });
  assert.equal(clar2.intent, "CLARIFICATION_REQUEST");
  assert.equal(clar2.needsClarification, true);
});

test("Candidate inquiries about salary, training, travel, and complaints return RELEVANT_COUNTER_QUESTION with grounded info", () => {
  const salary = fallbackInterpretation({
    question: "Pichli jagah aap sabse zyada kaun si services karti thi?",
    answer: "Salary kitni milegi?",
  });
  assert.equal(salary.intent, "RELEVANT_COUNTER_QUESTION");
  assert.match(salary.counterQuestionAnswer, /partner team/i);

  const training = fallbackInterpretation({
    question: "Rica wax karte waqt skin prep kaise karti hain?",
    answer: "Training milegi kya?",
  });
  assert.equal(training.intent, "RELEVANT_COUNTER_QUESTION");
  assert.match(training.counterQuestionAnswer, /training/i);

  const travel = fallbackInterpretation({
    question: "Aap Bangalore mein kis area mein rehti hain?",
    answer: "Mujhe kitni door travel karna hoga?",
  });
  assert.equal(travel.intent, "RELEVANT_COUNTER_QUESTION");
  assert.match(travel.counterQuestionAnswer, /3-4 km/i);

  const complaint = fallbackInterpretation({
    question: "Facial mask ke time acne wali customer kehti hai jalan ho rahi hai. Aap kya karengi?",
    answer: "Agar customer complain kare toh kya karna hoga?",
  });
  assert.equal(complaint.intent, "RELEVANT_COUNTER_QUESTION");
  assert.match(complaint.counterQuestionAnswer, /partner support|personally/i);
});

test("Short but relevant answers ('Do saal', 'Waxing', 'Bike se') are recognized as valid INTERVIEW_ANSWER", () => {
  const expShort = fallbackInterpretation({
    question: "Aapko salon mein kitne saal ka anubhav hai?",
    answer: "Do saal",
  });
  assert.equal(expShort.intent, "INTERVIEW_ANSWER");
  assert.equal(expShort.answerStatus, "sufficient");
  assert.equal(expShort.needsClarification, false);

  const serviceShort = fallbackInterpretation({
    question: "Waxing aur facial mein se kya zyada karti hain?",
    answer: "Waxing",
  });
  assert.equal(serviceShort.intent, "INTERVIEW_ANSWER");
  assert.equal(serviceShort.answerStatus, "sufficient");
  assert.equal(serviceShort.needsClarification, false);

  const travelShort = fallbackInterpretation({
    question: "Kaam par aane ke liye travel kaise karti hain?",
    answer: "Bike se",
  });
  assert.equal(travelShort.intent, "INTERVIEW_ANSWER");
  assert.equal(travelShort.answerStatus, "sufficient");
  assert.equal(travelShort.needsClarification, false);
});

test("Genuinely meaningless/unrelated answers are classified as IRRELEVANT_OR_NONRESPONSIVE", () => {
  const pizza = fallbackInterpretation({
    question: "Rica jaise lipo wax aur normal honey wax mein kya farak hota hai?",
    answer: "pizza pizza pizza",
  });
  assert.equal(pizza.intent, "IRRELEVANT_OR_NONRESPONSIVE");
  assert.equal(pizza.answerStatus, "irrelevant");
  assert.equal(pizza.needsClarification, true);

  const gibberish = fallbackInterpretation({
    question: "Customer app ke bahar discount maang rahi hai. Aap kya karengi?",
    answer: "habba jabba bla bla asdf",
  });
  assert.equal(gibberish.intent, "IRRELEVANT_OR_NONRESPONSIVE");
  assert.equal(gibberish.answerStatus, "irrelevant");
});

test("Empty or unintelligible utterances return UNINTELLIGIBLE_OR_NO_INPUT without irrelevant flag", () => {
  for (const empty of ["", "   ", "uh...", "noise", "<no speech>"]) {
    const res = fallbackInterpretation({
      question: "Pichli jagah aap sabse zyada kaun si services karti thi?",
      answer: empty,
    });
    assert.equal(res.intent, "UNINTELLIGIBLE_OR_NO_INPUT");
    assert.notEqual(res.intent, "IRRELEVANT_OR_NONRESPONSIVE");
    assert.equal(res.answerStatus, "unclear");
    assert.match(res.responseText, /repeat|dobara/i);
  }
});

test("interpretAnswer safety guard prevents false-positive irrelevant flags for counter-questions and short answers", async () => {
  // Model hallucinated IRRELEVANT_OR_NONRESPONSIVE for "Salary kitni milegi?"
  const resSalary = await interpretAnswer({
    question: "Aapko salon mein kitne saal ka anubhav hai?",
    answer: "Salary kitni milegi?",
    questionId: "B1",
    generateTextImpl: async () => JSON.stringify({
      intent: "IRRELEVANT_OR_NONRESPONSIVE",
      confidence: 0.9,
      understanding: "Candidate asked about salary instead of answering.",
      answerStatus: "irrelevant",
      needsClarification: true,
      responseText: "Answer the question directly.",
    }),
  });
  assert.equal(resSalary.intent, "RELEVANT_COUNTER_QUESTION", "Safety guard must protect salary inquiry");
  assert.equal(resSalary.answerStatus, "counter_question");
  assert.match(resSalary.responseText, /partner team/i);

  // Model hallucinated IRRELEVANT_OR_NONRESPONSIVE for short answer "2 saal"
  const resShort = await interpretAnswer({
    question: "Aapko salon mein kitne saal ka anubhav hai?",
    answer: "2 saal",
    questionId: "B1",
    generateTextImpl: async () => JSON.stringify({
      intent: "IRRELEVANT_OR_NONRESPONSIVE",
      confidence: 0.9,
      understanding: "Too short.",
      answerStatus: "irrelevant",
      needsClarification: true,
      responseText: "Please give more details.",
    }),
  });
  assert.equal(resShort.intent, "INTERVIEW_ANSWER", "Safety guard must protect valid short answer");
  assert.equal(resShort.answerStatus, "sufficient");
  assert.equal(resShort.needsClarification, false);
});


