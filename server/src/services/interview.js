const crypto = require("crypto");
const path = require("path");

const { classifyConsent, classifyLanguage } = require("./rules/consentRules");
const { evaluateAge } = require("./rules/ageRules");
const { classifyLocation } = require("./rules/locationRules");
const { interpretAnswer } = require("./geminiService");

const bankPath = path.join(__dirname, "../data/questionBank.json");
const bank = require(bankPath);

if (!Array.isArray(bank.questions) || bank.questions.length !== 50) {
  throw new Error("Invalid questionBank.json: expected exactly 50 questions.");
}

const questions = bank.questions.map((item) => ({
  ...item,
  id: item.id || item.Step,
  text: item.text || item["Bot says (primary)"] || item["Bot says(primary)"],
  category: item.category || item.Block || "unknown",
}));

if (questions.some((question) => !question.id || !question.text)) {
  throw new Error("A question is missing its ID or text.");
}

const sessions = new Map();
const CHILD_FOLLOW_UP_IDS = new Set(["A4", "A5"]);
const ROMANIZED_CHILD = String.raw`(?:bachch(?:a|e|on)?|bacch(?:a|e|on)?|bach(?:a|e|on)?)`;
const NO_CHILDREN_PATTERN = new RegExp(
  String.raw`\b(?:i\s+)?(?:do\s+not|don't|dont)\s+have\s+(?:(?:any|my)\s+)?(?:children|kids?|child)\b|\bno\s+(?:children|kids?|child)\b|\bchildless\b|\b(?:mere|meri|hamare|hamari|ghar\s+mein|ghar\s+me|mujhe)\s+(?:ghar\s+mein\s+)?(?:koi\s+)?${ROMANIZED_CHILD}\s+(?:bilkul\s+)?(?:nahi|nahin|nhi)(?:\s+(?:hai|hain))?|\b(?:koi\s+)?${ROMANIZED_CHILD}\s+(?:bilkul\s+)?(?:nahi|nahin|nhi)(?:\s+(?:hai|hain))?|(?:मेरे|मेरी|हमारे|हमारी)?\s*(?:घर\s+में\s+)?(?:कोई\s+)?(?:बच्चे|बच्चा|बच्चों|बच्ची|बच्चियाँ)\s*(?:बिल्कुल\s*)?(?:नहीं|नही)(?:\s*(?:है|हैं))?`,
  "giu",
);
const CHILD_MENTION_PATTERN = new RegExp(
  String.raw`\b(?:children|child|kids?|sons?|daughters?|${ROMANIZED_CHILD}|beta|beti|putra|putri)\b|(?:बच्चे|बच्चा|बच्चों|बच्ची|बच्चियाँ|बेटा|बेटी|पुत्र|पुत्री)`,
  "iu",
);

function classifyChildPresence(answer) {
  const normalized = answer.normalize("NFC").toLowerCase();
  const hasNegativeStatement = normalized.match(NO_CHILDREN_PATTERN) !== null;
  const remainder = normalized.replace(NO_CHILDREN_PATTERN, " ");
  const hasPositiveMention = CHILD_MENTION_PATTERN.test(remainder);

  if (hasNegativeStatement && hasPositiveMention) return "ambiguous";
  if (hasNegativeStatement) return "none";
  if (hasPositiveMention) return "present";
  return "unknown";
}

function classifyYesNo(answer) {
  const normalized = answer.normalize("NFC").trim().toLowerCase();
  if (/^(?:haan|han|yes|yeah|yep|ji|bilkul|हाँ|हां|जी|जी हाँ|जी हां)[.!?।\s]*$/iu.test(normalized)) {
    return "yes";
  }
  if (/^(?:nahi|nahin|nhi|no|नहीं|नही)[.!?।\s]*$/iu.test(normalized)) {
    return "no";
  }
  return null;
}

function childDetailsProvided(answer) {
  const normalized = answer.normalize("NFC").toLowerCase();
  const classDetails = /\b(?:class|grade|standard)\s*\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s+(?:class|grade|standard)\b|(?:कक्षा|क्लास)\s*\d{1,2}|\d{1,2}\s*(?:वीं|वां)\s*(?:कक्षा|क्लास)/iu.test(normalized);
  const childRef = String.raw`(?:children|child|kids?|${ROMANIZED_CHILD}|बच्चे|बच्चा|बच्चों|बेटा|बेटी)`;
  const caregiver = String.raw`(?:look after|takes care|care for|watches|stay(?:s|ing)? with|with (?:them|their|my)|picked up|saath reht|saath hot|sambhal|dekh.?bhaal|dekhte|dekhati|देखभाल|देखते|देखती|साथ रहते|साथ रहती|साथ होते)`;
  const caregiverDetails = new RegExp(
    String.raw`(?:${childRef}.{0,70}${caregiver}|${caregiver}.{0,70}${childRef})`,
    "iu",
  ).test(normalized);

  return { classDetails, caregiverDetails };
}

function advanceToNextApplicableQuestion(session) {
  session.invalidAttempts = {};
  session.currentQuestionIndex += 1;
  const childInfo = session.childQuestionApplicability;

  while (session.currentQuestionIndex < questions.length) {
    const nextId = questions[session.currentQuestionIndex].id;
    if (!CHILD_FOLLOW_UP_IDS.has(nextId)) break;

    const skipBecauseNoChildren = childInfo?.hasChildren === false;
    const skipBecauseAlreadyAnswered =
      (nextId === "A4" && childInfo?.classDetailsProvided) ||
      (nextId === "A5" && childInfo?.caregiverDetailsProvided);

    if (!skipBecauseNoChildren && !skipBecauseAlreadyAnswered) break;
    session.currentQuestionIndex += 1;
  }
}

function startInterview({ candidateId } = {}) {
  const sessionId = crypto.randomUUID();

  const session = {
    sessionId,
    ...(candidateId ? { candidateId } : {}),
    currentQuestionIndex: 0,
    answers: [],
    status: "in_progress",
    manualReviewRequired: false,
    manualReviewPaused: false,
    consentOutcome: "pending",
    language: null,
    invalidAttempts: {},
    startedAt: new Date().toISOString(),
    completedAt: null,
    endedAt: null,
  };

  sessions.set(sessionId, session);

  return {
    success: true,
    sessionId,
    totalQuestions: questions.length,
    questionNumber: 1,
    question: questions[0],
  };
}

function getSessionSnapshot(sessionId) {
  const session = sessions.get(sessionId);
  return session ? structuredClone(session) : null;
}

function restoreSessionSnapshot(sessionId, snapshot) {
  if (snapshot) sessions.set(sessionId, structuredClone(snapshot));
  else sessions.delete(sessionId);
}

function restoreSessions(restoredSessions) {
  sessions.clear();
  for (const session of restoredSessions) {
    if (session?.sessionId && session.status && session.startedAt) {
      sessions.set(session.sessionId, session);
    }
  }
  return sessions.size;
}

function getSessionForPersistence(sessionId) {
  return sessions.get(sessionId) || null;
}

const KNOWN_NONSENSE_TOKENS = new Set([
  "habba", "jabba", "bla", "blah", "asdf", "qwerty", "zxcv", "test", "testing",
  "foo", "bar", "baz", "qux", "xyz", "abc", "na", "none", "unknown", "random",
  "kuch", "bhi", "koi", "biryani", "pizza", "burger", "samosa", "chair", "table",
]);

