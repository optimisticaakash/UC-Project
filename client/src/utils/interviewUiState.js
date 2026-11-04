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
  terminated: { statusLabel: "Interview terminated", terminal: true },
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
  terminated = false,
} = {}) {
  if (terminated || sessionStatus === "terminated") return "terminated";
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

export const AI_CAPTION_STATES = {
  IDLE: "idle",
  LOADING: "loading",
  SPEAKING: "speaking",
  COMPLETED: "completed",
  INTERRUPTED: "interrupted",
};

export const AI_CAPTION_LOADING_TEXT = "Preparing your next question...";

export function resolveAiCaptionModel({
  aiCaptionState = null,
  isAiSpeaking = false,
  isPreparingResponse = false,
  captionText = "",
  currentQuestion = "",
} = {}) {
  let state = aiCaptionState;
  if (!state) {
    if (isAiSpeaking) {
      state = "speaking";
    } else if (isPreparingResponse) {
      state = "loading";
    } else if (captionText) {
      state = "completed";
    } else if (currentQuestion) {
      state = "loading";
    } else {
      state = "idle";
    }
  }

  if (state === "loading") {
    return {
      state: "loading",
      badgeText: "Preparing...",
      badgeClass: "text-amber-700 bg-amber-50 animate-pulse",
      indicatorClass: "bg-amber-400 animate-pulse",
      captionText: AI_CAPTION_LOADING_TEXT,
      isLoading: true,
      isSpeaking: false,
      isCompleted: false,
    };
  }

  if (state === "speaking") {
    return {
      state: "speaking",
      badgeText: "Speaking...",
      badgeClass: "text-blue-600 bg-blue-50",
      indicatorClass: "bg-blue-600 animate-pulse",
      captionText: captionText || "...",
      isLoading: false,
      isSpeaking: true,
      isCompleted: false,
    };
  }

  if (state === "completed") {
    return {
      state: "completed",
      badgeText: "Completed",
      badgeClass: "text-neutral-600 bg-neutral-100",
      indicatorClass: "bg-neutral-400",
      captionText: captionText || getCandidateVisibleQuestion(currentQuestion),
      isLoading: false,
      isSpeaking: false,
      isCompleted: true,
    };
  }

  if (state === "interrupted") {
    return {
      state: "interrupted",
      badgeText: "Interrupted",
      badgeClass: "text-amber-800 bg-amber-100/80",
      indicatorClass: "bg-amber-500",
      captionText: captionText || "...",
      isLoading: false,
      isSpeaking: false,
      isCompleted: false,
    };
  }

  // idle / initial
  return {
    state: "idle",
    badgeText: null,
    badgeClass: "",
    indicatorClass: "bg-neutral-400",
    captionText: "Preparing question...",
    isLoading: false,
    isSpeaking: false,
    isCompleted: false,
  };
}

export function canResumeSession(session) {
  return Boolean(
    session &&
      session.sessionId &&
      (session.status === "in_progress" || session.status === "paused")
  );
}

export function shouldDisplayInterviewView({ isInterviewOpen = false } = {}) {
  return Boolean(isInterviewOpen);
}

