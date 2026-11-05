const crypto = require("crypto");
const path = require("path");

const { classifyConsent, classifyLanguage } = require("./rules/consentRules");
const { evaluateAge } = require("./rules/ageRules");
const { classifyLocation } = require("./rules/locationRules");
const {
  interpretAnswer,
  extractFallbackFacts,
  generateInquiryResponse,
  isUnsupportedPolicyClaim,
  UNIFIED_INTENTS,
  normalizeIntent,
  INQUIRY_TIMEOUT_MS,
  isQuotaExhaustedError,
  isQuotaExhausted,
  markQuotaExhausted,
  resetQuotaExhaustion,
} = require("./geminiService");
const {
  detectCounterQuestion,
  isRequestToAskQuestion,
  isEnglishRequestToAsk,
  isCandidateDecidingNotToAsk,
  isSubDialogueResolution,
  isResumptionConfirmation,
  isNotReadyToResume,
  isGenericAcknowledgement,
  isExplicitContinueRequest,
  isRepetitiveInquiry,
  isAnsweringInquiryProbe,
  separateProbeAndAssessmentAnswer,
  separateLanguageAndInquiry,
} = require("./counterQuestions");

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

function createShortTermMemory() {
  return {
    facts: {},
    coveredTopics: [],
    recentTurns: [],
  };
}

const INTERVIEW_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAX_ADAPTIVE_INQUIRY_TURNS = 5;

const TERMINAL_STATUSES = new Set([
  "completed",
  "rejected",
  "manual_review",
  "incomplete",
  "terminated",
  "cancelled",
]);

function clearShortTermMemory(session) {
  if (!session) return;
  session.shortTermMemory = createShortTermMemory();
  session.activeInquiry = null;
}

function clearActiveInquiry(session) {
  if (!session) return;
  session.activeInquiry = null;
}

function createActiveInquiry({
  originalQuestionId,
  originalQuestionIndex,
  rootTopic = null,
  candidateConcern = null,
  initialCandidateTurn = null,
  initialInterviewerReply = null,
  initialSystemTurn = null,
  state = "clarification_check",
}) {
  const turns = [];
  if (initialCandidateTurn) {
    turns.push({
      role: "candidate",
      text: initialCandidateTurn,
      timestamp: new Date().toISOString(),
    });
  }
  const reply = initialInterviewerReply || initialSystemTurn;
  if (reply) {
    turns.push({
      role: "interviewer",
      text: reply,
      timestamp: new Date().toISOString(),
    });
  }
  return {
    status: "in_progress",
    state,
    originalQuestionId,
    originalQuestionIndex,
    rootTopic,
    currentTopic: rootTopic,
    candidateConcern,
    turns,
    turnCount: state === "AWAITING_CANDIDATE_QUESTION" ? 0 : (initialCandidateTurn ? 1 : 0),
    startedAt: new Date().toISOString(),
  };
}

function handleRequestToAskQuestion({
  session,
  targetQuestion,
  cleanAnswer,
  isEnglish = session.language === "English" || isEnglishRequestToAsk(cleanAnswer) || classifyLanguage(cleanAnswer) === "English",
}) {
  const isTargetEnglish = Boolean(isEnglish || isEnglishRequestToAsk(cleanAnswer) || classifyLanguage(cleanAnswer) === "English");
  const inviteText = isTargetEnglish
    ? "Sure, please go ahead and ask your question. I am here to help."
    : "Ji haan, bilkul poochiye, aap apna question poochhiye. Main aapki madad karti hoon.";

  session.activeInquiry = createActiveInquiry({
    originalQuestionId: targetQuestion.id,
    originalQuestionIndex: session.currentQuestionIndex,
    rootTopic: "candidate_question_request",
    candidateConcern: cleanAnswer,
    initialCandidateTurn: cleanAnswer,
    initialInterviewerReply: inviteText,
    state: "AWAITING_CANDIDATE_QUESTION",
  });

  return {
    status: 200,
    body: {
      success: true,
      completed: false,
      clarificationRequired: true,
      counterQuestionHandled: true,
      inquiryState: "AWAITING_CANDIDATE_QUESTION",
      message: inviteText,
      questionNumber: session.currentQuestionIndex + 1,
      totalQuestions: questions.length,
      question: {
        id: targetQuestion.id,
        text: targetQuestion.text,
        category: targetQuestion.category || targetQuestion.Block || "General",
        stage: targetQuestion.stage || targetQuestion.Type || "ASSESSMENT",
      },
    },
  };
}

function startActiveInquiry(session, question, cleanAnswer, inquiry, replyText) {
  if (!session || !question) return;
  const extracted = extractFallbackFacts(cleanAnswer);
  if (extracted && Object.keys(extracted).length > 0) {
    mergeShortTermMemoryFacts(session, extracted);
  }
  session.activeInquiry = createActiveInquiry({
    originalQuestionId: question.id,
    originalQuestionIndex: session.currentQuestionIndex,
    rootTopic: inquiry?.topic || "general_inquiry",
    candidateConcern: cleanAnswer,
    initialCandidateTurn: cleanAnswer,
    initialInterviewerReply: replyText,
  });
}

function getActiveInquiry(sessionId) {
  const session = sessions.get(sessionId);
  return session?.activeInquiry ? structuredClone(session.activeInquiry) : null;
}

function isSessionExpired(session, maxAgeMs = INTERVIEW_SESSION_TTL_MS, currentTime = Date.now()) {
  if (!session) return false;
  if (session.expiresAt) {
    const expires = new Date(session.expiresAt).getTime();
    if (!Number.isNaN(expires) && expires <= currentTime) return true;
  }
  if (session.startedAt) {
    const started = new Date(session.startedAt).getTime();
    if (!Number.isNaN(started) && (currentTime - started) > maxAgeMs) {
      return true;
    }
  }
  return false;
}

function cleanupExpiredSessions({ maxAgeMs = INTERVIEW_SESSION_TTL_MS, currentTime = Date.now() } = {}) {
  let cleanedCount = 0;
  for (const session of sessions.values()) {
    if (isSessionExpired(session, maxAgeMs, currentTime)) {
      if (session.status === "in_progress" || session.status === "paused") {
        session.status = "incomplete";
        session.endedAt = new Date(currentTime).toISOString();
        session.terminationReason = "session_expired";
      }
      clearShortTermMemory(session);
      cleanedCount += 1;
    }
  }
  return cleanedCount;
}

function mergeShortTermMemoryFacts(session, newFacts) {
  if (!session || !newFacts || typeof newFacts !== "object" || Array.isArray(newFacts)) {
    return;
  }
  if (!session.shortTermMemory || typeof session.shortTermMemory !== "object") {
    session.shortTermMemory = createShortTermMemory();
  }
  if (!session.shortTermMemory.facts || typeof session.shortTermMemory.facts !== "object") {
    session.shortTermMemory.facts = {};
  }

  const facts = session.shortTermMemory.facts;

  for (const [key, val] of Object.entries(newFacts)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (val === null || val === undefined) continue;

    if (typeof val === "string") {
      const cleanVal = val.trim();
      if (!cleanVal || /^(?:unknown|none|n\/a|null|undefined|not\s+specified)$/i.test(cleanVal)) {
        continue;
      }
      facts[key] = cleanVal;
    } else if (typeof val === "number" || typeof val === "boolean") {
      facts[key] = val;
    } else if (Array.isArray(val)) {
      const cleanArr = val
        .filter((item) => typeof item === "string" && item.trim() && !/^(?:unknown|none|n\/a|null|undefined)$/i.test(item.trim()))
        .map((item) => item.trim());

      if (cleanArr.length > 0) {
        const existingArr = Array.isArray(facts[key]) ? facts[key] : [];
        const mergedSet = new Set([...existingArr, ...cleanArr]);
        facts[key] = Array.from(mergedSet);
      }
    }
  }
}

function recordShortTermMemoryTurn(session, turn) {
  if (!session || !turn) return;
  if (!session.shortTermMemory || typeof session.shortTermMemory !== "object") {
    session.shortTermMemory = createShortTermMemory();
  }
  if (!Array.isArray(session.shortTermMemory.recentTurns)) {
    session.shortTermMemory.recentTurns = [];
  }
  if (!Array.isArray(session.shortTermMemory.coveredTopics)) {
    session.shortTermMemory.coveredTopics = [];
  }

  const qId = turn.questionId || "";
  const aText = typeof turn.answer === "string" ? turn.answer : "";
  if (qId && aText) {
    session.shortTermMemory.recentTurns.push({
      questionId: qId,
      questionText: turn.questionText || "",
      answer: aText,
      timestamp: turn.answeredAt || new Date().toISOString(),
    });
    if (session.shortTermMemory.recentTurns.length > 10) {
      session.shortTermMemory.recentTurns.shift();
    }
  }

  const category = turn.category || "";
  if (category && typeof category === "string" && !session.shortTermMemory.coveredTopics.includes(category)) {
    session.shortTermMemory.coveredTopics.push(category);
  }
}

function startInterview({ candidateId, profileName } = {}) {
  if (candidateId) {
    for (const priorSession of sessions.values()) {
      if (
        priorSession.candidateId === candidateId &&
        (priorSession.status === "in_progress" || priorSession.status === "paused")
      ) {
        priorSession.status = "incomplete";
        priorSession.endedAt = new Date().toISOString();
        clearShortTermMemory(priorSession);
      }
    }
  }

  const sessionId = crypto.randomUUID();

  const session = {
    sessionId,
    ...(candidateId ? { candidateId } : {}),
    ...(profileName ? { profileName: formatCandidateName(profileName) } : {}),
    currentQuestionIndex: 0,
    answers: [],
    shortTermMemory: createShortTermMemory(),
    activeInquiry: null,
    status: "in_progress",
    manualReviewRequired: false,
    manualReviewPaused: false,
    identityMismatchAttempts: 0,
    nameRejectionCount: 0,
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
  if (snapshot) {
    const clone = structuredClone(snapshot);
    if (!clone.shortTermMemory || typeof clone.shortTermMemory !== "object") {
      clone.shortTermMemory = createShortTermMemory();
    }
    if (clone.activeInquiry === undefined) {
      clone.activeInquiry = null;
    }
    if (TERMINAL_STATUSES.has(clone.status)) {
      clearShortTermMemory(clone);
      clone.activeInquiry = null;
    }
    sessions.set(sessionId, clone);
  } else {
    sessions.delete(sessionId);
  }
}

function restoreSessions(restoredSessions) {
  sessions.clear();
  for (const session of restoredSessions) {
    if (session?.sessionId && session.status && session.startedAt) {
      if (!session.shortTermMemory || typeof session.shortTermMemory !== "object") {
        session.shortTermMemory = createShortTermMemory();
      }
      if (session.activeInquiry === undefined) {
        session.activeInquiry = null;
      }
      if (TERMINAL_STATUSES.has(session.status)) {
        clearShortTermMemory(session);
        session.activeInquiry = null;
      }
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
  "nahi", "nahin", "nhi", "no", "nope", "not", "yes", "haan", "han", "ha",
  "haanji", "hanji", "yahi", "wahi", "sahi", "theek", "thik", "bilkul", "correct", "right", "galat", "wrong", "naam",
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

// Transliterate common Devanagari characters to Latin phonetic characters
const DEVANAGARI_CONSONANTS = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "f", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क्ष": "ksh", "त्र": "tr", "ज्ञ": "gy",
};
const DEVANAGARI_MATRAS = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u",
  "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
  "ं": "n", "ँ": "n", "ः": "h",
};
const DEVANAGARI_INDEPENDENT_VOWELS = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u",
  "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
};

function transliterateDevanagariToLatin(text) {
  if (!text || !/[\u0900-\u097f]/u.test(text)) return text;
  let res = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nextCh = text[i + 1];
    if (DEVANAGARI_CONSONANTS[ch]) {
      res += DEVANAGARI_CONSONANTS[ch];
      const isWordFinal = !nextCh || /\s|[\p{P}\p{Z}]/u.test(nextCh);
      if (nextCh === "्") {
        // virama suppresses inherent vowel
      } else if (!isWordFinal && !DEVANAGARI_MATRAS[nextCh]) {
        // inherent vowel inside a word, not at word end in modern Hindi
        res += "a";
      }
    } else if (DEVANAGARI_MATRAS[ch]) {
      res += DEVANAGARI_MATRAS[ch];
    } else if (DEVANAGARI_INDEPENDENT_VOWELS[ch]) {
      res += DEVANAGARI_INDEPENDENT_VOWELS[ch];
    } else if (ch !== "्" && ch !== "़") {
      res += ch;
    }
  }
  return res;
}

function normalizeNameTokenPhonetic(token) {
  if (!token) return "";
  let t = token.toLowerCase();
  t = transliterateDevanagariToLatin(t);
  t = t.replace(/[^a-z]/g, "");
  if (!t) return "";

  // Common Hindi/English spelling variations
  t = t.replace(/ee+/g, "i");
  t = t.replace(/oo+/g, "u");
  t = t.replace(/ou/g, "au");
  t = t.replace(/chou/g, "chau");
  t = t.replace(/ph/g, "f");
  t = t.replace(/w/g, "v");
  t = t.replace(/ay\b/g, "ai");
  t = t.replace(/ey\b/g, "ai");
  t = t.replace(/aa+/g, "a");
  // Normalize Agrawal / Agarwal
  t = t.replace(/agarval/g, "agraval");
  // Normalize Maurya / Morya
  t = t.replace(/mory/g, "maury");
  t = t.replace(/([a-z])\1+/g, "$1");
  t = t.replace(/gh$/g, "g");
  // Drop trailing schwa 'a' on tokens longer than 3 letters for Hindi/English parity
  if (t.length > 3) {
    t = t.replace(/a+$/g, "");
  }
  return t;
}

const HONORIFICS_REGEX = /\b(?:ji|shri|sri|smt|shrimati|mrs|mr|ms|miss|dr)\b/gi;
const DEVANAGARI_HONORIFICS_REGEX = /(?:श्री|श्रीमती|कुमारी|देवी|जी)/gu;

