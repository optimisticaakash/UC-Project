const UI_STATES = {
  ready: { statusLabel: "Ready to start", terminal: false },
  starting: { statusLabel: "Starting interview...", terminal: false },
  in_progress: { statusLabel: "Interview in progress", terminal: false },
  paused: { statusLabel: "Interview paused", terminal: false },
  ending: { statusLabel: "Ending interview...", terminal: false },
  completed: { statusLabel: "Interview completed", terminal: true },
  ended: { statusLabel: "Interview ended", terminal: true },
  manual_review: { statusLabel: "Manual review required", terminal: true },
  rejected: { statusLabel: "Interview ended", terminal: true },
  end_unconfirmed: { statusLabel: "Interview status unavailable", terminal: true },
  error: { statusLabel: "Interview paused", terminal: false },
};

const INTRODUCTORY_PLACEHOLDER =
  "I’ll ask you a few questions about your salon skills and customer service.";
const SAFE_CANDIDATE_ERRORS = new Set([
  "Sorry, I couldn't repeat the question. Please try again or continue with your answer.",
  "Sorry, I couldn't prepare the next question. Please ask me to repeat it or try your answer again.",
  "Sorry, your answer couldn't be processed. Please try again.",
  "I couldn't hear you. Please continue speaking or try again.",
  "Sorry, the connection was interrupted. Please restart the interview.",
  "Sorry, the connection closed. Please restart the interview.",
  "The connection was interrupted. Your progress is saved. Click Resume Interview to continue.",
  "Microphone permission is needed. Please allow access and try again.",
  "Sorry, the interview couldn't start. Please check your connection and try again.",
  "I couldn't confirm that the interview ended. Please contact support.",
  "Sorry, the interview couldn't be paused. Please try again.",
  "Sorry, the interview couldn't be resumed. Please try again.",
]);

export function getCandidateVisibleQuestion(currentQuestion) {
  return typeof currentQuestion === "string" && currentQuestion.trim()
    ? currentQuestion
    : INTRODUCTORY_PLACEHOLDER;
}

export function getCandidateSafeError(error) {
  if (!error) return "";
  return SAFE_CANDIDATE_ERRORS.has(error)
    ? error
    : "Sorry, something went wrong. Please try again.";
}

export function resolveTerminalInterviewState({
  completed = false,
  sessionStatus = null,
  manualReviewRequired = false,
  eligibilityOutcome = null,
} = {}) {
  if (manualReviewRequired || sessionStatus === "manual_review") return "manual_review";
  if (eligibilityOutcome === "reject" || sessionStatus === "rejected") return "rejected";
  if (completed || sessionStatus === "completed") return "completed";
  if (sessionStatus === "incomplete") return "ended";
  return "end_unconfirmed";
}

export function isTerminalInterviewState(state) {
  return Boolean(UI_STATES[state]?.terminal);
}

export function getInterviewUiModel({
  lifecycle = "ready",
  isAiSpeaking = false,
  isProcessingAnswer = false,
  isPreparingResponse = false,
  isWaitingForBackend = false,
} = {}) {
  const state = UI_STATES[lifecycle] || UI_STATES.error;
  let voiceLabel = null;
  if (lifecycle === "in_progress") {
    if (isAiSpeaking) voiceLabel = "Speaking";
    else if (isWaitingForBackend) voiceLabel = WAITING_STATUS;
    else if (isProcessingAnswer) voiceLabel = "Processing answer...";
    else if (isPreparingResponse) voiceLabel = "Preparing next question...";
    else voiceLabel = "Listening";
  }
  return { ...state, voiceLabel };
}

export const WAITING_STATUS = "Preparing next question...";

