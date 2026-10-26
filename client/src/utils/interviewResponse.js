export function resolvePromptHandoff(status, data) {
  const staleRecovery = Boolean(
    status === 409 && data?.staleQuestion && data.question?.text,
  );
  const successfulResponse = status >= 200 && status < 300 && data?.success;

  if (!staleRecovery && !successfulResponse) return null;

  const clarificationRequired = Boolean(data.clarificationRequired);
  const prompt = staleRecovery
    ? data.question.text
    : clarificationRequired
      ? data.message || data.question?.text
      : data.question?.text;

  if (!prompt) return null;

  return {
    questionId: data.question?.id || data.currentQuestionId || null,
    prompt,
    clarificationRequired,
    staleRecovery,
  };
}

export function isLostInterviewSession(status, data) {
  return status === 404 && data?.code === "SESSION_NOT_FOUND";
}
