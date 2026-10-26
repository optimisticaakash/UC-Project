import { createInterviewReportView } from "../utils/interviewReport";

function ResultBadge({ children }) {
  return (
    <span className="uc-report-badge">
      {children}
    </span>
  );
}

export default function InterviewReport({ report, loading, error, onRetry }) {
  const view = createInterviewReportView(report);

  if (loading) {
    return (
      <section className="uc-report" aria-live="polite">
        <h2>Interview report</h2>
        <p>Final report is loading…</p>
      </section>
    );
  }

  if (!view && !error) return null;

  return (
    <section className="uc-report" aria-labelledby="uc-report-title">
      <div className="uc-report-header">
        <h2 id="uc-report-title">Interview report</h2>
        {view && <ResultBadge>{view.statusLabel}</ResultBadge>}
      </div>

      {error && (
        <div role="alert" className="uc-report-error">
          <p>{error}</p>
          {onRetry && (
            <button className="uc-report-retry" onClick={() => onRetry()}>
              Retry loading report
            </button>
          )}
        </div>
      )}

      {view && !view.isFinal && (
        <p role="status">This interview is not complete yet. No final report is available.</p>
      )}

      {view?.isFinal && (
        <>
          <div className="uc-report-summary">
            <span>Answers recorded: {view.answeredQuestions}</span>
            <span>Question bank size: {view.totalQuestions}</span>
            {view.consentOutcome && <span>Consent: {view.consentOutcome}</span>}
            {view.eligibilityOutcome && (
              <span>Eligibility outcome: {view.eligibilityOutcome}</span>
            )}
            {view.locationOutcome && <span>Location outcome: {view.locationOutcome}</span>}
            {view.manualReviewRequired && <ResultBadge>Manual review required</ResultBadge>}
          </div>

          {view.manualReviewReason && (
            <p className="uc-report-review-reason">
              Manual-review note: {view.manualReviewReason}
            </p>
          )}

          {view.manualChecks.length > 0 && (
            <div className="uc-report-checks">
              <h3>Manual checks</h3>
              <ul>
                {view.manualChecks.map((check, index) => (
                  <li key={`${check.questionId || "check"}-${index}`}>
                    {check.questionId || "Interview check"}: {check.outcome || "Review required"}
                    {check.travelWillingness && ` · Travel: ${check.travelWillingness}`}
                    {check.moveTimelineAnswer && ` · Timeline recorded`}
                    {check.followUpAnswer && ` · Follow-up recorded`}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3>Question-by-question results</h3>
          {view.answers.length === 0 ? (
            <p>No answers were recorded.</p>
          ) : (
            <ol className="uc-report-answers">
              {view.answers.map((entry, index) => (
                <li key={`${entry.questionId || "answer"}-${index}`}>
                  <div className="uc-report-answer-heading">
                    <strong>{entry.questionId || `Answer ${index + 1}`}</strong>
                    {entry.interpretation?.answerStatus && (
                      <ResultBadge>{entry.interpretation.answerStatus}</ResultBadge>
                    )}
                    {entry.manualReviewRequired && <ResultBadge>Manual review</ResultBadge>}
                  </div>
                  {entry.questionText && <p className="uc-report-question">{entry.questionText}</p>}
                  <p className="uc-report-answer">{entry.answer || "No answer recorded"}</p>
                  {entry.interpretation?.understanding && (
                    <p className="uc-report-interpretation">
                      Recorded interpretation: {entry.interpretation.understanding}
                    </p>
                  )}
                  {(entry.consentOutcome || entry.eligibilityOutcome || entry.age != null ||
                    entry.travelWillingness || entry.childPresence) && (
                    <div className="uc-report-summary uc-report-entry-details">
                      {entry.consentOutcome && <span>Consent: {entry.consentOutcome}</span>}
                      {entry.age != null && <span>Age: {entry.age}</span>}
                      {entry.eligibilityOutcome && (
                        <span>Eligibility outcome: {entry.eligibilityOutcome}</span>
                      )}
                      {entry.travelWillingness && (
                        <span>Travel willingness: {entry.travelWillingness}</span>
                      )}
                      {entry.childPresence && <span>Children: {entry.childPresence}</span>}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
