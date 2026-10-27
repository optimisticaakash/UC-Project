export const WAIT_ANNOUNCEMENT_TEXT = "Please thoda wait kijiye, main aapke liye next question prepare kar rahi hoon.";

export function createRequestWaitAnnouncement({
  delayMs,
  onAnnounce,
  onWaitingChange = () => {},
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}) {
  let timer = null;
  let announced = false;
  let finished = false;
  let finishReason = null;
  let resolveFinished;
  const finishedPromise = new Promise((resolve) => {
    resolveFinished = resolve;
  });

  function finish(reason) {
    if (finished) return;
    finished = true;
    finishReason = reason;
    resolveFinished(reason);
  }

  return {
    start() {
      if (timer !== null || announced || finished) return;
      timer = schedule(() => {
        timer = null;
        if (finished) return;
        try {
          const didAnnounce = onAnnounce();
          if (didAnnounce === false) {
            onWaitingChange(false);
            finish("announcement_suppressed");
            return;
          }
          announced = true;
          onWaitingChange(true);
        } catch {
          onWaitingChange(false);
          finish("announcement_failed");
        }
      }, delayMs);
    },
    resolveRequest() {
      if (timer !== null) cancelSchedule(timer);
      timer = null;
      onWaitingChange(false);
      if (!announced) finish("request_resolved_fast");
      return announced;
    },
    markSpeechFinished(reason = "speech_finished") {
      finish(reason);
    },
    async waitForSpeech(timeoutMs = 10000, scheduleTimeout = setTimeout, cancelTimeout = clearTimeout) {
      if (!announced) return "not_announced";
      if (finished) return finishReason;
      let timeout;
      const result = await Promise.race([
        finishedPromise,
        new Promise((resolve) => {
          timeout = scheduleTimeout(() => resolve("speech_timeout"), timeoutMs);
        }),
      ]);
      if (timeout !== undefined) cancelTimeout(timeout);
      return result;
    },
    cancel(reason = "cancelled", { notify = true } = {}) {
      if (timer !== null) cancelSchedule(timer);
      timer = null;
      if (notify) onWaitingChange(false);
      finish(reason);
    },
    get announced() {
      return announced;
    },
    get finished() {
      return finished;
    },
  };
}
