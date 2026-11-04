const test = require("node:test");
const assert = require("node:assert/strict");
const {
  interpretAnswer,
  fallbackInterpretation,
  INTERPRETATION_REQUEST_OPTIONS,
  generateInquiryResponse,
  isUnsupportedPolicyClaim,
  UC_GROUNDED_FACTS,
  ALLOWED_NEXT_ACTIONS,
  INQUIRY_TIMEOUT_MS,
  UNIFIED_INTENTS,
  normalizeIntent,
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
  assert.match(travelCq.counterQuestionAnswer, /nearby local areas|local area|customer homes/i);

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
  assert.match(travel.counterQuestionAnswer, /local area|customer ke ghar|onboarding team/i);

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

test("Phase 1: fallbackInterpretation rejects arbitrary 3+ word answers lacking question context", () => {
  const irrelevant3Word = [
    { q: "Facial mask ke time acne wali customer kehti hai jalan ho rahi hai. Aap kya karengi?", a: "cricket match dekhna" },
    { q: "Rica wax karte waqt skin prep kaise karti hain?", a: "aaj mausam achha" },
    { q: "Customer app ke bahar discount maang rahi hai. Aap kya karengi?", a: "weather is nice" },
  ];

  for (const { q, a } of irrelevant3Word) {
    const res = fallbackInterpretation({ question: q, answer: a });
    assert.notEqual(res.answerStatus, "sufficient", `Answer "${a}" should not be marked sufficient`);
    assert.equal(res.needsClarification, true, `Answer "${a}" should require clarification`);
  }
});

test("Phase 1: Safety Guard 3 does NOT allow generic words like 'family', 'ghar', 'customer', 'ready' in irrelevant sentences to bypass IRRELEVANT_OR_NONRESPONSIVE", async () => {
  // Candidate mentions 'family' or 'ghar' in an irrelevant sentence about watching cricket or eating pizza
  const resFamily = await interpretAnswer({
    question: "Facial mask ke time acne wali customer kehti hai jalan ho rahi hai. Aap kya karengi?",
    answer: "meri family cricket match dekh rahi hai",
    questionId: "C1",
    generateTextImpl: async () => JSON.stringify({
      intent: "IRRELEVANT_OR_NONRESPONSIVE",
      confidence: 0.9,
      understanding: "Candidate is talking about family watching cricket.",
      answerStatus: "irrelevant",
      needsClarification: true,
      responseText: "Kripya sawal ka seedha jawab dein.",
    }),
  });

  assert.equal(resFamily.intent, "IRRELEVANT_OR_NONRESPONSIVE", "Safety guard 3 must not convert family cricket talk into a sufficient answer");
  assert.equal(resFamily.answerStatus, "irrelevant");
  assert.equal(resFamily.needsClarification, true);

  const resGhar = await interpretAnswer({
    question: "Rica jaise lipo wax aur normal honey wax mein kya farak hota hai?",
    answer: "ghar par pizza khaya tha",
    questionId: "D2",
    generateTextImpl: async () => JSON.stringify({
      intent: "IRRELEVANT_OR_NONRESPONSIVE",
      confidence: 0.9,
      understanding: "Candidate talks about eating pizza at home.",
      answerStatus: "irrelevant",
      needsClarification: true,
      responseText: "Kripya wax ke farak ke baare mein batayein.",
    }),
  });

  assert.equal(resGhar.intent, "IRRELEVANT_OR_NONRESPONSIVE");
  assert.equal(resGhar.answerStatus, "irrelevant");
});

test("Phase 1: Off-topic candidate questions (cricket score, weather, trivia) are classified as IRRELEVANT_OR_NONRESPONSIVE", () => {
  const offTopicQueries = [
    { q: "Aapko salon mein kitne saal ka anubhav hai?", a: "Who won the cricket match?" },
    { q: "Kaam par aane ke liye travel kaise karti hain?", a: "Aaj ka weather kaisa hai?" },
    { q: "Customer app ke bahar discount maang rahi hai. Aap kya karengi?", a: "What is the capital of France?" },
  ];

  for (const { q, a } of offTopicQueries) {
    const res = fallbackInterpretation({ question: q, answer: a });
    assert.equal(res.intent, "IRRELEVANT_OR_NONRESPONSIVE", `Query "${a}" should be flagged irrelevant`);
    assert.equal(res.needsClarification, true);
  }
});

test("Phase 1: Valid short direct answers and confirmation questions remain accepted as INTERVIEW_ANSWER", () => {
  const validAnswers = [
    { q: "Aapko salon mein kitne saal ka anubhav hai?", a: "2 years" },
    { q: "Aapko salon mein kitne saal ka anubhav hai?", a: "Do saal" },
    { q: "Aap sabse zyada kaun si service karti hain?", a: "Waxing" },
    { q: "Kaam par aane ke liye travel kaise karti hain?", a: "Bike se" },
    { q: "Aap kis city mein rehti hain?", a: "Delhi" },
    { q: "Kya aap poori training attend kar sakti hain?", a: "Haan" },
    { q: "Kya aap poori training attend kar sakti hain?", a: "Nahi" },
  ];

  for (const { q, a } of validAnswers) {
    const res = fallbackInterpretation({ question: q, answer: a });
    assert.equal(res.intent, "INTERVIEW_ANSWER", `Answer "${a}" should be accepted as INTERVIEW_ANSWER`);
    assert.equal(res.answerStatus, "sufficient");
    assert.equal(res.needsClarification, false);
  }
});

test("Phase 2: Ambiguous experience answers trigger PARTIAL_OR_AMBIGUOUS_ANSWER contextual probe", () => {
  const ambiguousAnswers = [
    { q: "Aapko salon mein kitne saal ka anubhav hai?", a: "Thoda experience hai" },
    { q: "Aapko salon mein kitne saal ka anubhav hai?", a: "I have some experience" },
    { q: "Aapko salon mein kitne saal ka anubhav hai?", a: "Mujhe thoda anubhav hai" },
    { q: "Aapka beauty ka safar kaise shuru hua? Salon mein kaam kiya hai?", a: "Haan experience hai" },
  ];

  for (const { q, a } of ambiguousAnswers) {
    const res = fallbackInterpretation({ question: q, answer: a });
    assert.equal(
      res.intent,
      "PARTIAL_OR_AMBIGUOUS_ANSWER",
      `Answer "${a}" should be partial/ambiguous, got ${res.intent}`,
    );
    assert.equal(res.needsClarification, true);
    assert.ok(res.clarificationQuestion.length > 5);
  }
});

test("Phase 2: Candidate clarification queries return CLARIFICATION_REQUEST without treating as invalid", () => {
  const clarificationQueries = [
    { q: "Aadhaar ke anusaar aapki umar kitni hai?", a: "Aap kya pooch rahe ho?" },
    { q: "Aadhaar ke anusaar aapki umar kitni hai?", a: "Question samajh nahi aaya" },
    { q: "Aadhaar ke anusaar aapki umar kitni hai?", a: "Thoda explain kariye" },
    { q: "Aadhaar ke anusaar aapki umar kitni hai?", a: "Can you repeat the question?" },
    { q: "Aadhaar ke anusaar aapki umar kitni hai?", a: "What do you mean?" },
  ];

  for (const { q, a } of clarificationQueries) {
    const res = fallbackInterpretation({ question: q, answer: a });
    assert.equal(
      res.intent,
      "CLARIFICATION_REQUEST",
      `Query "${a}" should be CLARIFICATION_REQUEST, got ${res.intent}`,
    );
    assert.ok(res.responseText.length > 5);
  }
});

test("Phase 2.1: generateInquiryResponse generates validated contextual response", async () => {
  let capturedPrompt = "";
  const mockResult = {
    topic: "travel",
    replyText: "Urban Company mein bookings aapke area ke 3-4 km cluster mein hi hoti hain.",
    probeQuestion: "Kya aap is cluster mein travel kar sakti hain?",
    suggestedNextAction: "CONTINUE_INQUIRY",
  };

  const res = await generateInquiryResponse({
    candidateUtterance: "Kaam kahan karna hoga?",
    currentQuestion: { id: "A1", text: "Aap kis area mein rehti hain?" },
    activeInquiryTopic: "travel",
    generateTextImpl: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify(mockResult);
    },
  });

  assert.equal(res.topic, "travel");
  assert.equal(res.replyText, mockResult.replyText);
  assert.equal(res.probeQuestion, mockResult.probeQuestion);
  assert.equal(res.suggestedNextAction, "CONTINUE_INQUIRY");
  assert.match(capturedPrompt, /Kaam kahan karna hoga\?/);
  assert.match(capturedPrompt, /Aap kis area mein rehti hain\?/);
});

