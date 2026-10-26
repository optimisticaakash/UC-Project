export function createPlaybackQueue() {
  const activeSources = new Set();
  const waiters = new Set();
  let sourceStartRevision = 0;

  function resolveWaiters(outcome) {
    if (activeSources.size > 0) return;
    for (const resolve of waiters) resolve(outcome);
    waiters.clear();
  }

  return {
    sourceStarted(source) {
      if (!activeSources.has(source)) {
        activeSources.add(source);
        sourceStartRevision += 1;
      }
    },

    sourceEnded(source) {
      if (!activeSources.delete(source)) return;
      resolveWaiters("played");
    },

    cancelAll(outcome = "interrupted") {
      activeSources.clear();
      resolveWaiters(outcome);
    },

    waitUntilDrained() {
      if (activeSources.size === 0) return Promise.resolve("played");
      return new Promise((resolve) => waiters.add(resolve));
    },

    get activeSourceCount() {
      return activeSources.size;
    },

    get sourceStartRevision() {
      return sourceStartRevision;
    },
  };
}

export async function waitForPlaybackAndPause({
  playbackQueue,
  pause,
  isCurrent,
}) {
  let playbackOutcome;

  while (true) {
    const startRevision = playbackQueue.sourceStartRevision;
    playbackOutcome = await playbackQueue.waitUntilDrained();
    if (!isCurrent()) return { ready: false, playbackOutcome };

    await pause(1000);
    if (!isCurrent()) return { ready: false, playbackOutcome };

    // Audio may arrive after the queue was observed empty. Require a full
    // quiet interval after the latest source has played before handing off.
    if (
      playbackQueue.activeSourceCount === 0 &&
      playbackQueue.sourceStartRevision === startRevision
    ) {
      return { ready: true, playbackOutcome };
    }
  }
}

export function pauseFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
