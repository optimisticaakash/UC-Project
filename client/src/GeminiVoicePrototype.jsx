import { useGeminiLiveInterview } from "./hooks/useGeminiLiveInterview";
import AIOrb from "./components/AIOrb";
import InterviewControls from "./components/InterviewControls";
import InterviewStatus from "./components/InterviewStatus";
import CandidateCompletion from "./components/CandidateCompletion.js";
import "./GeminiVoicePrototype.css";
// -----------------------------------------------------------------------------
// Gemini Live voice interview component
// -----------------------------------------------------------------------------
export default function GeminiVoicePrototype() {
const {
  messages,
  status,
  error,
  interviewComplete,
  interviewEnded,
  audioLevel,
  isAiSpeaking,
  startingRef,
  start,
  stop,
} = useGeminiLiveInterview();

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
      {interviewComplete || interviewEnded ? <CandidateCompletion endedEarly={interviewEnded} /> : <InterviewStatus status={status} error={error} />}

      {/* One orb, centered */}
      {!interviewComplete && !interviewEnded && <AIOrb
        isAiSpeaking={isAiSpeaking}
        audioLevel={audioLevel}
        messages={messages}
      />}

      {/* One set of interview buttons */}
      {/* Interview controls */}
      {!interviewComplete && !interviewEnded && <InterviewControls
        start={start}
        stop={stop}
        startingRef={startingRef}
        status={status}
      />}
    </main>
  );
}
