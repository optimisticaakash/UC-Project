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
  endInterview,
  getTotalQuestions,
  flagManualReview,
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
  const started = startInterview();

  for (const answer of [
    "",
    "Pata nahi",
    "Mera naam kya hai",
    "Mera naam nahi pata",
  ]) {
    const result = await submitAnswer({ sessionId: started.sessionId, answer });
    assert.equal(result.status, 200);
    assert.equal(result.body.clarificationRequired, true);
    assert.equal(result.body.question.id, "A2_NAME");
  }

  assert.equal(getReport(started.sessionId).body.report.answeredQuestions, 0);
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
