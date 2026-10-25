const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyConsent } = require("./rules/consentRules");
const { evaluateAge } = require("./rules/ageRules");
const { classifyLocation } = require("./rules/locationRules");

const {
  startInterview,
  submitAnswer,
  getReport,
  getTotalQuestions,
} = require("./interview");


test("Consent: accepts a clear yes", () => {
  assert.equal(classifyConsent("Haan"), "accepted");
});

test("Consent: identifies refusal", () => {
  assert.equal(classifyConsent("Nahi, main agree nahi karti"), "refused");
});

test("Consent: identifies unclear response", () => {
  assert.equal(classifyConsent("Pata nahi."), "unclear");
});

test("Age: accepts an eligible age", () => {
  const result = evaluateAge("25");

  assert.equal(result.outcome, "pass");
});

test("Age: flags age 39 for manual review", () => {
  const result = evaluateAge("39");

  assert.equal(result.outcome, "manual_review");
});


test("Interview: underage candidate is rejected", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const locationResult = submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  // Agar location follow-up aaye, toh usko handle karo.
  let result = locationResult;

  if (result.body.followUpRequired) {
    result = submitAnswer({
      sessionId: started.sessionId,
      answer: "Nahi, main travel nahi kar sakti",
    });
  }

  // Age question tak pahunchna verify karo.
  assert.equal(result.body.question.id, "A2");

  result = submitAnswer({
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
  assert.ok(result.question);
});

test("Interview: accepted consent moves to location question", () => {
  const started = startInterview();

  const result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.consentOutcome, "accepted");
  assert.equal(result.body.question.id, "A1");
});

test("Interview: refused consent routes to manual review", () => {
  const started = startInterview();

  const result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Nahi, main agree nahi karti",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.completed, true);
  assert.equal(result.body.sessionStatus, "manual_review");
  assert.equal(result.body.consentOutcome, "refused");
});

test("Interview: report contains the consent answer", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const result = getReport(started.sessionId);

  assert.equal(result.status, 200);
  assert.equal(result.body.report.consentOutcome, "accepted");
  assert.equal(result.body.report.answeredQuestions, 1);
});




test("Interview: unclear consent repeats the same question", () => {
  const started = startInterview();

  const result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Pata nahi.",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.clarificationRequired, true);
  assert.equal(result.body.question.id, "A0");
});

test("Interview: unclear location asks for clarification", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Pata nahi.",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.clarificationRequired, true);
  assert.equal(result.body.question.id, "A1");
});


test("Interview: willing candidate gets relocation timeline follow-up", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const locationResult = submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel kar sakti hoon",
  });

  assert.equal(locationResult.status, 200);
  assert.equal(locationResult.body.followUpRequired, true);

  // Answer the travel willingness clarification if required.
  let result = locationResult;

  if (result.body.followUp?.type === "travel_clarification") {
    result = submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan, main travel kar sakti hoon",
    });
  }

  assert.equal(result.body.followUpRequired, true);
  assert.equal(result.body.followUp.type, "move_timeline");

  const timelineResult = submitAnswer({
    sessionId: started.sessionId,
    answer: "Ek mahine mein",
  });

  assert.equal(timelineResult.status, 200);
  assert.equal(timelineResult.body.followUpCaptured, true);
});

test("Interview: unwilling candidate moves to the next question", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  const locationResult = submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, sirf apne area mein kaam kar sakti hoon",
  });

  let result = locationResult;

  if (result.body.followUp?.type === "travel_clarification") {
    result = submitAnswer({
      sessionId: started.sessionId,
      answer: "Nahi, main travel nahi kar sakti",
    });
  }

  assert.equal(result.status, 200);
  assert.equal(result.body.completed, false);
  assert.equal(result.body.question.id, "A2");
});

test("Interview: relocation timeline is saved in the report", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel kar sakti hoon",
  });

  if (result.body.followUp?.type === "travel_clarification") {
    result = submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan, main travel kar sakti hoon",
    });
  }

  if (result.body.followUp?.type === "move_timeline") {
    submitAnswer({
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



test("Interview: location answer is flagged for manual review", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  const result = getReport(started.sessionId);
  const report = result.body.report;

  assert.equal(result.status, 200);
  assert.equal(report.locationOutcome, "manual_review");
  assert.ok(report.manualChecks.some((item) => item.questionId === "A1"));
});

test("Interview: report records manual-review details after travel follow-up", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel kar sakti hoon",
  });

  if (result.body.followUp?.type === "travel_clarification") {
    result = submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan, main travel kar sakti hoon",
    });
  }

  if (result.body.followUp?.type === "move_timeline") {
    submitAnswer({
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

test("Interview: unclear relocation timeline does not silently advance", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi, main travel kar sakti hoon",
  });

  if (result.body.followUp?.type === "travel_clarification") {
    result = submitAnswer({
      sessionId: started.sessionId,
      answer: "Haan, main travel kar sakti hoon",
    });
  }

  assert.equal(result.body.followUp?.type, "move_timeline");

  const timelineResult = submitAnswer({
    sessionId: started.sessionId,
    answer: "Pata nahi",
  });

  // This is the intended requirement; implementation may fail initially.
  assert.equal(timelineResult.body.clarificationRequired, true);
  assert.equal(timelineResult.body.followUpRequired, true);
  assert.equal(timelineResult.body.question.id, "A1_MOVE_TIMELINE");
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



test("Interview: eligible age continues to the next question", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  if (result.body.followUpRequired) {
    result = submitAnswer({
      sessionId: started.sessionId,
      answer: "Nahi, main travel nahi kar sakti",
    });
  }

  assert.equal(result.body.question.id, "A2");

  result = submitAnswer({
    sessionId: started.sessionId,
    answer: "25",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.completed, false);
  assert.equal(result.body.eligibilityOutcome, "pass");
  assert.equal(result.body.question.id, "A3");
});

test("Interview: age 39 is saved for manual review", () => {
  const started = startInterview();

  submitAnswer({
    sessionId: started.sessionId,
    answer: "Haan",
  });

  let result = submitAnswer({
    sessionId: started.sessionId,
    answer: "Delhi",
  });

  if (result.body.followUpRequired) {
    result = submitAnswer({
      sessionId: started.sessionId,
      answer: "Nahi, main travel nahi kar sakti",
    });
  }

  assert.equal(result.body.question.id, "A2");

  result = submitAnswer({
    sessionId: started.sessionId,
    answer: "39",
  });

  const report = getReport(started.sessionId).body.report;

  assert.equal(result.body.eligibilityOutcome, "manual_review");
  assert.equal(result.body.manualReviewRequired, true);
  assert.equal(report.eligibilityOutcome, "manual_review");
});