function extractCleanTokens(name) {
  if (!name || typeof name !== "string") return [];
  const s = name
    .replace(DEVANAGARI_HONORIFICS_REGEX, " ")
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()'’"“”]/g, " ")
    .replace(HONORIFICS_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
  const rawTokens = s.split(" ").filter(Boolean);
  return rawTokens.map(normalizeNameTokenPhonetic).filter(Boolean);
}

function normalizeNameForComparison(name) {
  return extractCleanTokens(name).join(" ");
}

function isNameMatch(spoken, profile) {
  const spokenTokens = extractCleanTokens(spoken);
  const profileTokens = extractCleanTokens(profile);
  if (spokenTokens.length === 0 || profileTokens.length === 0) return false;

  // Exact full match
  if (spokenTokens.join(" ") === profileTokens.join(" ")) return true;

  // Single token on both sides
  if (spokenTokens.length === 1 && profileTokens.length === 1) {
    return spokenTokens[0] === profileTokens[0];
  }

  // Spoken has 1 token, profile has multiple: candidate spoke first name only
  if (spokenTokens.length === 1 && profileTokens.length > 1) {
    return spokenTokens[0] === profileTokens[0];
  }

  // Spoken has multiple tokens, profile has 1: candidate gave full name, profile had first name
  if (spokenTokens.length > 1 && profileTokens.length === 1) {
    return spokenTokens[0] === profileTokens[0];
  }

  // Both have multiple tokens:
  // First name must match
  if (spokenTokens[0] !== profileTokens[0]) return false;

  // Surnames must not conflict!
  const spokenLast = spokenTokens[spokenTokens.length - 1];
  const profileLast = profileTokens[profileTokens.length - 1];
  return spokenLast === profileLast;
}

function getCurrentQuestionForSession(session) {
  if (session.pendingNameConfirmation) {
    const isEnglish = session.language === "English";
    const name = session.pendingNameConfirmation.name;
    const isFromProfile = session.pendingNameConfirmation.fromProfile;
    let confirmPrompt;
    if (isFromProfile) {
      confirmPrompt = isEnglish
        ? `Your profile name is ${name}. Is this correct?`
        : `Aapke profile mein naam ${name} hai. Kya ye sahi hai?`;
    } else {
      confirmPrompt = isEnglish
        ? `Your name is ${name}, right?`
        : `Aapka naam ${name} hai, sahi hai na?`;
    }
    return {
      id: "A2_NAME_CONFIRM",
      Step: "A2_NAME_CONFIRM",
      text: confirmPrompt,
      category: "Introduction",
    };
  }
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

function isNameConfirmationAffirmative(cleanAnswer, pendingName, normalizedConfirmation) {
  if (typeof cleanAnswer !== "string" || !cleanAnswer.trim()) return false;

  const norm = (normalizedConfirmation || cleanAnswer)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[,;.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // If there's an explicit negative, it is NOT affirmative
  const hasNegative =
    /\b(?:no|nope|nahi|nahin|nhi|galat|wrong|incorrect|not)\b/i.test(norm) ||
    /(?:नहीं|नही|गलत)/u.test(norm);
  if (hasNegative) return false;

  // 1. Direct affirmation pattern (words and common affirmative phrases)
  const affirmativePattern =
    /^(?:(?:ji\s+)?(?:haan|han|haanji|hanji|haaji|haji|ha|haan\s+g|yes|yeah|yep|yup|sure|ok|okay)(?:\s+(?:ji|sir|madam))?(?:\s+(?:sahi(?:\s+hai)?|theek\s+hai|thik\s+hai|wahi\s+hai|yahi\s+hai|ye\s+sahi\s+hai|ye\s+theek\s+hai|ye\s+thik\s+hai|wahi\s+naam\s+hai|yahi\s+naam\s+hai|bilkul(?:\s+sahi(?:\s+hai)?)?|bilkul(?:\s+theek(?:\s+hai)?)?|correct|right|thats\s+correct|that\s+is\s+correct|thats\s+right|that\s+is\s+right|thats\s+my\s+name|that\s+is\s+my\s+name|it\s+is|its\s+correct|its\s+right))?|(?:(?:जी\s+)?(?:हाँ|हां|हाँजी|हांजी))(?:\s+जी)?(?:\s+(?:सही(?:\s+hai)?|theek\s+hai|thik\s+hai|सही(?:\s+है)?|ठीक(?:\s+है)?|ये\s+सही\s+है|ये\s+ठीक\s+है|बिल्कुल(?:\s+सही(?:\s+है)?)?|बिल्कुल(?:\s+theek(?:\s+hai)?)?|वही\s+है|यही\s+है|यही\s+नाम\s+है|मेरा\s+(?:यही|वही)\s+नाम\s+है))?|ji|जी|sahi|sahi\s+hai|ye\s+sahi\s+hai|ye\s+theek\s+hai|theek\s+hai|thik\s+hai|correct|right|thats\s+correct|that\s+is\s+correct|thats\s+right|that\s+is\s+right|thats\s+my\s+name|that\s+is\s+my\s+name|wahi\s+hai|yahi\s+hai|wahi\s+naam\s+hai|yahi\s+naam\s+hai|bilkul|bilkul\s+sahi(?:\s+hai)?|bilkul\s+theek(?:\s+hai)?|bilkul\s+thik(?:\s+hai)?|ji\s+bilkul|ji\s+haan(?:\s+bilkul)?|हाँ|हां|जी\s+हाँ|जी\s+हां|बिल्कुल|बिल्कुल\s+सही(?:\s+है)?|सही|सही\s+है|ठीक\s+है|वही\s+है|यही\s+है)[.!?।\s]*$/iu;

  if (affirmativePattern.test(norm)) return true;

  // 2. Starts with affirmative prefix (haan/yes/ji/haaji/ha) followed by agreement words
  if (/^(?:ji\s+)?(?:haan|han|haanji|hanji|haaji|haji|ha|yes|yeah|yep|ji)\b/i.test(norm)) {
    if (/\b(?:sahi|theek|thik|correct|right|mera|naam|wahi|yahi|hai|ji|sir|madam)\b/i.test(norm)) {
      return true;
    }
  }

  // 3. Candidate confirms by stating or repeating their pending name (e.g. "haan Aakash", "Aakash hai", "Aakash", "mera naam Aakash hai")
  if (pendingName && typeof pendingName === "string" && pendingName.trim()) {
    const normPending = pendingName.toLowerCase().trim();
    const pendingTokens = normPending.split(/\s+/).filter(Boolean);
    const hasPendingToken = pendingTokens.some((t) => t.length >= 2 && norm.includes(t));

    if (hasPendingToken) {
      const escaped = normPending.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const nameAffirmationPattern = new RegExp(
        `^(?:(?:ji\\s+)?(?:haan|han|haanji|hanji|haaji|haji|ha|yes|yeah|yep|ji)?\\s*)?(?:mera\\s+naam\\s+)?(?:main|mein)?\\s*${escaped}(?:\\s+hi)?(?:\\s+hai|\\s+hoon|\\s+hu)?(?:\\s+(?:sahi|theek|thik|hai|ji|sir|madam))*$`,
        "i"
      );
      if (nameAffirmationPattern.test(norm) || norm === normPending) {
        return true;
      }
    }
  }

  return false;
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

  // Strip leading polite conversational greetings/fillers and negation prefixes in English and Hindi:
  // "Namaste", "Namaskar", "Hello", "Hi", "Ji", "Haan", "Haanji", "Yes", "Ha", "Nahi", "No", "नमस्ते", "नमस्कार", "हाँ", "हां", "हाँजी", "हांजी", "जी", etc.
  const strippedGreeting = normalized
    .replace(/^(?:(?:namaste|namaskar|hello|hi|hey|ji|haan|han|haanji|hanji|yes|ha|acha|achha|nahi|nahin|nhi|no|nope|not|नमस्ते|नमस्कार|हाँ|हां|हाँजी|हांजी|जी|नहीं|नही)\s*[,.:;!-]*\s*)+/iu, "")
    .trim();

  const working = strippedGreeting || normalized;

  const uncertainty =
    /^(?:(?:(?:mera naam|मेरा नाम|my name is)\s+)?(?:pata nahi|nahi pata|yaad nahi|nahi yaad|nahi maloom|kya hai|i don't know|i do not know|not sure|don't know|no idea|samajh nahi aaya)|hmm+|umm+|uh+|naam nahi pata|पता नहीं|याद नहीं|समझ नहीं आया)$/iu;
  if (uncertainty.test(working) || uncertainty.test(normalized)) {
    return { clear: false, format: "uncertainty" };
  }

  const isQuestionOrInquiry =
    /[?]|(?:^|\b)(?:where|kahan|kidhar|why|kyun|kyu|kaise|kya|what|how|explain|batao)\b|\b(?:kya hai|kya hota hai|kya hoti hai|difference kya hai)\b/iu;
  if (isQuestionOrInquiry.test(working) || isQuestionOrInquiry.test(normalized)) {
    return { clear: false, format: "inquiry_or_question" };
  }

  const bareAffirmation =
    /^(?:haan|han|haanji|hanji|yes|yeah|yep|yup|ji|ji\s+haan|ji\s+han|theek\s+hai|thik\s+hai|ok|okay|sahi\s+hai|sahi|ha|bilkul|bilkul\s+sahi(?:\s+hai)?|yahi\s+naam\s+hai|yahi\s+hai|wahi\s+hai|wahi\s+naam\s+hai|(?:mera\s+)?naam\s+(?:yahi|wahi)\s+hai|mera\s+(?:yahi|wahi)\s+naam\s+hai|that's\s+correct|correct|that's\s+right|right|that's\s+my\s+name|yes\s+that's\s+my\s+name)$/iu;
  if (bareAffirmation.test(working) || bareAffirmation.test(normalized)) {
    return { clear: false, format: "bare_affirmation" };
  }

  const bareNegation =
    /^(?:no|nope|nahi|nahin|nhi|not|galat|wrong|galat\s+hai|wrong\s+name|not\s+my\s+name|ye\s+mera\s+naam\s+nahi\s+hai|mera\s+naam\s+galat\s+hai|galat\s+naam\s+hai|गलत|नहीं|नही)$/iu;
  if (bareNegation.test(working) || bareNegation.test(normalized)) {
    return { clear: false, format: "bare_negation" };
  }

  const nameToken = String.raw`[\p{L}][\p{L}\p{M}'’.-]*`;
  const nameSequence = String.raw`${nameToken}(?:\s+${nameToken}){0,3}`;
  const plainNameRegex = new RegExp(`^${nameSequence}$`, "u");

  const phraseMeraNaam = new RegExp(
    String.raw`^(?:mera\s+(?:sahi\s+|correct\s+|actual\s+)?naam|मेरा\s+(?:सही\s+)?नाम|my\s+(?:correct\s+|real\s+|actual\s+)?name\s+is|sahi\s+naam|correct\s+name)\s+(.+?)(?:\s+(?:hai|है|hoon|हूँ|hai ji|jee))?$`,
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

  const clauseSplit = working.split(/[,;]|(?:\s+(?:aur|and|from|se|rehti\s+hoon)\s+)/i)[0].trim();
  const nameTarget = clauseSplit || working;

  let match = phraseMeraNaam.exec(nameTarget) || phraseMeraNaam.exec(working);
  if (match) {
    candidate = match[1];
    format = "introduced_name";
  } else if ((match = phraseMainHoon.exec(nameTarget) || phraseMainHoon.exec(working))) {
    candidate = match[1];
    format = "introduced_name";
  } else if ((match = phraseThisIs.exec(nameTarget) || phraseThisIs.exec(working))) {
    candidate = match[1];
    format = "introduced_name";
  } else if ((match = phraseCallMe.exec(nameTarget) || phraseCallMe.exec(working))) {
    candidate = match[1];
    format = "introduced_name";
  } else if ((match = phraseSuffix.exec(nameTarget) || phraseSuffix.exec(working))) {
    candidate = match[1];
    format = "introduced_name";
  } else if (plainNameRegex.test(nameTarget)) {
    const sentenceStarter = /^(?:i|we|my|mera|meri|mujhe|main|मैं|मेरा|मेरी|this|aap)\s/iu;
    if (!sentenceStarter.test(nameTarget)) {
      candidate = nameTarget;
      format = "plain_name";
    }
  } else if (plainNameRegex.test(working)) {
    const sentenceStarter = /^(?:i|we|my|mera|meri|mujhe|main|मैं|मेरा|मेरी|this|aap)\s/iu;
    if (!sentenceStarter.test(working)) {
      candidate = working;
      format = "plain_name";
    }
  }

  if (candidate) {
    const cleanedCandidate = candidate
      .replace(/\s+(?:hai|है|hoon|हूँ|hai ji|jee|ji|जी|hi hai|ही है|hi|ही|bol rahi hoon|bol raha hoon|बोल रही हूँ|बोल रहा हूँ|baat kar rahi hoon|baat kar raha hoon|here)$/iu, "")
      .replace(/^[,\s.-]+|[,\s.-]+$/g, "")
      .trim();

    if (plainNameRegex.test(cleanedCandidate) && isSaneName(cleanedCandidate)) {
      const formattedName = formatCandidateName(cleanedCandidate);
      return { clear: true, format, name: formattedName };
    }
  }

  return { clear: false, format: "unsupported_phrase" };
}

function isOffTopicQuestionUtterance(answer) {
  if (typeof answer !== "string" || !answer.trim()) return false;
  const a = answer.trim().toLowerCase();
  const hasQuestionForm =
    /[?]$/.test(a) ||
    /^(?:who\s+(?:is|was|won|plays)|what\s+(?:is|was|are|happened)|where\s+is|why\s+is|how\s+is|kaun|kisne|kisko|kya\s+hua|mausam\s+kaisa|score\s+kya|weather)\b/i.test(
      a,
    );
  const hasOffTopicTopic =
    /\b(?:cricket|match|ipl|football|sports|game|movie|movies|cinema|film|actor|actress|weather|mausam|barish|rain|score|winner|capital|france|modi|rahul|election|politics|president|minister|news|song|sing|dance|chai|coffee|biryani|burger|pizza)\b/i.test(
      a,
    );
  return (
    (hasQuestionForm && hasOffTopicTopic) ||
    /^(?:who\s+won|score\s+kya|match\s+kaun|weather\s+kaisa)/i.test(a)
  );
}

function handleInvalidAttempt(session, question, {
  clarificationPrefix,
  warningPrefix,
  firstAttemptMessage,
  secondAttemptMessage,
  repeatQuestionText,
  candidateAnswer,
} = {}) {
  session.invalidAttempts = session.invalidAttempts || {};
  const currentAttempts = (session.invalidAttempts[question.id] || 0) + 1;
  session.invalidAttempts[question.id] = currentAttempts;

  const originalQuestionText = repeatQuestionText || question.text;
  const isEnglish = session.language === "English";
  const isOffTopic = isOffTopicQuestionUtterance(candidateAnswer);

  if (currentAttempts === 1) {
    let prefix;
    if (isOffTopic) {
      prefix = isEnglish
        ? "I cannot answer questions unrelated to the interview. Let's focus on the interview. Please answer this question"
        : "Maaf kijiye, main interview se alag sawalon ke jawab nahi de sakti. Chaliye interview par dhyan dete hain. Kripya is sawal ka jawab dein";
    } else {
      prefix =
        clarificationPrefix ||
        (isEnglish
          ? "I didn't understand how that answers the question. Please provide a direct answer to this question"
          : "Maaf kijiye, mujhe samajh nahi aaya ki ye sawal ka jawab kaise hai. Kripya is sawal ka seedha jawab dein");
    }
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
    let prefix;
    if (isOffTopic) {
      prefix = isEnglish
        ? "Your previous responses were not related to the interview. This is your final attempt. Please answer the assessment question directly"
        : "Aapke pehle ke jawab interview se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya is sawal ka seedha jawab dein";
    } else {
      prefix =
        warningPrefix ||
        (isEnglish
          ? "Your previous answers were not related to this question. This is your final attempt. Please answer clearly and directly"
          : "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya is sawal ka seedha aur spasht jawab dein");
    }
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
  clearShortTermMemory(session);

  const terminationMessage = isEnglish
    ? "Due to repeated invalid or off-topic responses, we cannot proceed with the interview. Your interview ends here."
    : "Teen baar koshish karne ke baad bhi relevant jawab na milne ki wajah se interview aage nahi badh sakta. Aapka interview yahin samapt hota hai.";

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

function getNaturalAcknowledgement(question, session, candidateAnswer = "") {
  if (!question || !session) return null;
  const isEnglish = session.language === "English";
  const candidateName = session.candidateName ? session.candidateName.trim() : "";
  const ans = typeof candidateAnswer === "string" ? candidateAnswer.trim().toLowerCase() : "";

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

  // 5. Dynamic candidate-grounded acknowledgement
  if (ans) {
    if (/\b(?:waxing|facial|threading|cleanup|bleach|manicure|pedicure|hair)\b/i.test(ans)) {
      return isEnglish
        ? "Understood, thank you for sharing your experience with these services."
        : "Achha, in services ke baare mein samajh gayi.";
    }
    if (/\b(?:\d+|ek|do|teen|chaar|panch|paanch|chheh|saat|aath|das)\s*(?:saal|year|years|mahine|months)\b/i.test(ans)) {
      return isEnglish
        ? "Thank you, noted your experience."
        : "Achha, aapka experience note kar liya.";
    }
  }

  // 6. A3 to A8: Family background, salon experience, salon setup
  if (["A3", "A4", "A5", "A6", "A7", "A8"].includes(question.id)) {
    if (isEnglish) {
      const enMap = {
        A3: "Thank you for sharing that.",
        A4: "Understood.",
        A5: "Noted, thank you.",
        A6: "That's clear.",
        A7: "Got it.",
        A8: "Thank you for explaining.",
      };
      return enMap[question.id] || "Thank you for sharing that.";
    }
    const hiMap = {
      A3: "Theek hai.",
      A4: "Ji, samajh gayi.",
      A5: "Theek hai, noted.",
      A6: "Sahi hai.",
      A7: "Achha, samajh gayi.",
      A8: "Achha, theek hai.",
    };
    return hiMap[question.id] || "Theek hai.";
  }

  // 7. A9 to A11: Travel readiness, conveyance, language fluency
  if (["A9", "A10", "A11"].includes(question.id)) {
    if (isEnglish) {
      const enMap = {
        A9: "Understood, thank you.",
        A10: "Great, noted.",
        A11: "Thank you, that's helpful.",
      };
      return enMap[question.id] || "Understood, thank you.";
    }
    const hiMap = {
      A9: "Theek hai.",
      A10: "Bahut badhiya.",
      A11: "Theek hai, noted.",
    };
    return hiMap[question.id] || "Theek hai.";
  }

  // 8. Stage B: Technical skill evaluation (waxing, facial, threading, manicure, etc.)
  if (question.id.startsWith("B")) {
    if (isEnglish) {
      return question.id.endsWith("2") || question.id.endsWith("3")
        ? "Understood."
        : "Thank you for sharing that.";
    }
    const bOptions = ["Theek hai.", "Sahi hai.", "Ji, samajh gayi.", "Bahut badhiya."];
    const idx = (question.id.charCodeAt(question.id.length - 1) || 0) % bOptions.length;
    return bOptions[idx];
  }

  // 9. Stage C: Customer handling scenarios & salon ethics
  if (question.id.startsWith("C")) {
    if (isEnglish) {
      return "Understood, thank you for explaining.";
    }
    const cOptions = ["Theek hai, samajh gayi.", "Bilkul sahi.", "Theek hai."];
    const idx = (question.id.charCodeAt(question.id.length - 1) || 0) % cOptions.length;
    return cOptions[idx];
  }

  // Fallback:
  return isEnglish ? "Thank you." : "Theek hai.";
}

async function submitAnswer({
  sessionId,
  answer,
  expectedQuestionId,
  diagnosticRequestId,
  diagnosticPromptTurn,
  diagnosticSessionGeneration,
}, { interpretAnswerImpl = interpretAnswer, generateInquiryResponseImpl = generateInquiryResponse } = {}) {
  let interpretation = null;
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

  if (isSessionExpired(session)) {
    if (session.status === "in_progress" || session.status === "paused") {
      session.status = "incomplete";
      session.endedAt = new Date().toISOString();
      session.terminationReason = "session_expired";
    }
    clearShortTermMemory(session);
    return {
      status: 400,
      body: {
        success: false,
        code: "SESSION_EXPIRED",
        message: "This interview session has expired.",
        sessionStatus: session.status,
        expired: true,
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

  if (session.status === "manual_review") {
    return {
      status: 409,
      body: {
        success: false,
        code: "INTERVIEW_IN_REVIEW",
        message: "This interview session is under manual review and cannot accept further answers.",
        sessionStatus: "manual_review",
        identityVerificationFailed: Boolean(session.identityVerificationFailed),
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

  session.activeTurnSequence = (session.activeTurnSequence || 0) + 1;
  const currentTurnSequence = session.activeTurnSequence;

  function isSupersededTurn() {
    return session.activeTurnSequence !== currentTurnSequence;
  }

  function staleTurnResponse() {
    const latestQuestion = getCurrentQuestionForSession(session);
    return {
      status: 409,
      body: {
        success: false,
        staleTurn: true,
        message: "This turn was superseded by a newer candidate utterance.",
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: latestQuestion,
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
    if (session.pendingNameConfirmation && requestQuestionId === "A0") {
      session.invalidAttempts = {};
      session.candidateName = formatCandidateName(session.pendingNameConfirmation.name);
      const nameRecord = {
        questionId: "A2_NAME",
        questionText: questions[0].text,
        category: "Introduction",
        answer: session.candidateName,
        answeredAt: new Date().toISOString(),
      };
      const existingNameIdx = session.answers.findIndex((a) => a.questionId === "A2_NAME");
      if (existingNameIdx >= 0) {
        session.answers[existingNameIdx] = nameRecord;
      } else {
        session.answers.push(nameRecord);
      }
      recordShortTermMemoryTurn(session, nameRecord);
      session.pendingNameConfirmation = null;
      session.currentQuestionIndex += 1;
    } else if (session.pendingFollowUp?.questionId === "A0" && requestQuestionId === "A1") {
      session.pendingFollowUp = null;
      session.language = session.language || "Hindi";
      session.currentQuestionIndex += 1;
    } else if (session.pendingFollowUp?.questionId === requestQuestionId) {
      // Allowed: Request matches parent question ID of the active pending follow-up
    } else {
      console.info("[UC Interview Diagnostics] stale_answer_ignored", {
        requestId: safeRequestId,
        sessionKey,
        expectedQuestionId: requestQuestionId,
        currentQuestionId,
      });
      return staleQuestionResponse();
    }
  }

  const question = questions[session.currentQuestionIndex];
  const isNameQuestion = question?.id === "A2_NAME" || Boolean(session.pendingNameConfirmation);
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

  let cleanAnswer = typeof answer === "string" ? answer.trim() : "";

  function buildQuotaExhaustedResponse({ session: s = session, currentQuestion, isEnglish = false }) {
    const message = isEnglish
      ? "I'm sorry, I am currently facing a technical issue with answering. Your interview question is safe. We can try again in a little while."
      : "Maaf kijiye, abhi mujhe jawab dene mein technical dikkat aa rahi hai. Aapka interview question safe hai. Hum thodi der baad dobara koshish kar sakte hain.";

    console.warn("[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED", {
      sessionKey: s?.id ? s.id.slice(-8) : null,
      currentQuestionId: currentQuestion?.id || null,
      currentQuestionIndex: s?.currentQuestionIndex,
    });

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        clarificationRequired: true,
        quotaExhausted: true,
        interpretationUnavailable: true,
        code: "AI_RATE_LIMIT",
        message,
        questionNumber: (s?.currentQuestionIndex ?? 0) + 1,
        totalQuestions: questions.length,
        question: currentQuestion,
      },
    };
  }

  async function checkCandidateInquiry(
    qText = question?.text,
    qId = question?.id,
    candidateAnswer = cleanAnswer,
  ) {
    const textToCheck = typeof candidateAnswer === "string" ? candidateAnswer.trim() : cleanAnswer;
    if (!textToCheck || /^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(textToCheck)) {
      return null;
    }

    let inquiry = null;
    let quotaError = null;
    try {
      const interp = await interpretAnswerImpl({
        question: qText,
        answer: textToCheck,
        questionId: qId,
        language: session.language,
        sessionMemory: session.shortTermMemory,
        activeInquiry: session.activeInquiry,
        diagnosticRequestId: safeRequestId,
        diagnosticPromptTurn: safePromptTurn,
        diagnosticSessionGeneration: safeSessionGeneration,
      });

      if (isSupersededTurn()) {
        return null;
      }

      if (
        interp &&
        (interp.intent === "RELEVANT_COUNTER_QUESTION" ||
          interp.intent === "CLARIFICATION_REQUEST" ||
          interp.intent === "QUESTION_RATIONALE_INQUIRY" ||
          interp.intent === "CANDIDATE_CONSTRAINT_OR_HESITATION" ||
          interp.intent === "CANDIDATE_QUESTION" ||
          interp.intent === "REQUEST_TO_ASK_QUESTION" ||
          interp.unifiedIntent === UNIFIED_INTENTS.CANDIDATE_QUESTION ||
          interp.unifiedIntent === UNIFIED_INTENTS.CLARIFICATION_REQUEST ||
          interp.unifiedIntent === UNIFIED_INTENTS.REQUEST_TO_ASK_QUESTION ||
          interp.answerStatus === "counter_question" ||
          interp.answerStatus === "request_to_ask_question")
      ) {
        inquiry = interp;
      }
    } catch (err) {
      if (isQuotaExhaustedError(err)) {
        quotaError = err;
      }
    }

    if (inquiry) {
      return inquiry;
    }

    if (quotaError) {
      return {
        isQuotaExhausted: true,
        code: "AI_RATE_LIMIT",
        error: quotaError,
      };
    }

    const cq = detectCounterQuestion(
      textToCheck,
      { text: qText, id: qId, Step: qId },
      { language: session.language, activeInquiry: session.activeInquiry },
    );
    if (cq.isCounterQuestion) {
      return {
        responseText: cq.reply,
        counterQuestionAnswer: cq.reply,
        intent: cq.intent || "RELEVANT_COUNTER_QUESTION",
        subIntent: cq.subIntent || null,
        topic: cq.topic || "counter_question",
        isEnglish: Boolean(cq.isEnglish),
        answerStatus: "counter_question",
      };
    }

    return null;
  }

  async function resolveInquiryReply({
    targetQuestion,
    inquiryObj,
    defaultReply,
    candidateUtterance = cleanAnswer,
    turns = [],
    timeoutMs = INQUIRY_TIMEOUT_MS,
  }) {
    if (isSupersededTurn()) {
      return {
        replyText: (defaultReply || "").trim(),
        probeQuestion: "",
        topic: inquiryObj?.topic || session?.activeInquiry?.currentTopic || "general_inquiry",
        suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
      };
    }

    let replyText = (defaultReply || "").trim();
    let probeQuestion = "";
    let topic = inquiryObj?.topic || session?.activeInquiry?.currentTopic || "general_inquiry";
    let suggestedNextAction = "RESOLVE_AND_PROMPT_QUESTION";

    const isEnglish = session?.language === "English";
    const isGeneralOrProfessionalTopic =
      topic === "location_requirement" ||
      topic === "travel" ||
      topic === "general_knowledge" ||
      topic === "general_inquiry" ||
      topic === "customer_handling" ||
      topic === "communication" ||
      topic === "service_quality" ||
      topic === "interview_guidance" ||
      topic === "term_clarification" ||
      topic === "question_clarification";

    const effectiveUtterance = candidateUtterance || cleanAnswer;
    const isSensitivePolicyQuery =
      !isGeneralOrProfessionalTopic &&
      (topic === "earnings" ||
      topic === "working_hours" ||
      /\b(?:salary|earnings?|kamai|payout|incentive|bonus\s+slab)\b/i.test(effectiveUtterance));

    const onboardingDeferral = isEnglish
      ? "I am the screening assistant, so exact earnings, payout structures, toolkit costs, and schedules will be confirmed by the Urban Company partner and onboarding team."
      : "Main screening assistant hoon, isliye earnings, payout slabs, toolkit aur scheduling ki poori jaankari Urban Company partner team aur onboarding team share karegi.";

    if (typeof generateInquiryResponseImpl === "function") {
      try {
        const aiRes = await generateInquiryResponseImpl({
          candidateUtterance: effectiveUtterance,
          currentQuestion: {
            id: targetQuestion?.id,
            text: targetQuestion?.text,
            category: targetQuestion?.category || targetQuestion?.Block,
            stage: targetQuestion?.stage || targetQuestion?.Type,
          },
          activeInquiryTopic: topic,
          activeInquiryTurns: turns,
          sessionMemory: session?.shortTermMemory,
          language: session?.language || "Hindi",
          timeoutMs,
        });

        if (isSupersededTurn()) {
          return {
            replyText: (defaultReply || "").trim(),
            probeQuestion: "",
            topic,
            suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
          };
        }

        const hasPolicyViolation =
          aiRes && (isUnsupportedPolicyClaim(aiRes.replyText) || isUnsupportedPolicyClaim(aiRes.probeQuestion));

        if (aiRes && typeof aiRes.replyText === "string" && aiRes.replyText.trim().length >= 3 && !hasPolicyViolation) {
          replyText = aiRes.replyText.trim();
          probeQuestion = typeof aiRes.probeQuestion === "string" ? aiRes.probeQuestion.trim() : "";
          if (aiRes.topic) topic = aiRes.topic;
          if (aiRes.suggestedNextAction) suggestedNextAction = aiRes.suggestedNextAction;
        } else if (hasPolicyViolation) {
          replyText = onboardingDeferral;
          probeQuestion = "";
          suggestedNextAction = "DEFER_TO_ONBOARDING";
        }
      } catch (err) {
        if (isQuotaExhaustedError(err)) {
          console.warn("[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED", {
            action: "resolveInquiryReply_quota_exhausted",
            error: err.message,
          });
          return {
            isQuotaExhausted: true,
            code: "AI_RATE_LIMIT",
            replyText: "",
            probeQuestion: "",
            topic,
            suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
          };
        }
        console.info("[UC Interview] Contextual inquiry response generation failed, using deterministic fallback:", err?.message || err);
        if (err?.code === "AI_UNSUPPORTED_POLICY_CLAIM" || isSensitivePolicyQuery) {
          replyText = onboardingDeferral;
          probeQuestion = "";
          suggestedNextAction = "DEFER_TO_ONBOARDING";
        }
      }
    }

    return {
      replyText,
      probeQuestion,
      topic,
      suggestedNextAction,
    };
  }

  function composeSingleQuestionInquiryResponse({
    replyText = "",
    probeQuestion = "",
    isEnglish = false,
  }) {
    const cleanReply = (replyText || "").trim();
    const cleanProbe = (probeQuestion || "").trim();

    const clarificationCheck = isEnglish
      ? "Does that clarify your doubt, or would you like to ask anything else?"
      : "Kya aapka doubt clear ho gaya, ya aap kuch aur poochhna chahenge?";

    if (cleanProbe) {
      const base = cleanReply.replace(/\s*[?]\s*$/g, ".").trim();
      return `${base} ${cleanProbe}`.trim();
    }

    const hasQuestion =
      /[?]$/.test(cleanReply) ||
      /doubt\s+clear|kuch\s+aur\s+poochna|clarify\s+your\s+doubt|anything\s+else/i.test(cleanReply);

    if (hasQuestion) {
      return cleanReply;
    }

    return `${cleanReply} ${clarificationCheck}`.trim();
  }

  async function respondWithInquiry({
    targetQuestion,
    inquiryObj,
    deterministicReply,
    isNameConfirmation = false,
    candidateUtterance = cleanAnswer,
  }) {
    const effectiveUtterance = candidateUtterance || cleanAnswer;
    const isEnglish = session.language === "English" || Boolean(inquiryObj?.isEnglish) || classifyLanguage(effectiveUtterance) === "English";

    if (inquiryObj?.isQuotaExhausted) {
      return buildQuotaExhaustedResponse({
        session,
        currentQuestion: targetQuestion,
        isEnglish,
      });
    }

    if (
      inquiryObj?.intent === "REQUEST_TO_ASK_QUESTION" ||
      inquiryObj?.unifiedIntent === UNIFIED_INTENTS.REQUEST_TO_ASK_QUESTION ||
      isRequestToAskQuestion(effectiveUtterance, { language: session.language })
    ) {
      return handleRequestToAskQuestion({
        session,
        targetQuestion,
        cleanAnswer: effectiveUtterance,
        isEnglish,
      });
    }

    const inquiryResolution = await resolveInquiryReply({
      targetQuestion,
      inquiryObj,
      defaultReply: deterministicReply,
      candidateUtterance,
      turns: [],
    });

    if (inquiryResolution?.isQuotaExhausted) {
      return buildQuotaExhaustedResponse({
        session,
        currentQuestion: targetQuestion,
        isEnglish,
      });
    }

    const { replyText, probeQuestion, topic } = inquiryResolution;
    const effectiveReply = probeQuestion && !replyText.includes(probeQuestion)
      ? `${replyText} ${probeQuestion}`
      : replyText;
    const isRepeat = inquiryObj?.topic === "repeat_question";
    const isQuestionClarification = inquiryObj?.topic === "question_clarification";
    let combinedMessage;
    const isIdentityOrPurpose = inquiryObj?.topic === "identity" || inquiryObj?.topic === "screening_purpose";
    if (targetQuestion.id === "A0" && isIdentityOrPurpose) {
      session.pendingConsentOnly = true;
      session.lastInquiryEnglish = isEnglish;
      const consentPrompt = isEnglish ? "Shall we start?" : "Kya hum shuru karein?";
      if (isRepeat) {
        combinedMessage = `${effectiveReply} ${consentPrompt}`.trim();
      } else {
        const cleanReply = effectiveReply
          .replace(/\b(?:Aap\s+Hindi\s+mein\s+baat\s+karengi?\s+ya\s+English\s+mein\??|Would\s+you\s+like\s+to\s+speak\s+in\s+Hindi\s+or\s+English\??)\b/gi, "")
          .replace(/\b(?:Shuru\s+karein\??|Shall\s+we\s+start\??|Kya\s+hum\s+shuru\s+karein\??)\b/gi, "")
          .replace(/(?:Chaliye\s+aage\s+badhte\s+hain|Let's\s+continue\s+with\s+this\s+question)[:\s]*$/i, "")
          .replace(/\s{2,}/g, " ")
          .trim();
        combinedMessage = cleanReply.toLowerCase().includes(consentPrompt.toLowerCase())
          ? cleanReply
          : `${cleanReply} ${consentPrompt}`.trim();
      }
    } else if (isRepeat) {
      combinedMessage = `${effectiveReply} ${targetQuestion.text}`.trim();
    } else if (isQuestionClarification || isNameConfirmation || targetQuestion.id === "A2_NAME_CONFIRM") {
      combinedMessage = effectiveReply;
    } else {
      // Step 3 & Step 4: Answer delivery and Clarification check
      // Do NOT append targetQuestion.text here! Enforce at most one question.
      combinedMessage = composeSingleQuestionInquiryResponse({
        replyText,
        probeQuestion,
        isEnglish,
      });
    }

    if (isSupersededTurn()) {
      return staleTurnResponse();
    }

    if (!isNameConfirmation && targetQuestion.id !== "A2_NAME_CONFIRM" && !(targetQuestion.id === "A0" && isIdentityOrPurpose)) {
      startActiveInquiry(session, targetQuestion, effectiveUtterance, { ...inquiryObj, topic: topic || inquiryObj?.topic }, combinedMessage);
    }
    const hasFollowUp = Boolean(session.pendingFollowUp);
    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        ...(isNameConfirmation ? { nameConfirmationRequired: true } : { clarificationRequired: true }),
        counterQuestionHandled: true,
        inquiryState: "clarification_check",
        language: session.language,
        ...(hasFollowUp ? { followUpRequired: true, followUp: session.pendingFollowUp } : {}),
        message: combinedMessage,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: targetQuestion,
      },
    };
  }

  // ==========================================
  // ACTIVE INQUIRY SUB-DIALOGUE ROUTING
  // ==========================================
  if (session.activeInquiry && session.activeInquiry.status === "in_progress") {
    const isEnglish = session.language === "English";
    const currentActiveInquiry = session.activeInquiry;
    const activeQuestion = getCurrentQuestionForSession(session) || question;
    const activeQuestionText = activeQuestion.id === "A0"
      ? (isEnglish ? "Shall we start?" : "Kya hum shuru karein?")
      : activeQuestion.text;

    // Flow 5: Candidate explicitly asks to return/continue interview (e.g. "aage badhiye", "continue")
    if (isExplicitContinueRequest(cleanAnswer)) {
      currentActiveInquiry.turns.push({
        role: "candidate",
        text: cleanAnswer,
        timestamp: new Date().toISOString(),
      });
      session.activeInquiry = null;
      const pivotText = isEnglish
        ? `Sure! Let's return to our question: ${activeQuestionText}`
        : `Ji bilkul! Chaliye humare sawal par wapas aate hain: ${activeQuestionText}`;
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          counterQuestionHandled: true,
          inquiryState: "resumed_assessment",
          message: pivotText,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: getCurrentQuestionForSession(session),
        },
      };
    }

    // Step 7: Candidate confirms resumption when AI previously asked "kya hum aage badhayein?"
    if (currentActiveInquiry.state === "ready_to_resume") {
      if (isResumptionConfirmation(cleanAnswer)) {
        currentActiveInquiry.turns.push({
          role: "candidate",
          text: cleanAnswer,
          timestamp: new Date().toISOString(),
        });
        session.activeInquiry = null;
        const resumeText = isEnglish
          ? `Great! Let's return to our question: ${activeQuestionText}`
          : `Ji bilkul! Chaliye humare sawal par wapas aate hain: ${activeQuestionText}`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "resumed_assessment",
            message: resumeText,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: getCurrentQuestionForSession(session),
          },
        };
      }

      if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
        currentActiveInquiry.state = "AWAITING_CANDIDATE_QUESTION";
        const inviteText = isEnglish
          ? "Sure, please go ahead and ask your question. I am here to help."
          : "Ji haan, bilkul poochiye, aap apna question poochhiye. Main aapki madad karti hoon.";
        currentActiveInquiry.turns.push({
          role: "candidate",
          text: cleanAnswer,
          timestamp: new Date().toISOString(),
        });
        currentActiveInquiry.turns.push({
          role: "interviewer",
          text: inviteText,
          timestamp: new Date().toISOString(),
        });
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "AWAITING_CANDIDATE_QUESTION",
            message: inviteText,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: getCurrentQuestionForSession(session),
          },
        };
      }

      if (isNotReadyToResume(cleanAnswer)) {
        currentActiveInquiry.state = "inquiry_active";
        const inviteText = isEnglish
          ? "Sure, go ahead! What would you like to ask?"
          : "Ji, poochhiye, aap kya poochna chahte hain?";
        currentActiveInquiry.turns.push({
          role: "candidate",
          text: cleanAnswer,
          timestamp: new Date().toISOString(),
        });
        currentActiveInquiry.turns.push({
          role: "interviewer",
          text: inviteText,
          timestamp: new Date().toISOString(),
        });
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "inquiry_active",
            message: inviteText,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: getCurrentQuestionForSession(session),
          },
        };
      }
    }

    // Sub-dialogue state: AWAITING_CANDIDATE_QUESTION
    if (currentActiveInquiry.state === "AWAITING_CANDIDATE_QUESTION") {
      // 1. Candidate decides not to ask anything
      if (isCandidateDecidingNotToAsk(cleanAnswer)) {
        currentActiveInquiry.turns.push({
          role: "candidate",
          text: cleanAnswer,
          timestamp: new Date().toISOString(),
        });
        currentActiveInquiry.state = "ready_to_resume";
        const resumeAsk = isEnglish
          ? "Alright. Shall we continue with the interview?"
          : "Theek hai. Kya ab hum interview aage badhayein?";
        currentActiveInquiry.turns.push({
          role: "interviewer",
          text: resumeAsk,
          timestamp: new Date().toISOString(),
        });
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "ready_to_resume",
            message: resumeAsk,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: activeQuestion,
          },
        };
      }

      // 2. Candidate repeats permission request
      if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
        currentActiveInquiry.turns.push({
          role: "candidate",
          text: cleanAnswer,
          timestamp: new Date().toISOString(),
        });
        const reInvite = isEnglish
          ? "Sure, please go ahead and ask your question. I am here to help."
          : "Ji haan, bilkul poochiye, aap apna question poochhiye. Main aapki madad karti hoon.";
        currentActiveInquiry.turns.push({
          role: "interviewer",
          text: reInvite,
          timestamp: new Date().toISOString(),
        });
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "AWAITING_CANDIDATE_QUESTION",
            message: reInvite,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: activeQuestion,
          },
        };
      }

      // 3. Process candidate's actual question
      currentActiveInquiry.turnCount += 1;
      currentActiveInquiry.turns.push({
        role: "candidate",
        text: cleanAnswer,
        timestamp: new Date().toISOString(),
      });

      const cq = detectCounterQuestion(cleanAnswer, activeQuestion, {
        language: session.language,
        activeInquiry: currentActiveInquiry,
      });

      if (cq.isCounterQuestion && cq.topic) {
        currentActiveInquiry.currentTopic = cq.topic;
      }

      const deterministicReply = (
        cq.counterQuestionAnswer ||
        cq.reply ||
        ""
      ).trim();

      const inquiryResolution = await resolveInquiryReply({
        targetQuestion: activeQuestion,
        inquiryObj: cq.isCounterQuestion ? cq : { topic: currentActiveInquiry.currentTopic || "general_knowledge" },
        defaultReply: deterministicReply,
        candidateUtterance: cleanAnswer,
        turns: currentActiveInquiry.turns.slice(0, -1),
      });

      if (inquiryResolution?.isQuotaExhausted) {
        return buildQuotaExhaustedResponse({
          session,
          currentQuestion: activeQuestion,
          isEnglish,
        });
      }

      const { replyText, probeQuestion, topic } = inquiryResolution;

      if (topic) {
        currentActiveInquiry.currentTopic = topic;
      }

      const combinedMessage = composeSingleQuestionInquiryResponse({
        replyText,
        probeQuestion,
        isEnglish,
      });

      if (isSupersededTurn()) {
        return staleTurnResponse();
      }

      currentActiveInquiry.state = "clarification_check";
      currentActiveInquiry.turns.push({
        role: "interviewer",
        text: combinedMessage,
        timestamp: new Date().toISOString(),
      });
      if (currentActiveInquiry.turns.length > 12) {
        currentActiveInquiry.turns = currentActiveInquiry.turns.slice(-12);
      }

      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          counterQuestionHandled: true,
          inquiryState: "clarification_check",
          message: combinedMessage,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: activeQuestion,
        },
      };
    }


    // Candidate requests to ask another question or states they have another doubt
    if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
      currentActiveInquiry.state = "AWAITING_CANDIDATE_QUESTION";
      const inviteText = isEnglish
        ? "Sure, please go ahead and ask your question. I am here to help."
        : "Ji haan, bilkul poochiye, aap apna question poochhiye. Main aapki madad karti hoon.";
      currentActiveInquiry.turns.push({
        role: "candidate",
        text: cleanAnswer,
        timestamp: new Date().toISOString(),
      });
      currentActiveInquiry.turns.push({
        role: "interviewer",
        text: inviteText,
        timestamp: new Date().toISOString(),
      });
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          counterQuestionHandled: true,
          inquiryState: "AWAITING_CANDIDATE_QUESTION",
          message: inviteText,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: getCurrentQuestionForSession(session),
        },
      };
    }

    // Candidate indicates they are not ready to resume (e.g. "abhi nahi", "ruko", "wait")
    if (isNotReadyToResume(cleanAnswer)) {
      currentActiveInquiry.state = "inquiry_active";
      const inviteText = isEnglish
        ? "Sure, go ahead! What would you like to ask?"
        : "Ji, poochhiye, aap kya poochna chahte hain?";
      currentActiveInquiry.turns.push({
        role: "candidate",
        text: cleanAnswer,
        timestamp: new Date().toISOString(),
      });
      currentActiveInquiry.turns.push({
        role: "interviewer",
        text: inviteText,
        timestamp: new Date().toISOString(),
      });
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          counterQuestionHandled: true,
          inquiryState: "inquiry_active",
          message: inviteText,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: getCurrentQuestionForSession(session),
        },
      };
    }

    // Step 6: Candidate indicates doubt is cleared OR gives generic affirmative / acknowledgement
    // Ask whether to continue with the interview, and wait for confirmation before resuming
    if (
      isSubDialogueResolution(cleanAnswer) ||
      isGenericAcknowledgement(cleanAnswer) ||
      /^(?:haan|ha|han|haanji|hanji|yes|yeah|ji|theek\s+hai|thik\s+hai|okay|ok|accha|achha|acha|all\s+clear|no\s+doubts?)[.!?।\s]*$/i.test(cleanAnswer)
    ) {
      currentActiveInquiry.turns.push({
        role: "candidate",
        text: cleanAnswer,
        timestamp: new Date().toISOString(),
      });
      currentActiveInquiry.state = "ready_to_resume";
      const proceedAsk = isEnglish
        ? "Shall we continue with the interview?"
        : "Achha, kya ab hum interview aage badhayein?";
      currentActiveInquiry.turns.push({
        role: "interviewer",
        text: proceedAsk,
        timestamp: new Date().toISOString(),
      });
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          counterQuestionHandled: true,
          inquiryState: "ready_to_resume",
          message: proceedAsk,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: getCurrentQuestionForSession(session),
        },
      };
    }

    // Flow 2: Candidate answering an AI conversational follow-up/probe
    if (isAnsweringInquiryProbe(cleanAnswer, currentActiveInquiry.turns)) {
      const { isComposite, probePart, assessmentPart } = separateProbeAndAssessmentAnswer(
        cleanAnswer,
        currentActiveInquiry.turns,
        activeQuestion,
      );

      currentActiveInquiry.turns.push({
        role: "candidate",
        text: probePart,
        timestamp: new Date().toISOString(),
      });

      const locFacts = extractFallbackFacts(probePart);
      if (locFacts && Object.keys(locFacts).length > 0) {
        mergeShortTermMemoryFacts(session, locFacts);
      }

      let interviewerAck;
      if (locFacts?.cityPreference) {
        interviewerAck = isEnglish
          ? `Understood, noted your preference for ${locFacts.cityPreference}.`
          : `Samajh gayi, aapka ${locFacts.cityPreference} mein kaam karne ka preference note kar liya hai.`;
      } else if (locFacts?.travelWillingness === "yes" && locFacts?.relocationWillingness === "no") {
        interviewerAck = isEnglish
          ? `Understood, noted that you can travel locally but cannot relocate.`
          : `Samajh gayi, aap local travel ke liye taiyaar hain lekin shift nahi hona chahte, ye note kar liya hai.`;
      } else if (locFacts?.relocationCondition === "accommodation") {
        interviewerAck = isEnglish
          ? `Understood, your accommodation condition has been noted for the onboarding team.`
          : `Samajh gayi, agar accommodation mile toh aap consider kar sakte hain, ye onboarding team ke liye note kar liya hai.`;
      } else {
        interviewerAck = isEnglish
          ? `Understood!`
          : `Bahut accha, samajh gayi!`;
      }

      currentActiveInquiry.turns.push({
        role: "interviewer",
        text: interviewerAck,
        timestamp: new Date().toISOString(),
      });

      if (isComposite && assessmentPart) {
        // If candidate's composite part is asking another question, keep inquiry active!
        const partIsQuestion = detectCounterQuestion(assessmentPart, activeQuestion, { language: session.language }).isCounterQuestion;
        if (!partIsQuestion) {
          session.activeInquiry = null;
        }
        cleanAnswer = assessmentPart;
      } else {
        session.activeInquiry = null;
        const resumeMessage = isEnglish
          ? `${interviewerAck} Let's return to our question: ${activeQuestionText}`
          : `${interviewerAck} Chaliye ab humare sawal par wapas aate hain: ${activeQuestionText}`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "resumed_assessment",
            message: resumeMessage,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: getCurrentQuestionForSession(session),
          },
        };
      }
    }

    // Flow 1: Candidate asks another question, follow-up, or constraint
    const followUpInquiry = await checkCandidateInquiry(activeQuestionText, activeQuestion.id);
    if (followUpInquiry) {
      if (followUpInquiry.isQuotaExhausted) {
        return buildQuotaExhaustedResponse({
          session,
          currentQuestion: activeQuestion,
          isEnglish,
        });
      }

      currentActiveInquiry.turnCount += 1;
      if (followUpInquiry.topic) {
        currentActiveInquiry.currentTopic =
          followUpInquiry.topic === "earnings" ? "unavailable_info" : followUpInquiry.topic;
      }
      currentActiveInquiry.turns.push({
        role: "candidate",
        text: cleanAnswer,
        timestamp: new Date().toISOString(),
      });

      // Repeat question inquiry request during active inquiry
      if (followUpInquiry.topic === "repeat_question") {
        session.activeInquiry = null;
        const repeatReply = isEnglish
          ? `Sure, let's return to our question: ${activeQuestionText}`
          : `Ji bilkul, chaliye humare sawal par wapas aate hain: ${activeQuestionText}`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "resumed_assessment",
            message: repeatReply,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: getCurrentQuestionForSession(session),
          },
        };
      }

      // Check repetitive inquiry loop
      const isRepetitive = isRepetitiveInquiry(cleanAnswer, currentActiveInquiry.turns.slice(0, -1));
      if (isRepetitive) {
        session.activeInquiry = null;
        const loopReply = isEnglish
          ? `As mentioned earlier, Urban Company service bookings are in nearby local areas and full training is provided. Let's return to our question: ${activeQuestionText}`
          : `Jaise maine pehle bataya, Urban Company mein kaam aapke paas ke local area mein hi hota hai aur poori training milti hai. Chaliye ab sawal par wapas aate hain: ${activeQuestionText}`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "resumed_assessment",
            message: loopReply,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: getCurrentQuestionForSession(session),
          },
        };
      }

      const deterministicReply = (
        followUpInquiry.counterQuestionAnswer ||
        followUpInquiry.responseText ||
        followUpInquiry.clarificationQuestion ||
        ""
      ).trim();

      const inquiryResolution = await resolveInquiryReply({
        targetQuestion: activeQuestion,
        inquiryObj: followUpInquiry,
        defaultReply: deterministicReply,
        turns: currentActiveInquiry.turns.slice(0, -1),
      });

      if (inquiryResolution?.isQuotaExhausted) {
        return buildQuotaExhaustedResponse({
          session,
          currentQuestion: activeQuestion,
          isEnglish,
        });
      }

      const { replyText, probeQuestion } = inquiryResolution;

      // Configurable safety boundary to prevent infinite cross-questioning
      if (currentActiveInquiry.turnCount >= MAX_ADAPTIVE_INQUIRY_TURNS) {
        session.activeInquiry = null;
        const pivotText = isEnglish
          ? "We have covered this in detail. Let's now return to our question:"
          : "Humne is baare mein vistaar se baat kar li hai. Chaliye ab humare sawal par wapas aate hain:";
        const replyClean = (replyText || "").replace(/\s*[?]\s*$/g, ".").trim();
        const combinedMessage = `${replyClean} ${pivotText} ${activeQuestionText}`.trim();
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            inquiryState: "resumed_assessment",
            message: combinedMessage,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: getCurrentQuestionForSession(session),
          },
        };
      }

      // Step 4 & 5: Adaptive depth - answer candidate's doubt and ask at most one clarification check
      const combinedMessage = composeSingleQuestionInquiryResponse({
        replyText,
        probeQuestion,
        isEnglish,
      });

      if (isSupersededTurn()) {
        return staleTurnResponse();
      }

      currentActiveInquiry.state = "clarification_check";
      currentActiveInquiry.turns.push({
        role: "interviewer",
        text: combinedMessage,
        timestamp: new Date().toISOString(),
      });
      if (currentActiveInquiry.turns.length > 12) {
        currentActiveInquiry.turns = currentActiveInquiry.turns.slice(-12);
      }

      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          counterQuestionHandled: true,
          inquiryState: "clarification_check",
          message: combinedMessage,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: getCurrentQuestionForSession(session),
        },
      };
    }


    // Flow 3: Candidate provided an actual answer (or invalid answer attempt).
    // Close active inquiry safely and fall through to standard question validation.
    session.activeInquiry = null;
  }

  if (session.pendingNameConfirmation) {
    const pendingName = session.pendingNameConfirmation.name;
    const isEnglish = session.language === "English";
    const isFromProfile = session.pendingNameConfirmation.fromProfile;
    let confirmPrompt;
    if (isFromProfile) {
      confirmPrompt = isEnglish
        ? `Your profile name is ${pendingName}. Is this correct?`
        : `Aapke profile mein naam ${pendingName} hai. Kya ye sahi hai?`;
    } else {
      confirmPrompt = isEnglish
        ? `Your name is ${pendingName}, right?`
        : `Aapka naam ${pendingName} hai, sahi hai na?`;
    }

    if (/^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(cleanAnswer)) {
      session.invalidAttempts = {};
      const reprompt = isEnglish
        ? `I couldn't hear you clearly. Could you please confirm if your name is ${pendingName}?`
        : `Maaf kijiye, mujhe aapki aawaz theek se nahi aayi. Kripya confirm karein ki kya aapka naam ${pendingName} hai?`;
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          nameConfirmationRequired: true,
          candidateName: pendingName,
          message: `${reprompt} ${confirmPrompt}`,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A2_NAME_CONFIRM",
            Step: "A2_NAME_CONFIRM",
            text: confirmPrompt,
            category: "Introduction",
          },
        },
      };
    }

    if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
      return handleRequestToAskQuestion({
        session,
        targetQuestion: {
          id: "A2_NAME_CONFIRM",
          Step: "A2_NAME_CONFIRM",
          text: confirmPrompt,
          category: "Introduction",
          stage: "SETUP",
        },
        cleanAnswer,
        isEnglish,
      });
    }

    const normalizedConfirmation = cleanAnswer
      .toLowerCase()
      .replace(/[,;]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const isExplicitQuestion =
      /[?]|(?:^|\b)(?:kyun|kyu|why|kaise|kya\s+hoga|kya\s+aap|kya\s+mujhe|batao|explain|zaroori\s+kyun|kyun\s+chahiye|kyun\s+pooch|kyun\s+puch)\b/i.test(
        cleanAnswer,
      );
    const cq = detectCounterQuestion(
      cleanAnswer,
      { text: confirmPrompt },
      { language: session.language },
    );
    if (isExplicitQuestion || cq.isCounterQuestion) {
      const inquiry = await checkCandidateInquiry(confirmPrompt, "A2_NAME_CONFIRM");
      if (inquiry) {
        const replyText = (
          inquiry.counterQuestionAnswer ||
          inquiry.responseText ||
          inquiry.clarificationQuestion ||
          cq.reply ||
          ""
        ).trim();
        return respondWithInquiry({
          targetQuestion: {
            id: "A2_NAME_CONFIRM",
            Step: "A2_NAME_CONFIRM",
            text: confirmPrompt,
            category: "Introduction",
          },
          inquiryObj: inquiry || cq,
          deterministicReply: replyText,
          isNameConfirmation: true,
        });
      }
    }

    let isAffirmative = isNameConfirmationAffirmative(
      cleanAnswer,
      pendingName,
      normalizedConfirmation,
    );

    let isNegative =
      /^(?:no|nope|nahi|nahin|nhi|galat|wrong(?:\s+name)?|incorrect|not\s+(?:correct|right|my\s+name)|(?:that|it|this|ye|that's)\s+(?:is\s+)?not\s+my\s+name|ye\s+mera\s+naam\s+nahi\s+hai|mera\s+naam\s+galat\s+hai|galat\s+naam\s+hai|galat\s+hai|naam\s+galat\s+hai|गलत|गलत\s+है|नहीं|नही|गलत\s+नाम\s+है|मेरा\s+नाम\s+गलत\s+है|(?:नहीं|नही)(?:\s+(?:गलत|गलत\s+है|ये\s+गलत\s+है|ये\s+मेरा\s+नाम\s+नहीं\s+है|मेरा\s+नाम\s+नहीं\s+है)))(?:\s+(?:hai|ji|sir|madam))?[.!?।\s]*$/iu.test(
        normalizedConfirmation,
      ) ||
      (/^(?:no|nope|nahi|nahin|nhi)\b/i.test(normalizedConfirmation) &&
        /\b(?:galat|wrong|incorrect|not\s+my\s+name|galat\s+hai)\b/i.test(normalizedConfirmation));

    const nameClassification = classifyNameAnswer(cleanAnswer);
    let isExplicitCorrectionPhrase =
      nameClassification.clear &&
      isSaneName(nameClassification.name) &&
      (nameClassification.format === "introduced_name" ||
        /^(?:no|nope|nahi|nahin|nhi)\s*[,.:;!-]/iu.test(cleanAnswer));

    if (!isAffirmative && !isNegative && !isExplicitCorrectionPhrase) {
      try {
        const interp = await interpretAnswerImpl({
          question: confirmPrompt,
          answer: cleanAnswer,
          questionId: "A2_NAME_CONFIRM",
          language: session.language,
          sessionMemory: session.shortTermMemory,
          diagnosticRequestId: safeRequestId,
          diagnosticPromptTurn: safePromptTurn,
          diagnosticSessionGeneration: safeSessionGeneration,
        });

        if (interp) {
          if (
            interp.intent === "RELEVANT_COUNTER_QUESTION" ||
            interp.intent === "CLARIFICATION_REQUEST" ||
            interp.answerStatus === "counter_question"
          ) {
            const replyText = (
              interp.counterQuestionAnswer ||
              interp.responseText ||
              interp.clarificationQuestion ||
              ""
            ).trim();
            const combinedMessage = replyText
              .toLowerCase()
              .includes(confirmPrompt.toLowerCase().trim())
              ? replyText
              : `${replyText} ${confirmPrompt}`;
            return {
              status: 200,
              body: {
                success: true,
                completed: false,
                nameConfirmationRequired: true,
                counterQuestionHandled: true,
                message: combinedMessage,
                questionNumber: session.currentQuestionIndex + 1,
                totalQuestions: questions.length,
                question: {
                  id: "A2_NAME_CONFIRM",
                  Step: "A2_NAME_CONFIRM",
                  text: confirmPrompt,
                  category: "Introduction",
                },
              },
            };
          }

          if (interp.intent === "INTERVIEW_ANSWER") {
            const understood = (interp.understoodAnswer || "").toLowerCase();
            if (
              /\b(?:yes|haan|han|agree|confirmed|correct|right|sahi)\b/i.test(understood) ||
              /(?:हाँ|हां|सही|बिल्कुल|कन्फर्म|पुष्टि)/u.test(understood)
            ) {
              isAffirmative = true;
            } else if (
              /\b(?:no|nahi|nahin|reject|wrong|galat|incorrect)\b/i.test(understood) ||
              /(?:नहीं|नही|गलत)/u.test(understood)
            ) {
              isNegative = true;
            } else {
              const parsedFromUnderstood = classifyNameAnswer(interp.understoodAnswer);
              if (parsedFromUnderstood.clear && isSaneName(parsedFromUnderstood.name)) {
                nameClassification.clear = true;
                nameClassification.name = parsedFromUnderstood.name;
                isExplicitCorrectionPhrase = true;
              }
            }
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    if (isAffirmative) {
      session.invalidAttempts = {};
      session.candidateName = formatCandidateName(pendingName);
      mergeShortTermMemoryFacts(session, { candidateName: session.candidateName });
      const nameRecord = {
        questionId: "A2_NAME",
        questionText: questions[0].text,
        category: "Introduction",
        answer: session.candidateName,
        answeredAt: new Date().toISOString(),
      };
      const existingNameIdx = session.answers.findIndex((a) => a.questionId === "A2_NAME");
      if (existingNameIdx >= 0) {
        session.answers[existingNameIdx] = nameRecord;
      } else {
        session.answers.push(nameRecord);
      }
      recordShortTermMemoryTurn(session, nameRecord);
      session.pendingNameConfirmation = null;
      session.currentQuestionIndex += 1;

      // Issue 3 Requirement 8: If no registered profile identity exists, flag
      // for manual review so self-reported name is not silently treated as verified.
      if (!session.profileName) {
        session.manualReviewRequired = true;
        session.manualReviewReason =
          "Identity verification unconfirmed: no registered profile found for session.";
      }

      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          nameConfirmed: true,
          candidateName: session.candidateName,
          acknowledgement: isEnglish ? "Thank you." : "Bahut badhiya.",
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: questions[session.currentQuestionIndex],
        },
      };
    }

    if (isNegative) {
      session.invalidAttempts = {};

      // Issue 3: Track rejection count with registered profile identity.
      // Repeated rejections of the registered name indicate identity mismatch.
      if (session.profileName) {
        session.nameRejectionCount = (session.nameRejectionCount || 0) + 1;
        if (session.nameRejectionCount >= 2) {
          session.status = "manual_review";
          session.identityVerificationFailed = true;
          session.manualReviewRequired = true;
          session.manualReviewReason =
            "Identity verification failed: candidate repeatedly rejected the registered profile name.";
          session.candidateName = session.profileName;
          clearShortTermMemory(session);
          const mismatchMessage = isEnglish
            ? `This interview is associated with ${session.profileName}'s registered profile. Since the name could not be verified, this session has been flagged for manual review.`
            : `Ye interview ${session.profileName} ke registered profile se juda hai. Naam verify nahi ho paya, isliye is session ko manual review ke liye flag kar diya gaya hai.`;
          return {
            status: 200,
            body: {
              success: true,
              completed: false,
              identityVerificationFailed: true,
              manualReviewRequired: true,
              sessionStatus: "manual_review",
              candidateName: session.profileName,
              message: mismatchMessage,
              questionNumber: session.currentQuestionIndex + 1,
              totalQuestions: questions.length,
              question: {
                id: "A2_NAME_MISMATCH",
                Step: "A2_NAME_MISMATCH",
                text: mismatchMessage,
                category: "Introduction",
              },
            },
          };
        }
      }

      session.pendingNameConfirmation = null;
      session.candidateName = null;
      const existingNameIdx = session.answers.findIndex((a) => a.questionId === "A2_NAME");
      if (existingNameIdx >= 0) {
        session.answers.splice(existingNameIdx, 1);
      }
      const reprompt = isEnglish
        ? "I apologize. Please state your correct name."
        : "Theek hai, kripya apna sahi naam batayein.";
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          nameConfirmationRequired: false,
          nameCorrectionRequired: true,
          message: reprompt,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A2_NAME",
            Step: "A2_NAME",
            text: reprompt,
            category: "Introduction",
          },
        },
      };
    }

    if (isExplicitCorrectionPhrase) {
      session.invalidAttempts = {};
      const newName = formatCandidateName(nameClassification.name);

      // Two-stage identity check on correction if registered profile name exists:
      if (session.profileName && !isNameMatch(newName, session.profileName)) {
        session.identityMismatchAttempts = (session.identityMismatchAttempts || 0) + 1;
        session.candidateName = session.profileName; // Preserve authoritative profile identity

        if (session.identityMismatchAttempts === 1) {
          session.warningLevel = 1;
          const warningMsg = isEnglish
            ? `This interview is registered for ${session.profileName}. The name provided did not match. Please state your registered name clearly.`
            : `Ye interview ${session.profileName} ke naam par registered hai. Kripya apna registered naam dobara spasht batayein.`;
          delete session.pendingNameConfirmation;
          return {
            status: 200,
            body: {
              success: true,
              completed: false,
              identityMismatchWarning: true,
              warningLevel: 1,
              candidateName: session.profileName,
              message: warningMsg,
              questionNumber: session.currentQuestionIndex + 1,
              totalQuestions: questions.length,
              question: {
                id: "A2_NAME",
                Step: "A2_NAME",
                text: warningMsg,
                category: "Introduction",
              },
            },
          };
        }

        session.status = "manual_review";
        session.identityVerificationFailed = true;
        session.manualReviewRequired = true;
        session.manualReviewReason =
          "Identity mismatch: candidate corrected name to a value that does not match the registered profile after warning.";
        clearShortTermMemory(session);
        const mismatchMessage = isEnglish
          ? `This interview is associated with ${session.profileName}'s registered profile. The corrected name does not match. This session has been flagged for manual review.`
          : `Ye interview ${session.profileName} ke registered profile se juda hai. Aapne jo naam bataya woh match nahi karta. Is session ko manual review ke liye flag kar diya gaya hai.`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            identityVerificationFailed: true,
            manualReviewRequired: true,
            sessionStatus: "manual_review",
            candidateName: session.profileName,
            message: mismatchMessage,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: {
              id: "A2_NAME_MISMATCH",
              Step: "A2_NAME_MISMATCH",
              text: mismatchMessage,
              category: "Introduction",
            },
          },
        };
      }

      session.identityMismatchAttempts = 0;

      session.candidateName = newName;
      session.pendingNameConfirmation = { name: newName, fromProfile: false };
      const nextConfirmPrompt = isEnglish
        ? `Your name is ${newName}, right?`
        : `Aapka naam ${newName} hai, sahi hai na?`;
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          nameConfirmationRequired: true,
          candidateName: newName,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A2_NAME_CONFIRM",
            Step: "A2_NAME_CONFIRM",
            text: nextConfirmPrompt,
            category: "Introduction",
          },
          message: nextConfirmPrompt,
        },
      };
    }

    const isOffTopic = isOffTopicQuestionUtterance(cleanAnswer);
    session.invalidAttempts = session.invalidAttempts || {};
    const currentConfirmAttempts = (session.invalidAttempts["A2_NAME_CONFIRM"] || 0) + 1;
    session.invalidAttempts["A2_NAME_CONFIRM"] = currentConfirmAttempts;

    if (currentConfirmAttempts >= 3) {
      session.status = "terminated";
      session.terminationReason = "repeated_invalid_answers";
      session.terminatedAt = new Date().toISOString();
      session.terminatedAtQuestionId = "A2_NAME_CONFIRM";
      session.completedAt = session.terminatedAt;
      session.endedAt = session.terminatedAt;
      clearShortTermMemory(session);

      const terminationMessage = isEnglish
        ? "Due to repeated invalid or off-topic responses, we cannot proceed with the interview. Your interview ends here."
        : "Teen baar koshish karne ke baad bhi relevant jawab na milne ki wajah se interview aage nahi badh sakta. Aapka interview yahin samapt hota hai.";

      return {
        status: 200,
        body: {
          success: true,
          completed: true,
          terminated: true,
          sessionStatus: "terminated",
          terminationReason: session.terminationReason,
          terminatedAtQuestionId: "A2_NAME_CONFIRM",
          terminatedAt: session.terminatedAt,
          message: terminationMessage,
          answeredQuestions: session.answers.length,
          totalQuestions: questions.length,
        },
      };
    }

    let repromptMsg;
    if (isOffTopic) {
      repromptMsg =
        currentConfirmAttempts === 1
          ? isEnglish
            ? `I cannot answer questions unrelated to the interview. Let's focus on the interview. Please confirm: your name is ${pendingName}, right?`
            : `Maaf kijiye, main interview se alag sawalon ke jawab nahi de sakti. Chaliye interview par dhyan dete hain. Kripya confirm karein: kya aapka naam ${pendingName} hai?`
          : isEnglish
            ? `Your previous responses were not related to the interview. This is your final attempt. Please confirm: your name is ${pendingName}, right? You can say Yes or No.`
            : `Aapke pehle ke jawab interview se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya confirm karein ki kya aapka naam ${pendingName} hai? Aap Haan ya Nahi bol sakti hain.`;
    } else {
      repromptMsg =
        currentConfirmAttempts === 1
          ? isEnglish
            ? `Please confirm: your name is ${pendingName}, right? You can say Yes or No.`
            : `Kripya confirm karein: kya aapka naam ${pendingName} hai? Aap Haan ya Nahi bol sakti hain.`
          : isEnglish
            ? `Your previous response was not clear. This is your final attempt. Please confirm if your name is ${pendingName} (Yes or No).`
            : `Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya confirm karein ki kya aapka naam ${pendingName} hai (Haan ya Nahi).`;
    }

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        nameConfirmationRequired: true,
        candidateName: pendingName,
        message: repromptMsg,
        warningLevel: currentConfirmAttempts,
        warning: currentConfirmAttempts > 1,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: {
          id: "A2_NAME_CONFIRM",
          Step: "A2_NAME_CONFIRM",
          text: confirmPrompt,
          category: "Introduction",
        },
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
            id: `${pending.questionId}_${pending.type.toUpperCase()}`,
            Step: `${pending.questionId}_${pending.type.toUpperCase()}`,
            text: pending.prompt,
            category: pending.category || "Location & movement",
          },
        },
      };
    }

    if (/^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(followUpAnswer)) {
      session.invalidAttempts = {};
      const isEnglish = session.language === "English";
      const reprompt = isEnglish
        ? "I couldn't hear you clearly. Could you please repeat or type your answer?"
        : "Maaf kijiye, mujhe aapki aawaz theek se nahi aayi. Kripya dobara batayein ya neeche type karein.";
      return askAgain(`${reprompt} ${pending.prompt}`);
    }

    const currentPendingQ = getCurrentQuestionForSession(session) || {
      id: `${pending.questionId}_${pending.type.toUpperCase()}`,
      Step: `${pending.questionId}_${pending.type.toUpperCase()}`,
      text: pending.prompt,
      category: pending.category || "Location & movement",
    };

    if (isRequestToAskQuestion(followUpAnswer, { language: session.language })) {
      const isEnglish = session.language === "English";
      return handleRequestToAskQuestion({
        session,
        targetQuestion: currentPendingQ,
        cleanAnswer: followUpAnswer,
        isEnglish,
      });
    }

    if (pending.type === "language_preference") {
      const sep = separateLanguageAndInquiry(followUpAnswer, {
        question: currentPendingQ,
        activeInquiry: session.activeInquiry,
      });

      if (sep.hasLanguagePreference && sep.detectedLanguage) {
        session.invalidAttempts = {};
        session.language = sep.detectedLanguage;
        mergeShortTermMemoryFacts(session, { preferredLanguage: sep.detectedLanguage });
        session.answers.push({
          questionId: "A0_LANGUAGE_PREFERENCE",
          questionText: pending.prompt,
          category: "Setup",
          answer: followUpAnswer,
          answeredAt: new Date().toISOString(),
          language: sep.detectedLanguage,
        });
        session.pendingFollowUp = null;
        session.currentQuestionIndex += 1;
        const nextQ = questions[session.currentQuestionIndex];

        if (sep.hasInquiry) {
          const inquiryCandidateUtterance = sep.cleanQuestion || sep.extractedQuestion || followUpAnswer;
          if (isRequestToAskQuestion(inquiryCandidateUtterance, { language: sep.detectedLanguage })) {
            return handleRequestToAskQuestion({
              session,
              targetQuestion: nextQ,
              cleanAnswer: inquiryCandidateUtterance,
              isEnglish: sep.detectedLanguage === "English",
            });
          }
          const inquiry = await checkCandidateInquiry(nextQ.text, nextQ.id, inquiryCandidateUtterance);
          const activeInquiryObj = inquiry || sep.counterQuestion || null;
          const replyText = (
            inquiry?.counterQuestionAnswer ||
            inquiry?.responseText ||
            inquiry?.clarificationQuestion ||
            sep.counterQuestion?.reply ||
            ""
          ).trim();

          return respondWithInquiry({
            targetQuestion: nextQ,
            inquiryObj: activeInquiryObj,
            deterministicReply: replyText,
            candidateUtterance: inquiryCandidateUtterance,
          });
        }

        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            acknowledgement: getNaturalAcknowledgement(nextQ, session),
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            consentOutcome: session.consentOutcome || "accepted",
            language: session.language,
            question: nextQ,
          },
        };
      }

      // Check if candidate asked an inquiry without selecting language
      const cq = detectCounterQuestion(
        followUpAnswer,
        currentPendingQ,
        { language: session.language },
      );
      const isExplicitCandidateQuestion =
        cq.isCounterQuestion ||
        /[?]|(?:^|\b)(?:where|kahan|kidhar|why|kyun|kyu|how\s+far|kitn[aie]\s+door|kitna\s+distance|kaise|what\s+if|agar|compulsory|zaroori\s+hai|zaruri\s+hai|relocate\s+karna\s+hoga|shift\s+hona\s+hoga|kya|what|difference|explain|batao)\b/i.test(
          followUpAnswer,
        );

      if (isExplicitCandidateQuestion) {
        const inquiry = await checkCandidateInquiry(pending.prompt, currentPendingQ.id, followUpAnswer);
        if (inquiry || cq.isCounterQuestion) {
          const replyText = (
            inquiry?.counterQuestionAnswer ||
            inquiry?.responseText ||
            inquiry?.clarificationQuestion ||
            cq.reply ||
            ""
          ).trim();
          const activeInquiryObj = inquiry || cq || null;
          return respondWithInquiry({
            targetQuestion: currentPendingQ,
            inquiryObj: activeInquiryObj,
            deterministicReply: replyText,
            candidateUtterance: followUpAnswer,
          });
        }
      }

      const isEnglish = session.language === "English";
      const reprompt = isEnglish
        ? "Please let me know: would you like to speak in Hindi or English?"
        : "Kripya batayein, aap Hindi mein baat karengi ya English mein?";
      return askAgain(reprompt);
    }

    const cq = detectCounterQuestion(
      followUpAnswer,
      currentPendingQ,
      { language: session.language },
    );
    const isExplicitCandidateQuestion =
      cq.isCounterQuestion ||
      /[?]|(?:^|\b)(?:where|kahan|kidhar|why|kyun|kyu|how\s+far|kitn[aie]\s+door|kitna\s+distance|kaise|what\s+if|agar|compulsory|zaroori\s+hai|zaruri\s+hai|relocate\s+karna\s+hoga|shift\s+hona\s+hoga)\b/i.test(
        followUpAnswer,
      );

    if (isExplicitCandidateQuestion) {
      const inquiry = await checkCandidateInquiry(pending.prompt, currentPendingQ.id);
      if (inquiry || cq.isCounterQuestion) {
        const replyText = (
          inquiry?.counterQuestionAnswer ||
          inquiry?.responseText ||
          inquiry?.clarificationQuestion ||
          cq.reply ||
          ""
        ).trim();
        const activeInquiryObj = inquiry || cq || null;
        return respondWithInquiry({
          targetQuestion: currentPendingQ,
          inquiryObj: activeInquiryObj,
          deterministicReply: replyText,
        });
      }
    }

    if (pending.type === "travel_clarification") {
      if (isExplicitContinueRequest(followUpAnswer)) {
        const isEnglish = session.language === "English";
        const reprompt = isEnglish
          ? "Sure, let's continue with our question:"
          : "Ji, chaliye sawal par aage badhte hain:";
        return askAgain(`${reprompt} ${pending.prompt}`);
      }

      if (isGenericAcknowledgement(followUpAnswer)) {
        const isEnglish = session.language === "English";
        const reprompt = isEnglish
          ? "Understood. Please let me know: are you comfortable travelling to nearby service areas?"
          : "Theek hai. Kripya batayein: kya aap aas-paas ke service areas mein travel karne ke liye comfortable hain?";
        return askAgain(reprompt);
      }

      const locationClassification = classifyLocation(followUpAnswer);

      const isWhereToTravel =
        /\b(?:where\s+(?:would\s+i|do\s+i|to|should\s+i|can\s+i)?\s*(?:need\s+to\s+travel|have\s+to\s+go|need\s+to\s+relocate|have\s+to\s+relocate|need\s+to\s+shift|have\s+to\s+shift|travel|relocate|shift|go)|kahan\s+(?:travel\s+karna|jana|jaana|shift\s+hona|relocate\s+karna)\s+(?:hoga|padega|hai)|kidhar\s+(?:travel\s+karna|jana|jaana|shift\s+hona|relocate\s+karna)\s+(?:hoga|padega|hai)|kitn[aie]\s+door\s+(?:jana|jaana|travel|shift)|which\s+area.*(?:visit|go|travel|relocate|shift)|kahan\s+hoga\s+kaam|have\s+to\s+(?:relocate|shift|move)|need\s+to\s+(?:relocate|shift|move)|shift\s+cities|relocate\s+cities|move\s+cities|doosre\s+sheher|dusre\s+sheher)\b/i.test(
          normalized,
        ) ||
        /^(?:how\s+far(?:\s+is\s+it)?|kitn[aie]\s+door|kitna\s+distance|how\s+much\s+distance)[.!?\s]*$/i.test(normalized) ||
        (/\b(?:where|kahan|kidhar|which\s+area|how\s+far|does\s+this\s+mean)\b/i.test(normalized) &&
          /\b(?:travel|relocate|shift|jana|jaana|visit|go|location|distance|ghar|area|cities|city)\b/i.test(normalized));

      const isCrossQuestion =
        isWhereToTravel ||
        cq.isCounterQuestion ||
        /\b(?:kyun|kyu|why|reason|zaruri\s+kyun|kyun\s+jana|door\s+kyun|kyun\s+zaruri|relocate\s+kyun|shift\s+kyun|compulsory|zaroori\s+hai|zaruri\s+hai)\b/i.test(
          normalized,
        );

      const isConveyanceConcern =
        /\b(?:gaadi|scooty|bike|vehicle|conveyance|two\s*wheeler|transport)\s*(?:nahi|nahin|nhi|chalana\s+nahi|chalati\s+nahi)\b|\b(?:no|don't\s+have|dont\s+have)\s*(?:vehicle|scooty|bike|car)\b|\bmera\s+paas\s+(?:gaadi|scooty|bike|vehicle)\s+nahi\b/i.test(
          normalized,
        );

      const isReluctantOrUnsure =
        /\b(?:difficult|mushkil|hard|problem|dikkat|issue|not\s+sure|unsure|pata\s+nahi|pata\s+nahin|pakka\s+nahi|doubt|shayad|no\s+idea|kuch\s+nahi\s+keh\s+sakti|depend|depends|depending|dekhna\s+padega|condition)\b/i.test(
          normalized,
        ) ||
        /^(?:it\s+depends|depends|maybe|shayad|not\s+sure|unsure|pata\s+nahi)[.!?\s]*$/i.test(normalized);

      const conflicting =
        (/\b(haan|yes)\b/i.test(normalized) || /हाँ|हां/.test(followUpAnswer)) &&
        (/\b(nahi|no)\b/i.test(normalized) || /नहीं|नही/.test(followUpAnswer));

      const positive =
        !isCrossQuestion &&
        !isConveyanceConcern &&
        !isReluctantOrUnsure &&
        (/\b(haan|han|yes|yeah|yep|ready|bilkul|theek\s+hai|thik\s+hai)\b|(?<!not\s+)\bsure\b|\bwilling\b/i.test(
          normalized,
        ) ||
          locationClassification.travelWillingness === "yes" ||
          /हाँ|हां/.test(followUpAnswer) ||
          /travel kar sakti|travel kar sakta|shift ho sakti|shift ho sakta|move kar sakti|move kar sakta|can travel|can relocate|can shift|ready to travel|ready to relocate|willing to travel|willing to relocate|manage kar lungi|manage kar lunga|travel kar lungi/i.test(
            normalized,
          ));

      const negative =
        !isCrossQuestion &&
        !isConveyanceConcern &&
        !isReluctantOrUnsure &&
        (/\b(sirf\s+apne\s+area|travel\s+nahi|shift\s+nahi|move\s+nahi|door\s+nahi|nahi\s+kar\s+sakti|nahi\s+ja\s+sakti|cannot\s+travel|can't\s+travel|cannot\s+relocate|can't\s+relocate|cannot\s+shift|can't\s+shift|not\s+willing|won't\s+travel|won't\s+relocate|won't\s+shift|possible\s+nahi|nahi\s+ho\s+payega)\b/i.test(
          normalized,
        ) ||
          /^(?:nahi|nahin|nhi|no|never|नहीं|नही)[.!?।\s]*$/iu.test(normalized) ||
          /^(?:no|nahi|nahin)[,.:\s]+(?:i\s+)?(?:cannot|can't|won't|will\s+not)\s+(?:travel|relocate|shift|move)[.!?\s]*$/i.test(normalized) ||
          /नहीं.*(जा|कर|शिफ्ट|ट्रैवल|यात्रा|रिलोकेट)|नही.*(जा|कर|शिफ्ट|ट्रैवल|यात्रा|रिलोकेट)/.test(
            followUpAnswer,
          ));

      if (conflicting) {
        return askAgain(
          "Please clarify: are you willing to travel or relocate if required?",
        );
      }

      if (isCrossQuestion) {
        pending.prompt = isWhereToTravel
          ? (session.language === "English"
              ? "In Urban Company, service appointments are at customer homes within a 3-4 km cluster of your local area. Are you comfortable travelling to customer locations?"
              : "Urban Company salon-at-home service hai, isliye professionals ko apne area ke 3-4 km cluster mein clients ke ghar jaana hota hai. Kya aap customer locations par travel karne ke liye comfortable hain?")
          : (session.language === "English"
              ? "Urban Company is a salon-at-home service, so professionals travel to client homes in their local 3-4 km cluster. Can you manage travel using public transport, auto, or other means?"
              : "Urban Company salon-at-home service hai, isliye professionals ko apne area ke 3-4 km cluster mein clients ke ghar jaana hota hai. Kya aap public transport, auto ya kisi aur tareeqe se manage kar sakti hain?");
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

      const timelineFacts = extractFallbackFacts(followUpAnswer);
      if (timelineFacts && Object.keys(timelineFacts).length > 0) {
        mergeShortTermMemoryFacts(session, timelineFacts);
      }
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
            candidateAnswer: followUpAnswer,
          },
        );
      }

      session.invalidAttempts = {};

      saveFollowUp();

      const travelFacts = extractFallbackFacts(followUpAnswer);
      if (travelFacts && Object.keys(travelFacts).length > 0) {
        mergeShortTermMemoryFacts(session, travelFacts);
      }

      const effectiveTravelWillingness = travelFacts?.travelWillingness
        ? travelFacts.travelWillingness
        : (negative ? "no" : "yes");

      session.travelWillingness = effectiveTravelWillingness;
      if (travelFacts?.relocationWillingness) {
        session.relocationWillingness = travelFacts.relocationWillingness;
      }
      if (travelFacts?.relocationCondition) {
        session.relocationCondition = travelFacts.relocationCondition;
      }
      if (lastLocationAnswer) {
        lastLocationAnswer.travelWillingness = effectiveTravelWillingness;
      }

      if (lastCheck) {
        lastCheck.travelWillingness = effectiveTravelWillingness;
      }

      if (negative || (travelFacts?.travelWillingness === "yes" && travelFacts?.relocationWillingness === "no")) {
        session.pendingFollowUp = null;
        session.currentQuestionIndex += 1;

        if (session.currentQuestionIndex >= questions.length) {
          session.status = "completed";
          session.completedAt = new Date().toISOString();
          clearShortTermMemory(session);

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
      if (isExplicitContinueRequest(followUpAnswer)) {
        return askAgain(
          "Ji, kripya batayein: agar shift hona pade, to aap kab tak shift ho sakti hain?",
        );
      }

      if (isGenericAcknowledgement(followUpAnswer)) {
        return askAgain(
          "Theek hai. Agar aapko shift hona pade, toh aap kab tak shift ho sakti hain?",
        );
      }

      const isTimelineQuestion =
        cq.isCounterQuestion ||
        /\b(?:where|kahan|kidhar|why|kyun|kyu|how\s+far|kitn[aie]\s+door|compulsory|zaroori|zaruri)\b/i.test(normalized) ||
        /[?]$/.test(normalized);

      if (isTimelineQuestion) {
        const targetQ = {
          id: "A1_MOVE_TIMELINE",
          Step: "A1_MOVE_TIMELINE",
          text: pending.prompt,
          category: "Location & movement",
        };
        const reply = session.language === "English"
          ? "Urban Company appointments are at client homes in a 3-4 km cluster of your area. Relocation is only considered if there is strong customer demand in nearby clusters. If you had to shift, how soon could you do so?"
          : "Urban Company salon-at-home service mein bookings aapke area ke 3-4 km cluster mein hoti hain. Agar aage chalkar zaroorat pade, to aap kab tak shift ho sakti hain?";
        return respondWithInquiry({
          targetQuestion: targetQ,
          inquiryObj: { topic: "travel", isCounterQuestion: true },
          deterministicReply: reply,
        });
      }

      const isUnclearTimeline =
        /^(?:pata\s+nahi|pata\s+nahin|not\s+sure|don't\s+know|dont\s+know|unsure|maybe|shayad|depend|depends|dekhna\s+padega)[.!?\s]*$/i.test(
          normalized,
        ) ||
        /\b(?:depend|depends|not\s+sure|pakka\s+nahi|pata\s+nahi|shayad)\b/i.test(normalized);

      if (isUnclearTimeline && !pending.probeGiven) {
        pending.probeGiven = true;
        return askAgain(
          "Aap kab tak shift ho sakti hain? Agar abhi pakka nahi hai, toh approximate time batayein.",
        );
      }

      const isUnwillingShift =
        /\b(?:shift\s+nahi|relocate\s+nahi|move\s+nahi|nahi\s+ho\s+sakti|nahi\s+ho\s+sakta|cannot\s+shift|can't\s+shift|cannot\s+relocate|can't\s+relocate|won't\s+shift|won't\s+relocate|not\s+possible|nahi\s+ho\s+payega)\b/i.test(
          normalized,
        ) ||
        /^(?:nahi|nahin|nhi|no|never)[.!?।\s]*$/iu.test(normalized);

      if (isUnwillingShift) {
        session.invalidAttempts = {};
        session.travelWillingness = "no";
        saveFollowUp();

      const timelineFacts = extractFallbackFacts(followUpAnswer);
      if (timelineFacts && Object.keys(timelineFacts).length > 0) {
        mergeShortTermMemoryFacts(session, timelineFacts);
      }
        if (lastCheck) {
          lastCheck.moveTimelineAnswer = followUpAnswer;
          lastCheck.travelWillingness = "no";
        }
        session.pendingFollowUp = null;
        advanceToNextApplicableQuestion(session);
        return {
          status: 200,
          body: {
            success: true,
            completed: session.currentQuestionIndex >= questions.length,
            acknowledgement: getNaturalAcknowledgement(question, session),
            manualReviewRequired: true,
            followUpCaptured: true,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: questions[session.currentQuestionIndex],
          },
        };
      }

      const isValidTimeline =
        /\b(?:immediate(?:ly)?|turant|abhi|kisi\s+bhi\s+samay|anytime|jaldi|asap|as\s+soon\s+as\s+possible|ready|willing|within\s+a\s+(?:week|month|few\s+days)|next\s+(?:week|month)|agale\s+mahine|agli\s+week)\b/i.test(
          normalized,
        ) ||
        /\b\d+\s*(?:din|day|days|haft[ae]|week|weeks|mahina|mahine|month|months|saal|year|years)\b/i.test(
          normalized,
        ) ||
        /\b(?:ek|do|teen|char|paanch|chhe|one|two|three|four|five|six)\s+(?:din|haft[ae]|week|weeks|mahina|mahine|month|months)\b/i.test(
          normalized,
        ) ||
        /\b(?:notice\s+period|kuch\s+din|few\s+days|couple\s+of\s+weeks|thode\s+din|samay\s+lagega)\b/i.test(
          normalized,
        ) ||
        (isUnclearTimeline && pending.probeGiven);

      if (!isValidTimeline) {
        return handleInvalidAttempt(
          session,
          {
            id: "A1_MOVE_TIMELINE",
            text: pending.prompt,
          },
          {
            clarificationPrefix:
              "Maaf kijiye, mujhe samajh nahi aaya. Kripya batayein ki agar zaroorat pade to aap lagbhag kab tak shift ho sakti hain (jaise 1 hafta, 1 mahina, ya turant)",
            warningPrefix:
              "Aapka jawab is sawal se juda hua nahi hai. Ye aapka aakhri attempt hai. Kripya spasht timeline batayein",
            repeatQuestionText: pending.prompt,
            candidateAnswer: followUpAnswer,
          },
        );
      }

      saveFollowUp();

      const timelineFacts = extractFallbackFacts(followUpAnswer);
      if (timelineFacts && Object.keys(timelineFacts).length > 0) {
        mergeShortTermMemoryFacts(session, timelineFacts);
      }

      if (lastCheck) {
        lastCheck.moveTimelineAnswer = followUpAnswer;
      }

      session.pendingFollowUp = null;
      session.invalidAttempts = {};
      session.currentQuestionIndex += 1;

      if (session.currentQuestionIndex >= questions.length) {
        session.status = "completed";
        session.completedAt = new Date().toISOString();
        clearShortTermMemory(session);

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
      let inquiry = null;
      let interp = null;
      try {
        interp = await interpretAnswerImpl({
          question: pending.prompt,
          answer: followUpAnswer,
          questionId: `${pending.questionId}_FOLLOW_UP`,
          language: session.language,
          sessionMemory: session.shortTermMemory,
          diagnosticRequestId: safeRequestId,
          diagnosticPromptTurn: safePromptTurn,
          diagnosticSessionGeneration: safeSessionGeneration,
        });
        if (
          interp &&
          (interp.intent === "RELEVANT_COUNTER_QUESTION" ||
            interp.intent === "CLARIFICATION_REQUEST" ||
            interp.answerStatus === "counter_question")
        ) {
          inquiry = interp;
        }
      } catch {
        // Fallback
      }
      if (!inquiry) {
        const cq = detectCounterQuestion(followUpAnswer, { text: pending.prompt }, { language: session.language });
        if (cq.isCounterQuestion) {
          inquiry = { responseText: cq.reply, counterQuestionAnswer: cq.reply };
        }
      }

      if (inquiry && !pending.explainedCounterQuestion) {
        pending.explainedCounterQuestion = true;
        session.invalidAttempts = {};
        const replyText = (inquiry.counterQuestionAnswer || inquiry.responseText || inquiry.clarificationQuestion || "").trim();
        const reply = replyText.toLowerCase().includes(pending.prompt.toLowerCase().trim())
          ? replyText
          : `${replyText} ${pending.prompt}`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            counterQuestionHandled: true,
            followUpRequired: true,
            followUp: pending,
            message: reply,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: {
              id: `${pending.questionId}_FOLLOW_UP`,
              Step: `${pending.questionId}_FOLLOW_UP`,
              text: pending.prompt,
              category: pending.category || "General",
            },
          },
        };
      }
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

      if (
        (interp && (interp.intent === "CONTINUE_INTERVIEW" || interp.unifiedIntent === UNIFIED_INTENTS.CONTINUE_INTERVIEW)) ||
        isExplicitContinueRequest(followUpAnswer)
      ) {
        const isEnglish = session.language === "English";
        const reprompt = isEnglish
          ? "Sure, let's continue with our question:"
          : "Ji, chaliye sawal par aage badhte hain:";
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            followUpRequired: true,
            followUp: pending,
            message: `${reprompt} ${pending.prompt}`,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: {
              id: `${pending.questionId}_FOLLOW_UP`,
              Step: `${pending.questionId}_FOLLOW_UP`,
              text: pending.prompt,
              category: pending.category || "General",
            },
          },
        };
      }

      if (
        (interp && (interp.intent === "ACKNOWLEDGEMENT" || interp.unifiedIntent === UNIFIED_INTENTS.ACKNOWLEDGEMENT)) ||
        isGenericAcknowledgement(followUpAnswer)
      ) {
        const isEnglish = session.language === "English";
        const reprompt = isEnglish
          ? "Understood. Please share your answer to the question:"
          : "Theek hai. Kripya is sawal ka apna jawab batayein:";
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            followUpRequired: true,
            followUp: pending,
            message: `${reprompt} ${pending.prompt}`,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: {
              id: `${pending.questionId}_FOLLOW_UP`,
              Step: `${pending.questionId}_FOLLOW_UP`,
              text: pending.prompt,
              category: pending.category || "General",
            },
          },
        };
      }

      const isIrrelevantFollowUp =
        (interp &&
          (interp.intent === "IRRELEVANT_OR_NONRESPONSIVE" ||
            interp.answerStatus === "irrelevant")) ||
        /\b(?:biryani|pizza|burger|maggi|cricket|football|movie|movies|cinema|anime|song|songs|dance|gaana|habba\s+jabba|bla\s+bla|blah\s+blah|asdf|qwerty|chair|table|desk|bottle|cat|dog|billi|kutta|weather|mausam|barish|rain|politics|election|favourite|favorite|colour|color|blue|red|green|yellow|eating)\b/i.test(
          normalized,
        ) ||
        isOffTopicQuestionUtterance(followUpAnswer) ||
        /^(?:(?:namaste|namaskar|hello|hi|hey|good\s*morning|good\s*evening|good\s*afternoon)[.!?\s]*){2,}$/iu.test(
          normalized,
        ) ||
        /^(?:noise|<no speech>|<empty>|\.{2,}|uh+|um+|hmm+)$/i.test(normalized) ||
        normalized.length < 2 ||
        /(.)\1{3,}/u.test(normalized);

      if (isIrrelevantFollowUp) {
        return handleInvalidAttempt(
          session,
          {
            id: `${pending.questionId}_FOLLOW_UP`,
            text: pending.prompt,
            category: pending.category || "General",
          },
          {
            clarificationPrefix:
              "Maaf kijiye, ye jawab is sawal se juda hua nahi hai. Kripya seedha jawab dein",
            warningPrefix:
              "Aapka jawab is sawal se juda hua nahi hai. Ye aapka aakhri attempt hai. Kripya spasht jawab dein",
            repeatQuestionText: pending.prompt,
            candidateAnswer: followUpAnswer,
          },
        );
      }

      session.invalidAttempts = {};

      const isStillUnclear =
        /^(?:pata\s+nahi|pata\s+nahin|not\s+sure|don't\s+know|dont\s+know|unsure|maybe|shayad|no\s+idea|samajh\s+nahi\s+aaya|skip|aage\s+badho|pass)[.!?\s]*$/i.test(
          normalized,
        );

      const followUpRecord = {
        questionId: `${pending.questionId}_FOLLOW_UP`,
        parentQuestionId: pending.questionId,
        questionText: pending.prompt,
        category: pending.category || "General",
        originalAnswer: pending.originalAnswer,
        answer: followUpAnswer,
        answeredAt: new Date().toISOString(),
        isFollowUp: true,
      };
      session.answers.push(followUpRecord);
      recordShortTermMemoryTurn(session, followUpRecord);

      const probeFacts = extractFallbackFacts(followUpAnswer);
      if (probeFacts && Object.keys(probeFacts).length > 0) {
        mergeShortTermMemoryFacts(session, probeFacts);
      }

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
        clearShortTermMemory(session);

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
          acknowledgement: getNaturalAcknowledgement(question, session, followUpAnswer),
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
    if (/^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(cleanAnswer)) {
      session.invalidAttempts = {};
      const isEnglish = session.language === "English";
      const reprompt = isEnglish
        ? "I couldn't hear you clearly. Could you please repeat or type your answer?"
        : "Maaf kijiye, mujhe aapki aawaz theek se nahi aayi. Kripya dobara batayein ya neeche type karein.";
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message: `${reprompt} ${question.text}`,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question,
        },
      };
    }

    if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
      const isEnglish = session.language === "English" || classifyLanguage(cleanAnswer) === "English";
      return handleRequestToAskQuestion({
        session,
        targetQuestion: question,
        cleanAnswer,
        isEnglish,
      });
    }

    const cq = detectCounterQuestion(cleanAnswer, question, { language: session.language });
    const consentOutcome = classifyConsent(cleanAnswer);
    const sep = separateLanguageAndInquiry(cleanAnswer, {
      question,
      activeInquiry: session.activeInquiry,
    });

    if (consentOutcome !== "refused" && sep.hasLanguagePreference && sep.hasInquiry) {
      session.invalidAttempts = {};
      session.pendingConsentOnly = false;
      session.consentOutcome = "accepted";
      session.language = sep.detectedLanguage;
      mergeShortTermMemoryFacts(session, { preferredLanguage: sep.detectedLanguage });
      answerRecord.consentOutcome = "accepted";
      answerRecord.language = sep.detectedLanguage;
      session.answers.push(answerRecord);
      recordShortTermMemoryTurn(session, answerRecord);
      session.currentQuestionIndex += 1;
      const nextQ = questions[session.currentQuestionIndex];

      const inquiryCandidateUtterance = sep.cleanQuestion || sep.extractedQuestion || cleanAnswer;
      if (isRequestToAskQuestion(inquiryCandidateUtterance, { language: sep.detectedLanguage })) {
        return handleRequestToAskQuestion({
          session,
          targetQuestion: nextQ,
          cleanAnswer: inquiryCandidateUtterance,
          isEnglish: sep.detectedLanguage === "English",
        });
      }
      const inquiry = await checkCandidateInquiry(nextQ.text, nextQ.id, inquiryCandidateUtterance);
      const activeInquiryObj = inquiry || sep.counterQuestion || null;
      const replyText = (
        inquiry?.counterQuestionAnswer ||
        inquiry?.responseText ||
        inquiry?.clarificationQuestion ||
        sep.counterQuestion?.reply ||
        ""
      ).trim();

      return respondWithInquiry({
        targetQuestion: nextQ,
        inquiryObj: activeInquiryObj,
        deterministicReply: replyText,
        candidateUtterance: inquiryCandidateUtterance,
      });
    }

    if (cq.isCounterQuestion || consentOutcome === "unclear") {
      const inquiry = await checkCandidateInquiry(question.text, question.id);
      if (inquiry) {
        const replyText = (
          inquiry.counterQuestionAnswer ||
          inquiry.responseText ||
          inquiry.clarificationQuestion ||
          cq.reply ||
          ""
        ).trim();
        const activeInquiryObj = inquiry || cq || interpretation || null;
        return respondWithInquiry({
          targetQuestion: question,
          inquiryObj: activeInquiryObj,
          deterministicReply: replyText,
        });
      }

      if (consentOutcome === "unclear") {
        return handleInvalidAttempt(session, question, {
          clarificationPrefix:
            "Maaf kijiye, mujhe samajh nahi aaya. Kripya batayein ki kya aap screening conversation ke liye agree karti hain",
          warningPrefix:
            "Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya spasht batayein",
          repeatQuestionText: question.text,
          candidateAnswer: cleanAnswer,
        });
      }
    }

    const outcome = consentOutcome;

    session.invalidAttempts = {};

    answerRecord.consentOutcome = outcome;
    session.answers.push(answerRecord);
    recordShortTermMemoryTurn(session, answerRecord);

    if (outcome === "refused") {
      session.consentOutcome = "refused";
      session.status = "manual_review";
      session.completedAt = new Date().toISOString();
      clearShortTermMemory(session);

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

    const detectedLanguage = classifyLanguage(cleanAnswer) || (session.pendingConsentOnly ? null : session.language);
    if (session.pendingConsentOnly && !detectedLanguage) {
      session.pendingConsentOnly = false;
      session.consentOutcome = "accepted";
      const isEnglish = session.language === "English" || Boolean(session.lastInquiryEnglish);
      const languagePrompt = isEnglish
        ? "Would you like to speak in Hindi or English?"
        : "Aap Hindi mein baat karengi ya English mein?";
      session.pendingFollowUp = {
        questionId: "A0",
        type: "language_preference",
        prompt: languagePrompt,
        category: "Setup",
      };

      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          followUpRequired: true,
          followUp: session.pendingFollowUp,
          consentOutcome: "accepted",
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          message: languagePrompt,
          question: {
            id: "A0_LANGUAGE_PREFERENCE",
            Step: "A0_LANGUAGE_PREFERENCE",
            text: languagePrompt,
            category: "Setup",
          },
        },
      };
    }

    session.pendingConsentOnly = false;
    const finalLanguage = detectedLanguage || "Hindi";
    session.consentOutcome = "accepted";
    session.language = finalLanguage;
    mergeShortTermMemoryFacts(session, { preferredLanguage: finalLanguage });
    answerRecord.language = finalLanguage;
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
    if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
      const isEnglish = session.language === "English" || classifyLanguage(cleanAnswer) === "English";
      return handleRequestToAskQuestion({
        session,
        targetQuestion: question,
        cleanAnswer,
        isEnglish,
      });
    }

    const cq = detectCounterQuestion(cleanAnswer, question, { language: session.language });
    const isCandidateQuestion =
      cq.isCounterQuestion ||
      /[?]|(?:kyun|kyu|why|kaise|kya\s+karun|kya\s+hoga|kya\s+aap|kya\s+mujhe|batao|explain|agar\s+mujhe|unsafe|safety|dikkat|problem)/i.test(
        cleanAnswer,
      );
    const result = classifyLocation(cleanAnswer);

    if (isCandidateQuestion || result.outcome === "clarification" || !result.area) {
      const inquiry = await checkCandidateInquiry(question.text, question.id);
      if (inquiry || cq.isCounterQuestion) {
        const locFacts = extractFallbackFacts(cleanAnswer);
        if (locFacts && Object.keys(locFacts).length > 0) {
          mergeShortTermMemoryFacts(session, locFacts);
          if (locFacts.currentCity) {
            session.candidateCity = locFacts.currentCity;
          }
        }
        const replyText = (
          inquiry?.counterQuestionAnswer ||
          inquiry?.responseText ||
          inquiry?.clarificationQuestion ||
          cq.reply ||
          ""
        ).trim();
        const activeInquiryObj = inquiry || cq || interpretation || null;
        return respondWithInquiry({
          targetQuestion: question,
          inquiryObj: activeInquiryObj,
          deterministicReply: replyText,
        });
      }

      if (result.outcome === "clarification" || !result.area) {
        const isEnglish = session.language === "English";
        const isOffTopic = isOffTopicQuestionUtterance(cleanAnswer);
        const currentAttempts =
          ((session.invalidAttempts && session.invalidAttempts["A1"]) || 0) + 1;

        let clarMsg;
        if (currentAttempts === 1) {
          if (isOffTopic) {
            clarMsg = isEnglish
              ? "I cannot answer questions unrelated to the interview. Let's focus on the screening. Please tell us your city or local area name."
              : "Maaf kijiye, main interview se alag sawalon ke jawab nahi de sakti. Chaliye screening par dhyan dete hain. Kripya apne sheher ya area ka naam batayein.";
          } else {
            clarMsg = isEnglish
              ? "We need to know your city and local area for screening. Please tell us the name of your city or local area."
              : "Maaf kijiye, screening ke liye humein aapka ilaka jaanna zaroori hai. Kripya apne sheher ya area ka naam batayein.";
          }
        } else {
          if (isOffTopic) {
            clarMsg = isEnglish
              ? "Your previous responses were not related to the interview. This is your final attempt. Please clearly state your city and local area name."
              : "Aapke pehle ke jawab interview se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya apne sheher aur local area ka naam spasht batayein.";
          } else {
            clarMsg = isEnglish
              ? "Your previous answers were not related to this question. This is your final attempt. Please clearly state your city and local area name."
              : "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya apne sheher aur local area ka naam spasht batayein.";
          }
        }

        return handleInvalidAttempt(session, question, {
          clarificationPrefix: clarMsg,
          warningPrefix: clarMsg,
          firstAttemptMessage: clarMsg,
          secondAttemptMessage: clarMsg,
          repeatQuestionText: clarMsg,
          candidateAnswer: cleanAnswer,
        });
      }
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

    if (result.area) {
      mergeShortTermMemoryFacts(session, { localArea: result.area });
    }
    const locFacts = extractFallbackFacts(cleanAnswer);
    if (locFacts && Object.keys(locFacts).length > 0) {
      mergeShortTermMemoryFacts(session, locFacts);
    }

    session.answers.push(answerRecord);
    recordShortTermMemoryTurn(session, answerRecord);
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
    if (/^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(cleanAnswer)) {
      session.invalidAttempts = {};
      const isEnglish = session.language === "English";
      const reprompt = isEnglish
        ? "I couldn't hear you clearly. Could you please repeat or type your answer?"
        : "Maaf kijiye, mujhe aapki aawaz theek se nahi aayi. Kripya dobara batayein ya neeche type karein.";
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message: `${reprompt} ${question.text}`,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question,
        },
      };
    }

    if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
      const isEnglish = session.language === "English" || classifyLanguage(cleanAnswer) === "English";
      return handleRequestToAskQuestion({
        session,
        targetQuestion: question,
        cleanAnswer,
        isEnglish,
      });
    }

    const cq = detectCounterQuestion(cleanAnswer, question, { language: session.language });
    const result = evaluateAge(cleanAnswer);

    if (cq.isCounterQuestion || result.outcome === "clarification") {
      const inquiry = await checkCandidateInquiry(question.text, question.id);
      if (inquiry) {
        const replyText = (
          inquiry.counterQuestionAnswer ||
          inquiry.responseText ||
          inquiry.clarificationQuestion ||
          cq.reply ||
          ""
        ).trim();
        const activeInquiryObj = inquiry || cq || interpretation || null;
        return respondWithInquiry({
          targetQuestion: question,
          inquiryObj: activeInquiryObj,
          deterministicReply: replyText,
        });
      }

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
            "Maaf kijiye, screening ke liye humein aapki umar jaanna zaroori hai. Kripya apni umar saal mein batayein",
          warningPrefix:
            "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya apni exact umar saal mein batayein (jaise 25 saal)",
          repeatQuestionText: question.text,
          candidateAnswer: cleanAnswer,
        });
      }
    }

    session.invalidAttempts = {};

    answerRecord.age = result.age;
    answerRecord.eligibilityOutcome = result.outcome;
    if (result.age) {
      mergeShortTermMemoryFacts(session, { age: result.age });
    }
    if (result.dob) {
      mergeShortTermMemoryFacts(session, { dob: result.dob });
    }
    session.answers.push(answerRecord);
    recordShortTermMemoryTurn(session, answerRecord);

    session.eligibilityOutcome = result.outcome;

    if (result.outcome === "reject") {
      session.status = "rejected";
      session.completedAt = new Date().toISOString();
      clearShortTermMemory(session);

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
    if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
      const isEnglish = session.language === "English" || classifyLanguage(cleanAnswer) === "English";
      return handleRequestToAskQuestion({
        session,
        targetQuestion: question,
        cleanAnswer,
        isEnglish,
      });
    }

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
    console.info("[UC Interview Diagnostics] name_extraction", {
      requestId: safeRequestId,
      sessionKey,
      extractedName: nameClassification.name || null,
      nameIsClear,
      format: nameClassification.format,
      hasProfile: Boolean(session.profileName),
      matchesProfile: session.profileName ? isNameMatch(formatCandidateName(nameClassification.name || cleanAnswer), session.profileName) : null,
    });

    if (!nameIsClear) {
      const inquiry = await checkCandidateInquiry(question.text, question.id);
      if (inquiry) {
        const replyText = (
          inquiry.counterQuestionAnswer ||
          inquiry.responseText ||
          inquiry.clarificationQuestion ||
          ""
        ).trim();
        const activeInquiryObj = inquiry || interpretation || null;
        return respondWithInquiry({
          targetQuestion: question,
          inquiryObj: activeInquiryObj,
          deterministicReply: replyText,
        });
      }

      if (session.profileName) {
        const isEnglish = session.language === "English";
        session.invalidAttempts = {};
        session.candidateName = session.profileName;
        session.pendingNameConfirmation = {
          name: session.profileName,
          fromProfile: true,
          rawAnswer: cleanAnswer,
        };
        const confirmPrompt = isEnglish
          ? `Your profile name is ${session.profileName}. Is this correct?`
          : `Aapke profile mein naam ${session.profileName} hai. Kya ye sahi hai?`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            nameConfirmationRequired: true,
            candidateName: session.profileName,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: {
              id: "A2_NAME_CONFIRM",
              Step: "A2_NAME_CONFIRM",
              text: confirmPrompt,
              category: "Introduction",
            },
            message: confirmPrompt,
          },
        };
      }

      return handleInvalidAttempt(session, question, {
        clarificationPrefix:
          "Maaf kijiye, mujhe aapka naam samajh nahi aaya. Kripya apna naam seedhe batayein",
        warningPrefix:
          "Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya apna naam spasht batayein",
        repeatQuestionText: question.text,
        candidateAnswer: cleanAnswer,
      });
    }

    session.invalidAttempts = {};

    const formattedName = formatCandidateName(nameClassification.name || cleanAnswer);
    const profileName = session.profileName;
    const matchesProfile = Boolean(profileName && isNameMatch(formattedName, profileName));
    const normSpoken = normalizeNameForComparison(formattedName);
    const normProfile = normalizeNameForComparison(profileName);
    const spokenTokens = extractCleanTokens(formattedName);
    const profileTokens = extractCleanTokens(profileName);
    const mismatchAttemptsBefore = session.identityMismatchAttempts || 0;

    console.info("[UC Interview Diagnostics] identity_verification_trace", {
      candidateId: session.candidateId || null,
      sessionProfileName: profileName || null,
      nameReceivedFromGeminiLive: cleanAnswer,
      nameExtractedByClassify: nameClassification.name || null,
      normalizedRegisteredName: normProfile,
      normalizedSpokenName: normSpoken,
      spokenTokens,
      profileTokens,
      isNameMatchResult: matchesProfile,
      identityMismatchAttemptsBefore: mismatchAttemptsBefore,
      identityMismatchAttemptsAfter: (profileName && !matchesProfile) ? mismatchAttemptsBefore + 1 : 0,
      branch: !profileName
        ? "no_profile_proceed"
        : matchesProfile
          ? "name_match_proceed"
          : mismatchAttemptsBefore + 1 === 1
            ? "identity_mismatch_warning_1"
            : "identity_mismatch_manual_review_2",
    });

    // Two-stage identity verification when a registered profile name exists:
    // Attempt 1 mismatch: exactly ONE polite warning asking candidate to state their registered name.
    // Attempt 2+ mismatch: route to manual review and block progression.
    if (profileName && !matchesProfile) {
      session.identityMismatchAttempts = (session.identityMismatchAttempts || 0) + 1;
      session.candidateName = profileName; // Preserve the authoritative identity

      if (session.identityMismatchAttempts === 1) {
        const isEnglish = session.language === "English";
        session.warningLevel = 1;
        const warningMsg = isEnglish
          ? `This interview is registered for ${profileName}. The name provided did not match. Please state your registered name clearly.`
          : `Ye interview ${profileName} ke naam par registered hai. Kripya apna registered naam dobara spasht batayein.`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            identityMismatchWarning: true,
            warningLevel: 1,
            candidateName: profileName,
            message: warningMsg,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question: {
              id: "A2_NAME",
              Step: "A2_NAME",
              text: warningMsg,
              category: "Introduction",
            },
          },
        };
      }

      const isEnglish = session.language === "English";
      session.status = "manual_review";
      session.identityVerificationFailed = true;
      session.manualReviewRequired = true;
      session.manualReviewReason =
        "Identity mismatch: candidate spoke a name that does not match the registered profile after warning.";
      session.candidateName = profileName; // Preserve the authoritative identity
      clearShortTermMemory(session);
      const mismatchMessage = isEnglish
        ? `This interview is associated with ${profileName}'s registered profile. The name you provided does not match. This session has been flagged for manual review.`
        : `Ye interview ${profileName} ke registered profile se juda hai. Aapne jo naam bataya woh match nahi karta. Is session ko manual review ke liye flag kar diya gaya hai.`;
      return {
        status: 200,
        body: {
          success: true,
          completed: true,
          identityVerificationFailed: true,
          manualReviewRequired: true,
          sessionStatus: "manual_review",
          candidateName: profileName,
          message: mismatchMessage,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: {
            id: "A2_NAME_MISMATCH",
            Step: "A2_NAME_MISMATCH",
            text: mismatchMessage,
            category: "Introduction",
          },
        },
      };
    }

    session.identityMismatchAttempts = 0;
    const confirmedCandidateName = matchesProfile ? profileName : formattedName;

    session.candidateName = confirmedCandidateName;
    session.pendingNameConfirmation = {
      name: confirmedCandidateName,
      rawAnswer: cleanAnswer,
      matchedProfile: Boolean(matchesProfile),
      fromProfile: false,
    };

    const isEnglish = session.language === "English";
    const confirmPrompt = isEnglish
      ? `Your name is ${confirmedCandidateName}, right?`
      : `Aapka naam ${confirmedCandidateName} hai, sahi hai na?`;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        nameConfirmationRequired: true,
        candidateName: confirmedCandidateName,
        acknowledgement: getNaturalAcknowledgement(question, session),
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: {
          id: "A2_NAME_CONFIRM",
          Step: "A2_NAME_CONFIRM",
          text: confirmPrompt,
          category: "Introduction",
        },
        message: confirmPrompt,
      },
    };
  }

  // A9: Travel block - handle travel mode, reluctance, cross-questions, and husband dependence
  if (question.id === "A9") {
    if (/^(?:\.{2,}|(?:uh+|um+|hmm+)\.*|noise|<no speech>|<empty>)$/i.test(cleanAnswer)) {
      session.invalidAttempts = {};
      const isEnglish = session.language === "English";
      const reprompt = isEnglish
        ? "I couldn't hear you clearly. Could you please repeat or type your answer?"
        : "Maaf kijiye, mujhe aapki aawaz theek se nahi aayi. Kripya dobara batayein ya neeche type karein.";
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message: `${reprompt} ${question.text}`,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question,
        },
      };
    }

    const cq = detectCounterQuestion(cleanAnswer, question, { language: session.language });
    const isQuestionUtterance =
      cq.isCounterQuestion ||
      /[?]|(?:kyun|kyu|why|kitna|kitni|kaise|kya\s+hoga|kya\s+aap|kya\s+mujhe|batao|explain|agar\s+mujhe)/i.test(
        cleanAnswer,
      );

    if (isQuestionUtterance) {
      const inquiry = await checkCandidateInquiry(question.text, question.id);
      if (inquiry) {
        const replyText = (
          inquiry.counterQuestionAnswer ||
          inquiry.responseText ||
          inquiry.clarificationQuestion ||
          cq.reply ||
          ""
        ).trim();
        const activeInquiryObj = inquiry || cq || interpretation || null;
        return respondWithInquiry({
          targetQuestion: question,
          inquiryObj: activeInquiryObj,
          deterministicReply: replyText,
        });
      }
    }

    const isCrossQuestion =
      /\b(?:kyun\s+jana|door\s+kyun|kyun\s+travel|zaruri\s+kyun|kyun\s+zaruri|travel\s+kyun)\b/i.test(
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
      /\b(?:biryani|pizza|burger|cricket|football|movie|movies|cinema|anime|chair|table|laptop|pen|bottle|cat|dog|billi|kutta|weather|mausam|barish|rain|song|songs|dance|gaana|habba\s+jabba|bla\s+bla|asdf|qwerty)\b/i.test(
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
          "Maaf kijiye, screening ke liye humein jaanna zaroori hai ki kya aap customer ke ghar travel kar sakti hain. Kripya batayein ki kya aap 3-4 km cluster mein travel karne ke liye taiyaar hain",
        warningPrefix:
          "Aapke pehle ke jawab travel ke sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya spasht batayein ki kya aap travel kar sakti hain",
        repeatQuestionText: question.text,
        candidateAnswer: cleanAnswer,
      });
    }

    const isAffirmativeTravel =
      /^(?:(?:ji\s+)?(?:haan|han|haanji|hanji|yes|yeah|yep|ha|sure|ok|okay)(?:\s+(?:ji|madam|sir))?|ji|bilkul|theek\s+hai|thik\s+hai|ho\s+jayega|kar\s+lungi|kar\s+lunga|ja\s+sakti\s+hoon|ja\s+sakta\s+hoon|kar\s+sakti\s+hoon|kar\s+sakta\s+hoon|manage\s+kar\s+lungi|manage\s+kar\s+lunga|problem\s+nahi\s+hai|koi\s+dikkat\s+nahi\s+hai|koi\s+issue\s+nahi\s+hai|हाँ|हां|जी|जी\s+हाँ|बिल्कुल|हो\s+जाएगा)[.!?।\s]*$/iu.test(
        cleanAnswer,
      ) ||
      /\b(?:travel\s+kar\s+sakti|travel\s+kar\s+sakta|ja\s+sakti|ja\s+sakta|kar\s+sakti|kar\s+sakta|kar\s+lungi|kar\s+lunga|manage\s+kar|willing|ready|comfortable|chalega|chalegi|bike|scooty|scooter|bus|auto|metro|public\s+transport|apni\s+gaadi|two\s*wheeler|koi\s+dikkat\s+nahi|koi\s+problem\s+nahi|no\s+problem|can\s+travel|will\s+travel)\b/i.test(
        cleanAnswer,
      );

    const isNegativeTravel =
      unwillingTravel ||
      /^(?:no|nope|nahi|nahin|nhi|never|not\s+possible|nahi\s+ho\s+payega|nahi\s+kar\s+sakti|nahi\s+kar\s+sakta|nahi\s+ja\s+sakti|nahi\s+ja\s+sakta|नहीं|नही)[.!?।\s]*$/iu.test(
        cleanAnswer,
      );

    if (isNegativeTravel) {
      session.invalidAttempts = {};
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
      recordShortTermMemoryTurn(session, answerRecord);
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

    if (isAffirmativeTravel) {
      session.invalidAttempts = {};
      answerRecord.travelWillingness = "yes";
      session.answers.push(answerRecord);
      recordShortTermMemoryTurn(session, answerRecord);
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

    return handleInvalidAttempt(session, question, {
      clarificationPrefix:
        "Maaf kijiye, screening ke liye humein jaanna zaroori hai ki kya aap customer ke ghar travel kar sakti hain. Kripya batayein ki kya aap 3-4 km cluster mein travel kar sakti hain",
      warningPrefix:
        "Aapke pehle ke jawab is sawal se jude hue nahi the. Ye aapka aakhri attempt hai. Kripya spasht batayein ki kya aap travel kar sakti hain",
      repeatQuestionText: question.text,
      candidateAnswer: cleanAnswer,
    });
  }

  // Gemini interpretation for normal questions only.
  const isSpecialQuestion = ["A0", "A1", "A2", "A2_NAME", "A9"].includes(
    question.id,
  );

  interpretation = null;
  if (!isSpecialQuestion) {
    const cq = detectCounterQuestion(cleanAnswer, question, { language: session.language });
    const isExplicitCandidateQuestion =
      cq.isCounterQuestion ||
      /[?]|(?:^|\b)(?:where|kahan|kidhar|why|kyun|kyu|how\s+far|kitn[aie]\s+door|kitna\s+distance|kaise|what\s+if|agar\s+mujhe|compulsory|zaroori\s+hai|zaruri\s+hai|batao|explain)\b/i.test(
        cleanAnswer,
      );

    if (isExplicitCandidateQuestion) {
      const inquiry = await checkCandidateInquiry(question.text, question.id);
      if (inquiry || cq.isCounterQuestion) {
        const replyText = (
          inquiry?.counterQuestionAnswer ||
          inquiry?.responseText ||
          inquiry?.clarificationQuestion ||
          cq.reply ||
          ""
        ).trim();
        const activeInquiryObj = inquiry || cq || null;
        return respondWithInquiry({
          targetQuestion: question,
          inquiryObj: activeInquiryObj,
          deterministicReply: replyText,
        });
      }
    }

    if (isRequestToAskQuestion(cleanAnswer, { language: session.language })) {
      const isEnglish = session.language === "English" || classifyLanguage(cleanAnswer) === "English";
      return handleRequestToAskQuestion({
        session,
        targetQuestion: question,
        cleanAnswer,
        isEnglish,
      });
    }

    const isIrrelevantUtterance =
      /\b(?:biryani|pizza|burger|maggi|cricket|football|movie|movies|cinema|anime|song|songs|dance|gaana|habba\s+jabba|bla\s+bla|blah\s+blah|asdf|qwerty|cat|dog|billi|kutta|weather|mausam|barish|rain|favourite\s+colou?r|favorite\s+colou?r)\b/i.test(
        cleanAnswer,
      ) ||
      isOffTopicQuestionUtterance(cleanAnswer) ||
      /^(?:(?:namaste|namaskar|hello|hi|hey|good\s*morning|good\s*evening|good\s*afternoon)[.!?\s]*){2,}$/iu.test(
        cleanAnswer,
      );

    if (isIrrelevantUtterance) {
      return handleInvalidAttempt(session, question, {
        clarificationPrefix:
          "Maaf kijiye, ye jawab is sawal se juda hua nahi hai. Kripya seedha jawab dein",
        warningPrefix:
          "Aapka jawab is sawal se juda hua nahi hai. Ye aapka aakhri attempt hai. Kripya spasht jawab dein",
        repeatQuestionText: question.text,
        candidateAnswer: cleanAnswer,
      });
    }

    const isAmbiguousOrUncertain =
      /^(?:it\s+depends|depends|maybe|shayad|not\s+sure|unsure|pata\s+nahi|pata\s+nahin|don't\s+know|dont\s+know|no\s+idea|samajh\s+nahi\s+aaya|dekhna\s+padega)[.!?\s]*$/i.test(
        cleanAnswer,
      );

    const alreadyProbedThisQuestion = Boolean(session.followUpsGiven?.[question.id]);
    if (isAmbiguousOrUncertain && !alreadyProbedThisQuestion) {
      session.followUpsGiven = session.followUpsGiven || {};
      session.followUpsGiven[question.id] = true;
      session.invalidAttempts = {};
      const bankQ = questions[session.currentQuestionIndex];
      const probeText =
        bankQ && bankQ["Follow-up probe"] && bankQ["Follow-up probe"] !== "—"
          ? bankQ["Follow-up probe"]
          : (session.language === "English"
              ? "Could you please elaborate on that in a little more detail?"
              : "Aap is baare mein thoda aur spasht batayein.");
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

    const interpretationQuestionIndex = session.currentQuestionIndex;
    try {
      interpretation = await interpretAnswerImpl({
        question: question.text,
        answer: cleanAnswer,
        questionId: question.id,
        language: session.language,
        sessionMemory: session.shortTermMemory,
        previousContext: (session.answers || []).slice(-3),
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

      if (
        interpretation?.extractedFacts &&
        typeof interpretation.extractedFacts === "object" &&
        interpretation.intent !== "IRRELEVANT_OR_NONRESPONSIVE" &&
        interpretation.intent !== "UNINTELLIGIBLE_OR_NO_INPUT"
      ) {
        mergeShortTermMemoryFacts(session, interpretation.extractedFacts);
      }

      const unifiedIntent =
        interpretation.unifiedIntent ||
        normalizeIntent(interpretation.intent, interpretation.answerStatus);

      if (
        unifiedIntent === UNIFIED_INTENTS.REQUEST_TO_ASK_QUESTION ||
        interpretation.intent === "REQUEST_TO_ASK_QUESTION" ||
        interpretation.answerStatus === "request_to_ask_question" ||
        isRequestToAskQuestion(cleanAnswer, { language: session.language })
      ) {
        const isEnglish = session.language === "English";
        return handleRequestToAskQuestion({
          session,
          targetQuestion: question,
          cleanAnswer,
          isEnglish,
        });
      }

      if (
        unifiedIntent === UNIFIED_INTENTS.CANDIDATE_QUESTION ||
        unifiedIntent === UNIFIED_INTENTS.CLARIFICATION_REQUEST ||
        interpretation.intent === "RELEVANT_COUNTER_QUESTION" ||
        interpretation.intent === "CLARIFICATION_REQUEST" ||
        interpretation.intent === "QUESTION_RATIONALE_INQUIRY" ||
        interpretation.intent === "CANDIDATE_CONSTRAINT_OR_HESITATION" ||
        interpretation.intent === "CANDIDATE_QUESTION" ||
        interpretation.answerStatus === "counter_question"
      ) {
        const isEnglish = session.language === "English";
        const reply =
          interpretation.counterQuestionAnswer ||
          interpretation.responseText ||
          interpretation.clarificationQuestion ||
          (isEnglish
            ? "Urban Company is a salon-at-home service where bookings are arranged at customer homes in nearby local areas."
            : "Urban Company salon-at-home service hai jahan kaam aapke paas ke local area mein customer ke ghar par hota hai.");
        const replyText = reply.trim();
        const activeInquiryObj = interpretation || null;
        return respondWithInquiry({
          targetQuestion: question,
          inquiryObj: activeInquiryObj,
          deterministicReply: replyText,
        });
      }

      if (
        unifiedIntent === UNIFIED_INTENTS.CONTINUE_INTERVIEW ||
        interpretation.intent === "CONTINUE_INTERVIEW" ||
        isExplicitContinueRequest(cleanAnswer)
      ) {
        session.invalidAttempts = {};
        const isEnglish = session.language === "English";
        const reprompt =
          interpretation.responseText ||
          (isEnglish
            ? "Sure, let's continue with our question:"
            : "Ji, chaliye sawal par aage badhte hain:");
        const combinedMessage = `${reprompt} ${question.text}`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            message: combinedMessage,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question,
          },
        };
      }

      if (
        unifiedIntent === UNIFIED_INTENTS.ACKNOWLEDGEMENT ||
        interpretation.intent === "ACKNOWLEDGEMENT" ||
        isGenericAcknowledgement(cleanAnswer)
      ) {
        session.invalidAttempts = {};
        const isEnglish = session.language === "English";
        const reprompt =
          interpretation.responseText ||
          (isEnglish
            ? "Understood. Please share your answer to the question:"
            : "Theek hai. Kripya is sawal ka apna jawab batayein:");
        const combinedMessage = `${reprompt} ${question.text}`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            message: combinedMessage,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question,
          },
        };
      }

      if (
        unifiedIntent === UNIFIED_INTENTS.UNINTELLIGIBLE_OR_NO_INPUT ||
        interpretation.intent === "UNINTELLIGIBLE_OR_NO_INPUT"
      ) {
        session.invalidAttempts = {};
        const isEnglish = session.language === "English";
        const reprompt =
          interpretation.responseText ||
          (isEnglish
            ? "I couldn't hear you clearly. Could you please repeat your answer or type it below?"
            : "Maaf kijiye, mujhe aapki aawaz theek se nahi aayi. Kripya dobara batayein ya neeche type karein.");
        const combinedMessage = `${reprompt} ${question.text}`;
        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            message: combinedMessage,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question,
          },
        };
      }

      if (
        unifiedIntent === UNIFIED_INTENTS.AMBIGUOUS_RESPONSE ||
        interpretation.intent === "PARTIAL_OR_AMBIGUOUS_ANSWER" ||
        interpretation.intent === "AMBIGUOUS_RESPONSE" ||
        interpretation.needsClarification
      ) {
        const isUncertainOrSkipped =
          /^(?:not\s+sure|unsure|pata\s+nahi|pata\s+nahin|don't\s+know|dont\s+know|maybe|shayad|no\s+idea|samajh\s+nahi\s+aaya|skip|aage\s+badho|pass)[.!?।\s]*$/i.test(
            cleanAnswer,
          ) ||
          /uncertain|hesitan|unsure|skip/i.test(interpretation.understanding);

        const isPartial =
          interpretation.intent === "PARTIAL_OR_AMBIGUOUS_ANSWER" ||
          interpretation.answerStatus === "partial" ||
          interpretation.answerStatus === "unclear";
        const isGenuinelyIrrelevant =
          interpretation.intent === "IRRELEVANT_OR_NONRESPONSIVE" ||
          interpretation.answerStatus === "irrelevant";
        const alreadyProbed = Boolean(session.followUpsGiven?.[question.id]);
        const isEnglish = session.language === "English";

        const bankQ = questions[session.currentQuestionIndex];
        const probe =
          bankQ && bankQ["Follow-up probe"] && bankQ["Follow-up probe"] !== "—"
            ? bankQ["Follow-up probe"]
            : null;

        session.followUpsGiven = session.followUpsGiven || {};
        if ((isPartial || isUncertainOrSkipped) && !alreadyProbed && !isGenuinelyIrrelevant) {
          session.followUpsGiven[question.id] = true;
          session.invalidAttempts = {};
          const probeText =
            interpretation.clarificationQuestion ||
            interpretation.responseText ||
            probe ||
            (isEnglish
              ? "Could you please elaborate on that in a little more detail?"
              : "Aap is baare mein thoda aur spasht batayein.");
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
              acknowledgement: interpretation.naturalAcknowledgement || (isEnglish ? "That makes sense." : "Theek hai."),
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

        if (alreadyProbed && !isGenuinelyIrrelevant) {
          session.invalidAttempts = {};
          session.pendingFollowUp = null;
          advanceToNextApplicableQuestion(session);

          return {
            status: 200,
            body: {
              success: true,
              completed: session.status === "completed",
              acknowledgement: getNaturalAcknowledgement(question, session, cleanAnswer),
              questionNumber: session.currentQuestionIndex + 1,
              totalQuestions: questions.length,
              question: questions[session.currentQuestionIndex] || null,
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
          candidateAnswer: cleanAnswer,
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
      const rateLimited = error?.code === "AI_RATE_LIMIT" || error?.name === "RateLimitError" || error?.status === 429 || error?.statusCode === 429 || isQuotaExhaustedError(error);
      if (rateLimited) {
        console.warn("[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED", {
          sessionKey,
          questionId: question.id,
          errorName: error?.name || "Error",
        });
      }
      session.pendingInterpretation = pendingInterpretation || {
        questionId: question.id,
        answerRecord,
        retryAnswers: [],
      };
      session.pendingInterpretation.failureCode = rateLimited
        ? "AI_RATE_LIMIT"
        : "AI_INTERPRETATION_UNAVAILABLE";
      session.pendingInterpretation.failedAt = new Date().toISOString();
      const isEnglish = session.language === "English";
      const quotaMessage = isEnglish
        ? "I'm sorry, I am currently facing a technical issue with answering. Your interview question is safe. We can try again in a little while."
        : "Maaf kijiye, abhi mujhe jawab dene mein technical dikkat aa rahi hai. Aapka interview question safe hai. Hum thodi der baad dobara koshish kar sakte hain.";
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          quotaExhausted: rateLimited,
          interpretationUnavailable: true,
          code: session.pendingInterpretation.failureCode,
          message: rateLimited
            ? quotaMessage
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
    if (childPresence === "none") {
      mergeShortTermMemoryFacts(session, { hasChildren: false });
    } else if (childPresence === "present") {
      mergeShortTermMemoryFacts(session, { hasChildren: true });
    }
  }

  // Sequential flow for questions other than A0.
  session.answers.push(answerRecord);
  advanceToNextApplicableQuestion(session);

  if (session.currentQuestionIndex >= questions.length) {
    session.status = "completed";
    session.completedAt = new Date().toISOString();
    clearShortTermMemory(session);

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

  const naturalAck =
    interpretation?.naturalAcknowledgement ||
    answerRecord?.interpretation?.naturalAcknowledgement ||
    getNaturalAcknowledgement(question, session, cleanAnswer);

  return {
    status: 200,
    body: {
      success: true,
      completed: false,
      acknowledgement: naturalAck,
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

  clearShortTermMemory(session);

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
  let active = null;
  for (const session of sessions.values()) {
    if (session.candidateId === candidateId && (session.status === "in_progress" || session.status === "paused")) {
      active = session;
    }
  }
  if (!active) return null;
  return {
    sessionId: active.sessionId,
    status: active.status,
    questionNumber: active.currentQuestionIndex + 1,
    totalQuestions: questions.length,
    question: getCurrentQuestionForSession(active),
    candidateName: active.candidateName || null,
    answersCount: active.answers?.length || 0,
  };
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
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      status: 404,
      body: { success: false, message: "Interview report not found." },
    };
  }
  clearShortTermMemory(session);
  sessions.delete(sessionId);
  return {
    status: 200,
    body: { success: true, message: "Interview report deleted successfully." },
  };
}

function updateCandidateName(sessionId, candidateName) {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, message: "Interview session not found." };
  const classification = classifyNameAnswer(candidateName);
  if (!classification.clear) {
    return { success: false, message: "Please provide a valid name." };
  }
  const formatted = formatCandidateName(classification.name || candidateName);
  session.candidateName = formatted;
  mergeShortTermMemoryFacts(session, { candidateName: formatted });
  if (session.pendingNameConfirmation) {
    session.pendingNameConfirmation.name = formatted;
  }
  const nameRecord = (session.answers || []).find((a) => a.questionId === "A2_NAME");
  if (nameRecord) {
    nameRecord.answer = formatted;
  }
  return { success: true, candidateName: formatted };
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
  updateCandidateName,
  createShortTermMemory,
  mergeShortTermMemoryFacts,
  recordShortTermMemoryTurn,
  clearShortTermMemory,
  createActiveInquiry,
  startActiveInquiry,
  clearActiveInquiry,
  getActiveInquiry,
  isSessionExpired,
  cleanupExpiredSessions,
  INTERVIEW_SESSION_TTL_MS,
  MAX_ADAPTIVE_INQUIRY_TURNS,
};
