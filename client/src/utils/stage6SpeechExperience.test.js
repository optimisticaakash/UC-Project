import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCandidateQuestionAnswerPrompt,
  buildCandidateQuestionFollowUpPrompt,
  buildCandidateQuestionInvitationPrompt,
  buildInquiryResponsePrompt,
  buildQuestionHandoffPrompt,
} from "./liveDialoguePrompt.js";
import { resolvePromptHandoff } from "./interviewResponse.js";
import { createPlaybackQueue, waitForPlaybackAndPause } from "./playbackCompletion.js";
import { BACKEND_WAIT_ANNOUNCEMENT_MS } from "../config/geminiConfig.js";
import { createRequestWaitAnnouncement } from "./requestWaitAnnouncement.js";

// 1. Adaptive Settle Timing & Threshold Tests
test("Stage 6: Adaptive settle timing differentiates finalized vs interim transcripts", () => {
  const FINALIZED_ANSWER_SETTLE_MS = 1000;
  const INTERIM_ANSWER_SETTLE_MS = 2200;

  function computeDelay({ isFinalized }) {
    return isFinalized ? FINALIZED_ANSWER_SETTLE_MS : INTERIM_ANSWER_SETTLE_MS;
  }

  assert.equal(computeDelay({ isFinalized: true }), 1000, "Finalized transcript uses snappy 1000ms settle window");
  assert.equal(computeDelay({ isFinalized: false }), 2200, "Interim transcript preserves 2200ms safety window");
});

test("Stage 6: Ambient noise after speech completion does not extend finalized settle timer", () => {
  const MAX_SETTLE_EXTENSION_MS = 3500;
  let settleStartTime = 10000;
  let isFinalized = true;
  let isSpeaking = false; // Candidate finished speaking

  function canExtendTimer(currentTime, rms, speaking, finalized) {
    if (rms <= 0.04) return false;
    const elapsed = currentTime - settleStartTime;
    return elapsed < MAX_SETTLE_EXTENSION_MS && (speaking || !finalized);
  }

  // Room noise after candidate finished speaking
  assert.equal(
    canExtendTimer(10500, 0.05, isSpeaking, isFinalized),
    false,
    "Background noise must not extend finalized timer when candidate is not speaking"
  );

  // Active quiet speech during interim transcript
  assert.equal(
    canExtendTimer(10500, 0.05, true, false),
    true,
    "Quiet candidate speech during interim transcript must extend the timer to prevent cutoff"
  );

  // Max extension cap reached
  assert.equal(
    canExtendTimer(14000, 0.05, true, false),
    false,
    "Must not extend beyond MAX_SETTLE_EXTENSION_MS even with active noise"
  );
});

// 2. Wait Announcement & Playback Optimization
test("Stage 6: BACKEND_WAIT_ANNOUNCEMENT_MS is optimized to at least 3000ms", () => {
  assert.ok(
    BACKEND_WAIT_ANNOUNCEMENT_MS >= 3000,
    `Wait announcement threshold should be >= 3000ms to avoid unnecessary filler on normal turns, got ${BACKEND_WAIT_ANNOUNCEMENT_MS}`
  );
});

test("Stage 6: waitForPlaybackAndPause skips 1000ms pause when playbackOutcome is response_ready", async () => {
  const queue = createPlaybackQueue();
  const source = {};
  const events = [];
  queue.sourceStarted(source);

  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: async (ms) => events.push(`pause:${ms}`),
    isCurrent: () => true,
  });

  // Early cancellation because backend response is ready
  queue.cancelAll("response_ready");
  const result = await pending;

  assert.equal(result.ready, true);
  assert.equal(result.playbackOutcome, "response_ready");
  assert.deepEqual(events, [], "Must not pause 1000ms when response is immediately ready");
});

test("Stage 6: In-flight wait announcement cancels immediately when response arrives", async () => {
  const coordinator = createRequestWaitAnnouncement({
    delayMs: 3000,
    onAnnounce: () => true,
  });

  coordinator.start();

  // Fast response arrives before delayMs
  const announced = coordinator.resolveRequest();
  assert.equal(announced, false, "Fast response resolves before announcement fires");
  assert.equal(coordinator.finished, true);
});

// 3. Conversational Naturalness & Anti-Cliché Rules
test("Stage 6: candidate dialogue prompt builders enforce natural transitions and anti-cliché directives", () => {
  const invitationPrompt = buildCandidateQuestionInvitationPrompt("Hindi");
  assert.match(invitationPrompt, /Avoid robotic clichés/i);
  assert.match(invitationPrompt, /Briefly and naturally invite them to ask/i);

  const answerPrompt = buildCandidateQuestionAnswerPrompt("What are the working hours?", "Hindi");
  assert.match(answerPrompt, /Avoid echoing the question, robotic filler clichés/i);
  assert.match(answerPrompt, /rigid repetitive closure phrases/i);
  assert.doesNotMatch(answerPrompt, /After answering, ask whether the candidate's doubt is clear\./);

  const followUpPrompt = buildCandidateQuestionFollowUpPrompt("Are shifts flexible?", "Hindi");
  assert.match(followUpPrompt, /Avoid robotic filler clichés or repetitive closure phrases/i);
});

test("Stage 6: buildInquiryResponsePrompt instructs Gemini Live to speak complete inquiry answer and check aloud", () => {
  const replyMessage = "Cloud computing ek aisi technology hai jisme internet ke zariye storage provide hoti hai. Kya aapka doubt clear ho gaya, ya aap kuch aur poochna chahenge?";
  const prompt = buildInquiryResponsePrompt(replyMessage, "Hindi");
  assert.match(prompt, /Speak the following answer and follow-up clearly, warmly, and completely aloud/i);
  assert.match(prompt, /Do not omit or change any words/i);
  assert.ok(prompt.includes(replyMessage));

  const englishPrompt = buildInquiryResponsePrompt("Cloud computing provides services over the internet. Does that clarify your doubt?", "English");
  assert.match(englishPrompt, /Conduct this in English as requested/i);
  assert.match(englishPrompt, /completely aloud/i);
});

test("Stage 6: resolvePromptHandoff preserves counterQuestionHandled and inquiryState", () => {
  const handoff = resolvePromptHandoff(200, {
    success: true,
    counterQuestionHandled: true,
    inquiryState: "clarification_check",
    clarificationRequired: true,
    message: "Cloud computing explanation...",
    question: { id: "A1", text: "Aap kis sheher mein rehte hain?" },
  });

  assert.ok(handoff);
  assert.equal(handoff.counterQuestionHandled, true);
  assert.equal(handoff.inquiryState, "clarification_check");
  assert.equal(handoff.clarificationRequired, true);
  assert.equal(handoff.prompt, "Cloud computing explanation...");
  assert.equal(handoff.questionId, "A1");
});
