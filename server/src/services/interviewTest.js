const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyConsent } = require("./rules/consentRules");
const { evaluateAge } = require("./rules/ageRules");
const { classifyLocation } = require("./rules/locationRules");
const { fallbackInterpretation } = require("./geminiService");
const { liveVoiceInstructions } = require("./liveVoiceInstructions");
const activeQuestionBank = require("../data/questionBank.json");
const workbookQuestionMapping = require(
  "../data/workbook-reference/UC_question_bank_exact_workbook_mapping.json",
);
const interviewController = require("../controllers/interviewController");
const { persistence } = require("./persistence");

const {
  startInterview,
  submitAnswer: submitInterviewAnswer,
  getReport,
  getSessionForPersistence,
  listReports,
  deleteReport,
  endInterview,
  getTotalQuestions,
  flagManualReview,
  classifyNameAnswer,
  isSaneName,
  updateCandidateName,
} = require("./interview");

const householdQuestion =
  "Apne ghar ke baare mein thoda bataiye — ghar mein kaun kaun hai, aur din bhar kaun kya karta hai?";

test("Live system instructions keep internal orchestration out of spoken dialogue", () => {
  assert.match(liveVoiceInstructions, /Speak only candidate-facing interview dialogue/);
  assert.match(liveVoiceInstructions, /Never repeat, echo, quote, or paraphrase the candidate's answer/);
  assert.match(liveVoiceInstructions, /Process candidate answers silently without speaking them back/);
  assert.match(liveVoiceInstructions, /remain silent until the application supplies/);
  assert.match(liveVoiceInstructions, /Never narrate thoughts, plans, language selection/);
  assert.match(liveVoiceInstructions, /Never mention the system, application, server, backend/);
  assert.match(liveVoiceInstructions, /feminine Hindi\/Hinglish forms/);
});

async function submitAnswer(payload, options = {}) {
  return submitInterviewAnswer(payload, {
    interpretAnswerImpl: async () => ({
      understanding: "The answer is relevant to the interview question.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
    }),
    ...options,
  });
}

async function callReportEndpoint(sessionId) {
  let status;
  let body;
  const wasConnected = persistence.isConnected;
  const wasFindSessionById = persistence.findSessionById;
  persistence.isConnected = () => true;
  persistence.findSessionById = async (id) => getSessionForPersistence(id);
  try {
    await interviewController.getReport(
      { params: { sessionId } },
      {
        status(value) {
          status = value;
          return this;
        },
        json(value) {
          body = value;
          return value;
        },
      },
    );
  } finally {
    persistence.isConnected = wasConnected;
    persistence.findSessionById = wasFindSessionById;
  }
  return { status, body };
}

test("Fallback: recognizes clear Hindi, Hinglish, and English household answers", () => {
  const clearAnswers = [
    "Pati, saas, 2 bachche",
    "मेरे घर में पति, सास और दो बच्चे हैं",
    "My husband works and my mother looks after the children",
  ];

  for (const answer of clearAnswers) {
    const result = fallbackInterpretation({
      question: householdQuestion,
      answer,
    });
    assert.equal(result.answerStatus, "sufficient", answer);
    assert.equal(result.needsClarification, false, answer);
  }
});

test("Fallback: asks for clarification on incomplete or unrelated household answers", () => {
  const unclearAnswers = [
    "Ghar bahut accha hai",
    "Mera parivaar bahut accha hai",
    "I like cricket",
    "We are fine",
  ];

  for (const answer of unclearAnswers) {
    const result = fallbackInterpretation({
      question: householdQuestion,
      answer,
    });
    assert.equal(result.answerStatus, "unclear", answer);
    assert.equal(result.needsClarification, true, answer);
  }
});

test("Interview: interpretation failure holds the current question and asks for a retry", async () => {
  const started = await startAtHousehold();
  const answerPayload = {
    sessionId: started.sessionId,
    answer: "Mere pati salon mein kaam karte hain aur bachche school jaate hain",
    expectedQuestionId: "A3",
    diagnosticRequestId: "interpretation-failure-test",
  };

  const failed = await submitAnswer(answerPayload, {
    interpretAnswerImpl: async () => {
      throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { name: "RateLimitError", status: 429 });
    },
  });

  assert.equal(failed.status, 200);
  assert.equal(failed.body.interpretationUnavailable, true);
  assert.equal(failed.body.clarificationRequired, true);
  assert.equal(failed.body.question.id, "A3");
  assert.match(failed.body.message, /safe|save|सुरक्षित/i);
  const failedSession = getSessionForPersistence(started.sessionId);
  assert.equal(failedSession.currentQuestionIndex, 4);
  assert.equal(failedSession.pendingInterpretation.answerRecord.answer, answerPayload.answer);
  assert.equal(failedSession.pendingInterpretation.failureCode, "AI_RATE_LIMIT");
  assert.equal(getReport(started.sessionId).body.report.pendingInterpretation.answer, answerPayload.answer);
  assert.equal(failedSession.answers.some((entry) => entry.questionId === "A3"), false);

  const retried = await submitAnswer(answerPayload, {
    interpretAnswerImpl: async () => ({
      understanding: "Household members and roles were provided.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
    }),
  });

  assert.equal(retried.status, 200);
  assert.equal(retried.body.question.id, "A4");
  assert.equal(getSessionForPersistence(started.sessionId).pendingInterpretation, null);
});

test("Interview: concurrent duplicate interpretations cannot skip a question", async () => {
  const started = await startAtHousehold();
  let releaseInterpretation;
  const interpretationGate = new Promise((resolve) => {
    releaseInterpretation = resolve;
  });
  let interpretationCalls = 0;
  const interpretAnswerImpl = async () => {
    interpretationCalls += 1;
    await interpretationGate;
    return {
      understanding: "The candidate described household members.",
      answerStatus: "sufficient",
      needsClarification: false,
      clarificationQuestion: "",
    };
  };
  const answer = {
    sessionId: started.sessionId,
    expectedQuestionId: "A3",
    answer: "Mere do bachche hain",
  };

  const firstSubmission = submitAnswer({
    ...answer,
    diagnosticRequestId: "duplicate-a3-first",
  }, { interpretAnswerImpl });
  const duplicateSubmission = submitAnswer({
    ...answer,
    diagnosticRequestId: "duplicate-a3-second",
  }, { interpretAnswerImpl });

  assert.equal(interpretationCalls, 2);
  releaseInterpretation();
  const results = await Promise.all([firstSubmission, duplicateSubmission]);

  assert.equal(results.filter((result) => result.status === 200).length, 1);
  const staleResult = results.find((result) => result.status === 409);
  assert.equal(staleResult?.body.staleQuestion, true);
  assert.equal(staleResult?.body.currentQuestionId, "A4");

  const report = getReport(started.sessionId).body.report;
  assert.deepEqual(
    report.answers.map((item) => item.questionId),
    ["A2_NAME", "A0", "A1", "A2", "A3"],
  );
  assert.equal(results.find((result) => result.status === 200).body.question.id, "A4");
});

async function startAtConsent() {
  const started = startInterview();
  assert.equal(started.question.id, "A2_NAME");
  const nameResult = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Sunita",
    expectedQuestionId: "A2_NAME",
    diagnosticRequestId: "name-opening-test",
  });
  assert.equal(nameResult.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(nameResult.body.candidateName, "Sunita");
  const confirmResult = await submitAnswer({
    sessionId: started.sessionId,
    answer: "yes",
    expectedQuestionId: "A2_NAME_CONFIRM",
  });
  assert.equal(confirmResult.body.question.id, "A0");
  return started;
}

async function startTravelClarification() {
  const started = await startAtConsent();
  await submitAnswer({ sessionId: started.sessionId, answer: "Haan" });
  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  assert.equal(result.body.followUp?.type, "travel_clarification");
  return started;
}

async function startAtHousehold() {
  const started = await startAtConsent();
  const consent = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });
  assert.equal(consent.body.question.id, "A1");

  const location = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel nahi kar sakti",
  });
  assert.equal(location.body.question.id, "A2");

  const age = await submitAnswer({
    sessionId: started.sessionId,
    answer: "25",
  });
  assert.equal(age.body.question.id, "A3");
  return started;
}

test("Interview: explicit Hindi or English no-children answers skip only A4 and A5", async () => {
  for (const answer of [
    "Mere bachche nahi hain, ghar mein pati aur saas hain",
    "Koi bachcha nahi hai; mere saath meri maa rehti hain",
    "मेरे घर में कोई बच्चा नहीं है, मेरे पति और सास रहते हैं",
    "I don't have children; I live with my husband and mother",
  ]) {
    const started = await startAtHousehold();
    const result = await submitAnswer({ sessionId: started.sessionId, answer });

    assert.equal(result.status, 200, answer);
    assert.equal(result.body.clarificationRequired, undefined, answer);
    assert.equal(result.body.question.id, "A6", answer);
    assert.equal(result.body.questionNumber, activeQuestionBank.questions.findIndex((item) => item.Step === "A6") + 1);

    const report = getReport(started.sessionId).body.report;
    assert.equal(report.answers.find((item) => item.questionId === "A3")?.childPresence, "none");
  }
});

test("Interview: children present keeps applicable A4 and A5 in order", async () => {
  for (const answer of ["Mere 2 bachche hain", "मेरे दो बच्चे हैं"]) {
    const started = await startAtHousehold();
    let result = await submitAnswer({ sessionId: started.sessionId, answer });
    assert.equal(result.body.question.id, "A4", answer);

    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Dono class 4 mein padhte hain",
    });
    assert.equal(result.body.question.id, "A5");

    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "School ke baad unki dadi unke saath hoti hain",
    });
    assert.equal(result.body.question.id, "A6");
  }
});

test("Interview: unclear child status on A3 asks clarification and accepts clear yes/no", async () => {
  const started = await startAtHousehold();
  let result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Mere ghar mein pati aur saas hain",
  });

  assert.equal(result.body.clarificationRequired, true);
  assert.equal(result.body.question.id, "A3");

  result = await submitAnswer({ sessionId: started.sessionId, answer: "Haan" });
  assert.equal(result.body.question.id, "A4");

  const noChildrenStarted = await startAtHousehold();
  await submitAnswer({
    sessionId: noChildrenStarted.sessionId,
    answer: "Pati aur saas",
  });
  result = await submitAnswer({
    sessionId: noChildrenStarted.sessionId,
    answer: "Nahi",
  });
  assert.equal(result.body.question.id, "A6");
});

test("Interview: conflicting A3 child statements stay in clarification", async () => {
  const started = await startAtHousehold();
  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Mere bachche nahi hain, lekin mere do bachche hain",
  });

  assert.equal(result.body.clarificationRequired, true);
  assert.equal(result.body.question.id, "A3");
});

test("Interview: A3 details already given skip only their corresponding child follow-up", async () => {
  const started = await startAtHousehold();
  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Mere 2 bachche hain, dono class 4 mein hain aur school ke baad meri saas unke saath rehti hain",
  });

  assert.equal(result.body.question.id, "A6");
});

test("Interview: approved name question is counted and matches the workbook mapping", () => {
  const activeQuestions = activeQuestionBank.questions;
  const mappedQuestions = workbookQuestionMapping.questionFlow;
  const activeSequence = activeQuestions.map((item) => ({
    Step: item.Step,
    text: item["Bot says (primary)"],
  }));
  const mappedSequence = mappedQuestions.map((item) => ({
    Step: item.Step,
    text: item["Bot says (primary)"],
  }));

  assert.equal(getTotalQuestions(), 50);
  assert.equal(activeQuestionBank.runtimeInstructions.questionCount, 50);
  assert.equal(activeQuestions.length, 50);
  assert.equal(mappedQuestions.length, 50);
  assert.deepEqual(activeSequence, mappedSequence);
  const started = startInterview();
  assert.equal(started.totalQuestions, 50);
  assert.equal(started.question.id, "A2_NAME");
  assert.equal(
    started.question.text,
    "Namaste ji, sabse pehle aap apna naam bataiye.",
  );

  const ids = activeQuestions.map((item) => item.Step);
  assert.deepEqual(ids.slice(0, 5), ["A2_NAME", "A0", "A1", "A2", "A3"]);
  assert.deepEqual(
    activeQuestions.find((item) => item.Step === "A2_NAME"),
    mappedQuestions.find((item) => item.Step === "A2_NAME"),
  );
  assert.equal(
    activeQuestions[0]["Bot says (primary)"],
    "Namaste ji, sabse pehle aap apna naam bataiye.",
  );
});

test("Interview: completes the active question-bank sequence and report endpoint in order", async () => {
  const expectedIds = activeQuestionBank.questions.map((item) => item.Step);
  const started = startInterview();
  assert.equal(started.totalQuestions, expectedIds.length);

  const answerFor = (questionId) => {
    switch (questionId) {
      case "A2_NAME":
        return "Sunita";
      case "A0":
        return "Haan, Hindi mein";
      case "A1":
        return "Delhi";
      case "A2":
        return "25";
      case "A3":
        return "I have two children";
      case "A4":
        return "They study in class 4";
      case "A5":
        return "Their grandmother looks after them after school";
      default:
        return "I can explain my relevant experience";
    }
  };

  let question = started.question;
  for (let index = 0; index < expectedIds.length; index += 1) {
    const expectedQuestionId = expectedIds[index];
    assert.equal(question.id, expectedQuestionId, `question at position ${index + 1}`);

    let result = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId,
      answer: answerFor(expectedQuestionId),
      diagnosticRequestId: `full-sequence-${index + 1}`,
    });

    assert.equal(result.status, 200, `HTTP result for ${expectedQuestionId}`);
    if (expectedQuestionId === "A2_NAME") {
      assert.equal(result.body.question.id, "A2_NAME_CONFIRM");
      result = await submitAnswer({
        sessionId: started.sessionId,
        expectedQuestionId: "A2_NAME_CONFIRM",
        answer: "yes",
      });
      assert.equal(result.body.question.id, expectedIds[index + 1]);
      question = result.body.question;
      continue;
    }
    if (expectedQuestionId === "A1") {
      assert.equal(result.body.followUpRequired, true);
      assert.equal(result.body.question.id, "A1_TRAVEL_CLARIFICATION");

      result = await submitAnswer({
        sessionId: started.sessionId,
        expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
        answer: "Haan, main travel kar sakti hoon",
      });
      assert.equal(result.body.question.id, "A1_MOVE_TIMELINE");

      result = await submitAnswer({
        sessionId: started.sessionId,
        expectedQuestionId: "A1_MOVE_TIMELINE",
        answer: "Ek mahine mein",
      });
      assert.equal(result.body.question.id, expectedIds[index + 1]);
      question = result.body.question;
      continue;
    }

    if (index === expectedIds.length - 1) {
      assert.equal(result.body.completed, true);
      assert.equal(result.body.question, undefined);
    } else {
      assert.equal(result.body.completed, false, `completion state for ${expectedQuestionId}`);
      question = result.body.question;
      assert.ok(question, `next question after ${expectedQuestionId}`);
      assert.equal(question.id, expectedIds[index + 1]);
    }
  }

  const report = getReport(started.sessionId).body.report;
  assert.equal(report.status, "completed");
  assert.equal(report.totalQuestions, expectedIds.length);
  assert.equal(report.answeredQuestions, expectedIds.length + 2);
  assert.equal(report.manualReviewRequired, true);
  assert.deepEqual(
    report.answers
      .map((item) => item.questionId)
      .filter((questionId) => expectedIds.includes(questionId)),
    expectedIds,
  );
  assert.deepEqual(
    report.answers
      .filter((item) => item.questionId.startsWith("A1_"))
      .map((item) => item.questionId),
    ["A1_travel_clarification", "A1_move_timeline"],
  );

  const endpoint = await callReportEndpoint(started.sessionId);
  assert.equal(endpoint.status, 200);
  assert.equal(endpoint.body.success, true);
  assert.equal(endpoint.body.report.status, "completed");
  assert.deepEqual(
    endpoint.body.report.answers
      .map((item) => item.questionId)
      .filter((questionId) => expectedIds.includes(questionId)),
    expectedIds,
  );
  assert.equal(endpoint.body.report.answers.length, expectedIds.length + 2);
  assert.equal(endpoint.body.report.manualReviewRequired, true);

  const endedComplete = endInterview(started.sessionId);
  assert.equal(endedComplete.body.sessionStatus, "completed");
  assert.equal(getReport(started.sessionId).body.report.status, "completed");

  const unknown = await callReportEndpoint("not-a-session");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.success, false);
});

test("Interview report endpoint marks an unfinished session as in progress", async () => {
  const started = startInterview();
  const endpoint = await callReportEndpoint(started.sessionId);

  assert.equal(endpoint.status, 200);
  assert.equal(endpoint.body.success, true);
  assert.equal(endpoint.body.report.status, "in_progress");
  assert.equal(endpoint.body.report.completedAt, null);
  assert.equal(endpoint.body.report.answeredQuestions, 0);
});

test("Ending an incomplete interview finalizes its report once and preserves answers and review flags", async () => {
  const started = await startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan",
  });
  const before = getReport(started.sessionId).body.report;
  assert.equal(before.answeredQuestions, 1);
  const flagResponse = flagManualReview(started.sessionId, "Existing review flag");
  assert.equal(flagResponse.body.manualReviewRequired, true);

  const firstEnd = endInterview(started.sessionId);
  const firstEndedAt = firstEnd.body.endedAt;
  assert.equal(firstEnd.body.sessionStatus, "incomplete");
  assert.equal(firstEnd.body.answeredQuestions, 1);

  const secondEnd = endInterview(started.sessionId);
  assert.equal(secondEnd.body.sessionStatus, "incomplete");
  assert.equal(secondEnd.body.endedAt, firstEndedAt);

  const report = getReport(started.sessionId).body.report;
  assert.equal(report.status, "incomplete");
  assert.equal(report.answeredQuestions, 1);
  assert.equal(report.answers[0].questionId, "A2_NAME");
  assert.equal(report.manualReviewRequired, true);
  assert.equal(report.manualReviewReason, "Existing review flag");
});

test("Ending after a refusal preserves the manual-review terminal outcome", async () => {
  const started = await startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Riya" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Nahi, main agree nahi karti" });
  const ended = endInterview(started.sessionId);
  const report = getReport(started.sessionId).body.report;
  assert.equal(ended.body.sessionStatus, "manual_review");
  assert.equal(report.status, "manual_review");
  assert.equal(report.answeredQuestions, 2);
  assert.equal(report.manualReviewRequired, true);
});