function formatCandidateName(name) {
  if (!name || typeof name !== "string") return name;
  return name
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (!/^[a-zA-Z]/u.test(word)) return word;
      if (/^[a-zA-Z]['’][a-zA-Z]/u.test(word)) {
        return word.charAt(0).toUpperCase() + word.charAt(1) + word.charAt(2).toUpperCase() + word.slice(3).toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function isSaneName(name) {
  if (!name || typeof name !== "string") return false;
  const cleaned = name.trim().toLowerCase();
  if (cleaned.length < 2) return false;
  if (/(.)\1{2,}/u.test(cleaned)) return false;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  if (tokens.some((t) => KNOWN_NONSENSE_TOKENS.has(t))) return false;
  if (/\b(?:habba\s+jabba|jabba\s+habba|bla\s+bla|blah\s+blah|asdf\s+qwerty)\b/iu.test(cleaned)) return false;

  const hasSubstantialToken = tokens.some((t) => t.replace(/[^a-zA-Z\p{L}]/gu, "").length >= 2);
  for (const t of tokens) {
    const lettersOnly = t.replace(/[^a-zA-Z\p{L}]/gu, "");
    if (lettersOnly.length === 1 && !hasSubstantialToken) return false;
    if (lettersOnly.length >= 3 && /^[a-z]+$/i.test(lettersOnly) && !/[aeiouy]/i.test(lettersOnly)) return false;
  }
  return true;
}

function getCurrentQuestionForSession(session) {
  if (session.pendingFollowUp) {
    const isProbe = session.pendingFollowUp.type === "contextual_probe";
    const suffix = isProbe ? "FOLLOW_UP" : session.pendingFollowUp.type.toUpperCase();
    return {
      id: `${session.pendingFollowUp.questionId}_${suffix}`,
      Step: `${session.pendingFollowUp.questionId}_${suffix}`,
      text: session.pendingFollowUp.prompt,
      category: session.pendingFollowUp.category || "Location & movement",
    };
  }
  return questions[session.currentQuestionIndex] || null;
}

function classifyNameAnswer(answer) {
  if (typeof answer !== "string") {
    return { clear: false, format: "non_string" };
  }

  const normalized = answer
    .normalize("NFC")
    .replace(/[.!?।]+$/u, "")
    .trim();

  if (!normalized) return { clear: false, format: "empty" };

  // Strip leading polite conversational greetings/fillers:
  // "Namaste", "Namaskar", "Hello", "Hi", "Ji", "Haan", "Haanji", "Yes", "Ha", etc.
  const strippedGreeting = normalized
    .replace(/^(?:(?:namaste|namaskar|hello|hi|hey|ji|haan|han|haanji|hanji|yes|ha|acha|achha)\s*[,.:;!-]*\s*)+/iu, "")
    .trim();

  const working = strippedGreeting || normalized;

  const uncertainty =
    /^(?:(?:(?:mera naam|मेरा नाम|my name is)\s+)?(?:pata nahi|nahi pata|yaad nahi|nahi yaad|nahi maloom|kya hai|i don't know|i do not know|not sure|don't know|no idea|samajh nahi aaya)|hmm+|umm+|uh+|naam nahi pata|पता नहीं|याद नहीं|समझ नहीं आया)$/iu;
  if (uncertainty.test(working) || uncertainty.test(normalized)) {
    return { clear: false, format: "uncertainty" };
  }

  const bareAffirmation = /^(?:haan|han|yes|ji|theek hai|thik hai|ok|okay|sahi hai|ha)$/iu;
  if (bareAffirmation.test(working) || bareAffirmation.test(normalized)) {
    return { clear: false, format: "bare_affirmation" };
  }

  const nameToken = String.raw`[\p{L}][\p{L}\p{M}'’.-]*`;
  const nameSequence = String.raw`${nameToken}(?:\s+${nameToken}){0,3}`;
  const plainNameRegex = new RegExp(`^${nameSequence}$`, "u");

  const phraseMeraNaam = new RegExp(
    String.raw`^(?:mera naam|मेरा नाम|my name is)\s+(.+?)(?:\s+(?:hai|है|hoon|हूँ|hai ji|jee))?$`,
    "iu",
  );
  const phraseMainHoon = new RegExp(
    String.raw`^(?:main|mai|mein|मैं|i am|i'm)\s+(.+?)(?:\s+(?:hoon|हूँ|hai|है|bol rahi hoon|bol raha hoon|baat kar rahi hoon|baat kar raha hoon))?$`,
    "iu",
  );
  const phraseThisIs = new RegExp(
    String.raw`^(?:this is)\s+(.+?)$`,
    "iu",
  );
  const phraseSuffix = new RegExp(
    String.raw`^(.+?)\s+(?:bol rahi hoon|bol raha hoon|baat kar rahi hoon|baat kar raha hoon|here)$`,
    "iu",
  );
  const phraseCallMe = new RegExp(
    String.raw`^(?:aap mujhe|mujhko|mujhe)\s+(.+?)(?:\s+(?:bula sakti hain|bula sakte hain|bolte hain|kehte hain))?$`,
    "iu",
  );

  let candidate = null;
  let format = "unsupported_phrase";

  let match = phraseMeraNaam.exec(working);
  if (match) {
    candidate = match[1];
    format = "introduced_name";
  } else if ((match = phraseMainHoon.exec(working))) {
    candidate = match[1];
    format = "introduced_name";
  } else if ((match = phraseThisIs.exec(working))) {
    candidate = match[1];
    format = "introduced_name";
  } else if ((match = phraseCallMe.exec(working))) {
    candidate = match[1];
    format = "introduced_name";
  } else if ((match = phraseSuffix.exec(working))) {
    candidate = match[1];
    format = "introduced_name";
  } else if (plainNameRegex.test(working)) {
    const sentenceStarter = /^(?:i|we|my|mera|meri|mujhe|main|मैं|मेरा|मेरी|this|aap)\s/iu;
    if (!sentenceStarter.test(working)) {
      candidate = working;
      format = "plain_name";
    }
  }

  if (candidate) {
    const cleanedCandidate = candidate
      .replace(/\s+(?:hai|है|hoon|हूँ|hai ji|jee|ji|bol rahi hoon|bol raha hoon|baat kar rahi hoon|here)$/iu, "")
      .replace(/^[,\s.-]+|[,\s.-]+$/g, "")
      .trim();

    if (plainNameRegex.test(cleanedCandidate) && isSaneName(cleanedCandidate)) {
      const formattedName = formatCandidateName(cleanedCandidate);
      return { clear: true, format, name: formattedName };
    }
  }

  return { clear: false, format: "unsupported_phrase" };
}

function handleInvalidAttempt(session, question, {
  clarificationPrefix,
  warningPrefix,
  firstAttemptMessage,
  secondAttemptMessage,
  repeatQuestionText,
} = {}) {
  session.invalidAttempts = session.invalidAttempts || {};
  const currentAttempts = (session.invalidAttempts[question.id] || 0) + 1;
  session.invalidAttempts[question.id] = currentAttempts;

  const originalQuestionText = repeatQuestionText || question.text;

  if (currentAttempts === 1) {
    const prefix =
      clarificationPrefix ||
      "Maaf kijiye, mujhe samajh nahi aaya ki ye sawal ka jawab kaise hai. Kripya is sawal ka seedha jawab dein";
    const message =
      firstAttemptMessage || `${prefix}: ${originalQuestionText}`;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        clarificationRequired: true,
        warningLevel: 1,
        warning: false,
        warningMessage: prefix,
        repeatedQuestionText: originalQuestionText,
        message,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: getCurrentQuestionForSession(session),
      },
    };
  }

  if (currentAttempts === 2) {
    const prefix =
      warningPrefix ||
      "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya is sawal ka seedha aur spasht jawab dein";
    const message =
      secondAttemptMessage || `${prefix}: ${originalQuestionText}`;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        clarificationRequired: true,
        warningLevel: 2,
        warning: true,
        warningMessage: prefix,
        repeatedQuestionText: originalQuestionText,
        message,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: getCurrentQuestionForSession(session),
      },
    };
  }

  // Attempt 3: terminate session gracefully.
  session.status = "terminated";
  session.terminationReason = "repeated_invalid_answers";
  session.terminatedAt = new Date().toISOString();
  session.terminatedAtQuestionId = question.id;
  session.completedAt = session.terminatedAt;
  session.endedAt = session.terminatedAt;

  const terminationMessage =
    "Teen baar koshish karne ke baad bhi relevant jawab na milne ki wajah se interview aage nahi badh sakta. Aapka interview yahin samapt hota hai.";

  return {
    status: 200,
    body: {
      success: true,
      completed: true,
      terminated: true,
      sessionStatus: "terminated",
      terminationReason: session.terminationReason,
      terminatedAtQuestionId: question.id,
      terminatedAt: session.terminatedAt,
      message: terminationMessage,
      answeredQuestions: session.answers.length,
      totalQuestions: questions.length,
    },
  };
}

