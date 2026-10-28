const crypto = require("crypto");
const path = require("path");

const { classifyConsent } = require("./rules/consentRules");
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
  "kuch", "bhi", "koi",
]);

function isSaneName(name) {
  if (!name || typeof name !== "string") return false;
  const cleaned = name.trim().toLowerCase();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  if (tokens.every((t) => KNOWN_NONSENSE_TOKENS.has(t))) return false;
  if (/\b(?:habba\s+jabba|jabba\s+habba|bla\s+bla|blah\s+blah)\b/iu.test(cleaned)) return false;
  for (const t of tokens) {
    if (/^[a-z]{3,}$/i.test(t) && !/[aeiouy]/i.test(t)) return false;
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

  const uncertainty =
    /^(?:(?:(?:mera naam|मेरा नाम|my name is)\s+)?(?:pata nahi|nahi pata|yaad nahi|nahi yaad|nahi maloom|kya hai|i don't know|i do not know|not sure|don't know|no idea|samajh nahi aaya)|hmm+|umm+|uh+|haan|han|yes|okay|ok|नाम नहीं पता|पता नहीं|याद नहीं|समझ नहीं आया)$/iu;
  if (uncertainty.test(normalized)) {
    return { clear: false, format: "uncertainty" };
  }

  // Devanagari vowel signs are Unicode marks, not letters. Include marks
  // after the first letter so Hindi names remain valid when transcribed in
  // Devanagari rather than Romanized Hindi.
  const nameToken = String.raw`[\p{L}][\p{L}\p{M}'’.-]*`;
  const nameSequence = String.raw`${nameToken}(?:\s+${nameToken}){0,3}`;
  const namePhrase = new RegExp(
    String.raw`^(?:mera naam|मेरा नाम|my name is|i am|i'm)\s+(${nameSequence})(?:\s+(?:hai|है))?$`,
    "iu",
  );
  const plainName = new RegExp(`^${nameSequence}$`, "u");
  const sentenceStarter = /^(?:i|we|my|mera|meri|mujhe|main|मैं|मेरा|मेरी)\s/iu;

  // Extract the candidate name from the supported introduction before
  // validating its token shape. Keep the full input anchored to avoid
  // accepting unrelated trailing sentences as a name.
  const introducedName = namePhrase.exec(normalized)?.[1];
  if (introducedName && plainName.test(introducedName.trim()) && isSaneName(introducedName.trim())) {
    return { clear: true, format: "introduced_name", name: introducedName.trim() };
  }
  if (!sentenceStarter.test(normalized) && plainName.test(normalized) && isSaneName(normalized)) {
    return { clear: true, format: "plain_name", name: normalized };
  }
  return { clear: false, format: "unsupported_phrase" };
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

  const isNameQuestion =
    questions[session.currentQuestionIndex]?.id === "A2_NAME";
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
      const negative =
        /\b(nahi|nahin|no|not|cannot|can't|unable|never)\b/.test(normalized) ||
        locationClassification.travelWillingness === "no" ||
        /नहीं|नही/.test(followUpAnswer) ||
        /travel nahi|shift nahi|move nahi|door nahi|nahi kar sakti|nahi ja sakti/.test(
          normalized,
        );

      const positive =
        /\b(haan|han|yes|yeah|yep|sure|willing|ready)\b/.test(normalized) ||
        locationClassification.travelWillingness === "yes" ||
        /हाँ|हां/.test(followUpAnswer) ||
        /हाँ.*(कर सकती|कर सकता|जा सकती|जा सकता)|हां.*(कर सकती|कर सकता|जा सकती|जा सकता)/.test(
          followUpAnswer,
        ) ||
        /travel kar sakti|travel kar sakta|shift ho sakti|shift ho sakta|move kar sakti|move kar sakta|can travel|can relocate/.test(
          normalized,
        );

      if (negative && positive) {
        return askAgain(
          "Please clarify: are you willing to travel or relocate if required?",
        );
      }

      if (!negative && !positive) {
        return askAgain(
          "Please tell me clearly whether you can travel or relocate if required.",
        );
      }

      saveFollowUp();

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
            manualReviewRequired: true,
            followUpCaptured: true,
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
          manualReviewRequired: true,
          followUpCaptured: true,
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question: questions[session.currentQuestionIndex],
        },
      };
    }

    if (pending.type === "contextual_probe") {
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

  const question = questions[session.currentQuestionIndex];

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
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message:
            "Please clarify whether you agree to the screening conversation.",
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question,
        },
      };
    }

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
        },
      };
    }

    session.consentOutcome = "accepted";
    session.currentQuestionIndex += 1;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        consentOutcome: session.consentOutcome,
        question: questions[session.currentQuestionIndex],
      },
    };
  }

  // A1: Location and movement handling.
  if (question.id === "A1") {
    const result = classifyLocation(cleanAnswer);

    if (result.outcome === "clarification" && !result.followUp) {
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
      return {
        status: 200,
        body: {
          success: true,
          completed: false,
          clarificationRequired: true,
          message: "Please tell me your name.",
          questionNumber: session.currentQuestionIndex + 1,
          totalQuestions: questions.length,
          question,
        },
      };
    }

    session.candidateName = nameClassification.name || cleanAnswer;
    session.answers.push(answerRecord);
    session.currentQuestionIndex += 1;

    return {
      status: 200,
      body: {
        success: true,
        completed: false,
        candidateName: session.candidateName,
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: questions[session.currentQuestionIndex],
      },
    };
  }

  // Gemini interpretation for normal questions only.
  const isSpecialQuestion = ["A0", "A1", "A2", "A2_NAME"].includes(
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

        session.clarificationAttempts = session.clarificationAttempts || {};
        session.clarificationAttempts[question.id] =
          (session.clarificationAttempts[question.id] || 0) + 1;

        if (session.clarificationAttempts[question.id] >= 3) {
          session.manualChecks = session.manualChecks || [];
          session.manualChecks.push({
            questionId: question.id,
            outcome: "repeated_unclear_answers",
            answer: cleanAnswer,
            required: true,
            createdAt: new Date().toISOString(),
          });
          session.manualReviewRequired = true;
          answerRecord.manualReviewRequired = true;
          answerRecord.manualReviewReason = "Repeated unclear answers";
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
                manualReviewRequired: true,
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
              manualReviewRequired: true,
              questionNumber: session.currentQuestionIndex + 1,
              totalQuestions: questions.length,
              question: questions[session.currentQuestionIndex],
            },
          };
        }

        return {
          status: 200,
          body: {
            success: true,
            completed: false,
            clarificationRequired: true,
            message:
              interpretation.clarificationQuestion ||
              "Maaf kijiye, kya aap apna jawab thoda aur spasht kar sakti hain?",
            interpretation,
            questionNumber: session.currentQuestionIndex + 1,
            totalQuestions: questions.length,
            question,
          },
        };
      }
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

  return {
    status: 200,
    body: {
      success: true,
      report: {
        sessionId: session.sessionId,
        candidateId: session.candidateId || null,
        status: session.status,
        manualReviewRequired,
        manualReviewReason: session.manualReviewReason || null,
        eligibilityOutcome: session.eligibilityOutcome || null,
        locationOutcome: session.locationOutcome || null,
        manualChecks,
        consentOutcome: session.consentOutcome,
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
            session.answers.find((answer) => answer.questionId === "A2_NAME")?.answer ||
            "Name not recorded",
          status: session.status,
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

module.exports = {
  startInterview,
  submitAnswer,
  getReport,
  listReports,
  endInterview,
  getTotalQuestions,
  flagManualReview,
  getSessionSnapshot,
  restoreSessionSnapshot,
  restoreSessions,
  getSessionForPersistence,
  pauseInterview,
  resumeInterview,
  getActiveSessionForCandidate,
  getCurrentQuestionForSession,
};
