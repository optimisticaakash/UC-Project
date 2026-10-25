const crypto = require("crypto");
const path = require("path");

const { classifyConsent } = require("./rules/consentRules");
const { evaluateAge } = require("./rules/ageRules");
const { classifyLocation } = require("./rules/locationRules");
const { interpretAnswer } = require("./geminiService");

const bankPath = path.join(__dirname, "../data/questionBank.json");
const bank = require(bankPath);

if (!Array.isArray(bank.questions) || bank.questions.length !== 49) {
  throw new Error("Invalid questionBank.json: expected exactly 49 questions.");
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

function submitAnswer({ sessionId, answer }) {
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

  if (typeof answer !== "string" || !answer.trim()) {
    return {
      status: 400,
      body: {
        success: false,
        message: "Please provide a non-empty answer.",
      },
    };
  }

  // Handle pending follow-ups safely.
  if (session.pendingFollowUp) {
    const pending = session.pendingFollowUp;
    const followUpAnswer = answer.trim();
    const normalized = followUpAnswer.toLowerCase();

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
      const negative =
        /\b(nahi|nahin|no|not|cannot|can't|unable|never)\b/.test(normalized) ||
        /travel nahi|shift nahi|move nahi|door nahi|nahi kar sakti|nahi ja sakti/.test(
          normalized,
        );

      const positive =
        /\b(haan|han|yes|yeah|yep|sure|willing|ready)\b/.test(normalized) ||
        /travel kar sakti|travel kar sakta|shift ho sakti|shift ho sakta|move kar sakti|move kar sakta|can travel|can relocate/.test(
          normalized,
        );

      // Ambiguous or contradictory answers need clarification.
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

      // Positive travel response: ask for relocation timeline.
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
      const followUpAnswer = answer.trim();
      const normalized = followUpAnswer.toLowerCase();

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
  console.log("CURRENT QUESTION:", question.id);
  console.log("RECEIVED ANSWER:", answer);
  const cleanAnswer = answer.trim();

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

  // Gemini interpretation for normal questions only.
  // const isSpecialQuestion = ["A0", "A1", "A2"].includes(question.id);

  // if (!isSpecialQuestion) {
  //   try {
  //     const interpretation = await interpretAnswer({
  //       question: question.text,
  //       answer: cleanAnswer,
  //     });

  //     answerRecord.interpretation = interpretation;

  //     if (interpretation.needsClarification) {
  //       return {
  //         status: 200,
  //         body: {
  //           success: true,
  //           completed: false,
  //           clarificationRequired: true,
  //           message: interpretation.clarificationQuestion,
  //           interpretation,
  //           questionNumber: session.currentQuestionIndex + 1,
  //           totalQuestions: questions.length,
  //           question,
  //         },
  //       };
  //     }
  //   } catch (error) {
  //     console.error("Gemini interpretation error:", error.message);
  //     answerRecord.interpretationError = true;
  //   }
  // }

  // Sequential flow for questions other than A0.
  session.answers.push(answerRecord);
  session.currentQuestionIndex += 1;

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
