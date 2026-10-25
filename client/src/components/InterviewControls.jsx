export default function InterviewControls({
  start,
  stop,
  startingRef,
  status,
}) {
  return (
    <div
      className="uc-actions"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        margin: "0 auto",
      }}
    >
      <button
        className="uc-action uc-primary"
        onClick={start}
        disabled={startingRef.current || status.startsWith("Connected")}
      >
        <svg
          width="19"
          height="19"
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
        Start Interview
      </button>

      <button className="uc-action uc-secondary" onClick={stop}>
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
        End Interview
      </button>
    </div>
  );
}
