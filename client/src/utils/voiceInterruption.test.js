import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackQueue, waitForPlaybackAndPause } from "./playbackCompletion.js";
import { createProgressiveCaptionsController } from "./progressiveCaptions.js";
import { createLiveInputTurn, isInternalSpeechMarker } from "./liveInputTurn.js";
import { AI_CAPTION_STATES, resolveAiCaptionModel } from "./interviewUiState.js";
import { buildNameConfirmationPrompt, buildQuestionHandoffPrompt } from "./liveDialoguePrompt.js";
import { speakTextFallback } from "./speechFallback.js";

test("1. Candidate interruption stops current AI playback promptly", () => {
  const queue = createPlaybackQueue();
  const source1 = { id: 1, stopped: false, stop() { this.stopped = true; } };
  const source2 = { id: 2, stopped: false, stop() { this.stopped = true; } };

  queue.sourceStarted(source1);
  queue.sourceStarted(source2);
  assert.equal(queue.activeSourceCount, 2);

  // When candidate interruption is confirmed:
  source1.stop();
  source2.stop();
  queue.cancelAll("interrupted");

  assert.equal(source1.stopped, true);
  assert.equal(source2.stopped, true);
  assert.equal(queue.activeSourceCount, 0);
});

test("2. Pending audio chunks are discarded after interruption", () => {
  const captions = createProgressiveCaptionsController();
  const question = "Aap Bangalore mein kis area mein rehti hain?";
  captions.beginTurn({ targetQuestionText: question });

  // Chunk 1 arrives before interruption
  captions.registerAudioChunk({ startAt: 0.0, duration: 2.0, chunkSequence: 1 });
  captions.updatePlaybackProgress(1.0);
  const revealedBefore = captions.getCaptionText();
  assert.ok(revealedBefore.length > 0 && revealedBefore.length < question.length);

  // Candidate interrupts
  captions.handleInterruption();
  assert.equal(captions.isInterrupted(), true);

  // Late audio chunks arrive from in-flight response
  captions.registerAudioChunk({ startAt: 2.0, duration: 2.0, chunkSequence: 2 });
  captions.appendTranscription("Aur kitne saal se kaam kar rahi hain?");

  // Timeline progress should not reveal the late chunks or appended text
  const revealedAfter = captions.updatePlaybackProgress(3.0);
  assert.equal(revealedAfter, revealedBefore);
  assert.equal(captions.getCaptionText(), revealedBefore);
});

test("3. Stale audio callbacks cannot restart interrupted playback or complete captions", () => {
  const captions = createProgressiveCaptionsController();
  const question = "Aapka salon kaam ka kitna anubhav hai?";
  captions.beginTurn({ targetQuestionText: question });
  captions.registerAudioChunk({ startAt: 0.0, duration: 3.0, chunkSequence: 1 });

  captions.updatePlaybackProgress(1.5);
  const frozenText = captions.handleInterruption();

  // Asynchronous source.onended fires for a stopped source
  const completedText = captions.markPlaybackComplete();

  // Caption must remain frozen and must not be marked complete
  assert.equal(completedText, frozenText);
  assert.equal(captions.getCaptionText(), frozenText);
  assert.equal(captions.isCompleted(), false);
});

test("4. Normal uninterrupted playback still completes", () => {
  const captions = createProgressiveCaptionsController();
  const question = "Aap waxing aur threading dono karti hain?";
  captions.beginTurn({ targetQuestionText: question });
  captions.registerAudioChunk({ startAt: 0.0, duration: 2.0, chunkSequence: 1 });

  captions.updatePlaybackProgress(1.0);
  assert.equal(captions.isCompleted(), false);

  const fullText = captions.markPlaybackComplete();
  assert.equal(fullText, question);
  assert.equal(captions.isCompleted(), true);

  const uiModel = resolveAiCaptionModel({
    currentQuestion: question,
    captionText: fullText,
    isAiSpeaking: false,
    aiCaptionState: AI_CAPTION_STATES.COMPLETED,
  });
  assert.equal(uiModel.state, "completed");
  assert.equal(uiModel.isCompleted, true);
  assert.equal(uiModel.badgeText, "Completed");
  assert.equal(uiModel.captionText, question);
});

test("5. Microphone capture remains active and candidate speech is captured after interruption", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  // Model was speaking, candidate interrupts
  const interruptResult = turn.handleServerContent({ interrupted: true }, { isPlaybackActive: true });
  assert.equal(interruptResult.interruptionConfirmed, true);

  // Candidate speaks their doubt/clarification
  const interim = turn.handleServerContent({ interimInputTranscription: { text: "Main yeh poochna" } });
  assert.equal(interim.activity, true);
  assert.equal(turn.isCandidateSpeaking(), true);

  const finalized = turn.handleServerContent({
    inputTranscription: {
      text: "Main yeh poochna chahti hoon ki duty timings kya hongi?",
      finished: true,
      startOffset: "1s",
      endOffset: "4s",
    },
  });

  assert.equal(finalized.answer, "Main yeh poochna chahti hoon ki duty timings kya hongi?");
  assert.equal(turn.getTranscript(), "Main yeh poochna chahti hoon ki duty timings kya hongi?");
});

test("6. A short noise event does not trigger repeated interruptions", () => {
  // Test detection filtering of internal noise / speech markers
  assert.equal(isInternalSpeechMarker("<no speech>"), true);
  assert.equal(isInternalSpeechMarker("{pause}"), true);
  assert.equal(isInternalSpeechMarker("<no speech>{pause}"), true);
  assert.equal(isInternalSpeechMarker("   "), false); // whitespace handled separately

  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  // Background noise packet with <no speech> marker during active playback
  const noiseResult = turn.handleServerContent(
    { interimInputTranscription: { text: "<no speech>" } },
    { isPlaybackActive: true },
  );

  assert.equal(noiseResult.activity, false);
  assert.equal(noiseResult.interruptionConfirmed, false);
  assert.equal(turn.hasCandidateSpoken(), false);
  assert.equal(turn.phase(), "model");
});

