const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const {
  startInterview,
  submitAnswer,
  getActiveInquiry,
  getSessionForPersistence,
} = require("./interview");

// Helper to progress interview to A1_TRAVEL_RELOCATION
async function reachA1Question({ language = "Hindi" } = {}) {
  const started = startInterview({ candidateName: "Pooja Sharma" });
  const sId = started.sessionId;

  // A2_NAME
  const rName = await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  assert.equal(rName.status, 200);

  // A2_NAME_CONFIRM
  const rConfirm = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: language === "English" ? "Yes, correct" : "Haan, bilkul",
  });
  assert.equal(rConfirm.status, 200);

  // A0 (Consent)
  const rConsent = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: language === "English" ? "Yes I agree, please continue in English" : "Haan main taiyaar hoon",
  });
  assert.equal(rConsent.status, 200);
  assert.equal(rConsent.body.question.id, "A1");

  const session = getSessionForPersistence(sId);
  if (language === "English") {
    session.language = "English";
  }

  return { sId, pendingQuestion: rConsent.body.question };
}

test("Scenario A: Single doubt then exact assessment question resumption", async () => {
  const { sId, pendingQuestion } = await reachA1Question();
  const sessionBefore = getSessionForPersistence(sId);
  const qIndexBefore = sessionBefore.currentQuestionIndex;
  const answersCountBefore = sessionBefore.answers.length;

  // Candidate asks clarification doubt
  const rDoubt = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Mujhe kahan travel ya relocate karna padega?",
  });

  assert.equal(rDoubt.status, 200);
  assert.equal(rDoubt.body.counterQuestionHandled, true);
  assert.equal(rDoubt.body.question.id, pendingQuestion.id, "Question ID must remain unchanged");
  assert.equal(rDoubt.body.questionNumber, qIndexBefore + 1, "Question number must not advance");

  let inq = getActiveInquiry(sId);
  assert.ok(inq, "Active inquiry must be created");
  assert.equal(inq.turnCount, 1);

  // Candidate confirms doubt is resolved: "Samajh gaya, theek hai"
  const rConfirm = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Samajh gaya, theek hai",
  });

  assert.equal(rConfirm.status, 200);
  assert.equal(rConfirm.body.counterQuestionHandled, true);
  assert.equal(rConfirm.body.question.id, pendingQuestion.id, "Question ID must still be pending question");
  assert.ok(rConfirm.body.message.includes(pendingQuestion.text), "Message must resume exact pending question text");

  // Verify integrity
  inq = getActiveInquiry(sId);
  assert.equal(inq, null, "Active inquiry should be closed after confirmation");
  const sessionAfter = getSessionForPersistence(sId);
  assert.equal(sessionAfter.currentQuestionIndex, qIndexBefore, "Question index must not advance during inquiry");
  assert.equal(sessionAfter.answers.length, answersCountBefore, "Inquiry turns must not be recorded in answers");
  assert.equal(sessionAfter.status, "in_progress", "Session status must remain in_progress");
});

