import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClarificationPrompt,
  buildInitialQuestionPrompt,
  buildQuestionHandoffPrompt,
  buildRepeatPrompt,
} from "./liveDialoguePrompt.js";

const internalNarration =
  "The user selected Hindi, so I will acknowledge this and wait for the backend's next prompt.";

test("question handoffs keep internal orchestration out of candidate-facing dialogue", () => {
  const question = "Aap apne kaam ke baare mein batayiye.";
  const prompt = buildQuestionHandoffPrompt(question);

  assert.ok(prompt.includes(question));
  assert.match(prompt, /only words intended for the candidate/i);
  assert.match(prompt, /Never narrate thoughts, plans, language choice, processing, waiting/i);
  assert.doesNotMatch(prompt, /The user selected Hindi/i);
  assert.doesNotMatch(prompt, /backend's next prompt/i);
});

test("the initial official question remains speakable exactly as provided", () => {
  const question = "Namaste ji, sabse pehle aap apna naam bataiye.";
  const prompt = buildInitialQuestionPrompt(question);

  assert.ok(prompt.endsWith(question));
  assert.match(prompt, /Say the following opening question exactly as written/i);
});

test("clarifications remain direct, polite, and present verbatim", () => {
  const clarification = "Kya aap is baat ko thoda aur spasht kar sakti hain?";
  const prompt = buildClarificationPrompt(clarification);

  assert.ok(prompt.endsWith(clarification));
  assert.match(prompt, /Ask the following clarification directly, politely/i);
});

test("repeat handoffs retain the exact active prompt", () => {
  const prompt = "Agar kaam door ho, to kya aap travel kar sakti hain?";
  const repeated = buildRepeatPrompt(prompt);

  assert.ok(repeated.endsWith(prompt));
  assert.match(repeated, /Repeat the exact active question or clarification/i);
});

test("the previously observed internal narration is never supplied as dialogue", () => {
  for (const prompt of [
    buildInitialQuestionPrompt("Aapka naam kya hai?"),
    buildQuestionHandoffPrompt("Aapka anubhav batayiye."),
    buildClarificationPrompt("Kya aap dobara samjha sakti hain?"),
    buildRepeatPrompt("Aapka naam kya hai?"),
  ]) {
    assert.equal(prompt.includes(internalNarration), false);
  }
});
