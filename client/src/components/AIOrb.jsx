export default function AIOrb({ isAiSpeaking, audioLevel, messages }) {
  const latestAiMessage =
    messages.filter((message) => message.role === "AI").slice(-1)[0]?.text ||
    "I’ll ask you a few questions about your salon skills and customer service.";

  return (
    <section aria-label="AI interviewer" aria-live="polite">
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

      <h2
        style={{
          margin: 0,
          fontSize: 23,
          fontWeight: 750,
          letterSpacing: "-.8px",
          color: "#111318",
        }}
      >
        AI Interviewer
      </h2>

      <p
        style={{
          maxWidth: 680,
          margin: "10px auto 18px",
          color: "#252833",
          fontSize: "clamp(14px, 1.6vw, 17px)",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {latestAiMessage}
      </p>
    </section>
  );
}
