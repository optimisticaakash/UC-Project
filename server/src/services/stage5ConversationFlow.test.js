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

  // Step 6: Candidate indicates doubt is resolved: "Samajh gaya, theek hai"
  const rConfirm = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Samajh gaya, theek hai",
  });

  assert.equal(rConfirm.status, 200);
  assert.equal(rConfirm.body.counterQuestionHandled, true);
  assert.equal(rConfirm.body.question.id, pendingQuestion.id, "Question ID must still be pending question");
  assert.match(rConfirm.body.message, /aage badhayein|continue/i, "Must ask whether to proceed before resuming");

  // Step 7: Candidate confirms proceeding: "Haan"
  const rProceed = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: pendingQuestion.id,
    answer: "Haan",
  });

  assert.equal(rProceed.status, 200);
  assert.equal(rProceed.body.counterQuestionHandled, true);
  assert.equal(rProceed.body.question.id, pendingQuestion.id, "Question ID must still be pending question");
  assert.ok(rProceed.body.message.includes(pendingQuestion.text), "Message must resume exact pending question text");

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

// ============================================================================
// Issue 1 Tests: General Knowledge & Multi-Turn Contextual Follow-ups
// ============================================================================

test("Issue 1: Candidate asks GK question 'Cloud computing kya hai?' on assessment question", async () => {
  const { sId, pendingQuestion } = await reachA1Question();

  // Candidate asks GK question instead of answering location
  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hai?",
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.completed, false);
  assert.equal(res.body.counterQuestionHandled, true);
  assert.equal(res.body.question.id, "A1", "Must preserve pending question A1");
  assert.match(res.body.message, /cloud/i, "Must provide explanation of cloud computing");

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0, "Must not count GK question as invalid attempt");
  const activeInquiry = getActiveInquiry(sId);
  assert.ok(activeInquiry, "Must maintain active inquiry");
  assert.equal(activeInquiry.currentTopic, "general_knowledge");
});

test("Issue 1: Multi-turn GK inquiry with pronoun follow-ups ('Iska example', 'Aur iska benefit?', 'Ye kaise work karta hai?')", async () => {
  const { sId } = await reachA1Question();

  // Turn 1: Initial GK Question
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hai?",
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.counterQuestionHandled, true);

  // Turn 2: Follow-up asking for example with pronoun 'iska'
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska example batao.",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.counterQuestionHandled, true);
  assert.equal(r2.body.question.id, "A1", "Must stay on A1");
  assert.match(r2.body.message, /example|drive|storage/i, "Must provide example for cloud computing");
  // In multi-turn active inquiry, pending question is not re-appended repeatedly on every turn
  assert.doesNotMatch(r2.body.message, /onboarding team/i, "Must not defer GK example to onboarding team");

  // Turn 3: Follow-up asking for benefit
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Aur iska benefit kya hai?",
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.counterQuestionHandled, true);
  assert.equal(r3.body.question.id, "A1", "Must stay on A1");
  assert.match(r3.body.message, /benefit|fayda|access|data/i, "Must explain benefits");

  // Turn 4: Contextual follow-up 'Ye kaise work karta hai?'
  const r4 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Ye kaise work karta hai?",
  });
  assert.equal(r4.status, 200);
  assert.equal(r4.body.counterQuestionHandled, true);
  assert.equal(r4.body.question.id, "A1", "Must stay on A1");

  // Turn 5: Step 6 - Candidate signals doubt resolution, AI asks if we should proceed
  const r5 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Samajh gaya, clear hai.",
  });
  assert.equal(r5.status, 200);
  assert.equal(r5.body.counterQuestionHandled, true);
  assert.match(r5.body.message, /aage badhayein|continue/i, "Must ask whether to proceed before resuming");

  // Turn 6: Step 7 - Candidate confirms, AI cleanly resumes exact pending question
  const r6 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, bilkul.",
  });
  assert.equal(r6.status, 200);
  assert.equal(r6.body.counterQuestionHandled, true);
  assert.match(r6.body.message, /wapas aate hain/i, "Must acknowledge and resume pending question");
  assert.equal(getActiveInquiry(sId), null, "Inquiry resolved");

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0, "No invalid attempt strikes");
  assert.equal(session.currentQuestionIndex, 2);
});

test("Issue 1: Candidate switches topic between GK questions without losing assessment state", async () => {
  const { sId } = await reachA1Question();

  // Initial GK question
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hai?",
  });

  // Candidate switches topic to AI vs ML
  const rSwitch = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "AI aur machine learning mein kya difference hai?",
  });

  assert.equal(rSwitch.status, 200);
  assert.equal(rSwitch.body.counterQuestionHandled, true);
  assert.equal(rSwitch.body.question.id, "A1", "Must preserve question A1");
  assert.match(rSwitch.body.message, /AI|machine learning|learn/i, "Must answer the new GK question");

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
});

test("Issue 1: English GK inquiries and examples", async () => {
  const { sId } = await reachA1Question({ language: "English" });

  // English GK question
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "What is cloud computing?",
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.counterQuestionHandled, true);
  assert.match(r1.body.message, /cloud computing/i);

  // English follow-up
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Can you give an example?",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.counterQuestionHandled, true);
  assert.match(r2.body.message, /example|drive|storage/i);

  // Another English GK question
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "How does the internet work?",
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.counterQuestionHandled, true);
  assert.match(r3.body.message, /internet|network|packet/i);

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
});

