export default function InterviewControls({
  start,
  pause,
  resume,
  stop,
  startingRef,
  isInterviewActive,
  isPaused = false,
  lifecycleBusy = false,
}) {
  return (
    <div
      className="uc-actions"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        margin: "24px auto 0",
      }}
    >
      {isPaused ? (
        <button
          type="button"
          className="uc-action uc-primary"
          onClick={resume}
          disabled={lifecycleBusy}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <polygon points="6 4 20 12 6 20 6 4" />
          </svg>
          <span>Resume Interview</span>
        </button>
      ) : (
        <button
          type="button"
          className="uc-action uc-primary"
          onClick={start}
          disabled={startingRef.current || lifecycleBusy || isInterviewActive}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="2" width="6" height="13" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
          </svg>
          <span>Start Interview</span>
        </button>
      )}

      {isInterviewActive && !isPaused && typeof pause === "function" && (
        <button
          type="button"
          className="uc-action uc-secondary"
          onClick={pause}
          disabled={lifecycleBusy}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
          <span>Pause Interview</span>
        </button>
      )}

      <button
        type="button"
        className="uc-action uc-secondary"
        onClick={() => stop("user_requested")}
        disabled={(!isInterviewActive && !isPaused) || lifecycleBusy}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
        <span>End Interview</span>
      </button>
    </div>
  );
}
