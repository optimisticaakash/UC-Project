import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFinalizedInput,
  createRepeatHandoffGuard,
  resolveRepeatQuestionRequest,
} from "./repeatQuestionIntent.js";
import {
  isCandidateQuestionRequest,
  isDoubtClearConfirmation,
} from "./repeatQuestionIntent.js";
import {
  classifyCandidateQuestionInput,
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


test("recognizes candidate question requests in English", () => {
  for (const phrase of [
    "I have a question.",
    "I want to ask a question.",
    "Can I ask something?",
    "May I ask something?",
    "I have one doubt.",
  ]) {
    assert.equal(isCandidateQuestionRequest(phrase), true, phrase);
  }
});

test("recognizes candidate question requests in Hinglish", () => {
  for (const phrase of [
    "Mujhe ek question poochna hai.",
    "Mujhe kuch question poochna hai.",
    "Mera ek question hai.",
    "Ek doubt hai.",
    "Mujhe ek doubt hai.",
  ]) {
    assert.equal(isCandidateQuestionRequest(phrase), true, phrase);
  }
});

test("recognizes candidate question requests in Hindi", () => {
  for (const phrase of [
    "मुझे एक सवाल पूछना है।",
    "मेरा एक सवाल है।",
    "एक प्रश्न है।",
  ]) {
    assert.equal(isCandidateQuestionRequest(phrase), true, phrase);
  }
});

test("does not classify normal assessment answers as candidate questions", () => {
  for (const phrase of [
    "I have worked in a salon for two years.",
    "I ask customers about their preferences.",
    "Mujhe salon mein do saal ka experience hai.",
    "Main customers ko service provide karti hoon.",
  ]) {
    assert.equal(isCandidateQuestionRequest(phrase), false, phrase);
  }
});

test("recognizes clear confirmations", () => {
  for (const phrase of [
    "Yes.",
    "Got it.",
    "I understand.",
    "Haan.",
    "Samajh aa gaya.",
    "Ab clear hai.",
    "कोई संदेह नहीं।",
  ]) {
    assert.equal(isDoubtClearConfirmation(phrase), true, phrase);
  }
});

test("does not treat unclear or negative responses as clear confirmation", () => {
  for (const phrase of [
    "No.",
    "Nahi.",
    "Nahi abhi bhi doubt hai.",
    "I still don't understand.",
    "It is not clear.",
    "Mujhe abhi samajh nahi aaya.",
  ]) {
    assert.equal(isDoubtClearConfirmation(phrase), false, phrase);
  }
});

test("candidate question request enters invitation mode", () => {
  assert.deepEqual(
    classifyCandidateQuestionInput(
      "Mujhe ek question poochna hai.",
      "inactive",
    ),
    { type: "invite_candidate_question" },
  );
});

test("candidate question is handled outside assessment submission", () => {
  assert.deepEqual(
    classifyCandidateQuestionInput(
      "Interview ka duration kitna hoga?",
      "awaiting_question",
    ),
    {
      type: "answer_candidate_question",
      question: "Interview ka duration kitna hoga?",
    },
  );
});

test("unclear response stays in candidate question conversation", () => {
  assert.deepEqual(
    classifyCandidateQuestionInput(
      "Mujhe abhi bhi doubt hai.",
      "awaiting_confirmation",
    ),
    {
      type: "candidate_question_follow_up",
      question: "Mujhe abhi bhi doubt hai.",
    },
  );
});

test("clear confirmation resumes the pending assessment", () => {
  assert.deepEqual(
    classifyCandidateQuestionInput(
      "Haan, samajh aa gaya.",
      "awaiting_confirmation",
    ),
    { type: "resume_assessment" },
  );
});

test("normal assessment answers are not captured as candidate questions", () => {
  assert.equal(
    classifyCandidateQuestionInput(
      "I have worked in a salon for two years.",
      "inactive",
    ),
    null,
  );
});