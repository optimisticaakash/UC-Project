import { createInterviewReportView } from "../utils/interviewReport";

function ResultBadge({ children }) {
  return (
    <span className="uc-report-badge">
      {children}
    </span>
  );
}

export default function InterviewReport({ report, loading, error, onRetry, onDownload }) {
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
      {report?.candidateName && <p className="text-sm text-neutral-600">Candidate: {report.candidateName}</p>}

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

      {view && (
        <>
          <div className="uc-report-summary">
            {report?.sessionId && <span>Session: {report.sessionId}</span>}
            <span>Status: {view.status || "Unavailable"}</span>
            <span>Answers recorded: {view.answeredQuestions}</span>
            <span>Question bank size: {view.totalQuestions}</span>
            {report?.startedAt && <span>Started: {new Date(report.startedAt).toLocaleString()}</span>}
            {(report?.completedAt || report?.endedAt) && <span>Ended: {new Date(report.completedAt || report.endedAt).toLocaleString()}</span>}
            {view.consentOutcome && <span>Consent: {view.consentOutcome}</span>}
            {view.eligibilityOutcome && (
              <span>Eligibility outcome: {view.eligibilityOutcome}</span>
            )}
            {view.locationOutcome && <span>Location outcome: {view.locationOutcome}</span>}
            {view.manualReviewRequired && <ResultBadge>Manual review required</ResultBadge>}
            {view.status === "terminated" && <ResultBadge>Interview terminated</ResultBadge>}
          </div>

          {view.terminationReason && (
            <p className="uc-report-review-reason">
              Termination reason: {view.terminationReason}{view.terminatedAtQuestionId ? ` (at question ${view.terminatedAtQuestionId})` : ""}
            </p>
          )}

          {view.manualReviewReason && (
            <p className="uc-report-review-reason">
              Manual-review note: {view.manualReviewReason}
            </p>
          )}

          {view.pendingInterpretation?.answer && (
            <div className="my-4 rounded-xl border border-neutral-300 bg-neutral-50 p-4">
              <h3 className="font-semibold">Answer awaiting interpretation retry</h3>
              <p className="mt-1 text-sm text-neutral-600">{view.pendingInterpretation.questionId}{view.pendingInterpretation.questionText ? ` · ${view.pendingInterpretation.questionText}` : ""}</p>
              <p className="mt-2 whitespace-pre-wrap">{view.pendingInterpretation.answer}</p>
            </div>
          )}

          {view.manualChecks.length > 0 && (
            <div className="uc-report-checks">
              <h3>Manual checks</h3>
              <ul>
                {view.manualChecks.map((check, index) => (
                  <li key={`${check.questionId || "check"}-${index}`}>
                    {check.questionId || "Interview check"}: {check.outcome || "Review required"}
                    {check.area && ` · Area: ${check.area}`}
                    {check.travelWillingness && ` · Travel: ${check.travelWillingness}`}
                    {check.moveTimelineAnswer && ` · Timeline: ${check.moveTimelineAnswer}`}
                    {check.followUpAnswer && ` · Follow-up: ${check.followUpAnswer}`}
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
                  {entry.previousInterpretationAttempts?.map((attempt, attemptIndex) => <p className="mt-2 text-sm text-neutral-600" key={`prior-answer-${attemptIndex}`}>Prior answer attempt: {attempt}</p>)}
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
                      {entry.location && <span>Area: {entry.location}</span>}
                      {entry.childPresence && <span>Children: {entry.childPresence}</span>}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {onDownload && <div className="mt-8 border-t border-neutral-200 pt-5 print:hidden"><button className="inline-flex min-h-10 items-center justify-center rounded-lg bg-neutral-950 px-4 text-sm font-semibold text-white transition hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/20" onClick={onDownload} type="button">Download PDF</button></div>}
        </>
      )}
    </section>
  );
}