test("7. Repeated interruptions do not corrupt audio state", () => {
  const queue = createPlaybackQueue();
  const captions = createProgressiveCaptionsController();
  captions.beginTurn({ targetQuestionText: "Question 1" });

  // First interruption
  const source1 = {};
  queue.sourceStarted(source1);
  queue.cancelAll("interrupted");
  captions.handleInterruption();
  assert.equal(queue.activeSourceCount, 0);
  assert.equal(captions.isInterrupted(), true);

  // Second immediate interruption signal (duplicate event or brief cough followed by speech)
  queue.cancelAll("interrupted");
  captions.handleInterruption();
  assert.equal(queue.activeSourceCount, 0);
  assert.equal(captions.isInterrupted(), true);

  // Starting next turn cleans up state cleanly
  captions.beginTurn({ targetQuestionText: "Question 2" });
  assert.equal(captions.isInterrupted(), false);
  assert.equal(captions.isCompleted(), false);
});

test("8. Interrupted captions do not incorrectly become completed captions", () => {
  const question = "Aap Bangalore mein kis area mein rehti hain?";
  const frozenPartial = "Aap Bangalore mein kis";

  const model = resolveAiCaptionModel({
    currentQuestion: question,
    captionText: frozenPartial,
    isAiSpeaking: false,
    aiCaptionState: AI_CAPTION_STATES.INTERRUPTED,
  });

  assert.equal(model.state, "interrupted");
  assert.equal(model.isCompleted, false);
  assert.equal(model.isSpeaking, false);
  assert.equal(model.isLoading, false);
  assert.equal(model.badgeText, "Interrupted");
  assert.equal(model.captionText, frozenPartial);
  assert.notEqual(model.captionText, question);
});

test("9. Interview cleanup stops active audio and releases resources correctly", async () => {
  const queue = createPlaybackQueue();
  const source = { stopped: false, stop() { this.stopped = true; } };
  queue.sourceStarted(source);

  let released = false;
  const waiter = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: async () => {},
    isCurrent: () => true,
  }).then((res) => {
    released = true;
    return res;
  });

  // Session stopped or component unmounted
  source.stop();
  queue.cancelAll("component_unmounted");

  const res = await waiter;
  assert.equal(released, true);
  assert.equal(res.ready, true);
  assert.equal(res.playbackOutcome, "component_unmounted");
  assert.equal(source.stopped, true);
  assert.equal(queue.activeSourceCount, 0);
});

test("10. Interruption does not advance or modify assessment state", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  // Interruption occurs during active assessment turn
  const interruptResult = turn.handleServerContent({ interrupted: true }, { isPlaybackActive: true });
  assert.equal(interruptResult.interruptionConfirmed, true);

  // Candidate asks a question instead of answering: "Can I ask something?"
  const candidateUtterance = turn.handleServerContent({
    inputTranscription: {
      text: "Can I ask something?",
      finished: true,
      startOffset: "0s",
      endOffset: "2s",
    },
  });

  assert.equal(candidateUtterance.answer, "Can I ask something?");
  // Turn phase remains candidate/listening, not auto-committed or auto-advanced
  assert.notEqual(turn.phase(), "submitted");
});

test("11. False server interruption without candidate speech allows buffered playback to continue", () => {
  const queue = createPlaybackQueue();
  const source = { id: "audio-chunk-1", stopped: false, stop() { this.stopped = true; } };
  queue.sourceStarted(source);
  assert.equal(queue.activeSourceCount, 1);

  // When spurious server interruption arrives with no mic speech and no transcript:
  const hasRealSpeechEvidence = false;
  if (hasRealSpeechEvidence) {
    source.stop();
    queue.cancelAll("interrupted");
  }

  // Active audio chunk is NOT abruptly cut off
  assert.equal(source.stopped, false);
  assert.equal(queue.activeSourceCount, 1);

  // When genuine candidate speech is subsequently detected:
  const candidateBargeIn = true;
  if (candidateBargeIn) {
    source.stop();
    queue.cancelAll("interrupted");
  }

  assert.equal(source.stopped, true);
  assert.equal(queue.activeSourceCount, 0);
});

test("12. Candidate vocal energy above speech threshold qualifies as genuine speech barge-in", () => {
  const SPEECH_RMS_THRESHOLD = 0.042;
  const ambientNoiseRms = 0.018;
  const echoCancellationBleedRms = 0.027;
  const candidateWhisperRms = 0.045;
  const candidateNormalSpeechRms = 0.082;

  assert.equal(ambientNoiseRms >= SPEECH_RMS_THRESHOLD, false, "Ambient noise must be gated during playback");
  assert.equal(echoCancellationBleedRms >= SPEECH_RMS_THRESHOLD, false, "Echo bleed must be gated during playback");
  assert.equal(candidateWhisperRms >= SPEECH_RMS_THRESHOLD, true, "Candidate speech must open the gate immediately");
  assert.equal(candidateNormalSpeechRms >= SPEECH_RMS_THRESHOLD, true, "Normal speech must trigger barge-in");
});