test("Internal session list identifies the matching session and review status", async () => {
  const first = await startInterview();
  const second = await startInterview();
  await submitAnswer({ sessionId: first.sessionId, answer: "Candidate Alpha", expectedQuestionId: "A2_NAME" });
  await submitAnswer({ sessionId: second.sessionId, answer: "Candidate Beta", expectedQuestionId: "A2_NAME" });
  await submitAnswer({ sessionId: second.sessionId, answer: "Nahi, main agree nahi karti", expectedQuestionId: "A0" });

  const sessions = listReports().body.sessions;
  const firstSummary = sessions.find((session) => session.sessionId === first.sessionId);
  const secondSummary = sessions.find((session) => session.sessionId === second.sessionId);
  assert.equal(firstSummary.candidateName, "Candidate Alpha");
  assert.equal(firstSummary.status, "in_progress");
  assert.equal(firstSummary.manualReviewRequired, false);
  assert.equal(secondSummary.candidateName, "Candidate Beta");
  assert.equal(secondSummary.status, "manual_review");
  assert.equal(secondSummary.manualReviewRequired, true);
  assert.equal(getReport(first.sessionId).body.report.sessionId, first.sessionId);
});

test("Interview: captures name, obtains consent, then progresses through A1, A2, and A3", async () => {
  for (const name of [
    "Sunita",
    "Mera naam Sunita hai",
    "मेरा नाम सुनीता है",
  ]) {
    const started = startInterview();
    assert.equal(started.question.id, "A2_NAME");
    const result = await submitAnswer({ sessionId: started.sessionId, answer: name });

    assert.equal(result.status, 200);
    assert.equal(result.body.clarificationRequired, undefined);
    assert.equal(result.body.question.id, "A2_NAME_CONFIRM");
    const confirmResult = await submitAnswer({
      sessionId: started.sessionId,
      answer: "yes",
      expectedQuestionId: "A2_NAME_CONFIRM",
    });
    assert.equal(confirmResult.status, 200);
    assert.equal(confirmResult.body.question.id, "A0");
    const report = getReport(started.sessionId).body.report;
    assert.ok(
      report.answers.find((item) => item.questionId === "A2_NAME"),
    );

    const consentResult = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan",
    });
    assert.equal(consentResult.body.question.id, "A1");

    const locationResult = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Delhi, main travel nahi kar sakti",
    });
    assert.equal(locationResult.body.question.id, "A2");

    const ageResult = await submitAnswer({
      sessionId: started.sessionId,
      answer: "25",
    });
    assert.equal(ageResult.body.question.id, "A3");
  }
});

test("Interview: empty or unclear name answers retain A2_NAME for clarification", async () => {
  for (const answer of [
    "",
    "Pata nahi",
    "Mera naam kya hai",
    "Mera naam nahi pata",
  ]) {
    const started = startInterview();
    const result = await submitAnswer({ sessionId: started.sessionId, answer });
    assert.equal(result.status, 200);
    assert.equal(result.body.clarificationRequired, true);
    assert.equal(result.body.question.id, "A2_NAME");
    assert.equal(getReport(started.sessionId).body.report.answeredQuestions, 0);
  }
});

test("Interview: a 17-character introduced name is accepted after clarification and advances to A0", async () => {
  const started = startInterview();
  const unclear = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Hmm",
    expectedQuestionId: "A2_NAME",
    diagnosticRequestId: "name-unclear-first",
  });

  assert.equal(unclear.body.clarificationRequired, true);
  assert.equal(unclear.body.question.id, "A2_NAME");

  const validName = "My name is Sunita";
  assert.equal(validName.length, 17);
  const accepted = await submitAnswer({
    sessionId: started.sessionId,
    answer: validName,
    expectedQuestionId: "A2_NAME",
    diagnosticRequestId: "name-accepted-second",
  });

  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.clarificationRequired, undefined);
  assert.equal(accepted.body.question.id, "A2_NAME_CONFIRM");
  const confirmed = await submitAnswer({
    sessionId: started.sessionId,
    answer: "yes",
    expectedQuestionId: "A2_NAME_CONFIRM",
  });
  assert.equal(confirmed.body.question.id, "A0");
});

test("Interview: stale A2_NAME submission after progression cannot answer A0", async () => {
  const started = startInterview();
  const acceptedName = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Sunita",
    expectedQuestionId: "A2_NAME",
    diagnosticRequestId: "p1-a1",
  });
  assert.equal(acceptedName.body.question.id, "A2_NAME_CONFIRM");
  const confirmed = await submitAnswer({
    sessionId: started.sessionId,
    answer: "yes",
    expectedQuestionId: "A2_NAME_CONFIRM",
  });
  assert.equal(confirmed.body.question.id, "A0");

  const staleName = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Sunita",
    expectedQuestionId: "A2_NAME",
    diagnosticRequestId: "p1-a2",
  });
  assert.equal(staleName.status, 409);
  assert.equal(staleName.body.staleQuestion, true);
  assert.equal(staleName.body.currentQuestionId, "A0");
  assert.equal(staleName.body.question.id, "A0");
  assert.equal(getReport(started.sessionId).body.report.answeredQuestions, 1);

  const consent = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
    expectedQuestionId: "A0",
    diagnosticRequestId: "p2-a3",
  });
  assert.equal(consent.body.question.id, "A1");
});

test("Interview: pending travel clarification accepts its logical question ID", async () => {
  const started = await startAtConsent();
  const consent = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
    expectedQuestionId: "A0",
    diagnosticRequestId: "travel-consent",
  });
  assert.equal(consent.body.question.id, "A1");

  const travel = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
    expectedQuestionId: "A1",
    diagnosticRequestId: "travel-answer",
  });
  assert.equal(travel.body.question.id, "A1_TRAVEL_CLARIFICATION");
  assert.equal(travel.body.manualReviewRequired, true);

  const clarification = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan, main travel kar sakti hoon",
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    diagnosticRequestId: "travel-clarification",
  });
  assert.equal(clarification.status, 200);
  assert.equal(clarification.body.question.id, "A1_MOVE_TIMELINE");
  assert.equal(clarification.body.followUp.type, "move_timeline");
  assert.equal(clarification.body.manualReviewRequired, true);
});


test("Consent: accepts a clear yes", () => {
  for (const answer of ["Haan", "Yes, I agree", "हाँ, मैं सहमत हूं"]) {
    assert.equal(classifyConsent(answer), "accepted", answer);
  }
});

test("Consent: identifies refusal", () => {
  assert.equal(classifyConsent("Nahi, main agree nahi karti"), "refused");
  assert.equal(classifyConsent("NAHI — MAIN AGREE NAHI KARTI!"), "refused");
});

test("Consent: preserves Devanagari refusal classification", () => {
  for (const answer of ["नहीं, मैं सहमत नहीं हूं", "रिकॉर्ड मत करो"]) {
    assert.equal(classifyConsent(answer), "refused", answer);
  }
});

test("Consent: identifies unclear response", () => {
  assert.equal(classifyConsent("Pata nahi."), "unclear");
  assert.equal(classifyConsent("Maybe, I agree"), "unclear");
});

test("Age: accepts an eligible age", () => {
  const validPhrases = [
    "25",
    "I am 25",
    "I am 25 years old",
    "25 years",
    "मैं 25 साल की हूं।",
    "मेरी उम्र 25 साल है।",
  ];

  for (const answer of validPhrases) {
    const result = evaluateAge(answer);
    assert.equal(result.outcome, "pass", answer);
    assert.equal(result.age, 25, answer);
  }
});

test("Age: does not interpret unrelated sentence numbers as age", () => {
  const result = evaluateAge("Faraon wala isliye 10 minute diya hai");

  assert.equal(result.outcome, "clarification");
  assert.equal(result.age, null);
});

test("Age: flags age 39 for manual review", () => {
  const result = evaluateAge("39");

  assert.equal(result.outcome, "manual_review");
});


test("Interview: underage candidate is rejected", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const locationResult = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  // Agar location follow-up aaye, toh usko handle karo.
  let result = locationResult;

  if (result.body.followUpRequired) {
    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Nahi, main travel nahi kar sakti",
    });
  }

  // Age question tak pahunchna verify karo.
  assert.equal(result.body.question.id, "A2");

  result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "17",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.completed, true);
  assert.equal(result.body.eligibilityOutcome, "reject");
});


test("Location: asks for clarification when unclear", () => {
  const result = classifyLocation("Pata nahi.");

  assert.equal(result.outcome, "clarification");
});


test("Interview: starts with the first question", () => {
  const result = startInterview();

  assert.equal(result.success, true);
  assert.ok(result.sessionId);
  assert.equal(result.questionNumber, 1);
  assert.equal(result.question.id, "A2_NAME");
  assert.equal(
    result.question.text,
    "Namaste ji, sabse pehle aap apna naam bataiye.",
  );
});

test("Interview: a lost in-memory session is identifiable and a fresh session starts at A2_NAME", async () => {
  const original = startInterview();
  const lostSessionResult = await submitAnswer({
    sessionId: "session-lost-after-server-restart",
    answer: "Sunita",
    expectedQuestionId: "A2_NAME",
  });

  assert.equal(lostSessionResult.status, 404);
  assert.equal(lostSessionResult.body.code, "SESSION_NOT_FOUND");

  const fresh = startInterview();
  assert.notEqual(fresh.sessionId, original.sessionId);
  assert.equal(fresh.question.id, "A2_NAME");
});

test("Interview: accepted consent moves to location question", async () => {
  const started = await startAtConsent();

  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.consentOutcome, "accepted");
  assert.equal(result.body.question.id, "A1");
});

test("Interview: refused consent routes to manual review", async () => {
  const started = await startAtConsent();

  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Nahi, main agree nahi karti",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.completed, true);
  assert.equal(result.body.manualReviewRequired, true);
  assert.equal(result.body.sessionStatus, "manual_review");
  assert.equal(result.body.consentOutcome, "refused");
});

test("Interview: report contains the consent answer", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const result = getReport(started.sessionId);

  assert.equal(result.status, 200);
  assert.equal(result.body.report.consentOutcome, "accepted");
  assert.equal(result.body.report.answeredQuestions, 2);
});




test("Interview: unclear consent repeats the same question", async () => {
  const started = await startAtConsent();

  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Pata nahi.",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.clarificationRequired, true);
  assert.equal(result.body.question.id, "A0");
});

test("Interview: unclear location asks for clarification", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Pata nahi.",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.clarificationRequired, true);
  assert.equal(result.body.question.id, "A1");
});


test("Interview: willing candidate gets relocation timeline follow-up", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const locationResult = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel kar sakti hoon",
  });

  assert.equal(locationResult.status, 200);
  assert.equal(locationResult.body.followUpRequired, true);

  // Answer the travel willingness clarification if required.
  let result = locationResult;

  if (result.body.followUp?.type === "travel_clarification") {
    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan, main travel kar sakti hoon",
    });
  }

  assert.equal(result.body.followUpRequired, true);
  assert.equal(result.body.followUp.type, "move_timeline");

  const timelineResult = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Ek mahine mein",
  });

  assert.equal(timelineResult.status, 200);
  assert.equal(timelineResult.body.followUpCaptured, true);
});

test("Interview: unwilling candidate moves to the next question", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const locationResult = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, sirf apne area mein kaam kar sakti hoon",
  });

  let result = locationResult;

  if (result.body.followUp?.type === "travel_clarification") {
    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Nahi, main travel nahi kar sakti",
    });
  }

  assert.equal(result.status, 200);
  assert.equal(result.body.completed, false);
  assert.equal(result.body.question.id, "A2");
});

test("Interview: relocation timeline is saved in the report", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel kar sakti hoon",
  });

  if (result.body.followUp?.type === "travel_clarification") {
    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan, main travel kar sakti hoon",
    });
  }

  if (result.body.followUp?.type === "move_timeline") {
    await submitAnswer({
      sessionId: started.sessionId,
      answer: "Ek mahine mein",
    });
  }

  const report = getReport(started.sessionId);
  const locationCheck = report.body.report.manualChecks.find(
    (item) => item.questionId === "A1",
  );

  assert.ok(locationCheck);
  assert.equal(locationCheck.moveTimelineAnswer, "Ek mahine mein");
});



test("Interview: location answer is flagged for manual review", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  const result = getReport(started.sessionId);
  const report = result.body.report;

  assert.equal(result.status, 200);
  assert.equal(report.locationOutcome, "manual_review");
  assert.ok(report.manualChecks.some((item) => item.questionId === "A1"));
});

test("Interview: report records manual-review details after travel follow-up", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel kar sakti hoon",
  });

  if (result.body.followUp?.type === "travel_clarification") {
    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan, main travel kar sakti hoon",
    });
  }

  if (result.body.followUp?.type === "move_timeline") {
    await submitAnswer({
      sessionId: started.sessionId,
      answer: "Ek mahine mein",
    });
  }

  const report = getReport(started.sessionId).body.report;
  const check = report.manualChecks.find((item) => item.questionId === "A1");

  assert.ok(check);
  assert.equal(check.required, true);
  assert.ok(check.travelWillingness);
  assert.equal(check.moveTimelineAnswer, "Ek mahine mein");
});

test("Interview: unclear relocation timeline does not silently advance", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel kar sakti hoon",
  });

  if (result.body.followUp?.type === "travel_clarification") {
    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan, main travel kar sakti hoon",
    });
  }

  assert.equal(result.body.followUp?.type, "move_timeline");

  const timelineResult = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Pata nahi",
  });

  // This is the intended requirement; implementation may fail initially.
  assert.equal(timelineResult.body.clarificationRequired, true);
  assert.equal(timelineResult.body.followUpRequired, true);
  assert.equal(timelineResult.body.question.id, "A1_MOVE_TIMELINE");
});



test("Interview: Devanagari affirmative reaches relocation timeline", async () => {
  const started = await startTravelClarification();

  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "हाँ, कर सकती हूँ।",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.followUpRequired, true);
  assert.equal(result.body.followUp.type, "move_timeline");
  assert.equal(result.body.question.id, "A1_MOVE_TIMELINE");
});

test("Interview: Devanagari negative advances to the next question", async () => {
  const started = await startTravelClarification();

  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "नहीं, मैं नहीं जा सकती।",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.followUpCaptured, true);
  assert.equal(result.body.travelWillingness, "no");
  assert.equal(result.body.question.id, "A2");
});

test("Interview: Romanized Hindi travel answers are classified", async () => {
  const positiveSession = await startTravelClarification();
  const positive = await submitAnswer({
    sessionId: positiveSession.sessionId,
    answer: "Haan, main travel kar sakti hoon",
  });

  assert.equal(positive.body.followUp.type, "move_timeline");
  assert.equal(positive.body.question.id, "A1_MOVE_TIMELINE");

  const negativeSession = await startTravelClarification();
  const negative = await submitAnswer({
    sessionId: negativeSession.sessionId,
    answer: "Nahi, main travel nahi kar sakti",
  });

  assert.equal(negative.body.travelWillingness, "no");
  assert.equal(negative.body.question.id, "A2");
});

test("Interview: English travel answers are classified", async () => {
  const positiveSession = await startTravelClarification();
  const positive = await submitAnswer({
    sessionId: positiveSession.sessionId,
    answer: "Yes, I can travel",
  });

  assert.equal(positive.body.followUp.type, "move_timeline");
  assert.equal(positive.body.question.id, "A1_MOVE_TIMELINE");

  const negativeSession = await startTravelClarification();
  const negative = await submitAnswer({
    sessionId: negativeSession.sessionId,
    answer: "No, I cannot travel",
  });

  assert.equal(negative.body.travelWillingness, "no");
  assert.equal(negative.body.question.id, "A2");
});

test("Interview: ambiguous travel answer keeps the clarification pending", async () => {
  const started = await startTravelClarification();

  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Maybe, I am not sure",
  });

  assert.equal(result.body.clarificationRequired, true);
  assert.equal(result.body.followUpRequired, true);
  assert.equal(result.body.followUp.type, "travel_clarification");
  assert.equal(result.body.question.id, "A1_TRAVEL_CLARIFICATION");
});

test("Interview: conflicting travel answer keeps the clarification pending", async () => {
  const started = await startTravelClarification();

  const result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "हाँ, लेकिन नहीं जा सकती।",
  });

  assert.equal(result.body.clarificationRequired, true);
  assert.equal(result.body.followUpRequired, true);
  assert.equal(result.body.followUp.type, "travel_clarification");
  assert.equal(result.body.question.id, "A1_TRAVEL_CLARIFICATION");
});

test("Age: boundary ages follow the workbook rules", () => {
  assert.equal(evaluateAge("18").outcome, "pass");
  assert.equal(evaluateAge("38").outcome, "pass");
  assert.equal(evaluateAge("39").outcome, "manual_review");
  assert.equal(evaluateAge("40").outcome, "manual_review");
  assert.equal(evaluateAge("41").outcome, "reject");
});

test("Age: accepts valid DOB formats", () => {
  assert.equal(evaluateAge("15/08/2000").age, 26);
  assert.equal(evaluateAge("2000-08-15").age, 26);
});

test("Age: rejects invalid and impossible DOB inputs for clarification", () => {
  assert.equal(evaluateAge("31/02/2000").outcome, "clarification");
  assert.equal(evaluateAge("not a date").outcome, "clarification");
});



test("Interview: eligible age continues to the next question", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  if (result.body.followUpRequired) {
    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Nahi, main travel nahi kar sakti",
    });
  }

  assert.equal(result.body.question.id, "A2");

  result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "25",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.completed, false);
  assert.equal(result.body.eligibilityOutcome, "pass");
  assert.equal(result.body.question.id, "A3");
});

test("Interview: age 39 is saved for manual review", async () => {
  const started = await startAtConsent();

  await submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  if (result.body.followUpRequired) {
    result = await submitAnswer({
      sessionId: started.sessionId,
      answer: "Nahi, main travel nahi kar sakti",
    });
  }

  assert.equal(result.body.question.id, "A2");

  result = await submitAnswer({
    sessionId: started.sessionId,
    answer: "39",
  });

  const report = getReport(started.sessionId).body.report;

  assert.equal(result.body.eligibilityOutcome, "manual_review");
  assert.equal(result.body.manualReviewRequired, true);
  assert.equal(report.eligibilityOutcome, "manual_review");
});