test("Phase 2.1: generateInquiryResponse matches candidate language in prompt", async () => {
  let capturedHindiPrompt = "";
  let capturedEnglishPrompt = "";

  await generateInquiryResponse({
    candidateUtterance: "Kahan travel karna hoga?",
    currentQuestion: { id: "A1", text: "Aap kis area mein rehti hain?" },
    language: "Hindi",
    generateTextImpl: async (prompt) => {
      capturedHindiPrompt = prompt;
      return JSON.stringify({
        topic: "travel",
        replyText: "Aapke paas ke cluster mein.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });
  assert.match(capturedHindiPrompt, /Language to match: natural Hindi\/Hinglish/i);

  await generateInquiryResponse({
    candidateUtterance: "Where would I need to travel?",
    currentQuestion: { id: "A1", text: "Which area do you live in?" },
    language: "English",
    generateTextImpl: async (prompt) => {
      capturedEnglishPrompt = prompt;
      return JSON.stringify({
        topic: "travel",
        replyText: "Within a 3-4 km cluster.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });
  assert.match(capturedEnglishPrompt, /Language to match: English/i);
});

test("Phase 2.1: generateInquiryResponse passes active inquiry history and relevant memory facts", async () => {
  let capturedPrompt = "";
  const turns = [
    { role: "candidate", text: "Travel kitna karna padega?" },
    { role: "interviewer", text: "3-4 km cluster mein kaam hota hai." },
  ];
  const memory = {
    facts: {
      currentCity: "Delhi",
      localArea: "Rohini",
      vehicle: "two-wheeler",
      hasChildren: true,
      rawDob: "1995-05-12",
    },
  };

  await generateInquiryResponse({
    candidateUtterance: "Kya Rohini ke paas hi milega?",
    currentQuestion: { id: "A1", text: "Aap kis area mein rehti hain?" },
    activeInquiryTurns: turns,
    sessionMemory: memory,
    generateTextImpl: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        topic: "travel",
        replyText: "Haan, Rohini cluster mein hi kaam milega.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });

  assert.match(capturedPrompt, /Candidate: "Travel kitna karna padega\?"/);
  assert.match(capturedPrompt, /Interviewer: "3-4 km cluster mein kaam hota hai\."/);
  assert.match(capturedPrompt, /City: Delhi/);
  assert.match(capturedPrompt, /Local Area: Rohini/);
  assert.match(capturedPrompt, /Vehicle\/Conveyance: two-wheeler/);
  // Sensitive/unnecessary personal facts must NOT be included in the memory prompt
  assert.doesNotMatch(capturedPrompt, /hasChildren/i);
  assert.doesNotMatch(capturedPrompt, /1995-05-12/);
});

test("Phase 2.1: generateInquiryResponse includes grounded facts and unverified policy constraints", async () => {
  let capturedPrompt = "";
  await generateInquiryResponse({
    candidateUtterance: "Kitna paisa milega per month?",
    currentQuestion: { id: "B1", text: "Customer handling ka experience?" },
    generateTextImpl: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        topic: "earnings",
        replyText: "Earnings aur payout details onboarding team share karegi.",
        probeQuestion: "",
        suggestedNextAction: "DEFER_TO_ONBOARDING",
      });
    },
  });

  assert.match(capturedPrompt, /nearby local areas/);
  assert.match(capturedPrompt, /Minimum age required to register as an Urban Company partner is 18 years/);
  assert.match(capturedPrompt, /NEVER invent, guess, or state specific rupee amounts/);
  assert.match(capturedPrompt, /DEFER_TO_ONBOARDING/);
});

test("Phase 2.1: generateInquiryResponse rejects malformed JSON and empty responses", async () => {
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Hello",
      currentQuestion: { id: "A1", text: "Location?" },
      generateTextImpl: async () => "Not a JSON output at all",
    }),
    (err) => err.code === "AI_MALFORMED_JSON",
  );

  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Hello",
      currentQuestion: { id: "A1", text: "Location?" },
      generateTextImpl: async () => JSON.stringify({ topic: "test", replyText: "" }),
    }),
    (err) => err.code === "AI_INVALID_STRUCTURE",
  );

  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Hello",
      currentQuestion: { id: "A1", text: "Location?" },
      generateTextImpl: async () => "",
    }),
    (err) => err.code === "AI_INVALID_STRUCTURE",
  );
});

