const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyConsent } = require("./rules/consentRules");
const { evaluateAge } = require("./rules/ageRules");
const { classifyLocation } = require("./rules/locationRules");
const { fallbackInterpretation } = require("./geminiService");
const activeQuestionBank = require("../data/questionBank.json");
const workbookQuestionMapping = require(
  "../data/workbook-reference/UC_question_bank_exact_workbook_mapping.json",
);

const {
  startInterview,
  submitAnswer,
  getReport,
  getTotalQuestions,
} = require("./interview");

const householdQuestion =
  "Apne ghar ke baare mein thoda bataiye — ghar mein kaun kaun hai, aur din bhar kaun kya karta hai?";

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

test("Interview: captures name, obtains consent, then progresses through A1, A2, and A3", async () => {
  for (const name of ["Sunita", "Mera naam Sunita hai"]) {
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