test("Interview regression: exact sequence from A2_NAME through all screening questions into work experience (B1 -> B2)", async () => {
  const mappingFlow = workbookQuestionMapping.questionFlow;
  const started = startInterview();

  assert.equal(started.totalQuestions, 50);
  assert.equal(started.question.id, "A2_NAME");
  assert.equal(started.question.text, mappingFlow[0]["Bot says (primary)"]);
  assert.equal(started.question.category, mappingFlow[0].Block);

  const approvedAnswers = {
    A2_NAME: "Priya Sharma",
    A2_NAME_CONFIRM: "yes",
    A0: "Haan, main Hindi mein baat karungi",
    A1: "Koramangala, Bangalore",
    A1_TRAVEL_CLARIFICATION: "Haan, main 5 km travel kar sakti hoon",
    A1_MOVE_TIMELINE: "Ek mahine ke andar",
    A2: "15/08/1996",
    A3: "Ghar mein mere pati aur do bachche hain, pati private job karte hain",
    A4: "Bade bachche 4th class mein hain aur chhota 1st mein",
    A5: "Jab main kaam pe hoti hoon tab dadi unka dhyan rakhti hain",
    A6: "Agle ek saal mein aisi koi shaadi ya shifting ka plan nahi hai",
    A7: "Abhi main ek local salon mein kaam karti hoon, apna parlor nahi hai",
    A8: "Waxing, facial aur manicure-pedicure sab regular karti hoon",
    A9: "Main apni two-wheeler scooty se aati jaati hoon",
    A10: "Pooja Sharma, Koramangala 4th block, Rica waxing and cleanup",
    A11: "Namaste maam, main Urban Company se aayi hoon aapki service ke liye",
    A12: "Nahi, maine pehle kisi app-based service mein kaam nahi kiya",
    B1: "Pichli job mein 7-8 ghante khade rehkar kaam karti thi, mujhe koi dikkat nahi hoti",
    B2: "Maine 4 saal pehle beauty parlor course kiya tha aur tab se do salons mein kaam kiya hai",
  };

  const expectedProgression = [
    "A2_NAME",
    "A2_NAME_CONFIRM",
    "A0",
    "A1",
    "A1_TRAVEL_CLARIFICATION",
    "A1_MOVE_TIMELINE",
    "A2",
    "A3",
    "A4",
    "A5",
    "A6",
    "A7",
    "A8",
    "A9",
    "A10",
    "A11",
    "A12",
    "B1",
    "B2",
  ];

  let currentQuestion = started.question;
  const recordedSteps = [currentQuestion.id];

  for (let i = 0; i < expectedProgression.length - 1; i++) {
    const stepId = expectedProgression[i];
    const nextExpectedId = expectedProgression[i + 1];

    assert.equal(currentQuestion.id, stepId, `step index ${i}`);

    const result = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId: stepId,
      answer: approvedAnswers[stepId],
      diagnosticRequestId: `regression-${stepId}`,
    });

    assert.equal(result.status, 200, `submission status for ${stepId}`);
    assert.equal(result.body.completed, false, `session must not complete prematurely at ${stepId}`);
    assert.ok(result.body.question, `question must be returned after ${stepId}`);
    assert.equal(result.body.question.id, nextExpectedId, `advancement after ${stepId}`);

    currentQuestion = result.body.question;
    recordedSteps.push(currentQuestion.id);

    // Verify against workbook mapping for regular bank questions
    const mappedItem = mappingFlow.find((item) => item.Step === currentQuestion.id);
    if (mappedItem) {
      assert.equal(currentQuestion.text, mappedItem["Bot says (primary)"], `text match for ${currentQuestion.id}`);
      assert.equal(currentQuestion.category, mappedItem.Block, `block match for ${currentQuestion.id}`);
    }
  }

  assert.deepEqual(recordedSteps, expectedProgression);

  // Also verify that without children, A4 and A5 are skipped and sequence resumes at A6 -> ... -> B2
  const noKidsStarted = startInterview();
  const noKidsAnswers = {
    ...approvedAnswers,
    A1_TRAVEL_CLARIFICATION: "Nahi, main travel nahi kar sakti",
    A2: "25",
    A3: "Ghar mein sirf main aur mere pati hain, mere koi bachche nahi hain",
  };

  const expectedNoKidsProgression = [
    "A2_NAME",
    "A2_NAME_CONFIRM",
    "A0",
    "A1",
    "A1_TRAVEL_CLARIFICATION",
    "A2",
    "A3",
    "A6",
    "A7",
    "A8",
    "A9",
    "A10",
    "A11",
    "A12",
    "B1",
    "B2",
  ];

  let noKidsQuestion = noKidsStarted.question;
  const noKidsSteps = [noKidsQuestion.id];

  for (let i = 0; i < expectedNoKidsProgression.length - 1; i++) {
    const stepId = expectedNoKidsProgression[i];
    const nextExpectedId = expectedNoKidsProgression[i + 1];

    assert.equal(noKidsQuestion.id, stepId);

    const result = await submitAnswer({
      sessionId: noKidsStarted.sessionId,
      expectedQuestionId: stepId,
      answer: noKidsAnswers[stepId],
      diagnosticRequestId: `regression-nokids-${stepId}`,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.completed, false);
    assert.equal(result.body.question.id, nextExpectedId);

    noKidsQuestion = result.body.question;
    noKidsSteps.push(noKidsQuestion.id);
  }

  assert.deepEqual(noKidsSteps, expectedNoKidsProgression);
});

test("Interview regression: unclear answers, repeated transcripts, and answer retries cannot skip questions", async () => {
  const started = startInterview();
  assert.equal(started.question.id, "A2_NAME");

  // 1. Unclear name keeps A2_NAME
  let res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "pata nahi",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A2_NAME");

  // Valid name gives confirmation step, and yes advances to A0
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Priya",
  });
  assert.equal(res.body.question.id, "A2_NAME_CONFIRM");

  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });
  assert.equal(res.body.question.id, "A0");

  // 2. Repeated transcript / stale question ID A2_NAME returns 409 and holds on A0
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Priya",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.staleQuestion, true);
  assert.equal(res.body.question.id, "A0");

  // 3. Unclear consent keeps A0
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "shayad",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A0");

  // Valid consent advances to A1
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Haan, Hindi mein",
  });
  assert.equal(res.body.question.id, "A1");

  // 4. Stale question ID A0 returns 409 and holds on A1
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Haan dobara",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.staleQuestion, true);
  assert.equal(res.body.question.id, "A1");

  // Location answer triggers travel clarification
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Delhi",
  });
  assert.equal(res.body.question.id, "A1_TRAVEL_CLARIFICATION");

  // 5. Ambiguous travel keeps A1_TRAVEL_CLARIFICATION
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "Haan, lekin travel nahi kar sakti",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A1_TRAVEL_CLARIFICATION");

  // Willing travel triggers move timeline
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "Haan, main travel kar sakti hoon",
  });
  assert.equal(res.body.question.id, "A1_MOVE_TIMELINE");

  // 6. Unclear timeline keeps A1_MOVE_TIMELINE
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_MOVE_TIMELINE",
    answer: "maybe",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A1_MOVE_TIMELINE");

  // Clear timeline advances to A2
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_MOVE_TIMELINE",
    answer: "Ek mahine mein",
  });
  assert.equal(res.body.question.id, "A2");

  // 7. Unclear DOB keeps A2
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "kal",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A2");

  // Clear age advances to A3
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "25",
  });
  assert.equal(res.body.question.id, "A3");

  // 8. Ambiguous child presence on A3 keeps A3 pending
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A3",
    answer: "Ghar mein sab log rehte hain",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A3");

  // Clarify children presence -> advances to A4
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A3",
    answer: "Haan mere do bachche hain",
  });
  assert.equal(res.body.question.id, "A4");

  // Answer A4 -> A5
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A4",
    answer: "4th class mein hain",
  });
  assert.equal(res.body.question.id, "A5");

  // Answer A5 -> A6
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A5",
    answer: "Dadi dekhti hain",
  });
  assert.equal(res.body.question.id, "A6");

  // 9. Interpretation failure on A6 retains A6 and asks for retry without advancing
  const failingInterpretation = async () => {
    const error = new Error("Resource has been exhausted (e.g. check quota)");
    error.status = 429;
    throw error;
  };

  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A6",
    answer: "Koi plan nahi hai",
  }, { interpretAnswerImpl: failingInterpretation });

  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.interpretationUnavailable, true);
  assert.equal(res.body.code, "AI_RATE_LIMIT");
  assert.equal(res.body.question.id, "A6");

  // Retry with successful interpretation resolves retry state and advances exactly one step to A7
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A6",
    answer: "Agle ek saal mein ghar mein koi badi cheez plan nahi ho rahi hai",
  });
  assert.equal(Boolean(res.body.clarificationRequired), false);
  assert.equal(res.body.question.id, "A7");
});

test("Pause and Resume: preserves current state, rejects answers while paused, and resumes safely", async () => {
  const {
    pauseInterview,
    resumeInterview,
    getActiveSessionForCandidate,
  } = require("./interview");

  const started = startInterview({ candidateId: "candidate-pause-test" });
  assert.equal(started.question.id, "A2_NAME");

  // Answer name
  let res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Anjali Gupta",
  });
  assert.equal(res.body.question.id, "A2_NAME_CONFIRM");
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });
  assert.equal(res.body.question.id, "A0");

  // Pause interview
  const pauseRes = pauseInterview(started.sessionId);
  assert.equal(pauseRes.status, 200);
  assert.equal(pauseRes.body.sessionStatus, "paused");
  assert.equal(pauseRes.body.question.id, "A0");
  assert.equal(pauseRes.body.candidateName, "Anjali Gupta");

  // Trying to submit an answer while paused is rejected
  const answerWhilePaused = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Haan, main agree karti hoon",
  });
  assert.equal(answerWhilePaused.status, 409);
  assert.equal(answerWhilePaused.body.code, "INTERVIEW_PAUSED");

  // Check active session retrieval
  const activeSession = getActiveSessionForCandidate("candidate-pause-test");
  assert.ok(activeSession);
  assert.equal(activeSession.sessionId, started.sessionId);
  assert.equal(activeSession.status, "paused");
  assert.equal(activeSession.question.id, "A0");

  // Resume interview
  const resumeRes = resumeInterview(started.sessionId);
  assert.equal(resumeRes.status, 200);
  assert.equal(resumeRes.body.sessionStatus, "in_progress");
  assert.equal(resumeRes.body.isResumed, true);
  assert.equal(resumeRes.body.question.id, "A0");

  // Now submit answer after resume succeeds
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Haan, main agree karti hoon",
  });
  assert.equal(res.body.question.id, "A1");

  // End interview after pause transitions to incomplete cleanly
  const pauseAgain = pauseInterview(started.sessionId);
  assert.equal(pauseAgain.status, 200);
  const endRes = endInterview(started.sessionId);
  assert.equal(endRes.body.sessionStatus, "incomplete");

  // Cannot resume ended interview
  const resumeEnded = resumeInterview(started.sessionId);
  assert.equal(resumeEnded.status, 400);
});

test("Sanity Check: rejects gibberish names like 'habba jabba' and accepts valid names", async () => {
  const started = startInterview();
  assert.equal(started.question.id, "A2_NAME");

  // 'habba jabba' must trigger clarification
  let res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "habba jabba",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A2_NAME");

  // Keyboard mash must trigger clarification
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "asdf qwerty",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A2_NAME");

  // Real name is accepted and verified
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita Verma",
  });
  assert.equal(res.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(res.body.candidateName, "Sunita Verma");
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });
  assert.equal(res.body.question.id, "A0");
});

test("Sanity Check: rejects irrelevant answers on location question A1", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Meena",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Haan agree karti hoon",
  });

  // Irrelevant food answer on location question
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Mujhe biryani pasand hai",
  });
  assert.equal(res.body.clarificationRequired, true);
  assert.equal(res.body.question.id, "A1");
  assert.match(res.body.message, /area/i);
});

test("Sanity Check: evaluates contextual short answers appropriately", () => {
  // In confirmation questions, 'haan' or 'yes' is sufficient
  const confirmResult = fallbackInterpretation({
    question: "Kya aap pedicure kar leti hain?",
    answer: "Haan",
  });
  assert.equal(confirmResult.answerStatus, "sufficient");
  assert.equal(confirmResult.needsClarification, false);

  // In confirmation questions, 'no' is sufficient
  const negativeResult = fallbackInterpretation({
    question: "Kya aap bikini wax karti hain?",
    answer: "Nahi",
  });
  assert.equal(negativeResult.answerStatus, "sufficient");
  assert.equal(negativeResult.needsClarification, false);

  // In open-ended household question, 'yes' alone is unclear
  const openResult = fallbackInterpretation({
    question: householdQuestion,
    answer: "Haan",
  });
  assert.equal(openResult.needsClarification, true);

  // Uncertainty 'not sure' needs clarification
  const uncertainResult = fallbackInterpretation({
    question: "Aap kab tak join kar sakti hain?",
    answer: "Not sure",
  });
  assert.equal(uncertainResult.needsClarification, true);
  assert.equal(uncertainResult.answerStatus, "unclear");
});

test("Contextual Follow-up: asks relevant probe when candidate is uncertain and captures follow-up", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Kavita",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Ji haan",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Koramangala, travel nahi kar sakti",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "26",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A3",
    answer: "Ghar mein pati aur 1 bachcha hai",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A4",
    answer: "4 saal ka hai",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A5",
    answer: "Dadi sambhalti hain",
  });

  // Now on A6 (pregnancy/baby plan), candidate expresses uncertainty: "not sure"
  const uncertainInterpretation = async () => ({
    understanding: "Candidate expressed uncertainty about their future plans.",
    answerStatus: "unclear",
    needsClarification: true,
    clarificationQuestion: "Agar abhi aap expecting hain to bata dijiye.",
  });

  const followUpRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A6",
    answer: "Shayad, abhi confirm nahi hai",
  }, { interpretAnswerImpl: uncertainInterpretation });

  // A contextual follow-up probe is returned
  assert.equal(followUpRes.body.followUpRequired, true);
  assert.equal(followUpRes.body.question.id, "A6_FOLLOW_UP");

  // Answering the follow-up clarifies and advances to next question A7
  const answerFollowUpRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A6_FOLLOW_UP",
    answer: "Abhi koi pregnancy plan nahi hai, bilkul ready hoon",
  });

  assert.equal(answerFollowUpRes.body.question.id, "A7");
  assert.equal(answerFollowUpRes.body.followUpCaptured, true);

  // Check that the follow-up is saved in the report
  const report = getReport(started.sessionId);
  const followUpInReport = report.body.report.answers.find(
    (a) => a.questionId === "A6_FOLLOW_UP",
  );
  assert.ok(followUpInReport);
  assert.equal(followUpInReport.isFollowUp, true);
  assert.equal(followUpInReport.answer, "Abhi koi pregnancy plan nahi hai, bilkul ready hoon");
});

test("Sanity Check: name question rejects repeated characters, single letters, and extracts introduced names", () => {
  // Rejection of gibberish and invalid shapes
  assert.equal(classifyNameAnswer("aaaa").clear, false);
  assert.equal(classifyNameAnswer("zzzzz").clear, false);
  assert.equal(classifyNameAnswer("a").clear, false);
  assert.equal(classifyNameAnswer("").clear, false);
  assert.equal(classifyNameAnswer("habba jabba").clear, false);
  assert.equal(classifyNameAnswer("asdf qwerty").clear, false);
  assert.equal(classifyNameAnswer("biryani").clear, false);
  assert.equal(classifyNameAnswer("chair").clear, false);

  // Correct extraction of introduced names without trailing 'hai'
  const priyaIntro = classifyNameAnswer("Mera naam Priya hai");
  assert.equal(priyaIntro.clear, true);
  assert.equal(priyaIntro.name, "Priya");

  const sunitaIntro = classifyNameAnswer("Mera naam Sunita");
  assert.equal(sunitaIntro.clear, true);
  assert.equal(sunitaIntro.name, "Sunita");

  const anjaliIntro = classifyNameAnswer("mera naam Anjali Verma hai");
  assert.equal(anjaliIntro.clear, true);
  assert.equal(anjaliIntro.name, "Anjali Verma");

  // Legitimate short or unfamiliar Indian names are accepted
  for (const name of ["Om", "Anu", "Ali", "Uma", "Diya", "Pooja", "Tenzin", "Zoya", "Ira"]) {
    const res = classifyNameAnswer(name);
    assert.equal(res.clear, true, `Name '${name}' should be accepted`);
    assert.equal(res.name, name);
  }
});

test("Sanity Check: location question rejects random objects, repeated chars, and vehicle-only responses", () => {
  // Irrelevant food and random objects
  for (const invalid of [
    "chair", "table", "mobile", "laptop", "pen", "bottle",
    "biryani", "pizza", "aaaa", "x", "car", "bike",
  ]) {
    const res = classifyLocation(invalid);
    assert.equal(res.outcome, "clarification", `Location '${invalid}' should require clarification`);
    assert.equal(res.area, null);
    assert.match(res.message, /area/i);
  }

  // Valid areas are accepted
  const whitefield = classifyLocation("Whitefield");
  assert.equal(whitefield.outcome, "manual_review");
  assert.equal(whitefield.area, "Whitefield");

  const koramangala = classifyLocation("Koramangala, Bangalore");
  assert.equal(koramangala.outcome, "manual_review");
  assert.equal(koramangala.area, "Koramangala, Bangalore");

  const willing = classifyLocation("Bellandur, main travel kar sakti hoon");
  assert.equal(willing.travelWillingness, "yes");
  assert.equal(willing.followUp, "move_timeline");

  const unwilling = classifyLocation("Indiranagar, travel nahi kar sakti");
  assert.equal(unwilling.travelWillingness, "no");
});

