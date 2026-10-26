import { useRef, useState } from "react";
import { updateTranscriptState } from "../utils/transcriptUtils";
import { connectGeminiLive } from "../services/geminiService";
import { API_URL } from "../config/geminiConfig";
import { toBase64, floatToPcm16, resample } from "../utils/audioUtils";
import { createLiveInputTurn } from "../utils/liveInputTurn";
import {
  createPlaybackQueue,
  pauseFor,
  waitForPlaybackAndPause,
} from "../utils/playbackCompletion";
import {
  classifyFinalizedInput,
  createRepeatHandoffGuard,
} from "../utils/repeatQuestionIntent";
import {
  buildClarificationPrompt,
  buildInitialQuestionPrompt,
  buildQuestionHandoffPrompt,
  buildRepeatPrompt,
} from "../utils/liveDialoguePrompt";
import {
  isCurrentLiveGeneration,
  isCurrentLiveSession,
} from "../utils/liveSessionLifecycle";
import {
  isLostInterviewSession,
  recoverMissingPrompt,
  resolvePromptHandoff,
} from "../utils/interviewResponse";

export function useGeminiLiveInterview() {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState("");
  const [interviewComplete, setInterviewComplete] = useState(false);
  const [interviewEnded, setInterviewEnded] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);

  const sessionRef = useRef(null);
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const micSourceRef = useRef(null);
  const processorRef = useRef(null);
  const micMuteGainRef = useRef(null);
  const outputAnalyserRef = useRef(null);
  const outputGainRef = useRef(null);
  const animationFrameRef = useRef(null);
  const playbackSourcesRef = useRef(new Set());
  const playbackQueueRef = useRef(createPlaybackQueue());
  const promptTurnRef = useRef(0);
  const audioChunkSequenceRef = useRef(0);
  const currentQuestionIdRef = useRef(null);
  const activePromptRef = useRef(null);
  const speakingStateRef = useRef(false);
  const lastAnalyserDiagnosticAtRef = useRef(0);
  const promptTimingRef = useRef(null);

  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const connectedRef = useRef(false);
  const outputTextRef = useRef("");
  const nextPlayTimeRef = useRef(0);
  const interviewSessionIdRef = useRef(null);
  const answerSubmittingRef = useRef(false);
  const answerRequestSequenceRef = useRef(0);
  const repeatRequestSequenceRef = useRef(0);
  const repeatHandoffGuardRef = useRef(createRepeatHandoffGuard());
  const inputTurnRef = useRef(createLiveInputTurn());
  const liveGenerationRef = useRef(0);

  function diagnostic(event, details = {}) {
    console.info("[UC Voice Diagnostics]", event, {
      clientTimeMs: Number(performance.now().toFixed(1)),
      promptTurn: promptTurnRef.current,
      sessionGeneration: liveGenerationRef.current,
      questionId: currentQuestionIdRef.current,
      ...details,
    });
  }

  function setSpeakingState(nextState, reason) {
    const previousState = speakingStateRef.current;
    speakingStateRef.current = nextState;
    setIsAiSpeaking(nextState);

    if (previousState !== nextState) {
      diagnostic("speaking_state", {
        from: previousState,
        to: nextState,
        reason,
        scheduledSources: playbackSourcesRef.current.size,
      });
    }
  }

  function promptElapsedMs(generation) {
    const timing = promptTimingRef.current;
    if (
      timing?.generation !== generation ||
      timing?.promptTurn !== promptTurnRef.current
    ) return null;
    return Number((performance.now() - timing.sentAt).toFixed(1));
  }

  async function repeatActivePrompt(generation, requestId, repeatRequest) {
    if (!repeatHandoffGuardRef.current.tryAcquire(generation)) return;
    const liveSession = sessionRef.current;

    try {
      if (!repeatRequest.prompt || !repeatRequest.questionId || !liveSession) {
        addMessage(
          "AI",
          "माफ़ कीजिए, मैं इस समय सवाल दोबारा नहीं पूछ पा रही हूँ।",
        );
        setStatus("सवाल दोबारा सुनाने में समस्या हुई");
        return;
      }

      diagnostic("repeat_prompt_playback_wait_started", {
        requestId,
        activeQuestionId: repeatRequest.questionId,
        scheduledSources: playbackSourcesRef.current.size,
      });
      const playbackWait = await waitForPlaybackAndPause({
        playbackQueue: playbackQueueRef.current,
        pause: pauseFor,
        isCurrent: () =>
          isCurrentLiveSession(
            liveSession,
            generation,
            sessionRef.current,
            liveGenerationRef.current,
          ) && !stoppingRef.current,
      });

      if (!playbackWait.ready) {
        diagnostic("repeat_prompt_handoff_skipped", {
          requestId,
          reason: "stale_session",
        });
        return;
      }

      currentQuestionIdRef.current = repeatRequest.questionId;
      promptTurnRef.current += 1;
      audioChunkSequenceRef.current = 0;
      const promptSentAt = performance.now();
      promptTimingRef.current = {
        generation,
        promptTurn: promptTurnRef.current,
        sentAt: promptSentAt,
      };
      diagnostic("repeat_prompt_handoff_started", {
        requestId,
        activeQuestionId: repeatRequest.questionId,
        promptChars: repeatRequest.prompt.length,
        clarificationRequired: repeatRequest.clarificationRequired,
      });

      inputTurnRef.current.beginModelTurn();
      liveSession.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [
              {
                text: buildRepeatPrompt(repeatRequest.prompt),
              },
            ],
          },
        ],
        turnComplete: true,
      });
      diagnostic("repeat_prompt_handoff_sent", {
        requestId,
        activeQuestionId: repeatRequest.questionId,
        sendCallElapsedMs: Number((performance.now() - promptSentAt).toFixed(1)),
      });
    } catch (err) {
      diagnostic("repeat_prompt_handoff_error", {
        requestId,
        errorName: err?.name || "Error",
      });
      addMessage(
        "AI",
        "माफ़ कीजिए, मैं इस समय सवाल दोबारा नहीं पूछ पा रही हूँ।",
      );
      setStatus("सवाल दोबारा सुनाने में समस्या हुई");
    } finally {
      repeatHandoffGuardRef.current.release(generation);
    }
  }

  async function submitCandidateAnswer(answer, requestId, transcriptFinalizedAt) {
    const generation = liveGenerationRef.current;
    const liveSession = sessionRef.current;
    const sessionId = interviewSessionIdRef.current;
    const normalizedAnswer = answer.trim();
    const expectedQuestionId = currentQuestionIdRef.current;

    if (
      !sessionId ||
      !liveSession ||
      !expectedQuestionId ||
      !normalizedAnswer ||
      answerSubmittingRef.current
    ) {
      return;
    }

    const requestStartedAt = performance.now();
    answerSubmittingRef.current = true;
    setStatus("Processing candidate answer...");
    let requestStage = "answer_request";
    diagnostic("answer_request_started", {
      requestId,
      sessionKey: sessionId.slice(-8),
      expectedQuestionId,
      answerChars: normalizedAnswer.length,
      answerFieldPresent: true,
      answerFieldType: "string",
      sessionGeneration: generation,
      msSinceTranscriptFinalized: Number(
        (requestStartedAt - transcriptFinalizedAt).toFixed(1),
      ),
    });

    try {
      const response = await fetch(`${API_URL}/api/interview/answer`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          answer: normalizedAnswer,
          expectedQuestionId,
          diagnosticRequestId: requestId,
          diagnosticPromptTurn: promptTurnRef.current,
          diagnosticSessionGeneration: generation,
        }),
      });

      requestStage = "answer_response_parse";
      const data = await response.json();

      if (
        !isCurrentLiveSession(
          liveSession,
          generation,
          sessionRef.current,
          liveGenerationRef.current,
        )
      ) {
        diagnostic("stale_answer_response_ignored", {
          requestId,
          sessionKey: sessionId.slice(-8),
          expectedQuestionId,
        });
        return;
      }

      if (isLostInterviewSession(response.status, data)) {
        diagnostic("backend_session_lost", {
          requestId,
          sessionKey: sessionId.slice(-8),
          expectedQuestionId,
          action: "restart_fresh_interview",
        });
        setStatus("Server restarted — restarting interview...");
        await stop("backend_session_lost");
        await start();
        return;
      }

      let promptHandoff = resolvePromptHandoff(response.status, data);
      const staleQuestionRecovery = Boolean(promptHandoff?.staleRecovery);

      if (response.status === 409 && data.staleQuestion) {
        diagnostic("stale_answer_response", {
          requestId,
          sessionKey: sessionId.slice(-8),
          expectedQuestionId,
          currentQuestionId: data.currentQuestionId || null,
          recoveryAvailable: staleQuestionRecovery,
        });
      }

      const responseType = staleQuestionRecovery
        ? "stale_question_recovery"
        : !response.ok || !data.success
        ? "error"
        : data.completed && data.manualReviewRequired
          ? "manual_review_terminal"
          : data.completed
            ? data.eligibilityOutcome === "reject"
              ? "rejected_terminal"
              : "completed_terminal"
            : data.clarificationRequired && data.followUpRequired
              ? "clarification_follow_up"
              : data.clarificationRequired
                ? "clarification"
                : data.followUpRequired
                  ? "follow_up"
                  : data.manualReviewRequired
                    ? "manual_review_continuing"
                    : data.question
                      ? "question_progression"
                      : "response_without_question";

      diagnostic("answer_response", {
        requestId,
        sessionKey: sessionId.slice(-8),
        expectedQuestionId,
        httpStatus: response.status,
        responseType,
        returnedQuestionId: data.question?.id || null,
        questionNumber: data.questionNumber ?? null,
        totalQuestions: data.totalQuestions ?? null,
        completed: Boolean(data.completed),
        clarificationRequired: Boolean(data.clarificationRequired),
        followUpRequired: Boolean(data.followUpRequired),
        manualReviewRequired: Boolean(data.manualReviewRequired),
        consentOutcome: data.consentOutcome || null,
        locationOutcome: data.locationOutcome || null,
        eligibilityOutcome: data.eligibilityOutcome || null,
        requestElapsedMs: Number((performance.now() - requestStartedAt).toFixed(1)),
        returnedPromptChars: (data.question?.text || data.message || "").length,
      });

      if ((!response.ok || !data.success) && !staleQuestionRecovery) {
        throw new Error(data.message || "Candidate answer submit nahi hua.");
      }

      // Backend says the interview has ended.
      if (data.completed) {
        diagnostic("interview_terminal", {
          responseType,
          sessionStatus: data.sessionStatus || null,
        });
        await stop("interview_terminal");
        setInterviewComplete(true);

        setStatus(
          data.manualReviewRequired
            ? "Manual review required"
            : data.eligibilityOutcome === "reject"
              ? "Interview ended"
              : "Interview completed",
        );
        return;
      }

      // A clarification can come from message or question.text.
      let nextPrompt = promptHandoff?.prompt;

      if (!nextPrompt) {
        if (data.manualReviewRequired) {
          diagnostic("manual_review_without_next_prompt", { responseType });
          await stop("manual_review_without_prompt");
          setStatus("Manual review required");
          return;
        }

        diagnostic("prompt_recovery_started", {
          requestId,
          expectedQuestionId,
          method: "single_empty_answer_state_reconciliation",
        });

        try {
          const recovery = await recoverMissingPrompt({
            fetchImpl: fetch,
            apiUrl: API_URL,
            sessionId,
            expectedQuestionId,
            requestId,
            promptTurn: promptTurnRef.current,
            sessionGeneration: generation,
          });

          if (
            !isCurrentLiveSession(
              liveSession,
              generation,
              sessionRef.current,
              liveGenerationRef.current,
            )
          ) {
            diagnostic("prompt_recovery_response_ignored", {
              requestId,
              reason: "obsolete_live_session",
            });
            return;
          }

          promptHandoff = recovery.promptHandoff;
          nextPrompt = promptHandoff?.prompt;
          diagnostic("prompt_recovery_response", {
            requestId,
            httpStatus: recovery.response.status,
            recovered: Boolean(nextPrompt),
            returnedQuestionId: promptHandoff?.questionId || null,
            promptChars: nextPrompt?.length || 0,
          });
        } catch (recoveryError) {
          diagnostic("prompt_recovery_error", {
            requestId,
            errorName: recoveryError?.name || "Error",
          });
        }

        if (!nextPrompt) {
          const waitMessage =
            "कृपया थोड़ा इंतज़ार कीजिए, मैं अगले सवाल के लिए तैयारी कर रही हूँ।";
          diagnostic("prompt_recovery_unavailable", {
            requestId,
            action: "hold_without_advancing",
          });
          addMessage("AI", waitMessage);
          setError(null);
          setStatus("अगले सवाल की तैयारी जारी है");
          return;
        }
      }

      requestStage = "playback_drain";
      diagnostic("response_playback_wait_started", {
        responseType,
        scheduledSources: playbackSourcesRef.current.size,
      });
      const playbackWait = await waitForPlaybackAndPause({
        playbackQueue: playbackQueueRef.current,
        pause: pauseFor,
        isCurrent: () =>
          isCurrentLiveSession(
            liveSession,
            generation,
            sessionRef.current,
            liveGenerationRef.current,
          ) && !stoppingRef.current,
      });
      diagnostic("response_playback_wait_finished", {
        responseType,
        playbackOutcome: playbackWait.playbackOutcome,
        readyForPrompt: playbackWait.ready,
      });
      if (!playbackWait.ready) return;

      if (
        !isCurrentLiveSession(
          liveSession,
          generation,
          sessionRef.current,
          liveGenerationRef.current,
        ) ||
        stoppingRef.current
      ) {
        diagnostic("prompt_handoff_skipped", {
          reason: stoppingRef.current ? "stopping" : "session_unavailable",
        });
        return;
      }

      setStatus("Asking next question...");
      if (promptHandoff.questionId) {
        currentQuestionIdRef.current = promptHandoff.questionId;
      }
      activePromptRef.current = {
        questionId: promptHandoff.questionId || currentQuestionIdRef.current,
        text: nextPrompt,
        clarificationRequired: promptHandoff.clarificationRequired,
      };
      promptTurnRef.current += 1;
      audioChunkSequenceRef.current = 0;
      requestStage = "live_prompt_send";
      const promptSentAt = performance.now();
      promptTimingRef.current = {
        generation,
        promptTurn: promptTurnRef.current,
        sentAt: promptSentAt,
      };
      diagnostic("prompt_handoff_started", {
        promptType: promptHandoff.clarificationRequired ? "clarification" : "question",
        responseType,
        promptChars: nextPrompt.length,
      });

      inputTurnRef.current.beginModelTurn();
      sessionRef.current.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [
              {
                text: promptHandoff.clarificationRequired
                  ? buildClarificationPrompt(nextPrompt)
                  : buildQuestionHandoffPrompt(nextPrompt),
              },
            ],
          },
        ],
        turnComplete: true,
      });
      diagnostic("prompt_handoff_sent", {
        promptType: promptHandoff.clarificationRequired ? "clarification" : "question",
        sendCallElapsedMs: Number((performance.now() - promptSentAt).toFixed(1)),
      });
    } catch (err) {
      diagnostic("answer_flow_error", {
        stage: requestStage,
        errorName: err?.name || "Error",
      });
      console.error("[Interview] Answer submission failed:", err?.name || "Error");
      setError(err.message || "Answer submit nahi ho paaya.");
      setStatus("Answer submission error");
    } finally {
      answerSubmittingRef.current = false;
    }
  }

  function addMessage(role, text, append = true) {
    if (!text?.trim()) return;

    setMessages((previous) =>
      updateTranscriptState(previous, role, append ? text : text),
    );
  }

  function monitorAudio() {
    const analyser = outputAnalyserRef.current;
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!outputAnalyserRef.current) return;

      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;
      const peak = data.reduce((maximum, value) => Math.max(maximum, value), 0);

      const now = Date.now();
      if (
        playbackSourcesRef.current.size > 0 &&
        now - lastAnalyserDiagnosticAtRef.current >= 1000
      ) {
        lastAnalyserDiagnosticAtRef.current = now;
        diagnostic("output_analyser_peak", {
          peakLevel: Number((peak / 255).toFixed(3)),
          scheduledSources: playbackSourcesRef.current.size,
          audioContextState: audioContextRef.current?.state || "unavailable",
        });
      }

      setAudioLevel(Math.min(1, average / 100));
      animationFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  }

  async function start() {
    if (startingRef.current || connectedRef.current) return;

    const generation = ++liveGenerationRef.current;
    setInterviewComplete(false);
    setInterviewEnded(false);

    let liveToken = "";
    const safeErrorMessage = (error, fallback) => {
      const message = error?.message || fallback;
      return liveToken ? message.replaceAll(liveToken, "[redacted]") : message;
    };

    startingRef.current = true;
    stoppingRef.current = false;
    setError("");
    setMessages([]);
    setStatus("Connecting to Gemini Live...");

    try {
      const tokenResponse = await fetch(`${API_URL}/api/voice/session`, {
        method: "POST",
        credentials: "include",
      });
      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.token) {
        throw new Error(tokenData.message || "Gemini Live token nahi mila.");
      }
      liveToken = tokenData.token;

      // Start the official Urban Company interview session
      const interviewResponse = await fetch(`${API_URL}/api/interview/start`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const interviewData = await interviewResponse.json();

      if (!interviewResponse.ok || !interviewData.success) {
        throw new Error(
          interviewData.message || "Interview session start nahi hua.",
        );
      }

      interviewSessionIdRef.current = interviewData.sessionId;
      currentQuestionIdRef.current = interviewData.question?.id || null;
      activePromptRef.current = interviewData.question?.text
        ? {
            questionId: interviewData.question.id || null,
            text: interviewData.question.text,
            clarificationRequired: false,
          }
        : null;
      promptTurnRef.current = 0;
      audioChunkSequenceRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (
        stoppingRef.current ||
        !isCurrentLiveGeneration(generation, liveGenerationRef.current)
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      micStreamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      audioContext.addEventListener("statechange", () => {
        diagnostic("audio_context_state", {
          state: audioContext.state,
          currentTimeSeconds: Number(audioContext.currentTime.toFixed(3)),
          sampleRate: audioContext.sampleRate,
          scheduledSources: playbackSourcesRef.current.size,
        });
        if (audioContext.state === "closed") {
          playbackQueueRef.current.cancelAll("audio_context_closed");
        }
      });
      await audioContext.resume();

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      outputAnalyserRef.current = analyser;

      const outputGain = audioContext.createGain();
      outputGain.gain.value = 1;
      outputGainRef.current = outputGain;

      analyser.connect(outputGain);
      outputGain.connect(audioContext.destination);

      // Mic processor ko active rakhein, lekin mic ko speakers par na bajayein.
      const micMuteGain = audioContext.createGain();
      micMuteGain.gain.value = 0;
      micMuteGainRef.current = micMuteGain;
      micMuteGain.connect(audioContext.destination);

      const session = await connectGeminiLive(tokenData.token, {
        onopen: () => {
          if (
            stoppingRef.current ||
            !isCurrentLiveGeneration(generation, liveGenerationRef.current)
          ) return;
          connectedRef.current = true;
          setStatus("Connected — you can speak");
        },

        onmessage: (message) => {
          if (
            stoppingRef.current ||
            !isCurrentLiveGeneration(generation, liveGenerationRef.current)
          ) return;

          const content = message.serverContent;
          if (!content) return;

          const inputTurn = inputTurnRef.current.handleServerContent(content);

          if (inputTurn.transcript) {
            setMessages((previous) =>
              updateTranscriptState(previous, "Candidate", inputTurn.transcript),
            );
          }

          // AI transcript
          const spokenText = content.outputTranscription?.text?.trim();

          if (spokenText) {
            const current = outputTextRef.current;

            if (!current) {
              outputTextRef.current = spokenText;
            } else if (spokenText.startsWith(current)) {
              outputTextRef.current = spokenText;
            } else if (!current.startsWith(spokenText)) {
              outputTextRef.current = `${current} ${spokenText}`.trim();
            }

            setMessages((previous) =>
              updateTranscriptState(previous, "AI", outputTextRef.current),
            );
          }

          // Play audio chunks in order at 24 kHz.
          const context = audioContextRef.current;

          if (content.interrupted) {
            diagnostic("playback_interrupted", {
              scheduledSources: playbackSourcesRef.current.size,
              queueMsRemaining: context
                ? Math.max(0, (nextPlayTimeRef.current - context.currentTime) * 1000)
                : null,
            });
            for (const source of playbackSourcesRef.current) {
              try {
                source.stop();
              } catch {
                // Source may already have stopped.
              }
            }
            playbackSourcesRef.current.clear();
            playbackQueueRef.current.cancelAll("interrupted");
            nextPlayTimeRef.current = context?.currentTime || 0;
            setSpeakingState(false, "interrupted");
          }

          const parts = content.modelTurn?.parts || [];

          for (const part of parts) {
            const audio = part.inlineData;
            const chunkSequence = audio ? ++audioChunkSequenceRef.current : null;

            if (audio) {
              const padding = audio.data?.endsWith("==") ? 2 : audio.data?.endsWith("=") ? 1 : 0;
              diagnostic("audio_chunk_received", {
                chunkSequence,
                mimeType: audio.mimeType || null,
                encodedBytes: audio.data
                  ? Math.max(0, Math.floor((audio.data.length * 3) / 4) - padding)
                  : 0,
                audioContextState: context?.state || "unavailable",
                audioContextSampleRate: context?.sampleRate || null,
                receivedAtContextSeconds: context
                  ? Number(context.currentTime.toFixed(3))
                  : null,
                msSincePromptSent: promptElapsedMs(generation),
              });

            }

            if (!context || !audio?.data || !audio.mimeType?.startsWith("audio/pcm")) {
              if (audio) {
                diagnostic("audio_chunk_skipped", {
                  reason: !context
                    ? "audio_context_unavailable"
                    : !audio.data
                      ? "audio_data_missing"
                      : "unsupported_mime_type",
                });
              }
              continue;
            }

            let binary;
            let pcm;
            try {
              binary = atob(audio.data);
              pcm = new Int16Array(binary.length / 2);

              for (let i = 0; i < pcm.length; i++) {
                let value =
                  binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);

                if (value >= 32768) value -= 65536;
                pcm[i] = value;
              }
            } catch (err) {
              diagnostic("audio_decode_error", {
                errorName: err?.name || "Error",
                encodedBytes: Math.floor((audio.data.length * 3) / 4),
              });
              throw err;
            }

            diagnostic("audio_chunk_decoded", {
              chunkSequence,
              decodedBytes: binary.length,
              samples: pcm.length,
              audioContextSampleRate: context.sampleRate,
            });

            let buffer;
            try {
              buffer = context.createBuffer(1, pcm.length, 24000);
              const channel = buffer.getChannelData(0);

              for (let i = 0; i < pcm.length; i++) {
                channel[i] = pcm[i] / 32768;
              }
            } catch (err) {
              diagnostic("audio_buffer_creation_error", {
                errorName: err?.name || "Error",
                samples: pcm.length,
                audioContextState: context.state,
                audioContextSampleRate: context.sampleRate,
              });
              throw err;
            }

            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(outputAnalyserRef.current);
            playbackSourcesRef.current.add(source);

            const startAt = Math.max(
              context.currentTime,
              nextPlayTimeRef.current,
            );

            const queueMsBefore = Math.max(0, (startAt - context.currentTime) * 1000);
            const scheduleGapMs = Math.max(
              0,
              (context.currentTime - nextPlayTimeRef.current) * 1000,
            );
            setSpeakingState(true, "audio_scheduled");
            try {
              source.start(startAt);
              playbackQueueRef.current.sourceStarted(source);
            } catch (err) {
              playbackSourcesRef.current.delete(source);
              diagnostic("audio_schedule_error", {
                errorName: err?.name || "Error",
                scheduledSources: playbackSourcesRef.current.size,
                audioContextState: context.state,
              });
              throw err;
            }
            nextPlayTimeRef.current = startAt + buffer.duration;
            diagnostic("audio_scheduled", {
              chunkSequence,
              mimeType: audio.mimeType,
              decodedBytes: binary.length,
              scheduledSources: playbackSourcesRef.current.size,
              audioContextSampleRate: context.sampleRate,
              startAtSeconds: Number(startAt.toFixed(3)),
              durationMs: Number((buffer.duration * 1000).toFixed(1)),
              queueMsBefore: Number(queueMsBefore.toFixed(1)),
              scheduleGapMs: Number(scheduleGapMs.toFixed(1)),
              queueEndSeconds: Number(nextPlayTimeRef.current.toFixed(3)),
              audioContextState: context.state,
              msSincePromptSent: promptElapsedMs(generation),
            });

            source.onended = () => {
              playbackSourcesRef.current.delete(source);
              playbackQueueRef.current.sourceEnded(source);
              diagnostic("audio_playback_ended", {
                chunkSequence,
                scheduledSources: playbackSourcesRef.current.size,
                audioContextState: context.state,
                contextTimeSeconds: Number(context.currentTime.toFixed(3)),
                queueMsRemaining: Number(
                  Math.max(0, (nextPlayTimeRef.current - context.currentTime) * 1000).toFixed(1),
                ),
                msSincePromptSent: promptElapsedMs(generation),
              });
              if (
                audioContextRef.current === context &&
                playbackSourcesRef.current.size === 0
              ) {
                setSpeakingState(false, "audio_queue_ended");
              }
            };
          }

          if (content.turnComplete) {
            outputTextRef.current = "";
            diagnostic("live_turn_complete", {
              hasOutputTranscription: Boolean(content.outputTranscription?.text),
              modelParts: parts.length,
              audioParts: parts.filter((part) => Boolean(part.inlineData)).length,
              scheduledSources: playbackSourcesRef.current.size,
              audioContextState: context?.state || "unavailable",
              queueMsRemaining: context
                ? Number(Math.max(0, (nextPlayTimeRef.current - context.currentTime) * 1000).toFixed(1))
                : null,
              speakingState: speakingStateRef.current,
              msSincePromptSent: promptElapsedMs(generation),
            });
            if (playbackSourcesRef.current.size === 0) {
              setSpeakingState(false, "turn_complete");
            }

            if (!inputTurn.answer && !answerSubmittingRef.current) {
              setStatus("Connected — you can speak");
            }
          }

          if (inputTurn.answer) {
            const finalizedInput = classifyFinalizedInput(
              inputTurn.answer,
              activePromptRef.current,
            );
            if (finalizedInput.type === "repeat_question") {
              const repeatRequest = finalizedInput.repeatRequest;
              const requestId = `p${promptTurnRef.current}-r${++repeatRequestSequenceRef.current}`;
              diagnostic("repeat_question_request_finalized", {
                requestId,
                transcriptChars: inputTurn.answer.length,
                activeQuestionId: repeatRequest.questionId,
                activePromptAvailable: Boolean(repeatRequest.prompt),
                answerSubmissionSkipped: true,
              });
              void repeatActivePrompt(generation, requestId, repeatRequest);
              return;
            }

            const answer = finalizedInput.answer;
            const requestId = `p${promptTurnRef.current}-a${++answerRequestSequenceRef.current}`;
            const transcriptFinalizedAt = performance.now();
            diagnostic("candidate_answer_finalized", {
              requestId,
              transcriptFieldPresent: true,
              transcriptChars: answer.length,
              transcriptFinalized: true,
              expectedQuestionId: currentQuestionIdRef.current,
            });
            void submitCandidateAnswer(
              answer,
              requestId,
              transcriptFinalizedAt,
            );
          }
        },

        onerror: (event) => {
          if (
            stoppingRef.current ||
            !isCurrentLiveGeneration(generation, liveGenerationRef.current)
          ) return;
          diagnostic("live_connection_error", {
            errorName: event?.name || "Error",
          });
          const messageText = safeErrorMessage(
            event,
            "Gemini Live connection error.",
          );
          console.error("[Gemini Live] Error:", messageText);
          setError(messageText);
          setStatus("Connection error");
        },

        onclose: () => {
          if (
            stoppingRef.current ||
            !isCurrentLiveGeneration(generation, liveGenerationRef.current)
          ) return;
          connectedRef.current = false;
          diagnostic("live_connection_closed", {
            scheduledSources: playbackSourcesRef.current.size,
          });
          setSpeakingState(false, "connection_closed");
          setStatus("Disconnected");
        },
      });

      if (stoppingRef.current) {
        session.close();
        return;
      }

      if (!isCurrentLiveGeneration(generation, liveGenerationRef.current)) {
        session.close();
        return;
      }

      sessionRef.current = session;

      const micSource = audioContext.createMediaStreamSource(stream);
      micSourceRef.current = micSource;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (
          !connectedRef.current ||
          !sessionRef.current ||
          stoppingRef.current
        ) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        const downsampled = resample(input, audioContext.sampleRate, 16000);
        const pcm = floatToPcm16(downsampled);

        try {
          sessionRef.current.sendRealtimeInput({
            audio: {
              data: toBase64(
                new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
              ),
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch (err) {
          console.error(
            "[Gemini Live] Mic send failed:",
            safeErrorMessage(err, "Microphone audio could not be sent."),
          );
        }
      };

      micSource.connect(processor);
      processor.connect(micMuteGain);

      monitorAudio();

      inputTurnRef.current.beginModelTurn();
      promptTurnRef.current += 1;
      audioChunkSequenceRef.current = 0;
      const initialPromptSentAt = performance.now();
      promptTimingRef.current = {
        generation,
        promptTurn: promptTurnRef.current,
        sentAt: initialPromptSentAt,
      };
      diagnostic("prompt_handoff_started", {
        promptType: "initial_question",
        promptChars: interviewData.question.text.length,
      });
      try {
        session.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [
              {
                text: buildInitialQuestionPrompt(interviewData.question.text),
              },
            ],
          },
        ],
        turnComplete: true,
        });
        diagnostic("prompt_handoff_sent", {
          promptType: "initial_question",
          sendCallElapsedMs: Number((performance.now() - initialPromptSentAt).toFixed(1)),
        });
      } catch (err) {
        diagnostic("prompt_handoff_error", {
          errorName: err?.name || "Error",
        });
        throw err;
      }

      setStatus("Connected — starting conversation");
    } catch (err) {
      if (!isCurrentLiveGeneration(generation, liveGenerationRef.current)) {
        return;
      }
      const messageText = safeErrorMessage(
        err,
        "Voice connection start nahi ho paaya.",
      );
      console.error("[Gemini Live] Start failed:", messageText);
      setError(messageText);
      setStatus("Unable to connect");
      await stop("start_failure");
    } finally {
      startingRef.current = false;
    }
  }

  async function stop(reason = "user_requested") {
    liveGenerationRef.current += 1;
    stoppingRef.current = true;
    connectedRef.current = false;
    const safeReason = typeof reason === "string" ? reason : "user_requested";
    const sessionIdToFinalize = interviewSessionIdRef.current;
    const shouldFinalizeSession = safeReason === "user_requested" && Boolean(sessionIdToFinalize);

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Source may already have stopped.
      }
    }
    playbackQueueRef.current.cancelAll("session_stopped");
    diagnostic("playback_cleanup", {
      reason: safeReason,
      sourcesStopped: playbackSourcesRef.current.size,
    });
    playbackSourcesRef.current.clear();

    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      try {
        processorRef.current.disconnect();
      } catch {}
    }

    try {
      micSourceRef.current?.disconnect();
      outputAnalyserRef.current?.disconnect();
      outputGainRef.current?.disconnect();
      micMuteGainRef.current?.disconnect();
      sessionRef.current?.close();

      micStreamRef.current?.getTracks().forEach((track) => track.stop());

      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        await audioContextRef.current.close();
      }
    } catch (err) {
      console.warn("[Cleanup] Warning:", err);
    }

    sessionRef.current = null;
    audioContextRef.current = null;
    micStreamRef.current = null;
    micSourceRef.current = null;
    processorRef.current = null;
    micMuteGainRef.current = null;
    outputAnalyserRef.current = null;
    outputGainRef.current = null;
    nextPlayTimeRef.current = 0;
    outputTextRef.current = "";
    inputTurnRef.current.reset();

    setAudioLevel(0);
    setSpeakingState(false, "stop_cleanup");
    if (shouldFinalizeSession) {
      try {
        const response = await fetch(`${API_URL}/api/interview/end`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdToFinalize }),
        });
        const data = await response.json();
        diagnostic("interview_end_response", {
          requestOk: response.ok && Boolean(data?.success),
          sessionStatus: data?.sessionStatus || null,
        });
        setInterviewEnded(true);
      } catch (endError) {
        diagnostic("interview_end_request_failed", {
          errorName: endError?.name || "Error",
        });
        // Local interview termination still completes; the dashboard will
        // show the session as active if the backend could not be reached.
        setInterviewEnded(true);
      }
      setStatus("Interview ended");
    } else {
      setStatus("Disconnected");
    }
    stoppingRef.current = false;
  }

  return {
    messages,
    status,
    error,
    interviewComplete,
    interviewEnded,
    audioLevel,
    isAiSpeaking,
    startingRef,
    start,
    stop,
  };
}