function getNaturalAcknowledgement(question, session) {
  if (!question || !session) return null;
  const isEnglish = session.language === "English";
  const candidateName = session.candidateName ? session.candidateName.trim() : "";

  // 1. A2_NAME: Name captured
  if (question.id === "A2_NAME") {
    if (candidateName) {
      return isEnglish ? `Thank you, ${candidateName}.` : `Thank you, ${candidateName} ji!`;
    }
    return isEnglish ? "Thank you." : "Thank you ji!";
  }

  // 2. A0: Consent & Language selection
  if (question.id === "A0") {
    return isEnglish ? "Thank you, understood." : "Theek hai, shukriya.";
  }

  // 3. A1: Location & Movement
  if (question.id === "A1") {
    return isEnglish ? "Understood, thank you." : "Achha, samajh gayi.";
  }

  // 4. A2: Age / Date of birth
  if (question.id === "A2") {
    return isEnglish ? "Thank you, noted." : "Theek hai, noted.";
  }

  // 5. A3 to A8: Family background, salon experience, salon setup
  if (["A3", "A4", "A5", "A6", "A7", "A8"].includes(question.id)) {
    return isEnglish ? "Thank you for sharing that." : "Achha, samajh gayi.";
  }

  // 6. A9 to A11: Travel readiness, conveyance, language fluency
  if (["A9", "A10", "A11"].includes(question.id)) {
    return isEnglish ? "Understood, thank you." : "Theek hai, samajh gayi.";
  }

  // 7. Stage B: Technical skill evaluation (waxing, facial, threading, manicure, etc.)
  if (question.id.startsWith("B")) {
    return isEnglish ? "Thank you for sharing that." : "Achha, theek hai.";
  }

  // 8. Stage C: Customer handling scenarios & salon ethics
  if (question.id.startsWith("C")) {
    return isEnglish ? "Understood, thank you for explaining." : "Achha, samajh gayi.";
  }

  // Fallback:
  return isEnglish ? "Thank you." : "Theek hai, samajh gayi.";
}