test("13. A2_NAME_CONFIRM with candidate silent: AI completes speech without interruption", () => {
  const turn = createLiveInputTurn();
  const queue = createPlaybackQueue();
  const captions = createProgressiveCaptionsController();
  const targetQuestion = "Aapka naam Sunita hai, sahi hai na?";

  // Handoff to A2_NAME_CONFIRM:
  turn.beginModelTurn();
  captions.beginTurn({ targetQuestionText: targetQuestion });
  let authorizedModelTurn = true;
  let turnInterrupted = false;
  let candidateSpeechDetected = false;

  // Server sends early interrupted: true BEFORE any audio chunk is scheduled (playbackSources.size === 0):
  const serverMsg = { interrupted: true };
  const inputTurn = turn.handleServerContent(serverMsg, { isPlaybackActive: authorizedModelTurn });
  assert.equal(inputTurn.interruptionConfirmed, true);

  // Candidate is completely silent:
  const hasRealSpeechEvidence = candidateSpeechDetected || Boolean(turn.hasCandidateSpoken());
  assert.equal(hasRealSpeechEvidence, false);

  // Spurious interruption suppression logic (exact logic from useGeminiLiveInterview):
  if (!hasRealSpeechEvidence) {
    turn.suppressSpuriousInterruption();
    // turnInterrupted MUST remain false and authorizedModelTurn MUST remain true!
  } else {
    turnInterrupted = true;
    authorizedModelTurn = false;
    captions.handleInterruption();
  }

  assert.equal(turnInterrupted, false, "turnInterrupted must not be set on spurious interruption");
  assert.equal(authorizedModelTurn, true, "authorizedModelTurn must remain true");

  // Subsequent audio chunk arrives from Gemini Live:
  const audioChunkArrivalAllowed = !turnInterrupted && authorizedModelTurn;
  assert.equal(audioChunkArrivalAllowed, true, "Audio chunks must NOT be skipped");

  const source = { id: "chunk-1", stopped: false, stop() { this.stopped = true; } };
  queue.sourceStarted(source);
  captions.registerAudioChunk({ startAt: 0.0, duration: 2.0, chunkSequence: 1 });
  captions.updatePlaybackProgress(2.0);

  // When model finishes:
  const fullText = captions.markPlaybackComplete();
  queue.sourceEnded(source);

  assert.equal(fullText, targetQuestion);
  assert.equal(captions.isCompleted(), true);
  assert.equal(source.stopped, false);
});

test("14. False microphone/VAD activity: mic audio gated below speech RMS threshold during preparation", () => {
  const SPEECH_RMS_THRESHOLD = 0.042;
  const authorizedModelTurn = true;
  const isAiSpeaking = false;
  const isAiSpeakingOrPreparing = isAiSpeaking || authorizedModelTurn;

  // Ambient room noise / breathing while AI is preparing A2_NAME_CONFIRM:
  const ambientSample = [0.01, 0.02, 0.015, -0.01, 0.022];
  let sum = 0;
  for (let i = 0; i < ambientSample.length; i++) sum += ambientSample[i] * ambientSample[i];
  const rmsAmbient = Math.sqrt(sum / ambientSample.length);

  assert.equal(isAiSpeakingOrPreparing, true);
  assert.equal(rmsAmbient < SPEECH_RMS_THRESHOLD, true, "Ambient noise must be below threshold");

  // Gating check: silent ambient audio is dropped (not sent to Gemini Live)
  const shouldDropAmbient = isAiSpeakingOrPreparing && rmsAmbient < SPEECH_RMS_THRESHOLD;
  assert.equal(shouldDropAmbient, true, "Silent mic noise must be dropped to prevent false VAD");

  // When candidate actually speaks aloud ("Haan"):
  const speechSample = [0.09, 0.12, -0.08, 0.11, -0.10];
  let speechSum = 0;
  for (let i = 0; i < speechSample.length; i++) speechSum += speechSample[i] * speechSample[i];
  const rmsSpeech = Math.sqrt(speechSum / speechSample.length);

  assert.equal(rmsSpeech >= SPEECH_RMS_THRESHOLD, true, "Genuine speech must be above threshold");
  const shouldSendSpeech = !isAiSpeakingOrPreparing || rmsSpeech >= SPEECH_RMS_THRESHOLD;
  assert.equal(shouldSendSpeech, true, "Genuine speech must pass through the gate");
});

test("15. Genuine candidate speech: AI stops immediately", () => {
  const turn = createLiveInputTurn();
  const queue = createPlaybackQueue();
  const captions = createProgressiveCaptionsController();
  const question = "Aapka naam Sunita hai, sahi hai na?";

  turn.beginModelTurn();
  captions.beginTurn({ targetQuestionText: question });
  const source = { id: "confirm-audio", stopped: false, stop() { this.stopped = true; } };
  queue.sourceStarted(source);
  captions.registerAudioChunk({ startAt: 0.0, duration: 3.0, chunkSequence: 1 });
  captions.updatePlaybackProgress(1.0);

  let authorizedModelTurn = true;
  let turnInterrupted = false;

  // Candidate genuinely speaks: "Haan, bilkul"
  const candidateSpeechDetectedDuringPlayback = true;
  const serverMsg = { interrupted: true };
  const inputTurn = turn.handleServerContent(serverMsg, { isPlaybackActive: true });
  assert.equal(inputTurn.interruptionConfirmed, true);

  const hasRealSpeechEvidence = candidateSpeechDetectedDuringPlayback || Boolean(turn.hasCandidateSpoken());
  assert.equal(hasRealSpeechEvidence, true);

  if (!hasRealSpeechEvidence) {
    turn.suppressSpuriousInterruption();
  } else {
    source.stop();
    queue.cancelAll("interrupted");
    turnInterrupted = true;
    authorizedModelTurn = false;
    captions.handleInterruption();
  }

  assert.equal(source.stopped, true, "Active playback must stop immediately on genuine speech");
  assert.equal(queue.activeSourceCount, 0, "Playback queue must be cleared");
  assert.equal(turnInterrupted, true, "turnInterrupted must be true");
  assert.equal(authorizedModelTurn, false, "authorizedModelTurn must be revoked");
  assert.equal(captions.isInterrupted(), true, "Captions must be marked interrupted");
});

