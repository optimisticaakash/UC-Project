import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeTranscriptionText,
  createProgressiveCaptionsController,
} from "./progressiveCaptions.js";

test("sanitizeTranscriptionText strips internal markers and control tags", () => {
  assert.equal(sanitizeTranscriptionText("<no speech>"), "");
  assert.equal(sanitizeTranscriptionText("{pause}"), "");
  assert.equal(sanitizeTranscriptionText("<no speech>{pause} internal orchestration"), "internal orchestration");
  assert.equal(sanitizeTranscriptionText("[system] Namaste ji"), "Namaste ji");
  assert.equal(sanitizeTranscriptionText("  Namaste!   Main UC ki screening assistant hoon.  "), "Namaste! Main UC ki screening assistant hoon.");
  assert.equal(sanitizeTranscriptionText(null), "");
  assert.equal(sanitizeTranscriptionText(undefined), "");
});

test("progressive captions do not pop full question before audio playback begins", () => {
  const controller = createProgressiveCaptionsController();
  const question = "Namaste ji, sabse pehle aap apna naam bataiye.";
  controller.beginTurn({ targetQuestionText: question });

  // Before any audio chunks are registered
  assert.equal(controller.getCaptionText(), "");
  assert.equal(controller.updatePlaybackProgress(0.0), "");

  // Register scheduled audio chunk: from 1.0s to 3.0s
  controller.registerAudioChunk({ startAt: 1.0, duration: 2.0, chunkSequence: 1 });

  // Audio Context is before startAt (e.g. 0.5s)
  assert.equal(controller.updatePlaybackProgress(0.5), "");
});

test("progressive captions reveal words proportionally along the Web Audio timeline", () => {
  const controller = createProgressiveCaptionsController();
  // 7 words
  const question = "Namaste ji sabse pehle apna naam bataiye";
  controller.beginTurn({ targetQuestionText: question });

  // 1 chunk of 4 seconds: 1.0s to 5.0s
  controller.registerAudioChunk({ startAt: 1.0, duration: 4.0, chunkSequence: 1 });

  // At startAt (1.0s): at least 1 word
  const tStart = controller.updatePlaybackProgress(1.0);
  assert.ok(tStart.length > 0);
  assert.ok(tStart.startsWith("Namaste"));

  // At 25% (2.0s):
  const t25 = controller.updatePlaybackProgress(2.0);
  assert.ok(t25.split(" ").length >= 2);
  assert.ok(t25.length < question.length);

  // At 50% (3.0s):
  const t50 = controller.updatePlaybackProgress(3.0);
  assert.ok(t50.split(" ").length >= 3);
  assert.ok(t50.length > t25.length);

  // At 75% (4.0s):
  const t75 = controller.updatePlaybackProgress(4.0);
  assert.ok(t75.split(" ").length >= 5);
  assert.ok(t75.length > t50.length);

  // At completion (5.0s):
  const t100 = controller.updatePlaybackProgress(5.0);
  assert.equal(t100, question);
});

test("progressive captions span multiple scheduled audio chunks correctly", () => {
  const controller = createProgressiveCaptionsController();
  const question = "Aap Bangalore mein kis area mein rehti hain";
  controller.beginTurn({ targetQuestionText: question });

  // Chunk 1: 0.0s to 1.0s
  controller.registerAudioChunk({ startAt: 0.0, duration: 1.0, chunkSequence: 1 });
  // Chunk 2: 1.0s to 2.0s
  controller.registerAudioChunk({ startAt: 1.0, duration: 1.0, chunkSequence: 2 });
  // Chunk 3: 2.0s to 3.0s
  controller.registerAudioChunk({ startAt: 2.0, duration: 1.0, chunkSequence: 3 });

  // At 1.5s (halfway through the 3 chunks):
  const mid = controller.updatePlaybackProgress(1.5);
  assert.ok(mid.split(" ").length >= 3);
  assert.ok(mid.length < question.length);

  // Mark playback complete:
  const complete = controller.markPlaybackComplete();
  assert.equal(complete, question);
  assert.equal(controller.isCompleted(), true);
});

test("prefers actual output transcription text over target question when provided", () => {
  const controller = createProgressiveCaptionsController();
  controller.beginTurn({ targetQuestionText: "Namaste ji, sabse pehle aap apna naam bataiye." });

  // Gemini Live emits output transcription chunks
  controller.appendTranscription("Namaste ji,");
  controller.appendTranscription("sabse pehle aap apna naam bataiye.");

  controller.registerAudioChunk({ startAt: 0.0, duration: 2.0, chunkSequence: 1 });

  controller.updatePlaybackProgress(1.0);
  const mid = controller.getCaptionText();
  assert.ok(mid.startsWith("Namaste ji,"));

  const full = controller.markPlaybackComplete();
  assert.equal(full, "Namaste ji, sabse pehle aap apna naam bataiye.");
});

test("interruption freezes caption reveal at current point", () => {
  const controller = createProgressiveCaptionsController();
  controller.beginTurn({ targetQuestionText: "Namaste ji sabse pehle apna naam bataiye" });
  controller.registerAudioChunk({ startAt: 0.0, duration: 4.0, chunkSequence: 1 });

  controller.updatePlaybackProgress(2.0);
  const beforeInterrupt = controller.getCaptionText();
  assert.ok(beforeInterrupt.length > 0 && beforeInterrupt.length < 40);

  controller.handleInterruption();

  // Further timeline updates do not advance the frozen caption
  const afterInterrupt = controller.updatePlaybackProgress(4.0);
  assert.equal(afterInterrupt, beforeInterrupt);
});

test("beginTurn clears prior captions cleanly for the next question", () => {
  const controller = createProgressiveCaptionsController();
  controller.beginTurn({ targetQuestionText: "Question 1 text" });
  controller.registerAudioChunk({ startAt: 0.0, duration: 1.0, chunkSequence: 1 });
  controller.markPlaybackComplete();
  assert.equal(controller.getCaptionText(), "Question 1 text");

  // Next question turn begins
  controller.beginTurn({ targetQuestionText: "Question 2 text" });
  assert.equal(controller.getCaptionText(), "");
  assert.equal(controller.isCompleted(), false);
});

