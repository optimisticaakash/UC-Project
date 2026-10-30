function mergeTranscript(current, incoming) {
  if (!current) return incoming;
  if (incoming === current || current.startsWith(incoming)) return current;
  if (incoming.startsWith(current)) return incoming;
  return `${current} ${incoming}`.trim();
}

function transcriptKey(transcription, text) {
  const { startOffset, endOffset, finished } = transcription;

  if (startOffset !== undefined || endOffset !== undefined) {
    return JSON.stringify([startOffset, endOffset, text, finished]);
  }

  return JSON.stringify([text, finished]);
}

export function isInternalSpeechMarker(value) {
  return /^(?:(?:<\s*no\s+speech\s*>|no\s+speech|no\s+pause|\{\s*pause\s*\})\s*)+$/i.test(
    typeof value === "string" ? value.trim() : "",
  );
}

export function createLiveInputTurn() {
  let phase = "listening";
  let candidateActivity = false;
  let candidateInterimActivity = false;
  let modelTurnInterrupted = false;
  let candidateResponseComplete = false;
  let transcript = "";
  let latestInterimText = "";
  let transcriptFinalized = false;
  let answerIssued = false;
  let seenTranscripts = new Set();
  // Offsets are relative to the audio session. Keep these keys across model
  // turns so a delayed duplicate cannot be mistaken for the next answer.
  const seenSessionTranscripts = new Set();

  function resetCandidate() {
    candidateActivity = false;
    candidateInterimActivity = false;
    modelTurnInterrupted = false;
    candidateResponseComplete = false;
    transcript = "";
    latestInterimText = "";
    transcriptFinalized = false;
    answerIssued = false;
    seenTranscripts = new Set();
  }

  function result(answer = null) {
    return { transcript, answer, activity: false };
  }

  return {
    beginModelTurn() {
      phase = "model";
      resetCandidate();
    },

    reset() {
      phase = "listening";
      resetCandidate();
      seenSessionTranscripts.clear();
    },

    finishModelPlayback() {
      if (phase === "model") {
        if (modelTurnInterrupted && candidateActivity && candidateResponseComplete) {
          phase = "candidate";
        } else {
          phase = "listening";
          resetCandidate();
        }
      }

      let answer = null;
      const canEmitAnswer =
        modelTurnInterrupted &&
        candidateActivity &&
        candidateResponseComplete &&
        transcriptFinalized &&
        !candidateInterimActivity &&
        transcript &&
        phase !== "submitted" &&
        phase !== "model";

      if (canEmitAnswer) {
        answer = transcript;
      }

      return { transcript: answer || "", answer, activity: false };
    },

    interruptModelPlayback() {
      if (phase === "model") {
        candidateActivity = true;
        modelTurnInterrupted = true;
      }
    },

    handleServerContent(content, { isPlaybackActive = false } = {}) {
      if (!content) return result();
      let activity = false;

      // Requirement 1: While AI question playback is actively playing through speakers,
      // do not treat microphone input as the candidate's answer unless model turn was explicitly interrupted.
      if (isPlaybackActive && !modelTurnInterrupted) {
        return { transcript: "", answer: null, activity: false };
      }

      if (content.interrupted && phase === "model") {
        candidateActivity = true;
        modelTurnInterrupted = true;
      }

      if (content.interimInputTranscription?.text?.trim()) {
        const interim = content.interimInputTranscription.text.trim();
        if (!isInternalSpeechMarker(interim) && phase !== "submitted") {
          activity = true;
          candidateActivity = true;
          candidateInterimActivity = true;
          candidateResponseComplete = false;
          transcriptFinalized = false;
          answerIssued = false;
          latestInterimText = interim;
        }
      }

      const input = content.inputTranscription;
      const text = input?.text?.trim();
      let answer = null;

      if (text && !isInternalSpeechMarker(text) && phase !== "submitted") {
        const key = transcriptKey(input, text);
        const hasOffsets =
          input.startOffset !== undefined || input.endOffset !== undefined;
        const duplicate = hasOffsets
          ? seenSessionTranscripts.has(key)
          : seenTranscripts.has(key);

        if (!duplicate) {
          activity = true;
          candidateActivity = true;
          seenTranscripts.add(key);
          if (hasOffsets) seenSessionTranscripts.add(key);
          transcript = mergeTranscript(transcript, text);
          transcriptFinalized = input.finished !== false;
          if (answerIssued) answerIssued = false;
          if (input.finished === false) candidateResponseComplete = false;
        }

        // A finalized input transcription marks the candidate's speech as
        // complete even if it arrives before the model turnComplete event.
        // The model turn still must complete before submitting, so an
        // assistant-only turn cannot become a candidate answer.
        if (input.finished !== false) {
          candidateInterimActivity = false;
          latestInterimText = "";
          if (phase === "listening") {
            phase = "candidate";
          }
          if (phase === "model" || phase === "candidate") {
            candidateResponseComplete = true;
          }
        }
      }

      if (content.turnComplete && phase !== "submitted") {
        if (phase === "model") {
          if (modelTurnInterrupted || (candidateActivity && candidateResponseComplete)) {
            phase = "candidate";
            candidateResponseComplete = true;
          } else if (candidateActivity) {
            phase = "candidate";
          } else if (!isPlaybackActive) {
            phase = "listening";
          }
        } else if (candidateActivity) {
          phase = "candidate";
          if (!candidateInterimActivity && candidateResponseComplete) {
            if (transcript) {
              transcriptFinalized = true;
            }
          }
        }
      }

      const canEmitAnswer =
        candidateActivity &&
        candidateResponseComplete &&
        transcriptFinalized &&
        !candidateInterimActivity &&
        transcript &&
        phase !== "submitted" &&
        !answerIssued &&
        phase !== "model" &&
        (!isPlaybackActive || modelTurnInterrupted);

      if (canEmitAnswer) {
        answer = transcript;
        answerIssued = true;
      }

      return { transcript, answer, activity };
    },

    commitAnswer() {
      if (answerIssued || transcript) phase = "submitted";
    },

    retry() {
      phase = "listening";
      resetCandidate();
    },

    getTranscript() {
      return (transcript || latestInterimText).trim();
    },

    isCandidateSpeaking() {
      return candidateInterimActivity || (candidateActivity && !candidateResponseComplete);
    },

    hasCandidateSpoken() {
      const best = (transcript || latestInterimText).trim();
      return candidateActivity && Boolean(best && !isInternalSpeechMarker(best));
    },

    phase() {
      return phase;
    },
  };
}