async function submitAnswer({
  sessionId,
  answer,
  expectedQuestionId,
  diagnosticRequestId,
  diagnosticPromptTurn,
  diagnosticSessionGeneration,
}, { interpretAnswerImpl = interpretAnswer } = {}) {
  const session = sessions.get(sessionId);

  if (!session) {
    return {
      status: 404,
      body: {
        success: false,
        code: "SESSION_NOT_FOUND",
        message: "Interview session not found.",
      },
    };
  }

  if (session.status === "paused") {
    return {
      status: 409,
      body: {
        success: false,
        code: "INTERVIEW_PAUSED",
        message: "Interview is paused. Please resume before submitting an answer.",
        sessionStatus: "paused",
      },
    };
  }

  if (session.status === "terminated") {
    return {
      status: 409,
      body: {
        success: false,
        code: "INTERVIEW_TERMINATED",
        message: "This interview session has been terminated.",
        sessionStatus: "terminated",
      },
    };
  }

  if (session.status !== "in_progress") {
    return {
      status: 400,
      body: {
        success: false,
        message: "This interview session is not in progress.",
        sessionStatus: session.status,
      },
    };
  }

  if (session.manualReviewPaused) {
    return {
      status: 409,
      body: {
        success: false,
        manualReviewRequired: true,
        message: "Interview paused for manual review.",
      },
    };
  }

  const requestQuestionId =
    typeof expectedQuestionId === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(expectedQuestionId)
      ? expectedQuestionId
      : null;
  const safeRequestId =
    typeof diagnosticRequestId === "string" &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(diagnosticRequestId)
      ? diagnosticRequestId
      : null;
  const safePromptTurn =
    Number.isSafeInteger(diagnosticPromptTurn) && diagnosticPromptTurn >= 0
      ? diagnosticPromptTurn
      : null;
  const safeSessionGeneration =
    Number.isSafeInteger(diagnosticSessionGeneration) &&
    diagnosticSessionGeneration >= 0
      ? diagnosticSessionGeneration
      : null;
  const currentQuestion = getCurrentQuestionForSession(session);
  const currentQuestionId = currentQuestion?.id || null;
  const sessionKey = sessionId.slice(-8);

  function staleQuestionResponse() {
    const latestQuestion = getCurrentQuestionForSession(session);

    return {
      status: 409,
      body: {
        success: false,
        staleQuestion: true,
        currentQuestionId: latestQuestion?.id || null,
        clarificationRequired: Boolean(
          session.pendingFollowUp || session.pendingChildApplicability,
        ),
        followUpRequired: Boolean(session.pendingFollowUp),
        manualReviewRequired: Boolean(session.pendingFollowUp),
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: latestQuestion,
        message: "This answer belongs to an earlier question.",
      },
    };
  }

  if (expectedQuestionId && !requestQuestionId) {
    return {
      status: 400,
      body: {
        success: false,
        message: "Invalid expected question ID.",
      },
    };
  }

  if (requestQuestionId && requestQuestionId !== currentQuestionId) {
    console.info("[UC Interview Diagnostics] stale_answer_ignored", {
      requestId: safeRequestId,
      sessionKey,
      expectedQuestionId: requestQuestionId,
      currentQuestionId,
    });
    return staleQuestionResponse();
  }

  const question = questions[session.currentQuestionIndex];
  const isNameQuestion = question?.id === "A2_NAME";
  if (
    typeof answer !== "string" ||
    (!answer.trim() && !isNameQuestion)
  ) {
    return {
      status: 400,
      body: {
        success: false,
        message: "Please provide a non-empty answer.",
      },
    };
  }

  if (session.pendingChildApplicability) {
    const pending = session.pendingChildApplicability;
    let childPresence = classifyChildPresence(answer);

    if (childPresence === "unknown") {
      const yesNo = classifyYesNo(answer);
      childPresence = yesNo === "yes" ? "present" : yesNo === "no" ? "none" : "unknown";
    }

    if (childPresence === "unknown" || childPresence === "ambiguous") {
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message: "Please clarify whether you have children, so I ask only the relevant follow-up questions.",
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: questions[session.currentQuestionIndex],
        },
      };
    }

    const detailSource = `${pending.answerRecord.answer} ${answer}`;
    const details = childDetailsProvided(detailSource);
    pending.answerRecord.childPresence = childPresence;
    session.answers.push(pending.answerRecord);
    session.childQuestionApplicability = {
      hasChildren: childPresence === "present",
      classDetailsProvided: details.classDetails,
      caregiverDetailsProvided: details.caregiverDetails,
    };
    session.pendingChildApplicability = null;
    advanceToNextApplicableQuestion(session);

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: questions[session.currentQuestionIndex],
      },
    };
  }

  // Handle pending follow-ups safely.
  if (session.pendingFollowUp) {
    const pending = session.pendingFollowUp;
    const followUpAnswer = answer.trim();
    const normalized = followUpAnswer.toLowerCase();

    console.info("[UC Interview Diagnostics] answer_processing", {
      requestId: safeRequestId,
      sessionKey,
      expectedQuestionId: requestQuestionId || null,
      questionId: `${pending.questionId}_${pending.type.toUpperCase()}`,
      answerChars: followUpAnswer.length,
      path: "pending_follow_up",
      followUpType: pending.type,
    });

    const lastCheck = (session.manualChecks || [])
      .slice()
      .reverse()
      .find((item) => item.questionId === pending.questionId);

    const lastLocationAnswer = [...session.answers]
      .reverse()
      .find((item) => item.questionId === "A1");

    function saveFollowUp() {
      session.answers.push({
        questionId: `${pending.questionId}_${pending.type}`,
        questionText: pending.prompt,
        category: "Location & movement",
        answer: followUpAnswer,
        answeredAt: new Date().toISOString(),
      });

      if (lastCheck) {
        lastCheck.followUpAnswer = followUpAnswer;
      }
    }

    function askAgain(message) {
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message,
          followUpRequired: true,
          followUp: pending,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: `A1_${pending.type.toUpperCase()}`,
            Step: `A1_${pending.type.toUpperCase()}`,
            text: pending.prompt,
            category: "Location & movement",
          },
        },
      };
    }

    if (pending.type === "travel_clarification") {
      const locationClassification = classifyLocation(followUpAnswer);

      const isCrossQuestion =
        /\b(?:kyun|kyu|why|reason|zaruri\s+kyun|kyun\s+jana|door\s+kyun|kyun\s+zaruri)\b/i.test(
          normalized,
        );

      const isConveyanceConcern =
        /\b(?:gaadi|scooty|bike|vehicle|conveyance|two\s*wheeler|transport)\s*(?:nahi|nahin|nhi|chalana\s+nahi|chalati\s+nahi)\b|\b(?:no|don't\s+have|dont\s+have)\s*(?:vehicle|scooty|bike|car)\b|\bmera\s+paas\s+(?:gaadi|scooty|bike|vehicle)\s+nahi\b/i.test(
          normalized,
        );

      const isReluctantOrUnsure =
        /\b(?:difficult|mushkil|hard|problem|dikkat|issue|not\s+sure|unsure|pata\s+nahi|pata\s+nahin|pakka\s+nahi|doubt|shayad|no\s+idea|kuch\s+nahi\s+keh\s+sakti)\b/i.test(
          normalized,
        ) ||
        /^(?:maybe|shayad|not\s+sure|unsure|pata\s+nahi)[.!?\s]*$/i.test(normalized);

      const conflicting =
        (/\b(haan|yes)\b/i.test(normalized) || /हाँ|हां/.test(followUpAnswer)) &&
        (/\b(nahi|no)\b/i.test(normalized) || /नहीं|नही/.test(followUpAnswer));

      const positive =
        !isReluctantOrUnsure &&
        (/\b(haan|han|yes|yeah|yep|ready|bilkul|theek\s+hai|thik\s+hai)\b|(?<!not\s+)\bsure\b|\bwilling\b/i.test(
          normalized,
        ) ||
          locationClassification.travelWillingness === "yes" ||
          /हाँ|हां/.test(followUpAnswer) ||
          /travel kar sakti|travel kar sakta|shift ho sakti|shift ho sakta|move kar sakti|move kar sakta|can travel|can relocate|manage kar lungi|manage kar lunga|travel kar lungi/i.test(
            normalized,
          ));

      const negative =
        !isCrossQuestion &&
        !isConveyanceConcern &&
        !isReluctantOrUnsure &&
        (/\b(sirf\s+apne\s+area|travel\s+nahi|shift\s+nahi|move\s+nahi|door\s+nahi|nahi\s+kar\s+sakti|nahi\s+ja\s+sakti|cannot\s+travel|can't\s+travel|not\s+willing|possible\s+nahi|nahi\s+ho\s+payega)\b/i.test(
          normalized,
        ) ||
          /^(?:nahi|nahin|nhi|no|never|नहीं|नही)[.!?।\s]*$/iu.test(normalized) ||
          /नहीं.*(जा|कर|शिफ्ट|ट्रैवल|यात्रा|रिलोकेट)|नही.*(जा|कर|शिफ्ट|ट्रैवल|यात्रा|रिलोकेट)/.test(
            followUpAnswer,
          ));

      if (conflicting) {
        return askAgain(
          "Please clarify: are you willing to travel or relocate if required?",
        );
      }

      if (isCrossQuestion) {
        pending.prompt =
          "Urban Company salon-at-home service hai, isliye professionals ko apne area ke 3-4 km cluster mein clients ke ghar jaana hota hai. Kya aap public transport, auto ya kisi aur tareeqe se manage kar sakti hain?";
        return askAgain(pending.prompt);
      }

      if (isConveyanceConcern) {
        pending.prompt =
          "Main samajh sakti hoon. Kaam aapke area ke 3-4 km cluster mein hi hota hai. Kya aap bus, auto ya family help se travel karne ke liye comfortable hain?";
        return askAgain(pending.prompt);
      }

      if (isReluctantOrUnsure && !pending.probeGiven) {
        pending.probeGiven = true;
        pending.prompt =
          "Main samajh sakti hoon. Travel ko lekar kya dikkat ho sakti hai — conveyance ki wajah se ya timing ki wajah se?";
        return askAgain(pending.prompt);
      }

      if (isReluctantOrUnsure && pending.probeGiven) {
        saveFollowUp();
        session.travelWillingness = "uncertain";
        if (lastLocationAnswer) {
          lastLocationAnswer.travelWillingness = "uncertain";
        }
        if (lastCheck) {
          lastCheck.travelWillingness = "uncertain";
        }
        session.manualChecks = session.manualChecks || [];
        session.manualChecks.push({
          questionId: "A1",
          outcome: "travel_willingness_uncertain",
          followUpAnswer,
          required: true,
          createdAt: new Date().toISOString(),
        });
        session.manualReviewRequired = true;
        session.pendingFollowUp = null;
        advanceToNextApplicableQuestion(session);

        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            acknowledgement: getNaturalAcknowledgement(question, session),
            manualReviewRequired: true,
            followUpCaptured: true,
            acknowledgement: getNaturalAcknowledgement(question, session),
            travelWillingness: "uncertain",
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: questions[session.currentQuestionIndex],
          },
        };
      }

      if (!negative && !positive) {
        return handleInvalidAttempt(
          session,
          {
            id: "A1_TRAVEL_CLARIFICATION",
            text: pending.prompt,
          },
          {
            clarificationPrefix:
              "Maaf kijiye, mujhe samajh nahi aaya. Kripya batayein ki kya aap travel ya shift karne ke liye taiyaar hain",
            warningPrefix:
              "Aapka jawab is sawal se juda hua nahi hai. Ye aapka aakhri attempt hai. Kripya seedhe batayein",
            repeatQuestionText: pending.prompt,
          },
        );
      }

      session.invalidAttempts = {};

      saveFollowUp();

      session.travelWillingness = negative ? "no" : "yes";
      if (lastLocationAnswer) {
        lastLocationAnswer.travelWillingness = negative ? "no" : "yes";
      }

      if (lastCheck) {
        lastCheck.travelWillingness = negative ? "no" : "yes";
      }

      if (negative) {
        session.pendingFollowUp = null;
        session.currentQuestionIndex += 1;

        if (session.currentQuestionIndex >= questions.length) {
          session.status = "completed";
          session.completedAt = new Date().toISOString();

          return {
            status: 200,
            body: {
              success: true,
              completed: true,
              manualReviewRequired: true,
              followUpCaptured: true,
              answeredQuestions: session.answers.length,
              totalQuestions: questions.length,
            },
          };
        }

        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            acknowledgement: getNaturalAcknowledgement(question, session),
            manualReviewRequired: true,
            followUpCaptured: true,
            acknowledgement: getNaturalAcknowledgement(question, session),
            travelWillingness: "no",
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: questions[session.currentQuestionIndex],
          },
        };
      }

      session.pendingFollowUp = {
        questionId: "A1",
        type: "move_timeline",
        prompt: "Agar shift hona pade, to aap kab tak shift ho sakti hain?",
      };

      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          acknowledgement: getNaturalAcknowledgement(question, session),
          manualReviewRequired: true,
          followUpRequired: true,
          followUp: session.pendingFollowUp,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A1_MOVE_TIMELINE",
            Step: "A1_MOVE_TIMELINE",
            text: session.pendingFollowUp.prompt,
            category: "Location & movement",
          },
        },
      };
    }

    if (pending.type === "move_timeline") {
      const unclear =
        /^(pata nahi|pata nahin|not sure|don't know|dont know|unsure|maybe|shayad)[.!?\s]*$/i.test(
          normalized,
        );

      if (unclear) {
        return askAgain(
          "Aap kab tak shift ho sakti hain? Agar abhi pakka nahi hai, toh approximate time batayein.",
        );
      }

      saveFollowUp();

      if (lastCheck) {
        lastCheck.moveTimelineAnswer = followUpAnswer;
      }

      session.pendingFollowUp = null;
      session.invalidAttempts = {};
      session.currentQuestionIndex += 1;

      if (session.currentQuestionIndex >= questions.length) {
        session.status = "completed";
        session.completedAt = new Date().toISOString();

        return {
          status: 200,
          body: {
            success: true,
            completed: true,
            manualReviewRequired: true,
            followUpCaptured: true,
            answeredQuestions: session.answers.length,
            totalQuestions: questions.length,
          },
        };
      }

      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          acknowledgement: getNaturalAcknowledgement(question, session),
          manualReviewRequired: true,
          followUpCaptured: true,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: questions[session.currentQuestionIndex],
        },
      };
    }

    if (pending.type === "contextual_probe") {
      const isCrossQuestion =
        /\b(?:kyun|kyu|why|reason|zaruri\s+kyun|kyun\s+jana|door\s+kyun|kyun\s+zaruri)\b/i.test(
          normalized,
        );
      const isConveyanceConcern =
        /\b(?:gaadi|scooty|bike|vehicle|conveyance)\s*(?:nahi|nahin|nhi)\b|\b(?:no|don't\s+have|dont\s+have)\s*(?:vehicle|scooty|bike)\b/i.test(
          normalized,
        );

      if (pending.questionId === "A9" && isCrossQuestion && !pending.explainedReason) {
        pending.explainedReason = true;
        pending.prompt =
          "Urban Company salon-at-home service hai, isliye professionals ko apne area ke 3-4 km cluster mein clients ke ghar jana hota hai. Kya aap public transport, auto ya family help se manage kar sakti hain?";
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            followUpRequired: true,
            followUp: pending,
            message: pending.prompt,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: {
              id: `${pending.questionId}_FOLLOW_UP`,
              Step: `${pending.questionId}_FOLLOW_UP`,
              text: pending.prompt,
              category: pending.category || "Travel",
            },
          },
        };
      }

      if (pending.questionId === "A9" && isConveyanceConcern && !pending.exploredOptions) {
        pending.exploredOptions = true;
        pending.prompt =
          "Samajh gayi. Kaam aapke area ke aas-paas ke 3-4 km cluster mein hi hota hai. Kya aap bus, auto ya family drop se travel kar sakti hain?";
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            followUpRequired: true,
            followUp: pending,
            message: pending.prompt,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: {
              id: `${pending.questionId}_FOLLOW_UP`,
              Step: `${pending.questionId}_FOLLOW_UP`,
              text: pending.prompt,
              category: pending.category || "Travel",
            },
          },
        };
      }

      const isStillUnclear =
        /^(?:pata\s+nahi|pata\s+nahin|not\s+sure|don't\s+know|dont\s+know|unsure|maybe|shayad|no\s+idea|samajh\s+nahi\s+aaya|skip|aage\s+badho|pass)[.!?\s]*$/i.test(
          normalized,
        );

      session.answers.push({
        questionId: `${pending.questionId}_FOLLOW_UP`,
        parentQuestionId: pending.questionId,
        questionText: pending.prompt,
        category: pending.category || "General",
        originalAnswer: pending.originalAnswer,
        answer: followUpAnswer,
        answeredAt: new Date().toISOString(),
        isFollowUp: true,
      });

      if (isStillUnclear) {
        session.manualChecks = session.manualChecks || [];
        session.manualChecks.push({
          questionId: pending.questionId,
          outcome: "uncertain_after_followup",
          originalAnswer: pending.originalAnswer,
          followUpAnswer,
          required: true,
          createdAt: new Date().toISOString(),
        });
        session.manualReviewRequired = true;
      }

      session.pendingFollowUp = null;
      advanceToNextApplicableQuestion(session);

      if (session.currentQuestionIndex >= questions.length) {
        session.status = "completed";
        session.completedAt = new Date().toISOString();

        return {
          status: 200,
          body: {
            success: true,
            completed: true,
            manualReviewRequired: Boolean(session.manualReviewRequired),
            followUpCaptured: true,
            answeredQuestions: session.answers.length,
            totalQuestions: questions.length,
          },
        };
      }

      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          manualReviewRequired: Boolean(session.manualReviewRequired),
          followUpCaptured: true,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: questions[session.currentQuestionIndex],
        },
      };
    }

    return askAgain("Please clarify your answer.");
  }

  const cleanAnswer = answer.trim();

  console.info("[UC Interview Diagnostics] answer_processing", {
    requestId: safeRequestId,
    sessionKey,
    expectedQuestionId: requestQuestionId || null,
    promptTurn: safePromptTurn,
    sessionGeneration: safeSessionGeneration,
    questionId: question.id,
    answerChars: cleanAnswer.length,
    path: "question",
  });

  const answerRecord = {
    questionId: question.id,
    questionText: question.text,
    category: question.category,
    answer: cleanAnswer,
    answeredAt: new Date().toISOString(),
  };
  const pendingInterpretation = session.pendingInterpretation?.questionId === question.id
    ? session.pendingInterpretation
    : null;
  if (pendingInterpretation && cleanAnswer !== pendingInterpretation.answerRecord?.answer) {
    pendingInterpretation.retryAnswers ||= [];
    if (!pendingInterpretation.retryAnswers.includes(cleanAnswer)) {
      pendingInterpretation.retryAnswers.push(cleanAnswer);
    }
  }

  // A0: consent handling lives in consentRules.js.
  if (question.id === "A0") {
    const outcome = classifyConsent(cleanAnswer);

    if (outcome === "unclear") {
      return handleInvalidAttempt(session, question, {
        clarificationPrefix:
          "Maaf kijiye, mujhe samajh nahi aaya. Kripya batayein ki kya aap screening conversation ke liye agree karti hain",
        warningPrefix:
          "Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya spasht batayein",
        repeatQuestionText: question.text,
      });
    }

    session.invalidAttempts = {};

    answerRecord.consentOutcome = outcome;
    session.answers.push(answerRecord);

    if (outcome === "refused") {
      session.consentOutcome = "refused";
      session.status = "manual_review";
      session.completedAt = new Date().toISOString();

      return {
        status: 200,
        body: {
          success: true,
          completed: true,
          manualReviewRequired: true,
          message:
            "Consent was not given. Route this session for manual screening.",
          sessionStatus: session.status,
          consentOutcome: session.consentOutcome,
        language: session.language || null,
        },
      };
    }

    const detectedLanguage = classifyLanguage(cleanAnswer) || "Hindi";
    session.consentOutcome = "accepted";
    session.language = detectedLanguage;
    answerRecord.language = detectedLanguage;
    session.currentQuestionIndex += 1;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        acknowledgement: getNaturalAcknowledgement(question, session),
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        consentOutcome: session.consentOutcome,
        language: session.language || null,
        question: questions[session.currentQuestionIndex],
      },
    };
  }

  // A1: Location and movement handling.
  if (question.id === "A1") {
    const result = classifyLocation(cleanAnswer);

    if (result.outcome === "clarification" && !result.area) {
      return handleInvalidAttempt(session, question, {
        clarificationPrefix:
          "Maaf kijiye, ye ilaqe ya area ka naam nahi lag raha. Kripya apne sheher ya area ka naam batayein",
        warningPrefix:
          "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya apne sheher ya area ka naam seedhe batayein",
        repeatQuestionText: question.text,
      });
    }

    if (result.outcome === "clarification" && result.area) {
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message: result.message,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question,
        },
      };
    }

    session.invalidAttempts = {};

    answerRecord.location = result.area;
    answerRecord.travelWillingness = result.travelWillingness;
    answerRecord.locationOutcome = result.outcome;
    answerRecord.manualReviewRequired = true;

    session.answers.push(answerRecord);
    session.locationOutcome = result.outcome;
    session.manualChecks = session.manualChecks || [];

    const check = {
      questionId: "A1",
      outcome: result.outcome,
      area: result.area,
      travelWillingness: result.travelWillingness,
      required: true,
      createdAt: new Date().toISOString(),
    };

    session.manualChecks.push(check);

    if (result.followUp) {
      const prompts = {
        travel_clarification:
          "Agar kaam thoda door ho, to kya aap travel kar sakti hain ya zarurat padne par shift ho sakti hain?",
        move_timeline:
          "Agar shift hona pade, to aap kab tak shift ho sakti hain?",
      };

      session.pendingFollowUp = {
        questionId: "A1",
        type: result.followUp,
        prompt: prompts[result.followUp],
      };

      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          acknowledgement: getNaturalAcknowledgement(question, session),
          manualReviewRequired: true,
          followUpRequired: true,
          followUp: session.pendingFollowUp,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: `A1_${result.followUp.toUpperCase()}`,
            Step: `A1_${result.followUp.toUpperCase()}`,
            text: session.pendingFollowUp.prompt,
            category: "Location & movement",
          },
        },
      };
    }

    session.currentQuestionIndex += 1;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        acknowledgement: getNaturalAcknowledgement(question, session),
        manualReviewRequired: true,
        locationOutcome: result.outcome,
        travelWillingness: result.travelWillingness,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: questions[session.currentQuestionIndex],
      },
    };
  }

  // A2: Age validation handled by ageRules.js.
  if (question.id === "A2") {
    const result = evaluateAge(cleanAnswer);

    if (result.outcome === "clarification") {
      const isAmbiguousAge =
        /\b(?:\d{1,2}\s+(?:ya|or)\s+\d{1,2}|twenty|thirty|forty|shayad\s+\d{1,2})\b/i.test(cleanAnswer) ||
        /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(cleanAnswer);

      session.ageClarifications = session.ageClarifications || 0;
      if (isAmbiguousAge && session.ageClarifications === 0) {
        session.ageClarifications += 1;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            message: "Kripya apni ek exact umar saal mein batayein (jaise 25 saal).",
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question,
          },
        };
      }

      return handleInvalidAttempt(session, question, {
        clarificationPrefix:
          "Maaf kijiye, ye sahi umar nahi lag rahi. Kripya apni sahi umar saal mein batayein",
        warningPrefix:
          "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya apni sahi umar saal mein spasht batayein",
        repeatQuestionText: question.text,
      });
    }

    session.invalidAttempts = {};

    answerRecord.age = result.age;
    answerRecord.eligibilityOutcome = result.outcome;
    session.answers.push(answerRecord);

    session.eligibilityOutcome = result.outcome;

    if (result.outcome === "reject") {
      session.status = "rejected";
      session.completedAt = new Date().toISOString();

      return {
        status: 200,
        body: {
          success: true,
          completed: true,
          age: result.age,
          eligibilityOutcome: "reject",
          message: result.message,
        },
      };
    }

    session.currentQuestionIndex += 1;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        acknowledgement: getNaturalAcknowledgement(question, session),
        age: result.age,
        eligibilityOutcome: result.outcome,
        manualReviewRequired: result.outcome === "manual_review",
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: questions[session.currentQuestionIndex],
      },
    };
  }

  // A2_NAME captures the candidate's name without applying eligibility rules.
  if (question.id === "A2_NAME") {
    const nameClassification = classifyNameAnswer(cleanAnswer);
    const nameIsClear = nameClassification.clear;
    console.info("[UC Interview Diagnostics] name_validation", {
      requestId: safeRequestId,
      sessionKey,
      questionId: question.id,
      outcome: nameIsClear ? "accepted" : "clarification",
      answerFormat: nameClassification.format,
      answerFieldType: typeof answer,
      answerChars: cleanAnswer.length,
      promptTurn: safePromptTurn,
      sessionGeneration: safeSessionGeneration,
    });

    if (!nameIsClear) {
      return handleInvalidAttempt(session, question, {
        clarificationPrefix:
          "Maaf kijiye, mujhe aapka naam samajh nahi aaya. Kripya apna naam seedhe batayein",
        warningPrefix:
          "Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya apna naam spasht batayein",
        repeatQuestionText: question.text,
      });
    }

    session.invalidAttempts = {};

    session.candidateName = formatCandidateName(nameClassification.name || cleanAnswer);
    session.answers.push(answerRecord);
    session.currentQuestionIndex += 1;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        candidateName: session.candidateName,
        acknowledgement: getNaturalAcknowledgement(question, session),
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: questions[session.currentQuestionIndex],
      },
    };
  }

  // A9: Travel block - handle travel mode, reluctance, cross-questions, and husband dependence
  if (question.id === "A9") {
    const isCrossQuestion =
      /\b(?:kyun|kyu|why|reason|zaruri\s+kyun|kyun\s+jana|door\s+kyun|kyun\s+zaruri)\b/i.test(
        cleanAnswer,
      );
    const isReluctantOrUnsure =
      /\b(?:difficult|mushkil|hard|problem|dikkat|issue|not\s+sure|unsure|pata\s+nahi|pata\s+nahin|doubt|shayad)\b/i.test(
        cleanAnswer,
      );
    const husbandDrop =
      /\b(?:husband|pati|father|papa|bhai|brother)\s*(?:chhod|drop|chhodenge|drop\s+karenge|chhodte|chhodti)\b|\b(?:pati|husband)\s+pe\s+depend\b/i.test(
        cleanAnswer,
      );
    const unwillingTravel =
      /\b(?:travel\s+nahi|door\s+nahi|scooty\s+nahi\s+chala|nahi\s+ja\s+sakti|cannot\s+travel|can't\s+travel|paas\s+mein\s+hi)\b/i.test(
        cleanAnswer,
      );
    const conveyanceIssue =
      /\b(?:gaadi|scooty|bike|vehicle|conveyance)\s*(?:nahi|nahin|nhi)\b|\b(?:no|don't\s+have|dont\s+have)\s*(?:vehicle|scooty|bike)\b/i.test(
        cleanAnswer,
      );
    const isIrrelevant =
      /\b(?:biryani|pizza|burger|cricket|movie|anime|chair|table|laptop|pen|bottle)\b/i.test(
        cleanAnswer,
      );

    if (isCrossQuestion) {
      session.pendingFollowUp = {
        questionId: "A9",
        type: "contextual_probe",
        prompt:
          "Urban Company salon-at-home service hai, isliye professionals ko apne area ke 3-4 km cluster mein clients ke ghar jana hota hai. Kya aap public transport, auto ya family help se manage kar sakti hain?",
        originalAnswer: cleanAnswer,
        category: "Travel",
      };
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          followUpRequired: true,
          followUp: session.pendingFollowUp,
          message: session.pendingFollowUp.prompt,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A9_FOLLOW_UP",
            Step: "A9_FOLLOW_UP",
            text: session.pendingFollowUp.prompt,
            category: "Travel",
          },
        },
      };
    }

    if (isReluctantOrUnsure) {
      session.pendingFollowUp = {
        questionId: "A9",
        type: "contextual_probe",
        prompt:
          "Main samajh sakti hoon. Travel ko lekar kya dikkat ho sakti hai — conveyance ki wajah se ya timing ki wajah se?",
        originalAnswer: cleanAnswer,
        category: "Travel",
      };
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          followUpRequired: true,
          followUp: session.pendingFollowUp,
          message: session.pendingFollowUp.prompt,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A9_FOLLOW_UP",
            Step: "A9_FOLLOW_UP",
            text: session.pendingFollowUp.prompt,
            category: "Travel",
          },
        },
      };
    }

    if (conveyanceIssue) {
      session.pendingFollowUp = {
        questionId: "A9",
        type: "contextual_probe",
        prompt:
          "Samajh gayi. Kaam aapke area ke aas-paas ke 3-4 km cluster mein hi hota hai. Kya aap bus, auto ya family drop se travel kar sakti hain?",
        originalAnswer: cleanAnswer,
        category: "Travel",
      };
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          followUpRequired: true,
          followUp: session.pendingFollowUp,
          message: session.pendingFollowUp.prompt,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A9_FOLLOW_UP",
            Step: "A9_FOLLOW_UP",
            text: session.pendingFollowUp.prompt,
            category: "Travel",
          },
        },
      };
    }

    if (husbandDrop) {
      session.pendingFollowUp = {
        questionId: "A9",
        type: "contextual_probe",
        prompt:
          "Jab wo kaam pe hon ya busy hon, tab aap kaise manage karengi?",
        originalAnswer: cleanAnswer,
        category: "Travel",
      };
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          followUpRequired: true,
          followUp: session.pendingFollowUp,
          message: session.pendingFollowUp.prompt,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A9_FOLLOW_UP",
            Step: "A9_FOLLOW_UP",
            text: session.pendingFollowUp.prompt,
            category: "Travel",
          },
        },
      };
    }

    if (isIrrelevant) {
      return handleInvalidAttempt(session, question, {
        clarificationPrefix:
          "Maaf kijiye, ye jawab sawal se juda hua nahi hai. Kripya is sawal ka seedha jawab dein",
        warningPrefix:
          "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya seedhe batayein",
        repeatQuestionText: question.text,
      });
    }

    session.invalidAttempts = {};

    if (unwillingTravel) {
      answerRecord.travelWillingness = "no";
      session.manualChecks = session.manualChecks || [];
      session.manualChecks.push({
        questionId: "A9",
        outcome: "reject",
        reason: "Candidate unwilling to travel 3-4 km",
        answer: cleanAnswer,
        required: true,
        createdAt: new Date().toISOString(),
      });
      session.manualReviewRequired = true;
      session.answers.push(answerRecord);
      advanceToNextApplicableQuestion(session);
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          manualReviewRequired: true,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: questions[session.currentQuestionIndex],
        },
      };
    }

    answerRecord.travelWillingness = "yes";
    session.answers.push(answerRecord);
    advanceToNextApplicableQuestion(session);
    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: questions[session.currentQuestionIndex],
      },
    };
  }

  // Gemini interpretation for normal questions only.
  const isSpecialQuestion = ["A0", "A1", "A2", "A2_NAME", "A9"].includes(
    question.id,
  );

  if (!isSpecialQuestion) {
    const interpretationQuestionIndex = session.currentQuestionIndex;
    try {
      const interpretation = await interpretAnswerImpl({
        question: question.text,
        answer: cleanAnswer,
        questionId: question.id,
        diagnosticRequestId: safeRequestId,
        diagnosticPromptTurn: safePromptTurn,
        diagnosticSessionGeneration: safeSessionGeneration,
      });

      // The Gemini call yields control while another request may accept the
      // same answer. Re-check ownership before applying this interpretation
      // or advancing the bank index a second time.
      if (
        session.currentQuestionIndex !== interpretationQuestionIndex ||
        session.status !== "in_progress" ||
        session.pendingFollowUp ||
        session.pendingChildApplicability
      ) {
        console.info("[UC Interview Diagnostics] stale_answer_ignored", {
          requestId: safeRequestId,
          sessionKey,
          expectedQuestionId: requestQuestionId,
          currentQuestionId:
            session.pendingFollowUp
              ? `${session.pendingFollowUp.questionId}_${session.pendingFollowUp.type.toUpperCase()}`
              : questions[session.currentQuestionIndex]?.id || null,
          reason: "session_advanced_during_interpretation",
        });
        return staleQuestionResponse();
      }

      answerRecord.interpretation = interpretation;

      if (interpretation.needsClarification) {
        const isUncertainOrSkipped =
          /^(?:not\s+sure|unsure|pata\s+nahi|pata\s+nahin|don't\s+know|dont\s+know|maybe|shayad|no\s+idea|samajh\s+nahi\s+aaya|skip|aage\s+badho|pass)[.!?।\s]*$/i.test(
            cleanAnswer,
          ) ||
          /uncertain|hesitan|unsure|skip/i.test(interpretation.understanding);

        const bankQ = questions[session.currentQuestionIndex];
        const probe =
          bankQ && bankQ["Follow-up probe"] && bankQ["Follow-up probe"] !== "—"
            ? bankQ["Follow-up probe"]
            : null;

        session.followUpsGiven = session.followUpsGiven || {};
        if (isUncertainOrSkipped && !session.followUpsGiven[question.id]) {
          session.followUpsGiven[question.id] = true;
          const probeText =
            probe ||
            interpretation.clarificationQuestion ||
            "Aap is baare mein thoda aur spasht batayein.";
          session.pendingFollowUp = {
            questionId: question.id,
            type: "contextual_probe",
            prompt: probeText,
            originalAnswer: cleanAnswer,
            category: question.category,
          };
          return {
            status: 200,
            body: {
              success: true,
              completed: false,
              clarificationRequired: true,
              followUpRequired: true,
              followUp: session.pendingFollowUp,
              message: probeText,
              questionNumber: session.currentQuestionIndex + 1,
              totalQuestions: questions.length,
              question: {
                id: `${question.id}_FOLLOW_UP`,
                Step: `${question.id}_FOLLOW_UP`,
                text: probeText,
                category: question.category,
              },
            },
          };
        }

        const clarPrefix = interpretation.clarificationQuestion
          ? interpretation.clarificationQuestion.replace(/[:.!?।\s]+$/u, "")
          : "Maaf kijiye, mujhe samajh nahi aaya ki ye sawal ka jawab kaise hai. Kripya is sawal ka seedha jawab dein";

        return handleInvalidAttempt(session, question, {
          clarificationPrefix: clarPrefix,
          warningPrefix:
            "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya is sawal ka seedha aur spasht jawab dein",
          repeatQuestionText: question.text,
        });
      }

      session.invalidAttempts = {};
    } catch (error) {
      if (
        session.currentQuestionIndex !== interpretationQuestionIndex ||
        session.status !== "in_progress" ||
        session.pendingFollowUp ||
        session.pendingChildApplicability
      ) {
        return staleQuestionResponse();
      }

      console.error("[UC Interview Diagnostics] interpretation_unavailable", {
        requestId: safeRequestId,
        sessionKey,
        questionId: question.id,
        errorName: error?.name || "Error",
      });
      // Preserve the verbatim answer in the persisted session while keeping
      // the current question active. The next candidate answer retries this
      // question; no interpretation or progression is fabricated here.
      session.pendingInterpretation = pendingInterpretation || {
        questionId: question.id,
        answerRecord,
        retryAnswers: [],
      };
      const rateLimited = error?.code === "AI_RATE_LIMIT" || error?.name === "RateLimitError" || error?.status === 429 || error?.statusCode === 429;
      session.pendingInterpretation.failureCode = rateLimited
        ? "AI_RATE_LIMIT"
        : "AI_INTERPRETATION_UNAVAILABLE";
      session.pendingInterpretation.failedAt = new Date().toISOString();
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          interpretationUnavailable: true,
          code: session.pendingInterpretation.failureCode,
          message: rateLimited
            ? "AI service abhi busy hai. Aapka jawab save hai. Kripya kuch der baad isi sawal ka jawab dobara dein."
            : "माफ़ कीजिए, आपका जवाब सुरक्षित है, लेकिन अभी समझा नहीं जा सका। कृपया इसी सवाल का जवाब दोबारा दें।",
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question,
        },
      };
    }
  }

  // A successful interpretation resolves any previously saved retry state.
  if (session.pendingInterpretation?.questionId === question.id) {
    answerRecord.previousInterpretationAttempts = [
      session.pendingInterpretation.answerRecord?.answer,
      ...(session.pendingInterpretation.retryAnswers || []),
    ].filter((attempt) => attempt && attempt !== answerRecord.answer);
    session.pendingInterpretation = null;
  }

  if (question.id === "A3") {
    const childPresence = classifyChildPresence(cleanAnswer);
    if (childPresence === "unknown" || childPresence === "ambiguous") {
      session.pendingChildApplicability = { answerRecord };
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message: "Please clarify whether you have children, so I ask only the relevant follow-up questions.",
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question,
        },
      };
    }

    const details = childDetailsProvided(cleanAnswer);
    answerRecord.childPresence = childPresence;
    session.childQuestionApplicability = {
      hasChildren: childPresence === "present",
      classDetailsProvided: details.classDetails,
      caregiverDetailsProvided: details.caregiverDetails,
    };
  }

  // Sequential flow for questions other than A0.
  session.answers.push(answerRecord);
  advanceToNextApplicableQuestion(session);

  if (session.currentQuestionIndex >= questions.length) {
    session.status = "completed";
    session.completedAt = new Date().toISOString();

    return {
      status: 200,
      body: {
        success: true,
        completed: true,
        answeredQuestions: session.answers.length,
        totalQuestions: questions.length,
      },
    };
  }

  return {
    status: 200,
    body: {
      success: true,
      completed: false,
      questionNumber: session.currentQuestionIndex + 1,
      totalQuestions: questions.length,
      question: questions[session.currentQuestionIndex],
    },
  };
}

