/**
 * Progressive AI Speech Captions Controller
 *
 * Synchronizes visible AI text captions with Gemini Live audio playback
 * using output transcription and Web Audio scheduled buffer timelines.
 */

import { isInternalSpeechMarker } from "./liveInputTurn.js";

/**
 * Sanitizes transcription text from Gemini Live by removing internal markers,
 * control tags (e.g. <no speech>, {pause}), and extraneous whitespace.
 */
export function sanitizeTranscriptionText(text) {
  if (typeof text !== "string" || !text) return "";
  if (isInternalSpeechMarker(text)) return "";

  return text
    .replace(/<\s*no\s+speech\s*>/gi, "")
    .replace(/\{\s*pause\s*\}/gi, "")
    .replace(/\[\s*system\s*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Creates a Progressive Captions Controller instance to manage progressive
 * caption reveal synchronized with Web Audio playback.
 */
export function createProgressiveCaptionsController() {
  let targetQuestionText = "";
  let accumulatedTranscription = "";
  let audioChunks = [];
  let earliestStartAt = Infinity;
  let latestEndAt = -Infinity;
  let isPlaybackCompleted = false;
  let isInterrupted = false;
  let lastRevealedText = "";

  function getCleanSourceText() {
    const cleanTarget = sanitizeTranscriptionText(targetQuestionText);
    if (cleanTarget) {
      return cleanTarget;
    }
    return sanitizeTranscriptionText(accumulatedTranscription);
  }

  return {
    beginTurn({ targetQuestionText: newTargetText = "" } = {}) {
      targetQuestionText = typeof newTargetText === "string" ? newTargetText : "";
      accumulatedTranscription = "";
      audioChunks = [];
      earliestStartAt = Infinity;
      latestEndAt = -Infinity;
      isPlaybackCompleted = false;
      isInterrupted = false;
      lastRevealedText = "";
    },

    appendTranscription(textChunk) {
      if (isInterrupted || typeof textChunk !== "string" || !textChunk) return lastRevealedText;
      const cleanChunk = sanitizeTranscriptionText(textChunk);
      if (!cleanChunk) return lastRevealedText;

      if (!accumulatedTranscription) {
        accumulatedTranscription = cleanChunk;
      } else if (!accumulatedTranscription.endsWith(cleanChunk)) {
        accumulatedTranscription = `${accumulatedTranscription} ${cleanChunk}`.replace(/\s+/g, " ");
      }
      return lastRevealedText;
    },

    registerAudioChunk({ startAt, duration, chunkSequence = null } = {}) {
      if (isInterrupted) return;
      if (typeof startAt !== "number" || typeof duration !== "number" || duration <= 0) return;

      const endAt = startAt + duration;
      audioChunks.push({ chunkSequence, startAt, duration, endAt });

      if (startAt < earliestStartAt) earliestStartAt = startAt;
      if (endAt > latestEndAt) latestEndAt = endAt;
    },

    updatePlaybackProgress(currentTime) {
      if (isPlaybackCompleted) {
        return getCleanSourceText();
      }
      if (isInterrupted) {
        return lastRevealedText;
      }

      const sourceText = getCleanSourceText();
      if (!sourceText) return "";

      if (typeof currentTime !== "number" || !Number.isFinite(earliestStartAt) || audioChunks.length === 0) {
        // If audio chunks have not arrived yet or timeline is uninitialized,
        // do not prematurely pop the full question on screen.
        return lastRevealedText;
      }

      if (currentTime < earliestStartAt) {
        return lastRevealedText;
      }

      const totalDuration = latestEndAt - earliestStartAt;
      if (totalDuration <= 0) {
        lastRevealedText = sourceText;
        return lastRevealedText;
      }

      const elapsed = Math.max(0, currentTime - earliestStartAt);
      const ratio = Math.min(1, Math.max(0, elapsed / totalDuration));

      if (ratio >= 0.98) {
        lastRevealedText = sourceText;
        return lastRevealedText;
      }

      const words = sourceText.split(" ");
      const totalWords = words.length;
      if (totalWords <= 1) {
        lastRevealedText = sourceText;
        return lastRevealedText;
      }

      // Proportional word reveal based on exact Web Audio playback position
      const wordsToReveal = Math.min(
        totalWords,
        Math.max(1, Math.ceil(ratio * totalWords)),
      );

      lastRevealedText = words.slice(0, wordsToReveal).join(" ");
      return lastRevealedText;
    },

    markPlaybackComplete() {
      isPlaybackCompleted = true;
      const fullText = getCleanSourceText();
      lastRevealedText = fullText;
      return fullText;
    },

    handleInterruption() {
      isInterrupted = true;
      // Freeze revealed text at current point
      return lastRevealedText;
    },

    handlePause() {
      // Retain current revealed progress while paused
      return lastRevealedText;
    },

    reset() {
      targetQuestionText = "";
      accumulatedTranscription = "";
      audioChunks = [];
      earliestStartAt = Infinity;
      latestEndAt = -Infinity;
      isPlaybackCompleted = false;
      isInterrupted = false;
      lastRevealedText = "";
    },

    getCaptionText() {
      if (isPlaybackCompleted) {
        return getCleanSourceText();
      }
      return lastRevealedText;
    },

    isCompleted() {
      return isPlaybackCompleted;
    },

    getSourceText() {
      return getCleanSourceText();
    },
  };
}

