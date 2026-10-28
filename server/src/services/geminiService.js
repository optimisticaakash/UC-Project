const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const INTERPRETATION_TIMEOUT_MS = 15000;
const INTERPRETATION_REQUEST_OPTIONS = Object.freeze({
  retries: Object.freeze({ strategy: "none" }),
  timeout_ms: INTERPRETATION_TIMEOUT_MS,
});

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

  const response = await ai.interactions.create(
    {
      model: MODEL,
      input: input.trim(),
    },
    INTERPRETATION_REQUEST_OPTIONS,
  );

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

  // The household prompt needs at least one concrete household member.
  // Words such as "ghar" or "family" alone are too broad to establish relevance.
  const isHouseholdQuestion =
    /household|family|घर|परिवार|ghar/i.test(question);
  const householdMemberPatterns =
    /\b(?:husband|wife|mother|father|parents?|brother|sister|son|daughter|children|child|kids?|grandmother|grandfather|in-laws?|pati|patni|saas|sasur|maa|mummy|mum|mumma|papa|pitaji|bhai|behen|beta|beti|bachche|bacche)\b|(?:पति|पत्नी|सास|ससुर|माँ|मां|मम्मी|माता|पिता|पापा|भाई|बहन|बेटा|बेटी|बच्चे|बच्चा)/iu;

  if (isHouseholdQuestion) {
    if (householdMemberPatterns.test(answer)) {
      return {
        understanding: "The answer identifies one or more household members.",
        answerStatus: "sufficient",
        needsClarification: false,
        clarificationQuestion: "",
      };
    }

    return {
      understanding: "The answer does not identify any household members.",
      answerStatus: "unclear",
      needsClarification: true,
      clarificationQuestion:
        "Could you tell me who lives in your household and what they do during the day?",
    };
  }

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

  const isConfirmationQuestion =
    /^(?:kya\s+aap|kya\s+tum|do\s+you|are\s+you|can\s+you|will\s+you|would\s+you|have\s+you)\b|\b(?:kar\s+sakti\s+hain|kar\s+sakte\s+ho|karti\s+hain|karengi|willing|ready|experience\s+hai|seekhna\s+chahti\s+hain|padh\s+leti\s+hain)\b/iu.test(q);

  const isAffirmative =
    /^(?:yes|yeah|yep|sure|haan|han|ji|ji\s+haan|ji\s+han|bilkul|ready|willing|thik\s+hai|theek\s+hai|हाँ|हां|जी|जी\s+हाँ|जी\s+हां|बिल्कुल)[.!?।\s]*$/iu.test(a);

  const isNegative =
    /^(?:no|nope|nahi|nahin|nhi|never|not\s+willing|not\s+ready|नहीं|नही)[.!?।\s]*$/iu.test(a);

  const isUncertain =
    /^(?:not\s+sure|unsure|pata\s+nahi|pata\s+nahin|don't\s+know|dont\s+know|maybe|shayad|no\s+idea|samajh\s+nahi\s+aaya|पता\s+नहीं|शायद)[.!?।\s]*$/iu.test(a);

  if (isUncertain) {
    return {
      understanding: "Candidate expressed uncertainty or hesitance.",
      answerStatus: "unclear",
      needsClarification: true,
      clarificationQuestion: "Kripya is baare mein thoda aur spasht batayein.",
    };
  }

  if (isConfirmationQuestion && isAffirmative) {
    return {
      understanding: "Candidate gave a clear affirmative confirmation in context.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
    };
  }

  if (isConfirmationQuestion && isNegative) {
    return {
      understanding: "Candidate gave a clear negative response in context.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
    };
  }

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

async function interpretAnswer({
  question,
  answer,
  questionId,
  diagnosticRequestId,
  diagnosticPromptTurn,
  diagnosticSessionGeneration,
  generateTextImpl = generateText,
}) {
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

Guidelines for evaluating answers:
- Contextual evaluation: evaluate short answers like "yes", "no", "haan", "nahi" in the context of the question. If the question asks for confirmation, willingness, or experience, a clear affirmative or negative is "sufficient".
- Irrelevant responses or gibberish (e.g. "habba jabba", food, random topics) must be marked as "irrelevant" with needsClarification true.
- If the candidate expresses uncertainty (e.g. "not sure", "pata nahi", "maybe") or skips the question, mark as "unclear" with needsClarification true and ask a natural, polite follow-up.

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
  const modelCallStartedAt = process.hrtime.bigint();
  const diagnosticMetadata = {
    requestId:
      typeof diagnosticRequestId === "string" &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(diagnosticRequestId)
        ? diagnosticRequestId
        : null,
    questionId:
      typeof questionId === "string" && /^[A-Z0-9_]{1,64}$/.test(questionId)
        ? questionId
        : null,
    promptTurn:
      Number.isSafeInteger(diagnosticPromptTurn) && diagnosticPromptTurn >= 0
        ? diagnosticPromptTurn
        : null,
    sessionGeneration:
      Number.isSafeInteger(diagnosticSessionGeneration) &&
      diagnosticSessionGeneration >= 0
        ? diagnosticSessionGeneration
        : null,
  };
  console.info("[UC Answer Interpretation] model_request_started", diagnosticMetadata);

  try {
    raw = await generateTextImpl(prompt);
  } catch (error) {
    console.info("[UC Answer Interpretation] model_request_failed", {
      ...diagnosticMetadata,
      errorName: error?.name || "Error",
      modelCallElapsedMs: Number(
        (Number(process.hrtime.bigint() - modelCallStartedAt) / 1e6).toFixed(1),
      ),
    });
    const message = error?.message || "";
    // A heuristic fallback can classify a rate-limited answer as
    // "sufficient". Keep the failure explicit so the interview service can
    // retain the answer and ask for a retry without advancing the question.
    if (
      error?.name === "RateLimitError" || error?.status === 429 ||
      error?.statusCode === 429 || message.includes("429") || /rate.?limit|quota/i.test(message)
    ) {
      error.code = "AI_RATE_LIMIT";
    } else if (/temporarily unavailable|503|timeout/i.test(message)) {
      error.code = "AI_INTERPRETATION_UNAVAILABLE";
    }
    throw error;
  }

  console.info("[UC Answer Interpretation] model_response_received", {
    ...diagnosticMetadata,
    modelCallElapsedMs: Number(
      (Number(process.hrtime.bigint() - modelCallStartedAt) / 1e6).toFixed(1),
    ),
  });

  try {
    const jsonText = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const result = JSON.parse(jsonText);
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

    const interpretation = {
      understanding: result.understanding.trim(),
      answerStatus: result.answerStatus,
      needsClarification: result.needsClarification,
      clarificationQuestion: result.clarificationQuestion.trim(),
    };
    console.info("[UC Answer Interpretation] interpretation_completed", {
      ...diagnosticMetadata,
      answerStatus: interpretation.answerStatus,
      needsClarification: interpretation.needsClarification,
      interpretationElapsedMs: Number(
        (Number(process.hrtime.bigint() - modelCallStartedAt) / 1e6).toFixed(1),
      ),
    });
    return interpretation;
  } catch (error) {
    console.info("[UC Answer Interpretation] interpretation_failed", {
      ...diagnosticMetadata,
      errorName: error?.name || "Error",
      interpretationElapsedMs: Number(
        (Number(process.hrtime.bigint() - modelCallStartedAt) / 1e6).toFixed(1),
      ),
    });
    throw error;
  }
}

// module.exports = {
//   generateText,
//   interpretAnswer,
// };

module.exports = {
  generateText,
  interpretAnswer,
  fallbackInterpretation,
  INTERPRETATION_REQUEST_OPTIONS,
};
