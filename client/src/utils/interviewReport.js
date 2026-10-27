const FINAL_STATUSES = new Set(["completed", "incomplete", "manual_review", "rejected"]);

const STATUS_LABELS = {
  completed: "Interview completed",
  incomplete: "Interview ended before completion",
  manual_review: "Manual review required",
  rejected: "Interview ended with an eligibility outcome",
  in_progress: "Interview in progress",
};

export function isFinalInterviewReport(report) {
  return FINAL_STATUSES.has(report?.status);
}

export function createInterviewReportView(report) {
  if (!report || typeof report !== "object") return null;

  return {
    status: report.status,
    candidateName: report.candidateName || null,
    startedAt: report.startedAt || null,
    completedAt: report.completedAt || report.endedAt || null,
    statusLabel: STATUS_LABELS[report.status] || "Interview status unavailable",
    isFinal: isFinalInterviewReport(report),
    totalQuestions: Number.isFinite(report.totalQuestions)
      ? report.totalQuestions
      : 0,
    answeredQuestions: Number.isFinite(report.answeredQuestions)
      ? report.answeredQuestions
      : 0,
    manualReviewRequired: Boolean(report.manualReviewRequired),
    manualReviewReason: report.manualReviewReason || null,
    consentOutcome: report.consentOutcome || null,
    eligibilityOutcome: report.eligibilityOutcome || null,
    locationOutcome: report.locationOutcome || null,
    manualChecks: Array.isArray(report.manualChecks) ? report.manualChecks : [],
    answers: Array.isArray(report.answers) ? report.answers : [],
    pendingInterpretation: report.pendingInterpretation || null,
  };
}
