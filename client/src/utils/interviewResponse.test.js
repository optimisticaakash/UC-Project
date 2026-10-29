import assert from "node:assert/strict";
import test from "node:test";
import {
  isLostInterviewSession,
  recoverMissingPrompt,
  resolvePromptHandoff,
} from "./interviewResponse.js";
import {
  isCurrentLiveGeneration,
  isCurrentLiveSession,
} from "./liveSessionLifecycle.js";

test("only an explicit missing-session response triggers session recovery", () => {
  assert.equal(
    isLostInterviewSession(404, { code: "SESSION_NOT_FOUND" }),
    true,
  );
  assert.equal(isLostInterviewSession(404, { code: "NOT_FOUND" }), false);
  assert.equal(isLostInterviewSession(409, { code: "SESSION_NOT_FOUND" }), false);
});

test("accepted A2_NAME response hands off the returned A0 consent prompt", () => {
  const handoff = resolvePromptHandoff(200, {
    success: true,
    question: { id: "A0", text: "Consent prompt" },
  });

  assert.deepEqual(handoff, {
    questionId: "A0",
    prompt: "Consent prompt",
    clarificationRequired: false,
    staleRecovery: false,
  });
});

test("A2_NAME to A0 handoff keeps the active Live generation eligible for audio events", () => {
  const handoff = resolvePromptHandoff(200, {
    success: true,
    question: { id: "A0", text: "Consent prompt" },
  });
  const activeGeneration = 4;

  assert.equal(handoff.questionId, "A0");
  assert.equal(
    isCurrentLiveGeneration(activeGeneration, activeGeneration),
    true,
  );
  assert.equal(
    isCurrentLiveGeneration(activeGeneration - 1, activeGeneration),
    false,
  );
});

test("A0 audio handoff remains attached to the same active Live session", () => {
  const liveSession = { sendClientContent() {} };
  const handoff = resolvePromptHandoff(200, {
    success: true,
    question: { id: "A0", text: "Consent prompt" },
  });

  assert.equal(handoff.questionId, "A0");
  assert.equal(
    isCurrentLiveSession(liveSession, 8, liveSession, 8),
    true,
  );
  assert.equal(
    isCurrentLiveSession(liveSession, 8, { sendClientContent() {} }, 9),
    false,
  );
});

test("a late callback from an obsolete Live session cannot target the current session", () => {
  const obsoleteSession = { close() {} };
  const activeSession = { close() {} };

  assert.equal(
    isCurrentLiveSession(obsoleteSession, 7, activeSession, 8),
    false,
  );
  assert.equal(isCurrentLiveGeneration(7, 8), false);
});

test("stale 409 recovers by handing off the server's active prompt", () => {
  const handoff = resolvePromptHandoff(409, {
    success: false,
    staleQuestion: true,
    currentQuestionId: "A1_TRAVEL_CLARIFICATION",
    clarificationRequired: true,
    message: "Please clarify your travel answer.",
    question: {
      id: "A1_TRAVEL_CLARIFICATION",
      text: "Travel clarification prompt",
    },
  });

  assert.deepEqual(handoff, {
    questionId: "A1_TRAVEL_CLARIFICATION",
    prompt: "Travel clarification prompt",
    clarificationRequired: true,
    staleRecovery: true,
  });
});

test("stale 409 without an active question cannot trigger a prompt", () => {
  assert.equal(
    resolvePromptHandoff(409, {
      success: false,
      staleQuestion: true,
      currentQuestionId: "A0",
    }),
    null,
  );
});

test("missing prompt recovery performs one empty state-reconciliation request", async () => {
  const calls = [];
  const recovery = await recoverMissingPrompt({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 409,
        async json() {
          return {
            success: false,
            staleQuestion: true,
            currentQuestionId: "A8",
            question: { id: "A8", text: "Current authorized question" },
          };
        },
      };
    },
    apiUrl: "http://localhost:5001",
    sessionId: "session-123",
    expectedQuestionId: "A7",
    requestId: "p9-a1",
    promptTurn: 9,
    sessionGeneration: 2,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:5001/api/interview/answer");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.answer, "");
  assert.equal(payload.expectedQuestionId, "A7");
  assert.equal(payload.diagnosticRequestId, "p9-a1-r1");
  assert.equal("candidateAnswer" in payload, false);
  assert.equal(recovery.promptHandoff.questionId, "A8");
  assert.equal(recovery.promptHandoff.staleRecovery, true);
});

