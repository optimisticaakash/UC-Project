const {
  detectCounterQuestion,
  isRequestToAskQuestion,
  isGenericAcknowledgement,
  isExplicitContinueRequest,
} = require("./counterQuestions");

const UNIFIED_INTENTS = Object.freeze({
  ASSESSMENT_ANSWER: "ASSESSMENT_ANSWER",
  CANDIDATE_QUESTION: "CANDIDATE_QUESTION",
  REQUEST_TO_ASK_QUESTION: "REQUEST_TO_ASK_QUESTION",
  CLARIFICATION_REQUEST: "CLARIFICATION_REQUEST",
  AMBIGUOUS_RESPONSE: "AMBIGUOUS_RESPONSE",
  IRRELEVANT_RESPONSE: "IRRELEVANT_RESPONSE",
  ACKNOWLEDGEMENT: "ACKNOWLEDGEMENT",
  CONTINUE_INTERVIEW: "CONTINUE_INTERVIEW",
  UNINTELLIGIBLE_OR_NO_INPUT: "UNINTELLIGIBLE_OR_NO_INPUT",
});

function normalizeIntent(rawIntent, answerStatus = null) {
  if (!rawIntent || typeof rawIntent !== "string") {
    if (answerStatus === "counter_question") return UNIFIED_INTENTS.CANDIDATE_QUESTION;
    if (answerStatus === "request_to_ask_question") return UNIFIED_INTENTS.REQUEST_TO_ASK_QUESTION;
    if (answerStatus === "irrelevant") return UNIFIED_INTENTS.IRRELEVANT_RESPONSE;
    if (answerStatus === "unclear") return UNIFIED_INTENTS.AMBIGUOUS_RESPONSE;
    return UNIFIED_INTENTS.ASSESSMENT_ANSWER;
  }
  const upper = rawIntent.trim().toUpperCase();
  switch (upper) {
    case "ASSESSMENT_ANSWER":
    case "INTERVIEW_ANSWER":
      return UNIFIED_INTENTS.ASSESSMENT_ANSWER;
    case "REQUEST_TO_ASK_QUESTION":
      return UNIFIED_INTENTS.REQUEST_TO_ASK_QUESTION;
    case "CANDIDATE_QUESTION":
    case "RELEVANT_COUNTER_QUESTION":
    case "QUESTION_RATIONALE_INQUIRY":
    case "CANDIDATE_CONSTRAINT_OR_HESITATION":
      return UNIFIED_INTENTS.CANDIDATE_QUESTION;
    case "CLARIFICATION_REQUEST":
      return UNIFIED_INTENTS.CLARIFICATION_REQUEST;
    case "AMBIGUOUS_RESPONSE":
    case "PARTIAL_OR_AMBIGUOUS_ANSWER":
      return UNIFIED_INTENTS.AMBIGUOUS_RESPONSE;
    case "IRRELEVANT_RESPONSE":
    case "IRRELEVANT_OR_NONRESPONSIVE":
      return UNIFIED_INTENTS.IRRELEVANT_RESPONSE;
    case "ACKNOWLEDGEMENT":
      return UNIFIED_INTENTS.ACKNOWLEDGEMENT;
    case "CONTINUE_INTERVIEW":
      return UNIFIED_INTENTS.CONTINUE_INTERVIEW;
    case "UNINTELLIGIBLE_OR_NO_INPUT":
      return UNIFIED_INTENTS.UNINTELLIGIBLE_OR_NO_INPUT;
    default:
      return upper;
  }
}

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const DEFAULT_INTERPRETATION_TIMEOUT_MS = 15000;
const INTERPRETATION_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.GEMINI_INTERPRETATION_TIMEOUT_MS) || DEFAULT_INTERPRETATION_TIMEOUT_MS,
);
const INTERPRETATION_REQUEST_OPTIONS = Object.freeze({
  retries: Object.freeze({ strategy: "none" }),
  timeout_ms: INTERPRETATION_TIMEOUT_MS,
});

const RELEVANT_PATTERNS =
  /\b(politely|polite|respectfully|calmly|patiently|courteously|customer|client|grahak|listen|listening|sunungi|sununga|sunti hoon|sunta hoon|samjhaungi|samjhaunga|help karungi|help karunga|sorry|apologize|apologise|maafi|relocate|relocation|travel|shift|shifting|saal|sal|years?|yrs?|yr|mahine|mahina|din|weeks?|months?|days?|ready|willing|kar sakti hoon|kar sakta hoon|kar paungi|kar paunga|mummy|mumma|maa|mother|papa|father|family|parivaar|ghar|rehte|rehti|rehta|sambhalti|sambhalta|waxing|wax|facial|cleanup|threading|manicure|pedicure|haircut|bleach|d-?tan|massage|spa|salon|beauty|parlour|parlor|scooty|bike|bus|auto|metro|vehicle|conveyance|two\s*wheeler|anubhav|experience|kaam\s+kiya)\b/i;

const SHORT_DIRECT_ANSWER_PATTERNS =
  /^(?:(?:\d{1,2}|ek|do|teen|chaar|char|panch|paanch|chheh|cheh|saat|aath|nau|das|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:saal|sal|years?|yrs?|mahine|months?)(?:\s+(?:ka)?(?:\s+(?:experience|anubhav|kaam))?)?|fresh|fresher|(?:(?:only\s+|sirf\s+)?(?:waxing|wax|facial|cleanup|clean\s*up|threading|manicure|pedicure|mani\s*pedi|hair\s*styling|haircut|hair\s*cut|bleach|d-?tan|massage|makeup))|(?:(?:apni\s+|khud\s+ki\s+)?(?:bike|scooty|scooter|bus|metro|auto|two\s*wheeler|public\s+transport)(?:\s+(?:se|pe|par|through))?)|(?:delhi|new\s+delhi|noida|gurgaon|gurugram|bangalore|bengaluru|mumbai|pune|hyderabad|chennai|kolkata|jaipur|lucknow|chandigarh))[.!?।\s]*$/iu;

const IRRELEVANT_PATTERNS =
  /\b(aaloo|aloo|potato|biryani|pizza|burger|maggi|cricket|football|movie|movies|cinema|anime|song|songs|dance|gaana|habba\s+jabba|bla\s+bla|blah\s+blah|asdf|qwerty|chair|table|desk|bottle|cat|dog|billi|kutta|weather|mausam|barish|rain|politics|election|chutkula|joke|favourite|favorite|colour|color|blue|red|green|yellow)\b/i;

let clientPromise;

let quotaExhaustedUntil = 0;

function isQuotaExhaustedError(error) {
  if (!error) return false;
  const message = error.message || (typeof error === "string" ? error : "");
  return Boolean(
    error.isQuotaExhausted ||
    error.code === "AI_RATE_LIMIT" ||
    error.status === 429 ||
    error.statusCode === 429 ||
    error.name === "RateLimitError" ||
    /\b429\b|resource_exhausted|quota|rate.?limit/i.test(message)
  );
}

function markQuotaExhausted(retryDelayMs = 60000) {
  quotaExhaustedUntil = Date.now() + Math.max(retryDelayMs, 30000);
  console.warn("[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED", {
    quotaExhaustedUntil,
    cooldownMs: Math.max(retryDelayMs, 30000),
  });
}

function isQuotaExhausted() {
  return Date.now() < quotaExhaustedUntil;
}

function resetQuotaExhaustion() {
  quotaExhaustedUntil = 0;
}

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

  if (isQuotaExhausted()) {
    const error = new Error("GEMINI_FREE_TIER_QUOTA_EXHAUSTED: Request blocked by quota exhaustion circuit-breaker.");
    error.name = "RateLimitError";
    error.code = "AI_RATE_LIMIT";
    error.status = 429;
    error.isQuotaExhausted = true;
    console.warn("[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED", {
      action: "generateText_blocked_by_circuit_breaker",
    });
    throw error;
  }

  const ai = await getClient();

  try {
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
  } catch (error) {
    if (isQuotaExhaustedError(error)) {
      error.code = "AI_RATE_LIMIT";
      error.isQuotaExhausted = true;
      markQuotaExhausted();
    }
    throw error;
  }
}

function fallbackInterpretation(firstArg, ...rest) {
  let params;
  if (firstArg && typeof firstArg === "object" && ("question" in firstArg || "answer" in firstArg || "questionId" in firstArg || "language" in firstArg)) {
    params = firstArg;
  } else if (typeof firstArg === "string") {
    params = {
      question: firstArg,
      answer: rest[0] || "",
      questionId: rest[1] || null,
      language: rest[2] || "Hindi",
    };
  } else {
    params = firstArg || {};
  }
  const result = computeFallbackInterpretation(params);
  if (result && typeof result === "object") {
    if (!result.unifiedIntent) {
      result.unifiedIntent = normalizeIntent(result.intent);
    }
    if (result.intent === "INTERVIEW_ANSWER" || result.intent === "PARTIAL_OR_AMBIGUOUS_ANSWER" || result.unifiedIntent === UNIFIED_INTENTS.ASSESSMENT_ANSWER || result.unifiedIntent === UNIFIED_INTENTS.AMBIGUOUS_RESPONSE) {
      result.extractedFacts = extractFallbackFacts(params.answer || "");
    } else {
      result.extractedFacts = {};
    }
  }
  return result;
}

