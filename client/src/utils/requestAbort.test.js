import assert from "node:assert/strict";
import test from "node:test";
import { createAbortableRequest } from "./requestAbort.js";

function fakeTimers() {
  const tasks = new Map();
  let id = 0;
  return {
    tasks,
    schedule(callback) { const next = ++id; tasks.set(next, callback); return next; },
    cancel(timerId) { tasks.delete(timerId); },
  };
}

test("a stalled answer request aborts at its deadline and exposes a retryable timeout reason", () => {
  const timers = fakeTimers();
  const request = createAbortableRequest(45000, { schedule: timers.schedule, cancelSchedule: timers.cancel });
  [...timers.tasks.values()][0]();

  assert.equal(request.signal.aborted, true);
  assert.equal(request.reason, "timeout");
  request.clear();
});

test("stopping an interview cancels the pending request and its deadline", () => {
  const timers = fakeTimers();
  const request = createAbortableRequest(45000, { schedule: timers.schedule, cancelSchedule: timers.cancel });
  request.cancel("interview_stopped");

  assert.equal(request.signal.aborted, true);
  assert.equal(request.reason, "interview_stopped");
  assert.equal(timers.tasks.size, 0);
});

test("a completed request clears its deadline without aborting the result", () => {
  const timers = fakeTimers();
  const request = createAbortableRequest(45000, { schedule: timers.schedule, cancelSchedule: timers.cancel });
  request.clear();

  assert.equal(request.signal.aborted, false);
  assert.equal(timers.tasks.size, 0);
});