function flagManualReview(sessionId, reason) {
  const session = sessions.get(sessionId);

  if (!session) {
    return {
      status: 404,
      body: {
        success: false,
        message: "Interview session not found.",
      },
    };
  }

  session.manualReviewRequired = true;
  session.manualReviewReason = reason || "Repeated unclear answer";
  session.manualReviewPaused = true;

  return {
    status: 200,
    body: {
      success: true,
      manualReviewRequired: true,
    },
  };
}

function endInterview(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      status: 404,
      body: { success: false, message: "Interview session not found." },
    };
  }

  if (session.status === "in_progress" || session.status === "paused") {
    session.status = "incomplete";
    session.endedAt = new Date().toISOString();
  }

  // Terminal outcomes (completed, rejected, manual_review) and an earlier
  // incomplete end are intentionally idempotent and remain unchanged.
  return {
    status: 200,
    body: {
      success: true,
      sessionId: session.sessionId,
      sessionStatus: session.status,
      endedAt: session.endedAt || session.completedAt,
      answeredQuestions: session.answers.length,
    },
  };
}

function pauseInterview(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      status: 404,
      body: { success: false, message: "Interview session not found." },
    };
  }
  if (session.status !== "in_progress") {
    return {
      status: 400,
      body: {
        success: false,
        message: "Only an active in-progress interview session can be paused.",
        sessionStatus: session.status,
      },
    };
  }
  session.status = "paused";
  session.pausedAt = new Date().toISOString();
  return {
    status: 200,
    body: {
      success: true,
      sessionId: session.sessionId,
      sessionStatus: "paused",
      pausedAt: session.pausedAt,
      questionNumber: session.currentQuestionIndex + 1,
      totalQuestions: questions.length,
      question: getCurrentQuestionForSession(session),
      candidateName: session.candidateName || null,
    },
  };
}

