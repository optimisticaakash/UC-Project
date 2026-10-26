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
  assert.match(html, /Interview complete/);
  assert.match(html, /इंटरव्यू पूरा/);
  assert.doesNotMatch(html, /manual|review|score|assessment|answer|sessionId/i);
});

test("candidate early-end screen does not reveal internal report or review fields", () => {
  const html = renderToStaticMarkup(createElement(CandidateCompletion, { endedEarly: true }));
  assert.match(html, /Interview ended/);
  assert.match(html, /इंटरव्यू समाप्त/);
  assert.doesNotMatch(html, /manual|review|score|assessment|answer|sessionId/i);
});

test("internal report is accepted only for the selected session ID", () => {
  assert.equal(reportBelongsToSession({ sessionId: "session-a" }, "session-a"), true);
  assert.equal(reportBelongsToSession({ sessionId: "session-b" }, "session-a"), false);
});