test("Sanity Check: age question accepts Romanized Hindi and rejects ambiguous/nonsense values", () => {
  // Romanized Hindi forms
  assert.equal(evaluateAge("25 saal").age, 25);
  assert.equal(evaluateAge("25 saal").outcome, "pass");
  assert.equal(evaluateAge("28 sal").age, 28);
  assert.equal(evaluateAge("meri age 28 hai").age, 28);
  assert.equal(evaluateAge("meri umar 28 saal hai").age, 28);
  assert.equal(evaluateAge("28 saal ki hoon").age, 28);
  assert.equal(evaluateAge("meri age hai 25").age, 25);
  assert.equal(evaluateAge("umar 30 hai").age, 30);

  // Ambiguous, nonsense, and invalid inputs
  assert.equal(evaluateAge("twenty or thirty").outcome, "clarification");
  assert.equal(evaluateAge("shayad 25 ya 26").outcome, "clarification");
  assert.equal(evaluateAge("25 or 26").outcome, "clarification");
  assert.equal(evaluateAge("kal").outcome, "clarification");
  assert.equal(evaluateAge("chair").outcome, "clarification");
  assert.equal(evaluateAge("").outcome, "clarification");
});

test("Sanity Check: open-ended experience, scenarios, and routines reject bare haan/yes", () => {
  // Open-ended scenario questions (C1, C6) must reject bare haan
  const c6Result = fallbackInterpretation({
    question: "Customer app ke bahar discount maang rahi hai. Kya karengi?",
    answer: "haan",
  });
  assert.equal(c6Result.needsClarification, true);
  assert.equal(c6Result.answerStatus, "unclear");

  const c1Result = fallbackInterpretation({
    question: "Facial mask ke time acne wali customer kehti hai jalan ho rahi hai. Aap kya karengi?",
    answer: "yes",
  });
  assert.equal(c1Result.needsClarification, true);
  assert.equal(c1Result.answerStatus, "unclear");

  // Technical questions (K2, K7) must reject bare haan
  const k7Result = fallbackInterpretation({
    question: "Pedicure ke baad tools aur baaki saamaan ka kya karti hain?",
    answer: "haan",
  });
  assert.equal(k7Result.needsClarification, true);
  assert.equal(k7Result.answerStatus, "unclear");

  const k2Result = fallbackInterpretation({
    question: "Rica jaise lipo wax aur normal honey wax mein kya farak hota hai?",
    answer: "yes",
  });
  assert.equal(k2Result.needsClarification, true);
  assert.equal(k2Result.answerStatus, "unclear");

  // Experience and routine questions (B2, B13) must reject bare haan
  const b2Result = fallbackInterpretation({
    question: "Aapka beauty ka safar kaise shuru hua? Kahan kahan kaam kiya hai?",
    answer: "haan",
  });
  assert.equal(b2Result.needsClarification, true);
  assert.equal(b2Result.answerStatus, "unclear");

  const b13Result = fallbackInterpretation({
    question: "Aapka weekend ka routine kya hota hai — Saturday-Sunday aap kya karti hain?",
    answer: "haan",
  });
  assert.equal(b13Result.needsClarification, true);
  assert.equal(b13Result.answerStatus, "unclear");

  // Confirmation questions MUST remain valid with bare short answers
  const a12Result = fallbackInterpretation({
    question: "Kya kabhi pehle UC, Yes Madam ya kisi aur app ke through kaam kiya hai?",
    answer: "Haan",
  });
  assert.equal(a12Result.needsClarification, false);
  assert.equal(a12Result.answerStatus, "sufficient");

  const b15Result = fallbackInterpretation({
    question: "Kya aap poori training attend kar sakti hain?",
    answer: "Nahi",
  });
  assert.equal(b15Result.needsClarification, false);
  assert.equal(b15Result.answerStatus, "sufficient");

  const b19Result = fallbackInterpretation({
    question: "Kya aapka PAN, Aadhaar se linked hai aur dono mein naam same hai?",
    answer: "Haan",
  });
  assert.equal(b19Result.needsClarification, false);
  assert.equal(b19Result.answerStatus, "sufficient");
});

test("Natural Travel Flow: handles multi-turn travel uncertainty, cross-questions, options, and candidate agreement", async () => {
  const started = startInterview();

  // Answer name, consent, and give location without explicit travel willingness
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });

  const locRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Koramangala",
  });
  assert.equal(locRes.body.followUpRequired, true);
  assert.equal(locRes.body.question.id, "A1_TRAVEL_CLARIFICATION");

  // 1. Candidate expresses reluctance / uncertainty: "I'm not sure. That might be difficult."
  const reluctantRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "I'm not sure. That might be difficult.",
  });
  assert.equal(reluctantRes.body.clarificationRequired, true);
  assert.equal(reluctantRes.body.followUpRequired, true);
  assert.equal(reluctantRes.body.question.id, "A1_TRAVEL_CLARIFICATION");
  // Bot naturally acknowledges concern and asks about conveyance vs timing
  assert.match(reluctantRes.body.message, /Main samajh sakti hoon/i);
  assert.match(reluctantRes.body.message, /conveyance/i);

  // 2. Candidate asks a cross-question: "Travel karna kyun zaruri hai?"
  const crossQRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "Travel karna kyun zaruri hai?",
  });
  assert.equal(crossQRes.body.clarificationRequired, true);
  assert.equal(crossQRes.body.followUpRequired, true);
  assert.equal(crossQRes.body.question.id, "A1_TRAVEL_CLARIFICATION");
  // Bot explains verified salon-at-home cluster reason and explores practical options
  assert.match(crossQRes.body.message, /salon-at-home/i);
  assert.match(crossQRes.body.message, /3-4 km cluster/i);

  // 3. Candidate changes mind and agrees: "Haan, main auto ya bus se manage kar lungi"
  const agreedRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "Haan, main auto ya bus se manage kar lungi",
  });
  // Moves to move timeline
  assert.equal(agreedRes.body.followUpRequired, true);
  assert.equal(agreedRes.body.question.id, "A1_MOVE_TIMELINE");

  // 4. Candidate provides move timeline
  const timelineRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_MOVE_TIMELINE",
    answer: "15 din mein",
  });
  assert.equal(timelineRes.body.question.id, "A2");

  // Check report records travelWillingness: "yes" and preserves follow-up records
  const report = getReport(started.sessionId).body.report;
  assert.equal(report.travelWillingness, "yes");
  const followUpAnswers = report.answers.filter((a) => a.questionId.startsWith("A1_"));
  assert.ok(followUpAnswers.length >= 2, "Follow-up answers must be preserved in report");
});

test("Natural Travel Flow: handles candidate declining after travel probe without infinite loop", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Kavita" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });

  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Bellandur",
  });

  // Candidate is reluctant
  const relRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "Shayad mushkil hoga",
  });
  assert.match(relRes.body.message, /Main samajh sakti hoon/i);

  // Candidate confirms refusal
  const declineRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "Nahi, main travel nahi kar sakti",
  });
  assert.equal(declineRes.body.question.id, "A2");
  assert.equal(declineRes.body.travelWillingness, "no");
  assert.equal(declineRes.body.manualReviewRequired, true);
});

test("Natural Travel Flow: handles persistent uncertainty after probe without blocking", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Rekha" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });

  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "HSR Layout",
  });

  // Turn 1: reluctant
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "I am not sure",
  });

  // Turn 2: still uncertain after probe
  const uncertainRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "Abhi kuch nahi keh sakti, pakka nahi pata",
  });

  // Accurately records uncertain, flags for manual review, and advances to A2
  assert.equal(uncertainRes.body.question.id, "A2");
  assert.equal(uncertainRes.body.travelWillingness, "uncertain");
  assert.equal(uncertainRes.body.manualReviewRequired, true);

  const report = getReport(started.sessionId).body.report;
  assert.equal(report.travelWillingness, "uncertain");
  assert.equal(report.manualReviewRequired, true);
});

test("Natural Travel Flow on A9: handles conveyance concern, cross-questions, and husband dependence", async () => {
  // Test conveyance concern on A9
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Geeta" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Whitefield, travel kar sakti hoon" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_MOVE_TIMELINE", answer: "1 mahine mein" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "26" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Ghar mein main aur pati hain, koi bachche nahi hain" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Koi plan nahi hai" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A7", answer: "Local parlor mein kaam karti hoon" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A8", answer: "Waxing aur facial" });

  // Now on A9 (travel mode): candidate expresses conveyance issue
  const a9Res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A9",
    answer: "Mere paas scooty nahi hai",
  });
  assert.equal(a9Res.body.followUpRequired, true);
  assert.equal(a9Res.body.question.id, "A9_FOLLOW_UP");
  assert.match(a9Res.body.message, /3-4 km cluster/i);

  // Candidate agrees to travel by bus/auto on follow-up
  const followUpRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A9_FOLLOW_UP",
    answer: "Haan, main bus ya auto se travel kar lungi",
  });
  assert.equal(followUpRes.body.question.id, "A10");
  assert.equal(followUpRes.body.followUpCaptured, true);

  // Check report retains follow-up answer linked to A9
  const report = getReport(started.sessionId).body.report;
  const a9FollowUp = report.answers.find((a) => a.questionId === "A9_FOLLOW_UP");
  assert.ok(a9FollowUp);
  assert.equal(a9FollowUp.parentQuestionId, "A9");
  assert.equal(a9FollowUp.isFollowUp, true);
});

test("2-Warning Policy: A2_NAME gives 2 warnings and terminates on 3rd invalid attempt", async () => {
  const started = startInterview();

  // Attempt 1: repeat question naturally
  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "habba jabba",
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.body.clarificationRequired, true);
  assert.equal(res1.body.warningLevel, 1);
  assert.equal(res1.body.question.id, "A2_NAME");
  assert.match(res1.body.message, /naam/i);
  assert.ok(res1.body.message.includes("Namaste ji, sabse pehle aap apna naam bataiye."));
  assert.equal(res1.body.repeatedQuestionText, "Namaste ji, sabse pehle aap apna naam bataiye.");

  // Attempt 2: clear warning that 1 final attempt remains
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "asdf qwerty",
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.clarificationRequired, true);
  assert.equal(res2.body.warningLevel, 2);
  assert.equal(res2.body.warning, true);
  assert.match(res2.body.message, /aakhri attempt/i);
  assert.ok(res2.body.message.includes("Namaste ji, sabse pehle aap apna naam bataiye."));
  assert.equal(res2.body.repeatedQuestionText, "Namaste ji, sabse pehle aap apna naam bataiye.");

  // Attempt 3: graceful termination
  const res3 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "aaaa",
  });
  assert.equal(res3.status, 200);
  assert.equal(res3.body.completed, true);
  assert.equal(res3.body.terminated, true);
  assert.equal(res3.body.sessionStatus, "terminated");
  assert.equal(res3.body.terminationReason, "repeated_invalid_answers");
  assert.equal(res3.body.terminatedAtQuestionId, "A2_NAME");
  assert.match(res3.body.message, /Teen baar koshish/i);

  // Subsequent answer submission is rejected with HTTP 409
  const res4 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Priya",
  });
  assert.equal(res4.status, 409);
  assert.equal(res4.body.code, "INTERVIEW_TERMINATED");

  const report = getReport(started.sessionId).body.report;
  assert.equal(report.status, "terminated");
  assert.equal(report.terminationReason, "repeated_invalid_answers");
  assert.equal(report.terminatedAtQuestionId, "A2_NAME");
  assert.equal(report.manualReviewRequired, false);
});

test("2-Warning Policy: Location A1 gives 2 warnings and terminates on 3rd invalid attempt", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Sunita" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan agree karti hoon" });

  // Attempt 1 on A1
  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "biryani",
  });
  assert.equal(res1.body.clarificationRequired, true);
  assert.equal(res1.body.warningLevel, 1);
  assert.equal(res1.body.question.id, "A1");
  assert.ok(res1.body.message.includes("Aap Bangalore mein kis area mein rehti hain? Roz aas-paas kin areas mein aana-jaana hota hai?"));
  assert.equal(res1.body.repeatedQuestionText, "Aap Bangalore mein kis area mein rehti hain? Roz aas-paas kin areas mein aana-jaana hota hai?");

  // Attempt 2 on A1
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "pizza",
  });
  assert.equal(res2.body.clarificationRequired, true);
  assert.equal(res2.body.warningLevel, 2);
  assert.equal(res2.body.warning, true);
  assert.match(res2.body.message, /aakhri attempt/i);
  assert.ok(res2.body.message.includes("Aap Bangalore mein kis area mein rehti hain? Roz aas-paas kin areas mein aana-jaana hota hai?"));
  assert.equal(res2.body.repeatedQuestionText, "Aap Bangalore mein kis area mein rehti hain? Roz aas-paas kin areas mein aana-jaana hota hai?");

  // Attempt 3 on A1
  const res3 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "chair",
  });
  assert.equal(res3.body.completed, true);
  assert.equal(res3.body.terminated, true);
  assert.equal(res3.body.sessionStatus, "terminated");
  assert.equal(res3.body.terminationReason, "repeated_invalid_answers");
  assert.equal(res3.body.terminatedAtQuestionId, "A1");

  const report = getReport(started.sessionId).body.report;
  assert.equal(report.status, "terminated");
  assert.equal(report.terminatedAtQuestionId, "A1");
});

test("2-Warning Policy: Age A2 gives 2 warnings and terminates on 3rd invalid attempt", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi, travel kar sakti hoon" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_MOVE_TIMELINE", answer: "1 mahine mein" });

  // Attempt 1 on A2
  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "chair",
  });
  assert.equal(res1.body.clarificationRequired, true);
  assert.equal(res1.body.warningLevel, 1);
  assert.equal(res1.body.question.id, "A2");
  assert.ok(res1.body.message.includes("Aadhaar card pe aapki date of birth kya likhi hai?"));
  assert.equal(res1.body.repeatedQuestionText, "Aadhaar card pe aapki date of birth kya likhi hai?");

  // Attempt 2 on A2
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "kal",
  });
  assert.equal(res2.body.clarificationRequired, true);
  assert.equal(res2.body.warningLevel, 2);
  assert.equal(res2.body.warning, true);
  assert.equal(res2.body.question.id, "A2");
  assert.ok(res2.body.message.includes("Aadhaar card pe aapki date of birth kya likhi hai?"));
  assert.equal(res2.body.repeatedQuestionText, "Aadhaar card pe aapki date of birth kya likhi hai?");

  // Attempt 3 on A2
  const res3 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "asdf",
  });
  assert.equal(res3.body.completed, true);
  assert.equal(res3.body.terminated, true);
  assert.equal(res3.body.sessionStatus, "terminated");
  assert.equal(res3.body.terminationReason, "repeated_invalid_answers");
  assert.equal(res3.body.terminatedAtQuestionId, "A2");
});

test("2-Warning Policy: Open-ended question gives 2 warnings and terminates on 3rd invalid attempt", async () => {
  const started = startInterview();
  const mockSufficient = async () => ({
    understanding: "Clear answer",
    answerStatus: "sufficient",
    needsClarification: false,
    clarificationQuestion: "",
  });
  const mockIrrelevant = async () => ({
    understanding: "Irrelevant response",
    answerStatus: "irrelevant",
    needsClarification: true,
    clarificationQuestion: "Could you please explain your work experience directly?",
  });

  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Ritu" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Noida, travel kar sakti hoon" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_MOVE_TIMELINE", answer: "immediate" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "27" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Shaadi ho gayi hai, bacche nahi hain" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Koi plan nahi hai" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A7", answer: "Local salon mein" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A8", answer: "Facial and waxing" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A9", answer: "Scooty se travel kar lungi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A10", answer: "9 baje" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A11", answer: "Haan koi dikkat nahi hai" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A12", answer: "Haan theek hai" }, { interpretAnswerImpl: mockSufficient });

  // Now on B1 (open-ended experience): candidate gives bare "haan" or irrelevant answer
  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "B1",
    answer: "haan",
  }, { interpretAnswerImpl: mockIrrelevant });
  assert.equal(res1.body.clarificationRequired, true);
  assert.equal(res1.body.warningLevel, 1);

  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "B1",
    answer: "biryani",
  }, { interpretAnswerImpl: mockIrrelevant });
  assert.equal(res2.body.clarificationRequired, true);
  assert.equal(res2.body.warningLevel, 2);
  assert.equal(res2.body.warning, true);

  const res3 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "B1",
    answer: "asdf qwerty",
  }, { interpretAnswerImpl: mockIrrelevant });
  assert.equal(res3.body.completed, true);
  assert.equal(res3.body.terminated, true);
  assert.equal(res3.body.sessionStatus, "terminated");
  assert.equal(res3.body.terminatedAtQuestionId, "B1");
});

test("2-Warning Policy: Valid answer on attempt 2 or 3 resets counter and advances", async () => {
  const started = startInterview();

  // Attempt 1: invalid
  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "habba jabba",
  });
  assert.equal(res1.body.warningLevel, 1);

  // Attempt 2: valid name -> succeeds and moves to confirmation
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Anjali",
  });
  assert.equal(res2.status, 200);
  assert.equal(Boolean(res2.body.clarificationRequired), false);
  assert.equal(res2.body.question.id, "A2_NAME_CONFIRM");

  const resConfirm = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });
  assert.equal(resConfirm.status, 200);
  assert.equal(resConfirm.body.question.id, "A0");

  // On A0: attempt 1 invalid
  const res3 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "biryani",
  });
  // Counter on A0 started fresh at 1!
  assert.equal(res3.body.warningLevel, 1);
  assert.ok(res3.body.message.includes("Namaste! Main UC ki screening assistant hoon."));
  assert.equal(
    res3.body.repeatedQuestionText,
    "Namaste! Main UC ki screening assistant hoon. Ye baat-cheet sirf screening ke liye record hogi. Shuru karein? Aap Hindi mein baat karengi ya English mein?",
  );

  // Attempt 2 on A0: invalid
  const res4 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "pizza",
  });
  assert.equal(res4.body.warningLevel, 2);
  assert.ok(res4.body.message.includes("Namaste! Main UC ki screening assistant hoon."));
  assert.equal(
    res4.body.repeatedQuestionText,
    "Namaste! Main UC ki screening assistant hoon. Ye baat-cheet sirf screening ke liye record hogi. Shuru karein? Aap Hindi mein baat karengi ya English mein?",
  );

  // Attempt 3 on A0: valid consent -> succeeds and advances to A1
  const res5 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Haan, main Hindi mein baat karungi",
  });
  assert.equal(res5.status, 200);
  assert.equal(res5.body.question.id, "A1");
});