function resumeInterview(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      status: 404,
      body: { success: false, message: "Interview session not found." },
    };
  }
  if (session.status !== "paused" && session.status !== "in_progress") {
    return {
      status: 400,
      body: {
        success: false,
        message: "This interview session cannot be resumed because it has already ended.",
        sessionStatus: session.status,
      },
    };
  }
  if (session.status === "paused") {
    session.status = "in_progress";
    session.resumedAt = new Date().toISOString();
  }
  return {
    status: 200,
    body: {
      success: true,
      sessionId: session.sessionId,
      sessionStatus: session.status,
      questionNumber: session.currentQuestionIndex + 1,
      totalQuestions: questions.length,
      question: getCurrentQuestionForSession(session),
      candidateName: session.candidateName || null,
      isResumed: true,
    },
  };
}

function getActiveSessionForCandidate(candidateId) {
  if (!candidateId) return null;
  for (const session of sessions.values()) {
    if (session.candidateId === candidateId && (session.status === "in_progress" || session.status === "paused")) {
      return {
        sessionId: session.sessionId,
        status: session.status,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: getCurrentQuestionForSession(session),
        candidateName: session.candidateName || null,
        answersCount: session.answers?.length || 0,
      };
    }
  }
  return null;
}

function getReport(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    return {
      status: 404,
      body: {
        success: false,
        message: "Interview session not found.",
      },
    };
  }

  const manualChecks = session.manualChecks || [];
  const manualReviewRequired = Boolean(
    session.manualReviewRequired ||
      session.status === "manual_review" ||
      session.eligibilityOutcome === "manual_review" ||
      manualChecks.some((check) => check.required),
  );

  const lastLocationAnswer = [...session.answers]
    .reverse()
    .find((item) => item.questionId === "A1");
  const travelWillingness =
    session.travelWillingness ||
    lastLocationAnswer?.travelWillingness ||
    null;

  return {
    status: 200,
    body: {
      success: true,
      report: {
        sessionId: session.sessionId,
        candidateId: session.candidateId || null,
        candidateName: session.candidateName || null,
        status: session.status,
        terminationReason: session.terminationReason || null,
        terminatedAtQuestionId: session.terminatedAtQuestionId || null,
        terminatedAt: session.terminatedAt || null,
        manualReviewRequired,
        manualReviewReason: session.manualReviewReason || null,
        eligibilityOutcome: session.eligibilityOutcome || null,
        locationOutcome: session.locationOutcome || null,
        travelWillingness,
        manualChecks,
        consentOutcome: session.consentOutcome,
        language: session.language || null,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        endedAt: session.endedAt || session.completedAt,
        totalQuestions: questions.length,
        answeredQuestions: session.answers.length,
        answers: session.answers,
        pendingInterpretation: session.pendingInterpretation
          ? {
              questionId: session.pendingInterpretation.questionId,
              questionText: session.pendingInterpretation.answerRecord?.questionText || null,
              answer: session.pendingInterpretation.answerRecord?.answer || "",
              status: "interpretation_pending_retry",
            }
          : null,
      },
    },
  };
}

