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
  assert.equal(nameResult.body.question.id, "A0");
  assert.equal(nameResult.body.candidateName, "Sunita");
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
    assert.equal(result.body.question.id, "A0");
    const report = getReport(started.sessionId).body.report;
    assert.equal(
      report.answers.find((item) => item.questionId === "A2_NAME")?.answer,
      name,
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
  assert.equal(accepted.body.question.id, "A0");
});

test("Interview: stale A2_NAME submission after progression cannot answer A0", async () => {
  const started = startInterview();
  const acceptedName = await submitAnswer({
    sessionId: started.sessionId,
    answer: "Sunita",
    expectedQuestionId: "A2_NAME",
    diagnosticRequestId: "p1-a1",
  });
  assert.equal(acceptedName.body.question.id, "A0");

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

  // Valid name advances to A0
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Priya",
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

  // Real name is accepted
  res = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita Verma",
  });
  assert.equal(res.body.question.id, "A0");
  assert.equal(res.body.candidateName, "Sunita Verma");
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

  // Attempt 2: valid name -> succeeds and advances to A0
  const res2 = await submitAnswer({
    sessionId: started.sessionId,
    expectedQuestionId: "A2_NAME",
    answer: "Anjali",
  });
  assert.equal(res2.status, 200);
  assert.equal(Boolean(res2.body.clarificationRequired), false);
  assert.equal(res2.body.question.id, "A0");

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
  assert.equal(resName2.body.question.id, "A0");

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
    assert.equal(res.body.question.id, "A0");
    assert.equal(res.body.candidateName, expectedName, `Expected candidate name '${expectedName}' for input '${input}', got '${res.body.candidateName}'`);
    assert.ok(res.body.acknowledgement, "Response must include an acknowledgement");
    assert.match(res.body.acknowledgement, new RegExp(expectedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