test("Phase 2.1: generateInquiryResponse propagates 429 and 503 error codes", async () => {
  const rateLimitError = Object.assign(new Error("Resource exhausted"), { status: 429 });
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Kya training milegi?",
      currentQuestion: { id: "A0", text: "Start karein?" },
      generateTextImpl: async () => { throw rateLimitError; },
    }),
    (err) => err.code === "AI_RATE_LIMIT",
  );

  const unavailableError = new Error("Model temporarily unavailable 503");
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Kya training milegi?",
      currentQuestion: { id: "A0", text: "Start karein?" },
      generateTextImpl: async () => { throw unavailableError; },
    }),
    (err) => err.code === "AI_INTERPRETATION_UNAVAILABLE",
  );
});

test("Phase 2.1: generateInquiryResponse enforces timeout boundary", async () => {
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Kaam kahan hoga?",
      currentQuestion: { id: "A1", text: "Location?" },
      timeoutMs: 50,
      generateTextImpl: () => new Promise((resolve) => setTimeout(resolve, 200)),
    }),
    (err) => err.code === "AI_TIMEOUT",
  );
});

test("Phase 2.1.1: isUnsupportedPolicyClaim identifies unsupported claims while accepting normal explanation", () => {
  const unsafeClaims = [
    "Aapko 30,000 per month milega",
    "Har service ke 500 rupees milenge",
    "Daily 5 bookings guaranteed milengi",
    "Guaranteed work aur regular clients milenge",
    "Kit ₹2000 ka aayega",
    "Kit 5,000 rupees ka lena hoga",
    "Subah 9 baje se 7 baje tak kaam karna hoga",
    "8 ghante kaam karna padega",
    "Hum 100% safety guarantee dete hain",
    "Poori safety ki guarantee hamari hai",
  ];

  for (const claim of unsafeClaims) {
    assert.equal(isUnsupportedPolicyClaim(claim), true, `Claim should be flagged as unsafe: "${claim}"`);
  }

  const safeExplanations = [
    "Urban Company mein bookings aapke ghar ke 3-4 km cluster mein hi hoti hain, door nahi jaana hota.",
    "Urban Company partner banne ke liye kam se kam 18 saal ki umar honi chahiye.",
    "Screening clear karne ke baad Urban Company selected partners ko proper training deti hai.",
    "Partners app ke through flexible slots choose kar sakte hain.",
    "Main screening assistant hoon, earnings aur payout slabs ki poori jaankari onboarding team share karegi.",
    "Aap bus, auto, ya scooty jo bhi suvidhajanak ho use kar sakti hain.",
  ];

  for (const safe of safeExplanations) {
    assert.equal(isUnsupportedPolicyClaim(safe), false, `Safe explanation should not be flagged: "${safe}"`);
  }
});

