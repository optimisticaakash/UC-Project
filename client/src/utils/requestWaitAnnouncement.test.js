import assert from "node:assert/strict";
import test from "node:test";
import {
  createRequestWaitAnnouncement,
  WAIT_ANNOUNCEMENT_TEXT,
} from "./requestWaitAnnouncement.js";
import { createPlaybackQueue, waitForPlaybackAndPause } from "./playbackCompletion.js";

function createFakeTimers() {
  let nextId = 0;
  const tasks = new Map();
  return {
    tasks,
    schedule(callback) {
      const id = ++nextId;
      tasks.set(id, callback);
      return id;
    },
    cancel(id) { tasks.delete(id); },
    runAll() {
      const pending = [...tasks.values()];
      tasks.clear();
      pending.forEach((callback) => callback());
    },
  };
}

test("a fast backend response cancels the timer without showing or speaking a wait message", () => {
  const timers = createFakeTimers();
  const events = [];
  const wait = createRequestWaitAnnouncement({
    delayMs: 1400,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    onWaitingChange: (value) => events.push(value),
    onAnnounce: () => events.push("spoken"),
  });
  wait.start();
  assert.equal(wait.resolveRequest(), false);
  timers.runAll();
  assert.equal(events.includes("spoken"), false);
  assert.equal(events.includes(true), false);
  assert.equal(timers.tasks.size, 0);
});

test("a slow backend request triggers one Hinglish announcement and waits for its audio turn", async () => {
  const timers = createFakeTimers();
  const events = [];
  const wait = createRequestWaitAnnouncement({
    delayMs: 1400,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    onWaitingChange: (value) => events.push(value),
    onAnnounce: () => { events.push(WAIT_ANNOUNCEMENT_TEXT); return true; },
  });
  wait.start();
  wait.start();
  timers.runAll();
  assert.equal(events.filter((event) => event === WAIT_ANNOUNCEMENT_TEXT).length, 1);
  assert.equal(wait.resolveRequest(), true);
  let speechFinished = false;
  const speech = wait.waitForSpeech(2000).then(() => { speechFinished = true; });
  await Promise.resolve();
  assert.equal(speechFinished, false);
  wait.markSpeechFinished();
  await speech;
  assert.equal(speechFinished, true);
  assert.deepEqual(events.filter((event) => typeof event === "boolean"), [true, false]);
});

test("cancellation clears the pending announcement and resolves the speech wait", async () => {
  const timers = createFakeTimers();
  let announcements = 0;
  const wait = createRequestWaitAnnouncement({
    delayMs: 1400,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    onAnnounce: () => { announcements += 1; },
  });
  wait.start();
  wait.cancel("interview_ended");
  timers.runAll();
  assert.equal(announcements, 0);
  assert.equal(await wait.waitForSpeech(), "not_announced");
});

test("cancelling an already announced wait releases the pending speech handoff", async () => {
  const timers = createFakeTimers();
  const wait = createRequestWaitAnnouncement({
    delayMs: 10,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    onAnnounce: () => true,
  });
  wait.start();
  timers.runAll();
  wait.resolveRequest();
  const speech = wait.waitForSpeech();
  wait.cancel("interview_ended");
  assert.equal(await speech, "interview_ended");
});

test("a candidate who is still speaking suppresses the waiting voice announcement", () => {
  const timers = createFakeTimers();
  const states = [];
  const wait = createRequestWaitAnnouncement({
    delayMs: 10,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    onWaitingChange: (value) => states.push(value),
    onAnnounce: () => false,
  });
  wait.start();
  timers.runAll();
  assert.equal(wait.announced, false);
  assert.deepEqual(states, [false]);
});

test("the next question waits until the waiting utterance and playback queue finish", async () => {
  const timers = createFakeTimers();
  const playbackQueue = createPlaybackQueue();
  const source = {};
  let nextQuestionSent = false;
  const wait = createRequestWaitAnnouncement({
    delayMs: 10,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    onAnnounce: () => true,
  });
  wait.start();
  timers.runAll();
  const announcementSourceDone = new Promise((resolve) => {
    playbackQueue.sourceStarted(source);
    wait.resolveRequest();
    wait.waitForSpeech().then(resolve);
  });
  const handoff = (async () => {
    await announcementSourceDone;
    await waitForPlaybackAndPause({
      playbackQueue,
      pause: async () => {},
      isCurrent: () => true,
    });
    nextQuestionSent = true;
  })();
  wait.markSpeechFinished();
  await Promise.resolve();
  assert.equal(nextQuestionSent, false);
  playbackQueue.sourceEnded(source);
  await handoff;
  assert.equal(nextQuestionSent, true);
});
