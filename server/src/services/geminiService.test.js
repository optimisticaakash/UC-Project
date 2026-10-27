const test = require("node:test");
const assert = require("node:assert/strict");
const { interpretAnswer, INTERPRETATION_REQUEST_OPTIONS } = require("./geminiService");

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