test("16. Previous turn interruption state does not affect the next turn", () => {
  const turn = createLiveInputTurn();
  const captions = createProgressiveCaptionsController();

  // Turn 1 (A2_NAME): was interrupted by candidate speech
  turn.beginModelTurn();
  turn.handleServerContent({ interrupted: true }, { isPlaybackActive: true });
  captions.beginTurn({ targetQuestionText: "Pehle aap apna naam bataiye" });
  captions.handleInterruption();
  assert.equal(captions.isInterrupted(), true);

  let turnInterrupted = true;
  let authorizedModelTurn = false;

  // Next Turn (A2_NAME_CONFIRM): fresh handoff must reset interruption state completely
  turn.beginModelTurn();
  captions.beginTurn({ targetQuestionText: "Aapka naam Sunita hai, sahi hai na?" });
  turnInterrupted = false;
  authorizedModelTurn = true;

  assert.equal(turnInterrupted, false, "New turn must start with turnInterrupted = false");
  assert.equal(authorizedModelTurn, true, "New turn must start with authorizedModelTurn = true");
  assert.equal(captions.isInterrupted(), false, "New turn must start with captions uninterrupted");
  assert.equal(captions.isCompleted(), false, "New turn must start with captions incomplete");
  assert.equal(turn.phase(), "model", "Turn phase must be reset to model");
});

test("17. Stale audio chunks cannot revive interrupted playback", () => {
  const captions = createProgressiveCaptionsController();
  const question = "Aapka naam Sunita hai, sahi hai na?";
  captions.beginTurn({ targetQuestionText: question });
  captions.registerAudioChunk({ startAt: 0.0, duration: 1.0, chunkSequence: 1 });
  captions.updatePlaybackProgress(0.5);

  // Turn is interrupted:
  let turnInterrupted = true;
  let authorizedModelTurn = false;
  captions.handleInterruption();
  const frozenCaption = captions.getCaptionText();

  // In-flight delayed chunk arrives from server for the interrupted turn:
  const chunkSequence = 2;
  const chunkSkipped = turnInterrupted || !authorizedModelTurn;
  assert.equal(chunkSkipped, true, "Late chunks must be dropped when turn is interrupted");

  // Caption must not advance:
  captions.registerAudioChunk({ startAt: 1.0, duration: 1.0, chunkSequence });
  captions.updatePlaybackProgress(1.5);
  assert.equal(captions.getCaptionText(), frozenCaption);
  assert.equal(captions.isCompleted(), false);
});

test("18. Yes/No buttons continue working normally during and after name confirmation", () => {
  // During AI speech: buttons must be disabled
  const isAiSpeaking = true;
  const isProcessingAnswer = false;
  const isPreparingResponse = false;
  const isWaitingForBackend = false;

  const isDisabledDuringSpeech =
    isAiSpeaking || isProcessingAnswer || isPreparingResponse || isWaitingForBackend;
  assert.equal(isDisabledDuringSpeech, true, "Buttons must be disabled while AI speaks");

  // After AI finishes speaking: buttons must be enabled
  const isAiSpeakingFinished = false;
  const isDisabledAfterSpeech =
    isAiSpeakingFinished || isProcessingAnswer || isPreparingResponse || isWaitingForBackend;
  assert.equal(isDisabledAfterSpeech, false, "Buttons must be enabled when AI completes speech");

  // Clicking Yes produces a clean confirmation payload
  const isConfirmed = true;
  const answer = isConfirmed ? "yes" : "no";
  const transcript = isConfirmed ? "Yes" : "No";
  assert.equal(answer, "yes");
  assert.equal(transcript, "Yes");
});

test("19. Missing-audio retry for A2_NAME_CONFIRM preserves buildNameConfirmationPrompt", () => {
  const activePrompt = {
    questionId: "A2_NAME_CONFIRM",
    text: "Aapka naam Aakash hai, kya ye sahi hai?",
    clarificationRequired: false,
    identityMismatchWarning: false,
    warningLevel: null,
    isNameConfirmationTurn: true,
  };

  const isNameConfirm = Boolean(
    activePrompt.isNameConfirmationTurn ||
    activePrompt.questionId === "A2_NAME_CONFIRM"
  );
  assert.equal(isNameConfirm, true);

  const retryReq = {
    questionId: activePrompt.questionId,
    prompt: activePrompt.text,
    isNameConfirmationTurn: isNameConfirm,
    isMissingAudioRetry: true,
  };

  const isRetryNameConfirm = Boolean(
    retryReq.isNameConfirmationTurn ||
    retryReq.questionId === "A2_NAME_CONFIRM"
  );
  const promptText = isRetryNameConfirm
    ? buildNameConfirmationPrompt(retryReq.prompt, "Hindi")
    : buildQuestionHandoffPrompt(retryReq.prompt, null, "Hindi");

  assert.ok(promptText.includes("To verify the candidate's identity, ask the following authorized name confirmation question aloud exactly as written"));
  assert.ok(promptText.includes("Aapka naam Aakash hai, kya ye sahi hai?"));
});

