const test = require("node:test");
const assert = require("node:assert/strict");
const { startInterview, submitAnswer, getSessionForPersistence } = require("./interview");

test("Strict turn-taking: Screening purpose inquiry on A0 asks only consent, then language preference, then advances to A1", async () => {
  const started = startInterview({ candidateName: "Aarti", profileName: "Aarti" });
  const sId = started.sessionId;

  // 1. Initial name step: A2_NAME
  const rName = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A2_NAME",
    answer: "Aarti",
  });
  assert.equal(rName.status, 200);
  assert.equal(rName.body.question.id, "A2_NAME_CONFIRM");

  // 2. Name confirmation: A2_NAME_CONFIRM -> returns A0
  const rConfirm = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan, bilkul",
  });
  assert.equal(rConfirm.status, 200);
  assert.equal(rConfirm.body.question.id, "A0");

  // 3. Candidate asks: "Ye screening kis liye hai?"
  const rInquiry = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Ye screening kis liye hai?",
  });
  assert.equal(rInquiry.status, 200);
  assert.equal(rInquiry.body.counterQuestionHandled, true);
  assert.equal(rInquiry.body.clarificationRequired, true);
  assert.equal(rInquiry.body.question.id, "A0");

  // Verify: AI explains purpose AND asks ONLY consent ("Kya hum shuru karein?")
  // It must NOT combine both questions or include the language question in this turn!
  assert.match(rInquiry.body.message, /qualification screening|screening assistant/i);
  assert.match(rInquiry.body.message, /Kya hum shuru karein\?/i);
  assert.doesNotMatch(rInquiry.body.message, /Aap Hindi mein baat karengi ya English mein/i);

  // 4. Candidate responds only to consent: "Haan"
  const rConsent = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Haan",
  });
  assert.equal(rConsent.status, 200);
  assert.equal(rConsent.body.consentOutcome, "accepted");
  assert.equal(rConsent.body.followUpRequired, true);

  // Verify: AI does NOT jump to A1 immediately; it asks ONLY language preference
  assert.equal(rConsent.body.question.id, "A0_LANGUAGE_PREFERENCE");
  assert.match(rConsent.body.message, /Aap Hindi mein baat karengi ya English mein\?/i);

  // 5. Candidate responds with language preference: "Hindi"
  const rLanguage = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0_LANGUAGE_PREFERENCE",
    answer: "Hindi",
  });
  assert.equal(rLanguage.status, 200);
  assert.equal(rLanguage.body.consentOutcome, "accepted");
  assert.equal(rLanguage.body.language, "Hindi");

  // Verify: AI now advances to A1
  assert.equal(rLanguage.body.question.id, "A1");
  assert.match(rLanguage.body.question.text, /Bangalore mein kis area/i);

  const session = getSessionForPersistence(sId);
  assert.equal(session.consentOutcome, "accepted");
  assert.equal(session.language, "Hindi");
  assert.equal(session.currentQuestionIndex, 2); // A1 is at index 2
});

test("Strict turn-taking: Screening purpose inquiry on A0 with combined consent + language answer proceeds directly to A1", async () => {
  const started = startInterview({ candidateName: "Sunita", profileName: "Sunita" });
  const sId = started.sessionId;

  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A2_NAME",
    answer: "Sunita",
  });
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Haan ji",
  });

  // Candidate asks about screening purpose
  const rInquiry = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Ye screening kyun ho rahi hai?",
  });
  assert.equal(rInquiry.status, 200);
  assert.match(rInquiry.body.message, /Kya hum shuru karein\?/i);
  assert.doesNotMatch(rInquiry.body.message, /Aap Hindi mein baat karengi ya English mein/i);

  // Candidate provides both consent and language together
  const rCombined = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Haan, main Hindi mein baat karungi",
  });

  // Must advance directly to A1 without redundant language preference question
  assert.equal(rCombined.status, 200);
  assert.equal(rCombined.body.consentOutcome, "accepted");
  assert.equal(rCombined.body.language, "Hindi");
  assert.equal(rCombined.body.question.id, "A1");
});

test("Strict turn-taking: English screening purpose inquiry on A0 follows English prompts and advances to A1", async () => {
  const started = startInterview({ candidateName: "Priya", profileName: "Priya" });
  const sId = started.sessionId;

  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A2_NAME",
    answer: "Priya",
  });
  await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A2_NAME_CONFIRM",
    answer: "Yes, that is correct",
  });

  // Candidate asks: "What is this screening for?"
  const rInquiry = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "What is this screening for?",
  });
  assert.equal(rInquiry.status, 200);
  assert.match(rInquiry.body.message, /Shall we start\?/i);
  assert.doesNotMatch(rInquiry.body.message, /Hindi or English/i);

  // Candidate gives consent in English: "Yes"
  const rConsent = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0",
    answer: "Yes",
  });
  assert.equal(rConsent.status, 200);
  assert.equal(rConsent.body.question.id, "A0_LANGUAGE_PREFERENCE");
  assert.match(rConsent.body.message, /Hindi or English\?/i);

  // Candidate selects English: "English please"
  const rLang = await submitAnswer({
    sessionId: sId,
    expectedQuestionId: "A0_LANGUAGE_PREFERENCE",
    answer: "English please",
  });
  assert.equal(rLang.status, 200);
  assert.equal(rLang.body.language, "English");
  assert.equal(rLang.body.question.id, "A1");
});