test("2-Warning Policy: Technical AI rate limit failure does not penalize candidate or increment invalid attempts", async () => {
  const started = startInterview();
  const mockSufficient = async () => ({
    understanding: "Clear answer",
    answerStatus: "sufficient",
    needsClarification: false,
    clarificationQuestion: "",
  });

  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Anita" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi, travel kar sakti hoon" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_MOVE_TIMELINE", answer: "15 din" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "29" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Shaadi nahi hui, koi bachche nahi hain" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "No" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A7", answer: "Salon" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A8", answer: "Threading" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A9", answer: "Yes, scooty" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A10", answer: "9 AM" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A11", answer: "Yes" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A12", answer: "Yes" }, { interpretAnswerImpl: mockSufficient });

  // Rate limit failure on B1
  const mockRateLimit = async () => {
    const err = new Error("Rate limit exceeded");
    err.code = "AI_RATE_LIMIT";
    throw err;
  };

  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "B1",
    answer: "5 saal ka parlor experience hai",
  }, { interpretAnswerImpl: mockRateLimit });

  assert.equal(res1.body.interpretationUnavailable, true);
  assert.equal(res1.body.code, "AI_RATE_LIMIT");

  // Subsequent answer retry succeeds with normal interpretation
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "B1",
    answer: "Maine 5 saal parlor mein facial aur waxing ka kaam kiya hai",
  }, { interpretAnswerImpl: mockSufficient });
  assert.equal(res2.status, 200);
  assert.equal(Boolean(res2.body.interpretationUnavailable), false);
});

test("2-Warning Policy: A9 invalid answer repeats the complete authorized question text", async () => {
  const started = startInterview();
  const mockSufficient = async () => ({
    understanding: "Clear answer",
    answerStatus: "sufficient",
    needsClarification: false,
    clarificationQuestion: "",
  });

  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Rekha" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi, travel kar sakti hoon" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_MOVE_TIMELINE", answer: "15 din" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "30" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Shaadi nahi hui, koi bachche nahi hain" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "No" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A7", answer: "Salon" }, { interpretAnswerImpl: mockSufficient });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A8", answer: "Threading" }, { interpretAnswerImpl: mockSufficient });

  // Now at A9: test attempt 1 invalid
  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A9",
    answer: "biryani",
  });
  assert.equal(res1.body.clarificationRequired, true);
  assert.equal(res1.body.warningLevel, 1);
  assert.equal(res1.body.question.id, "A9");
  assert.ok(res1.body.message.includes("Abhi aap kaam pe ya market kaise jaati hain?"));
  assert.equal(res1.body.repeatedQuestionText, "Abhi aap kaam pe ya market kaise jaati hain?");

  // Attempt 2 invalid on A9
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A9",
    answer: "pizza",
  });
  assert.equal(res2.body.clarificationRequired, true);
  assert.equal(res2.body.warningLevel, 2);
  assert.equal(res2.body.warning, true);
  assert.equal(res2.body.question.id, "A9");
  assert.ok(res2.body.message.includes("Abhi aap kaam pe ya market kaise jaati hain?"));
  assert.equal(res2.body.repeatedQuestionText, "Abhi aap kaam pe ya market kaise jaati hain?");
});

test("Regression: 'Hindi' is accepted for language selection A0 and interview continues", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Kavita" });

  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Hindi",
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.completed, false);
  assert.equal(Boolean(res.body.terminated), false);
  assert.equal(Boolean(res.body.clarificationRequired), false);
  assert.equal(res.body.consentOutcome, "accepted");
  assert.equal(res.body.language, "Hindi");
  assert.equal(res.body.question.id, "A1");

  const report = getReport(started.sessionId).body.report;
  assert.equal(report.language, "Hindi");
  assert.equal(report.consentOutcome, "accepted");
  assert.equal(report.status, "in_progress");
});

test("Regression: 'English' is accepted for language selection A0 and interview continues", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Neha" });

  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "English",
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.completed, false);
  assert.equal(Boolean(res.body.terminated), false);
  assert.equal(Boolean(res.body.clarificationRequired), false);
  assert.equal(res.body.consentOutcome, "accepted");
  assert.equal(res.body.language, "English");
  assert.equal(res.body.question.id, "A1");

  const report = getReport(started.sessionId).body.report;
  assert.equal(report.language, "English");
});

test("Regression: Language variations ('Hindi mein baat karungi', 'English please', Devanagari, 'Both') are accepted", async () => {
  const variations = [
    { answer: "Hindi mein baat karungi", expectedLang: "Hindi" },
    { answer: "Mujhe Hindi mein baat karni hai", expectedLang: "Hindi" },
    { answer: "हिंदी में बात करेंगे", expectedLang: "Hindi" },
    { answer: "English please", expectedLang: "English" },
    { answer: "अंग्रेज़ी", expectedLang: "English" },
    { answer: "Hinglish", expectedLang: "Hinglish" },
    { answer: "Both are fine", expectedLang: "Hinglish" },
    { answer: "Dono chalega", expectedLang: "Hinglish" },
  ];

  for (const { answer, expectedLang } of variations) {
    const started = startInterview();
    await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });

    const res = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId: "A0",
      answer,
    });

    assert.equal(res.status, 200, `Answer '${answer}' must return 200`);
    assert.equal(res.body.completed, false, `Answer '${answer}' must not terminate`);
    assert.equal(res.body.consentOutcome, "accepted", `Answer '${answer}' must accept consent`);
    assert.equal(res.body.language, expectedLang, `Answer '${answer}' must detect language '${expectedLang}'`);
    assert.equal(res.body.question.id, "A1");
  }
});

test("Regression: Invalid attempt on A2_NAME does not leak or cause termination on A0", async () => {
  const started = startInterview();

  // Attempt 1 on A2_NAME: invalid
  const resName1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "habba jabba",
  });
  assert.equal(resName1.body.warningLevel, 1);

  // Attempt 2 on A2_NAME: valid name
  const resName2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Aarti",
  });
  assert.equal(resName2.body.question.id, "A2_NAME_CONFIRM");
  const resConfirm = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });
  assert.equal(resConfirm.body.question.id, "A0");

  // On A0: candidate says "Hindi" on first attempt
  const resA0 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Hindi",
  });

  // Must succeed immediately with no warning and no termination
  assert.equal(resA0.status, 200);
  assert.equal(resA0.body.completed, false);
  assert.equal(Boolean(resA0.body.warningLevel), false);
  assert.equal(Boolean(resA0.body.terminated), false);
  assert.equal(resA0.body.question.id, "A1");
  assert.equal(resA0.body.language, "Hindi");
});

test("Regression: Invalid-attempt counter resets on question transition", async () => {
  const started = startInterview();

  // Attempt 1 on A2_NAME: invalid
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "asdf" });
  // Attempt 2 on A2_NAME: valid
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Meena" });

  // On A0: Attempt 1 invalid ("biryani")
  const res1 = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "biryani" });
  assert.equal(res1.body.warningLevel, 1, "Counter on A0 must start fresh at 1, not 2");

  // On A0: Attempt 2 invalid ("pizza")
  const res2 = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "pizza" });
  assert.equal(res2.body.warningLevel, 2);

  // On A0: Attempt 3 valid ("Hindi") -> prevents termination and advances
  const res3 = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  assert.equal(res3.body.completed, false);
  assert.equal(Boolean(res3.body.terminated), false);
  assert.equal(res3.body.question.id, "A1");
  assert.equal(res3.body.language, "Hindi");

  // On A1: Attempt 1 invalid ("chair") -> starts fresh at warningLevel 1
  const resA1 = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "chair" });
  assert.equal(resA1.body.warningLevel, 1, "Counter on A1 must start fresh at 1");
});

test("Regression: Three genuinely invalid answers to A0 produce two warnings then termination", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Rani" });

  // Attempt 1: invalid
  const res1 = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "biryani" });
  assert.equal(res1.body.warningLevel, 1);
  assert.equal(res1.body.question.id, "A0");

  // Attempt 2: invalid
  const res2 = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "pizza" });
  assert.equal(res2.body.warningLevel, 2);
  assert.equal(res2.body.warning, true);
  assert.equal(res2.body.question.id, "A0");

  // Attempt 3: invalid -> graceful termination
  const res3 = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "chair" });
  assert.equal(res3.body.completed, true);
  assert.equal(res3.body.terminated, true);
  assert.equal(res3.body.sessionStatus, "terminated");
  assert.equal(res3.body.terminationReason, "repeated_invalid_answers");
  assert.equal(res3.body.terminatedAtQuestionId, "A0");

  // Subsequent answer is rejected with HTTP 409
  const res4 = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  assert.equal(res4.status, 409);
  assert.equal(res4.body.code, "INTERVIEW_TERMINATED");
});

test("Reliable Name Capture: handles varied natural Hindi and English introductions, initials, and regional names", async () => {
  const validIntroductions = [
    { input: "Mera naam Priya Sharma hai", expectedName: "Priya Sharma" },
    { input: "Main Sunita bol rahi hoon", expectedName: "Sunita" },
    { input: "Aap mujhe Aarti bula sakti hain", expectedName: "Aarti" },
    { input: "Namaste ji, mera naam Rekha Verma hai", expectedName: "Rekha Verma" },
    { input: "This is Deepanjali", expectedName: "Deepanjali" },
    { input: "My name is Mary D'Souza", expectedName: "Mary D'Souza" },
    { input: "K. Lakshmi", expectedName: "K. Lakshmi" },
    { input: "Priya S", expectedName: "Priya S" },
    { input: "Tsering Dolma", expectedName: "Tsering Dolma" },
    { input: "मेरा नाम पूजा है", expectedName: "पूजा" },
  ];

  for (const { input, expectedName } of validIntroductions) {
    const started = startInterview();
    const res = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId: "A2_NAME",
      answer: input,
    });

    assert.equal(res.status, 200, `Answer '${input}' should be accepted with status 200`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.question.id, "A2_NAME_CONFIRM");
    assert.equal(res.body.candidateName, expectedName, `Expected candidate name '${expectedName}' for input '${input}', got '${res.body.candidateName}'`);
    assert.ok(res.body.acknowledgement, "Response must include an acknowledgement");
    assert.match(res.body.acknowledgement, new RegExp(expectedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const confirmRes = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId: "A2_NAME_CONFIRM",
      answer: "yes",
    });
    assert.equal(confirmRes.status, 200);
    assert.equal(confirmRes.body.question.id, "A0");
  }
});

test("Reliable Name Capture: strictly rejects nonsensical, gibberish, empty, or uncertain name answers", async () => {
  const invalidNameInputs = [
    "habba jabba",
    "asdf qwerty",
    "biryani",
    "pizza",
    "12345",
    "x",
    "pata nahi",
    "nahi pata",
    "   ",
  ];

  for (const input of invalidNameInputs) {
    const started = startInterview();
    const res = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId: "A2_NAME",
      answer: input,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.clarificationRequired, true, `Input '${input}' must trigger clarification, not be accepted`);
    assert.equal(res.body.warningLevel, 1);
    assert.equal(res.body.acknowledgement, undefined, "Invalid answer must not have an acknowledgement of acceptance");
  }
});

test("Natural Acknowledgements: each valid answer receives appropriate brief natural acknowledgement matching session language", async () => {
  const started = startInterview();

  // A2_NAME
  const resName = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera naam Priya hai",
  });
  assert.equal(resName.body.acknowledgement, "Thank you, Priya ji!");

  // A0 (select English)
  const resA0 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "I would prefer English please",
  });
  assert.equal(resA0.body.acknowledgement, "Thank you, understood.");

  // A1 (Location) in English session
  const resA1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "I live in Whitefield, Bangalore and can travel across the city.",
  });
  assert.equal(resA1.body.acknowledgement, "Understood, thank you.");
  assert.equal(resA1.body.question.id, "A1_MOVE_TIMELINE");

  // A1 Follow-up (Move timeline)
  const resTimeline = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_MOVE_TIMELINE",
    answer: "I can relocate within 15 days if required.",
  });
  assert.equal(resTimeline.body.acknowledgement, "Understood, thank you.");
  assert.equal(resTimeline.body.question.id, "A2");

  // A2 (Age) in English session
  const resA2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "I am 28 years old.",
  });
  assert.equal(resA2.body.acknowledgement, "Thank you, noted.");
  assert.equal(resA2.body.question.id, "A3");
});

test("deleteReport removes the report from sessions and subsequent getReport returns 404", async () => {
  const started = startInterview();
  const sessionId = started.sessionId;

  // Confirm report is present in listReports and getReport
  assert.equal(getReport(sessionId).status, 200);
  const beforeList = listReports().body.sessions;
  assert.ok(beforeList.some((s) => s.sessionId === sessionId));

  // Delete the report
  const deleteResult = deleteReport(sessionId);
  assert.equal(deleteResult.status, 200);
  assert.equal(deleteResult.body.success, true);

  // Confirm report is no longer present
  assert.equal(getReport(sessionId).status, 404);
  const afterList = listReports().body.sessions;
  assert.ok(!afterList.some((s) => s.sessionId === sessionId));

  // Deleting again returns 404
  const deleteAgain = deleteReport(sessionId);
  assert.equal(deleteAgain.status, 404);
  assert.equal(deleteAgain.body.success, false);
});

test("deleteReport isolates deletion and preserves other reports and sessions", async () => {
  const session1 = startInterview();
  const session2 = startInterview();

  await submitAnswer({ sessionId: session1.sessionId, expectedQuestionId: "A2_NAME", answer: "Candidate One" });
  await submitAnswer({ sessionId: session2.sessionId, expectedQuestionId: "A2_NAME", answer: "Candidate Two" });

  // Delete session 1
  const result = deleteReport(session1.sessionId);
  assert.equal(result.status, 200);

  // Session 1 is deleted
  assert.equal(getReport(session1.sessionId).status, 404);

  // Session 2 is completely intact
  const report2 = getReport(session2.sessionId);
  assert.equal(report2.status, 200);
  assert.equal(report2.body.report.candidateName, "Candidate Two");

  // Clean up session 2
  deleteReport(session2.sessionId);
});

test("interviewController.deleteReport deletes report with HTTP 200 and handles nonexistent report with HTTP 404", async () => {
  const original = {
    isConnected: persistence.isConnected,
    findSessionById: persistence.findSessionById,
    deleteSession: persistence.deleteSession,
  };

  const started = startInterview();
  const sessionId = started.sessionId;
  let persistenceDeleted = false;

  persistence.isConnected = () => true;
  persistence.findSessionById = async (id) => (id === sessionId ? getSessionForPersistence(id) : null);
  persistence.deleteSession = async (id) => {
    if (id === sessionId) {
      persistenceDeleted = true;
      return true;
    }
    return false;
  };

  try {
    const makeRes = () => ({
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
    });

    const res1 = makeRes();
    await interviewController.deleteReport({ params: { sessionId } }, res1);
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.success, true);
    assert.equal(res1.body.sessionId, sessionId);
    assert.equal(persistenceDeleted, true);

    // Second delete returns 404
    const res2 = makeRes();
    await interviewController.deleteReport({ params: { sessionId } }, res2);
    assert.equal(res2.statusCode, 404);
    assert.equal(res2.body.success, false);

    // Invalid session ID returns 400
    const res3 = makeRes();
    await interviewController.deleteReport({ params: { sessionId: "" } }, res3);
    assert.equal(res3.statusCode, 400);
  } finally {
    persistence.isConnected = original.isConnected;
    persistence.findSessionById = original.findSessionById;
    persistence.deleteSession = original.deleteSession;
  }
});

test("Counter Question Handling: candidate asking 'Where do I have to travel?' on A1 receives grounded explanation without invalid warning and can answer", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Aarti",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Hindi",
  });

  // On A1, candidate asks "Where would I need to travel?"
  const crossQuestionRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Kahan travel karna padega?",
  });

  // Should trigger clarification with grounded travel cluster explanation, NOT invalid warning or termination
  assert.equal(crossQuestionRes.body.clarificationRequired, true);
  assert.equal(crossQuestionRes.body.counterQuestionHandled, true);
  assert.equal(crossQuestionRes.body.question.id, "A1");
  assert.match(crossQuestionRes.body.message, /3-4 km cluster/i);
  assert.equal(crossQuestionRes.body.invalidAnswer, undefined);

  // Candidate confirms area and willingness to travel within the cluster
  const followUpRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Koramangala, haan travel kar sakti hoon",
  });

  // Candidate advances to A1_MOVE_TIMELINE or A2
  assert.ok(["A1_MOVE_TIMELINE", "A2"].includes(followUpRes.body.question.id));
});

test("Counter Question Handling on Open-Ended Question: candidate asking about salary receives clear guidance and repeats question without penalty", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Sunita" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Indiranagar, travel kar sakti hoon" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_MOVE_TIMELINE", answer: "immediate" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "27" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Ghar mein 2 log hain, koi bachcha nahi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Nahi, koi plan nahi hai" });

  // On A7 (past salon experience), candidate asks counter question: "Salary kitni hogi?"
  const salaryInterpretation = async () => ({
    understanding: "Candidate asked about earnings/salary policy.",
    answerStatus: "counter_question",
    counterQuestionAnswer: "Earnings aur payout details interview clear hone ke baad onboarding team discuss karegi.",
    needsClarification: true,
  });

  const salaryRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Aage jaake salary kitni milegi?",
  }, { interpretAnswerImpl: salaryInterpretation });

  assert.equal(salaryRes.body.counterQuestionHandled, true);
  assert.equal(salaryRes.body.question.id, "A7");
  assert.match(salaryRes.body.message, /onboarding team/i);

  // Candidate now answers A7 normally
  const answerRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Main 2 saal se ek local salon mein beautician hoon",
  });

  assert.equal(answerRes.body.question.id, "A8");
});

test("Contextual Follow-Up: partial answer triggers a follow-up probe without penalty, and follow-up answer advances to next question", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Priya" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "English" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "HSR Layout, can travel" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_MOVE_TIMELINE", answer: "Immediately" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "25" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Living with parents, no kids" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "No pregnancy plans" });

  // Candidate gives a partial answer on A7
  const partialInterpretation = async () => ({
    understanding: "Candidate mentioned salon work but did not specify duration or responsibilities.",
    answerStatus: "partial",
    needsClarification: true,
    clarificationQuestion: "Could you tell me how long you worked there and what services you provided?",
  });

  const partialRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "I worked in a salon",
  }, { interpretAnswerImpl: partialInterpretation });

  assert.equal(partialRes.body.followUpRequired, true);
  assert.equal(partialRes.body.question.id, "A7_FOLLOW_UP");
  assert.match(partialRes.body.message, /how long you worked there/i);

  // Candidate answers the follow-up probe
  const followUpAnswerRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7_FOLLOW_UP",
    answer: "I worked for 3 years doing facials, waxing, and threading",
  });

  assert.equal(followUpAnswerRes.body.question.id, "A8");
  assert.equal(followUpAnswerRes.body.followUpCaptured, true);
});