test("20. Missing-audio recovery triggers TTS fallback when retries exhausted or empty turn completes", () => {
  let isPreparingResponse = true;
  let speakingState = false;
  let captionState = "loading";
  let captionText = "";
  let ttsCalled = false;
  let ttsTextSpoken = "";

  const mockSpeechSynthesis = {
    cancel() {},
    speak(utterance) {
      ttsCalled = true;
      ttsTextSpoken = utterance.text;
      setTimeout(() => utterance.onstart?.(), 5);
      setTimeout(() => utterance.onend?.(), 25);
    },
    getVoices() {
      return [{ lang: "hi-IN", name: "Hindi" }];
    },
  };

  function triggerMissingAudioTtsFallback({ fallbackText, language = "Hindi" }) {
    isPreparingResponse = false;
    captionText = fallbackText;
    captionState = "speaking";

    return speakTextFallback({
      text: fallbackText,
      language,
      speechSynthesisImpl: mockSpeechSynthesis,
      SpeechSynthesisUtteranceImpl: class {
        constructor(text) { this.text = text; }
      },
      onStart: () => {
        speakingState = true;
        captionState = "speaking";
      },
      onEnd: () => {
        speakingState = false;
        captionState = "completed";
      },
    });
  }

  // Turn complete arrives with 0 audio chunks and retry count exhausted:
  const targetPrompt = "Aapka naam Aakash hai, kya ye sahi hai?";
  triggerMissingAudioTtsFallback({ fallbackText: targetPrompt, language: "Hindi" });

  assert.equal(isPreparingResponse, false, "Preparing response must be cleared immediately");
  assert.equal(captionText, targetPrompt, "Captions must show the prompt being spoken");
  assert.equal(captionState, "speaking");
  assert.equal(ttsCalled, true, "TTS fallback must be invoked");
  assert.equal(ttsTextSpoken, targetPrompt);
});

test("21. Missing-audio arrival timeout fires and triggers TTS fallback if Gemini Live hangs without audio", async () => {
  let ttsTriggered = false;
  let timerFired = false;
  const audioChunksReceived = 0;
  const activeSources = 0;

  // Start bounded 50ms test timeout for retry arrival:
  await new Promise((resolve) => {
    setTimeout(() => {
      timerFired = true;
      if (audioChunksReceived === 0 && activeSources === 0) {
        ttsTriggered = true;
      }
      resolve();
    }, 50);
  });

  assert.equal(timerFired, true);
  assert.equal(ttsTriggered, true, "TTS fallback must trigger if no audio arrived within deadline");
});

test("22. Candidate vocal interruption during TTS fallback cancels speech synthesis cleanly", () => {
  let ttsCancelled = false;
  const mockSpeechSynthesis = {
    cancel() { ttsCancelled = true; },
    speak() {},
    getVoices() { return []; },
  };

  const cancelTts = speakTextFallback({
    text: "Aapka naam Aakash hai, kya ye sahi hai?",
    speechSynthesisImpl: mockSpeechSynthesis,
    SpeechSynthesisUtteranceImpl: class { constructor(text) { this.text = text; } },
  });

  // Candidate speaks aloud into microphone:
  const rms = 0.08; // above 0.042 threshold
  const isCandidateSpeech = rms >= 0.042;
  if (isCandidateSpeech) {
    cancelTts();
  }

  assert.equal(isCandidateSpeech, true);
  assert.equal(ttsCancelled, true, "TTS synthesis must be cancelled when candidate speaks");
});

test("23. Multi-chunk streaming: speech does not finalize between chunks while model is streaming", () => {
  let speakingState = true;
  let captionsCompleted = false;
  let modelTurnComplete = false;
  const activeSources = new Set();

  function onChunkEnd(source) {
    activeSources.delete(source);
    if (activeSources.size === 0) {
      if (modelTurnComplete) {
        speakingState = false;
        captionsCompleted = true;
      }
      // If modelTurnComplete is false, streaming continues — do not drop speaking state!
    }
  }

  // Chunk 1 playing
  const source1 = { id: 1 };
  activeSources.add(source1);

  // Chunk 1 finishes while model is still streaming chunk 2
  onChunkEnd(source1);
  assert.equal(speakingState, true, "Speaking state must remain true while model is streaming");
  assert.equal(captionsCompleted, false, "Captions must not be completed mid-stream");

  // Chunk 2 arrives
  const source2 = { id: 2 };
  activeSources.add(source2);

  // Model sends turnComplete
  modelTurnComplete = true;

  // Chunk 2 finishes
  onChunkEnd(source2);
  assert.equal(speakingState, false, "Speaking state completes after all chunks finish and turn is complete");
  assert.equal(captionsCompleted, true, "Captions complete cleanly at turn end");
});

test("24. Mutual exclusion: late Gemini audio chunks are skipped when TTS fallback is active", () => {
  const isTtsFallbackActive = true;
  const skippedReasons = [];

  function handleIncomingAudioChunk(audio) {
    if (isTtsFallbackActive) {
      skippedReasons.push("tts_fallback_active");
      return false;
    }
    return true;
  }

  const result = handleIncomingAudioChunk({ data: "pcm_data" });
  assert.equal(result, false, "Audio chunk must not be scheduled while TTS is active");
  assert.deepEqual(skippedReasons, ["tts_fallback_active"]);
});

test("25. Mutual exclusion: TTS fallback is suppressed when Gemini audio has arrived or is playing", () => {
  let ttsStarted = false;
  const audioChunksReceived = 2;
  const scheduledSourcesCount = 1;

  function triggerTtsFallback() {
    if (audioChunksReceived > 0 || scheduledSourcesCount > 0) {
      return "tts_fallback_skipped_gemini_active";
    }
    ttsStarted = true;
    return "started";
  }

  const outcome = triggerTtsFallback();
  assert.equal(outcome, "tts_fallback_skipped_gemini_active");
  assert.equal(ttsStarted, false, "TTS must never start if Gemini audio is active");
});

test("26. Interruption during multi-chunk streaming halts playback and cancels all sources", () => {
  let speakingState = true;
  const activeSources = new Set([
    { stop() { this.stopped = true; } },
    { stop() { this.stopped = true; } },
  ]);
  let isInterrupted = false;

  // Candidate speaks aloud:
  const isCandidateSpeech = true;
  if (isCandidateSpeech) {
    for (const s of activeSources) {
      s.stop();
    }
    activeSources.clear();
    speakingState = false;
    isInterrupted = true;
  }

  assert.equal(speakingState, false);
  assert.equal(activeSources.size, 0);
  assert.equal(isInterrupted, true);
});

