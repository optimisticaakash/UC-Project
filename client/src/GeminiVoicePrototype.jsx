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
} = useGeminiLiveInterview();
  const interviewTerminal = isTerminalInterviewState(interviewLifecycle);
  const lifecycleBusy = interviewLifecycle === "starting" || interviewLifecycle === "ending";

  // ---------------------------------------------------------------------------
  // Interview UI
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
      {/* One main heading and one status */}
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
      />}

      {/* One set of interview buttons */}
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
