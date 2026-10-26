import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFinalizedInput,
  createRepeatHandoffGuard,
  resolveRepeatQuestionRequest,
} from "./repeatQuestionIntent.js";

const activeQuestion = {
  questionId: "A7",
  text: "Abhi aapka kaam kaise chal raha hai?",
  clarificationRequired: false,
};

test("recognizes clear Hindi repeat requests", () => {
  for (const phrase of [
    "वह सवाल क्या था?",
    "मुझे सवाल समझ नहीं आया।",
    "एक बार फिर से पूछिए।",
  ]) {
    assert.deepEqual(resolveRepeatQuestionRequest(phrase, activeQuestion), {
      questionId: "A7",
      prompt: activeQuestion.text,
      clarificationRequired: false,
    });
  }
});

test("recognizes clear Hinglish repeat requests", () => {
  for (const phrase of [
    "Woh sawal kya tha?",
    "Sawal dobara bata sakti hain?",
    "Question repeat kariye.",
    "Mujhe sawal samajh nahi aaya.",
  ]) {
    assert.ok(resolveRepeatQuestionRequest(phrase, activeQuestion), phrase);
  }
});

test("recognizes clear English repeat requests", () => {
  for (const phrase of [
    "What was the question?",
    "Could you repeat the question please?",
    "Please ask the question again.",
    "I didn't understand the question.",
  ]) {
    assert.ok(resolveRepeatQuestionRequest(phrase, activeQuestion), phrase);
  }
});

test("returns the exact active clarification or follow-up prompt", () => {
  const clarification = {
    questionId: "A1_TRAVEL_CLARIFICATION",
    text: "Agar kaam door ho, to kya aap travel kar sakti hain?",
    clarificationRequired: true,
  };
  const repeat = resolveRepeatQuestionRequest(
    "Sawal dobara bataiye.",
    clarification,
  );

  assert.equal(repeat.questionId, clarification.questionId);
  assert.equal(repeat.prompt, clarification.text);
  assert.equal(repeat.clarificationRequired, true);
});

test("clear repeat intent is still detected when the active prompt is unavailable", () => {
  assert.deepEqual(resolveRepeatQuestionRequest("Repeat question", null), {
    questionId: null,
    prompt: "",
    clarificationRequired: false,
  });
});

test("genuine answers containing similar words are not repeat requests", () => {
  for (const answer of [
    "I understood the question and I have been working at a salon for two years.",
    "Sawal samajh aaya, main ghar se clients leti hoon.",
    "Please repeat customer bookings in my answer; I have five clients.",
  ]) {
    assert.equal(resolveRepeatQuestionRequest(answer, activeQuestion), null);
  }
});

test("repeat intent is routed without an answer payload or question progression", () => {
  const action = classifyFinalizedInput("Question repeat kariye.", activeQuestion);

  assert.deepEqual(action, {
    type: "repeat_question",
    repeatRequest: {
      questionId: "A7",
      prompt: activeQuestion.text,
      clarificationRequired: false,
    },
  });
  assert.equal("answer" in action, false);
});

test("a genuine answer remains eligible for normal backend assessment", () => {
  assert.deepEqual(
    classifyFinalizedInput(
      "I understood the question and have worked in a salon for two years.",
      activeQuestion,
    ),
    {
      type: "submit_answer",
      answer: "I understood the question and have worked in a salon for two years.",
    },
  );
});

test("repeat handoff guard suppresses concurrent duplicates but allows a later repeat", () => {
  const guard = createRepeatHandoffGuard();

  assert.equal(guard.tryAcquire(3), true);
  assert.equal(guard.tryAcquire(3), false);
  assert.equal(guard.tryAcquire(4), true);
  guard.release(3);
  assert.equal(guard.tryAcquire(3), true);
  guard.release(3);
  guard.release(4);
});
