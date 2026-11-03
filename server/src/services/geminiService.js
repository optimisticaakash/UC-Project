const { detectCounterQuestion } = require("./counterQuestions");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const INTERPRETATION_TIMEOUT_MS = 15000;
const INTERPRETATION_REQUEST_OPTIONS = Object.freeze({
  retries: Object.freeze({ strategy: "none" }),
  timeout_ms: INTERPRETATION_TIMEOUT_MS,
});

const RELEVANT_PATTERNS =
  /\b(politely|polite|respectfully|calmly|patiently|courteously|customer|client|grahak|listen|listening|sunungi|sununga|sunti hoon|sunta hoon|samjhaungi|samjhaunga|help karungi|help karunga|sorry|apologize|apologise|maafi|relocate|relocation|travel|shift|shifting|saal|sal|years?|yrs?|yr|mahine|mahina|din|weeks?|months?|days?|ready|willing|kar sakti hoon|kar sakta hoon|kar paungi|kar paunga|mummy|mumma|maa|mother|papa|father|family|parivaar|ghar|rehte|rehti|rehta|sambhalti|sambhalta|waxing|wax|facial|cleanup|threading|manicure|pedicure|haircut|bleach|d-?tan|massage|spa|salon|beauty|parlour|parlor|scooty|bike|bus|auto|metro|vehicle|conveyance|two\s*wheeler|anubhav|experience|kaam\s+kiya)\b/i;

const SHORT_DIRECT_ANSWER_PATTERNS =
  /^(?:(?:\d{1,2}|ek|do|teen|chaar|char|panch|paanch|chheh|cheh|saat|aath|nau|das|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:saal|sal|years?|yrs?|mahine|months?)(?:\s+(?:ka)?(?:\s+(?:experience|anubhav|kaam))?)?|fresh|fresher|(?:(?:only\s+|sirf\s+)?(?:waxing|wax|facial|cleanup|clean\s*up|threading|manicure|pedicure|mani\s*pedi|hair\s*styling|haircut|hair\s*cut|bleach|d-?tan|massage|makeup))|(?:(?:apni\s+|khud\s+ki\s+)?(?:bike|scooty|scooter|bus|metro|auto|two\s*wheeler|public\s+transport)(?:\s+(?:se|pe|par|through))?)|(?:delhi|new\s+delhi|noida|gurgaon|gurugram|bangalore|bengaluru|mumbai|pune|hyderabad|chennai|kolkata|jaipur|lucknow|chandigarh))[.!?।\s]*$/iu;

const IRRELEVANT_PATTERNS =
  /\b(aaloo|aloo|potato|biryani|pizza|burger|maggi|cricket|football|movie|movies|cinema|anime|song|songs|dance|gaana|habba\s+jabba|bla\s+bla|blah\s+blah|asdf|qwerty|chair|table|desk|bottle|cat|dog|billi|kutta|weather|mausam|barish|rain|politics|election|chutkula|joke)\b/i;

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
    if (result.intent === "INTERVIEW_ANSWER" || result.intent === "PARTIAL_OR_AMBIGUOUS_ANSWER") {
      result.extractedFacts = extractFallbackFacts(params.answer || "");
    } else {
      result.extractedFacts = {};
    }
  }
  return result;
}

