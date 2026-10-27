export function reportBelongsToSession(report, sessionId) {
  return Boolean(report && sessionId && report.sessionId === sessionId);
}

export const candidateCompletionMessage = "Thank you. Your interview is complete.";