test("Phase 2.1.1: generateInquiryResponse rejects invented monthly earnings or payouts", async () => {
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Earnings kitni hongi?",
      currentQuestion: { id: "B1", text: "Customer handling" },
      generateTextImpl: async () => JSON.stringify({
        topic: "earnings",
        replyText: "Aapko monthly 25,000 rupees pakka milenge.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      }),
    }),
    (err) => err.code === "AI_UNSUPPORTED_POLICY_CLAIM",
  );

  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Kitna paisa milega?",
      currentQuestion: { id: "B1", text: "Customer handling" },
      generateTextImpl: async () => JSON.stringify({
        topic: "earnings",
        replyText: "Har client visit ka 500 rs payout milega.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      }),
    }),
    (err) => err.code === "AI_UNSUPPORTED_POLICY_CLAIM",
  );
});

test("Phase 2.1.1: generateInquiryResponse rejects guaranteed bookings and invented kit costs", async () => {
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Kaam regular milega?",
      currentQuestion: { id: "A1", text: "Location?" },
      generateTextImpl: async () => JSON.stringify({
        topic: "general_inquiry",
        replyText: "Daily 5 bookings guaranteed milengi.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      }),
    }),
    (err) => err.code === "AI_UNSUPPORTED_POLICY_CLAIM",
  );

  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Kit kitne ka hoga?",
      currentQuestion: { id: "B18", text: "Training" },
      generateTextImpl: async () => JSON.stringify({
        topic: "training",
        replyText: "Kit ₹3000 ka khareedna padega.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      }),
    }),
    (err) => err.code === "AI_UNSUPPORTED_POLICY_CLAIM",
  );
});

test("Phase 2.1.1: generateInquiryResponse rejects exact shift hours and safety guarantees", async () => {
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Timing kya hogi?",
      currentQuestion: { id: "A1", text: "Location?" },
      generateTextImpl: async () => JSON.stringify({
        topic: "working_hours",
        replyText: "Aapko subah 9 baje se 7 baje tak kaam karna padega.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      }),
    }),
    (err) => err.code === "AI_UNSUPPORTED_POLICY_CLAIM",
  );

  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Safety ka kya intezam hai?",
      currentQuestion: { id: "A1", text: "Location?" },
      generateTextImpl: async () => JSON.stringify({
        topic: "safety",
        replyText: "Hum 100% safety guarantee dete hain.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      }),
    }),
    (err) => err.code === "AI_UNSUPPORTED_POLICY_CLAIM",
  );
});

// =========================================================================
// STAGE 2: UNIFIED CONVERSATION INTENT TESTS
// =========================================================================

test("Stage 2: normalizeIntent maps all raw intents and fallback statuses to 7 canonical intents", () => {
  assert.equal(normalizeIntent("INTERVIEW_ANSWER"), UNIFIED_INTENTS.ASSESSMENT_ANSWER);
  assert.equal(normalizeIntent("ASSESSMENT_ANSWER"), UNIFIED_INTENTS.ASSESSMENT_ANSWER);
  assert.equal(normalizeIntent("RELEVANT_COUNTER_QUESTION"), UNIFIED_INTENTS.CANDIDATE_QUESTION);
  assert.equal(normalizeIntent("CANDIDATE_QUESTION"), UNIFIED_INTENTS.CANDIDATE_QUESTION);
  assert.equal(normalizeIntent("QUESTION_RATIONALE_INQUIRY"), UNIFIED_INTENTS.CANDIDATE_QUESTION);
  assert.equal(normalizeIntent("CANDIDATE_CONSTRAINT_OR_HESITATION"), UNIFIED_INTENTS.CANDIDATE_QUESTION);
  assert.equal(normalizeIntent("CLARIFICATION_REQUEST"), UNIFIED_INTENTS.CLARIFICATION_REQUEST);
  assert.equal(normalizeIntent("PARTIAL_OR_AMBIGUOUS_ANSWER"), UNIFIED_INTENTS.AMBIGUOUS_RESPONSE);
  assert.equal(normalizeIntent("AMBIGUOUS_RESPONSE"), UNIFIED_INTENTS.AMBIGUOUS_RESPONSE);
  assert.equal(normalizeIntent("IRRELEVANT_OR_NONRESPONSIVE"), UNIFIED_INTENTS.IRRELEVANT_RESPONSE);
  assert.equal(normalizeIntent("IRRELEVANT_RESPONSE"), UNIFIED_INTENTS.IRRELEVANT_RESPONSE);
  assert.equal(normalizeIntent("ACKNOWLEDGEMENT"), UNIFIED_INTENTS.ACKNOWLEDGEMENT);
  assert.equal(normalizeIntent("CONTINUE_INTERVIEW"), UNIFIED_INTENTS.CONTINUE_INTERVIEW);
  assert.equal(normalizeIntent("UNINTELLIGIBLE_OR_NO_INPUT"), UNIFIED_INTENTS.UNINTELLIGIBLE_OR_NO_INPUT);

  // Missing intent falls back based on answerStatus
  assert.equal(normalizeIntent(null, "sufficient"), UNIFIED_INTENTS.ASSESSMENT_ANSWER);
  assert.equal(normalizeIntent(undefined, "counter_question"), UNIFIED_INTENTS.CANDIDATE_QUESTION);
  assert.equal(normalizeIntent(undefined, "unclear"), UNIFIED_INTENTS.AMBIGUOUS_RESPONSE);
  assert.equal(normalizeIntent(undefined, "irrelevant"), UNIFIED_INTENTS.IRRELEVANT_RESPONSE);
  assert.equal(normalizeIntent(undefined), UNIFIED_INTENTS.ASSESSMENT_ANSWER);
});