test("Issue 1 & 2: Comprehensive 7-step conversation lifecycle for General Knowledge interruption ('Cloud computing kya hoti hai?')", async () => {
  // Step 1: Pending question state (active assessment question A1)
  const { sId, pendingQuestion } = await reachA1Question();
  assert.equal(pendingQuestion.id, "A1");

  // Step 2 & 3 & 4: Candidate interrupts with 'Cloud computing kya hoti hai?'
  // - System recognizes as inquiry/CANDIDATE_QUESTION
  // - Pending question remains active
  // - Speaks the answer and asks clarification check
  // - Does NOT append pending question text
  const rDoubt = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hoti hai?",
  });

  assert.equal(rDoubt.status, 200);
  assert.equal(rDoubt.body.counterQuestionHandled, true);
  assert.equal(rDoubt.body.question.id, "A1", "Pending question remains A1");
  assert.match(rDoubt.body.message, /cloud/i, "Must contain cloud computing explanation");
  assert.match(rDoubt.body.message, /doubt clear|kuch aur poochna/i, "Step 4: Must ask clarification check");
  assert.equal(rDoubt.body.message.includes(pendingQuestion.text), false, "Must NOT append pending assessment question");
  assert.equal(rDoubt.body.inquiryState, "clarification_check");

  // Step 5: Candidate asks chained follow-up questions
  // 5a: 'Iska example batao'
  const rExample = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska example batao.",
  });
  assert.equal(rExample.status, 200);
  assert.equal(rExample.body.counterQuestionHandled, true);
  assert.match(rExample.body.message, /example|drive|storage/i);
  assert.match(rExample.body.message, /doubt clear|kuch aur poochna/i, "Must repeat clarification check");
  assert.equal(rExample.body.message.includes(pendingQuestion.text), false);

  // 5b: 'Aur iska benefit kya hai?'
  const rBenefit = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Aur iska benefit kya hai?",
  });
  assert.equal(rBenefit.status, 200);
  assert.equal(rBenefit.body.counterQuestionHandled, true);
  assert.match(rBenefit.body.message, /benefit|fayda|access|data/i);
  assert.match(rBenefit.body.message, /doubt clear|kuch aur poochna/i);
  assert.equal(rBenefit.body.message.includes(pendingQuestion.text), false);

  // 5c: Topic switch to AI vs ML
  const rSwitch = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "AI aur machine learning mein kya difference hai?",
  });
  assert.equal(rSwitch.status, 200);
  assert.equal(rSwitch.body.counterQuestionHandled, true);
  assert.match(rSwitch.body.message, /AI|machine learning|learn/i);
  assert.match(rSwitch.body.message, /doubt clear|kuch aur poochna/i);
  assert.equal(rSwitch.body.message.includes(pendingQuestion.text), false);

  // Step 6: Inquiry closure signal - candidate says doubt is clear
  // AI must explicitly ask whether to proceed, and NOT resume immediately
  const rClear = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Doubt clear ho gaya, samajh gaya.",
  });
  assert.equal(rClear.status, 200);
  assert.equal(rClear.body.counterQuestionHandled, true);
  assert.match(rClear.body.message, /aage badhayein|continue/i, "Step 6: AI must ask whether to proceed");
  assert.equal(rClear.body.inquiryState, "ready_to_resume");
  assert.equal(rClear.body.message.includes(pendingQuestion.text), false, "Must not resume before candidate confirms");

  // Step 7: Assessment resumption - candidate confirms proceeding
  const rResume = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, aage badhiye.",
  });
  assert.equal(rResume.status, 200);
  assert.equal(rResume.body.counterQuestionHandled, true);
  assert.ok(rResume.body.message.includes(pendingQuestion.text), "Step 7: Resumes exact pending assessment question");
  assert.match(rResume.body.message, /wapas aate hain/i);
  assert.equal(getActiveInquiry(sId), null, "Inquiry closed after resumption");

  const sessionFinal = getSessionForPersistence(sId);
  assert.deepEqual(sessionFinal.invalidAttempts || {}, {}, "Zero invalid attempt penalties across entire 7-step exchange");
  assert.equal(sessionFinal.currentQuestionIndex, 2, "Question index remained on A1");
});

// ============================================================================
// Issue 2 Tests: Travel and Relocation Follow-up Intelligence
// ============================================================================

test("Issue 2: Delhi candidate asks about Bangalore relocation and states current-city preference", async () => {
  const { sId } = await reachA1Question();

  // Turn 1: Candidate asks if shifting to Bangalore is mandatory
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Bangalore shift hona zaroori hai kya?",
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.counterQuestionHandled, true);
  assert.match(r1.body.message, /onboarding team/i, "Must state onboarding team confirms requirements");
  assert.match(r1.body.message, /Bangalore.*(?:open|prefer|sheher)|current\s+city/i, "Must probe for preference");

  // Turn 2: Candidate answers probe stating current city preference
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Main Delhi mein hi kaam karna chahta hoon.",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.counterQuestionHandled, true);
  assert.match(r2.body.message, /Delhi.*preference|samajh gayi/i, "Must acknowledge preference for Delhi");
  assert.match(r2.body.message, /wapas aate hain/i, "Must resume exact pending question");

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0, "No invalid attempt strikes");
  assert.equal(session.shortTermMemory?.facts?.cityPreference, "Delhi", "City preference stored in short-term memory");
  assert.equal(session.shortTermMemory?.facts?.currentCity, "Delhi", "Current city stored in short-term memory");
});