test("Candidate Name Confirmation and Update: allows correcting misheard or updated name", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Pooja",
  });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });

  const sessionBefore = getSessionForPersistence(started.sessionId);
  assert.equal(sessionBefore.candidateName, "Pooja");

  // Candidate corrects name to "Pooja Sharma"
  const updateResult = updateCandidateName(started.sessionId, "Pooja Sharma");
  assert.equal(updateResult.success, true);
  assert.equal(updateResult.candidateName, "Pooja Sharma");

  const sessionAfter = getSessionForPersistence(started.sessionId);
  assert.equal(sessionAfter.candidateName, "Pooja Sharma");
  const nameAnswer = sessionAfter.answers.find((a) => a.questionId === "A2_NAME");
  assert.equal(nameAnswer.answer, "Pooja Sharma");

  // Rejects invalid gibberish
  const badResult = updateCandidateName(started.sessionId, "xyz abc");
  assert.equal(badResult.success, false);

  // Controller endpoint returns 200 on valid update and 400 on bad name
  const makeRes = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  });

  const res1 = makeRes();
  await interviewController.updateCandidateName({
    body: { sessionId: started.sessionId, name: "Pooja R. Sharma" },
  }, res1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.success, true);
  assert.equal(res1.body.candidateName, "Pooja R. Sharma");

  const res2 = makeRes();
  await interviewController.updateCandidateName({
    body: { sessionId: started.sessionId, name: "" },
  }, res2);
  assert.equal(res2.statusCode, 400);

  const res3 = makeRes();
  await interviewController.updateCandidateName({
    body: { sessionId: "nonexistent-id", name: "Valid Name" },
  }, res3);
  assert.equal(res3.statusCode, 400);
});

test("Regression 1 & 9: Complete relevant answer in Hindi/English advances with natural acknowledgement", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Neha Sharma" });
  const a0Res = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan main ready hoon" });
  assert.equal(a0Res.status, 200);
  assert.equal(a0Res.body.question.id, "A1");
  assert.ok(a0Res.body.acknowledgement, "Should provide natural acknowledgement");

  const a1Res = await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "South Delhi" });
  assert.equal(a1Res.status, 200);
  assert.ok(a1Res.body.acknowledgement);
});

test("Regression 2, 10 & 11: Legitimate counter-questions do not increment warning count, are not stored as official answers, and repeat pending question", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Suman" });
  
  // Ask counter-question on A0 (Consent): "Salary kitni hogi?"
  const salaryQueryRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Salary kitni hogi?",
  });
  assert.equal(salaryQueryRes.status, 200);
  assert.equal(salaryQueryRes.body.question.id, "A0", "Question must remain A0");
  assert.equal(salaryQueryRes.body.counterQuestionHandled, true);
  assert.match(salaryQueryRes.body.message, /partner team|onboarding/i);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No invalid attempts should be recorded for counter-question");
  const storedA0Answers = session.answers.filter((a) => a.questionId === "A0");
  assert.equal(storedA0Answers.length, 0, "Counter-question must NOT be saved as official answer");

  // Candidate now consents normally
  const consentRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Haan ji, main taiyar hoon",
  });
  assert.equal(consentRes.status, 200);
  assert.equal(consentRes.body.question.id, "A1");

  // Counter-question on A1: "Where do I have to travel?"
  const travelQueryRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Kahan jana padega travel karke?",
  });
  assert.equal(travelQueryRes.status, 200);
  assert.equal(travelQueryRes.body.question.id, "A1", "Question must remain A1");
  assert.equal(travelQueryRes.body.counterQuestionHandled, true);
  assert.match(travelQueryRes.body.message, /3-4 km/i);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);

  // Candidate answers A1 and travel clarification to advance to A2
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "South Delhi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi, main travel nahi kar sakti" });

  // Counter-question on A2: "Minimum age kya hai?"
  const ageQueryRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "Minimum age kitni honi chahiye?",
  });
  assert.equal(ageQueryRes.status, 200);
  assert.equal(ageQueryRes.body.question.id, "A2", "Question must remain A2");
  assert.equal(ageQueryRes.body.counterQuestionHandled, true);
  assert.match(ageQueryRes.body.message, /18/);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);
});

test("Regression 3: Clarification request explains concept simply, repeats question, and issues no warning", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Noida" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi, main travel nahi kar sakti" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "26" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Family ke saath rehti hoon, bacche nahi hain" }, { interpretAnswerImpl: fallbackInterpretation });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Abhi pregnancy ka koi plan nahi hai" }, { interpretAnswerImpl: fallbackInterpretation });

  // On A7: candidate asks for clarification: "Can you explain what you mean?"
  const clarRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Can you please explain the question?",
  }, { interpretAnswerImpl: fallbackInterpretation });

  assert.equal(clarRes.status, 200);
  assert.equal(clarRes.body.question.id, "A7", "Question A7 remains active");
  assert.equal(clarRes.body.counterQuestionHandled, true);
  assert.match(clarRes.body.message, /anubhav|experience|explain/i);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No invalid attempt warnings on clarification");
});

test("Regression 4: Partial answer requires follow-up probe without warning strike and advances upon answer", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Sunita" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Yes" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi, main travel nahi kar sakti" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "28" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Living with husband, no kids" }, { interpretAnswerImpl: fallbackInterpretation });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Abhi pregnancy ka koi plan nahi hai" }, { interpretAnswerImpl: fallbackInterpretation });

  // Partial answer on A7
  const partialRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Haan experience hai",
  }, { interpretAnswerImpl: fallbackInterpretation });

  assert.equal(partialRes.status, 200);
  assert.equal(partialRes.body.followUpRequired, true);
  assert.equal(partialRes.body.question.id, "A7_FOLLOW_UP");
  assert.match(partialRes.body.message, /services/i);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No invalid warnings on partial answer");

  // Answering the follow-up probe advances to A8
  const followUpRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7_FOLLOW_UP",
    answer: "Facial aur waxing karti hoon",
  }, { interpretAnswerImpl: fallbackInterpretation });

  assert.equal(followUpRes.status, 200);
  assert.equal(followUpRes.body.question.id, "A8");
});

test("Regression 5: Genuinely irrelevant utterance triggers 2-warning policy and eventual termination", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Anita" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Rohini" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi, main travel nahi kar sakti" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "24" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Parents ke saath, no kids" }, { interpretAnswerImpl: fallbackInterpretation });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Abhi pregnancy ka koi plan nahi hai" }, { interpretAnswerImpl: fallbackInterpretation });

  // 1st irrelevant answer on A7
  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "The weather is very nice today, I like pizza",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(res1.status, 200);
  assert.equal(res1.body.warningLevel, 1);
  assert.equal(res1.body.question.id, "A7");

  // 2nd irrelevant answer on A7
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Habba jabba cricket match",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.warningLevel, 2);
  assert.equal(res2.body.warning, true);
  assert.equal(res2.body.question.id, "A7");

  // 3rd irrelevant answer terminates
  const res3 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Potato burger movie",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(res3.status, 200);
  assert.equal(res3.body.completed, true);
  assert.equal(res3.body.sessionStatus, "terminated");
});

test("Regression 6: Empty or unintelligible audio ('...') asks candidate to repeat without counting as invalid strike", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Meena" });

  // Candidate audio is muffled/unintelligible "..."
  const repromptRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "...",
  });

  assert.equal(repromptRes.status, 200);
  assert.equal(repromptRes.body.question.id, "A0", "Question A0 remains active");
  assert.match(repromptRes.body.message, /aawaz|repeat|type/i);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No invalid attempt strikes for unintelligible audio");

  // Candidate then answers cleanly
  const answerRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Haan main taiyar hoon",
  });
  assert.equal(answerRes.status, 200);
  assert.equal(answerRes.body.question.id, "A1");
});

test("Regression 7: Counter-question followed by answer to the same pending question advances cleanly", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Kavita" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Haan" });

  // Candidate asks counter-question on A1
  const cqRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Where do I need to travel?",
  });
  assert.equal(cqRes.status, 200);
  assert.equal(cqRes.body.counterQuestionHandled, true);
  assert.equal(cqRes.body.question.id, "A1");

  // Candidate now answers the pending question
  const ansRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Indirapuram",
  });
  assert.equal(ansRes.status, 200);
  assert.equal(ansRes.body.question.id, "A1_TRAVEL_CLARIFICATION");

  const clarAns = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1_TRAVEL_CLARIFICATION",
    answer: "Nahi, main travel nahi kar sakti",
  });
  assert.equal(clarAns.status, 200);
  assert.equal(clarAns.body.question.id, "A2");
});

test("Regression 12: Question bank IDs, length, and sequence remain strictly unchanged", () => {
  const bankPath = require("path").join(__dirname, "../data/questionBank.json");
  const bank = require(bankPath);
  assert.equal(bank.questions.length, 50, "Bank must contain exactly 50 official questions");
  assert.equal(bank.questions[0].Step, "A2_NAME");
  assert.equal(bank.questions[1].Step, "A0");
  assert.equal(bank.questions[2].Step, "A1");
  assert.equal(bank.questions[bank.questions.length - 1].Step, "D2");
});

test("Regression Name Verification 1: Candidate provides name -> A2_NAME_CONFIRM appears before A0", async () => {
  const started = startInterview();
  assert.equal(started.question.id, "A2_NAME");

  const nameRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera naam Aakash hai",
  });

  assert.equal(nameRes.status, 200);
  assert.equal(nameRes.body.nameConfirmationRequired, true);
  assert.equal(nameRes.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(nameRes.body.candidateName, "Aakash");
  assert.match(nameRes.body.question.text, /Aapka naam Aakash hai, sahi hai na\?/i);
});

test("Regression Name Verification 2: Yes confirms name and advances to A0 exactly once", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera naam Aakash hai",
  });

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.question.id, "A0");
  assert.equal(confirmRes.body.candidateName, "Aakash");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.candidateName, "Aakash");
  const nameRecord = session.answers.find((a) => a.questionId === "A2_NAME");
  assert.ok(nameRecord, "A2_NAME must be recorded in session answers");
  assert.equal(nameRecord.answer, "Aakash");
  assert.equal(session.answers.filter((a) => a.questionId === "A2_NAME").length, 1);
});

test("Regression Name Verification 3: No requests corrected name and repeats verification on new name", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera naam Aakash hai",
  });

  // Candidate says No
  const noRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Nahi",
  });

  assert.equal(noRes.status, 200);
  assert.equal(noRes.body.nameCorrectionRequired, true);
  assert.equal(noRes.body.question.id, "A2_NAME");
  assert.match(noRes.body.message, /sahi naam batayein/i);

  // Candidate states correct name
  const correctedRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera sahi naam Vikas hai",
  });

  assert.equal(correctedRes.status, 200);
  assert.equal(correctedRes.body.nameConfirmationRequired, true);
  assert.equal(correctedRes.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(correctedRes.body.candidateName, "Vikas");
  assert.match(correctedRes.body.question.text, /Aapka naam Vikas hai, sahi hai na\?/i);

  // Candidate confirms with Haan
  const finalConfirm = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan",
  });

  assert.equal(finalConfirm.status, 200);
  assert.equal(finalConfirm.body.question.id, "A0");
  assert.equal(finalConfirm.body.candidateName, "Vikas");
});

test("Regression Name Verification 4: Duplicate spoken and button confirmations do not cause duplicate progression", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita Verma",
  });

  // First confirmation (e.g., spoken "yes")
  const firstConfirm = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });
  assert.equal(firstConfirm.status, 200);
  assert.equal(firstConfirm.body.question.id, "A0");

  // Duplicate confirmation attempt (e.g. rapid button click or duplicate speech packet)
  const dupConfirm = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });

  // Should be rejected as stale with 409 and not corrupt the current question A0
  assert.equal(dupConfirm.status, 409);
  assert.equal(dupConfirm.body.staleQuestion, true);
  assert.equal(dupConfirm.body.question.id, "A0");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.answers.length, 1);
  assert.equal(session.answers[0].questionId, "A2_NAME");
});

test("Regression Name Verification 5: Verbal correction directly during confirmation updates name and repeats verification", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita",
  });

  // Candidate corrects verbally: "Nahi mera naam Sunita nahi Rekha hai"
  const correctionRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Nahi mera naam Rekha hai",
  });

  assert.equal(correctionRes.status, 200);
  assert.equal(correctionRes.body.nameConfirmationRequired, true);
  assert.equal(correctionRes.body.candidateName, "Rekha");
  assert.match(correctionRes.body.question.text, /Aapka naam Rekha hai, sahi hai na\?/i);

  // Now confirms
  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Ji haan",
  });
  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.question.id, "A0");
});

test("Regression Name Verification 6: Spoken name matches profile name -> verified with 'Aapka naam [Name] hai, sahi hai na?'", async () => {
  const started = startInterview({ candidateId: "cand-profile-1", profileName: "Pooja Sharma" });
  assert.equal(started.question.id, "A2_NAME");

  const nameRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera naam Pooja Sharma hai",
  });

  assert.equal(nameRes.status, 200);
  assert.equal(nameRes.body.nameConfirmationRequired, true);
  assert.equal(nameRes.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(nameRes.body.candidateName, "Pooja Sharma");
  assert.match(nameRes.body.question.text, /Aapka naam Pooja Sharma hai, sahi hai na\?/i);
});

test("Regression Name Verification 7: Unclear spoken name with authenticated profile -> verified with 'Aapke profile mein naam [Name] hai. Kya ye sahi hai?'", async () => {
  const started = startInterview({ candidateId: "cand-profile-2", profileName: "Pooja Sharma" });
  assert.equal(started.question.id, "A2_NAME");

  // Candidate says unclear/bare "haan" or muffled words
  const unclearRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "haan",
  });

  assert.equal(unclearRes.status, 200);
  assert.equal(unclearRes.body.nameConfirmationRequired, true);
  assert.equal(unclearRes.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(unclearRes.body.candidateName, "Pooja Sharma");
  assert.match(unclearRes.body.question.text, /Aapke profile mein naam Pooja Sharma hai\. Kya ye sahi hai\?/i);

  // Candidate confirms
  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Ji haan sahi hai",
  });
  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.question.id, "A0");
  assert.equal(confirmRes.body.candidateName, "Pooja Sharma");
});

test("Regression Name Verification 8: First name spoken matches full profile name", async () => {
  const started = startInterview({ candidateId: "cand-profile-3", profileName: "Pooja Sharma" });

  const nameRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Main Pooja baat kar rahi hoon",
  });

  assert.equal(nameRes.status, 200);
  assert.equal(nameRes.body.nameConfirmationRequired, true);
  assert.equal(nameRes.body.candidateName, "Pooja Sharma");
  assert.match(nameRes.body.question.text, /Aapka naam Pooja Sharma hai, sahi hai na\?/i);
});

test("Lifecycle Regression 1: Every explicit Start Interview action creates a fresh session starting from Question 1", async () => {
  const candidateId = "candidate-single-flow-1";

  // Start interview 1
  const session1 = startInterview({ candidateId });
  assert.equal(session1.questionNumber, 1);
  assert.equal(session1.question.id, "A2_NAME");
  assert.equal(session1.totalQuestions, 50);

  // Candidate answers question 1
  await submitAnswer({
    sessionId: session1.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Kavita",
  });
  await submitAnswer({
    sessionId: session1.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });

  const rep1 = getReport(session1.sessionId).body.report;
  assert.equal(rep1.answeredQuestions, 1);
  assert.equal(rep1.answers[0].questionId, "A2_NAME");

  // Explicit start interview 2 for same candidate
  const session2 = startInterview({ candidateId });
  assert.notEqual(session2.sessionId, session1.sessionId, "Must create a brand new session ID");
  assert.equal(session2.questionNumber, 1, "Must always start from Question 1");
  assert.equal(session2.question.id, "A2_NAME", "Question 1 must be A2_NAME");

  const rep2 = getReport(session2.sessionId).body.report;
  assert.equal(rep2.answeredQuestions, 0, "New session must not reuse answered questions");

  // Session 1 report is preserved (not deleted) and marked incomplete
  const rep1After = getReport(session1.sessionId).body.report;
  assert.ok(rep1After, "Historical session report must be preserved");
  assert.equal(rep1After.status, "incomplete", "Prior session concluded as incomplete");
  assert.equal(rep1After.answeredQuestions, 1, "Prior answers preserved");
});

test("Lifecycle Regression 2: Ended interview is marked incomplete/ended and never offered as an active interview", async () => {
  const { getActiveSessionForCandidate, resumeInterview } = require("./interview");
  const candidateId = "candidate-single-flow-ended";

  const started = startInterview({ candidateId });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Shweta",
  });

  // End the interview
  const endResult = endInterview(started.sessionId);
  assert.equal(endResult.status, 200);
  assert.equal(endResult.body.sessionStatus, "incomplete");

  // Verify it is NOT offered as an active session
  const activeSession = getActiveSessionForCandidate(candidateId);
  assert.equal(activeSession, null, "Ended session must never be offered as active session");

  // Submitting answers to ended session is rejected
  const answerAttempt = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "yes",
  });
  assert.equal(answerAttempt.status, 400);
  assert.match(answerAttempt.body.message, /not in progress/i);

  // Resuming ended session is rejected
  const resumeAttempt = resumeInterview(started.sessionId);
  assert.equal(resumeAttempt.status, 400);
  assert.match(resumeAttempt.body.message, /already ended/i);
});

test("Intent Regression 1 & 4: Asking 'Aap ye question kyun pooch rahe ho?' receives relevant explanation and returns same pending question", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Neha" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "yes" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "25" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Husband ke saath rehti hoon, bacche nahi hain" }, { interpretAnswerImpl: fallbackInterpretation });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Abhi koi plan nahi hai" }, { interpretAnswerImpl: fallbackInterpretation });

  // On A7 (Salon experience): candidate asks "Aap ye question kyun pooch rahe ho?"
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Aap mujhse ye question kyun pooch rahe ho?",
  }, { interpretAnswerImpl: fallbackInterpretation });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A7", "Must return same pending question A7");
  assert.equal(res.body.counterQuestionHandled, true);
  assert.match(res.body.message, /experience|skills|preferences|bookings/i);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warning for asking question purpose");
});