test("Stage 2: 9 Core Step 4 scenarios accurately classified by fallbackInterpretation", () => {
  const travelQuestion = "Are you comfortable travelling to nearby service areas?";

  // 1. ASSESSMENT_ANSWER
  const ans1 = fallbackInterpretation({ question: travelQuestion, answer: "Yes, I can travel." });
  assert.equal(ans1.unifiedIntent, UNIFIED_INTENTS.ASSESSMENT_ANSWER);

  // 2. CANDIDATE_QUESTION: "Where would I need to travel?"
  const ans2 = fallbackInterpretation({ question: travelQuestion, answer: "Where would I need to travel?" });
  assert.equal(ans2.unifiedIntent, UNIFIED_INTENTS.CANDIDATE_QUESTION);

  // 3. CANDIDATE_QUESTION: "How far would I need to travel?"
  const ans3 = fallbackInterpretation({ question: travelQuestion, answer: "How far would I need to travel?" });
  assert.equal(ans3.unifiedIntent, UNIFIED_INTENTS.CANDIDATE_QUESTION);

  // 4. CANDIDATE_QUESTION: "Does this mean I have to shift cities?"
  const ans4 = fallbackInterpretation({ question: travelQuestion, answer: "Does this mean I have to shift cities?" });
  assert.equal(ans4.unifiedIntent, UNIFIED_INTENTS.CANDIDATE_QUESTION);

  // 5. CANDIDATE_QUESTION: "What if I cannot travel every day?"
  const ans5 = fallbackInterpretation({ question: travelQuestion, answer: "What if I cannot travel every day?" });
  assert.equal(ans5.unifiedIntent, UNIFIED_INTENTS.CANDIDATE_QUESTION);

  // 6. AMBIGUOUS_RESPONSE: "It depends on the distance."
  const ans6 = fallbackInterpretation({ question: travelQuestion, answer: "It depends on the distance." });
  assert.equal(ans6.unifiedIntent, UNIFIED_INTENTS.AMBIGUOUS_RESPONSE);

  // 7. AMBIGUOUS_RESPONSE: "I am not sure."
  const ans7 = fallbackInterpretation({ question: travelQuestion, answer: "I am not sure." });
  assert.equal(ans7.unifiedIntent, UNIFIED_INTENTS.AMBIGUOUS_RESPONSE);

  // 8. IRRELEVANT_RESPONSE: "My favourite colour is blue."
  const ans8 = fallbackInterpretation({ question: travelQuestion, answer: "My favourite colour is blue." });
  assert.equal(ans8.unifiedIntent, UNIFIED_INTENTS.IRRELEVANT_RESPONSE);

  // 9. ACKNOWLEDGEMENT: "Okay."
  const ans9 = fallbackInterpretation({ question: travelQuestion, answer: "Okay." });
  assert.equal(ans9.unifiedIntent, UNIFIED_INTENTS.ACKNOWLEDGEMENT);
});