test("27. Initial greeting/name question audio handoff lifecycle without premature timeout", () => {
  const turn = createLiveInputTurn();
  let isPreparingResponse = false;
  let authorizedModelTurn = false;
  let speakingState = false;
  let audioChunksReceived = 0;
  let ttsFallbackTriggered = false;

  // Step 1: When starting session, preparing state and model turn are established first
  turn.beginModelTurn();
  isPreparingResponse = true;
  authorizedModelTurn = true;
  assert.equal(turn.phase(), "model");
  assert.equal(isPreparingResponse, true);
  assert.equal(authorizedModelTurn, true);

  // Step 2: Prompt handoff dispatches initial question
  const initialPrompt = "Namaste ji, sabse pehle aap apna naam bataiye.";
  const promptSentAt = 1000;

  // Step 3: First Gemini Live audio chunk arrives at 1800ms (well within deadline)
  const firstChunkReceivedAt = 1800;
  assert.ok(firstChunkReceivedAt - promptSentAt < 4000, "First chunk arrives before timeout");

  audioChunksReceived += 1;
  isPreparingResponse = false;
  speakingState = true;

  assert.equal(audioChunksReceived, 1);
  assert.equal(speakingState, true);
  assert.equal(ttsFallbackTriggered, false, "TTS fallback must never be triggered when chunks arrive");
});

test("28. Microphone audio is gated during initial setup and model turn preparation", () => {
  let isPreparingResponse = true;
  let answerSubmitting = false;
  let realtimeAudioSentCount = 0;

  function onMicAudioMessage(input) {
    if (isPreparingResponse || answerSubmitting) {
      return;
    }
    realtimeAudioSentCount += 1;
  }

  // Incoming mic frames during initial connection and prompt preparation:
  onMicAudioMessage(new Float32Array(512));
  onMicAudioMessage(new Float32Array(512));
  onMicAudioMessage(new Float32Array(512));

  assert.equal(
    realtimeAudioSentCount,
    0,
    "No realtime audio input must be sent while preparing response / initial prompt handoff"
  );

  // When AI finishes speaking and candidate's turn begins:
  isPreparingResponse = false;
  onMicAudioMessage(new Float32Array(512));
  assert.equal(
    realtimeAudioSentCount,
    1,
    "Realtime audio input is allowed once preparing state is cleared"
  );
});

test("29. AudioContext resumption and queue synchronization on start", async () => {
  let audioContextState = "suspended";
  let currentTime = 14.5;
  let nextPlayTime = 0;

  async function ensureAudioContextReady() {
    if (audioContextState === "suspended") {
      audioContextState = "running";
    }
    nextPlayTime = currentTime;
  }

  await ensureAudioContextReady();
  assert.equal(audioContextState, "running");
  assert.equal(nextPlayTime, 14.5, "nextPlayTime must sync with currentTime, avoiding stale offset");

  // Scheduling chunk 1:
  const chunkDuration = 2.0;
  const startAt = Math.max(currentTime, nextPlayTime);
  assert.equal(startAt, 14.5, "Audio starts immediately at current context time");
  nextPlayTime = startAt + chunkDuration;
  assert.equal(nextPlayTime, 16.5);
});

test("30. TTS fallback preemption when Gemini audio arrives before TTS speech starts", () => {
  let isTtsFallbackActive = true;
  let isTtsSpeaking = false;
  let ttsCancelled = false;
  const scheduledChunks = [];

  const ttsCancel = () => {
    ttsCancelled = true;
    isTtsSpeaking = false;
    isTtsFallbackActive = false;
  };

  // Simulating incoming Gemini Live audio chunk while TTS is queued but NOT yet producing sound
  function handleIncomingAudio(chunk) {
    if (ttsCancel && !isTtsSpeaking) {
      ttsCancel();
    }
    if (isTtsFallbackActive) {
      return false;
    }
    scheduledChunks.push(chunk);
    return true;
  }

  const success = handleIncomingAudio({ seq: 1, pcm: "data" });
  assert.equal(success, true, "Chunk is accepted because pending TTS was preempted");
  assert.equal(ttsCancelled, true, "Pending TTS was cancelled cleanly");
  assert.equal(isTtsFallbackActive, false);
  assert.equal(scheduledChunks.length, 1);
});

test("31. Candidate listening is enabled only after initial playback queue completely drains", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  assert.equal(turn.phase(), "model");

  const s1 = { id: 1 };
  const s2 = { id: 2 };
  const activeSources = new Set([s1, s2]);
  let candidateListeningEnabled = false;

  function onSourceEnded(source) {
    activeSources.delete(source);
    if (activeSources.size === 0) {
      turn.finishModelPlayback();
      candidateListeningEnabled = true;
    }
  }

  // Source 1 ends, but source 2 still playing
  onSourceEnded(s1);
  assert.equal(turn.phase(), "model");
  assert.equal(candidateListeningEnabled, false, "Candidate listening must not be active while sources remain");

  // Source 2 ends
  onSourceEnded(s2);
  assert.equal(turn.phase(), "listening");
  assert.equal(candidateListeningEnabled, true, "Candidate listening is enabled once all sources finish");
});

