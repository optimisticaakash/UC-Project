const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { liveVoiceInstructions } = require("./liveVoiceInstructions");
const { startInterview, submitAnswer } = require("./interview");

test("Stage 6: liveVoiceInstructions strictly avoids robotic clichés and preserves salon terminology", () => {
  assert.match(liveVoiceInstructions, /mirroring the candidate's language/i);
  assert.match(liveVoiceInstructions, /Preserve standard salon terms in English or Hinglish/i);
  assert.match(liveVoiceInstructions, /waxing, facial, threading/i);
  assert.match(liveVoiceInstructions, /Avoid formulaic clichés and filler phrases like 'Certainly', 'Sure thing'/i);
});

test("Stage 6: Natural acknowledgements vary across turns and avoid repetitive canned phrases", async () => {
  const started = startInterview({ candidateName: "Sunita Sharma", language: "Hindi" });
  const sessionId = started.sessionId;

  // Answer A2_NAME
  const rName = await submitAnswer({
    sessionId,
    answer: "Mera naam Sunita Sharma hai",
    expectedQuestionId: "A2_NAME",
  });
  assert.equal(rName.status, 200);
  assert.ok(rName.body.acknowledgement);

  // A2_NAME_CONFIRM
  const rConfirm = await submitAnswer({
    sessionId,
    answer: "Haan, bilkul",
    expectedQuestionId: "A2_NAME_CONFIRM",
  });
  assert.equal(rConfirm.status, 200);

  // A0
  const rA0 = await submitAnswer({
    sessionId,
    answer: "Haan, theek hai, main Hindi mein baat karungi.",
    expectedQuestionId: "A0",
  });
  assert.equal(rA0.status, 200);
  assert.ok(rA0.body.acknowledgement);

  // A1
  const rA1 = await submitAnswer({
    sessionId,
    answer: "Main Indiranagar Bangalore mein rehti hoon.",
    expectedQuestionId: "A1",
  });
  assert.equal(rA1.status, 200);
  assert.ok(rA1.body.acknowledgement);

  // Next question after A1 (could be A1 follow-up or A2)
  const nextQ1 = rA1.body.question.id;
  const rNext1 = await submitAnswer({
    sessionId,
    answer: nextQ1 === "A1_TRAVEL_CLARIFICATION" ? "Haan main travel kar sakti hoon" : "Meri umar 28 saal hai",
    expectedQuestionId: nextQ1,
  });
  assert.equal(rNext1.status, 200);
  assert.ok(rNext1.body.acknowledgement);

  // Next question
  const nextQ2 = rNext1.body.question.id;
  const rNext2 = await submitAnswer({
    sessionId,
    answer: nextQ2 === "A1_MOVE_TIMELINE" ? "Main 1 hafte mein shift ho sakti hoon" : "Meri umar 28 saal hai",
    expectedQuestionId: nextQ2,
  });
  assert.equal(rNext2.status, 200);
  assert.ok(rNext2.body.acknowledgement);

  // Next question
  const nextQ3 = rNext2.body.question.id;
  const rNext3 = await submitAnswer({
    sessionId,
    answer: nextQ3 === "A2" ? "Meri umar 28 saal hai" : "Mere parivaar mein pati aur do bachhe hain",
    expectedQuestionId: nextQ3,
  });
  assert.equal(rNext3.status, 200);
  assert.ok(rNext3.body.acknowledgement);

  // Verify that acknowledgements across turns vary and do not blindly repeat identical canned phrases
  const acks = [rA1.body.acknowledgement, rNext1.body.acknowledgement, rNext2.body.acknowledgement, rNext3.body.acknowledgement];
  const uniqueAcks = new Set(acks);
  assert.ok(uniqueAcks.size > 1, `Acknowledgements across turns must vary, got: ${JSON.stringify(acks)}`);
});
