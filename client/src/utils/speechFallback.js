
export function speakTextFallback({
  text,
  language = "Hindi",
  onStart = () => { },
  onEnd = () => { },
  onError = () => { },
  speechSynthesisImpl =
  typeof window !== "undefined" ? window.speechSynthesis : null,
  SpeechSynthesisUtteranceImpl =
  typeof window !== "undefined" ? window.SpeechSynthesisUtterance : null,
} = {}) {
  if (
    !text?.trim() ||
    !speechSynthesisImpl ||
    !SpeechSynthesisUtteranceImpl
  ) {
    onError(new Error("speechSynthesis unavailable"));
    return () => { };
  }

  let finished = false;
  let started = false;
  let startTimer = null;
  let playbackTimer = null;

  const clearTimers = () => {
    if (startTimer) clearTimeout(startTimer);
    if (playbackTimer) clearTimeout(playbackTimer);
    startTimer = null;
    playbackTimer = null;
  };

  const finish = (callback) => {
    if (finished) return;
    finished = true;
    clearTimers();
    callback();
  };

  try {
    speechSynthesisImpl.cancel();

    const utterance = new SpeechSynthesisUtteranceImpl(text);

    utterance.lang = language === "English" ? "en-IN" : "hi-IN";
    utterance.rate = 0.95;
    utterance.pitch = 1;

    const voices = speechSynthesisImpl.getVoices?.() || [];

    const normalizedLanguage = language?.toLowerCase();

    const voice =
      normalizedLanguage === "english"
        ? voices.find((v) => v.lang?.toLowerCase() === "en-in") ||
        voices.find((v) => v.lang?.toLowerCase().startsWith("en"))
        : voices.find((v) => v.lang?.toLowerCase() === "hi-in") ||
        voices.find((v) => v.lang?.toLowerCase().startsWith("hi"));

    if (voice) {
      utterance.voice = voice;
    }

    utterance.onstart = () => {
      if (finished) return;

      started = true;
      clearTimers();

      onStart();

      // A timeout after speech starts is a failure,
      // never a successful playback completion.
      playbackTimer = setTimeout(() => {
        finish(() => {
          try {
            speechSynthesisImpl.cancel();
          } catch { }

          onError(new Error("Speech playback timed out"));
        });
      }, Math.max(15000, text.length * 350));
    };

    utterance.onend = () => {
      if (!started) {
        finish(() =>
          onError(new Error("Speech ended without starting"))
        );
        return;
      }

      finish(onEnd);
    };

    utterance.onerror = (event) => {
      finish(() =>
        onError(
          new Error(
            `Speech playback failed: ${event?.error || "unknown error"}`
          )
        )
      );
    };

    // Detect browser TTS that never starts.
    startTimer = setTimeout(() => {
      finish(() => {
        try {
          speechSynthesisImpl.cancel();
        } catch { }

        onError(new Error("Speech synthesis did not start"));
      });
    }, 8000);

    speechSynthesisImpl.resume?.();
    speechSynthesisImpl.speak(utterance);

    return () => {
      if (finished) return;

      finished = true;
      clearTimers();

      try {
        speechSynthesisImpl.cancel();
      } catch { }
    };
  } catch (error) {
    finish(() => onError(error));
    return () => { };
  }
}
