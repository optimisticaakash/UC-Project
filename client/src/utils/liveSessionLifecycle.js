export function isCurrentLiveGeneration(eventGeneration, currentGeneration) {
  return eventGeneration === currentGeneration;
}

export function isCurrentLiveSession(
  expectedSession,
  expectedGeneration,
  activeSession,
  activeGeneration,
) {
  return (
    expectedSession != null &&
    expectedSession === activeSession &&
    isCurrentLiveGeneration(expectedGeneration, activeGeneration)
  );
}