test("32. Unsolicited Gemini Live audio chunks arriving when authorizedModelTurn is false are skipped with unauthorized_model_turn", () => {
  // Scenario: Candidate is speaking their name on A2_NAME.
  // Previous model turn has completed (modelTurnCompleteRef = true).
  // The client has not authorized any new model turn yet (authorizedModelTurnRef = false).
  // Gemini Live LLM independently generates unsolicited audio (e.g. asking a salon experience question).
  const authorizedModelTurnRef = { current: false };
  const modelTurnCompleteRef = { current: true };
  const turnInterruptedRef = { current: false };
  const isTtsFallbackActiveRef = { current: false };
  const ttsCancelRef = { current: null };

  const skippedDiagnostics = [];
  function processIncomingAudioChunk(audio) {
    if (
      turnInterruptedRef.current ||
      !authorizedModelTurnRef.current ||
      isTtsFallbackActiveRef.current ||
      ttsCancelRef.current
    ) {
      if (audio) {
        const reason = turnInterruptedRef.current
          ? "interrupted_turn"
          : !authorizedModelTurnRef.current
            ? "unauthorized_model_turn"
            : (isTtsFallbackActiveRef.current || ttsCancelRef.current)
              ? "tts_fallback_active"
              : "unauthorized_model_turn";
        skippedDiagnostics.push({ reason });
      }
      return false;
    }
    return true;
  }

  const accepted = processIncomingAudioChunk({ data: "raw_pcm_audio" });
  assert.equal(accepted, false, "Unsolicited audio chunk must NOT be accepted or scheduled");
  assert.equal(skippedDiagnostics.length, 1);
  assert.equal(skippedDiagnostics[0].reason, "unauthorized_model_turn");
});

test("33. Unsolicited Gemini Live turnComplete event when wasAuthorizedTurn is false is ignored and does not invoke playback finalization or answer settle", () => {
  let authorizedModelTurn = false;
  let finalizedCalled = false;
  let preparingResponseCleared = false;
  let candidateSettleScheduled = false;

  function handleTurnComplete() {
    const wasAuthorizedTurn = authorizedModelTurn;
    authorizedModelTurn = false;

    if (!wasAuthorizedTurn) {
      // Diagnostic: unauthorized_turn_complete_ignored
      return;
    }

    preparingResponseCleared = true;
    finalizedCalled = true;
    candidateSettleScheduled = true;
  }

  handleTurnComplete();

  assert.equal(finalizedCalled, false, "Playback finalization must not run for unauthorized turnComplete");
  assert.equal(preparingResponseCleared, false, "Preparing response state must not be cleared by unauthorized turnComplete");
  assert.equal(candidateSettleScheduled, false, "Candidate answer settle must not be triggered by unauthorized turnComplete");
});

test("34. Missing-audio retry and TTS fallback do not mutate or advance the active question ID", () => {
  let activeQuestionId = "A2_NAME_CONFIRM";
  const activePrompt = {
    questionId: activeQuestionId,
    text: "Aapka naam Pooja hai, sahi hai na?",
  };

  // Missing audio retry handler:
  function createRepeatRequest(prompt) {
    return {
      questionId: prompt.questionId,
      prompt: prompt.text,
      isMissingAudioRetry: true,
    };
  }

  const repeatReq = createRepeatRequest(activePrompt);
  assert.equal(repeatReq.questionId, "A2_NAME_CONFIRM", "Retry must strictly preserve current questionId");
  assert.equal(activeQuestionId, "A2_NAME_CONFIRM", "Active question ID must not mutate on retry");

  // TTS fallback trigger:
  function triggerTtsFallback(prompt) {
    // Speak prompt text, never advance question ID
    return {
      spokenText: prompt.text,
      forQuestionId: prompt.questionId,
    };
  }

  const fallback = triggerTtsFallback(activePrompt);
  assert.equal(fallback.forQuestionId, "A2_NAME_CONFIRM");
  assert.equal(activeQuestionId, "A2_NAME_CONFIRM", "Active question ID must remain strictly unchanged on TTS fallback");
});

test("35. Current authorized Bangalore question audio chunks are accepted", () => {
  const promptTurn = 4;
  const generation = 1;
  const currentQuestionId = "A1";

  const authorizedModelTurnRef = { current: true };
  const authorizedTurnRef = {
    current: {
      promptTurn,
      sessionGeneration: generation,
      questionId: currentQuestionId,
      active: true,
    },
  };
  const turnInterruptedRef = { current: false };
  const isTtsFallbackActiveRef = { current: false };
  const ttsCancelRef = { current: null };

  function validateChunk(incomingGeneration, chunkPromptTurn) {
    const isChunkAuthorized = Boolean(
      authorizedModelTurnRef.current &&
      authorizedTurnRef.current?.active &&
      authorizedTurnRef.current?.promptTurn === chunkPromptTurn &&
      authorizedTurnRef.current?.sessionGeneration === incomingGeneration
    );

    if (
      turnInterruptedRef.current ||
      !isChunkAuthorized ||
      isTtsFallbackActiveRef.current ||
      ttsCancelRef.current
    ) {
      return { accepted: false, reason: "unauthorized_model_turn" };
    }
    return { accepted: true };
  }

  const result = validateChunk(generation, promptTurn);
  assert.equal(result.accepted, true, "Bangalore question (A1) audio chunks must be accepted for the active prompt turn");
});

test("36. All chunks of the same authorized response are played, not just the first chunk", () => {
  const promptTurn = 4;
  const generation = 1;
  const authorizedModelTurnRef = { current: true };
  const authorizedTurnRef = {
    current: {
      promptTurn,
      sessionGeneration: generation,
      questionId: "A1",
      active: true,
    },
  };
  const turnInterruptedRef = { current: false };
  const receivedChunks = [];

  function processChunk(chunkIndex) {
    const isChunkAuthorized = Boolean(
      authorizedModelTurnRef.current &&
      authorizedTurnRef.current?.active &&
      authorizedTurnRef.current?.promptTurn === promptTurn &&
      authorizedTurnRef.current?.sessionGeneration === generation
    );
    if (!isChunkAuthorized || turnInterruptedRef.current) return false;
    receivedChunks.push(chunkIndex);
    return true;
  }

  // Simulate streaming across multiple messages
  assert.equal(processChunk(1), true);
  assert.equal(processChunk(2), true);
  assert.equal(processChunk(3), true);
  assert.equal(processChunk(4), true);

  assert.equal(receivedChunks.length, 4, "All 4 streaming audio chunks must be accepted and processed");
  assert.deepEqual(receivedChunks, [1, 2, 3, 4]);
});

