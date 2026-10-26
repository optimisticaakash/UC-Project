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

export function createLiveInputTurn() {
  let phase = "listening";
  let candidateActivity = false;
  let candidateInterimActivity = false;
  let modelTurnInterrupted = false;
  let candidateResponseComplete = false;
  let transcript = "";
  let transcriptFinalized = false;
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
    transcriptFinalized = false;
    seenTranscripts = new Set();
  }

  function result(answer = null) {
    return { transcript, answer };
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

    handleServerContent(content) {
      if (!content) return result();

      if (content.interrupted && phase === "model") {
        candidateActivity = true;
        modelTurnInterrupted = true;
      }

      if (content.interimInputTranscription?.text?.trim()) {
        candidateActivity = true;
        candidateInterimActivity = true;
      }

      const input = content.inputTranscription;
      const text = input?.text?.trim();
      let answer = null;

      if (text && phase !== "submitted") {
        const key = transcriptKey(input, text);
        const hasOffsets =
          input.startOffset !== undefined || input.endOffset !== undefined;
        const duplicate = hasOffsets
          ? seenSessionTranscripts.has(key)
          : seenTranscripts.has(key);

        if (!duplicate) {
          candidateActivity = true;
          seenTranscripts.add(key);
          if (hasOffsets) seenSessionTranscripts.add(key);
          transcript = mergeTranscript(transcript, text);
          transcriptFinalized = input.finished !== false;
        }

        // A finalized input transcription marks the candidate's speech as
        // complete even if it arrives before the model turnComplete event.
        // The model turn still must complete before submitting, so an
        // assistant-only turn cannot become a candidate answer.
        if (
          input.finished !== false &&
          (phase === "model" || phase === "candidate")
        ) {
          candidateResponseComplete = true;
        } else if (
          input.finished !== false &&
          phase === "listening" &&
          !candidateInterimActivity
        ) {
          phase = "candidate";
          candidateResponseComplete = true;
        }
      }

      if (content.turnComplete && phase !== "submitted") {
        if (phase === "model") {
          if (modelTurnInterrupted || (candidateActivity && candidateResponseComplete)) {
            phase = "candidate";
            candidateResponseComplete = true;
          } else if (candidateActivity) {
            phase = "candidate";
          } else {
            phase = "listening";
          }
        } else if (candidateActivity) {
          phase = "candidate";
          candidateResponseComplete = true;
        }
      }

      if (
        candidateActivity &&
        candidateResponseComplete &&
        transcriptFinalized &&
        transcript &&
        phase !== "submitted" &&
        phase !== "model"
      ) {
        answer = transcript;
        phase = "submitted";
      }

      return result(answer);
    },
  };
}