test("Scenario B: Multi-turn inquiry does not repeatedly append question, then resumes exact question", async () => {
  const { sId, pendingQuestion } = await reachA1Question();
  const sessionBefore = getSessionForPersistence(sId);
  const qIndexBefore = sessionBefore.currentQuestionIndex;
  const answersCountBefore = sessionBefore.answers.length;

  // Turn 1: Candidate asks doubt 1
  const rTurn1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Kya mujhe training milegi?",
  });
  assert.equal(rTurn1.status, 200);
  assert.equal(rTurn1.body.counterQuestionHandled, true);
  let inq = getActiveInquiry(sId);
  assert.ok(inq);
  assert.equal(inq.turnCount, 1);

  // Turn 2: Candidate asks follow-up doubt without confirming
  const rTurn2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Training kitne din ki hogi aur kahan par hogi?",
  });
  assert.equal(rTurn2.status, 200);
  assert.equal(rTurn2.body.counterQuestionHandled, true);
  assert.equal(rTurn2.body.question.id, pendingQuestion.id);
  inq = getActiveInquiry(sId);
  assert.equal(inq.turnCount, 2);

  // Requirement: Do NOT repeatedly re-append the pending question text on ongoing follow-up inquiry turns
  assert.equal(
    rTurn2.body.message.endsWith(pendingQuestion.text),
    false,
    "Ongoing follow-up turn should not repeatedly append the pending question text",
  );

  // Turn 3: Candidate asks another follow-up doubt
  const rTurn3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Kya training ke dauran koi fees deni hogi?",
  });
  assert.equal(rTurn3.status, 200);
  assert.equal(rTurn3.body.counterQuestionHandled, true);
  inq = getActiveInquiry(sId);
  assert.equal(inq.turnCount, 3);
  assert.equal(
    rTurn3.body.message.endsWith(pendingQuestion.text),
    false,
    "Third follow-up turn should not repeatedly append pending question",
  );

  // Turn 4: Candidate confirms: "Theek hai, aage badhiye"
  const rResume = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Theek hai, aage badhiye",
  });
  assert.equal(rResume.status, 200);
  assert.equal(rResume.body.counterQuestionHandled, true);
  assert.equal(rResume.body.question.id, pendingQuestion.id);
  assert.ok(
    rResume.body.message.includes(pendingQuestion.text),
    "Confirmation must cleanly resume the exact pending assessment question",
  );

  // Integrity checks
  assert.equal(getActiveInquiry(sId), null);
  const sessionAfter = getSessionForPersistence(sId);
  assert.equal(sessionAfter.currentQuestionIndex, qIndexBefore);
  assert.equal(sessionAfter.answers.length, answersCountBefore);
  assert.equal(sessionAfter.status, "in_progress");
});

test("Scenario C: Topic change during active inquiry preserves context and pending question", async () => {
  const { sId, pendingQuestion } = await reachA1Question();

  // Topic 1: travel / location
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Kaam kis area mein hoga?",
  });
  assert.equal(r1.status, 200);
  let inq = getActiveInquiry(sId);
  assert.ok(inq);

  // Topic 2: payouts / earnings (topic change)
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Earnings aur payment schedule kya rehta hai?",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.counterQuestionHandled, true);
  assert.equal(r2.body.question.id, pendingQuestion.id);
  inq = getActiveInquiry(sId);
  assert.equal(inq.turnCount, 2);

  // Candidate resolves: "Ab clear hai, sawal poochiye"
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Ab clear hai, aage badhiye",
  });
  assert.equal(r3.status, 200);
  assert.ok(r3.body.message.includes(pendingQuestion.text));
  assert.equal(r3.body.question.id, pendingQuestion.id);
});

test("Scenario E: Candidate answers pending question directly after explanation without explicit confirmation", async () => {
  const { sId, pendingQuestion } = await reachA1Question();
  const sessionBefore = getSessionForPersistence(sId);
  const answersCountBefore = sessionBefore.answers.length;

  // Candidate asks a doubt
  const rDoubt = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Kaam kahan par karna hoga?",
  });
  assert.equal(rDoubt.status, 200);
  assert.equal(rDoubt.body.counterQuestionHandled, true);
  assert.ok(getActiveInquiry(sId));

  // Candidate immediately provides valid assessment answer:
  const rAnswer = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Main Koramangala Bangalore mein rehti hoon.",
  });

  assert.equal(rAnswer.status, 200);
  // Must be accepted as assessment answer and not treated as inquiry
  assert.equal(rAnswer.body.counterQuestionHandled, undefined, "Direct answer must not be treated as inquiry");
  const sessionAfter = getSessionForPersistence(sId);
  assert.equal(sessionAfter.answers.length, answersCountBefore + 1, "Answer must be recorded in session answers");
  const recordedA1 = sessionAfter.answers.find((a) => a.questionId === pendingQuestion.id);
  assert.ok(recordedA1, "A1 answer must be present");
  assert.equal(recordedA1.location, "Main Koramangala Bangalore mein rehti hoon.");
  assert.equal(getActiveInquiry(sId), null, "Active inquiry must be cleared");
});