test("Issue 2: Candidate is willing to travel but unwilling to relocate ('Travel kar sakta hoon, lekin shift nahi ho sakta')", async () => {
  const { sId } = await reachA1Question();

  // Turn 1: Candidate asks relocation inquiry
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Bangalore shift hona zaroori hai kya?",
  });

  // Turn 2: Candidate distinguishes travel vs relocation
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Travel kar sakta hoon, lekin shift nahi ho sakta.",
  });

  assert.equal(r2.status, 200);
  assert.equal(r2.body.counterQuestionHandled, true);
  assert.match(r2.body.message, /local travel|shift nahi|samajh gayi/i, "Must acknowledge travel vs shift stance");
  assert.match(r2.body.message, /wapas aate hain/i, "Must resume exact pending question");

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
  assert.equal(session.shortTermMemory?.facts?.travelWillingness, "yes", "Travel willingness is yes");
  assert.equal(session.shortTermMemory?.facts?.relocationWillingness, "no", "Relocation willingness is no");
});

test("Issue 2: Conditional relocation ('Agar accommodation mile toh consider kar sakta hoon')", async () => {
  const { sId } = await reachA1Question();

  // Turn 1: Inquiry with location requirement probe
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Bangalore shift hona zaroori hai kya?",
  });

  // Turn 2: Conditional willingness answering probe
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Agar accommodation mile toh consider kar sakta hoon.",
  });

  assert.equal(r2.status, 200);
  assert.equal(r2.body.counterQuestionHandled, true);
  assert.match(r2.body.message, /accommodation|onboarding team|samajh gayi/i);
  assert.match(r2.body.message, /wapas aate hain/i);

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
  assert.equal(session.shortTermMemory?.facts?.relocationWillingness, "conditional");
  assert.equal(session.shortTermMemory?.facts?.relocationCondition, "accommodation");
});

test("Issue 2: Company accommodation inquiry defers to onboarding without making unsupported promises", async () => {
  const { sId } = await reachA1Question();

  // Candidate asks about accommodation
  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Accommodation provide karti hai kya company?",
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.counterQuestionHandled, true);
  assert.equal(res.body.question.id, "A1");
  assert.match(res.body.message, /onboarding team/i, "Must defer accommodation to onboarding team");
  assert.doesNotMatch(res.body.message, /company room|free flat|guarantee accommodation/i, "Must not hallucinate accommodation");

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
});

test("Issue 1 & 2: Comprehensive 7-step conversation lifecycle for General Knowledge interruption ('Cloud computing kya hoti hai?')", async () => {
  // Step 1: Pending question state (active assessment question A1)
  const { sId, pendingQuestion } = await reachA1Question();
  assert.equal(pendingQuestion.id, "A1");

  // Step 2 & 3 & 4: Candidate interrupts with 'Cloud computing kya hoti hai?'
  // - System recognizes as inquiry/CANDIDATE_QUESTION
  // - Pending question remains active
  // - Speaks the answer and asks clarification check
  // - Does NOT append pending question text
  const rDoubt = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hoti hai?",
  });

  assert.equal(rDoubt.status, 200);
  assert.equal(rDoubt.body.counterQuestionHandled, true);
  assert.equal(rDoubt.body.question.id, "A1", "Pending question remains A1");
  assert.match(rDoubt.body.message, /cloud/i, "Must contain cloud computing explanation");
  assert.match(rDoubt.body.message, /doubt clear|kuch aur poochna/i, "Step 4: Must ask clarification check");
  assert.equal(rDoubt.body.message.includes(pendingQuestion.text), false, "Must NOT append pending assessment question");
  assert.equal(rDoubt.body.inquiryState, "clarification_check");

  // Step 5: Candidate asks chained follow-up questions
  // 5a: 'Iska example batao'
  const rExample = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska example batao.",
  });
  assert.equal(rExample.status, 200);
  assert.equal(rExample.body.counterQuestionHandled, true);
  assert.match(rExample.body.message, /example|drive|storage/i);
  assert.match(rExample.body.message, /doubt clear|kuch aur poochna/i, "Must repeat clarification check");
  assert.equal(rExample.body.message.includes(pendingQuestion.text), false);

  // 5b: 'Aur iska benefit kya hai?'
  const rBenefit = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Aur iska benefit kya hai?",
  });
  assert.equal(rBenefit.status, 200);
  assert.equal(rBenefit.body.counterQuestionHandled, true);
  assert.match(rBenefit.body.message, /benefit|fayda|access|data/i);
  assert.match(rBenefit.body.message, /doubt clear|kuch aur poochna/i);
  assert.equal(rBenefit.body.message.includes(pendingQuestion.text), false);

  // 5c: Topic switch to AI vs ML
  const rSwitch = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "AI aur machine learning mein kya difference hai?",
  });
  assert.equal(rSwitch.status, 200);
  assert.equal(rSwitch.body.counterQuestionHandled, true);
  assert.match(rSwitch.body.message, /AI|machine learning|learn/i);
  assert.match(rSwitch.body.message, /doubt clear|kuch aur poochna/i);
  assert.equal(rSwitch.body.message.includes(pendingQuestion.text), false);

  // Step 6: Inquiry closure signal - candidate says doubt is clear
  // AI must explicitly ask whether to proceed, and NOT resume immediately
  const rClear = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Doubt clear ho gaya, samajh gaya.",
  });
  assert.equal(rClear.status, 200);
  assert.equal(rClear.body.counterQuestionHandled, true);
  assert.match(rClear.body.message, /aage badhayein|continue/i, "Step 6: AI must ask whether to proceed");
  assert.equal(rClear.body.inquiryState, "ready_to_resume");
  assert.equal(rClear.body.message.includes(pendingQuestion.text), false, "Must not resume before candidate confirms");

  // Step 7: Assessment resumption - candidate confirms proceeding
  const rResume = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, aage badhiye.",
  });
  assert.equal(rResume.status, 200);
  assert.equal(rResume.body.counterQuestionHandled, true);
  assert.ok(rResume.body.message.includes(pendingQuestion.text), "Step 7: Resumes exact pending assessment question");
  assert.match(rResume.body.message, /wapas aate hain/i);
  assert.equal(getActiveInquiry(sId), null, "Inquiry closed after resumption");

  const sessionFinal = getSessionForPersistence(sId);
  assert.deepEqual(sessionFinal.invalidAttempts || {}, {}, "Zero invalid attempt penalties across entire 7-step exchange");
  assert.equal(sessionFinal.currentQuestionIndex, 2, "Question index remained on A1");
});

