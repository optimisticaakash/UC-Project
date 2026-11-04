const candidateQuestionPatterns = [
  // English
  /^(?:i have (?:a|one) question|i want to ask (?:a )?question|can i ask (?:a )?question|may i ask (?:a )?question|can i ask something|may i ask something|i need to ask something|i have (?:a|one) doubt)[.!?]*$/i,

  // Hinglish
  /^(?:mujhe|main) (?:(?:ek|kuch) )?(?:question|sawal|sawaal|prashn) (?:poochna|puchna) (?:hai|tha)[.!?]*$/i,
  /^mera (?:ek )?(?:question|sawal|sawaal|prashn) hai[.!?]*$/i,
  /^(?:mujhe|mere paas) (?:ek )?(?:question|sawal|sawaal|doubt) hai[.!?]*$/i,
  /^(?:ek )?(?:question|sawal|sawaal|doubt) hai[.!?]*$/i,
  /^(?:kya )?(?:main|mai) (?:ek )?(?:question|sawal|sawaal) (?:pooch|puch) sakti hoon[.!?]*$/i,

  // Hindi
  /^(?:मुझे|मैं) (?:एक )?(?:सवाल|प्रश्न) पूछना है[।.!?]*$/u,
  /^(?:मेरा|मेरे पास) (?:एक )?(?:सवाल|प्रश्न|संदेह) है[।.!?]*$/u,
  /^(?:एक )?(?:सवाल|प्रश्न|संदेह) है[।.!?]*$/u,
];

const clearConfirmationPatterns = [
  // English
  /^(?:yes|yeah|yep|that's clear|it is clear|clear now|no more questions|no more doubts|i understand|understood|got it|i got it|continue|proceed|next|move on|resume|all clear|that helps)[.!?]*$/i,

  // Hinglish
  /^(?:haan|han|haan ji|ji haan|samajh gaya|samajh gayi|samajh aa gaya|samajh aa gayi|clear hai|ab clear hai|koi doubt nahi|ab samajh aa gaya|ab samajh aa gayi|aage badhiye|aage chaliye|aage badho|aage badhein|agla sawal|next question|chaliye shuru karein|shuru kijiye|shuru kariye)[.!?]*$/i,
  /^(?:theek hai|thik hai|okay|ok|accha|achha|acha|sahi hai|alright|fine)[.!?]*$/i,
  /^(?:theek hai|thik hai|okay|ok|accha|achha|acha|sahi hai)[,، ]+(?:aage badhiye|continue|next|samajh gaya|samajh gayi|samajh aa gaya|samajh aa gayi|clear hai)[.!?]*$/i,

  // Hindi
  /^(?:हाँ|हां|जी हाँ|समझ गया|समझ गई|समझ आ गया|समझ आ गई|अब स्पष्ट है|कोई संदेह नहीं|आगे बढ़िए|आगे बढ़िए|अगला सवाल|शुरू कीजिए|जारी रखिए|ठीक है|अच्छा|सही है)[।.!?]*$/u,

  /^(?:yes|yeah|yep|haan|han|haan ji|ji haan)[,، ]+(?:now )?(?:i understand|i got it|got it|that's clear|it is clear|clear now|samajh gaya|samajh gayi|samajh aa gaya|samajh aa gayi|ab clear hai|aage badhiye|continue|next)[.!?]*$/i,

  /^(?:हाँ|हां|जी हाँ|जी हां)[,، ]+(?:अब )?(?:समझ गया|समझ गई|समझ आ गया|समझ आ गई|स्पष्ट है|आगे बढ़िए)[।.!?]*$/u,
];


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

export function isCandidateQuestionRequest(transcript) {
  if (typeof transcript !== "string") return false;

  const normalized = transcript.trim().replace(/\s+/g, " ");

  return candidateQuestionPatterns.some((pattern) =>
    pattern.test(normalized)
  );
}

export function isDoubtClearConfirmation(transcript) {
  if (typeof transcript !== "string") return false;

  const normalized = transcript.trim().replace(/\s+/g, " ");

  return clearConfirmationPatterns.some((pattern) =>
    pattern.test(normalized)
  );
}

export function isCandidateQuestionOrInquiry(transcript) {
  if (typeof transcript !== "string") return false;
  const trimmed = transcript.trim();
  if (!trimmed) return false;

  // 1. Explicit permission request to ask a question
  if (isCandidateQuestionRequest(trimmed)) return true;

  // 2. Contains question mark
  if (/[?؟]/.test(trimmed)) return true;

  // 3. Question words in English, Hinglish, or Hindi
  const hasQuestionWord =
    /\b(?:what|where|when|why|how|who|whom|whose|which|can i|could you|would i|will i|is there|are there|do i|does it|should i|kya|kaise|kaisa|kaisi|kahan|kidhar|kitna|kitne|kitni|kab|kyun|kyu|kaun|kaunsa|kaunsi|doubt|question|sawal|sawaal|prashn|problem|dikkat|chinta|hesitation)\b/i.test(
      trimmed,
    ) ||
    /(?:क्या|कैसे|कैसा|कैसी|कहाँ|कहा|कितना|कितने|कितनी|कब|क्यों|क्यूँ|कौन|सवाल|प्रश्न|संदेह|दिक्कत)/u.test(
      trimmed,
    );

  // 4. Stating doubt remains or negative response to "is doubt clear?"
  const hasUnclearOrDoubt =
    /\b(?:still (?:don't|not)|not clear|unclear|still have (?:a )?doubt|samajh nahi|clear nahi|abhi bhi doubt|doubt hai)\b/i.test(
      trimmed,
    ) ||
    /^(?:no|nahi|nahin|na|नहीं|ना)[.!?]*$/i.test(trimmed);

  return hasQuestionWord || hasUnclearOrDoubt;
}

export function classifyCandidateQuestionInput(transcript, mode) {
  if (typeof transcript !== "string" || !transcript.trim()) {
    return null;
  }

  const question = transcript.trim();

  // Candidate has been invited to ask their question.
  if (mode === "awaiting_question") {
    return {
      type: "answer_candidate_question",
      question,
    };
  }

  // Candidate is confirming whether the doubt is clear.
  if (mode === "awaiting_confirmation") {
    if (isDoubtClearConfirmation(question)) {
      return { type: "resume_assessment" };
    }
    if (isCandidateQuestionOrInquiry(question)) {
      return {
        type: "candidate_question_follow_up",
        question,
      };
    }
    // If candidate neither confirmed nor asked another question/doubt:
    // They are providing their answer to the pending assessment question!
    return null;
  }

  // Candidate asks permission to ask a question.
  if (
    mode === "inactive" &&
    isCandidateQuestionRequest(question)
  ) {
    return {
      type: "invite_candidate_question",
    };
  }

  return null;
}

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
  if (isCandidateQuestionRequest(transcript)) {
    return {
      type: "candidate_question_request",
    };
  }

  const repeatRequest = resolveRepeatQuestionRequest(transcript, activePrompt);

  if (repeatRequest) {
    return {
      type: "repeat_question",
      repeatRequest,
    };
  }

  return {
    type: "submit_answer",
    answer: transcript,
  };
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


