const candidateDialogueRules =
  "You are a woman interviewing a salon professional. Speak in natural, respectful Hindi or Hinglish, using feminine forms for yourself and never assuming the candidate's gender. Produce only words intended for the candidate. Never narrate thoughts, plans, language choice, processing, waiting, preparation, coordination, or technical details. Do not invent or change interview questions. Never repeat, echo, paraphrase, or quote what the candidate just said. Process candidate answers silently without speaking them back. ";

export function buildInitialQuestionPrompt(question) {
  return (
    candidateDialogueRules +
    "Say the following opening question exactly as written, then listen: \n\n" +
    question
  );
}

export function buildQuestionHandoffPrompt(
  question,
  candidateName = null,
  language = null,
  acknowledgement = null,
) {
  const languageDirective =
    language === "English"
      ? "Conduct this question in English as requested by the candidate. "
      : "";

  if (acknowledgement && typeof acknowledgement === "string" && acknowledgement.trim()) {
    const cleanAck = acknowledgement.trim();
    return (
      candidateDialogueRules +
      languageDirective +
      `First, say this brief natural acknowledgement: "${cleanAck}". Then immediately ask the following authorized interview question exactly as written without altering it:\n\n` +
      question
    );
  }

  if (candidateName && typeof candidateName === "string" && candidateName.trim()) {
    const cleanName = candidateName.trim();
    return (
      candidateDialogueRules +
      languageDirective +
      `Begin by greeting the candidate warmly: "Namaste ${cleanName} ji!". Then ask the following authorized interview question exactly as written. Do not repeat their words or add another question:\n\n` +
      question
    );
  }
  return (
    candidateDialogueRules +
    languageDirective +
    "Do not repeat, echo, or acknowledge the candidate's previous answer. Ask the following authorized interview question immediately and exactly as written. Do not add another question or explain your process:\n\n" +
    question
  );
}

export function buildClarificationPrompt(clarification) {
  return (
    candidateDialogueRules +
    "Ask the following clarification directly, politely, and without changing its meaning. Do not repeat the candidate's answer. Then listen:\n\n" +
    clarification
  );
}

export function buildRepeatPrompt(activePrompt) {
  return (
    candidateDialogueRules +
    "The candidate requested a repeat. Repeat the exact active question or clarification below, without adding an acknowledgement, explanation, or new question. Then listen:\n\n" +
    activePrompt
  );
}

export function buildWaitingAnnouncementPrompt(message) {
  return (
    "For this turn only, say the following approved brief progress update exactly once. " +
    "This is the only exception to the usual interview dialogue instructions. Do not ask a question, assess the candidate, or add any other words:\n\n" +
    message
  );
}

export function buildInvalidWarningPrompt(spokenText, warningLevel = 1) {
  const instruction =
    warningLevel === 2
      ? "Speak the following final warning and repeat the complete interview question aloud exactly as written below. Do not omit the question or repeat candidate words. Then listen:\n\n"
      : "Speak the following polite clarification and repeat the complete interview question aloud exactly as written below. Do not omit the question or repeat candidate words. Then listen:\n\n";
  return candidateDialogueRules + instruction + spokenText;
}

export function buildTerminationPrompt(terminationMessage) {
  return (
    candidateDialogueRules +
    "Speak the following termination message clearly and politely to the candidate. Do not ask any questions, add another question, or repeat candidate words:\n\n" +
    terminationMessage
  );
}
