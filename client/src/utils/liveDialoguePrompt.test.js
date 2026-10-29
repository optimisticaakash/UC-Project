import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClarificationPrompt,
  buildInitialQuestionPrompt,
  buildInvalidWarningPrompt,
  buildQuestionHandoffPrompt,
  buildRepeatPrompt,
  buildTerminationPrompt,
  buildWaitingAnnouncementPrompt,
} from "./liveDialoguePrompt.js";
import { WAIT_ANNOUNCEMENT_TEXT } from "./requestWaitAnnouncement.js";

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

test("the waiting voice prompt speaks only the approved Hinglish announcement", () => {
  const prompt = buildWaitingAnnouncementPrompt(WAIT_ANNOUNCEMENT_TEXT);
  assert.ok(prompt.endsWith(WAIT_ANNOUNCEMENT_TEXT));
  assert.match(prompt, /only exception to the usual interview dialogue instructions/i);
  assert.doesNotMatch(prompt, /no pause|<no speech>|\{pause\}|Processing candidate answer/i);
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

test("question handoffs strictly prohibit echoing or acknowledging candidate answers", () => {
  const question = "Aapka current address kya hai? (Kripya apna area aur city batayein)";
  const prompt = buildQuestionHandoffPrompt(question);

  assert.match(prompt, /Do not repeat, echo, or acknowledge the candidate's previous answer/i);
  assert.match(prompt, /Process candidate answers silently without speaking them back/i);
  assert.doesNotMatch(prompt, /begin with one brief, relevant acknowledgement/i);
  assert.ok(prompt.endsWith(question));
});

test("clarification prompts strictly prohibit repeating candidate answers", () => {
  const clarification = "Kripya apna poora address batayein.";
  const prompt = buildClarificationPrompt(clarification);

  assert.match(prompt, /Do not repeat the candidate's answer/i);
  assert.match(prompt, /Never repeat, echo, paraphrase, or quote what the candidate just said/i);
  assert.ok(prompt.endsWith(clarification));
});

test("A2_NAME handoff to A0 allows personalized greeting with candidate name", () => {
  const questionA0 =
    "Namaste! Main UC ki screening assistant hoon. Ye baat-cheet sirf screening ke liye record hogi. Shuru karein? Aap Hindi mein baat karengi ya English mein?";
  const prompt = buildQuestionHandoffPrompt(questionA0, "Aarti");

  assert.match(prompt, /Begin by greeting the candidate warmly: "Namaste Aarti ji!"/);
  assert.ok(prompt.endsWith(questionA0));
});

test("invalid answer warning level 1 instructs model to speak clarification and repeat complete question aloud", () => {
  const spokenText =
    "Maaf kijiye, mujhe aapka naam samajh nahi aaya. Kripya apna naam seedhe batayein: Namaste ji, sabse pehle aap apna naam bataiye.";
  const prompt = buildInvalidWarningPrompt(spokenText, 1);

  assert.match(prompt, /Speak the following polite clarification and repeat the complete interview question aloud exactly as written below/i);
  assert.match(prompt, /Do not omit the question or repeat candidate words/i);
  assert.match(prompt, /Never repeat, echo, paraphrase, or quote what the candidate just said/i);
  assert.ok(prompt.endsWith(spokenText));
});

test("invalid answer warning level 2 instructs model to speak final warning and repeat complete question aloud", () => {
  const spokenText =
    "Aapka jawab samajh nahi aaya. Ye aapka aakhri attempt hai. Kripya apna naam spasht batayein: Namaste ji, sabse pehle aap apna naam bataiye.";
  const prompt = buildInvalidWarningPrompt(spokenText, 2);

  assert.match(prompt, /Speak the following final warning and repeat the complete interview question aloud exactly as written below/i);
  assert.match(prompt, /Do not omit the question or repeat candidate words/i);
  assert.ok(prompt.endsWith(spokenText));
});

test("termination prompt instructs model to speak termination message without asking new questions", () => {
  const terminationMessage =
    "Teen baar koshish karne ke baad bhi relevant jawab na milne ki wajah se interview aage nahi badh sakta. Aapka interview yahin samapt hota hai.";
  const prompt = buildTerminationPrompt(terminationMessage);

  assert.match(prompt, /Speak the following termination message clearly and politely to the candidate/i);
  assert.match(prompt, /Do not ask any questions/i);
  assert.ok(prompt.endsWith(terminationMessage));
});

test("question handoffs preserve selected English language in subsequent prompts", () => {
  const question = "Aap Bangalore mein kis area mein rehti hain?";
  const prompt = buildQuestionHandoffPrompt(question, "Sunita", "English");

  assert.match(prompt, /Conduct this question in English as requested by the candidate/i);
  assert.match(prompt, /Namaste Sunita ji!/);
  assert.ok(prompt.endsWith(question));
});

test("question handoffs include natural brief acknowledgement when provided", () => {
  const question = "Aapki umar kitni hai?";
  const acknowledgement = "Theek hai, samajh gayi.";
  const prompt = buildQuestionHandoffPrompt(question, null, "Hindi", acknowledgement);

  assert.match(prompt, /First, say this brief natural acknowledgement: "Theek hai, samajh gayi\."/);
  assert.ok(prompt.endsWith(question));
});

test("English question handoffs include natural brief English acknowledgement", () => {
  const question = "How many years of salon experience do you have?";
  const acknowledgement = "Thank you, Priya.";
  const prompt = buildQuestionHandoffPrompt(question, "Priya", "English", acknowledgement);

  assert.match(prompt, /Conduct this question in English as requested by the candidate/i);
  assert.match(prompt, /First, say this brief natural acknowledgement: "Thank you, Priya\."/);
  assert.ok(prompt.endsWith(question));
});