test("Intent Regression 2: Asking for clarification does not trigger warning and stays on same question", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Ritu" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "yes" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "26" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Ghar pe mummy papa hain, no kids" }, { interpretAnswerImpl: fallbackInterpretation });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Abhi koi plan nahi hai" }, { interpretAnswerImpl: fallbackInterpretation });

  // Candidate asks "Iska matlab kya hai?" on A7
  const res1 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Iska matlab kya hai?",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(res1.status, 200);
  assert.equal(res1.body.question.id, "A7");
  assert.equal(res1.body.counterQuestionHandled, true);

  // Candidate asks "Aap thoda explain kar sakte ho?" on A7
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Aap thoda explain kar sakte ho?",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.question.id, "A7");
  assert.equal(res2.body.counterQuestionHandled, true);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "Zero warnings for asking clarification");
});

test("Intent Regression 3 & 5: Salary, training, and travel questions do not trigger warnings and are never saved as official answers", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Meena" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "yes" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "24" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Pati ke saath, bacche nahi hain" }, { interpretAnswerImpl: fallbackInterpretation });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Koi plan nahi hai" }, { interpretAnswerImpl: fallbackInterpretation });

  // Salary inquiry on A7
  const resSalary = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Salary kitni milegi?",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(resSalary.status, 200);
  assert.equal(resSalary.body.question.id, "A7");
  assert.match(resSalary.body.message, /partner team/i);

  // Training inquiry on A7
  const resTraining = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Training milegi kya?",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(resTraining.status, 200);
  assert.equal(resTraining.body.question.id, "A7");
  assert.match(resTraining.body.message, /training/i);

  // Travel inquiry on A7
  const resTravel = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Mujhe kitni door travel karna hoga?",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(resTravel.status, 200);
  assert.equal(resTravel.body.question.id, "A7");
  assert.match(resTravel.body.message, /3-4 km/i);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warnings for job inquiries");

  // Verify counter-questions are NEVER saved in session.answers
  for (const record of session.answers) {
    assert.notEqual(record.answer, "Salary kitni milegi?");
    assert.notEqual(record.answer, "Training milegi kya?");
    assert.notEqual(record.answer, "Mujhe kitni door travel karna hoga?");
  }

  // Now candidate provides real answer to A7
  const validRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Main 3 saal se salon mein kaam kar rahi hoon, waxing aur facial karti hoon",
  }, { interpretAnswerImpl: fallbackInterpretation });
  assert.equal(validRes.status, 200);
  assert.equal(validRes.body.question.id, "A8", "Advances to A8 after candidate answers");

  const lastAnswer = session.answers[session.answers.length - 1];
  assert.equal(lastAnswer.questionId, "A7");
  assert.match(lastAnswer.answer, /3 saal/);
});

test("Intent Regression 6 & 10: Short but relevant answers are accepted and advance with natural acknowledgement", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Divya" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "yes" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "27" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Parents ke saath, no kids" }, { interpretAnswerImpl: fallbackInterpretation });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Koi plan nahi hai" }, { interpretAnswerImpl: fallbackInterpretation });

  // Direct short answer on A7: "3 saal"
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "3 saal",
  }, { interpretAnswerImpl: fallbackInterpretation });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A8");
  assert.ok(res.body.acknowledgement, "Must provide natural acknowledgement");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);
});

test("Intent Regression 9: Empty or unintelligible input does not trigger warning or increment invalid attempts", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Kiran" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "yes" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "23" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Family, no kids" }, { interpretAnswerImpl: fallbackInterpretation });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Koi plan nahi hai" }, { interpretAnswerImpl: fallbackInterpretation });

  // Candidate produces unintelligible audio
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "uh...",
  }, { interpretAnswerImpl: fallbackInterpretation });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A7", "Remains on A7");
  assert.match(res.body.message, /aawaz theek se nahi aayi|repeat/i);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warning on unintelligible audio");
});

test("Intent Regression 11: Official question bank has exactly 50 approved questions in unmodified order", () => {
  const bank = require("../data/questionBank.json");
  assert.equal(Array.isArray(bank.questions), true);
  assert.equal(bank.questions.length, 50, "Question bank must contain exactly 50 questions");
  assert.equal(bank.questions[0].Step || bank.questions[0].id, "A2_NAME");
  assert.equal(bank.questions[1].Step || bank.questions[1].id, "A0");
  assert.equal(bank.questions[2].Step || bank.questions[2].id, "A1");
});

test("Generalization 1: Candidate asks unseen question 'Kya mujhe apna samaan khud lana padega?' during A0 consent", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });

  // During A0 consent, candidate asks unseen question about equipment/samaan
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Kya mujhe apna samaan khud lana padega?",
  }, {
    interpretAnswerImpl: async () => ({
      intent: "RELEVANT_COUNTER_QUESTION",
      answerStatus: "counter_question",
      needsClarification: true,
      counterQuestionAnswer: "Urban Company onboarding team toolkit aur samaan ke baare mein poori details share karti hai.",
      responseText: "Urban Company onboarding team toolkit aur samaan ke baare mein poori details share karti hai.",
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A0", "Remains on A0 pending consent");
  assert.match(res.body.message, /toolkit|samaan|onboarding/i);
  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warnings issued for asking equipment question");
  assert.equal(session.answers.some((a) => a.questionId === "A0"), false, "Asking question is not recorded as consent");
});

test("Generalization 2: Candidate asks unseen question 'Agar mujhe client ke ghar unsafe feel ho toh main kya karun?' during A1 location", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });

  // During A1 location, candidate asks unseen safety question
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A1",
    answer: "Agar mujhe client ke ghar unsafe feel ho toh main kya karun?",
  }, {
    interpretAnswerImpl: async () => ({
      intent: "RELEVANT_COUNTER_QUESTION",
      answerStatus: "counter_question",
      needsClarification: true,
      counterQuestionAnswer: "Urban Company mein partner safety hamari priority hai, app mein SOS button aur safety support helpline hamesha available hoti hai.",
      responseText: "Urban Company mein partner safety hamari priority hai, app mein SOS button aur safety support helpline hamesha available hoti hai.",
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A1", "Remains on A1 pending location answer");
  assert.match(res.body.message, /safety|SOS|support/i);
  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warnings issued for asking safety question");
});

test("Generalization 3: Candidate asks unseen question 'Aap meri age pooch rahe hain, lekin experience ko kaise consider karenge?' during A2 age", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Whitefield" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi" });

  // During A2 age, candidate asks about experience vs age
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2",
    answer: "Aap meri age pooch rahe hain, lekin experience ko kaise consider karenge?",
  }, {
    interpretAnswerImpl: async () => ({
      intent: "RELEVANT_COUNTER_QUESTION",
      answerStatus: "counter_question",
      needsClarification: true,
      counterQuestionAnswer: "Urban Company partner banne ke liye kam se kam 18 saal umar honi zaroori hai. Aapka work experience aage aane wale sawaalon mein detail mein pucha jaayega.",
      responseText: "Urban Company partner banne ke liye kam se kam 18 saal umar honi zaroori hai. Aapka work experience aage aane wale sawaalon mein detail mein pucha jaayega.",
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A2", "Remains on A2 pending age");
  assert.match(res.body.message, /18 saal|experience/i);
  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warnings issued for asking age purpose");
  assert.equal(session.answers.some((a) => a.questionId === "A2"), false, "Asking question is not recorded as age");
});

test("Generalization 4: Candidate asks unseen clarification 'Aapne jo question poochha, kya aap ek example de sakte hain?' during A2_NAME_CONFIRM", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Neha" });

  // During name confirmation, candidate asks for an example/clarification
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Aapne jo question poochha, kya aap ek example de sakte hain?",
  }, {
    interpretAnswerImpl: async () => ({
      intent: "CLARIFICATION_REQUEST",
      answerStatus: "counter_question",
      needsClarification: true,
      clarificationQuestion: "Haan zaroor, bas itna batana hai ki kya aapka naam Neha sahi hai, aap Haan ya Nahi bol sakti hain.",
      responseText: "Haan zaroor, bas itna batana hai ki kya aapka naam Neha sahi hai, aap Haan ya Nahi bol sakti hain.",
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A2_NAME_CONFIRM", "Remains on name confirmation");
  assert.match(res.body.message, /Haan|Nahi|Neha/i);
  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warnings issued for asking clarification on name confirmation");
});

test("Generalization 5: Candidate asks unseen question 'Agar mujhe kisi service ka answer nahi pata, toh kya hoga?' during A9 travel", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Sunita" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Delhi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "24" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Family ke saath, no kids" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Koi plan nahi hai" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A7", answer: "2 saal" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A8", answer: "Waxing aur facial" });

  // During A9 travel, candidate asks what happens if they don't know a service answer
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A9",
    answer: "Agar mujhe kisi service ka answer nahi pata, toh kya hoga?",
  }, {
    interpretAnswerImpl: async () => ({
      intent: "RELEVANT_COUNTER_QUESTION",
      answerStatus: "counter_question",
      needsClarification: true,
      counterQuestionAnswer: "Koi chinta nahi, aap jitna jaanti hain spasht batayein. Onboarding ke dauran Urban Company poori training provide karti hai.",
      responseText: "Koi chinta nahi, aap jitna jaanti hain spasht batayein. Onboarding ke dauran Urban Company poori training provide karti hai.",
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A9", "Remains on A9 pending travel answer");
  assert.match(res.body.message, /training|chinta|spasht/i);
  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warnings issued on A9 inquiry");
});

test("Generalization 6: Candidate gives short answers 'Do saal' and 'Waxing aur facial' with natural context-aware acknowledgement", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Rani" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A0", answer: "Hindi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1", answer: "Bangalore" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A1_TRAVEL_CLARIFICATION", answer: "Nahi" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2", answer: "25" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A3", answer: "Family ke saath, no kids" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A6", answer: "Kuch nahi" });

  // A7: "Do saal"
  const resA7 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A7",
    answer: "Do saal",
  });
  assert.equal(resA7.status, 200);
  assert.equal(resA7.body.question.id, "A8");
  assert.match(resA7.body.acknowledgement, /experience|noted|samajh/i);

  // A8: "Waxing aur facial"
  const resA8 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A8",
    answer: "Waxing aur facial",
  });
  assert.equal(resA8.status, 200);
  assert.equal(resA8.body.question.id, "A9");
  assert.match(resA8.body.acknowledgement, /services|samajh|theek/i);
});

test("Generalization 7: Gemini offline or rate limited during screening falls back to detectCounterQuestion safely", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Geeta" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "yes" });

  // During A0, candidate asks known counter question while Gemini throws RateLimitError
  const res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A0",
    answer: "Salary kitni milegi aur payment kaise hoti hai?",
  }, {
    interpretAnswerImpl: async () => {
      throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { name: "RateLimitError", status: 429 });
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.question.id, "A0", "Stays on A0 via counterQuestions fallback");
  assert.match(res.body.message, /partner onboarding team|earning/i);
  const session = getSessionForPersistence(started.sessionId);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warning despite Gemini rate limit");
});

test("Name Confirmation Reliability 1: 'Haan, yahi naam hai' confirms original name without treating affirmation as name", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja Sharma" });

  const sessionBefore = getSessionForPersistence(started.sessionId);
  assert.equal(sessionBefore.answers.some((a) => a.questionId === "A2_NAME"), false, "Must not persist before confirmation");

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan, yahi naam hai",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.candidateName, "Pooja Sharma");
  assert.notEqual(confirmRes.body.candidateName, "Yahi Naam");
  assert.equal(confirmRes.body.question.id, "A0");

  const sessionAfter = getSessionForPersistence(started.sessionId);
  assert.equal(sessionAfter.candidateName, "Pooja Sharma");
  const nameRecord = sessionAfter.answers.find((a) => a.questionId === "A2_NAME");
  assert.ok(nameRecord);
  assert.equal(nameRecord.answer, "Pooja Sharma");
  assert.equal(Object.keys(sessionAfter.invalidAttempts || {}).length, 0);
});

test("Name Confirmation Reliability 2: 'Bilkul sahi' confirms original name without treating affirmation as name", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Sunita Rao" });

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Bilkul sahi",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.candidateName, "Sunita Rao");
  assert.notEqual(confirmRes.body.candidateName, "Bilkul Sahi");
  assert.equal(confirmRes.body.question.id, "A0");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.candidateName, "Sunita Rao");
  assert.equal(session.answers.find((a) => a.questionId === "A2_NAME")?.answer, "Sunita Rao");
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);
});

test("Name Confirmation Reliability 3: 'Yes, that's correct' confirms original name without treating affirmation as name", async () => {
  const started = startInterview({ language: "English" });
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Ananya Patel" });

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Yes, that's correct",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.candidateName, "Ananya Patel");
  assert.notEqual(confirmRes.body.candidateName, "That's Correct");
  assert.equal(confirmRes.body.question.id, "A0");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.candidateName, "Ananya Patel");
  assert.equal(session.answers.find((a) => a.questionId === "A2_NAME")?.answer, "Ananya Patel");
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);
});

test("Name Confirmation Reliability 4: 'Haanji' confirms original name without treating affirmation as name", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Kavita Verma" });

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haanji",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.candidateName, "Kavita Verma");
  assert.notEqual(confirmRes.body.candidateName, "Haanji");
  assert.equal(confirmRes.body.question.id, "A0");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.candidateName, "Kavita Verma");
  assert.equal(session.answers.find((a) => a.questionId === "A2_NAME")?.answer, "Kavita Verma");
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);
});

test("Name Confirmation Reliability 5: 'Ji haan bilkul' confirms original name without treating affirmation as name", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Rekha Rani" });

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Ji haan bilkul",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.candidateName, "Rekha Rani");
  assert.equal(confirmRes.body.question.id, "A0");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.candidateName, "Rekha Rani");
  assert.equal(session.answers.find((a) => a.questionId === "A2_NAME")?.answer, "Rekha Rani");
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);
});

test("Name Confirmation Reliability 6: 'Haan, theek hai' confirms original name without treating affirmation as name", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Deepa Devi" });

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan, theek hai",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.candidateName, "Deepa Devi");
  assert.equal(confirmRes.body.question.id, "A0");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.candidateName, "Deepa Devi");
  assert.equal(session.answers.find((a) => a.questionId === "A2_NAME")?.answer, "Deepa Devi");
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);
});

test("Name Confirmation Reliability 7: 'Nahi, galat hai' clears unconfirmed name and reprompts for name on A2_NAME with 0 warnings", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });

  const rejectRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Nahi, galat hai",
  });

  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.nameCorrectionRequired, true);
  assert.equal(rejectRes.body.question.id, "A2_NAME");
  assert.match(rejectRes.body.message, /sahi naam batayein/i);

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.candidateName, null, "Candidate name must be cleared on rejection");
  assert.equal(session.pendingNameConfirmation, null, "Pending confirmation must be cleared on rejection");
  assert.equal(session.answers.some((a) => a.questionId === "A2_NAME"), false, "A2_NAME must not exist in answers");
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0, "No warning penalty on rejection");
});

test("Name Confirmation Reliability 8: 'Mera naam galat hai' clears unconfirmed name and reprompts for name on A2_NAME with 0 warnings", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Sunita" });

  const rejectRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Mera naam galat hai",
  });

  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.nameCorrectionRequired, true);
  assert.equal(rejectRes.body.question.id, "A2_NAME");

  const session = getSessionForPersistence(started.sessionId);
  assert.equal(session.candidateName, null);
  assert.equal(session.pendingNameConfirmation, null);
  assert.equal(session.answers.some((a) => a.questionId === "A2_NAME"), false);
  assert.equal(Object.keys(session.invalidAttempts || {}).length, 0);
});

test("Name Confirmation Reliability 9: 'Nahi, mera naam Sunita hai' corrects name and prompts confirmation for new name without premature persistence", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Anita" });

  const correctRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Nahi, mera naam Sunita hai",
  });

  assert.equal(correctRes.status, 200);
  assert.equal(correctRes.body.nameConfirmationRequired, true);
  assert.equal(correctRes.body.candidateName, "Sunita");
  assert.equal(correctRes.body.question.id, "A2_NAME_CONFIRM");
  assert.match(correctRes.body.question.text, /Sunita/i);

  const sessionMid = getSessionForPersistence(started.sessionId);
  assert.equal(sessionMid.answers.some((a) => a.questionId === "A2_NAME"), false, "Sunita not yet committed prior to confirmation");
  assert.equal(Object.keys(sessionMid.invalidAttempts || {}).length, 0);

  // Now candidate confirms Sunita
  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.candidateName, "Sunita");
  assert.equal(confirmRes.body.question.id, "A0");

  const sessionFinal = getSessionForPersistence(started.sessionId);
  assert.equal(sessionFinal.candidateName, "Sunita");
  assert.equal(sessionFinal.answers.find((a) => a.questionId === "A2_NAME")?.answer, "Sunita");
  assert.equal(Object.keys(sessionFinal.invalidAttempts || {}).length, 0);
});

test("Name Confirmation Reliability 10: 'Aap mera naam kyun pooch rahe ho?' responds naturally with grounded facts without warnings and preserves pending confirmation", async () => {
  const started = startInterview();
  await submitAnswer({ sessionId: started.sessionId, expectedQuestionId: "A2_NAME", answer: "Pooja" });

  const inquiryRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Aap mera naam kyun pooch rahe ho?",
  });

  assert.equal(inquiryRes.status, 200);
  assert.equal(inquiryRes.body.counterQuestionHandled, true);
  assert.equal(inquiryRes.body.nameConfirmationRequired, true);
  assert.equal(inquiryRes.body.question.id, "A2_NAME_CONFIRM");
  assert.match(inquiryRes.body.message, /pooch|samajh|experience|bookings|aate hain/i);

  const sessionMid = getSessionForPersistence(started.sessionId);
  assert.equal(sessionMid.pendingNameConfirmation?.name, "Pooja");
  assert.equal(sessionMid.answers.some((a) => a.questionId === "A2_NAME"), false);
  assert.equal(Object.keys(sessionMid.invalidAttempts || {}).length, 0, "Zero warnings for asking why name is requested");

  // Subsequent confirmation advances to A0
  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.question.id, "A0");
  assert.equal(confirmRes.body.candidateName, "Pooja");
});