test("Stage 2: Hindi and Hinglish equivalents for 9 scenarios accurately classified", () => {
  const travelQuestion = "Kya aap aas-paas ke service areas mein travel karne ke liye comfortable hain?";

  // 1. ASSESSMENT_ANSWER in Hindi / Hinglish
  const ans1 = fallbackInterpretation({ question: travelQuestion, answer: "Haan main travel kar sakti hoon" });
  assert.equal(ans1.unifiedIntent, UNIFIED_INTENTS.ASSESSMENT_ANSWER);

  // 2. CANDIDATE_QUESTION: Kahan travel karna hoga?
  const ans2 = fallbackInterpretation({ question: travelQuestion, answer: "Kahan travel karna hoga?" });
  assert.equal(ans2.unifiedIntent, UNIFIED_INTENTS.CANDIDATE_QUESTION);

  // 3. CANDIDATE_QUESTION: Kitni door travel karna padega?
  const ans3 = fallbackInterpretation({ question: travelQuestion, answer: "Kitni door travel karna padega?" });
  assert.equal(ans3.unifiedIntent, UNIFIED_INTENTS.CANDIDATE_QUESTION);

  // 4. CANDIDATE_QUESTION: Kya mujhe dusre city shift hona padega?
  const ans4 = fallbackInterpretation({ question: travelQuestion, answer: "Kya mujhe doosre city shift hona padega?" });
  assert.equal(ans4.unifiedIntent, UNIFIED_INTENTS.CANDIDATE_QUESTION);

  // 5. CANDIDATE_QUESTION: Agar main roz travel na kar paun toh?
  const ans5 = fallbackInterpretation({ question: travelQuestion, answer: "Agar main roz travel na kar paun toh?" });
  assert.equal(ans5.unifiedIntent, UNIFIED_INTENTS.CANDIDATE_QUESTION);

  // 6. AMBIGUOUS_RESPONSE: Distance pe depend karega
  const ans6 = fallbackInterpretation({ question: travelQuestion, answer: "Distance pe depend karega" });
  assert.equal(ans6.unifiedIntent, UNIFIED_INTENTS.AMBIGUOUS_RESPONSE);

  // 7. AMBIGUOUS_RESPONSE: Pata nahi / pakka nahi keh sakti
  const ans7 = fallbackInterpretation({ question: travelQuestion, answer: "Mujhe nahi pata, pakka nahi keh sakti" });
  assert.equal(ans7.unifiedIntent, UNIFIED_INTENTS.AMBIGUOUS_RESPONSE);

  // 8. IRRELEVANT_RESPONSE: Mera favourite rang neela hai
  const ans8 = fallbackInterpretation({ question: travelQuestion, answer: "Mera favourite colour blue hai" });
  assert.equal(ans8.unifiedIntent, UNIFIED_INTENTS.IRRELEVANT_RESPONSE);

  // 9. ACKNOWLEDGEMENT: Theek hai / Samajh gaya
  const ans9 = fallbackInterpretation({ question: travelQuestion, answer: "Theek hai, samajh gaya" });
  assert.equal(ans9.unifiedIntent, UNIFIED_INTENTS.ACKNOWLEDGEMENT);

  // CONTINUE_INTERVIEW: Aage badhiye
  const ans10 = fallbackInterpretation({ question: travelQuestion, answer: "Aage badhiye, agla sawal poochiye" });
  assert.equal(ans10.unifiedIntent, UNIFIED_INTENTS.CONTINUE_INTERVIEW);
});

test("Stage 2: interpretAnswer attaches normalized unifiedIntent and honors ACKNOWLEDGEMENT / CONTINUE_INTERVIEW", async () => {
  const interpAck = await interpretAnswer({
    question: "Do you have salon experience?",
    answer: "Understood.",
    questionId: "A7",
    generateTextImpl: async () => JSON.stringify({
      intent: "ACKNOWLEDGEMENT",
      answerStatus: "acknowledgement",
      needsClarification: true,
      shouldRepeatPendingQuestion: true,
      understanding: "Candidate acknowledged without answering.",
      responseText: "Theek hai. Kripya apna anubhav batayein.",
    }),
  });
  assert.equal(interpAck.unifiedIntent, UNIFIED_INTENTS.ACKNOWLEDGEMENT);
  assert.equal(interpAck.intent, "ACKNOWLEDGEMENT");

  const interpCont = await interpretAnswer({
    question: "Do you have salon experience?",
    answer: "Please continue.",
    questionId: "A7",
    generateTextImpl: async () => JSON.stringify({
      intent: "CONTINUE_INTERVIEW",
      answerStatus: "continue",
      needsClarification: true,
      shouldRepeatPendingQuestion: true,
      understanding: "Candidate requested to continue.",
      responseText: "Ji haan, aage badhte hain.",
    }),
  });
  assert.equal(interpCont.unifiedIntent, UNIFIED_INTENTS.CONTINUE_INTERVIEW);
  assert.equal(interpCont.intent, "CONTINUE_INTERVIEW");
});

test("Stage 2 Gap 4: generateInquiryResponse rejects guaranteed relocation immunity and accepts natural uncertainty", async () => {
  // 1. Guaranteed relocation immunity rejected
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Kya mujhe kabhi shift hona padega?",
      currentQuestion: { id: "A1", text: "Location?" },
      generateTextImpl: async () => JSON.stringify({
        topic: "travel",
        replyText: "Aapko kabhi bhi relocate nahi karna hoga guarantee hai.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      }),
    }),
    (err) => err.code === "AI_UNSUPPORTED_POLICY_CLAIM",
  );

  // 2. Natural uncertainty communicating onboarding deferral is accepted
  const res = await generateInquiryResponse({
    candidateUtterance: "Shift timings kya hongi?",
    currentQuestion: { id: "A1", text: "Location?" },
    generateTextImpl: async () => JSON.stringify({
      topic: "working_hours",
      replyText: "Main screening assistant hoon, isliye shift timings aur schedules ki poori jaankari onboarding team aapse discuss karegi.",
      probeQuestion: "",
      suggestedNextAction: "DEFER_TO_ONBOARDING",
    }),
  });
  assert.equal(res.suggestedNextAction, "DEFER_TO_ONBOARDING");
  assert.match(res.replyText, /onboarding team/i);
});