test("Issue 2: Candidate asks about Bangalore opportunity hypothetically", async () => {
  const { sId } = await reachA1Question();

  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Agar Bangalore mein opportunity mile toh?",
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.counterQuestionHandled, true);
  assert.equal(res.body.question.id, "A1");
  assert.match(res.body.message, /onboarding team|opportunity|demand/i);

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
});

test("Issue 2: Negation in city statement preserves current city and target city ('Main Bangalore mein nahi, Delhi mein rehta hoon')", async () => {
  const { sId } = await reachA1Question();

  const res = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Main Bangalore mein nahi, Delhi mein rehta hoon. Kya Bangalore aana zaroori hai?",
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.counterQuestionHandled, true);
  assert.equal(res.body.question.id, "A1");

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
  assert.equal(session.candidateCity, "Delhi", "Current city is Delhi");
  assert.equal(session.shortTermMemory?.facts?.currentCity, "Delhi");
  assert.equal(session.shortTermMemory?.facts?.targetCity, "Bangalore");
  assert.equal(session.shortTermMemory?.facts?.notInTargetCity, true);
});

test("Issue: Composite Utterance at A0 (Language Selection + General Knowledge Question)", async () => {
  const started = startInterview({ candidateName: "Pooja Sharma" });
  const sId = started.sessionId;

  // A2_NAME
  const rName = await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  assert.equal(rName.status, 200);

  // A2_NAME_CONFIRM
  const rConfirm = await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan, sahi hai" });
  assert.equal(rConfirm.status, 200);

  // A0: Candidate gives language preference AND asks general knowledge question simultaneously
  const rA0 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Hindi mein baat karungi, waise cloud computing kya hoti hai?",
  });

  assert.equal(rA0.status, 200);
  assert.equal(rA0.body.completed, false);
  assert.equal(rA0.body.counterQuestionHandled, true);
  assert.equal(rA0.body.inquiryState, "clarification_check");
  assert.equal(rA0.body.language, "Hindi", "Must save Hindi as session language");
  assert.equal(rA0.body.question.id, "A1", "Pending assessment question must be A1");
  assert.match(rA0.body.message, /cloud/i, "Must provide explanation of cloud computing");
  assert.match(rA0.body.message, /doubt\s+clear|kuch\s+aur\s+poochna/i, "Must include spoken clarification check");

  const session = getSessionForPersistence(sId);
  assert.equal(session.language, "Hindi");
  assert.equal(session.consentOutcome, "accepted");
  assert.equal(session.shortTermMemory?.facts?.preferredLanguage, "Hindi");
  assert.equal((session.invalidAttempts || {})["A0"] || 0, 0, "No invalid attempts on A0");
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0, "No invalid attempts on A1");

  // Step 5: Candidate asks follow-up during sub-dialogue
  const rFollowUp = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska example batao.",
  });

  assert.equal(rFollowUp.status, 200);
  assert.equal(rFollowUp.body.counterQuestionHandled, true);
  assert.equal(rFollowUp.body.question.id, "A1");
  assert.match(rFollowUp.body.message, /example|drive|storage/i);

  // Step 6: Candidate indicates doubt is clear
  const rClear = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan doubt clear ho gaya.",
  });

  assert.equal(rClear.status, 200);
  assert.equal(rClear.body.counterQuestionHandled, true);
  assert.match(rClear.body.message, /aage\s+badhayein/i, "Must ask permission before resuming");

  // Step 7: Candidate confirms resumption
  const rResume = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan bilkul.",
  });

  assert.equal(rResume.status, 200);
  assert.equal(rResume.body.counterQuestionHandled, true);
  assert.equal(rResume.body.inquiryState, "resumed_assessment");
  assert.match(rResume.body.message, /Bangalore.*area/i, "Must resume exact pending question A1");

  // Candidate answers A1
  const rA1Answer = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Main Indiranagar mein rehti hoon.",
  });

  assert.equal(rA1Answer.status, 200);
  assert.ok(
    rA1Answer.body.question.id === "A3" || rA1Answer.body.question.id === "A1_TRAVEL_CLARIFICATION",
    "Advances from A1 properly",
  );
});

