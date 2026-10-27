import { useEffect, useState } from "react";
import { getCandidateSafeError, getInterviewUiModel } from "../utils/interviewUiState.js";

export default function InterviewStatus({
  lifecycle,
  isAiSpeaking,
  isProcessingAnswer,
  isPreparingResponse,
  isWaitingForBackend,
  error,
}) {
  const model = getInterviewUiModel({ lifecycle, isAiSpeaking, isProcessingAnswer, isPreparingResponse, isWaitingForBackend });
  const safeError = getCandidateSafeError(error);
  const [showPreparing, setShowPreparing] = useState(false);

  useEffect(() => {
    if (!isPreparingResponse || lifecycle !== "in_progress") {
      setShowPreparing(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowPreparing(true), 450);
    return () => clearTimeout(timer);
  }, [isPreparingResponse, lifecycle]);

  const preparing = model.voiceLabel === "Preparing next question...";
  const voiceLabel = preparing && !showPreparing
    ? ""
    : model.voiceLabel;
  const active = lifecycle === "in_progress";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        width: "100%",
        maxWidth: 900,
        margin: "8px auto 0",
      }}
    >
      <h1 className="uc-heading" style={{
        margin: 0,
        fontSize: "clamp(20px, 2.7vw, 26px)",
        lineHeight: 1.2,
        fontWeight: 750,
        letterSpacing: "-1px",
        color: "#111318",
        textAlign: "left",
      }}>
        Salon Professional Interview
      </h1>

      <div aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#252833", fontSize: 13, fontWeight: 700 }}>
          <span aria-hidden="true" style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: active ? "#16a34a" : "#9ca3af",
            boxShadow: active ? "0 0 0 3px rgba(22,163,74,.12)" : "none",
            flexShrink: 0,
          }} />
          {model.statusLabel}
        </span>
        {isWaitingForBackend && <span style={{ color: "#657084", fontSize: 13 }}>
          <span aria-hidden="true" className="uc-status-spinner" />
          Preparing next question...
        </span>}
        {voiceLabel && (!isWaitingForBackend || isAiSpeaking) && <span style={{ color: "#657084", fontSize: 13 }}>
          {preparing && showPreparing && <span aria-hidden="true" className="uc-status-spinner" />}
          {voiceLabel}
        </span>}
      </div>

      {safeError && <p role="alert" style={{ flexBasis: "100%", color: "#b91c1c", margin: "4px 0 0", textAlign: "left" }}>{safeError}</p>}
    </div>
  );
}
