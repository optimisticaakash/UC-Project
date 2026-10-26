import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlaybackQueue,
  waitForPlaybackAndPause,
} from "./playbackCompletion.js";

test("the one-second pause starts only after all scheduled audio ends", async () => {
  const queue = createPlaybackQueue();
  const first = {};
  const last = {};
  const events = [];
  queue.sourceStarted(first);
  queue.sourceStarted(last);

  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: async (ms) => events.push(`pause:${ms}`),
    isCurrent: () => true,
  });

  queue.sourceEnded(first);
  assert.deepEqual(events, []);
  queue.sourceEnded(last);
  const result = await pending;

  assert.deepEqual(events, ["pause:1000"]);
  assert.deepEqual(result, { ready: true, playbackOutcome: "played" });
});

test("turnComplete alone does not release the barrier before scheduled audio ends", async () => {
  const queue = createPlaybackQueue();
  const source = {};
  let settled = false;
  queue.sourceStarted(source);

  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: async () => {},
    isCurrent: () => true,
  }).then((result) => {
    settled = true;
    return result;
  });

  const events = ["turn_complete"];
  await Promise.resolve();
  assert.deepEqual(events, ["turn_complete"]);
  assert.equal(settled, false);

  queue.sourceEnded(source);
  assert.equal((await pending).ready, true);
});

test("an empty queue still waits one second before allowing the response handoff", async () => {
  const queue = createPlaybackQueue();
  let releasePause;
  let handoffAllowed = false;
  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: (ms) => {
      assert.equal(ms, 1000);
      return new Promise((resolve) => { releasePause = resolve; });
    },
    isCurrent: () => true,
  }).then((result) => {
    handoffAllowed = result.ready;
    return result;
  });

  await Promise.resolve();
  assert.equal(handoffAllowed, false);
  releasePause();
  assert.equal((await pending).ready, true);
  assert.equal(handoffAllowed, true);
});

test("audio scheduled during the pause must finish before a fresh one-second gap", async () => {
  const queue = createPlaybackQueue();
  const lateSource = {};
  const pauses = [];
  let releaseFirstPause;
  let releaseSecondPause;
  let handoffAllowed = false;

  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: (ms) => {
      pauses.push(ms);
      return new Promise((resolve) => {
        if (pauses.length === 1) releaseFirstPause = resolve;
        else releaseSecondPause = resolve;
      });
    },
    isCurrent: () => true,
  }).then((result) => {
    handoffAllowed = result.ready;
    return result;
  });

  await Promise.resolve();
  queue.sourceStarted(lateSource);
  releaseFirstPause();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(handoffAllowed, false);
  assert.deepEqual(pauses, [1000]);

  queue.sourceEnded(lateSource);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(pauses, [1000, 1000]);
  assert.equal(handoffAllowed, false);

  releaseSecondPause();
  assert.equal((await pending).ready, true);
  assert.equal(handoffAllowed, true);
});

test("clarification and follow-up handoffs use the same playback barrier", async () => {
  for (const promptType of ["clarification", "follow_up"]) {
    const queue = createPlaybackQueue();
    const source = { promptType };
    const events = [];
    queue.sourceStarted(source);

    const pending = waitForPlaybackAndPause({
      playbackQueue: queue,
      pause: async (ms) => events.push(`pause:${ms}`),
      isCurrent: () => true,
    });

    assert.deepEqual(events, [], `${promptType} must wait for audio`);
    queue.sourceEnded(source);
    await pending;
    assert.deepEqual(events, ["pause:1000"]);
  }
});

test("duplicate source completion cannot trigger duplicate pauses", async () => {
  const queue = createPlaybackQueue();
  const source = {};
  const events = [];
  queue.sourceStarted(source);
  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: async (ms) => events.push(ms),
    isCurrent: () => true,
  });

  queue.sourceEnded(source);
  queue.sourceEnded(source);
  await pending;

  assert.deepEqual(events, [1000]);
});

test("an obsolete source completion cannot drain a newer response queue", async () => {
  const queue = createPlaybackQueue();
  const oldSource = {};
  const currentSource = {};
  queue.sourceStarted(oldSource);
  queue.cancelAll("interrupted");
  queue.sourceStarted(currentSource);

  queue.sourceEnded(oldSource);
  assert.equal(queue.activeSourceCount, 1);

  const pending = queue.waitUntilDrained();
  queue.sourceEnded(currentSource);
  assert.equal(await pending, "played");
  assert.equal(queue.activeSourceCount, 0);
});

test("stale lifecycle state prevents the pause and next handoff", async () => {
  const queue = createPlaybackQueue();
  const source = {};
  const events = [];
  let current = true;
  queue.sourceStarted(source);

  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: async (ms) => events.push(ms),
    isCurrent: () => current,
  });

  current = false;
  queue.sourceEnded(source);
  const result = await pending;

  assert.equal(result.ready, false);
  assert.deepEqual(events, []);
});

test("a session that becomes stale during the pause cannot hand off a prompt", async () => {
  const queue = createPlaybackQueue();
  let releasePause;
  let current = true;
  queue.sourceStarted({});

  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: () => new Promise((resolve) => { releasePause = resolve; }),
    isCurrent: () => current,
  });

  queue.cancelAll("interrupted");
  await Promise.resolve();
  current = false;
  releasePause();

  assert.equal((await pending).ready, false);
});

test("an explicit interruption drains stopped sources without duplicate completion", async () => {
  const queue = createPlaybackQueue();
  const source = {};
  const events = [];
  queue.sourceStarted(source);
  const pending = waitForPlaybackAndPause({
    playbackQueue: queue,
    pause: async (ms) => events.push(ms),
    isCurrent: () => true,
  });

  queue.cancelAll("interrupted");
  const result = await pending;
  queue.sourceEnded(source);

  assert.deepEqual(result, { ready: true, playbackOutcome: "interrupted" });
  assert.deepEqual(events, [1000]);
});
