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

function startInterview() {
  const sessionId = crypto.randomUUID();

  const session = {
    sessionId,
    currentQuestionIndex: 0,
    answers: [],
    status: "in_progress",
    manualReviewRequired: false,
    manualReviewPaused: false,
    consentOutcome: "pending",
    startedAt: new Date().toISOString(),
    completedAt: null,
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

  const nameToken = String.raw`[\p{L}][\p{L}'’.-]*`;
  const nameSuffix = String.raw`(?:\s+${nameToken}){0,3}`;
  const namePhrase = new RegExp(
    String.raw`^(?:(?:mera naam|मेरा नाम)\s+${nameToken}${nameSuffix}\s*(?:hai|है)?|(?:my name is|i am|i'm)\s+${nameToken}${nameSuffix})$`,
    "iu",
  );
  const plainName = new RegExp(`^${nameToken}(?:\\s+${nameToken})?$`, "u");
  const sentenceStarter = /^(?:i|we|my|mera|meri|mujhe|main|मैं|मेरा|मेरी)\s/iu;

  if (namePhrase.test(normalized)) {
    return { clear: true, format: "introduced_name" };
  }
  if (!sentenceStarter.test(normalized) && plainName.test(normalized)) {
    return { clear: true, format: "plain_name" };
  }
  return { clear: false, format: "unsupported_phrase" };
}

async function submitAnswer({
  sessionId,
  answer,
  expectedQuestionId,
  diagnosticRequestId,
}) {
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
  const currentBankQuestion = questions[session.currentQuestionIndex];
  const currentQuestion = session.pendingFollowUp
    ? {
        id: `${session.pendingFollowUp.questionId}_${session.pendingFollowUp.type.toUpperCase()}`,
        Step: `${session.pendingFollowUp.questionId}_${session.pendingFollowUp.type.toUpperCase()}`,
        text: session.pendingFollowUp.prompt,
        category: "Location & movement",
      }
    : currentBankQuestion || null;
  const currentQuestionId = currentQuestion?.id || null;
  const sessionKey = sessionId.slice(-8);

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
    return {
      status: 409,
      body: {
        success: false,
        staleQuestion: true,
        currentQuestionId,
        clarificationRequired: Boolean(session.pendingFollowUp),
        followUpRequired: Boolean(session.pendingFollowUp),
        manualReviewRequired: Boolean(session.pendingFollowUp),
        questionNumber: session.currentQuestionIndex + 1,
        totalQuestions: questions.length,
        question: currentQuestion,
        message: "This answer belongs to an earlier question.",
      },
    };
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

    return askAgain("Please clarify your answer.");
  }

  const question = questions[session.currentQuestionIndex];

  const cleanAnswer = answer.trim();

  console.info("[UC Interview Diagnostics] answer_processing", {
    requestId: safeRequestId,
    sessionKey,
    expectedQuestionId: requestQuestionId || null,
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

    session.answers.push(answerRecord);
    session.currentQuestionIndex += 1;

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
  const isSpecialQuestion = ["A0", "A1", "A2", "A2_NAME"].includes(
    question.id,
  );

  if (!isSpecialQuestion) {
    try {
      const interpretation = await interpretAnswer({
        question: question.text,
        answer: cleanAnswer,
      });

      answerRecord.interpretation = interpretation;

      if (interpretation.needsClarification) {
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
      console.error("Gemini interpretation error:", error.message);
      answerRecord.interpretationError = true;
    }
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

  return {
    status: 200,
    body: {
      success: true,
      report: {
        sessionId: session.sessionId,
        status: session.status,
        manualReviewRequired: Boolean(session.manualReviewRequired),
        eligibilityOutcome: session.eligibilityOutcome || null,
        locationOutcome: session.locationOutcome || null,
        manualChecks: session.manualChecks || [],
        consentOutcome: session.consentOutcome,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        totalQuestions: questions.length,
        answeredQuestions: session.answers.length,
        answers: session.answers,
      },
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
  getTotalQuestions,
  flagManualReview,
};
