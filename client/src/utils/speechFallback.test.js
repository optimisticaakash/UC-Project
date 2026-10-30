import assert from "node:assert/strict";
import test from "node:test";
import { speakTextFallback } from "./speechFallback.js";

class MockUtterance {
  constructor(text) {
    this.text = text;
    this.lang = "";
    this.rate = 1.0;
    this.pitch = 1.0;
    this.voice = null;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

function createMockSpeechSynthesis({ voices = [] } = {}) {
  let speaking = false;
  let activeUtterance = null;
  return {
    get speaking() {
      return speaking;
    },
    get activeUtterance() {
      return activeUtterance;
    },
    getVoices() {
      return voices;
    },
    speak(utterance) {
      speaking = true;
      activeUtterance = utterance;
    },
    cancel() {
      speaking = false;
      if (activeUtterance && activeUtterance.onerror) {
        activeUtterance.onerror({ error: "canceled" });
      }
      activeUtterance = null;
    },
  };
}

test("speakTextFallback speaks Hindi text with hi-IN language and triggers onStart / onEnd", () => {
  const synth = createMockSpeechSynthesis({
    voices: [{ lang: "hi-IN", name: "Hindi Voice" }],
  });
  let started = false;
  let ended = false;

  speakTextFallback({
    text: "Ye interview Aakash ke naam par registered hai.",
    language: "Hindi",
    onStart: () => {
      started = true;
    },
    onEnd: () => {
      ended = true;
    },
    speechSynthesisImpl: synth,
    SpeechSynthesisUtteranceImpl: MockUtterance,
  });

  assert.equal(synth.speaking, true);
  assert.equal(synth.activeUtterance.lang, "hi-IN");
  assert.equal(synth.activeUtterance.voice?.lang, "hi-IN");
  synth.activeUtterance.onstart();
  assert.equal(started, true);
  assert.equal(ended, false);

  synth.activeUtterance.onstart();
  synth.activeUtterance.onend();

  assert.equal(ended, true);
});

test("speakTextFallback selects English en-IN voice for English language", () => {
  const synth = createMockSpeechSynthesis({
    voices: [{ lang: "en-IN", name: "Indian English Voice" }],
  });
  let ended = false;

  speakTextFallback({
    text: "This interview is registered under Aakash.",
    language: "English",
    onEnd: () => {
      ended = true;
    },
    speechSynthesisImpl: synth,
    SpeechSynthesisUtteranceImpl: MockUtterance,
  });

  assert.equal(synth.activeUtterance.lang, "en-IN");
  assert.equal(synth.activeUtterance.voice?.lang, "en-IN");

  synth.activeUtterance.onstart();
  synth.activeUtterance.onend();

  assert.equal(ended, true);
});

test("speakTextFallback cancel function stops speech and triggers clean cancellation", () => {
  const synth = createMockSpeechSynthesis();

  const cancel = speakTextFallback({
    text: "Test cancellation",
    language: "Hindi",
    onEnd: () => { },
    speechSynthesisImpl: synth,
    SpeechSynthesisUtteranceImpl: MockUtterance,
  });

  assert.equal(synth.speaking, true);
  cancel();
  assert.equal(synth.speaking, false);
});

test("speakTextFallback calls onError if speech synthesis is unavailable", () => {
  let errorCaught = null;
  speakTextFallback({
    text: "Test unavailable",
    onEnd: () => { },
    onError: (err) => {
      errorCaught = err;
    },
    speechSynthesisImpl: null,
    SpeechSynthesisUtteranceImpl: null,
  });

  assert.ok(errorCaught);
  assert.match(errorCaught.message, /speechSynthesis unavailable/i);
});
