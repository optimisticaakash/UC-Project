import test from "node:test";
import assert from "node:assert/strict";
import {
  canResumeSession,
  getCandidateVisibleQuestion,
  getCandidateSafeError,
  getInterviewUiModel,
  isTerminalInterviewState,
  resolveTerminalInterviewState,
  shouldDisplayInterviewView,
  AI_CAPTION_STATES,
  AI_CAPTION_LOADING_TEXT,
  resolveAiCaptionModel,
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
  assert.equal(resolveTerminalInterviewState({ sessionStatus: "terminated" }), "terminated");
  assert.equal(resolveTerminalInterviewState({ terminated: true }), "terminated");
  assert.equal(resolveTerminalInterviewState({}), "end_unconfirmed");
  assert.equal(isTerminalInterviewState("manual_review"), true);
  assert.equal(isTerminalInterviewState("terminated"), true);
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

test("canResumeSession accepts only active in_progress or paused sessions", () => {
  assert.equal(canResumeSession({ sessionId: "sess-1", status: "in_progress" }), true);
  assert.equal(canResumeSession({ sessionId: "sess-1", status: "paused" }), true);
  assert.equal(canResumeSession({ sessionId: "sess-1", status: "completed" }), false);
  assert.equal(canResumeSession({ sessionId: "sess-1", status: "terminated" }), false);
  assert.equal(canResumeSession({ sessionId: "sess-1", status: "ended" }), false);
  assert.equal(canResumeSession({ sessionId: "sess-1", status: "manual_review" }), false);
  assert.equal(canResumeSession({ status: "in_progress" }), false);
  assert.equal(canResumeSession(null), false);
  assert.equal(canResumeSession(undefined), false);
});

test("shouldDisplayInterviewView prevents premature interview view on home screen before explicit start/resume", () => {
  assert.equal(shouldDisplayInterviewView({ isInterviewOpen: false }), false);
  assert.equal(shouldDisplayInterviewView({ isInterviewOpen: true }), true);
  assert.equal(shouldDisplayInterviewView(), false);
});

test("Regression Voice Sync 1: Preparing next question state prevents premature Listening state", () => {
  // While next question prompt is being sent or audio is decoding, UI must not state 'Listening'
  const preparingModel = getInterviewUiModel({
    lifecycle: "in_progress",
    isPreparingResponse: true,
    isAiSpeaking: false,
  });
  assert.equal(preparingModel.voiceLabel, "Preparing next question...");

  // Listening state begins only after AI playback has ended and preparation is done
  const listeningModel = getInterviewUiModel({
    lifecycle: "in_progress",
    isPreparingResponse: false,
    isAiSpeaking: false,
    isWaitingForBackend: false,
    isProcessingAnswer: false,
  });
  assert.equal(listeningModel.voiceLabel, "Listening");
});

test("Regression Voice Sync 2: Missing audio recovery error is recognized as a safe candidate error", () => {
  const safeErr = getCandidateSafeError(
    "Sorry, I couldn't prepare the next question. Please ask me to repeat it or try your answer again.",
  );
  assert.equal(
    safeErr,
    "Sorry, I couldn't prepare the next question. Please ask me to repeat it or try your answer again.",
  );
});

test("AI Caption Lifecycle 1: Question loaded but audio not started shows loading status and hides full question", () => {
  const question = "Namaste! Aapka naam Aakash hai, sahi hai na?";
  const model = resolveAiCaptionModel({
    currentQuestion: question,
    captionText: "",
    isAiSpeaking: false,
    aiCaptionState: AI_CAPTION_STATES.LOADING,
  });

  assert.equal(model.state, "loading");
  assert.equal(model.badgeText, "Preparing...");
  assert.equal(model.captionText, AI_CAPTION_LOADING_TEXT);
  assert.notEqual(model.captionText, question);
  assert.equal(model.isLoading, true);
  assert.equal(model.isSpeaking, false);
  assert.equal(model.isCompleted, false);
});

test("AI Caption Lifecycle 2: Audio playback starts shows the progressive AI question caption", () => {
  const question = "Namaste! Aapka naam Aakash hai, sahi hai na?";
  const progressiveChunk = "Namaste! Aapka naam";
  const model = resolveAiCaptionModel({
    currentQuestion: question,
    captionText: progressiveChunk,
    isAiSpeaking: true,
    aiCaptionState: AI_CAPTION_STATES.SPEAKING,
  });

  assert.equal(model.state, "speaking");
  assert.equal(model.badgeText, "Speaking...");
  assert.equal(model.captionText, progressiveChunk);
  assert.equal(model.isLoading, false);
  assert.equal(model.isSpeaking, true);
  assert.equal(model.isCompleted, false);
});

test("AI Caption Lifecycle 3: Audio playback completes retains final caption and marks completed", () => {
  const question = "Namaste! Aapka naam Aakash hai, sahi hai na?";
  const model = resolveAiCaptionModel({
    currentQuestion: question,
    captionText: question,
    isAiSpeaking: false,
    aiCaptionState: AI_CAPTION_STATES.COMPLETED,
  });

  assert.equal(model.state, "completed");
  assert.equal(model.badgeText, "Completed");
  assert.equal(model.captionText, question);
  assert.equal(model.isLoading, false);
  assert.equal(model.isSpeaking, false);
  assert.equal(model.isCompleted, true);
});

test("AI Caption Lifecycle 4: Audio generation/playback failure does not show a false speaking caption", () => {
  const question = "Aap kis shahar mein rehti hain?";
  const model = resolveAiCaptionModel({
    currentQuestion: question,
    captionText: "",
    isAiSpeaking: false,
    isPreparingResponse: false,
  });

  assert.notEqual(model.state, "speaking");
  assert.equal(model.isSpeaking, false);
  assert.notEqual(model.captionText, question);
  assert.equal(model.captionText, AI_CAPTION_LOADING_TEXT);
});

test("AI Caption Lifecycle 5: A new question starting before previous playback completes clears old caption", () => {
  // Turn 1 had completed text
  const turn1Question = "Question 1: Aapka naam kya hai?";
  const completedTurn1 = resolveAiCaptionModel({
    currentQuestion: turn1Question,
    captionText: turn1Question,
    isAiSpeaking: false,
    aiCaptionState: AI_CAPTION_STATES.COMPLETED,
  });
  assert.equal(completedTurn1.captionText, turn1Question);

  // Turn 2 begins: new question loads, captionText resets to empty
  const turn2Question = "Question 2: Aapka shahar kaun sa hai?";
  const loadingTurn2 = resolveAiCaptionModel({
    currentQuestion: turn2Question,
    captionText: "",
    isAiSpeaking: false,
    aiCaptionState: AI_CAPTION_STATES.LOADING,
  });

  assert.equal(loadingTurn2.state, "loading");
  assert.equal(loadingTurn2.captionText, AI_CAPTION_LOADING_TEXT);
  assert.notEqual(loadingTurn2.captionText, turn1Question);
  assert.notEqual(loadingTurn2.captionText, turn2Question);
});

test("AI Caption Lifecycle 6: Existing AI and Candidate captions continue working independently", () => {
  // AI is in loading state
  const aiLoadingModel = resolveAiCaptionModel({
    currentQuestion: "Question 2",
    captionText: "",
    isAiSpeaking: false,
    aiCaptionState: AI_CAPTION_STATES.LOADING,
  });

  // Candidate transcription exists from speech
  const candidateTranscript = "Haan, mera naam Aakash hai";

  // Both exist without interfering with one another
  assert.equal(aiLoadingModel.captionText, AI_CAPTION_LOADING_TEXT);
  assert.equal(candidateTranscript, "Haan, mera naam Aakash hai");

  // When AI transitions to speaking, candidate text remains distinct
  const aiSpeakingModel = resolveAiCaptionModel({
    currentQuestion: "Question 2",
    captionText: "Aap kis",
    isAiSpeaking: true,
    aiCaptionState: AI_CAPTION_STATES.SPEAKING,
  });
  assert.equal(aiSpeakingModel.captionText, "Aap kis");
  assert.equal(candidateTranscript, "Haan, mera naam Aakash hai");
});