test("Issue: Composite Utterance during pendingFollowUp language_preference", async () => {
  const started = startInterview({ candidateName: "Pooja Sharma" });
  const sId = started.sessionId;

  // A2_NAME
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  // A2_NAME_CONFIRM
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });

  // Candidate asks purpose inquiry at A0, triggering pendingConsentOnly
  const rInquiry = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Ye screening kis liye hai?",
  });
  assert.equal(rInquiry.status, 200);
  assert.equal(rInquiry.body.counterQuestionHandled, true);

  // Candidate responds only to consent: "Haan"
  const rConsent = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Haan",
  });

  assert.equal(rConsent.status, 200);
  assert.equal(rConsent.body.followUpRequired, true);
  assert.equal(rConsent.body.followUp.type, "language_preference");

  // Now candidate responds to language_preference with composite language + GK question
  const rLangComposite = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0_LANGUAGE_PREFERENCE",
    answer: "Hindi mein baat karungi, waise cloud computing kya hoti hai?",
  });

  assert.equal(rLangComposite.status, 200);
  assert.equal(rLangComposite.body.counterQuestionHandled, true);
  assert.equal(rLangComposite.body.inquiryState, "clarification_check");
  assert.equal(rLangComposite.body.language, "Hindi");
  assert.equal(rLangComposite.body.question.id, "A1", "Pending assessment question must be A1");
  assert.match(rLangComposite.body.message, /cloud/i);
  assert.match(rLangComposite.body.message, /doubt\s+clear|kuch\s+aur\s+poochna/i);

  const session = getSessionForPersistence(sId);
  assert.equal(session.language, "Hindi");
  assert.equal(session.pendingFollowUp, null, "pendingFollowUp must be resolved");
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
});

test("Issue: Composite Utterance at A0 in English with GK Question", async () => {
  const started = startInterview({ candidateName: "Pooja Sharma" });
  const sId = started.sessionId;

  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Yes" });

  // Candidate chooses English and asks GK question
  const rA0 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "English please, but what is cloud computing?",
  });

  assert.equal(rA0.status, 200);
  assert.equal(rA0.body.counterQuestionHandled, true);
  assert.equal(rA0.body.inquiryState, "clarification_check");
  assert.equal(rA0.body.language, "English", "Must set language to English");
  assert.equal(rA0.body.question.id, "A1", "Target question must be A1");
  assert.match(rA0.body.message, /cloud computing/i);
  assert.match(rA0.body.message, /clarify your doubt|anything else/i, "Clarification check in English");

  const session = getSessionForPersistence(sId);
  assert.equal(session.language, "English");
  assert.equal((session.invalidAttempts || {})["A0"] || 0, 0);
});

test("Issue: Composite Utterance at A0 with Travel/Relocation Inquiry", async () => {
  const started = startInterview({ candidateName: "Pooja Sharma" });
  const sId = started.sessionId;

  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Pooja" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });

  const rA0 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Main Hindi mein bolungi, kya Bangalore relocate karna zaroori hai?",
  });

  assert.equal(rA0.status, 200);
  assert.equal(rA0.body.counterQuestionHandled, true);
  assert.equal(rA0.body.language, "Hindi");
  assert.equal(rA0.body.question.id, "A1");
  assert.match(rA0.body.message, /onboarding team|local service areas|eligibility/i);
  assert.doesNotMatch(rA0.body.message, /mandatory to travel to Bangalore|must relocate to Bangalore/i);

  const session = getSessionForPersistence(sId);
  assert.equal(session.language, "Hindi");
  assert.equal((session.invalidAttempts || {})["A1"] || 0, 0);
});

// =========================================================================
// FEATURE TESTS: Candidate Request to Ask a Question (REQUEST_TO_ASK_QUESTION)
// =========================================================================

