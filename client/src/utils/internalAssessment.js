export function reportBelongsToSession(report, sessionId) {
  return Boolean(report && sessionId && report.sessionId === sessionId);
}

export const candidateCompletionMessage = "धन्यवाद। आपका इंटरव्यू पूरा हो गया है।";
