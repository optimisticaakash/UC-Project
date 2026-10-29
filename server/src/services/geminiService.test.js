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