test("Feature: Hindi & Hinglish Request to Ask a Question (Full Multi-Turn Lifecycle)", async () => {
  const { sId, pendingQuestion } = await reachA1Question();
  const sessionBefore = getSessionForPersistence(sId);
  const qIndexBefore = sessionBefore.currentQuestionIndex;
  const answersBefore = sessionBefore.answers.length;

  // 1. Hindi request to ask: "Mujhe ek question poochhna tha."
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Mujhe ek question poochhna tha.",
  });

  assert.equal(r1.status, 200);
  assert.equal(r1.body.counterQuestionHandled, true);
  assert.equal(r1.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");
  assert.equal(r1.body.question.id, "A1", "Pending question must be preserved");
  assert.match(r1.body.message, /bilkul poochiye.*aap apna question poochhiye/i, "Must invite question politely");
  assert.match(r1.body.message, /madad karti hoon/i);

  // Assessment integrity
  const sessionAfterR1 = getSessionForPersistence(sId);
  assert.equal(sessionAfterR1.currentQuestionIndex, qIndexBefore, "Question index must not advance");
  assert.equal(sessionAfterR1.answers.length, answersBefore, "Inquiry request must not be recorded as answer");
  assert.equal((sessionAfterR1.invalidAttempts || {})["A1"] || 0, 0, "Invalid attempts must not increase");

  const inquiry1 = getActiveInquiry(sId);
  assert.ok(inquiry1);
  assert.equal(inquiry1.state, "AWAITING_CANDIDATE_QUESTION");
  assert.equal(inquiry1.originalQuestionId, "A1");

  // 2. Actual question received after invitation: "Cloud computing kya hoti hai?"
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hoti hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Cloud computing internet ke through servers, storage aur applications access karne ki technology hai.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  assert.equal(r2.status, 200);
  assert.equal(r2.body.counterQuestionHandled, true);
  assert.equal(r2.body.inquiryState, "clarification_check");
  assert.equal(r2.body.question.id, "A1");
  assert.match(r2.body.message, /cloud computing.*servers/i);
  assert.match(r2.body.message, /kya aapka doubt clear ho gaya, ya aap kuch aur poochhna chahenge/i);

  // 3. Follow-up question: "Iska example bataiye."
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska example bataiye.",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Jaise Google Drive ya Netflix cloud computing ke famous examples hain.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  assert.equal(r3.status, 200);
  assert.equal(r3.body.inquiryState, "clarification_check");
  assert.match(r3.body.message, /google drive ya netflix/i);
  assert.match(r3.body.message, /doubt clear|kuch aur poochhna/i);

  // 4. Multiple follow-ups: "Aur iska benefit kya hai?"
  const r4 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Aur iska benefit kya hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Iska benefit hai ki aap kisi bhi device se apna data securely access kar sakte hain.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  assert.equal(r4.status, 200);
  assert.equal(r4.body.inquiryState, "clarification_check");
  assert.match(r4.body.message, /securely access kar sakte hain/i);

  // 5. Topic switching: "AI aur machine learning mein kya difference hai?"
  const r5 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "AI aur machine learning mein kya difference hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "artificial_intelligence",
      replyText: "AI ek broad field hai jisme machines smart banti hain, aur ML uska part hai jisme data se seekhte hain.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  assert.equal(r5.status, 200);
  assert.equal(r5.body.inquiryState, "clarification_check");
  assert.match(r5.body.message, /AI ek broad field hai/i);

  // 6. Candidate confirms inquiry resolution: "Haan, doubt clear ho gaya"
  const r6 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, doubt clear ho gaya",
  });

  assert.equal(r6.status, 200);
  assert.equal(r6.body.counterQuestionHandled, true);
  assert.equal(r6.body.inquiryState, "ready_to_resume");
  assert.match(r6.body.message, /interview aage badhayein/i, "Must ask permission before resuming assessment");
  assert.equal(getActiveInquiry(sId).state, "ready_to_resume");

  // 7. Permission granted to resume: "Haan"
  const r7 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan",
  });

  assert.equal(r7.status, 200);
  assert.equal(r7.body.inquiryState, "resumed_assessment");
  assert.match(r7.body.message, /wapas aate hain/i);
  assert.equal(r7.body.question.id, "A1");
  assert.equal(getActiveInquiry(sId), null, "Inquiry must be closed");

  // 8. Candidate provides actual assessment answer
  const r8 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Koramangala, Bangalore",
  });

  assert.equal(r8.status, 200);
  const finalSession = getSessionForPersistence(sId);
  assert.equal(finalSession.answers.length, answersBefore + 1);
  assert.equal((finalSession.invalidAttempts || {})["A1"] || 0, 0);
});

test("Feature: English Request to Ask a Question with Natural Invitation", async () => {
  const { sId } = await reachA1Question({ language: "English" });
  const sessionBefore = getSessionForPersistence(sId);
  const answersBefore = sessionBefore.answers.length;

  // 1. English request: "Can I ask something?"
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Can I ask something?",
  });

  assert.equal(r1.status, 200);
  assert.equal(r1.body.counterQuestionHandled, true);
  assert.equal(r1.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");
  assert.match(r1.body.message, /sure, please go ahead and ask your question\. i am here to help/i);
  assert.equal(r1.body.question.id, "A1");

  // 2. Candidate asks question: "What is cloud computing?"
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "What is cloud computing?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Cloud computing delivers computing services over the internet including servers and storage.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });

  assert.equal(r2.status, 200);
  assert.equal(r2.body.inquiryState, "clarification_check");
  assert.match(r2.body.message, /cloud computing delivers computing services/i);
  assert.match(r2.body.message, /clarify your doubt|anything else/i);

  // 3. Doubt clear: "Understood, thank you."
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Understood, thank you.",
  });

  assert.equal(r3.status, 200);
  assert.equal(r3.body.inquiryState, "ready_to_resume");
  assert.match(r3.body.message, /shall we continue with the interview/i);

  // 4. Confirm resumption: "Yes"
  const r4 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Yes",
  });

  assert.equal(r4.status, 200);
  assert.equal(r4.body.inquiryState, "resumed_assessment");
  assert.match(r4.body.message, /let's return to our question/i);
  assert.equal(getActiveInquiry(sId), null);
  assert.equal(getSessionForPersistence(sId).answers.length, answersBefore);
});

test("Feature: Candidate Decides Not to Ask in AWAITING_CANDIDATE_QUESTION", async () => {
  const { sId } = await reachA1Question();
  const sessionBefore = getSessionForPersistence(sId);
  const answersBefore = sessionBefore.answers.length;

  // 1. Candidate requests permission: "Ek doubt hai."
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Ek doubt hai.",
  });

  assert.equal(r1.status, 200);
  assert.equal(r1.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");

  // 2. Candidate changes mind: "Nahi kuch nahi, rehne do"
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Nahi kuch nahi, rehne do",
  });

  assert.equal(r2.status, 200);
  assert.equal(r2.body.counterQuestionHandled, true);
  assert.equal(r2.body.inquiryState, "ready_to_resume");
  assert.match(r2.body.message, /theek hai\. kya ab hum interview aage badhayein/i);

  // 3. Candidate confirms: "Haan"
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan",
  });

  assert.equal(r3.status, 200);
  assert.equal(r3.body.inquiryState, "resumed_assessment");
  assert.match(r3.body.message, /wapas aate hain/i);
  assert.equal(getActiveInquiry(sId), null);
  assert.equal(getSessionForPersistence(sId).answers.length, answersBefore);
});