test("Stage 2 Review Fix 1: Grounded facts and deterministic travel responses remove unsupported 3-4 km cluster claim while preserving onboarding deferral", () => {
  const { detectCounterQuestion } = require("./counterQuestions");

  // 1. Verify UC_GROUNDED_FACTS does not claim 3-4 km or cluster as factual company policy
  for (const fact of UC_GROUNDED_FACTS) {
    assert.doesNotMatch(fact, /3-?4\s*km|3–4\s*km/i, "Grounded fact must not state 3-4 km distance claim");
    assert.doesNotMatch(fact, /cluster/i, "Grounded fact must not state cluster claim");
  }

  // 2. Deterministic travel inquiry reply in English
  const travelEn = detectCounterQuestion("Where would I need to travel?", {}, { language: "English" });
  assert.equal(travelEn.isCounterQuestion, true);
  assert.doesNotMatch(travelEn.reply, /3-?4\s*km|3–4\s*km|cluster/i);
  assert.match(travelEn.reply, /nearby local areas/i);
  assert.match(travelEn.reply, /onboarding team/i);

  // 3. Deterministic travel inquiry reply in Hindi
  const travelHi = detectCounterQuestion("Kahan jana hoga?", {}, { language: "Hindi" });
  assert.equal(travelHi.isCounterQuestion, true);
  assert.doesNotMatch(travelHi.reply, /3-?4\s*km|3–4\s*km|cluster/i);
  assert.match(travelHi.reply, /local area/i);
  assert.match(travelHi.reply, /onboarding team/i);

  // 4. Deterministic travel constraint reply in English & Hindi
  const constEn = detectCounterQuestion("What if I cannot travel far?", {}, { language: "English" });
  assert.equal(constEn.isCounterQuestion, true);
  assert.doesNotMatch(constEn.reply, /3-?4\s*km|3–4\s*km|strictly.*cluster/i);
  assert.match(constEn.reply, /onboarding team/i);

  const constHi = detectCounterQuestion("Agar main roz travel na kar paun toh?", {}, { language: "Hindi" });
  assert.equal(constHi.isCounterQuestion, true);
  assert.doesNotMatch(constHi.reply, /3-?4\s*km|3–4\s*km|cluster/i);
  assert.match(constHi.reply, /onboarding team/i);
});

