import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CandidateCompletion from "../components/CandidateCompletion.js";
import {
  reportBelongsToSession,
} from "./internalAssessment.js";

test("candidate completion screen contains only neutral thank-you copy", () => {
  const html = renderToStaticMarkup(createElement(CandidateCompletion));
  assert.match(html, /Interview completed/);
  assert.match(html, /Thank you/);
  assert.doesNotMatch(html, /manual|review|score|assessment|answer|sessionId/i);
});

test("candidate early-end screen does not reveal internal report or review fields", () => {
  const html = renderToStaticMarkup(createElement(CandidateCompletion, { outcome: "ended" }));
  assert.match(html, /Interview ended/);
  assert.match(html, /Thank you/);
  assert.doesNotMatch(html, /manual|review|score|assessment|answer|sessionId/i);
});

test("manual review completion is distinct and does not expose assessment details", () => {
  const html = renderToStaticMarkup(createElement(CandidateCompletion, { outcome: "manual_review" }));
  assert.match(html, /Manual review required/);
  assert.match(html, /Our team will review your response/i);
  assert.doesNotMatch(html, /score|assessment|sessionId/i);
});

test("terminated completion is distinct and explains termination gracefully", () => {
  const html = renderToStaticMarkup(createElement(CandidateCompletion, { outcome: "terminated" }));
  assert.match(html, /Interview terminated/);
  assert.match(html, /The interview has ended because a relevant response was not provided after repeated warnings/i);
  assert.doesNotMatch(html, /manual|review|score|assessment|sessionId/i);
});

test("internal report is accepted only for the selected session ID", () => {
  assert.equal(reportBelongsToSession({ sessionId: "session-a" }, "session-a"), true);
  assert.equal(reportBelongsToSession({ sessionId: "session-b" }, "session-a"), false);
});