function computeFallbackInterpretation({ question = "", answer = "", questionId = null, language = "Hindi", activeInquiry = null }) {
  const trimmed = typeof answer === "string" ? answer.trim() : "";
  const isInaudibleMarker = !trimmed || /^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(trimmed);
  if (isInaudibleMarker) {
    const isEnglish = language === "English";
    return {
      intent: "UNINTELLIGIBLE_OR_NO_INPUT",
      unifiedIntent: UNIFIED_INTENTS.UNINTELLIGIBLE_OR_NO_INPUT,
      confidence: 1.0,
      understoodAnswer: "",
      responseText: isEnglish
        ? "I couldn't hear you clearly. Could you please repeat your answer or type it below?"
        : "Maaf kijiye, mujhe aapki aawaz theek se nahi aayi. Kripya dobara batayein ya neeche type karein.",
      shouldRepeatPendingQuestion: true,
      understanding: "Audio or speech was empty or unintelligible.",
      answerStatus: "unclear",
      needsClarification: true,
      clarificationQuestion: isEnglish
        ? "I couldn't hear you clearly. Could you please repeat your answer?"
        : "Maaf kijiye, mujhe aapki aawaz theek se nahi aayi. Kripya dobara batayein.",
      counterQuestionAnswer: "",
      naturalAcknowledgement: "",
    };
  }

  const q = question.trim().toLowerCase();
  const a = answer.trim().toLowerCase();
  const words = a.split(/\s+/).filter(Boolean);
  const isEnglish = language === "English" || /^[a-zA-Z\s.,!?'-]+$/.test(a);

  // Check for candidate counter-questions or clarification requests
  const cq = detectCounterQuestion(
    answer,
    { text: question, id: questionId, Step: questionId },
    { language, activeInquiry },
  );
  if (cq.isCounterQuestion) {
    const isClarificationIntent = cq.intent === "CLARIFICATION_REQUEST";
    const isRequestToAskIntent = cq.intent === "REQUEST_TO_ASK_QUESTION";
    const mappedIntent = cq.intent || "RELEVANT_COUNTER_QUESTION";
    return {
      intent: mappedIntent,
      unifiedIntent: isRequestToAskIntent
        ? UNIFIED_INTENTS.REQUEST_TO_ASK_QUESTION
        : isClarificationIntent
          ? UNIFIED_INTENTS.CLARIFICATION_REQUEST
          : UNIFIED_INTENTS.CANDIDATE_QUESTION,
      confidence: 0.95,
      understoodAnswer: "",
      responseText: cq.reply,
      shouldRepeatPendingQuestion: isRequestToAskIntent ? false : true,
      understanding: isRequestToAskIntent
        ? "Candidate requested permission to ask a question."
        : `Candidate asked a ${isClarificationIntent ? "clarification" : "counter-question"} about ${cq.topic}.`,
      answerStatus: isRequestToAskIntent ? "request_to_ask_question" : "counter_question",
      needsClarification: true,
      counterQuestionAnswer: cq.reply,
      clarificationQuestion: cq.reply,
      naturalAcknowledgement: "",
    };
  }

  // Check for explicit continue / move forward request
  if (isExplicitContinueRequest(trimmed)) {
    const reprompt = isEnglish
      ? "Sure, let's continue with our question:"
      : "Ji, chaliye sawal par aage badhte hain:";
    return {
      intent: "CONTINUE_INTERVIEW",
      unifiedIntent: UNIFIED_INTENTS.CONTINUE_INTERVIEW,
      confidence: 0.95,
      understoodAnswer: "",
      responseText: reprompt,
      shouldRepeatPendingQuestion: true,
      understanding: "Candidate requested to continue or move forward.",
      answerStatus: "continue",
      needsClarification: true,
      clarificationQuestion: reprompt,
      counterQuestionAnswer: "",
      naturalAcknowledgement: isEnglish ? "Sure." : "Ji.",
    };
  }

  // Check for generic acknowledgement on non-confirmation questions
  const isNameConfirm = questionId === "A2_NAME_CONFIRM" || /naam.*(?:sahi|confirm)|confirm.*name/i.test(q);
  if (isGenericAcknowledgement(trimmed) && !isNameConfirm) {
    const probe = isEnglish
      ? "Understood. Please share your answer to the question:"
      : "Theek hai. Kripya is sawal ka apna jawab batayein:";
    return {
      intent: "ACKNOWLEDGEMENT",
      unifiedIntent: UNIFIED_INTENTS.ACKNOWLEDGEMENT,
      confidence: 0.95,
      understoodAnswer: "",
      responseText: probe,
      shouldRepeatPendingQuestion: true,
      understanding: "Candidate gave an acknowledgement without answering the assessment question.",
      answerStatus: "acknowledgement",
      needsClarification: true,
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
      naturalAcknowledgement: isEnglish ? "Understood." : "Theek hai.",
    };
  }

  // Customer scenario partial answer: e.g. "I would talk to her" / "samjhaungi" / "baat karungi"
  const isCustomerScenario = /customer|client|grahak|unhappy|naraz|shikayat|complain|acne|jalan|discount/i.test(q);
  const isMinimalCustomerResponse =
    /^(?:i\s+would\s+talk(?:\s+to\s+her)?|talk\s+to\s+her|talk|unse\s+baat\s+karungi|baat\s+karungi|samjhaungi|unhe\s+samjhaungi)[.!?\s]*$/i.test(a);

  if (isCustomerScenario && isMinimalCustomerResponse) {
    const probe = isEnglish
      ? "That makes sense. What would you do if the customer was still unhappy after you explained the situation?"
      : "Theek hai. Agar customer aapke samjhane ke baad bhi naraz rahein, tab aap kya karengi?";
    return {
      intent: "PARTIAL_OR_AMBIGUOUS_ANSWER",
      confidence: 0.9,
      understoodAnswer: "Candidate gave a partial answer for a customer scenario.",
      responseText: probe,
      shouldRepeatPendingQuestion: false,
      understanding: "Candidate gave a partial answer for a customer scenario.",
      answerStatus: "partial",
      needsClarification: true,
      naturalAcknowledgement: isEnglish ? "That makes sense." : "Theek hai.",
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
    };
  }

  // Experience question partial answer: e.g. "Yes, I have experience" / "haan experience hai" / "Thoda experience hai" / "I have some experience"
  const isExperienceQuestion = /experience|anubhav|services|kaam\s+kiya|salon/i.test(q);
  const isMinimalExperience =
    /^(?:yes(?:,\s*|\s+)?i\s+have\s+(?:some\s+)?experience|i\s+have\s+(?:some\s+)?experience|i\s+have\s+experience|thoda\s+(?:bahut\s+)?(?:experience|anubhav|kaam)(?:\s+hai)?|haan\s+(?:thoda\s+)?(?:experience|anubhav)\s+hai|mujhe\s+(?:thoda\s+)?(?:experience|anubhav)\s+hai|kuch\s+(?:experience|anubhav)\s+hai|experience\s+hai|anubhav\s+hai|i\s+worked\s+in\s+a\s+salon|salon\s+mein\s+kaam\s+kiya\s+hai)[.!?\s]*$/iu.test(
      a,
    );

  if (isExperienceQuestion && isMinimalExperience) {
    const isDurationQuestion =
      /\b(?:kitne\s+saal|kitne\s+sal|kitna\s+experience|kitna\s+anubhav|how\s+many\s+years|how\s+long)\b/i.test(
        q,
      );
    let probe;
    if (isDurationQuestion) {
      probe = isEnglish
        ? "Could you tell me how many months or years of salon experience you have?"
        : "Kripya batayein ki aapko lagbhag kitne saal ya mahine ka anubhav hai?";
    } else {
      probe = isEnglish
        ? "Could you briefly tell me which salon services you have experience with?"
        : "Kripya batayein ki aapko salon ki kaun-kaun si services ka anubhav hai?";
    }
    return {
      intent: "PARTIAL_OR_AMBIGUOUS_ANSWER",
      confidence: 0.9,
      understoodAnswer: "Candidate gave a partial answer indicating experience without specific details.",
      responseText: probe,
      shouldRepeatPendingQuestion: false,
      understanding: "Candidate gave a partial answer indicating experience without specific details.",
      answerStatus: "partial",
      needsClarification: true,
      naturalAcknowledgement: isEnglish ? "Understood." : "Theek hai.",
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
    };
  }

  // The household prompt needs at least one concrete household member.
  const isHouseholdQuestion =
    questionId === "A3" ||
    (!questionId && (/ghar mein kaun|household members|din bhar kaun/i.test(question) || (/\bhousehold\b/i.test(question) && !/shaadi|badi cheez|plan/i.test(question))));
  const householdMemberPatterns =
    /\b(?:husband|wife|mother|father|parents?|brother|sister|son|daughter|children|child|kids?|grandmother|grandfather|in-laws?|pati|patni|saas|sasur|maa|mummy|mum|mumma|papa|pitaji|bhai|behen|beta|beti|bachche|bacche)\b|(?:पति|पत्नी|सास|ससुर|माँ|मां|मम्मी|माता|पिता|पापा|भाई|बहन|बेटा|बेटी|बच्चे|बच्चा)/iu;

  if (isHouseholdQuestion) {
    if (householdMemberPatterns.test(answer)) {
      return {
        intent: "INTERVIEW_ANSWER",
        confidence: 0.95,
        understoodAnswer: answer.trim(),
        responseText: isEnglish ? "Thank you." : "Theek hai.",
        shouldRepeatPendingQuestion: false,
        understanding: "The answer identifies one or more household members.",
        answerStatus: "sufficient",
        needsClarification: false,
        clarificationQuestion: "",
        counterQuestionAnswer: "",
        naturalAcknowledgement: isEnglish ? "Thank you." : "Theek hai.",
      };
    }

    const probe = isEnglish
      ? "Could you tell me who lives in your household and what they do during the day?"
      : "Kripya batayein ki aapke ghar mein kaun-kaun rehte hain?";
    return {
      intent: "PARTIAL_OR_AMBIGUOUS_ANSWER",
      confidence: 0.85,
      understoodAnswer: "",
      responseText: probe,
      shouldRepeatPendingQuestion: false,
      understanding: "The answer does not identify any household members.",
      answerStatus: "unclear",
      needsClarification: true,
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
      naturalAcknowledgement: "",
    };
  }

  const relevantPatterns = RELEVANT_PATTERNS;
  const irrelevantPatterns = IRRELEVANT_PATTERNS;

  const questionKeywords = q
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);

  const answerHasContext = questionKeywords.some((word) => a.includes(word));
  const isCandidateQuestion =
    /[?]$/.test(trimmed) ||
    /^(?:what\s+is|who\s+is|what\s+are|where\s+is|how\s+many|why\s+is|how\s+do|can\s+you|could\s+you|tell\s+me)\b/i.test(a);

  const isOffTopicTriviaQuestion =
    /^(?:who\s+won|who\s+is\s+(?:modi|rahul|actor|president)|capital\s+of|weather\s+kaisa|score\s+kya|cricket\s+score)\b/i.test(a) ||
    (/\b(?:cricket|ipl|match|football|weather|mausam|barish|score|movie|cinema)\b/i.test(a) && /[?]$/.test(trimmed));

  const isLikelyIrrelevant =
    (irrelevantPatterns.test(a) || isOffTopicTriviaQuestion) &&
    !answerHasContext &&
    !isCandidateQuestion &&
    !SHORT_DIRECT_ANSWER_PATTERNS.test(trimmed);

  const isOpenEnded =
    /\b(?:kya\s+(?:karengi|karenge|karti|karte|kartin)|what\s+would\s+you\s+do|kaise|how|kahan|where|kyun|why|kitna|kitne|how\s+much|how\s+many|steps\s+bataiye|kya\s+farak|kya\s+dhyan|kaun\s+kaun|safar|routine|kaise\s+manage)\b/i.test(
      q,
    );

  const isConfirmationQuestion =
    questionId === "A2_NAME_CONFIRM" ||
    (!isOpenEnded &&
      (/^(?:kya\s+(?:aap|tum|kabhi)|do\s+you|are\s+you|can\s+you|will\s+you|would\s+you|have\s+you)\b/iu.test(
        q,
      ) ||
        /\b(?:kar\s+sakti\s+hain|kar\s+sakte\s+ho|willing|ready|seekhna\s+chahti\s+hain|padh\s+leti\s+hain|kaam\s+kiya\s+hai|linked\s+hai|sahi\s+hai|right|is\s+this\s+correct)\b/iu.test(
          q,
        )));

  const isAffirmative =
    /^(?:(?:ji\s+)?(?:haan|han|haanji|hanji|yes|yeah|yep|ha)(?:\s+ji)?(?:\s+(?:sahi(?:\s+hai)?|theek\s+hai|thik\s+hai|wahi\s+hai|yahi\s+hai|wahi\s+naam\s+hai|yahi\s+naam\s+hai|(?:mera\s+)?(?:yahi|wahi)\s+naam\s+hai|(?:mera\s+)?naam\s+(?:yahi|wahi)\s+hai|bilkul(?:\s+sahi(?:\s+hai)?)?|bilkul(?:\s+theek(?:\s+hai)?)?|correct|right|that's\s+correct|that's\s+right|that's\s+my\s+name))?|ji|sahi|sahi\s+hai|correct|right|that's\s+correct|that's\s+right|that's\s+my\s+name|wahi\s+hai|yahi\s+hai|wahi\s+naam\s+hai|yahi\s+naam\s+hai|mera\s+(?:yahi|wahi)\s+naam\s+hai|mera\s+naam\s+(?:yahi|wahi)\s+hai|(?:mera\s+)?naam\s+(?:yahi|wahi)\s+hai|theek\s+hai|thik\s+hai|bilkul|bilkul\s+sahi(?:\s+hai)?|bilkul\s+theek(?:\s+hai)?|bilkul\s+thik(?:\s+hai)?|ji\s+bilkul|ji\s+haan\s+bilkul|ready|willing|sure|हाँ|हां|जी|जी\s+हाँ|जी\s+हां|बिल्कुल|बिल्कुल\s+सही|सही\s+है|वही\s+है|यही\s+है|यही\s+नाम\s+है|मेरा\s+यही\s+नाम\s+है)[.!?।\s]*$/iu.test(
      a,
    );

  const isNegative =
    /^(?:no|nope|nahi|nahin|nhi|galat|wrong(?:\s+name)?|incorrect|not\s+(?:correct|right|my\s+name)|never|not\s+willing|not\s+ready|(?:that|it|this|ye|that's)\s+(?:is\s+)?not\s+my\s+name|ye\s+mera\s+naam\s+nahi\s+hai|mera\s+naam\s+galat\s+hai|galat\s+naam\s+hai|galat\s+hai|naam\s+galat\s+hai|गलत|गलत\s+है|नहीं|नही|गलत\s+नाम\s+है|मेरा\s+नाम\s+गलत\s+है)(?:\s+(?:hai|ji|sir|madam))?[.!?।\s]*$/iu.test(
      a,
    ) ||
    (/^(?:no|nope|nahi|nahin|nhi)\b/i.test(a) &&
      /\b(?:galat|wrong|incorrect|not\s+my\s+name|galat\s+hai)\b/i.test(a));

  const isUncertain =
    /^(?:(?:i\s+(?:am|'m)\s+)?(?:not\s+sure|unsure)|pata\s+nahi|pata\s+nahin|mujhe\s+(?:pata|maloom)\s+nahi|don't\s+know|dont\s+know|maybe|shayad|no\s+idea|samajh\s+nahi\s+aaya|can(?:'t|not)\s+say|keh\s+nahi\s+sakt[ai]|पता\s+नहीं|शायद)[.!?।\s]*$/iu.test(
      a,
    ) ||
    /\b(?:i\s+am\s+not\s+sure|i'm\s+not\s+sure|not\s+really\s+sure|pakka\s+nahi|mujhe\s+nahi\s+pata)\b/i.test(
      a,
    );

  const isConditional =
    /\b(?:depends?\s+on|depend\s+karta|depend\s+karega|it\s+depends|dekhna\s+padega|sochna\s+padega)\b/i.test(
      a,
    );

  if (isUncertain || isConditional) {
    const probe = isEnglish
      ? "Could you please elaborate on that in a little more detail?"
      : "Kripya is baare mein thoda aur spasht batayein.";
    return {
      intent: "PARTIAL_OR_AMBIGUOUS_ANSWER",
      unifiedIntent: UNIFIED_INTENTS.AMBIGUOUS_RESPONSE,
      confidence: 0.9,
      understoodAnswer: "",
      responseText: probe,
      shouldRepeatPendingQuestion: false,
      understanding: isConditional
        ? "Candidate gave a conditional response depending on external factors."
        : "Candidate expressed uncertainty or hesitance.",
      answerStatus: "unclear",
      needsClarification: true,
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
      naturalAcknowledgement: "",
    };
  }

  if ((isOpenEnded || !isConfirmationQuestion) && (isAffirmative || isNegative)) {
    const probe = isEnglish
      ? "Could you please explain your answer in a little more detail?"
      : "Kripya apne jawab ko thoda vistar se samjhaiye.";
    return {
      intent: "PARTIAL_OR_AMBIGUOUS_ANSWER",
      confidence: 0.9,
      understoodAnswer: isAffirmative ? "Yes" : "No",
      responseText: probe,
      shouldRepeatPendingQuestion: false,
      understanding: "Candidate gave a brief yes/no to an open-ended question that requires explanation.",
      answerStatus: "unclear",
      needsClarification: true,
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
      naturalAcknowledgement: "",
    };
  }

  if (isConfirmationQuestion && isAffirmative) {
    return {
      intent: "INTERVIEW_ANSWER",
      confidence: 0.95,
      understoodAnswer: "Yes",
      responseText: isEnglish ? "Thank you." : "Theek hai.",
      shouldRepeatPendingQuestion: false,
      understanding: "Candidate gave a clear affirmative confirmation in context.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
      counterQuestionAnswer: "",
      naturalAcknowledgement: isEnglish ? "Thank you." : "Theek hai.",
    };
  }

  if (isConfirmationQuestion && isNegative) {
    return {
      intent: "INTERVIEW_ANSWER",
      confidence: 0.95,
      understoodAnswer: "No",
      responseText: isEnglish ? "Understood." : "Theek hai.",
      shouldRepeatPendingQuestion: false,
      understanding: "Candidate gave a clear negative response in context.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
      counterQuestionAnswer: "",
      naturalAcknowledgement: isEnglish ? "Understood." : "Theek hai.",
    };
  }

  if (SHORT_DIRECT_ANSWER_PATTERNS.test(trimmed)) {
    return {
      intent: "INTERVIEW_ANSWER",
      confidence: 0.95,
      understoodAnswer: answer.trim(),
      responseText: isEnglish ? "Understood." : "Theek hai.",
      shouldRepeatPendingQuestion: false,
      understanding: "Candidate gave a clear, direct answer to the question.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
      counterQuestionAnswer: "",
      naturalAcknowledgement: isEnglish ? "Understood." : "Theek hai.",
    };
  }

  if (isLikelyIrrelevant) {
    const probe = isEnglish
      ? "Could you please answer the question directly?"
      : "Kripya is sawal ka seedha jawab dein.";
    return {
      intent: "IRRELEVANT_OR_NONRESPONSIVE",
      confidence: 0.9,
      understoodAnswer: "",
      responseText: probe,
      shouldRepeatPendingQuestion: true,
      understanding: "The answer does not appear relevant to the question.",
      answerStatus: "irrelevant",
      needsClarification: true,
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
      naturalAcknowledgement: "",
    };
  }

  const hasDomainRelevance =
    answerHasContext ||
    (/\b(waxing|wax|facial|cleanup|threading|manicure|pedicure|haircut|bleach|d-?tan|massage|spa|salon|beauty|parlour|parlor)\b/i.test(a) &&
      /\b(service|services|wax|facial|kaam|salon|parlour|parlor|beauty)\b/i.test(q)) ||
    (/\b(politely|polite|respectfully|calmly|patiently|courteously|listen|listening|sunungi|sununga|sunti\s+hoon|sunta\s+hoon|samjhaungi|samjhaunga|help|sorry|apologize|apologise|maafi|shanti|solution|discount|rate|rates|fixed|app)\b/i.test(a) &&
      /\b(customer|client|grahak|naraz|unhappy|shikayat|complain|acne|jalan|discount)\b/i.test(q)) ||
    (/\b(travel(?:ling)?|relocat(?:e|ion)?|shift(?:ing)?|bike|scooty|bus|auto|metro|vehicle|conveyance|two\s*wheeler)\b/i.test(a) &&
      /\b(travel(?:ling)?|relocat(?:e|ion)?|shift(?:ing)?|cluster|door|areas?|locations?)\b/i.test(q)) ||
    (/\b(?:\d{1,2}|ek|do|teen|chaar|char|panch|paanch|chheh|cheh|saat|aath|nau|das|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:saal|sal|years?|yrs?|yr|mahine|months?|din|days?|ghante|hours?)\b/i.test(a) &&
      /\b(experience|anubhav|saal|sal|years|ghante|hours|time|kab|kitne)\b/i.test(q));

  if (hasDomainRelevance) {
    return {
      intent: "INTERVIEW_ANSWER",
      confidence: 0.9,
      understoodAnswer: answer.trim(),
      responseText: isEnglish ? "That makes sense." : "Theek hai.",
      shouldRepeatPendingQuestion: false,
      understanding: "The answer contains a recognized relevant response.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
      counterQuestionAnswer: "",
      naturalAcknowledgement: isEnglish ? "That makes sense." : "Theek hai.",
    };
  }

  if (words.length >= 3 && answerHasContext) {
    return {
      intent: "INTERVIEW_ANSWER",
      confidence: 0.85,
      understoodAnswer: answer.trim(),
      responseText: isEnglish ? "Understood." : "Theek hai.",
      shouldRepeatPendingQuestion: false,
      understanding: "Candidate gave a substantive response referencing the question topic.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
      counterQuestionAnswer: "",
      naturalAcknowledgement: isEnglish ? "Understood." : "Theek hai.",
    };
  }

  if (irrelevantPatterns.test(a)) {
    const probe = isEnglish
      ? "Could you please answer the question directly?"
      : "Kripya is sawal ka seedha jawab dein.";
    return {
      intent: "IRRELEVANT_OR_NONRESPONSIVE",
      confidence: 0.9,
      understoodAnswer: "",
      responseText: probe,
      shouldRepeatPendingQuestion: true,
      understanding: "The answer does not appear relevant to the question.",
      answerStatus: "irrelevant",
      needsClarification: true,
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
      naturalAcknowledgement: "",
    };
  }

  if (!answerHasContext && !hasDomainRelevance && !relevantPatterns.test(a)) {
    const probe = isEnglish
      ? "Could you please answer the question directly?"
      : "Kripya is sawal ka seedha jawab dein.";
    return {
      intent: "IRRELEVANT_OR_NONRESPONSIVE",
      confidence: 0.85,
      understoodAnswer: "",
      responseText: probe,
      shouldRepeatPendingQuestion: true,
      understanding: "The answer does not appear relevant to the question topic.",
      answerStatus: "irrelevant",
      needsClarification: true,
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
      naturalAcknowledgement: "",
    };
  }

  return {
    intent: "PARTIAL_OR_AMBIGUOUS_ANSWER",
    confidence: 0.7,
    understoodAnswer: answer.trim(),
    responseText: isEnglish
      ? "Could you please explain your answer in relation to the question?"
      : "Kripya is sawal ke baare mein thoda aur batayein.",
    shouldRepeatPendingQuestion: false,
    understanding: "Rule-based fallback; relevance could not be fully verified.",
    answerStatus: "unclear",
    needsClarification: true,
    clarificationQuestion: isEnglish
      ? "Could you please explain your answer in relation to the question?"
      : "Kripya is sawal ke baare mein thoda aur batayein.",
    counterQuestionAnswer: "",
    naturalAcknowledgement: "",
  };
}

const WORD_TO_NUM = {
  one: "1", ek: "1",
  two: "2", do: "2",
  three: "3", teen: "3",
  four: "4", chaar: "4", char: "4",
  five: "5", panch: "5", paanch: "5",
  six: "6", chheh: "6", cheh: "6",
  seven: "7", saat: "7",
  eight: "8", aath: "8",
  nine: "9", nau: "9",
  ten: "10", das: "10",
};

function extractFallbackFacts(answer) {
  if (typeof answer !== "string" || !answer.trim()) return {};
  const text = answer.trim();
  const lower = text.toLowerCase();
  const facts = {};

  const isHypotheticalTarget = (target) => {
    if (!target) return false;
    const tgt = target.toLowerCase();
    return (
      new RegExp(String.raw`\b(?:agar|if|maybe|shayad|might)\b[^.!?।]{0,100}\b${tgt}\b`, "i").test(lower) ||
      new RegExp(String.raw`\b${tgt}\b[^.!?।]{0,100}\b(?:agar|if|maybe|shayad|might)\b`, "i").test(lower) ||
      new RegExp(String.raw`\b${tgt}\b[^.!?।]{0,40}\b(?:relocate|shift|move|aana|jana|jaana|travel)\b`, "i").test(lower) ||
      new RegExp(String.raw`\b(?:relocate|shift|move|aana|jana|jaana|travel|to)\b[^.!?।]{0,40}\b${tgt}\b`, "i").test(lower)
    );
  };

  const isNegatedTarget = (target) => {
    if (!target) return false;
    const tgt = target.toLowerCase();
    return (
      new RegExp(String.raw`\b${tgt}\b\s*(?:mein\s+)?(?:nahi|nahin|nhi|se\s+nahi|not)\b`, "i").test(lower) ||
      new RegExp(String.raw`\b(?:nahi|nahin|nhi|not|don't\s+live\s+in|dont\s+live\s+in|not\s+in)\s+[^.!?।]{0,20}\b${tgt}\b`, "i").test(lower)
    );
  };

  // Cities
  const cityRegex = /\b(delhi|new\s+delhi|noida|gurgaon|gurugram|bangalore|bengaluru|mumbai|pune|hyderabad|chennai|kolkata|jaipur|lucknow|chandigarh)\b/gi;
  const allCityMatches = Array.from(lower.matchAll(cityRegex));
  const validCity = allCityMatches.find((m) => !isHypotheticalTarget(m[1]) && !isNegatedTarget(m[1]));
  if (validCity) {
    const rawCity = validCity[1].toLowerCase();
    const formattedCity = rawCity === "new delhi" ? "New Delhi" :
      rawCity.charAt(0).toUpperCase() + rawCity.slice(1);
    facts.currentCity = formattedCity;
  }
  const negatedCity = allCityMatches.find((m) => isNegatedTarget(m[1]));
  if (negatedCity) {
    facts.notInTargetCity = true;
  }

  // Experience
  const expMatch = text.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|ek|do|teen|chaar|panch)\s*(?:saal|sal|years?|yrs?)\b/i);
  if (expMatch && !isHypotheticalTarget(expMatch[1])) {
    const rawNum = expMatch[1].toLowerCase();
    const num = WORD_TO_NUM[rawNum] || rawNum;
    facts.experience = `${num} years`;
  }

  // Skills
  const skills = [];
  if (/\b(?:hair\s*styling|hair\s*cut|haircut|hairstyling)\b/i.test(lower)) skills.push("Hair styling");
  if (/\b(?:waxing|wax|rica|roll\s*on)\b/i.test(lower)) skills.push("Waxing");
  if (/\b(?:facial|cleanup|clean\s*up)\b/i.test(lower)) skills.push("Facial");
  if (/\b(?:threading)\b/i.test(lower)) skills.push("Threading");
  if (/\b(?:manicure|pedicure|mani\s*pedi)\b/i.test(lower)) skills.push("Manicure/Pedicure");
  if (/\b(?:makeup|make\s*up|bridal)\b/i.test(lower)) skills.push("Makeup");
  if (skills.length > 0) {
    facts.skills = skills;
  }

  // Vehicle
  const vehicleMatch = lower.match(/\b(scooty|scooter|bike|motorcycle|bus|metro|auto)\b/i);
  if (vehicleMatch && !isHypotheticalTarget(vehicleMatch[1])) {
    facts.vehicle = vehicleMatch[1].toLowerCase();
  }

  // Travel & Relocation Willingness, Conditions, and City Preference
  if (/\b(?:travel\s+kar\s+sakt[aei]|can\s+travel|ready\s+to\s+travel|willing\s+to\s+travel|door\s+bhi\s+ja)\b/i.test(lower)) {
    facts.travelWillingness = "yes";
  } else if (/\b(?:travel\s+nahi\s+kar\s+sakt[aei]|cannot\s+travel|can't\s+travel|not\s+willing\s+to\s+travel|door\s+nahi\s+ja)\b/i.test(lower)) {
    facts.travelWillingness = "no";
  }

  if (/\b(?:agar\s+[^.!?।]{0,40}(?:accommodation|rehne\s+ki\s+jagah|opportunity|offer)|consider\s+kar\s+sakt|can\s+consider|(?:if|provided)\s+[^.!?।]{0,40}accommodation)\b/i.test(lower) || (/\b(?:accommodation|rehne\s+ki\s+jagah)\b/i.test(lower) && /\b(?:relocate|shift|travel)\b/i.test(lower))) {
    facts.relocationWillingness = "conditional";
  } else if (/\b(?:shift\s+nahi\s+ho\s+sakt[aei]|shift\s+nahi|relocate\s+nahi|cannot\s+relocate|cannot\s+shift|can't\s+shift|not\s+willing\s+to\s+relocate|won't\s+relocate)\b/i.test(lower)) {
    facts.relocationWillingness = "no";
  } else if (/\b(?:shift\s+ho\s+sakt[aei]|relocate\s+kar\s+sakt[aei]|ready\s+to\s+relocate|willing\s+to\s+relocate|can\s+relocate|can\s+shift)\b/i.test(lower)) {
    facts.relocationWillingness = "yes";
  }

  if (/\b(?:accommodation|rehne\s+ki\s+jagah)\b/i.test(lower)) {
    facts.relocationCondition = "accommodation";
  } else if (/\b(?:opportunity|offer)\b/i.test(lower)) {
    facts.relocationCondition = "opportunity";
  }

  const prefMatch = lower.match(/(?:main|mai|i|prefer)\s+(delhi|new\s+delhi|noida|gurgaon|gurugram|bangalore|bengaluru|mumbai|pune)\s*(?:mein\s+hi|me\s+hi|\s+hi)?\s*(?:kaam\s+karna|rehna|prefer)/i) ||
    lower.match(/\b(delhi|new\s+delhi|noida|gurgaon|gurugram|bangalore|bengaluru|mumbai|pune)\s*(?:mein\s+hi|me\s+hi)\s+(?:kaam\s+karna|rehna)\b/i);
  if (prefMatch) {
    const rawPref = prefMatch[1].toLowerCase();
    facts.cityPreference = rawPref === "new delhi" ? "New Delhi" : rawPref.charAt(0).toUpperCase() + rawPref.slice(1);
  } else if (/\b(?:apne\s+sheher|current\s+city)\s*(?:mein\s+hi|me\s+hi)\b/i.test(lower)) {
    facts.cityPreference = "Current city preferred";
  }

  if (negatedCity) {
    const rawNegated = negatedCity[1].toLowerCase();
    facts.targetCity = rawNegated === "new delhi" ? "New Delhi" : rawNegated.charAt(0).toUpperCase() + rawNegated.slice(1);
  } else if (/\b(bangalore|bengaluru|delhi|mumbai|pune)\b/i.test(lower) && isHypotheticalTarget(lower.match(/\b(bangalore|bengaluru|delhi|mumbai|pune)\b/i)[1])) {
    const rawTarget = lower.match(/\b(bangalore|bengaluru|delhi|mumbai|pune)\b/i)[1].toLowerCase();
    facts.targetCity = rawTarget.charAt(0).toUpperCase() + rawTarget.slice(1);
  }

  return facts;
}

function sanitizeExtractedFacts(raw, utterance = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const cleaned = {};
  const utteranceLower = typeof utterance === "string" ? utterance.toLowerCase() : "";

  const isValidString = (val) =>
    typeof val === "string" &&
    val.trim() &&
    !/^(?:unknown|none|n\/a|null|undefined|not\s+specified|maybe|shayad)$/i.test(val.trim());

  const isHypotheticalTarget = (target) => {
    if (!utteranceLower || !target) return false;
    const tgt = target.toLowerCase();
    return (
      new RegExp(String.raw`\b(?:agar|if|maybe|shayad|might)\b[^.!?।]{0,100}\b${tgt}\b`, "i").test(utteranceLower) ||
      new RegExp(String.raw`\b${tgt}\b[^.!?।]{0,100}\b(?:agar|if|maybe|shayad|might)\b`, "i").test(utteranceLower)
    );
  };

  if (isValidString(raw.currentCity)) {
    const city = raw.currentCity.trim();
    if (!isHypotheticalTarget(city)) {
      cleaned.currentCity = city;
    }
  }

  if (isValidString(raw.localArea)) {
    cleaned.localArea = raw.localArea.trim();
  }

  if (isValidString(raw.experience)) {
    cleaned.experience = raw.experience.trim();
  }

  if (isValidString(raw.vehicle)) {
    const veh = raw.vehicle.trim();
    if (!isHypotheticalTarget(veh)) {
      cleaned.vehicle = veh.toLowerCase();
    }
  }

  if (isValidString(raw.preferredLanguage)) {
    cleaned.preferredLanguage = raw.preferredLanguage.trim();
  }

  if (isValidString(raw.candidateName)) {
    cleaned.candidateName = raw.candidateName.trim();
  }

  if (isValidString(raw.travelWillingness)) {
    cleaned.travelWillingness = raw.travelWillingness.trim();
  }

  if (isValidString(raw.relocationWillingness)) {
    cleaned.relocationWillingness = raw.relocationWillingness.trim();
  }

  if (isValidString(raw.cityPreference)) {
    cleaned.cityPreference = raw.cityPreference.trim();
  }

  if (isValidString(raw.relocationCondition)) {
    cleaned.relocationCondition = raw.relocationCondition.trim();
  }

  if (isValidString(raw.targetCity)) {
    cleaned.targetCity = raw.targetCity.trim();
  }

  if (typeof raw.notInTargetCity === "boolean") {
    cleaned.notInTargetCity = raw.notInTargetCity;
  }

  if (Array.isArray(raw.skills)) {
    const validSkills = raw.skills
      .filter(isValidString)
      .map((s) => s.trim());
    if (validSkills.length > 0) {
      cleaned.skills = Array.from(new Set(validSkills));
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (Object.prototype.hasOwnProperty.call(cleaned, key)) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (isValidString(value)) {
      if (!isHypotheticalTarget(value)) {
        cleaned[key] = value.trim();
      }
    } else if (Array.isArray(value)) {
      const arr = value.filter(isValidString).map((v) => v.trim());
      if (arr.length > 0) cleaned[key] = Array.from(new Set(arr));
    }
  }

  return cleaned;
}

function formatMemoryContext(sessionMemory) {
  if (!sessionMemory) return "";
  const facts =
    sessionMemory && typeof sessionMemory === "object"
      ? sessionMemory.facts && typeof sessionMemory.facts === "object"
        ? sessionMemory.facts
        : sessionMemory
      : null;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return "";

  const items = [];
  if (facts.candidateName && typeof facts.candidateName === "string" && facts.candidateName.trim()) {
    items.push(`Candidate Name: ${facts.candidateName.trim()}`);
  }
  if (facts.preferredLanguage && typeof facts.preferredLanguage === "string" && facts.preferredLanguage.trim()) {
    items.push(`Preferred Language: ${facts.preferredLanguage.trim()}`);
  }
  if (facts.currentCity && typeof facts.currentCity === "string" && facts.currentCity.trim()) {
    items.push(`Current City: ${facts.currentCity.trim()}`);
  }
  if (facts.localArea && typeof facts.localArea === "string" && facts.localArea.trim()) {
    items.push(`Local Area: ${facts.localArea.trim()}`);
  }
  if (facts.experience && typeof facts.experience === "string" && facts.experience.trim()) {
    items.push(`Experience: ${facts.experience.trim()}`);
  }
  if (Array.isArray(facts.skills) && facts.skills.length > 0) {
    items.push(`Skills: ${facts.skills.join(", ")}`);
  }
  if (facts.vehicle && typeof facts.vehicle === "string" && facts.vehicle.trim()) {
    items.push(`Vehicle/Conveyance: ${facts.vehicle.trim()}`);
  }
  if (typeof facts.age === "number" || (typeof facts.age === "string" && facts.age.trim())) {
    items.push(`Age: ${facts.age}`);
  }
  if (typeof facts.hasChildren === "boolean") {
    items.push(`Has Children: ${facts.hasChildren ? "Yes" : "No"}`);
  }
  if (facts.cityPreference && typeof facts.cityPreference === "string" && facts.cityPreference.trim()) {
    items.push(`City Preference: ${facts.cityPreference.trim()}`);
  }
  if (facts.targetCity && typeof facts.targetCity === "string" && facts.targetCity.trim()) {
    items.push(`Target City: ${facts.targetCity.trim()}`);
  }
  if (facts.travelWillingness && typeof facts.travelWillingness === "string" && facts.travelWillingness.trim()) {
    items.push(`Travel Willingness: ${facts.travelWillingness.trim()}`);
  }
  if (facts.relocationWillingness && typeof facts.relocationWillingness === "string" && facts.relocationWillingness.trim()) {
    items.push(`Relocation Willingness: ${facts.relocationWillingness.trim()}`);
  }
  if (facts.relocationCondition && typeof facts.relocationCondition === "string" && facts.relocationCondition.trim()) {
    items.push(`Relocation Condition: ${facts.relocationCondition.trim()}`);
  }

  for (const [key, val] of Object.entries(facts)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (["candidateName", "preferredLanguage", "currentCity", "localArea", "experience", "skills", "vehicle", "age", "hasChildren", "cityPreference", "targetCity", "travelWillingness", "relocationWillingness", "relocationCondition", "notInTargetCity"].includes(key)) continue;
    if (typeof val === "string" && val.trim() && !/^(?:unknown|none|n\/a|null|undefined)$/i.test(val.trim())) {
      items.push(`${key}: ${val.trim()}`);
    } else if (typeof val === "number" || typeof val === "boolean") {
      items.push(`${key}: ${val}`);
    }
  }

  if (items.length === 0) return "";
  return items.join("; ");
}

async function interpretAnswer({
  question,
  answer,
  questionId,
  previousContext = [],
  pendingFollowUp = null,
  language = "Hindi",
  sessionMemory = null,
  activeInquiry = null,
  diagnosticRequestId,
  diagnosticPromptTurn,
  diagnosticSessionGeneration,
  generateTextImpl = generateText,
}) {
  if (
    typeof question !== "string" ||
    !question.trim() ||
    typeof answer !== "string"
  ) {
    throw new Error("Question and answer must be non-empty strings");
  }

  const cleanAnswer = answer.trim();
  if (!cleanAnswer || /^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(cleanAnswer)) {
    return fallbackInterpretation({ question, answer: cleanAnswer, questionId, language, sessionMemory, activeInquiry });
  }

  const memorySummary = formatMemoryContext(sessionMemory);
  const memorySection = memorySummary
    ? `Known Candidate Facts from This Session (already shared by candidate): ${memorySummary}

Session Memory Guidelines (Crucial for Natural Conversation):
- Known Candidate Facts listed above have ALREADY been shared by the candidate earlier in this interview.
- When generating responseText, naturalAcknowledgement, or follow-up probes:
  1. Acknowledge previously shared information naturally when relevant (e.g. if the candidate mentions their location or experience, refer to it warmly, such as "Achha, aap Delhi mein rehti hain...").
  2. Avoid asking the candidate to repeat information they have already provided. If a detail is already listed in Known Candidate Facts, do not ask for it again.
  3. If a follow-up or clarification is required, ask only for missing or additional details genuinely needed (e.g. if currentCity is known as Delhi but specific area is needed: "Achha, aap Delhi mein rehti hain. Delhi mein kis area mein rehti hain?").
  4. Respect candidate corrections: if the candidate corrects a previously shared fact in this utterance, use the updated fact.
  5. Never invent, assume, or hallucinate candidate facts that were not stated.
  6. Do not output raw JSON, internal variable names, or technical terms in conversational fields. Keep responses natural, concise, and respectful.`
    : "";

  const contextSummary = Array.isArray(previousContext) && previousContext.length > 0
    ? previousContext.map((c) => `Q: ${c.questionText || c.questionId} -> A: ${c.answer}`).join("\n")
    : "";

  const prompt = `
You are an intelligent, empathetic conversation evaluator for Urban Company's AI voice interviewer screening salon professionals.
Analyze the candidate's utterance in the context of the current interview question and determine their intent.

Candidate Language: ${language || "Hindi"}
Current Question [${questionId || "Question"}]: "${question.trim()}"
${pendingFollowUp ? `Pending Follow-up Probe: "${pendingFollowUp}"` : ""}
${memorySection ? `${memorySection}\n` : ""}${contextSummary ? `Recent Context:\n${contextSummary}\n` : ""}Candidate Spoken Utterance: "${cleanAnswer}"

Your task is to classify the candidate's utterance into EXACTLY ONE of the following intents:

1. "INTERVIEW_ANSWER" (or "ASSESSMENT_ANSWER")
   The candidate is answering the question.
   - Salon professionals often answer with concise, direct, or informal Hindi, Hinglish, or English.
   - Short answers that directly address the question (e.g. "Do saal", "2 years", "Waxing", "Facial and cleanup", "Bike se", "Yes I can travel") are SUFFICIENT answers.
   - For confirmation or binary availability questions (e.g. "Kya aap training attend kar sakti hain?", "Kya pehle kisi app pe kaam kiya hai?", or name confirmation "Aapka naam [Name] hai, sahi hai na?"), a clear affirmative ("Haan", "Yes", "Bilkul sahi", "Haanji", "Yahi naam hai", "That's correct") or negative ("Nahi", "No", "Galat hai") is "sufficient". If candidate provides a corrected name (e.g. "Nahi, mera naam Sunita hai"), capture the corrected name in understoodAnswer.
   - For open-ended questions asking for explanations, experience details, customer scenarios ("Aap kya karengi?"), technical procedures, or background, a bare "yes", "no", "haan", or "nahi" is NOT sufficient and must be marked as "PARTIAL_OR_AMBIGUOUS_ANSWER" with a follow-up probe.
   - Set shouldRepeatPendingQuestion to false.
   - Provide a brief, natural, varied naturalAcknowledgement (e.g. "Achha, 2 saal ka anubhav hai.", "Theek hai, samajh gayi.", "Bahut badhiya.", "Understood, noted.") recognizing what they said. Avoid repeating identical phrases on every turn.

2. "RELEVANT_COUNTER_QUESTION" (or "CANDIDATE_QUESTION")
   The candidate asks ANY legitimate question, doubt, curiosity, or request for advice or explanation at any point.
   This includes NEW, UNEXPECTED, or UNSEEN questions, such as:
   - General knowledge and concepts (e.g. "Cloud computing kya hai?", "What is an API?", "AI kaise kaam karta hai?")
   - Professional communication & customer experience (e.g. "Why is communication important?", "What is customer satisfaction?", "How do I handle a difficult customer?", "What happens if a customer refuses to pay?", "What should I do if a customer is unhappy?")
   - Salon practices & service quality (e.g. "How can I improve my service quality?", "What if I am unable to complete a service?", "What is the difference between two salon services?")
   - Interview process & guidance (e.g. "Can you explain this interview process?", "Why does UC require this skill?", "What if I am nervous during an interview?", "Agar mujhe answer nahi pata toh?")
   - Practical situations, tools, safety, travel, earnings, or company policies.
   - Conversational follow-ups to prior answers (e.g. "Iska kya matlab hai?", "Aur kyun?", "Uske baad kya hoga?", "Woh kaise karenge?").
   - Do NOT restrict candidate questions to Urban Company topics. General knowledge questions, professional questions, and conversational follow-ups MUST ALWAYS be classified as RELEVANT_COUNTER_QUESTION (or CANDIDATE_QUESTION), NEVER as IRRELEVANT_OR_NONRESPONSIVE or ASSESSMENT_ANSWER.
   - The candidate may ask unexpected questions that are NOT in any fixed list (e.g. asking why a question matters, asking where/how far they have to travel like "Where would I need to travel?" or "Kitni door jana hoga?", asking if they have to shift like "Does this mean I have to shift cities?", asking what happens if they cannot travel daily like "What if I cannot travel every day?", asking about equipment like "Kya mujhe apna samaan khud lana padega?", asking about safety like "Agar mujhe client ke ghar unsafe feel ho toh main kya karun?", challenging an assumption, or asking about earnings/policy).
   - Approved Grounded Facts (DO NOT invent company policy, salary figures, guarantees, or unsupported features):
     * Role: You are the AI screening assistant conducting preliminary qualification for Urban Company's salon-at-home services.
     * Recording: The interview is recorded solely for preliminary screening and quality evaluation.
     * Work Model: Salon-at-home service where bookings are arranged at customer homes in nearby local areas, with exact operational zones confirmed by the onboarding team.
     * Age Criteria: Minimum age for partners is 18 years.
     * Earnings & Payout: Urban Company's partner onboarding team shares exact payout structures, earnings potential, and incentive slabs after screening. Politely explain this limitation without inventing specific rupee amounts or guarantees.
     * Training & Onboarding: Selected partners undergo professional service, hygiene, and safety training before starting bookings.
     * Equipment & Kits: Standard service kits and materials are clarified and arranged during onboarding by the partner team.
     * Customer Handling: Partners are expected to listen politely, stay calm, and resolve customer concerns respectfully. During the interview, we want to understand the candidate's personal approach.
     * Unknown / Unsupported Topics: If a candidate asks about specific policies, benefits, leave rules, or terms not listed above, politely state that the onboarding team will clarify them after the screening interview. Never invent policies.
   - In responseText: generate a concise (1-2 sentences), warm, conversational answer directly addressing their specific question using the grounded facts, then smoothly transition back to the pending interview question.
   - Set shouldRepeatPendingQuestion to true.
   - NEVER classify a relevant candidate question as irrelevant or issue a warning.

3. "CLARIFICATION_REQUEST"
   The candidate asks what the question or an unfamiliar term means, asks for an example (e.g. "Aapne jo question poochha, kya aap ek example de sakte hain?"), asks you to explain or repeat, or says they did not understand.
   - In responseText: explain the question or term in simple, accessible, respectful terms in the candidate's language, and ask them to share their response.
   - Set shouldRepeatPendingQuestion to true.
   - NEVER issue an irrelevant-answer warning.

4. "PARTIAL_OR_AMBIGUOUS_ANSWER" (or "AMBIGUOUS_RESPONSE")
   The candidate gives an incomplete, conditional, hesitant, or vague answer (e.g. "It depends on the distance", "Distance pe depend karega", "I am not sure", "shayad", or for "How would you handle an unhappy customer?", candidate only says "I would talk to her").
   - In responseText: ask one concise, contextually relevant follow-up probe.
   - Set shouldRepeatPendingQuestion to false.
   - NEVER issue an irrelevant-answer warning for a partial, hesitant, or conditional answer.

5. "IRRELEVANT_OR_NONRESPONSIVE" (or "IRRELEVANT_RESPONSE")
   The utterance is genuinely completely non-responsive banter or off-topic conversation (e.g. "The weather is nice today, what did you eat?", "My favourite colour is blue", unprompted poetry, talking about a cricket match or asking sports scores, movie gossip, or meaningless gibberish like "habba jabba", "asdf qwerty", random food items).
   - STRICT RULES:
     * Candidate questions (including general knowledge, technical concepts, travel/relocation inquiries, or follow-ups) are CANDIDATE QUESTIONS and MUST NEVER be classified as IRRELEVANT_OR_NONRESPONSIVE.
     * NEVER classify a relevant interview- or job-related candidate question as irrelevant.
     * NEVER classify a short or grammatically imperfect Hindi/Hinglish answer as irrelevant if it relates to the question.
     * NEVER classify silence, breathing, or background noise as irrelevant.
     * Do NOT infer irrelevance merely because the answer differs from an expected keyword.
   - Set shouldRepeatPendingQuestion to true.
   - In responseText: polite message asking them to answer the question directly.

6. "ACKNOWLEDGEMENT"
   The candidate acknowledges what the interviewer said without answering the assessment question (e.g., "Okay", "Theek hai", "Understood", "Haanji", "Accha", "Samajh gayi").
   - IMPORTANT: On open-ended or substantive assessment questions, an acknowledgement alone is NOT an assessment answer. It must be classified as "ACKNOWLEDGEMENT".
   - In responseText: politely acknowledge and ask them to share their answer to the pending question.
   - Set shouldRepeatPendingQuestion to true.

7. "CONTINUE_INTERVIEW"
   The candidate explicitly asks to proceed, continue, or move forward with the interview (e.g., "aage badhiye", "continue", "next question", "chaliye shuru karein", "proceed").
   - In responseText: transition back to the pending question.
   - Set shouldRepeatPendingQuestion to true.

8. "UNINTELLIGIBLE_OR_NO_INPUT"
   The audio is blank, muffled noise, inaudible, or transcription failure.
   - Set shouldRepeatPendingQuestion to true.
   - In responseText: ask the candidate to repeat or type their response.
   - NEVER issue a warning penalty.

9. "REQUEST_TO_ASK_QUESTION"
   The candidate explicitly requests permission to ask a question, raises a doubt, or asks if they can clarify something without having asked the question yet (e.g. 'Mujhe ek question poochhna tha', 'Ek baat poochhni thi', 'Mujhe kuch poochhna hai', 'Ek doubt hai', 'Can I ask something?', 'I have a question', 'I wanted to ask something', 'Can you clarify something?').
   - In responseText: generate a polite invitation: "Ji haan, bilkul poochiye, aap apna question poochhiye. Main aapki madad karti hoon." (or English: "Sure, please go ahead and ask your question. I am here to help.").
   - Set shouldRepeatPendingQuestion to false.

10. "extractedFacts" (Optional structured facts about the candidate):
   Extract ONLY clear, factual attributes EXPLICITLY stated by the candidate about themselves in this utterance.
   - Do NOT guess, assume, or infer missing details.
   - Do NOT store hypothetical or conditional statements (e.g. "If I relocate...", "Agar car ho toh...", "Maybe", "Shayad").
   - Do NOT store off-topic chatter.
   - If candidate explicitly corrects a prior fact, capture the new corrected value.
   - Supported fields (include ONLY fields explicitly stated in the answer):
     * "currentCity": string (e.g. "Delhi", "Bangalore")
     * "localArea": string (e.g. "Whitefield", "Rohini")
     * "experience": string (e.g. "2 years", "6 months")
     * "skills": array of strings (e.g. ["Hair styling", "Waxing", "Facial"])
     * "vehicle": string (e.g. "scooty", "bike", "metro")
     * "preferredLanguage": string (e.g. "Hindi", "English")
   If no factual attributes were explicitly stated, return an empty object: {}.

Output MUST be strictly valid JSON without markdown wrapping:
{
  "intent": "INTERVIEW_ANSWER" | "REQUEST_TO_ASK_QUESTION" | "RELEVANT_COUNTER_QUESTION" | "CLARIFICATION_REQUEST" | "PARTIAL_OR_AMBIGUOUS_ANSWER" | "IRRELEVANT_OR_NONRESPONSIVE" | "ACKNOWLEDGEMENT" | "CONTINUE_INTERVIEW" | "UNINTELLIGIBLE_OR_NO_INPUT",
  "confidence": 0.95,
  "understoodAnswer": "summary of answer or empty string",
  "responseText": "conversational response to speak to candidate",
  "shouldRepeatPendingQuestion": false,
  "naturalAcknowledgement": "brief acknowledgement",
  "extractedFacts": {}
}
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

  if (generateTextImpl === generateText && isQuotaExhausted()) {
    const error = new Error("GEMINI_FREE_TIER_QUOTA_EXHAUSTED: Request blocked by quota exhaustion circuit-breaker.");
    error.name = "RateLimitError";
    error.code = "AI_RATE_LIMIT";
    error.status = 429;
    error.isQuotaExhausted = true;
    console.warn("[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED", {
      ...diagnosticMetadata,
      action: "interpretAnswer_blocked_by_circuit_breaker",
    });
    throw error;
  }

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
    if (isQuotaExhaustedError(error)) {
      error.code = "AI_RATE_LIMIT";
      error.isQuotaExhausted = true;
      if (generateTextImpl === generateText) {
        markQuotaExhausted();
      }
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

    let intent = result.intent;
    if (!intent) {
      if (result.answerStatus === "counter_question") intent = "RELEVANT_COUNTER_QUESTION";
      else if (result.answerStatus === "partial") intent = "PARTIAL_OR_AMBIGUOUS_ANSWER";
      else if (result.answerStatus === "irrelevant") intent = "IRRELEVANT_OR_NONRESPONSIVE";
      else if (result.answerStatus === "sufficient") intent = "INTERVIEW_ANSWER";
      else if (result.answerStatus === "acknowledgement") intent = "ACKNOWLEDGEMENT";
      else if (result.answerStatus === "continue") intent = "CONTINUE_INTERVIEW";
      else intent = result.needsClarification ? "PARTIAL_OR_AMBIGUOUS_ANSWER" : "INTERVIEW_ANSWER";
    }

    if (intent === "ASSESSMENT_ANSWER") intent = "INTERVIEW_ANSWER";
    else if (intent === "CANDIDATE_QUESTION") intent = "RELEVANT_COUNTER_QUESTION";
    else if (intent === "AMBIGUOUS_RESPONSE") intent = "PARTIAL_OR_AMBIGUOUS_ANSWER";
    else if (intent === "IRRELEVANT_RESPONSE") intent = "IRRELEVANT_OR_NONRESPONSIVE";

    // Safety guard 1: Counter-question / Clarification protection
    const cq = detectCounterQuestion(cleanAnswer, { text: question }, { language, activeInquiry });
    if (cq.isCounterQuestion) {
      const wasIrrelevant = intent === "IRRELEVANT_OR_NONRESPONSIVE" || result.intent === "IRRELEVANT_OR_NONRESPONSIVE" || intent === "IRRELEVANT_RESPONSE";
      intent = cq.intent || "RELEVANT_COUNTER_QUESTION";
      result.answerStatus = cq.intent === "REQUEST_TO_ASK_QUESTION" ? "request_to_ask_question" : "counter_question";
      result.needsClarification = true;
      result.shouldRepeatPendingQuestion = cq.intent === "REQUEST_TO_ASK_QUESTION" ? false : true;
      if (!result.responseText || !result.responseText.trim() || wasIrrelevant) {
        result.responseText = cq.reply;
        result.counterQuestionAnswer = cq.reply;
      }
    }

    // Safety guard 2: Empty or inaudible markers must never become IRRELEVANT_OR_NONRESPONSIVE
    if (/^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(cleanAnswer)) {
      intent = "UNINTELLIGIBLE_OR_NO_INPUT";
      result.answerStatus = "unclear";
      result.needsClarification = true;
      result.shouldRepeatPendingQuestion = true;
    }

    // Safety guard 2b: Explicit continue request
    if (isExplicitContinueRequest(cleanAnswer)) {
      intent = "CONTINUE_INTERVIEW";
      result.answerStatus = "continue";
      result.needsClarification = true;
      result.shouldRepeatPendingQuestion = true;
    }

    // Safety guard 2c: Generic acknowledgement on non-confirmation questions
    const isNameConfirm =
      question &&
      /A2_NAME_CONFIRM|naam.*(?:sahi|confirm)|confirm.*name/i.test(question);
    if (isGenericAcknowledgement(cleanAnswer) && !isNameConfirm) {
      intent = "ACKNOWLEDGEMENT";
      result.answerStatus = "acknowledgement";
      result.needsClarification = true;
      result.shouldRepeatPendingQuestion = true;
    }

    // Safety guard 3: Short direct answers containing salon, experience, or transport terms must not be flagged irrelevant.
    // Generic words like "family", "ghar", "customer", "ready" alone must NOT independently override irrelevance.
    if (intent === "IRRELEVANT_OR_NONRESPONSIVE") {
      const isShortDirect = SHORT_DIRECT_ANSWER_PATTERNS.test(cleanAnswer);
      const isBinaryConfirmation =
        question &&
        /A2_NAME_CONFIRM|kya\s+(?:aap|tum|kabhi)|do\s+you|are\s+you|can\s+you|will\s+you|would\s+you|have\s+you/i.test(question) &&
        /^(?:haan|ha|han|yes|yeah|yep|ji|sahi|sahi\s+hai|correct|right|no|nahi|nahin|nhi|galat)[.!?।\s]*$/iu.test(cleanAnswer);
      if (isShortDirect || isBinaryConfirmation) {
        intent = "INTERVIEW_ANSWER";
        result.answerStatus = "sufficient";
        result.needsClarification = false;
        result.shouldRepeatPendingQuestion = false;
      }
    }

    const unifiedIntent = normalizeIntent(intent);

    const answerStatus =
      result.answerStatus ||
      (intent === "INTERVIEW_ANSWER" ? "sufficient" :
       intent === "REQUEST_TO_ASK_QUESTION" ? "request_to_ask_question" :
       intent === "RELEVANT_COUNTER_QUESTION" ? "counter_question" :
       intent === "CLARIFICATION_REQUEST" ? "clarification" :
       intent === "PARTIAL_OR_AMBIGUOUS_ANSWER" ? "partial" :
       intent === "ACKNOWLEDGEMENT" ? "acknowledgement" :
       intent === "CONTINUE_INTERVIEW" ? "continue" :
       intent === "IRRELEVANT_OR_NONRESPONSIVE" ? "irrelevant" : "unclear");

    const needsClarification =
      result.needsClarification !== undefined
        ? Boolean(result.needsClarification)
        : intent !== "INTERVIEW_ANSWER";

    const responseText = (result.responseText || result.clarificationQuestion || result.counterQuestionAnswer || "").trim();
    const clarificationQuestion = (result.clarificationQuestion || result.responseText || "").trim();
    const counterQuestionAnswer = (result.counterQuestionAnswer || (intent === "RELEVANT_COUNTER_QUESTION" ? responseText : "")).trim();
    const naturalAcknowledgement = (result.naturalAcknowledgement || (intent === "INTERVIEW_ANSWER" ? "Theek hai." : "")).trim();

    const rawFacts = result.extractedFacts;
    const extractedFacts = (rawFacts && typeof rawFacts === "object" && !Array.isArray(rawFacts))
      ? sanitizeExtractedFacts(rawFacts, cleanAnswer)
      : extractFallbackFacts(cleanAnswer);

    const interpretation = {
      intent,
      unifiedIntent,
      confidence: typeof result.confidence === "number" ? result.confidence : 0.9,
      understoodAnswer: (result.understoodAnswer || result.understanding || "").trim(),
      responseText,
      shouldRepeatPendingQuestion: result.shouldRepeatPendingQuestion !== undefined
        ? Boolean(result.shouldRepeatPendingQuestion)
        : (intent === "RELEVANT_COUNTER_QUESTION" || intent === "CLARIFICATION_REQUEST" || intent === "IRRELEVANT_OR_NONRESPONSIVE" || intent === "UNINTELLIGIBLE_OR_NO_INPUT" || intent === "ACKNOWLEDGEMENT" || intent === "CONTINUE_INTERVIEW"),
      understanding: (result.understanding || result.understoodAnswer || "").trim() || "Candidate answer evaluated.",
      answerStatus,
      needsClarification,
      clarificationQuestion,
      counterQuestionAnswer,
      naturalAcknowledgement,
      extractedFacts,
    };

    console.info("[UC Answer Interpretation] interpretation_completed", {
      ...diagnosticMetadata,
      intent: interpretation.intent,
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

const DEFAULT_INQUIRY_TIMEOUT_MS = 15000;
const INQUIRY_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.GEMINI_INQUIRY_TIMEOUT_MS) || DEFAULT_INQUIRY_TIMEOUT_MS,
);

const UC_GROUNDED_FACTS = Object.freeze([
  "Urban Company operates a salon-at-home service platform where partners visit clients at their homes.",
  "Service bookings are organized at customer homes in nearby local areas, with exact operational zones and travel policies confirmed by the onboarding team.",
  "Cross-city eligibility, active service areas, and relocation requirements are confirmed directly by the Urban Company onboarding team; the screening assistant does not mandate relocation.",
  "Minimum age required to register as an Urban Company partner is 18 years.",
  "Urban Company provides professional service, hygiene, and safety training to all selected partners after screening (via partner training centers and digital modules).",
  "Partner support is available during service fulfillment to assist with customer concerns or on-job issues.",
  "Specific work schedules, availability, and slot preferences are discussed and finalized with the partner onboarding team.",
  "Partner onboarding requires basic qualification details and valid government photo ID verification (such as Aadhaar, PAN).",
  "The interviewer is an automated AI screening assistant conducting preliminary candidate qualification.",
]);

const INQUIRY_POLICY_CONSTRAINTS = Object.freeze([
  "NEVER invent, guess, or state specific rupee amounts, earnings numbers, commission percentages, daily/monthly income guarantees, or bonus slabs.",
  "NEVER invent, guess, or state toolkit/kit prices, equipment deduction costs, or equipment deposit amounts.",
  "NEVER invent or promise fixed training durations (e.g. '7 days' or '2 weeks') or specific training center addresses.",
  "NEVER promise fixed or exact daily working shifts or hours (e.g. '8 hours daily' or specific shift timings).",
  "NEVER make absolute safety guarantees (such as '100% safe', 'guaranteed safety', or unverified 24/7 physical security / SOS commitments).",
  "NEVER guarantee customer booking volume, minimum bookings per day, or job security.",
  "NEVER state fixed or guaranteed travel distance limits or cluster sizes, or promise that relocation or city transfers will never occur; explain that bookings are in local areas, and exact operational zones and relocation policies are confirmed by the onboarding team.",
  "NEVER make unconditional schedule flexibility promises; explain that scheduling options are finalized during onboarding.",
  "When verified official information is unavailable: Communicate uncertainty naturally (e.g. state clearly that the Urban Company onboarding team will share complete details and official policies after initial screening), rather than inventing an authoritative claim. Set suggestedNextAction to 'DEFER_TO_ONBOARDING'.",
]);

const ALLOWED_NEXT_ACTIONS = Object.freeze([
  "CONTINUE_INQUIRY",
  "RESOLVE_AND_PROMPT_QUESTION",
  "DEFER_TO_ONBOARDING",
]);

const ALLOWED_INQUIRY_TOPICS = Object.freeze([
  "travel",
  "location_requirement",
  "earnings",
  "age_policy",
  "training",
  "safety",
  "support",
  "working_hours",
  "documents",
  "term_clarification",
  "repeat_question",
  "hesitation_or_constraint",
  "question_clarification",
  "complaint_handling",
  "customer_handling",
  "general_knowledge",
  "interview_guidance",
  "policy_query",
  "unavailable_info",
  "general_inquiry",
]);

const UNSUPPORTED_POLICY_PATTERNS = Object.freeze([
  // 1. Invented monetary amounts (rupee symbols, Rs, INR, rupees, hazaar, lakh with numbers, numbers with commas like 30,000)
  /(?:₹|rs\.?|inrs?|rupees?)\s*[\d,]+/i,
  /\b[\d,]+\s*(?:₹|rs\.?|inrs?|rupees?|hazaar|hazar|lakhs?|crores?)\b/i,
  /\b\d[\d,]*\s*(?:per\s+month|prati\s+mahina|mahina|mahine|salary|income|kamai)\b/i,

  // 2. Guaranteed earnings, fixed salary, fixed payouts
  /\b(?:guaranteed?\s+(?:earnings?|income|salary|payouts?|money|rupees?)|fixed\s+(?:salary|income|earnings?|payouts?))\b/i,
  /\b(?:pakka\s+(?:milega|paisa|salary|income|kamai))\b/i,

  // 3. Guaranteed work, customer bookings, or order volume
  /\b(?:guaranteed?\s+(?:work|jobs?|bookings?|customers?|clients?|orders?)|pakki?\s+(?:booking|job|kaam))\b/i,
  /\b(?:daily\s+\d+\s+bookings?|roj\s+\d+\s+booking|\d+\s+orders?\s+guaranteed?)\b/i,
  /\b(?:100%\s*(?:guarantee|pakka)|guarantee\s+dete\s+hain|guarantee\s+hai)\b/i,

  // 4. Invented exact working shifts/hours (not flexible slots)
  /\b(?:(?:subah|morning)?\s*\d{1,2}\s*(?:baje|am|pm)?\s*(?:se|to|-)\s*(?:shaam|dopahar|raat|evening|night)?\s*\d{1,2}\s*(?:baje|am|pm)|(?:8|9|10|12)\s*ghante\s+kaam|(?:8|9|10|12)\s*hours?\s+(?:of\s+)?work)\b/i,

  // 5. Unsupported absolute safety guarantees
  /\b(?:100%\s*(?:safe|surakshit|safety)|guaranteed?\s+safety|poori\s+safety\s+ki\s+guarantee|koi\s+(?:bhi\s+)?khatra\s+nahi\s+hoga)\b/i,

  // 6. Unsupported absolute relocation guarantees
  /\b(?:kabhi\s+(?:bhi\s+)?relocate\s+nahi\s+karna\s+hoga|relocation\s+(?:is\s+)?(?:never\s+required|guaranteed\s+not)|never\s+have\s+to\s+relocate|never\s+required\s+to\s+shift)\b/i,
]);

function isUnsupportedPolicyClaim(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return UNSUPPORTED_POLICY_PATTERNS.some((pattern) => pattern.test(text));
}

function formatInquiryMemoryContext(sessionMemory) {
  if (!sessionMemory || !sessionMemory.facts || typeof sessionMemory.facts !== "object") {
    return "";
  }
  const facts = sessionMemory.facts;
  const items = [];
  if (facts.currentCity && typeof facts.currentCity === "string" && facts.currentCity.trim()) {
    items.push(`City: ${facts.currentCity.trim()}`);
  }
  if (facts.localArea && typeof facts.localArea === "string" && facts.localArea.trim()) {
    items.push(`Local Area: ${facts.localArea.trim()}`);
  }
  if (facts.vehicle && typeof facts.vehicle === "string" && facts.vehicle.trim()) {
    items.push(`Vehicle/Conveyance: ${facts.vehicle.trim()}`);
  }
  if (facts.experience && typeof facts.experience === "string" && facts.experience.trim()) {
    items.push(`Experience: ${facts.experience.trim()}`);
  }
  if (Array.isArray(facts.skills) && facts.skills.length > 0) {
    items.push(`Skills: ${facts.skills.join(", ")}`);
  }
  return items.join("; ");
}

function formatInquiryTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return "None (this is the first inquiry turn).";
  return turns
    .map((t) => `${t.role === "candidate" ? "Candidate" : "Interviewer"}: "${t.text}"`)
    .join("\n");
}

async function withTimeout(promise, timeoutMs, timeoutMessage = "Model request timed out") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutMessage);
      err.code = "AI_TIMEOUT";
      reject(err);
    }, timeoutMs);
  });

  // Attach a silent error sink to the original promise so if it rejects after timeout,
  // it does not trigger an UnhandledPromiseRejection in Node.js.
  if (promise && typeof promise.catch === "function") {
    promise.catch(() => {});
  }

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function generateInquiryResponse({
  candidateUtterance,
  currentQuestion,
  activeInquiryTopic = "general_inquiry",
  activeInquiryTurns = [],
  sessionMemory = null,
  approvedFacts = UC_GROUNDED_FACTS,
  language = "Hindi",
  generateTextImpl = generateText,
  timeoutMs = INQUIRY_TIMEOUT_MS,
}) {
  if (typeof candidateUtterance !== "string" || !candidateUtterance.trim()) {
    throw new Error("candidateUtterance must be a non-empty string");
  }

  const memoryContext = formatInquiryMemoryContext(sessionMemory);
  const turnsContext = formatInquiryTurns(activeInquiryTurns);
  const targetLanguage = language === "English" ? "English" : "natural Hindi/Hinglish";

  const prompt = `You are the AI interviewer for Urban Company (UC) screening salon-at-home professionals.
The candidate has paused the assessment question to ask a question, express hesitation, or ask for clarification.

Respond naturally, concisely (1-2 sentences), warmly, and professionally.
Language to match: ${targetLanguage}.

CURRENT PENDING ASSESSMENT QUESTION:
ID: "${currentQuestion?.id || "N/A"}"
Stage / Category: "${currentQuestion?.category || currentQuestion?.stage || "Assessment"}"
Text: "${currentQuestion?.text || "N/A"}"

INQUIRY TOPIC:
"${activeInquiryTopic}"

CONVERSATION HISTORY OF THIS INQUIRY:
${turnsContext}

RELEVANT CANDIDATE CONTEXT (already shared by candidate):
${memoryContext || "None"}

CANDIDATE UTTERANCE TO ANSWER NOW:
"${candidateUtterance.trim()}"

VERIFIED URBAN COMPANY GROUNDED FACTS:
${approvedFacts.map((f) => `- ${f}`).join("\n")}

STRICT POLICY & BOUNDARIES:
${INQUIRY_POLICY_CONSTRAINTS.map((c) => `- ${c}`).join("\n")}

RESPONSE RULES:
1. KNOWLEDGE GROUNDING & SEPARATION:
   A. Urban Company Specific Facts (earnings, payout, kits, working hours, travel distance/zones, training duration/location, company policies):
      - Ground your answer strictly and exclusively in the VERIFIED URBAN COMPANY GROUNDED FACTS above.
      - NEVER invent rupee amounts, fixed salaries, booking volume guarantees, distance promises, or policy commitments.
      - If verified facts do not have official specifics (e.g. exact training duration, shift timings, payout slabs, kit prices), honestly and politely state in candidate's language that the Urban Company partner onboarding team will clarify complete details after preliminary screening. Set suggestedNextAction to "DEFER_TO_ONBOARDING".
   B. General Knowledge, Professional Skills & Interview Clarification:
      - For general knowledge questions (e.g. "What is an API?", technical terms), professional salon customer practices (e.g. handling upset or angry customers, maintaining hygiene, communication etiquette), or interview questions (e.g. "Agar mujhe answer nahi pata toh?"):
      - Answer directly, simply, and conversationally using general knowledge and professional best practices.
      - Do NOT unnecessarily defer general knowledge or interview guidance questions to the onboarding team.
   C. Simplifying the Assessment Question:
      - If candidate asks for simplification (e.g. "Iska matlab simple language mein samjhao", "Explain in simple words"), explain the core meaning of the current pending assessment question simply and clearly in candidate language so they can answer it.

2. CONVERSATIONAL CONTEXT & PRONOUN RESOLUTION:
   - Carefully read CONVERSATION HISTORY OF THIS INQUIRY. Resolve pronouns and elliptical references (e.g., "iska", "uska", "uske baare mein", "what about that?", "aur uske baad?", "kitne din ki hoti hai?") using the previous turns.
   - On follow-ups, build naturally on the prior explanation. Do NOT restart the same explanation from the beginning.
   - If candidate changes topic (e.g. from training to earnings or customer handling), answer the new question while maintaining conversational coherence.

3. DYNAMIC FOLLOW-UP REASONING & INTERVIEW ORIENTATION:
   You are an intelligent human interviewer conducting a preliminary qualification screening for Urban Company's salon-at-home professionals.
   Do not behave like a robotic, keyword-driven chatbot or a search engine that merely spits out an answer.
   Maintain an intelligent, relevant, adaptive conversation around the interview:
   - Answer the candidate's question first with genuine substance and clarity.
   - Understand the candidate's underlying concern.
   - When appropriate, connect general concepts (e.g. communication, customer satisfaction, problem solving, hygiene) to salon work, customer experience, or partner professionalism. Avoid forcing connections when it would sound unnatural.
   - Decide dynamically among the following actions (set 'followUpDecision'):
     * "DIRECT_ANSWER": Candidate asked a simple factual or policy doubt. Provide a direct, warm, concise answer. Set probeQuestion to "".
     * "SIMPLER_EXPLANATION": Candidate asked for simplification or sounded confused. Explain in simpler everyday words. Set probeQuestion to "".
     * "CONTEXTUAL_FOLLOW_UP": Candidate asked about a professional or service concept. Answer their question first, and ask one relevant contextual follow-up. Set probeQuestion to that follow-up question.
     * "PRACTICAL_EXAMPLE": Candidate asked about a concept or practice. Provide a concrete salon or customer handling example in replyText.
     * "SCENARIO_DISCUSSION": Pose a realistic customer scenario to explore how the candidate would respond (e.g. "Suppose a customer is still unhappy after the service. Aap us situation ko kaise handle karengi?"). Set probeQuestion to that scenario question.
     * "CLARIFICATION_FROM_CANDIDATE": If candidate's question was genuinely ambiguous or incomplete, ask one focused clarifying question in probeQuestion.
     * "TRANSITION_TO_ASSESSMENT": The inquiry is complete, understood, or resolved. Answer clearly, set probeQuestion to "", and set suggestedNextAction to "RESOLVE_AND_PROMPT_QUESTION".
   - Avoid robotic repetition: NEVER repeatedly ask "Kya aapka doubt clear ho gaya?" or "Do you have another question?".
   - Avoid turning every single answer into another question. Vary your approach naturally.
   - NEVER ask or advance any official assessment question. Assessment questions are strictly controlled by the backend.

4. MULTIPLE QUESTIONS IN ONE UTTERANCE:
   - If the candidate asks multiple questions in one utterance (e.g. "Customer satisfaction kya hai aur agar client naraz ho toh kya karein?"):
     Identify each question, address each separately and distinctly in order within 'replyText', without skipping any question.

5. ONE-QUESTION-AT-A-TIME OUTPUT RULE:
   - 'replyText' MUST contain only the direct answer, explanation, or examples. Do NOT embed a question inside 'replyText'.
   - If a follow-up or scenario question is appropriate (when followUpDecision is 'CONTEXTUAL_FOLLOW_UP', 'SCENARIO_DISCUSSION', or 'CLARIFICATION_FROM_CANDIDATE'), put that single question into 'probeQuestion'. Otherwise, keep 'probeQuestion' as "".
   - Never output more than one question in a turn.

REQUIRED JSON FORMAT:
{
  "topic": "<brief inquiry topic string>",
  "conversationalReasoning": "<brief explanation of dynamic follow-up decision>",
  "followUpDecision": "<'DIRECT_ANSWER' | 'SIMPLER_EXPLANATION' | 'CONTEXTUAL_FOLLOW_UP' | 'PRACTICAL_EXAMPLE' | 'SCENARIO_DISCUSSION' | 'CLARIFICATION_FROM_CANDIDATE' | 'TRANSITION_TO_ASSESSMENT'>",
  "replyText": "<concise, natural answer in candidate language, connecting to salon context if appropriate>",
  "probeQuestion": "<optional follow-up or scenario question, or empty string>",
  "suggestedNextAction": "<'CONTINUE_INQUIRY' | 'RESOLVE_AND_PROMPT_QUESTION' | 'DEFER_TO_ONBOARDING'>"
}`;

  if (generateTextImpl === generateText && isQuotaExhausted()) {
    const error = new Error("GEMINI_FREE_TIER_QUOTA_EXHAUSTED: Request blocked by quota exhaustion circuit-breaker.");
    error.name = "RateLimitError";
    error.code = "AI_RATE_LIMIT";
    error.status = 429;
    error.isQuotaExhausted = true;
    console.warn("[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED", {
      action: "generateInquiryResponse_blocked_by_circuit_breaker",
    });
    throw error;
  }

  let raw;
  try {
    raw = await withTimeout(
      generateTextImpl(prompt),
      timeoutMs,
      "Inquiry response generation timed out",
    );
  } catch (error) {
    const message = error?.message || "";
    if (isQuotaExhaustedError(error)) {
      error.code = "AI_RATE_LIMIT";
      error.isQuotaExhausted = true;
      if (generateTextImpl === generateText) {
        markQuotaExhausted();
      }
    } else if (/temporarily unavailable|503/i.test(message)) {
      error.code = "AI_INTERPRETATION_UNAVAILABLE";
    }
    throw error;
  }

  if (typeof raw !== "string" || !raw.trim()) {
    const emptyErr = new Error("Model returned empty response for inquiry");
    emptyErr.code = "AI_INVALID_STRUCTURE";
    throw emptyErr;
  }

  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const parseErr = new Error("Model returned invalid JSON for inquiry response");
    parseErr.code = "AI_MALFORMED_JSON";
    throw parseErr;
  }

  if (!parsed || typeof parsed !== "object") {
    const structErr = new Error("Model returned non-object for inquiry response");
    structErr.code = "AI_INVALID_STRUCTURE";
    throw structErr;
  }

  const replyText = typeof parsed.replyText === "string" ? parsed.replyText.trim() : "";
  if (replyText.length < 3 || replyText.length > 1000) {
    const lenErr = new Error("Invalid replyText length in model inquiry response");
    lenErr.code = "AI_INVALID_STRUCTURE";
    throw lenErr;
  }

  const topicCandidate = typeof parsed.topic === "string" ? parsed.topic.trim().toLowerCase() : "";
  const topic = ALLOWED_INQUIRY_TOPICS.includes(topicCandidate)
    ? topicCandidate
    : (/^[a-z0-9_]{3,40}$/i.test(topicCandidate) ? topicCandidate : (activeInquiryTopic && ALLOWED_INQUIRY_TOPICS.includes(activeInquiryTopic) ? activeInquiryTopic : "general_inquiry"));

  const probeQuestion = typeof parsed.probeQuestion === "string"
    ? parsed.probeQuestion.trim().slice(0, 500)
    : "";

  const suggestedNextAction = ALLOWED_NEXT_ACTIONS.includes(parsed.suggestedNextAction)
    ? parsed.suggestedNextAction
    : "RESOLVE_AND_PROMPT_QUESTION";

  const followUpDecision = typeof parsed.followUpDecision === "string"
    ? parsed.followUpDecision.trim()
    : "DIRECT_ANSWER";

  const conversationalReasoning = typeof parsed.conversationalReasoning === "string"
    ? parsed.conversationalReasoning.trim()
    : "";

  // Safety Hardening: block unsupported policy claims or invented promises
  if (isUnsupportedPolicyClaim(replyText) || isUnsupportedPolicyClaim(probeQuestion)) {
    const policyErr = new Error("Model generated unsupported policy claim or guarantee");
    policyErr.code = "AI_UNSUPPORTED_POLICY_CLAIM";
    throw policyErr;
  }

  return {
    topic,
    replyText,
    probeQuestion,
    followUpDecision,
    conversationalReasoning,
    suggestedNextAction,
  };
}

module.exports = {
  generateText,
  interpretAnswer,
  fallbackInterpretation,
  UNIFIED_INTENTS,
  normalizeIntent,
  INTERPRETATION_REQUEST_OPTIONS,
  sanitizeExtractedFacts,
  extractFallbackFacts,
  formatMemoryContext,
  generateInquiryResponse,
  formatInquiryMemoryContext,
  isUnsupportedPolicyClaim,
  UNSUPPORTED_POLICY_PATTERNS,
  ALLOWED_INQUIRY_TOPICS,
  UC_GROUNDED_FACTS,
  INQUIRY_POLICY_CONSTRAINTS,
  ALLOWED_NEXT_ACTIONS,
  DEFAULT_INQUIRY_TIMEOUT_MS,
  INQUIRY_TIMEOUT_MS,
  isQuotaExhaustedError,
  isQuotaExhausted,
  markQuotaExhausted,
  resetQuotaExhaustion,
};
