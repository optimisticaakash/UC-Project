const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

let clientPromise;

async function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing from server environment");
  }

  if (!clientPromise) {
    clientPromise = import("@google/genai").then(({ GoogleGenAI }) => {
      return new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
      });
    });
  }

  return clientPromise;
}

async function generateText(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Input must be a non-empty string");
  }

  const ai = await getClient();

  const response = await ai.interactions.create({
    model: MODEL,
    input: input.trim(),
  });

  const text = response.output_text;

  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Gemini returned an empty response");
  }

  return text.trim();
}

function fallbackInterpretation({ question, answer }) {
  const q = question.trim().toLowerCase();
  const a = answer.trim().toLowerCase();
  const words = a.split(/\s+/).filter(Boolean);

  const relevantPatterns =
    /\b(politely|polite|respectfully|calmly|patiently|courteously|customer|client|grahak|listen|listening|sunungi|sununga|sunti hoon|sunta hoon|samjhaungi|samjhaunga|help karungi|help karunga|sorry|apologize|apologise|maafi|relocate|relocation|travel|shift|shifting|mahine|mahina|din|weeks?|months?|days?|ready|willing|kar sakti hoon|kar sakta hoon|kar paungi|kar paunga mummy|mumma|maa|mother|papa|father|family|parivaar|ghar|rehte|rehti|rehta|sambhalti|sambhalta)\b/i;

  if (relevantPatterns.test(a)) {
    return {
      understanding: "The answer contains a recognized relevant response.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
    };
  }
  const irrelevantPatterns =
    /\b(mujhe|i like|i love|pasand hai|aaloo|aloo|potato|cricket|movie|movies|anime)\b/i;

  const questionKeywords = q
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);

  const answerHasContext = questionKeywords.some((word) => a.includes(word));

  const isLikelyIrrelevant = irrelevantPatterns.test(a) && !answerHasContext;

  if (words.length < 2) {
    return {
      understanding: "The answer is too short to understand clearly.",
      answerStatus: "unclear",
      needsClarification: true,
      clarificationQuestion:
        "Could you please explain your answer in a little more detail?",
    };
  }

  if (isLikelyIrrelevant) {
    return {
      understanding: "The answer does not appear relevant to the question.",
      answerStatus: "irrelevant",
      needsClarification: true,
      clarificationQuestion: "Could you please answer the question directly?",
    };
  }

  return {
    understanding:
      "Rule-based fallback; relevance could not be fully verified.",
    answerStatus: "unclear",
    needsClarification: true,
    clarificationQuestion:
      "Could you please explain your answer in relation to the question?",
  };
}

async function interpretAnswer({ question, answer }) {
  if (
    typeof question !== "string" ||
    !question.trim() ||
    typeof answer !== "string" ||
    !answer.trim()
  ) {
    throw new Error("Question and answer must be non-empty strings");
  }

  const prompt = `
You are an answer interpreter for a salon professional interview.
Understand the candidate's answer only in the context of the question.
Do not decide hiring eligibility, reject candidates, or assign scores.
Do not invent information.

Return only valid JSON:
{
  "understanding": "brief interpretation",
  "answerStatus": "sufficient",
  "needsClarification": false,
  "clarificationQuestion": ""
}

answerStatus must be "sufficient", "unclear", or "irrelevant".
If clarification is needed, set needsClarification to true and provide
one short, neutral clarificationQuestion.
The candidate may answer in Hindi, English, or Hinglish.

Question: ${question.trim()}
Candidate answer: ${answer.trim()}
`;

  let raw;

  try {
    raw = await generateText(prompt);
  } catch (error) {
    const message = error?.message || "";
    const isTemporaryAIError =
      message.includes("429") ||
      /rate.?limit|quota|temporarily unavailable|503|timeout/i.test(message);

    if (isTemporaryAIError) {
      return fallbackInterpretation({ question, answer });
    }

    throw error;
  }

  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let result;

  try {
    result = JSON.parse(jsonText);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }

  const validStatuses = ["sufficient", "unclear", "irrelevant"];

  if (
    !result ||
    typeof result.understanding !== "string" ||
    !validStatuses.includes(result.answerStatus) ||
    typeof result.needsClarification !== "boolean" ||
    typeof result.clarificationQuestion !== "string"
  ) {
    throw new Error("Gemini returned an invalid answer interpretation");
  }

  if (result.needsClarification && !result.clarificationQuestion.trim()) {
    throw new Error("Clarification question is missing");
  }

  return {
    understanding: result.understanding.trim(),
    answerStatus: result.answerStatus,
    needsClarification: result.needsClarification,
    clarificationQuestion: result.clarificationQuestion.trim(),
  };
}

// module.exports = {
//   generateText,
//   interpretAnswer,
// };

module.exports = {
  generateText,
  interpretAnswer,
  fallbackInterpretation,
};