test("Feature: Request to Ask a Question at A0 (Consent) Does Not Trigger Unclear Consent Warning", async () => {
  const started = startInterview({ candidateName: "Reena" });
  const sId = started.sessionId;

  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Reena" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Haan" });

  // Candidate at A0 says: "Ek baat poochhni thi."
  const rA0 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Ek baat poochhni thi.",
  });

  assert.equal(rA0.status, 200);
  assert.equal(rA0.body.counterQuestionHandled, true);
  assert.equal(rA0.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");
  assert.equal(rA0.body.question.id, "A0", "Pending question must remain A0");
  assert.doesNotMatch(rA0.body.message, /maaf kijiye, mujhe samajh nahi aaya/i, "Must not trigger unclear consent warning");
  assert.doesNotMatch(rA0.body.message, /agree karti hain/i);
  assert.match(rA0.body.message, /bilkul poochiye/i);

  const session = getSessionForPersistence(sId);
  assert.equal((session.invalidAttempts || {})["A0"] || 0, 0, "No invalid attempt on consent");
});

test("Feature: English Request to Ask at A0: 'I have a question.'", async () => {
  const started = startInterview({ candidateName: "Reena" });
  const sId = started.sessionId;

  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME", answer: "Reena" });
  await submitAnswer({ sessionId: sId, expectedQuestionId: "A2_NAME_CONFIRM", answer: "Yes" });

  const rA0 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "I have a question.",
  });

  assert.equal(rA0.status, 200);
  assert.equal(rA0.body.counterQuestionHandled, true);
  assert.equal(rA0.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");
  assert.equal(rA0.body.question.id, "A0");
  assert.match(rA0.body.message, /sure, please go ahead and ask your question/i);
  assert.doesNotMatch(rA0.body.message, /maaf kijiye|agree/i);
});

test("Feature: Candidate says no or is not ready in ready_to_resume preserves pending question", async () => {
  const { sId } = await reachA1Question();
  const sessionBefore = getSessionForPersistence(sId);
  const answersBefore = sessionBefore.answers.length;

  // 1. Candidate requests permission: "Mujhe ek question poochhna tha"
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Mujhe ek question poochhna tha",
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");

  // 2. Candidate asks question
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Cloud computing internet ke through services dene ka tarika hai.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.inquiryState, "clarification_check");

  // 3. Doubt clear -> AI asks permission to continue
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Doubt clear ho gaya",
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.inquiryState, "ready_to_resume");
  assert.match(r3.body.message, /achha, kya ab hum interview aage badhayein\?/i);

  // 4. Candidate says no / not ready: "Abhi nahi, ruko"
  const r4 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Abhi nahi, ruko",
  });
  assert.equal(r4.status, 200);
  assert.equal(r4.body.counterQuestionHandled, true);
  assert.equal(r4.body.inquiryState, "inquiry_active");
  assert.equal(r4.body.question.id, "A1", "Pending assessment question must remain preserved");
  assert.match(r4.body.message, /poochhiye, aap kya poochna chahte hain/i);

  const sessionMid = getSessionForPersistence(sId);
  assert.equal((sessionMid.invalidAttempts || {})["A1"] || 0, 0, "No invalid attempt added");
  assert.equal(sessionMid.answers.length, answersBefore, "No assessment answer recorded");

  // 5. Candidate asks follow-up: "Iska benefit kya hai?"
  const r5 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska benefit kya hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Iska benefit flexible storage aur secure access hai.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r5.status, 200);
  assert.equal(r5.body.inquiryState, "clarification_check");

  // 6. Doubt clear again
  const r6 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Theek hai samajh gaya",
  });
  assert.equal(r6.status, 200);
  assert.equal(r6.body.inquiryState, "ready_to_resume");

  // 7. Confirms resumption: "Haan chaliye"
  const r7 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan chaliye",
  });
  assert.equal(r7.status, 200);
  assert.equal(r7.body.inquiryState, "resumed_assessment");
  assert.match(r7.body.message, /humare sawal par wapas aate hain/i);
  assert.equal(r7.body.question.id, "A1");
  assert.equal(getActiveInquiry(sId), null);
});

test("Strict One-Question-at-a-Time Rule: AI never asks multiple questions in a single turn", async () => {
  const { sId } = await reachA1Question();

  function countQuestions(text) {
    if (!text || typeof text !== "string") return 0;
    const matches = text.match(/\?/g);
    return matches ? matches.length : 0;
  }

  // Step 1: Candidate requests permission to ask a question
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Mujhe ek question poochhna tha",
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");
  // Invitation must contain 0 questions — it invites and waits!
  assert.equal(countQuestions(r1.body.message), 0, "Invitation must contain 0 questions, simply inviting and listening");
  assert.match(r1.body.message, /bilkul poochiye/i);

  // Step 2 & 3: Candidate asks one GK question
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hoti hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Cloud computing internet ke through computing resources provide karta hai.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.inquiryState, "clarification_check");
  // AI provides one clear answer followed by exactly ONE clarification question
  assert.equal(countQuestions(r2.body.message), 1, "AI must ask at most one question (clarification check)");
  assert.match(r2.body.message, /kya aapka doubt clear ho gaya, ya aap kuch aur poochhna chahenge\?/i);

  // Step 4: Candidate asks a follow-up
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska example bataiye.",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Jaise Google Drive ya Netflix cloud computing ke examples hain.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r3.status, 200);
  assert.equal(countQuestions(r3.body.message), 1, "Follow-up response must contain at most one question");

  // Step 5: Candidate asks a location inquiry whose answer already contains a question
  const r4 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Kya Bangalore mein rehna hi zaroori hai?",
  });
  assert.equal(r4.status, 200);
  // Must NOT append duplicate clarification check to an answer that already has a question!
  assert.equal(countQuestions(r4.body.message), 1, "Answer with existing question must not append a second question");

  // Step 6: Candidate confirms doubt is clear
  const r5 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, doubt clear ho gaya",
  });
  assert.equal(r5.status, 200);
  assert.equal(r5.body.inquiryState, "ready_to_resume");
  assert.equal(countQuestions(r5.body.message), 1, "Ready-to-resume must contain exactly one permission question");
  assert.match(r5.body.message, /achha, kya ab hum interview aage badhayein\?/i);

  // Step 7: Candidate confirms -> assessment resumes
  const r6 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan",
  });
  assert.equal(r6.status, 200);
  assert.equal(r6.body.inquiryState, "resumed_assessment");
  assert.match(r6.body.message, /humare sawal par wapas aate hain/i);
});

