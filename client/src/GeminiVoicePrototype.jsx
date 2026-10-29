import { useGeminiLiveInterview } from "./hooks/useGeminiLiveInterview";
import AIOrb from "./components/AIOrb";
import InterviewControls from "./components/InterviewControls";
import InterviewStatus from "./components/InterviewStatus";
import CandidateCompletion from "./components/CandidateCompletion.js";
import { isTerminalInterviewState } from "./utils/interviewUiState.js";
import "./GeminiVoicePrototype.css";

// -----------------------------------------------------------------------------
// Gemini Live voice interview component
// -----------------------------------------------------------------------------
export default function GeminiVoicePrototype() {
  const {
    error,
    interviewLifecycle,
    currentQuestion,
    captionText,
    isProcessingAnswer,
    isPreparingResponse,
    isWaitingForBackend,
    audioLevel,
    isAiSpeaking,
    isInterviewActive,
    startingRef,
    start,
    pause,
    resume,
    stop,
    savedActiveSession,
    isInterviewOpen,
    setIsInterviewOpen,
  } = useGeminiLiveInterview();

  const interviewTerminal = isTerminalInterviewState(interviewLifecycle);
  const lifecycleBusy = interviewLifecycle === "starting" || interviewLifecycle === "ending";

  // ---------------------------------------------------------------------------
  // 1. Candidate Landing / Dashboard UI (before starting or resuming interview)
  // ---------------------------------------------------------------------------
  if (!isInterviewOpen) {
    return (
      <div className="p-6 sm:p-10 text-left">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-neutral-100">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-700">
              <span className="size-2 rounded-full bg-emerald-500" />
              AI Voice Interview
            </span>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-neutral-950 sm:text-3xl">
              Professional Assessment
            </h2>
            <p className="mt-1 text-sm text-neutral-600 max-w-xl">
              Answer questions speaking naturally into your microphone. Our AI screening assistant will evaluate your salon skills, experience, and customer handling.
            </p>
          </div>
        </div>

        {/* Preparation Guidelines */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-neutral-200/80 bg-neutral-50/50 p-4">
            <div className="flex items-center gap-2.5 text-neutral-900 font-semibold text-sm">
              <svg className="size-4 shrink-0 text-neutral-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              Microphone Required
            </div>
            <p className="mt-2 text-xs leading-relaxed text-neutral-600">
              Please allow microphone access when prompted. Ensure your audio is clear.
            </p>
          </div>

          <div className="rounded-xl border border-neutral-200/80 bg-neutral-50/50 p-4">
            <div className="flex items-center gap-2.5 text-neutral-900 font-semibold text-sm">
              <svg className="size-4 shrink-0 text-neutral-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Hindi or English
            </div>
            <p className="mt-2 text-xs leading-relaxed text-neutral-600">
              Aap Hindi ya English mein baat kar sakti hain. Speak naturally and confidently.
            </p>
          </div>

          <div className="rounded-xl border border-neutral-200/80 bg-neutral-50/50 p-4">
            <div className="flex items-center gap-2.5 text-neutral-900 font-semibold text-sm">
              <svg className="size-4 shrink-0 text-neutral-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              10–15 Minutes
            </div>
            <p className="mt-2 text-xs leading-relaxed text-neutral-600">
              Find a quiet place without background noise to complete your assessment.
            </p>
          </div>
        </div>

        {/* Saved Session banner (if active session exists) */}
        {savedActiveSession && (
          <div className="mt-6 rounded-xl border border-blue-200 bg-blue-50/70 p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-blue-600 text-white text-xs font-bold" aria-hidden="true">
                ✓
              </span>
              <div>
                <h3 className="text-sm font-semibold text-blue-950">
                  Interview in progress
                </h3>
                <p className="mt-1 text-xs text-blue-800 leading-relaxed">
                  {savedActiveSession.candidateName
                    ? `Welcome back, ${savedActiveSession.candidateName}! `
                    : ""}
                  Aapka previous interview progress saved hai. You can resume your assessment from where you left off.
                  {savedActiveSession.questionNumber && savedActiveSession.totalQuestions
                    ? ` (Question ${savedActiveSession.questionNumber} of ${savedActiveSession.totalQuestions})`
                    : ""}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </p>
        )}

        {/* Action Button */}
        <div className="mt-8 flex flex-wrap items-center gap-4">
          {savedActiveSession ? (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-2.5 rounded-xl bg-neutral-950 px-6 py-3.5 text-sm font-semibold text-white shadow-sm hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 focus-visible:ring-offset-2 transition disabled:opacity-60"
                onClick={async () => {
                  await resume();
                }}
                disabled={startingRef.current}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
                Resume Interview
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl border border-neutral-300 bg-white px-5 py-3.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 transition disabled:opacity-60"
                onClick={async () => {
                  await start();
                }}
                disabled={startingRef.current}
              >
                Start New Interview
              </button>
            </>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-2.5 rounded-xl bg-neutral-950 px-6 py-3.5 text-sm font-semibold text-white shadow-sm hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 focus-visible:ring-offset-2 transition disabled:opacity-60"
              onClick={async () => {
                await start();
              }}
              disabled={startingRef.current}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="2" width="6" height="13" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
              </svg>
              Start Interview
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Active Interview UI (rendered once explicitly started or resumed)
  // ---------------------------------------------------------------------------
  return (
    <main
      style={{
        minHeight: "auto",
        boxSizing: "border-box",
        padding: "12px 20px 18px",
        background: "radial-gradient(ellipse at 50% 42%, #f0f1ff 0%, #fff 53%)",
        color: "#111318",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        textAlign: "center",
        overflow: "hidden",
      }}
    >
      {/* Back to Overview link if paused */}
      {interviewLifecycle === "paused" && (
        <div style={{ textAlign: "left", maxWidth: 900, margin: "0 auto 8px" }}>
          <button
            type="button"
            className="text-xs font-semibold text-neutral-600 hover:text-neutral-950 underline"
            onClick={() => setIsInterviewOpen(false)}
          >
            ← Back to Assessment Overview
          </button>
        </div>
      )}

      {/* Interview status */}
      {interviewTerminal
        ? <CandidateCompletion outcome={interviewLifecycle} />
        : <InterviewStatus
            lifecycle={interviewLifecycle}
            isAiSpeaking={isAiSpeaking}
            isProcessingAnswer={isProcessingAnswer}
            isPreparingResponse={isPreparingResponse}
            isWaitingForBackend={isWaitingForBackend}
            error={error}
          />}

      {/* One orb, centered */}
      {!interviewTerminal && <AIOrb
        isAiSpeaking={isAiSpeaking}
        audioLevel={audioLevel}
        currentQuestion={currentQuestion}
        captionText={captionText}
      />}

      {/* Interview controls */}
      {!interviewTerminal && <InterviewControls
        start={start}
        pause={pause}
        resume={resume}
        stop={stop}
        startingRef={startingRef}
        isInterviewActive={isInterviewActive}
        isPaused={interviewLifecycle === "paused"}
        lifecycleBusy={lifecycleBusy}
      />}
    </main>
  );
}