test("Repeat question intent during active inquiry resets inquiry and returns exact question", async () => {
  const { sId, pendingQuestion } = await reachA1Question();

  // Candidate asks a doubt
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Training kahan hogi?",
  });
  assert.ok(getActiveInquiry(sId));

  // Candidate asks to repeat the question: "Sawal kya tha, dobara bataiye"
  const rRepeat = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Sawal kya tha, dobara bataiye",
  });

  assert.equal(rRepeat.status, 200);
  assert.equal(rRepeat.body.counterQuestionHandled, true);
  assert.ok(rRepeat.body.message.includes(pendingQuestion.text), "Must repeat exact pending question text");
  assert.equal(rRepeat.body.question.id, pendingQuestion.id);
  assert.equal(getActiveInquiry(sId), null, "Inquiry must be cleared when question is explicitly repeated");
});

test("Inquiry dialogue does not increment invalidAttempts or trigger scoring", async () => {
  const { sId, pendingQuestion } = await reachA1Question();

  // Turn 1: doubt
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Kaam kahan karna hoga?",
  });

  let session = getSessionForPersistence(sId);
  const attempts = session.invalidAttempts || {};
  assert.equal(attempts[pendingQuestion.id] || 0, 0, "Inquiry must not increment invalidAttempts");

  // Turn 2: follow-up doubt
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Uniform khud khareedna padega kya?",
  });

  session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})[pendingQuestion.id] || 0, 0, "Follow-up must not increment invalidAttempts");
  assert.equal(session.scores, undefined, "Scoring must not be triggered during inquiry");
});

test("Issue 2: Composite location answer and inquiry on A1 resolves inquiry without auto-advancing", async () => {
  const { sId, pendingQuestion } = await reachA1Question();
  assert.equal(pendingQuestion.id, "A1");

  // Candidate: "Main Bangalore mein nahi, Delhi mein rehta hoon. Kya Bangalore mein rehna zaroori hai?"
  const rInquiry = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Main Bangalore mein nahi, Delhi mein rehta hoon. Kya Bangalore mein rehna zaroori hai?",
  });

  assert.equal(rInquiry.status, 200);
  assert.equal(rInquiry.body.completed, false);
  assert.equal(rInquiry.body.counterQuestionHandled, true);
  assert.equal(rInquiry.body.question.id, "A1", "Must stay on A1, not advance to A2 or travel clarification");
  assert.ok(
    /onboarding\s+team/i.test(rInquiry.body.message),
    "Must state that cross-city eligibility and relocation requirements are confirmed by the onboarding team"
  );
  assert.equal(
    /\b(?:padega|karna\s+padega|mandatory|compulsory|must\s+relocate|must\s+travel)\b/i.test(rInquiry.body.message),
    false,
    "Must never present unverified relocation requirements as confirmed policy"
  );
  assert.ok(
    /Bangalore.*(?:open|prefer|sheher)|current\s+city/i.test(rInquiry.body.message),
    "Must ask a neutral clarification regarding working in Bangalore or current city"
  );

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0, "Must not count invalid attempts");
  assert.equal(session.candidateCity, "Delhi", "Must preserve candidate's stated city Delhi");
  assert.equal(session.currentQuestionIndex, 2, "Must not advance question index");
});

test("Issue 2: English composite location answer and inquiry on A1 defers cross-city policy to onboarding team without mandating relocation", async () => {
  const { sId } = await reachA1Question({ language: "English" });

  const rInquiry = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "I do not live in Bangalore, I stay in Delhi. Do I have to live in Bangalore?",
  });

  assert.equal(rInquiry.status, 200);
  assert.equal(rInquiry.body.completed, false);
  assert.equal(rInquiry.body.counterQuestionHandled, true);
  assert.equal(rInquiry.body.question.id, "A1", "Must stay on A1");
  assert.ok(
    /onboarding\s+team/i.test(rInquiry.body.message),
    "Must state cross-city requirements are confirmed by the onboarding team"
  );
  assert.equal(
    /\b(?:mandatory|compulsory|must\s+relocate|must\s+travel|have\s+to\s+relocate|requires\s+being\s+able\s+to\s+travel)\b/i.test(rInquiry.body.message),
    false,
    "Must not claim relocation is mandatory"
  );
  assert.ok(
    /open\s+to\s+working\s+in\s+Bangalore|prefer\s+your\s+current\s+city/i.test(rInquiry.body.message),
    "Must ask neutral clarification"
  );

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
  assert.equal(session.candidateCity, "Delhi", "Must preserve candidate's stated city Delhi in English turn");
  assert.equal(session.currentQuestionIndex, 2);
});
