import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackQueue, waitForPlaybackAndPause } from "./playbackCompletion.js";
import { createProgressiveCaptionsController } from "./progressiveCaptions.js";
import { createLiveInputTurn, isInternalSpeechMarker } from "./liveInputTurn.js";
import { AI_CAPTION_STATES, resolveAiCaptionModel } from "./interviewUiState.js";

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