test("Task 1 Regression 2: Natural affirmative confirmation variations reliably confirm name", async () => {
  const variations = [
    "Haan, yahi hai",
    "Haan, mera naam yahi hai",
    "Ji haan",
    "Haan ji, bilkul sahi",
    "Yes, that's my name",
    "Bilkul sahi hai",
  ];

  for (const phrase of variations) {
    const started = startInterview({ candidateId: `cand-aff-${phrase.slice(0, 5)}`, profileName: "Pooja Sharma" });
    const nameRes = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId: "A2_NAME",
      answer: "Pooja Sharma",
    });
    assert.equal(nameRes.status, 200);
    assert.equal(nameRes.body.question.id, "A2_NAME_CONFIRM");

    const confirmRes = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId: "A2_NAME_CONFIRM",
      answer: phrase,
    });
    assert.equal(confirmRes.status, 200, `Failed for phrase: ${phrase}`);
    assert.equal(confirmRes.body.nameConfirmed, true, `Expected nameConfirmed for: ${phrase}`);
    assert.equal(confirmRes.body.candidateName, "Pooja Sharma", `Expected candidateName preserved for: ${phrase}`);
    assert.equal(confirmRes.body.question.id, "A0", `Expected advance to A0 for: ${phrase}`);
  }
});

test("Task 1 Regression 3: Negative confirmation clears unconfirmed name and reprompts on A2_NAME", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Pooja Sharma",
  });

  const rejectRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Nahi, galat hai",
  });

  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.nameCorrectionRequired, true);
  assert.equal(rejectRes.body.question.id, "A2_NAME");
  const rawSession = getSessionForPersistence(started.sessionId);
  assert.equal(rawSession.candidateName, null);
  assert.equal(rawSession.pendingNameConfirmation, null);
});

test("Task 1 Regression 4: Explicit name correction updates pending name and prompts confirmation", async () => {
  const started = startInterview();
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Pooja",
  });

  const correctRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Nahi, mera naam Sunita hai",
  });

  assert.equal(correctRes.status, 200);
  assert.equal(correctRes.body.nameConfirmationRequired, true);
  assert.equal(correctRes.body.candidateName, "Sunita");
  assert.equal(correctRes.body.question.id, "A2_NAME_CONFIRM");
  assert.match(correctRes.body.message, /Sunita/);
});

test("Task 1 Regression 5: Registered name match proceeds to confirmation and interview progression", async () => {
  const started = startInterview({ candidateId: "cand-reg-match", profileName: "Pooja Sharma" });
  const nameRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Pooja Sharma",
  });

  assert.equal(nameRes.status, 200);
  assert.equal(nameRes.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(nameRes.body.candidateName, "Pooja Sharma");

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan, yahi hai",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.question.id, "A0");
  assert.equal(confirmRes.body.candidateName, "Pooja Sharma");
});

test("Task 1 Regression 6: Registered name mismatch gives warning on attempt 1, blocks and routes to manual_review on attempt 2", async () => {
  const started = startInterview({ candidateId: "cand-mismatch-1", profileName: "Pooja Sharma" });

  // Attempt 1: Candidate speaks a name that does not match registered profile
  const firstMismatchRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera naam Sunita hai",
  });

  assert.equal(firstMismatchRes.status, 200);
  assert.equal(firstMismatchRes.body.identityMismatchWarning, true);
  assert.equal(firstMismatchRes.body.warningLevel, 1);
  assert.equal(firstMismatchRes.body.question.id, "A2_NAME");
  assert.equal(firstMismatchRes.body.candidateName, "Pooja Sharma");
  assert.match(firstMismatchRes.body.message, /Pooja Sharma/i);

  const midSession = getSessionForPersistence(started.sessionId);
  assert.equal(midSession.status, "in_progress", "Attempt 1 warning keeps session in progress");
  assert.equal(midSession.identityMismatchAttempts, 1);
  assert.equal(midSession.candidateName, "Pooja Sharma", "Authoritative profile identity preserved");

  // Attempt 2: Second genuine mismatch routes to manual_review and blocks progression
  const secondMismatchRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita",
  });

  assert.equal(secondMismatchRes.status, 200);
  assert.equal(secondMismatchRes.body.identityVerificationFailed, true);
  assert.equal(secondMismatchRes.body.manualReviewRequired, true);
  assert.equal(secondMismatchRes.body.sessionStatus, "manual_review");
  assert.equal(secondMismatchRes.body.question.id, "A2_NAME_MISMATCH");
  assert.match(secondMismatchRes.body.message, /Pooja Sharma.*registered profile|Pooja Sharma ke registered profile/i);

  const rawSession = getSessionForPersistence(started.sessionId);
  assert.equal(rawSession.status, "manual_review");
  assert.equal(rawSession.identityVerificationFailed, true);
  assert.equal(rawSession.candidateName, "Pooja Sharma", "Authoritative profile identity preserved");
  assert.equal(rawSession.currentQuestionIndex, 0, "Question progression blocked");
});

test("Task 1 Regression 7: Candidate who corrects to registered name on retry after warning is accepted", async () => {
  const started = startInterview({ candidateId: "cand-correct-retry", profileName: "Pooja Sharma" });

  // Attempt 1: Mismatch triggers warning
  const warnRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita",
  });
  assert.equal(warnRes.status, 200);
  assert.equal(warnRes.body.identityMismatchWarning, true);
  assert.equal(warnRes.body.question.id, "A2_NAME");

  // Attempt 2: Candidate corrects with registered profile name
  const correctRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera naam Pooja Sharma hai",
  });
  assert.equal(correctRes.status, 200);
  assert.equal(correctRes.body.nameConfirmationRequired, true);
  assert.equal(correctRes.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(correctRes.body.candidateName, "Pooja Sharma");

  const rawSession = getSessionForPersistence(started.sessionId);
  assert.equal(rawSession.status, "in_progress");
  assert.equal(rawSession.identityMismatchAttempts, 0, "Mismatch attempts reset on correct answer");

  // Subsequent confirmation proceeds to A0
  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan, bilkul sahi",
  });
  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.question.id, "A0");
});

test("Task 1 Regression 7b: Conflicting surname is rejected as identity mismatch", async () => {
  const started = startInterview({ candidateId: "cand-conflict-surname", profileName: "Pooja Sharma" });

  // Candidate speaks same first name but different surname
  const conflictRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mera naam Pooja Verma hai",
  });
  assert.equal(conflictRes.status, 200);
  assert.equal(conflictRes.body.identityMismatchWarning, true, "Conflicting surname must NOT match");
  assert.equal(conflictRes.body.question.id, "A2_NAME");
});

test("Task 1 Regression 7c: Phonetic, honorific, and Devanagari variations match registered name without warning", async () => {
  // Phonetic spelling variation: Puja Sharma matches Pooja Sharma
  const session1 = startInterview({ candidateId: "cand-phonetic-1", profileName: "Pooja Sharma" });
  const res1 = await submitAnswer({
    sessionId: session1.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Puja Sharma",
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.body.nameConfirmationRequired, true);
  assert.equal(res1.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(res1.body.candidateName, "Pooja Sharma");

  // Honorific variation: Mrs Pooja Sharma / Pooja ji
  const session2 = startInterview({ candidateId: "cand-honorific-2", profileName: "Pooja Sharma" });
  const res2 = await submitAnswer({
    sessionId: session2.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Mrs Pooja Sharma",
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.nameConfirmationRequired, true);
  assert.equal(res2.body.question.id, "A2_NAME_CONFIRM");

  // Devanagari transliteration: पूजा शर्मा matches Pooja Sharma
  const session3 = startInterview({ candidateId: "cand-devanagari-3", profileName: "Pooja Sharma" });
  const res3 = await submitAnswer({
    sessionId: session3.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "पूजा शर्मा",
  });
  assert.equal(res3.status, 200);
  assert.equal(res3.body.nameConfirmationRequired, true);
  assert.equal(res3.body.question.id, "A2_NAME_CONFIRM");
});

test("Task 1 Regression 8: Missing registered identity does not silently permit the interview", async () => {
  // Session without profileName
  const started = startInterview({ candidateId: "cand-unregistered-no-profile" });
  assert.equal(started.question.id, "A2_NAME");

  const nameRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Pooja Sharma",
  });
  assert.equal(nameRes.status, 200);
  assert.equal(nameRes.body.question.id, "A2_NAME_CONFIRM");

  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan, yahi hai",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.question.id, "A0");

  const rawSession = getSessionForPersistence(started.sessionId);
  assert.equal(rawSession.manualReviewRequired, true, "Missing profile identity must flag manualReviewRequired");
  assert.match(rawSession.manualReviewReason, /Identity verification unconfirmed.*no registered profile/i);
});

test("Task 1 Regression 9: Candidate questions during confirmation preserve pending identity state", async () => {
  const started = startInterview({ candidateId: "cand-inquiry-1", profileName: "Pooja Sharma" });
  await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Pooja Sharma",
  });

  // Candidate asks why name is needed
  const inquiryRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Aap mera naam kyun pooch rahe ho?",
  });

  assert.equal(inquiryRes.status, 200);
  assert.equal(inquiryRes.body.counterQuestionHandled, true);
  assert.equal(inquiryRes.body.question.id, "A2_NAME_CONFIRM");

  const rawSession = getSessionForPersistence(started.sessionId);
  assert.equal(rawSession.pendingNameConfirmation?.name, "Pooja Sharma", "Pending identity preserved");
  assert.equal(rawSession.answers.some((a) => a.questionId === "A2_NAME"), false, "No premature persistence");
  assert.equal(Object.keys(rawSession.invalidAttempts || {}).length, 0, "No warning accrued");

  // Subsequent confirmation successfully advances to A0
  const confirmRes = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan, yahi hai",
  });

  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.nameConfirmed, true);
  assert.equal(confirmRes.body.question.id, "A0");
  assert.equal(confirmRes.body.candidateName, "Pooja Sharma");
});

test("Task 1 Extension: Name variations ('Rajesh', 'My name is Rajesh.', 'Mera naam Rajesh hai.', 'Pooja Sharma', 'Sunita', 'Haan, Rajesh.', 'Rajesh ji.') properly trigger confirmation", async () => {
  const testCases = [
    { input: "Rajesh", expected: "Rajesh" },
    { input: "My name is Rajesh.", expected: "Rajesh" },
    { input: "Mera naam Rajesh hai.", expected: "Rajesh" },
    { input: "Pooja Sharma", expected: "Pooja Sharma" },
    { input: "Sunita", expected: "Sunita" },
    { input: "Haan, Rajesh.", expected: "Rajesh" },
    { input: "Rajesh ji.", expected: "Rajesh" },
  ];

  for (const tc of testCases) {
    const started = startInterview();
    const res = await submitAnswer({
      sessionId: started.sessionId,
      expectedQuestionId: "A2_NAME",
      answer: tc.input,
    });

    assert.equal(res.status, 200, `Failed status for ${tc.input}`);
    assert.equal(res.body.nameConfirmationRequired, true, `Expected confirmation for ${tc.input}`);
    assert.equal(res.body.candidateName, tc.expected, `Expected candidateName ${tc.expected} for ${tc.input}`);
    assert.equal(res.body.question.id, "A2_NAME_CONFIRM", `Expected question A2_NAME_CONFIRM for ${tc.input}`);
    assert.match(res.body.question.text, new RegExp(tc.expected), `Expected confirm text to include ${tc.expected}`);
  }
});

test("Deterministic Production Candidate Verification: 'Aakash' registered profile from MongoDB", async () => {
  const candidateId = "044bf5cf-a429-45a2-9e80-7f949bad64a8";
  const profileName = "Aakash";

  const passingInputs = [
    { label: "exact registered name", input: "Aakash" },
    { label: "phonetic spelling", input: "Akash" },
    { label: "Devanagari exact", input: "आकाश" },
    { label: "Devanagari sentence", input: "मेरा नाम आकाश है" },
    { label: "English sentence", input: "My name is Aakash" },
    { label: "Hinglish sentence", input: "Mera naam Aakash hai" },
    { label: "full name with surname", input: "Aakash Maurya" },
    { label: "Devanagari full name", input: "आकाश मौर्य" },
    { label: "honorific suffix", input: "Aakash ji" },
    { label: "Devanagari honorific", input: "आकाश जी" },
    { label: "greeting prefix Hindi", input: "हाँ आकाश" },
    { label: "greeting prefix English", input: "Haan Aakash" },
  ];

  for (const tc of passingInputs) {
    const session = startInterview({ candidateId, profileName });
    const res = await submitAnswer({
      sessionId: session.sessionId,
      expectedQuestionId: "A2_NAME",
      answer: tc.input,
    });

    assert.equal(res.status, 200, `Failed for ${tc.label} ('${tc.input}')`);
    assert.equal(res.body.nameConfirmationRequired, true, `Must require confirmation for ${tc.label}`);
    assert.equal(res.body.question.id, "A2_NAME_CONFIRM", `Must be A2_NAME_CONFIRM for ${tc.label}`);
    assert.equal(res.body.candidateName, "Aakash", `Authoritative name must be Aakash for ${tc.label}`);
    assert.equal(res.body.identityMismatchWarning, undefined, `No warning allowed for ${tc.label}`);

    const raw = getSessionForPersistence(session.sessionId);
    assert.equal(raw.status, "in_progress", `Session must stay in_progress for ${tc.label}`);
    assert.equal(raw.identityMismatchAttempts, 0, `0 mismatch attempts for ${tc.label}`);
    assert.equal(raw.manualReviewRequired, false, `Must NOT require manual review for ${tc.label}`);
  }
});

test("Deterministic Production Candidate Verification: 'Om Agrawal' registered profile from MongoDB", async () => {
  const candidateId = "4655a487-aa1e-4c5d-8f2b-8dd23a4e59b3";
  const profileName = "Om Agrawal";

  const passingInputs = [
    { label: "exact registered full name", input: "Om Agrawal" },
    { label: "common Agarwal spelling variation", input: "Om Agarwal" },
    { label: "first name only", input: "Om" },
    { label: "Devanagari full name", input: "ओम अग्रवाल" },
    { label: "Devanagari first name", input: "ओम" },
    { label: "Devanagari sentence", input: "मेरा नाम ओम अग्रवाल है" },
    { label: "Hinglish sentence", input: "Mera naam Om Agrawal hai" },
    { label: "honorific prefix", input: "Shri Om Agrawal" },
    { label: "honorific suffix", input: "Om Agrawal ji" },
  ];

  for (const tc of passingInputs) {
    const session = startInterview({ candidateId, profileName });
    const res = await submitAnswer({
      sessionId: session.sessionId,
      expectedQuestionId: "A2_NAME",
      answer: tc.input,
    });

    assert.equal(res.status, 200, `Failed for ${tc.label} ('${tc.input}')`);
    assert.equal(res.body.nameConfirmationRequired, true, `Must require confirmation for ${tc.label}`);
    assert.equal(res.body.question.id, "A2_NAME_CONFIRM", `Must be A2_NAME_CONFIRM for ${tc.label}`);
    assert.equal(res.body.candidateName, "Om Agrawal", `Authoritative name must be Om Agrawal for ${tc.label}`);
    assert.equal(res.body.identityMismatchWarning, undefined, `No warning allowed for ${tc.label}`);

    const raw = getSessionForPersistence(session.sessionId);
    assert.equal(raw.status, "in_progress", `Must stay in_progress for ${tc.label}`);
    assert.equal(raw.identityMismatchAttempts, 0, `0 mismatch attempts for ${tc.label}`);
    assert.equal(raw.manualReviewRequired, false, `Must NOT require manual review for ${tc.label}`);
  }
});

test("Deterministic Two-Stage Mismatch: Genuine mismatch warns on attempt 1, manual review on attempt 2, retry succeeds", async () => {
  const candidateId = "044bf5cf-a429-45a2-9e80-7f949bad64a8";
  const profileName = "Aakash";

  // Scenario 1: Retry with correct name after warning succeeds
  const session1 = startInterview({ candidateId, profileName });
  const attempt1 = await submitAnswer({
    sessionId: session1.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita",
  });
  assert.equal(attempt1.status, 200);
  assert.equal(attempt1.body.identityMismatchWarning, true);
  assert.equal(attempt1.body.warningLevel, 1);
  assert.equal(attempt1.body.question.id, "A2_NAME");
  assert.equal(getSessionForPersistence(session1.sessionId).status, "in_progress");

  // Correct retry with Hindi Devanagari name
  const retryCorrect = await submitAnswer({
    sessionId: session1.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "मेरा नाम आकाश है",
  });
  assert.equal(retryCorrect.status, 200);
  assert.equal(retryCorrect.body.nameConfirmationRequired, true);
  assert.equal(retryCorrect.body.question.id, "A2_NAME_CONFIRM");
  assert.equal(retryCorrect.body.candidateName, "Aakash");
  assert.equal(getSessionForPersistence(session1.sessionId).status, "in_progress");
  assert.equal(getSessionForPersistence(session1.sessionId).identityMismatchAttempts, 0);

  // Scenario 2: Two consecutive wrong names route to manual review
  const session2 = startInterview({ candidateId, profileName });
  await submitAnswer({
    sessionId: session2.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita",
  });
  const attempt2Wrong = await submitAnswer({
    sessionId: session2.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Pooja",
  });
  assert.equal(attempt2Wrong.status, 200);
  assert.equal(attempt2Wrong.body.identityVerificationFailed, true);
  assert.equal(attempt2Wrong.body.manualReviewRequired, true);
  assert.equal(attempt2Wrong.body.sessionStatus, "manual_review");
  assert.equal(attempt2Wrong.body.question.id, "A2_NAME_MISMATCH");
  assert.equal(getSessionForPersistence(session2.sessionId).status, "manual_review");
  assert.equal(getSessionForPersistence(session2.sessionId).candidateName, "Aakash");
});

test("Regression: Identity warning text and payload integrity for spoken dialogue", async () => {
  const candidateId = "c-aakash-reg-test";
  const profileName = "Aakash";
  const session = startInterview({ candidateId, profileName });

  const mismatchRes = await submitAnswer({
    sessionId: session.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Pooja",
  });

  assert.equal(mismatchRes.status, 200);
  assert.equal(mismatchRes.body.identityMismatchWarning, true);
  assert.equal(mismatchRes.body.warningLevel, 1);
  assert.equal(
    mismatchRes.body.question.text,
    "Ye interview Aakash ke naam par registered hai. Kripya apna registered naam dobara spasht batayein."
  );
  assert.equal(mismatchRes.body.question.id, "A2_NAME");
});