function listReports() {
  return {
    status: 200,
    body: {
      success: true,
      sessions: [...sessions.values()]
        .map((session) => ({
          sessionId: session.sessionId,
          candidateId: session.candidateId || null,
          candidateName:
            session.candidateName ||
            session.answers.find((answer) => answer.questionId === "A2_NAME")?.answer ||
            "Name not recorded",
          status: session.status,
          terminationReason: session.terminationReason || null,
          terminatedAtQuestionId: session.terminatedAtQuestionId || null,
          startedAt: session.startedAt,
          completedAt: session.completedAt,
          endedAt: session.endedAt || session.completedAt,
          answeredQuestions: session.answers.length,
          manualReviewRequired: Boolean(
            session.manualReviewRequired ||
              session.status === "manual_review" ||
              session.eligibilityOutcome === "manual_review" ||
              (session.manualChecks || []).some((check) => check.required),
          ),
        }))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    },
  };
}

function getTotalQuestions() {
  return questions.length;
}

function getAllSessions() {
  return [...sessions.values()];
}

function deleteReport(sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    return {
      status: 400,
      body: { success: false, message: "A valid session ID is required." },
    };
  }
  if (!sessions.has(sessionId)) {
    return {
      status: 404,
      body: { success: false, message: "Interview report not found." },
    };
  }
  sessions.delete(sessionId);
  return {
    status: 200,
    body: { success: true, message: "Interview report deleted successfully." },
  };
}

module.exports = {
  startInterview,
  submitAnswer,
  getReport,
  listReports,
  deleteReport,
  endInterview,
  getTotalQuestions,
  getAllSessions,
  flagManualReview,
  getSessionSnapshot,
  restoreSessionSnapshot,
  restoreSessions,
  getSessionForPersistence,
  pauseInterview,
  resumeInterview,
  getActiveSessionForCandidate,
  getCurrentQuestionForSession,
  classifyNameAnswer,
  isSaneName,
};