test("Scenario A: Full multi-turn permission, GK inquiry, clarification check, permission verification, and assessment continuation", async () => {
  const { sId } = await reachA1Question();

  // 1. Candidate interrupts with permission request
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Mujhe ek question poochhna tha.",
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");
  assert.match(r1.body.message, /bilkul poochiye/i);

  // 2. Candidate asks question
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Cloud computing internet ke madhyam se data storage aur computing services deta hai.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.inquiryState, "clarification_check");
  assert.match(r2.body.message, /kya aapka doubt clear ho gaya/i);

  // 3. Candidate asks follow-up
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Iska example bataiye.",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Google Drive aur Netflix iske aam examples hain.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.inquiryState, "clarification_check");

  // 4. Candidate says doubt is clear
  const r4 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, samajh gaya.",
  });
  assert.equal(r4.status, 200);
  assert.equal(r4.body.inquiryState, "ready_to_resume");
  assert.match(r4.body.message, /achha, kya ab hum interview aage badhayein\?/i);

  // 5. Candidate confirms resumption
  const r5 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, chaliye.",
  });
  assert.equal(r5.status, 200);
  assert.equal(r5.body.inquiryState, "resumed_assessment");
  assert.equal(r5.body.question?.id, "A1");
  assert.match(r5.body.message, /chaliye humare sawal par wapas aate hain/i);

  // 6. Candidate answers the resumed assessment question normally
  const r6 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Main Koramangala mein rehti hoon aur roz HSR aana jaana hota hai",
  });
  assert.equal(r6.status, 200);
  assert.equal(r6.body.question?.id, "A1_TRAVEL_CLARIFICATION");
});

test("Scenario B: Candidate states another doubt remains during clarification check", async () => {
  const { sId } = await reachA1Question();

  // 1. Candidate asks first question
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hoti hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Cloud computing remote servers use karta hai.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.inquiryState, "clarification_check");

  // 2. Candidate says: 'Abhi ek aur doubt hai.' -> Stays in inquiry!
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Abhi ek aur doubt hai.",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");
  assert.match(r2.body.message, /bilkul poochiye/i);

  // 3. Candidate asks the second doubt
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "AI kya hota hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "AI machines ko smart decisions lene ki kshamata deta hai.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.inquiryState, "clarification_check");

  // 4. Doubt is clear
  const r4 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Ab samajh aa gaya.",
  });
  assert.equal(r4.status, 200);
  assert.equal(r4.body.inquiryState, "ready_to_resume");
  assert.match(r4.body.message, /achha, kya ab hum interview aage badhayein\?/i);

  // 5. Explicit confirmation resumes exact assessment question
  const r5 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan ji, continue kijiye",
  });
  assert.equal(r5.status, 200);
  assert.equal(r5.body.inquiryState, "resumed_assessment");
  assert.equal(r5.body.question?.id, "A1");
});

test("Scenario C: Candidate says 'Abhi nahi, ek aur question hai' preserves pending question and stays in inquiry", async () => {
  const { sId } = await reachA1Question();

  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Cloud computing kya hai?",
  }, {
    generateInquiryResponseImpl: async () => ({
      topic: "general_knowledge",
      replyText: "Cloud computing explanation.",
      probeQuestion: "",
      suggestedNextAction: "RESOLVE_AND_PROMPT_QUESTION",
    }),
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.inquiryState, "clarification_check");

  // Candidate says: 'Abhi nahi, ek aur question hai.'
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Abhi nahi, ek aur question hai.",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.inquiryState, "AWAITING_CANDIDATE_QUESTION");
  assert.match(r2.body.message, /bilkul poochiye/i);
  assert.equal(r2.body.question?.id, "A1", "Pending assessment question must remain unchanged");
});

test("Scenario D: Candidate asks question, confirms resumption, question delivered once without scoring penalty", async () => {
  const { sId } = await reachA1Question();

  // 1. Candidate asks a question
  const r1 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Training kitne din ki hoti hai?",
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.inquiryState, "clarification_check");

  // 2. Candidate says doubt is clear
  const r2 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Theek hai, clear hai.",
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.inquiryState, "ready_to_resume");
  assert.match(r2.body.message, /achha, kya ab hum interview aage badhayein\?/i);

  // 3. Candidate confirms continuation
  const r3 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Haan, shuru karein",
  });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.inquiryState, "resumed_assessment");
  assert.equal(r3.body.question?.id, "A1");
  assert.match(r3.body.message, /Aap Bangalore mein kis area mein rehti hain\?/i);

  // 4. Candidate now answers A1
  const r4 = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A1",
    answer: "Main Indiranagar mein rehti hoon aur Whitefield travel kar sakti hoon.",
  });
  assert.equal(r4.status, 200);
  assert.equal(r4.body.question?.id, "A1_MOVE_TIMELINE");
});
