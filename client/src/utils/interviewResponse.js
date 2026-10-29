import { buildApiUrl } from "./apiUrl.js";

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

  const handoff = {
    questionId: data.question?.id || data.currentQuestionId || null,
    prompt,
    clarificationRequired,
    staleRecovery,
  };

  if (data.warningLevel !== undefined && data.warningLevel !== null) {
    handoff.warningLevel = data.warningLevel;
  }
  if (data.warning !== undefined) {
    handoff.warning = Boolean(data.warning);
  }
  if (data.warningMessage) {
    handoff.warningMessage = data.warningMessage;
  }
  if (data.repeatedQuestionText) {
    handoff.repeatedQuestionText = data.repeatedQuestionText;
  }
  if (data.language) {
    handoff.language = data.language;
  }
  if (data.acknowledgement) {
    handoff.acknowledgement = data.acknowledgement;
  }

  return handoff;
}

export async function recoverMissingPrompt({
  fetchImpl,
  apiUrl,
  sessionId,
  expectedQuestionId,
  requestId,
  promptTurn,
  sessionGeneration,
}) {
  const url = buildApiUrl(apiUrl, "/api/interview/answer");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // An empty answer asks the existing stale-question guard for current state.
    // It cannot submit or persist the candidate's previous answer.
    body: JSON.stringify({
      sessionId,
      answer: "",
      expectedQuestionId,
      diagnosticRequestId: `${requestId}-r1`,
      diagnosticPromptTurn: promptTurn,
      diagnosticSessionGeneration: sessionGeneration,
    }),
  });
  const data = await response.json();

  return {
    response,
    data,
    promptHandoff: resolvePromptHandoff(response.status, data),
  };
}

export function isLostInterviewSession(status, data) {
  return status === 404 && data?.code === "SESSION_NOT_FOUND";
}
