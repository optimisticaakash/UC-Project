import test from "node:test";
import assert from "node:assert/strict";
import {
  getCandidateVisibleQuestion,
  getCandidateSafeError,
  getInterviewUiModel,
  isTerminalInterviewState,
  resolveTerminalInterviewState,
} from "./interviewUiState.js";

test("interview status follows ready, active voice, and terminal lifecycle states", () => {
  assert.equal(getInterviewUiModel({ lifecycle: "ready" }).statusLabel, "Ready to start");
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress" }).statusLabel, "Interview in progress");
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress" }).voiceLabel, "Listening");
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress", isAiSpeaking: true }).voiceLabel, "Speaking");
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress", isProcessingAnswer: true }).voiceLabel, "Processing answer...");
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress", isWaitingForBackend: true }).voiceLabel, "Preparing next question...");
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress", isPreparingResponse: true }).voiceLabel, "Preparing next question...");
  assert.equal(getInterviewUiModel({ lifecycle: "completed" }).statusLabel, "Interview completed");
  assert.equal(getInterviewUiModel({ lifecycle: "ended" }).statusLabel, "Interview ended");
});

test("terminal interview outcomes require backend completion, status, or review data", () => {
  assert.equal(resolveTerminalInterviewState({ completed: true }), "completed");
  assert.equal(resolveTerminalInterviewState({ completed: true, manualReviewRequired: true }), "manual_review");
  assert.equal(resolveTerminalInterviewState({ sessionStatus: "incomplete" }), "ended");
  assert.equal(resolveTerminalInterviewState({ eligibilityOutcome: "reject" }), "rejected");
  assert.equal(resolveTerminalInterviewState({}), "end_unconfirmed");
  assert.equal(isTerminalInterviewState("manual_review"), true);
  assert.equal(isTerminalInterviewState("in_progress"), false);
  // Audio stopping alone has no role in the lifecycle decision.
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress", isAiSpeaking: false }).statusLabel, "Interview in progress");
});

test("candidate-visible question comes only from the approved question, not raw model output", () => {
  const approvedQuestion = "How do you handle a customer request?";
  const rawOutputTranscription = "<no speech>{pause} internal orchestration";
  assert.equal(getCandidateVisibleQuestion(approvedQuestion, rawOutputTranscription), approvedQuestion);
  assert.doesNotMatch(JSON.stringify(getCandidateVisibleQuestion(approvedQuestion)), /no speech|pause|orchestration/i);
  assert.match(getInterviewUiModel({ lifecycle: "in_progress" }).statusLabel, /Interview in progress/);
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress" }).voiceLabel, "Listening");
});

test("candidate-visible errors allow only reviewed English messages", () => {
  assert.equal(
    getCandidateSafeError("Sorry, your answer couldn't be processed. Please try again."),
    "Sorry, your answer couldn't be processed. Please try again.",
  );
  assert.equal(
    getCandidateSafeError("Gemini RateLimitError: internal event payload"),
    "Sorry, something went wrong. Please try again.",
  );
});

test("preparing voice state is available only during an active interview", () => {
  assert.equal(getInterviewUiModel({ lifecycle: "in_progress", isPreparingResponse: true }).voiceLabel, "Preparing next question...");
  assert.equal(getInterviewUiModel({ lifecycle: "ready", isPreparingResponse: true }).voiceLabel, null);
  assert.equal(getInterviewUiModel({ lifecycle: "manual_review", isAiSpeaking: false }).voiceLabel, null);
});

test("pre-interview state displays introductory placeholder rather than initial question", () => {
  assert.equal(
    getCandidateVisibleQuestion(""),
    "I’ll ask you a few questions about your salon skills and customer service.",
  );
  assert.equal(
    getCandidateVisibleQuestion("   "),
    "I’ll ask you a few questions about your salon skills and customer service.",
  );
  assert.equal(
    getCandidateVisibleQuestion("Namaste ji, sabse pehle aap apna naam bataiye."),
    "Namaste ji, sabse pehle aap apna naam bataiye.",
  );
});

test("interview paused state is non-terminal and has friendly status and recovery messaging", () => {
  assert.equal(getInterviewUiModel({ lifecycle: "paused" }).statusLabel, "Interview paused");
  assert.equal(isTerminalInterviewState("paused"), false);
  assert.equal(getInterviewUiModel({ lifecycle: "paused" }).voiceLabel, null);
  assert.equal(
    getCandidateSafeError("The connection was interrupted. Your progress is saved. Click Resume Interview to continue."),
    "The connection was interrupted. Your progress is saved. Click Resume Interview to continue.",
  );
});