test("failed missing-prompt recovery does not loop or return a question", async () => {
  let calls = 0;
  const recovery = await recoverMissingPrompt({
    fetchImpl: async () => {
      calls += 1;
      return {
        status: 400,
        async json() {
          return { success: false, message: "Invalid answer" };
        },
      };
    },
    apiUrl: "http://localhost:5001",
    sessionId: "session-123",
    expectedQuestionId: "A7",
    requestId: "p9-a1",
    promptTurn: 9,
    sessionGeneration: 2,
  });

  assert.equal(calls, 1);
  assert.equal(recovery.promptHandoff, null);
});

test("client prompt handoff delivers exact screening question sequence into work experience (B1 -> B2)", () => {
  const approvedScreeningThroughWorkExperience = [
    { id: "A2_NAME", text: "Namaste ji, sabse pehle aap apna naam bataiye." },
    { id: "A0", text: "Namaste! Main UC ki screening assistant hoon. Ye baat-cheet sirf screening ke liye record hogi. Shuru karein? Aap Hindi mein baat karengi ya English mein?" },
    { id: "A1", text: "Aap Bangalore mein kis area mein rehti hain? Roz aas-paas kin areas mein aana-jaana hota hai?" },
    { id: "A1_TRAVEL_CLARIFICATION", text: "Agar kaam thoda door ho, to kya aap travel kar sakti hain ya zarurat padne par shift ho sakti hain?" },
    { id: "A1_MOVE_TIMELINE", text: "Agar shift hona pade, to aap kab tak shift ho sakti hain?" },
    { id: "A2", text: "Aadhaar card pe aapki date of birth kya likhi hai?" },
    { id: "A3", text: "Apne ghar ke baare mein thoda bataiye — ghar mein kaun kaun hai, aur din bhar kaun kya karta hai?" },
    { id: "A4", text: "(If kids) Bachche kis class mein padhte hain?" },
    { id: "A5", text: "Jab aap kaam pe hoti hain, tab bachchon ka din kaise chalta hai — school ke baad unke saath kaun hota hai?" },
    { id: "A6", text: "Aane wale ek saal mein ghar mein koi badi cheez plan hai — jaise shaadi, family badhana, ya shift hona?" },
    { id: "A7", text: "Abhi aapka kaam kaise chal raha hai — kisi salon mein hain, ya ghar pe bhi clients aate hain?" },
    { id: "A8", text: "Pichli jagah aap sabse zyada kaun si services karti thi? Pedicure-manicure kitni baar karti thi?" },
    { id: "A9", text: "Abhi aap kaam pe ya market kaise jaati hain?" },
    { id: "A10", text: "(Tablet shows card) Ye address aur service card zor se padhiye." },
    { id: "A11", text: "Maan lijiye aap customer ke ghar pahunchi hain. Mujhe customer samajhkar Hindi ya English mein apna introduction dijiye." },
    { id: "A12", text: "Kya kabhi pehle UC, Yes Madam ya kisi aur app ke through kaam kiya hai? Unme kaun se phone number use kiye the?" },
    { id: "B1", text: "Pichli job mein ek din mein kitne ghante khade rehkar kaam hota tha? Shaam tak thakaan kaisi hoti thi?" },
    { id: "B2", text: "Aapka beauty ka safar kaise shuru hua? Kahan kahan kaam kiya, aur wo salon kis area mein the?" },
  ];

  const deliveredQuestionIds = [];

  for (const item of approvedScreeningThroughWorkExperience) {
    const handoff = resolvePromptHandoff(200, {
      success: true,
      question: item,
    });

    assert.ok(handoff, `handoff must resolve for ${item.id}`);
    assert.equal(handoff.questionId, item.id);
    assert.equal(handoff.prompt, item.text);
    assert.equal(handoff.clarificationRequired, false);
    deliveredQuestionIds.push(handoff.questionId);
  }

  assert.deepEqual(
    deliveredQuestionIds,
    approvedScreeningThroughWorkExperience.map((item) => item.id),
  );
  // Verify that B2 (work experience) is index 17 and is only reached after all 14 screening questions and B1
  assert.equal(deliveredQuestionIds[deliveredQuestionIds.length - 1], "B2");
  assert.equal(deliveredQuestionIds.indexOf("B2"), 17);
});

