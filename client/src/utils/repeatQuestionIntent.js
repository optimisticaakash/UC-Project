const repeatRequestPatterns = [
  /^(?:(?:please|could you|can you)\s+)?(?:repeat|rephrase|say again|ask again)\s+(?:(?:the|that|current)\s+)?(?:question|sawal|sawaal)(?:\s+(?:please|again))?[.!?]*$/i,
  /^(?:(?:please|could you|can you)\s+)?ask\s+(?:(?:the|that|current)\s+)?(?:question|sawal|sawaal)\s+again(?:\s+please)?[.!?]*$/i,
  /^(?:what\s+(?:was|is)\s+(?:the\s+)?question|what\s+did\s+you\s+ask)(?:\s+please)?[.!?]*$/i,
  /^(?:i\s+)?(?:didn['’]?t|don['’]?t|do\s+not)\s+understand\s+(?:(?:the|that)\s+)?(?:question|sawal|sawaal)[.!?]*$/i,
  /^(?:(?:woh|wo|ye|yeh)\s+)?(?:sawal|sawaal|question)\s+(?:kya\s+tha|repeat\s+k(?:ijiye|ariye)|dobara\s+bata(?:iye|iye|o|\s+sakti\s+hain?|\s+sakte\s+hain?)|phir\s+se\s+(?:bata(?:iye|iye|o|\s+sakti\s+hain?|\s+sakte\s+hain?)|pooch(?:iye|iye|o)|puch(?:iye|iye|o)))[.!?]*$/i,
  /^(?:mujhe\s+)?(?:sawal|sawaal|question)\s+samajh\s+nahi\s+(?:aaya|aayi|aya|ayi)[.!?]*$/i,
  /^(?:ek\s+baar\s+)?(?:phir\s+se|dobara)\s+(?:pooch(?:iye|iye|o)|puch(?:iye|iye|o)|bata(?:iye|iye|o)|repeat\s+k(?:ijiye|ariye))[.!?]*$/i,
  /^(?:वह|वो|यह|ये)?\s*(?:सवाल|सवाल को|प्रश्न)\s*(?:क्या था|दोबारा बताइए|फिर से बताइए|दोबारा पूछिए|फिर से पूछिए)[।.!?]*$/u,
  /^(?:मुझे\s+)?(?:सवाल|प्रश्न)\s+समझ\s+नहीं\s+आया[।.!?]*$/u,
  /^(?:एक\s+बार\s+)?(?:फिर\s+से|दोबारा)\s+(?:पूछिए|पूछिये|बताइए|बताइये)[।.!?]*$/u,
];

export function resolveRepeatQuestionRequest(transcript, activePrompt) {
  if (typeof transcript !== "string") return null;
  const normalized = transcript.trim().replace(/\s+/g, " ");
  if (!normalized || !repeatRequestPatterns.some((pattern) => pattern.test(normalized))) {
    return null;
  }

  return {
    questionId: activePrompt?.questionId || null,
    prompt: typeof activePrompt?.text === "string" ? activePrompt.text.trim() : "",
    clarificationRequired: Boolean(activePrompt?.clarificationRequired),
  };
}

export function classifyFinalizedInput(transcript, activePrompt) {
  const repeatRequest = resolveRepeatQuestionRequest(transcript, activePrompt);
  return repeatRequest
    ? { type: "repeat_question", repeatRequest }
    : { type: "submit_answer", answer: transcript };
}

export function createRepeatHandoffGuard() {
  const activeGenerations = new Set();
  return {
    tryAcquire(generation) {
      if (activeGenerations.has(generation)) return false;
      activeGenerations.add(generation);
      return true;
    },
    release(generation) {
      activeGenerations.delete(generation);
    },
  };
}