function computeFallbackInterpretation({ question = "", answer = "", questionId = null, language = "Hindi" }) {
  const trimmed = typeof answer === "string" ? answer.trim() : "";
  const isInaudibleMarker = !trimmed || /^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(trimmed);
  if (isInaudibleMarker) {
    const isEnglish = language === "English";
    return {
      intent: "UNINTELLIGIBLE_OR_NO_INPUT",
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
    { language },
  );
  if (cq.isCounterQuestion) {
    const isClarificationIntent = cq.intent === "CLARIFICATION_REQUEST";
    return {
      intent: cq.intent || "RELEVANT_COUNTER_QUESTION",
      confidence: 0.95,
      understoodAnswer: "",
      responseText: cq.reply,
      shouldRepeatPendingQuestion: true,
      understanding: `Candidate asked a ${isClarificationIntent ? "clarification" : "counter-question"} about ${cq.topic}.`,
      answerStatus: "counter_question",
      needsClarification: true,
      counterQuestionAnswer: cq.reply,
      clarificationQuestion: cq.reply,
      naturalAcknowledgement: "",
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
    /^(?:what\s+is|who\s+is|who\s+won|what\s+are|where\s+is|how\s+many|capital\s+of|weather\s+kaisa|score\s+kya)\b/i.test(a);

  const isOffTopicQuestion =
    isCandidateQuestion &&
    !cq.isCounterQuestion &&
    !answerHasContext;

  const isLikelyIrrelevant =
    (irrelevantPatterns.test(a) || isOffTopicQuestion) &&
    !answerHasContext &&
    !SHORT_DIRECT_ANSWER_PATTERNS.test(trimmed);

  const isOpenEnded =
    /\b(?:kya\s+karengi|kya\s+karenge|what\s+would\s+you\s+do|kaise|how|kahan|where|kyun|why|kitna|kitne|how\s+much|how\s+many|steps\s+bataiye|kya\s+farak|kya\s+dhyan|kaun\s+kaun|safar|routine|kaise\s+manage)\b/i.test(
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
    /^(?:not\s+sure|unsure|pata\s+nahi|pata\s+nahin|don't\s+know|dont\s+know|maybe|shayad|no\s+idea|samajh\s+nahi\s+aaya|पता\s+नहीं|शायद)[.!?।\s]*$/iu.test(a);

  if (isUncertain) {
    const probe = isEnglish
      ? "Could you please elaborate on that in a little more detail?"
      : "Kripya is baare mein thoda aur spasht batayein.";
    return {
      intent: "PARTIAL_OR_AMBIGUOUS_ANSWER",
      confidence: 0.9,
      understoodAnswer: "",
      responseText: probe,
      shouldRepeatPendingQuestion: false,
      understanding: "Candidate expressed uncertainty or hesitance.",
      answerStatus: "unclear",
      needsClarification: true,
      clarificationQuestion: probe,
      counterQuestionAnswer: "",
      naturalAcknowledgement: "",
    };
  }

  if (isOpenEnded && (isAffirmative || isNegative)) {
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
    (/\b(travel|relocate|shift|bike|scooty|bus|auto|metro|vehicle|conveyance|two\s*wheeler)\b/i.test(a) &&
      /\b(travel|relocate|shift|cluster|door|area|location)\b/i.test(q)) ||
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
      new RegExp(String.raw`\b${tgt}\b[^.!?।]{0,100}\b(?:agar|if|maybe|shayad|might)\b`, "i").test(lower)
    );
  };

  // Cities
  const cityMatch = lower.match(/\b(delhi|new\s+delhi|noida|gurgaon|gurugram|bangalore|bengaluru|mumbai|pune|hyderabad|chennai|kolkata|jaipur|lucknow|chandigarh)\b/i);
  if (cityMatch && !isHypotheticalTarget(cityMatch[1])) {
    const rawCity = cityMatch[1].toLowerCase();
    const formattedCity = rawCity === "new delhi" ? "New Delhi" :
      rawCity.charAt(0).toUpperCase() + rawCity.slice(1);
    facts.currentCity = formattedCity;
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

  for (const [key, val] of Object.entries(facts)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (["candidateName", "preferredLanguage", "currentCity", "localArea", "experience", "skills", "vehicle", "age", "hasChildren"].includes(key)) continue;
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
    return fallbackInterpretation({ question, answer: cleanAnswer, questionId, language, sessionMemory });
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

Your task is to classify the candidate's utterance into EXACTLY ONE of the following 6 intents:

1. "INTERVIEW_ANSWER"
   The candidate is answering the question.
   - Salon professionals often answer with concise, direct, or informal Hindi, Hinglish, or English.
   - Short answers that directly address the question (e.g. "Do saal", "2 years", "Waxing", "Facial and cleanup", "Bike se") are SUFFICIENT answers.
   - For confirmation or binary availability questions (e.g. "Kya aap training attend kar sakti hain?", "Kya pehle kisi app pe kaam kiya hai?", or name confirmation "Aapka naam [Name] hai, sahi hai na?"), a clear affirmative ("Haan", "Yes", "Bilkul sahi", "Haanji", "Yahi naam hai", "That's correct") or negative ("Nahi", "No", "Galat hai") is "sufficient". If candidate provides a corrected name (e.g. "Nahi, mera naam Sunita hai"), capture the corrected name in understoodAnswer.
   - For open-ended questions asking for explanations, experience details, customer scenarios ("Aap kya karengi?"), technical procedures, or background, a bare "yes", "no", "haan", or "nahi" is NOT sufficient and must be marked as "PARTIAL_OR_AMBIGUOUS_ANSWER" with a follow-up probe.
   - Set shouldRepeatPendingQuestion to false.
   - Provide a brief, natural, varied naturalAcknowledgement (e.g. "Achha, 2 saal ka anubhav hai.", "Theek hai, samajh gayi.", "Bahut badhiya.", "Understood, noted.") recognizing what they said. Avoid repeating identical phrases on every turn.

2. "RELEVANT_COUNTER_QUESTION"
   The candidate asks ANY legitimate question about the job, question purpose, salon equipment/samaan, safety, customer situations, training, earnings, or the interview process.
   - The candidate may ask unexpected questions that are NOT in any fixed list (e.g. asking why a question matters, asking about equipment like "Kya mujhe apna samaan khud lana padega?", asking about safety like "Agar mujhe client ke ghar unsafe feel ho toh main kya karun?", challenging an assumption like "Aap meri age pooch rahe hain lekin experience ko kaise consider karenge?", or asking what happens if they don't know a service answer).
   - Approved Grounded Facts (DO NOT invent company policy, salary figures, guarantees, or unsupported features):
     * Role: You are the AI screening assistant conducting preliminary qualification for Urban Company's salon-at-home services.
     * Recording: The interview is recorded solely for preliminary screening and quality evaluation.
     * Work Model: Salon-at-home service where bookings are arranged at customer homes within a local 3-4 km cluster of the partner's area.
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

4. "PARTIAL_OR_AMBIGUOUS_ANSWER"
   The candidate gives an incomplete, hesitant, or vague answer (e.g. for "How would you handle an unhappy customer?", candidate only says "I would talk to her"; or expresses uncertainty like "not sure", "shayad").
   - In responseText: ask one concise, contextually relevant follow-up probe.
   - Set shouldRepeatPendingQuestion to false.
   - NEVER issue an irrelevant-answer warning for a partial or hesitant answer.

5. "IRRELEVANT_OR_NONRESPONSIVE"
   The utterance is genuinely completely off-topic, unrelated conversation (e.g. "The weather is nice today, what did you eat?", talking about a cricket match, asking off-topic trivia like who won a sports match, or meaningless gibberish like "habba jabba", "asdf qwerty", food items, random objects).
   - STRICT RULES:
     * NEVER classify a relevant interview- or job-related candidate question as irrelevant. However, completely off-topic questions (e.g. sports scores, movie trivia, weather, political questions, general trivia) that have nothing to do with the interview or job should be classified as IRRELEVANT_OR_NONRESPONSIVE.
     * NEVER classify a short or grammatically imperfect Hindi/Hinglish answer as irrelevant if it relates to the question.
     * NEVER classify silence, breathing, or background noise as irrelevant.
     * Do NOT infer irrelevance merely because the answer differs from an expected keyword.
   - Set shouldRepeatPendingQuestion to true.
   - In responseText: polite message asking them to answer the question directly.

6. "UNINTELLIGIBLE_OR_NO_INPUT"
   The audio is blank, muffled noise, inaudible, or transcription failure.
   - Set shouldRepeatPendingQuestion to true.
   - In responseText: ask the candidate to repeat or type their response.
   - NEVER issue a warning penalty.

7. "extractedFacts" (Optional structured facts about the candidate):
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
  "intent": "INTERVIEW_ANSWER" | "RELEVANT_COUNTER_QUESTION" | "CLARIFICATION_REQUEST" | "PARTIAL_OR_AMBIGUOUS_ANSWER" | "IRRELEVANT_OR_NONRESPONSIVE" | "UNINTELLIGIBLE_OR_NO_INPUT",
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

    let intent = result.intent;
    if (!intent) {
      if (result.answerStatus === "counter_question") intent = "RELEVANT_COUNTER_QUESTION";
      else if (result.answerStatus === "partial") intent = "PARTIAL_OR_AMBIGUOUS_ANSWER";
      else if (result.answerStatus === "irrelevant") intent = "IRRELEVANT_OR_NONRESPONSIVE";
      else if (result.answerStatus === "sufficient") intent = "INTERVIEW_ANSWER";
      else intent = result.needsClarification ? "PARTIAL_OR_AMBIGUOUS_ANSWER" : "INTERVIEW_ANSWER";
    }

    // Safety guard 1: Counter-question / Clarification protection
    const cq = detectCounterQuestion(cleanAnswer, { text: question }, { language });
    if (cq.isCounterQuestion) {
      const wasIrrelevant = intent === "IRRELEVANT_OR_NONRESPONSIVE" || result.intent === "IRRELEVANT_OR_NONRESPONSIVE";
      intent = cq.intent || "RELEVANT_COUNTER_QUESTION";
      result.answerStatus = "counter_question";
      result.needsClarification = true;
      result.shouldRepeatPendingQuestion = true;
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

    const answerStatus =
      result.answerStatus ||
      (intent === "INTERVIEW_ANSWER" ? "sufficient" :
       intent === "RELEVANT_COUNTER_QUESTION" ? "counter_question" :
       intent === "CLARIFICATION_REQUEST" ? "clarification" :
       intent === "PARTIAL_OR_AMBIGUOUS_ANSWER" ? "partial" :
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
      confidence: typeof result.confidence === "number" ? result.confidence : 0.9,
      understoodAnswer: (result.understoodAnswer || result.understanding || "").trim(),
      responseText,
      shouldRepeatPendingQuestion: result.shouldRepeatPendingQuestion !== undefined
        ? Boolean(result.shouldRepeatPendingQuestion)
        : (intent === "RELEVANT_COUNTER_QUESTION" || intent === "CLARIFICATION_REQUEST" || intent === "IRRELEVANT_OR_NONRESPONSIVE" || intent === "UNINTELLIGIBLE_OR_NO_INPUT"),
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

module.exports = {
  generateText,
  interpretAnswer,
  fallbackInterpretation,
  INTERPRETATION_REQUEST_OPTIONS,
  sanitizeExtractedFacts,
  extractFallbackFacts,
  formatMemoryContext,
};
