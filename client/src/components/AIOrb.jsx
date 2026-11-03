import { getCandidateVisibleQuestion } from "../utils/interviewUiState.js";

export default function AIOrb({
  isAiSpeaking,
  audioLevel,
  currentQuestion,
  captionText,
  candidateTranscript = "",
}) {
  const visibleQuestion = isAiSpeaking
    ? (captionText || currentQuestion || "")
    : (captionText || getCandidateVisibleQuestion(currentQuestion));

  return (
    <section aria-label="AI interview session" aria-live="polite">
      <div className="uc-orb-stage">
        <div className={`uc-ripple ${isAiSpeaking ? "active" : ""}`} />

        <div className={`uc-ripple delay-1 ${isAiSpeaking ? "active" : ""}`} />

        <div className={`uc-ripple delay-2 ${isAiSpeaking ? "active" : ""}`} />

        <div className="uc-floor-glow" />

        <div
          className="uc-liquid-orb"
          style={{
            transform: `scale(${1 + audioLevel * 0.22})`,
            boxShadow: `
              inset -18px -20px 32px #000,
              inset 5px 6px 16px rgba(220,230,255,.7),
              0 0 ${8 + audioLevel * 16}px rgba(90,125,255,.9),
              0 0 ${30 + audioLevel * 35}px rgba(75,95,255,.48),
              0 22px 55px rgba(50,65,160,.25)
            `,
          }}
        />
      </div>

      {/* Two separate caption boxes: AI Interviewer and Candidate */}
      <div className="mx-auto mt-4 w-full max-w-3xl grid grid-cols-1 md:grid-cols-2 gap-4 text-left px-2 sm:px-0">
        {/* Box 1: AI Interviewer */}
        <div
          className="rounded-2xl border border-neutral-200/90 bg-white/95 p-4 sm:p-5 shadow-sm flex flex-col justify-between min-h-[130px]"
          aria-label="AI Interviewer captions"
        >
          <div>
            <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-neutral-100">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-800 flex items-center gap-2">
                <span
                  className={`inline-block size-2 rounded-full ${
                    isAiSpeaking ? "bg-blue-600 animate-pulse" : "bg-neutral-400"
                  }`}
                />
                AI Interviewer
              </span>
              {isAiSpeaking && (
                <span className="text-[11px] font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                  Speaking...
                </span>
              )}
            </div>
            <p className="text-sm sm:text-base text-neutral-900 leading-relaxed whitespace-pre-wrap break-words">
              {visibleQuestion || "Preparing question..."}
            </p>
          </div>
        </div>

        {/* Box 2: Candidate */}
        <div
          className="rounded-2xl border border-neutral-200/90 bg-white/95 p-4 sm:p-5 shadow-sm flex flex-col justify-between min-h-[130px]"
          aria-label="Candidate captions"
        >
          <div>
            <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-neutral-100">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-800 flex items-center gap-2">
                <span
                  className={`inline-block size-2 rounded-full ${
                    candidateTranscript
                      ? "bg-emerald-600"
                      : isAiSpeaking
                        ? "bg-neutral-300"
                        : "bg-emerald-500 animate-pulse"
                  }`}
                />
                Candidate
              </span>
              {!isAiSpeaking && (
                <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                  {candidateTranscript ? "Recorded" : "Listening..."}
                </span>
              )}
            </div>
            {candidateTranscript ? (
              <p className="text-sm sm:text-base text-neutral-900 leading-relaxed whitespace-pre-wrap break-words">
                {candidateTranscript}
              </p>
            ) : (
              <p className="text-sm text-neutral-400 italic leading-relaxed">
                {isAiSpeaking
                  ? "Listening begins when AI interviewer finishes speaking..."
                  : "Listening... speak into your microphone"}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