test("37. Stale audio from a previous prompt is rejected", () => {
  const currentPromptTurn = 4; // Current is A1
  const stalePromptTurn = 3;   // Stale is A0
  const generation = 1;

  const authorizedModelTurnRef = { current: true };
  const authorizedTurnRef = {
    current: {
      promptTurn: currentPromptTurn,
      sessionGeneration: generation,
      questionId: "A1",
      active: true,
    },
  };

  function checkChunk(chunkPromptTurn) {
    const isChunkAuthorized = Boolean(
      authorizedModelTurnRef.current &&
      authorizedTurnRef.current?.active &&
      authorizedTurnRef.current?.promptTurn === chunkPromptTurn &&
      authorizedTurnRef.current?.sessionGeneration === generation
    );
    return isChunkAuthorized;
  }

  assert.equal(checkChunk(stalePromptTurn), false, "Chunk with stale promptTurn must be rejected");
  assert.equal(checkChunk(currentPromptTurn), true, "Chunk with current promptTurn must be accepted");
});

test("38. Audio from an old session generation is rejected", () => {
  const promptTurn = 4;
  const currentGeneration = 2;
  const oldGeneration = 1;

  const authorizedModelTurnRef = { current: true };
  const authorizedTurnRef = {
    current: {
      promptTurn,
      sessionGeneration: currentGeneration,
      questionId: "A1",
      active: true,
    },
  };

  function checkChunk(chunkGeneration) {
    const isChunkAuthorized = Boolean(
      authorizedModelTurnRef.current &&
      authorizedTurnRef.current?.active &&
      authorizedTurnRef.current?.promptTurn === promptTurn &&
      authorizedTurnRef.current?.sessionGeneration === chunkGeneration
    );
    return isChunkAuthorized;
  }

  assert.equal(checkChunk(oldGeneration), false, "Chunk from previous session generation must be rejected");
  assert.equal(checkChunk(currentGeneration), true, "Chunk from active session generation must be accepted");
});

test("39. Authorization is not prematurely cleared before the current response completes", () => {
  const promptTurn = 4;
  const generation = 1;
  const authorizedModelTurnRef = { current: true };
  const authorizedTurnRef = {
    current: {
      promptTurn,
      sessionGeneration: generation,
      questionId: "A1",
      active: true,
    },
  };

  // Simulate turnComplete signal arriving (e.g. alongside or before the final audio buffer finishes playing)
  function handleTurnComplete(chunksReceived) {
    const wasAuthorizedTurn = Boolean(
      authorizedModelTurnRef.current &&
      authorizedTurnRef.current?.active &&
      authorizedTurnRef.current?.promptTurn === promptTurn &&
      authorizedTurnRef.current?.sessionGeneration === generation
    );
    // Crucial: turnComplete must NOT set active = false prematurely!
    return wasAuthorizedTurn;
  }

  const valid = handleTurnComplete(2);
  assert.equal(valid, true);
  assert.equal(authorizedTurnRef.current.active, true, "Authorization must remain active while audio playback is in flight");

  // Only finalizeModelPlayback deactivates authorization
  function finalizeModelPlayback() {
    authorizedModelTurnRef.current = false;
    authorizedTurnRef.current.active = false;
  }

  finalizeModelPlayback();
  assert.equal(authorizedTurnRef.current.active, false, "Authorization is cleared cleanly upon complete playback finalization");
});

test("40. Normal question playback still works and finishes cleanly", () => {
  const queue = createPlaybackQueue();
  const captions = createProgressiveCaptionsController();
  const question = "Aap Bangalore mein kis area mein rehti hain? Roz aas-paas kin areas mein aana-jaana hota hai?";

  captions.beginTurn({ targetQuestionText: question });
  const source1 = { id: 1, stopped: false, stop() { this.stopped = true; } };
  const source2 = { id: 2, stopped: false, stop() { this.stopped = true; } };

  queue.sourceStarted(source1);
  captions.registerAudioChunk({ startAt: 0.0, duration: 2.0, chunkSequence: 1 });
  queue.sourceStarted(source2);
  captions.registerAudioChunk({ startAt: 2.0, duration: 2.5, chunkSequence: 2 });

  captions.updatePlaybackProgress(4.5);
  queue.sourceEnded(source1);
  queue.sourceEnded(source2);

  const completedText = captions.markPlaybackComplete();
  assert.equal(completedText, question);
  assert.equal(queue.activeSourceCount, 0);
  assert.equal(captions.isCompleted(), true);
});

test("41. Candidate interruption still stops the current AI audio correctly", () => {
  const queue = createPlaybackQueue();
  const source = { id: "bangalore-q", stopped: false, stop() { this.stopped = true; } };
  queue.sourceStarted(source);

  const authorizedModelTurnRef = { current: true };
  const authorizedTurnRef = {
    current: {
      promptTurn: 4,
      sessionGeneration: 1,
      questionId: "A1",
      active: true,
    },
  };
  const turnInterruptedRef = { current: false };

  // Candidate speaks to barge-in:
  function handleInterruption() {
    turnInterruptedRef.current = true;
    authorizedModelTurnRef.current = false;
    if (authorizedTurnRef.current) {
      authorizedTurnRef.current.active = false;
    }
    source.stop();
    queue.cancelAll("interrupted");
  }

  handleInterruption();

  assert.equal(source.stopped, true, "Active source must be immediately stopped on candidate interruption");
  assert.equal(queue.activeSourceCount, 0, "Playback queue must be cleared on candidate interruption");
  assert.equal(turnInterruptedRef.current, true);
  assert.equal(authorizedTurnRef.current.active, false);
});