test("warning level 1 invalid answer response preserves warningLevel, message, and repeated question", () => {
  const qText = "Namaste ji, sabse pehle aap apna naam bataiye.";
  const spokenMessage =
    `Maaf kijiye, mujhe aapka naam samajh nahi aaya. Kripya apna naam seedhe batayein: ${qText}`;
  const handoff = resolvePromptHandoff(200, {
    success: true,
    completed: false,
    clarificationRequired: true,
    warningLevel: 1,
    warning: false,
    warningMessage: "Maaf kijiye, mujhe aapka naam samajh nahi aaya. Kripya apna naam seedhe batayein",
    repeatedQuestionText: qText,
    message: spokenMessage,
    question: { id: "A2_NAME", text: qText },
  });

  assert.deepEqual(handoff, {
    questionId: "A2_NAME",
    prompt: spokenMessage,
    clarificationRequired: true,
    staleRecovery: false,
    warningLevel: 1,
    warning: false,
    warningMessage: "Maaf kijiye, mujhe aapka naam samajh nahi aaya. Kripya apna naam seedhe batayein",
    repeatedQuestionText: qText,
  });
});

test("warning level 2 invalid answer response preserves warningLevel 2, warning: true, and repeated question", () => {
  const qText = "Namaste ji, sabse pehle aap apna naam bataiye.";
  const spokenMessage =
    `Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya apna naam spasht batayein: ${qText}`;
  const handoff = resolvePromptHandoff(200, {
    success: true,
    completed: false,
    clarificationRequired: true,
    warningLevel: 2,
    warning: true,
    warningMessage: "Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya apna naam spasht batayein",
    repeatedQuestionText: qText,
    message: spokenMessage,
    question: { id: "A2_NAME", text: qText },
  });

  assert.deepEqual(handoff, {
    questionId: "A2_NAME",
    prompt: spokenMessage,
    clarificationRequired: true,
    staleRecovery: false,
    warningLevel: 2,
    warning: true,
    warningMessage: "Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya apna naam spasht batayein",
    repeatedQuestionText: qText,
  });
});

test("valid A0 language response preserves language without entering terminal state", () => {
  const handoff = resolvePromptHandoff(200, {
    success: true,
    completed: false,
    language: "Hindi",
    questionNumber: 3,
    totalQuestions: 50,
    question: { id: "A1", text: "Aap Bangalore mein kis area mein rehti hain? Roz aas-paas kin areas mein aana-jaana hota hai?" },
  });

  assert.deepEqual(handoff, {
    questionId: "A1",
    prompt: "Aap Bangalore mein kis area mein rehti hain? Roz aas-paas kin areas mein aana-jaana hota hai?",
    clarificationRequired: false,
    staleRecovery: false,
    language: "Hindi",
  });
});

test("resolvePromptHandoff preserves natural acknowledgement when provided by server", () => {
  const handoff = resolvePromptHandoff(200, {
    success: true,
    completed: false,
    acknowledgement: "Thank you, Priya ji!",
    question: { id: "A0", text: "Namaste! Main UC ki screening assistant hoon." },
  });

  assert.equal(handoff.acknowledgement, "Thank you, Priya ji!");
  assert.equal(handoff.questionId, "A0");
});
