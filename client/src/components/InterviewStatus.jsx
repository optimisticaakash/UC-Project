export default function InterviewStatus({ status, error }) {
  return (
    <>
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
        <h1
          className="uc-heading"
          style={{
            margin: 0,
            fontSize: "clamp(20px, 2.7vw, 26px)",
            lineHeight: 1.2,
            fontWeight: 750,
            letterSpacing: "-1px",
            color: "#111318",
            textAlign: "left",
          }}
        >
          Salon Professional Interview
        </h1>

        <p
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            margin: 0,
            color: "#657084",
            fontSize: 13,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: status.startsWith("Connected")
                ? "#16a34a"
                : "#9ca3af",
              flexShrink: 0,
            }}
          />
          {status}
        </p>
      </div>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", marginTop: 16 }}>
          {error}
        </p>
      )}
    </>
  );
}