test("Stage 3 Test 1: Arbitrary general-knowledge question answered with general knowledge without unnecessary onboarding deferral", async () => {
  let capturedPrompt = "";
  const res = await generateInquiryResponse({
    candidateUtterance: "API kya hoti hai?",
    currentQuestion: { id: "A7", text: "Salon experience?", category: "Experience" },
    activeInquiryTopic: "general_knowledge",
    language: "Hindi",
    generateTextImpl: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        topic: "general_knowledge",
        replyText: "API alag-alag computer systems aur apps ko aapas mein baat karne aur data share karne ka tareeqa hoti hai.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });

  assert.match(capturedPrompt, /General Knowledge, Professional Skills/i);
  assert.equal(res.topic, "general_knowledge");
  assert.match(res.replyText, /API/i);
  assert.equal(res.suggestedNextAction, "RESOLVE_AND_PROMPT_QUESTION");
  assert.doesNotMatch(res.replyText, /onboarding team/i, "General knowledge should not unnecessarily defer to onboarding");
});

test("Stage 3 Test 2: Arbitrary UC-related question answered with verified information", async () => {
  let capturedPrompt = "";
  const res = await generateInquiryResponse({
    candidateUtterance: "Training kaise hoti hai?",
    currentQuestion: { id: "A7", text: "Salon experience?", category: "Experience" },
    activeInquiryTopic: "training",
    language: "Hindi",
    generateTextImpl: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        topic: "training",
        replyText: "Selection ke baad Urban Company training centers aur digital modules ke through proper service aur safety training deti hai.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });

  assert.match(capturedPrompt, /VERIFIED URBAN COMPANY GROUNDED FACTS/i);
  assert.equal(res.topic, "training");
  assert.match(res.replyText, /training centers.*digital modules/i);
  assert.equal(res.suggestedNextAction, "RESOLVE_AND_PROMPT_QUESTION");
});

test("Stage 3 Test 3: UC-related question with unavailable information defers operational specifics to onboarding team", async () => {
  const res = await generateInquiryResponse({
    candidateUtterance: "Exact toolkit price aur deduction kitna hoga?",
    currentQuestion: { id: "A7", text: "Salon experience?", category: "Experience" },
    activeInquiryTopic: "earnings",
    language: "Hindi",
    generateTextImpl: async () => JSON.stringify({
      topic: "earnings",
      replyText: "Toolkit costs aur material arrangements ki poori jaankari screening clear hone ke baad partner onboarding team aapse share karegi.",
      probeQuestion: "",
      suggestedNextAction: "DEFER_TO_ONBOARDING",
    }),
  });

  assert.equal(res.suggestedNextAction, "DEFER_TO_ONBOARDING");
  assert.match(res.replyText, /onboarding team/i);
  assert.doesNotMatch(res.replyText, /₹|\d+\s*rupees?/i);
});

test("Stage 3 Test 4 & 5: Contextual follow-up and pronoun resolution using previous inquiry turns", async () => {
  let capturedPromptTurn2 = "";
  let capturedPromptTurn3 = "";

  const turn1Turns = [
    { role: "candidate", text: "Training kaise hoti hai?" },
    { role: "interviewer", text: "Urban Company partner training centers aur digital modules se training provide karti hai." },
  ];

  // Turn 2: Elliptical follow-up on duration ("Kitne din ki hoti hai?")
  const resTurn2 = await generateInquiryResponse({
    candidateUtterance: "Kitne din ki hoti hai?",
    currentQuestion: { id: "A7", text: "Salon experience?", category: "Experience" },
    activeInquiryTopic: "training",
    activeInquiryTurns: turn1Turns,
    language: "Hindi",
    generateTextImpl: async (prompt) => {
      capturedPromptTurn2 = prompt;
      return JSON.stringify({
        topic: "training",
        replyText: "Training module ke hisaab se hoti hai, iski exact schedule aur din partner team final karegi.",
        probeQuestion: "",
        suggestedNextAction: "DEFER_TO_ONBOARDING",
      });
    },
  });

  assert.match(capturedPromptTurn2, /CONVERSATION HISTORY OF THIS INQUIRY:\s+Candidate: "Training kaise hoti hai\?"/);
  assert.match(capturedPromptTurn2, /Resolve pronouns and elliptical references/i);
  assert.match(resTurn2.replyText, /partner team|schedule/i);

  // Turn 3: Pronoun/sequence follow-up ("Aur uske baad?")
  const turn2Turns = [
    ...turn1Turns,
    { role: "candidate", text: "Kitne din ki hoti hai?" },
    { role: "interviewer", text: resTurn2.replyText },
  ];

  const resTurn3 = await generateInquiryResponse({
    candidateUtterance: "Aur uske baad?",
    currentQuestion: { id: "A7", text: "Salon experience?", category: "Experience" },
    activeInquiryTopic: "training",
    activeInquiryTurns: turn2Turns,
    language: "Hindi",
    generateTextImpl: async (prompt) => {
      capturedPromptTurn3 = prompt;
      return JSON.stringify({
        topic: "training",
        replyText: "Training successfully complete hone ke baad onboarding formalize hoti hai aur aapko live customer bookings milna shuru hoti hain.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });

  assert.match(capturedPromptTurn3, /Candidate: "Kitne din ki hoti hai\?"/);
  assert.match(resTurn3.replyText, /bookings|onboarding/i);
  assert.equal(resTurn3.suggestedNextAction, "RESOLVE_AND_PROMPT_QUESTION");
});

test("Stage 3 Test 7: Generates natural responses matching English, Hindi, and Hinglish language settings", async () => {
  // English
  let promptEn = "";
  const resEn = await generateInquiryResponse({
    candidateUtterance: "What should I do if a customer is upset?",
    currentQuestion: { id: "A8", text: "Customer handling?", category: "Customer" },
    activeInquiryTopic: "customer_handling",
    language: "English",
    generateTextImpl: async (p) => {
      promptEn = p;
      return JSON.stringify({
        topic: "customer_handling",
        replyText: "In salon services, it is best to listen calmly and politely understand their concern.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });
  assert.match(promptEn, /Language to match: English/);
  assert.match(resEn.replyText, /listen calmly/i);

  // Hindi / Hinglish
  let promptHi = "";
  const resHi = await generateInquiryResponse({
    candidateUtterance: "Agar customer angry ho toh kya karein?",
    currentQuestion: { id: "A8", text: "Customer handling?", category: "Customer" },
    activeInquiryTopic: "customer_handling",
    language: "Hindi",
    generateTextImpl: async (p) => {
      promptHi = p;
      return JSON.stringify({
        topic: "customer_handling",
        replyText: "Aise mein shanti se grahak ki baat sunkar unhe polite tareeqe se solution dena chahiye.",
        probeQuestion: "",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      });
    },
  });
  assert.match(promptHi, /Language to match: natural Hindi\/Hinglish/);
  assert.match(resHi.replyText, /shanti.*sunkar/i);
});

test("Stage 3 Test 8: Gemini timeout and malformed output fallback safely with structured errors", async () => {
  // 1. Timeout error code
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Training kaise hogi?",
      currentQuestion: { id: "A7", text: "Experience?" },
      timeoutMs: 50,
      generateTextImpl: () => new Promise((resolve) => setTimeout(() => resolve("{}"), 200)),
    }),
    (err) => err.code === "AI_TIMEOUT",
  );

  // 2. Malformed JSON throws AI_MALFORMED_JSON
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Training kaise hogi?",
      currentQuestion: { id: "A7", text: "Experience?" },
      generateTextImpl: async () => "Not valid json",
    }),
    (err) => err.code === "AI_MALFORMED_JSON",
  );

  // 3. Empty structure throws AI_INVALID_STRUCTURE
  await assert.rejects(
    generateInquiryResponse({
      candidateUtterance: "Training kaise hogi?",
      currentQuestion: { id: "A7", text: "Experience?" },
      generateTextImpl: async () => JSON.stringify({ replyText: "x" }), // too short
    }),
    (err) => err.code === "AI_INVALID_STRUCTURE",
  );
});
