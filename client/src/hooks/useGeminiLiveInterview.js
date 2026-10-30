import { useEffect, useRef, useState } from "react";
import { connectGeminiLive } from "../services/geminiService";
import { API_URL, BACKEND_WAIT_ANNOUNCEMENT_MS } from "../config/geminiConfig";
import { toBase64, floatToPcm16, resample } from "../utils/audioUtils";
import { createLiveInputTurn, isInternalSpeechMarker } from "../utils/liveInputTurn";
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
  buildIdentityWarningPrompt,
  buildInitialQuestionPrompt,
  buildInvalidWarningPrompt,
  buildNameConfirmationPrompt,
  buildQuestionHandoffPrompt,
  buildRepeatPrompt,
  buildTerminationPrompt,
  buildWaitingAnnouncementPrompt,
} from "../utils/liveDialoguePrompt";
import { speakTextFallback } from "../utils/speechFallback";
import {
  isCurrentLiveGeneration,
  isCurrentLiveSession,
} from "../utils/liveSessionLifecycle";
import {
  isLostInterviewSession,
  recoverMissingPrompt,
  resolvePromptHandoff,
} from "../utils/interviewResponse";
import { resolveTerminalInterviewState } from "../utils/interviewUiState.js";
import { createRequestWaitAnnouncement, WAIT_ANNOUNCEMENT_TEXT } from "../utils/requestWaitAnnouncement.js";
import { createAbortableRequest } from "../utils/requestAbort.js";
import { createProgressiveCaptionsController } from "../utils/progressiveCaptions.js";

const ANSWER_SETTLE_MS = 1000;
const NO_SPEECH_TIMEOUT_MS = 15000;
const WAIT_SPEECH_TIMEOUT_MS = 10000;
const ANSWER_REQUEST_TIMEOUT_MS = 45000;

export function useGeminiLiveInterview() {
  const [error, setError] = useState("");
  const [interviewLifecycle, setInterviewLifecycle] = useState("ready");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [captionText, setCaptionText] = useState("");
  const [isProcessingAnswer, setIsProcessingAnswer] = useState(false);
  const [isPreparingResponse, setIsPreparingResponse] = useState(false);
  const [isWaitingForBackend, setIsWaitingForBackend] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isInterviewActive, setIsInterviewActive] = useState(false);
  const [isInterviewOpen, setIsInterviewOpen] = useState(false);
  const [candidateName, setCandidateName] = useState("");
  const [currentQuestionId, setCurrentQuestionId] = useState(null);
  const [savedActiveSession, setSavedActiveSession] = useState(null);
  const [isCheckingActiveSession, setIsCheckingActiveSession] = useState(true);

  const captionsControllerRef = useRef(createProgressiveCaptionsController());
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
  const nextPlayTimeRef = useRef(0);
  const interviewSessionIdRef = useRef(null);
  const answerSubmittingRef = useRef(false);
  const answerRequestSequenceRef = useRef(0);
  const repeatRequestSequenceRef = useRef(0);
  const repeatHandoffGuardRef = useRef(createRepeatHandoffGuard());
  const inputTurnRef = useRef(createLiveInputTurn());
  const liveGenerationRef = useRef(0);
  const answerSettleTimerRef = useRef(null);
  const pendingAnswerRunnerRef = useRef(null);
  const noSpeechTimerRef = useRef(null);
  const preparingResponseTimerRef = useRef(null);
  const isPreparingResponseRef = useRef(false);
  const pendingWaitAnnouncementRef = useRef(null);
  const answerRequestRef = useRef(null);
  const candidateSpeechSinceSubmitRef = useRef(false);
  const suppressWaitingSpeechRef = useRef(false);
  const authorizedModelTurnRef = useRef(false);
  const audioChunksReceivedForTurnRef = useRef(0);
  const candidateLanguageRef = useRef("Hindi");
  const missingAudioRetryCountRef = useRef(0);
  const ttsCancelRef = useRef(null);
  const currentRequestIdRef = useRef(null);
  const turnMetricsRef = useRef({
    speechEndedAt: null,
    settleStartedAt: null,
    settleEndedAt: null,
    backendRequestStartedAt: null,
    backendResponseReceivedAt: null,
    backendServiceElapsedMs: null,
    llmInterpretationMs: null,
    modelCallElapsedMs: null,
    promptHandoffSentAt: null,
    firstAudioChunkReceivedAt: null,
    firstPlaybackStartedAt: null,
    playbackFinishedAt: null,
    candidateListeningEnabledAt: null,
  });
  const mountedRef = useRef(true);

  function cancelPendingWaitAnnouncement(reason = "cancelled", stopAudio = false) {
    const pending = pendingWaitAnnouncementRef.current;
    if (!pending) return;
    pending.coordinator.cancel(reason);
    if (stopAudio) {
      for (const source of pending.sources) {
        try { source.stop(); } catch { /* Audio may already have ended. */ }
        playbackSourcesRef.current.delete(source);
      }
      if (pending.sources.size) {
        playbackQueueRef.current.cancelAll(reason);
        playbackSourcesRef.current.clear();
        pending.sources.clear();
        nextPlayTimeRef.current = audioContextRef.current?.currentTime || 0;
      }
      authorizedModelTurnRef.current = false;
      suppressWaitingSpeechRef.current = true;
    }
    pendingWaitAnnouncementRef.current = null;
    if (mountedRef.current) setIsWaitingForBackend(false);
  }

  useEffect(() => {
    mountedRef.current = true;
    setIsCheckingActiveSession(false);
    return () => {
      mountedRef.current = false;
      liveGenerationRef.current += 1;
      stoppingRef.current = true;
      connectedRef.current = false;
      if (answerSettleTimerRef.current) clearTimeout(answerSettleTimerRef.current);
      if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
      if (preparingResponseTimerRef.current) clearTimeout(preparingResponseTimerRef.current);
      answerSettleTimerRef.current = null;
      noSpeechTimerRef.current = null;
      preparingResponseTimerRef.current = null;
      if (ttsCancelRef.current) {
        ttsCancelRef.current();
        ttsCancelRef.current = null;
      }
      const pending = pendingWaitAnnouncementRef.current;
      if (pending) pending.coordinator.cancel("component_unmounted", { notify: false });
      pendingWaitAnnouncementRef.current = null;
      for (const source of playbackSourcesRef.current) {
        try { source.stop(); } catch { /* Audio may already have ended. */ }
      }
      playbackQueueRef.current.cancelAll("component_unmounted");
      playbackSourcesRef.current.clear();
      sessionRef.current?.close();
      sessionRef.current = null;
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        void audioContextRef.current.close();
      }
    };
  }, []);

  function clearAnswerSettleTimer() {
    if (answerSettleTimerRef.current) clearTimeout(answerSettleTimerRef.current);
    answerSettleTimerRef.current = null;
    pendingAnswerRunnerRef.current = null;
  }

  function clearNoSpeechTimer() {
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
    noSpeechTimerRef.current = null;
  }

  function clearPreparingResponseTimer() {
    if (preparingResponseTimerRef.current) clearTimeout(preparingResponseTimerRef.current);
    preparingResponseTimerRef.current = null;
    isPreparingResponseRef.current = false;
  }

  function setPreparingResponse(active) {
    clearPreparingResponseTimer();
    isPreparingResponseRef.current = Boolean(active);
    setIsPreparingResponse(active);
    if (active) {
      preparingResponseTimerRef.current = setTimeout(() => {
        preparingResponseTimerRef.current = null;
        isPreparingResponseRef.current = false;
        if (mountedRef.current && !stoppingRef.current) {
          diagnostic("preparing_response_ui_fallback_fired", {
            timeoutMs: 8000,
            activeQuestionId: currentQuestionIdRef.current,
          });
          setIsPreparingResponse(false);
        }
      }, 8000);
    }
  }

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

    if (previousState && !nextState) {
      turnMetricsRef.current.candidateListeningEnabledAt = performance.now();
    }

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
        setError("Sorry, I couldn't repeat the question. Please try again or continue with your answer.");
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
      turnMetricsRef.current.promptHandoffSentAt = promptSentAt;
      turnMetricsRef.current.firstAudioChunkReceivedAt = null;
      turnMetricsRef.current.firstPlaybackStartedAt = null;
      turnMetricsRef.current.playbackFinishedAt = null;
      if (audioContextRef.current && audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume().catch(() => { });
      }
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

      setCurrentQuestion(repeatRequest.prompt);
      setCaptionText("");
      captionsControllerRef.current.beginTurn({ targetQuestionText: repeatRequest.prompt });

      inputTurnRef.current.beginModelTurn();
      authorizedModelTurnRef.current = true;
      audioChunksReceivedForTurnRef.current = 0;
      const isIdentity = Boolean(
        repeatRequest.identityMismatchWarning ||
        (repeatRequest.questionId === "A2_NAME" && repeatRequest.warningLevel)
      );
      const promptText = isIdentity
        ? buildIdentityWarningPrompt(repeatRequest.prompt, candidateLanguageRef.current)
        : repeatRequest.isMissingAudioRetry
          ? (repeatRequest.warningLevel
            ? buildInvalidWarningPrompt(repeatRequest.prompt, repeatRequest.warningLevel)
            : repeatRequest.clarificationRequired
              ? buildClarificationPrompt(repeatRequest.prompt)
              : buildQuestionHandoffPrompt(repeatRequest.prompt, null, candidateLanguageRef.current))
          : buildRepeatPrompt(repeatRequest.prompt);

      liveSession.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [
              {
                text: promptText,
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
      if (mountedRef.current && isCurrentLiveGeneration(generation, liveGenerationRef.current)) {
        setError("Sorry, I couldn't repeat the question. Please try again or continue with your answer.");
      }
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
    currentRequestIdRef.current = requestId;
    turnMetricsRef.current.backendRequestStartedAt = requestStartedAt;
    const answerRequest = createAbortableRequest(ANSWER_REQUEST_TIMEOUT_MS);
    answerRequestRef.current = answerRequest;
    answerSubmittingRef.current = true;
    setIsProcessingAnswer(true);
    setPreparingResponse(false);
    candidateSpeechSinceSubmitRef.current = false;
    const waitAnnouncement = createRequestWaitAnnouncement({
      delayMs: BACKEND_WAIT_ANNOUNCEMENT_MS,
      onWaitingChange: (value) => {
        if (mountedRef.current) setIsWaitingForBackend(value);
      },
      onAnnounce: () => {
        if (
          candidateSpeechSinceSubmitRef.current ||
          stoppingRef.current ||
          !isCurrentLiveSession(liveSession, generation, sessionRef.current, liveGenerationRef.current)
        ) return false;
        suppressWaitingSpeechRef.current = false;
        authorizedModelTurnRef.current = true;
        audioChunksReceivedForTurnRef.current = 0;
        liveSession.sendClientContent({
          turns: [{
            role: "user",
            parts: [{
              text: buildWaitingAnnouncementPrompt(WAIT_ANNOUNCEMENT_TEXT),
            }],
          }],
          turnComplete: true,
        });
        diagnostic("backend_wait_announcement_sent", { requestId });
        return true;
      },
    });
    pendingWaitAnnouncementRef.current = {
      requestId,
      coordinator: waitAnnouncement,
      sources: new Set(),
    };
    waitAnnouncement.start();
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
        signal: answerRequest.signal,
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
      turnMetricsRef.current.backendResponseReceivedAt = performance.now();
      turnMetricsRef.current.backendServiceElapsedMs = data.timing?.serviceElapsedMs || null;
      turnMetricsRef.current.llmInterpretationMs = data.timing?.interpretationElapsedMs || null;
      turnMetricsRef.current.modelCallElapsedMs = data.timing?.modelCallElapsedMs || null;

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

      const pendingAnnouncement = pendingWaitAnnouncementRef.current;
      if (pendingAnnouncement?.requestId === requestId) {
        const wasAnnounced = pendingAnnouncement.coordinator.resolveRequest();
        if (wasAnnounced) {
          const speechResult = await pendingAnnouncement.coordinator.waitForSpeech(WAIT_SPEECH_TIMEOUT_MS);
          if (speechResult === "speech_timeout") {
            diagnostic("backend_wait_announcement_timeout", { requestId });
            cancelPendingWaitAnnouncement("speech_timeout", true);
          }
        }
        if (pendingWaitAnnouncementRef.current === pendingAnnouncement) {
          pendingWaitAnnouncementRef.current = null;
        }
        setIsWaitingForBackend(false);
      }

      if (isLostInterviewSession(response.status, data)) {
        diagnostic("backend_session_lost", {
          requestId,
          sessionKey: sessionId.slice(-8),
          expectedQuestionId,
          action: "restart_fresh_interview",
        });
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
        const isTerminated = Boolean(data.terminated || data.sessionStatus === "terminated");
        const terminalState = resolveTerminalInterviewState({
          completed: true,
          sessionStatus: data.sessionStatus,
          manualReviewRequired: data.manualReviewRequired,
          eligibilityOutcome: data.eligibilityOutcome,
          terminated: isTerminated,
        });

        if (
          isTerminated &&
          data.message &&
          connectedRef.current &&
          sessionRef.current &&
          !stoppingRef.current
        ) {
          try {
            setCurrentQuestion(data.message);
            inputTurnRef.current.beginModelTurn();
            suppressWaitingSpeechRef.current = false;
            authorizedModelTurnRef.current = true;
            audioChunksReceivedForTurnRef.current = 0;
            sessionRef.current.sendClientContent({
              turns: [
                {
                  role: "user",
                  parts: [
                    {
                      text: buildTerminationPrompt(data.message),
                    },
                  ],
                },
              ],
              turnComplete: true,
            });
            await waitForPlaybackAndPause({
              playbackQueue: playbackQueueRef.current,
              pause: pauseFor,
              drainTimeoutMs: 15000,
              isCurrent: () =>
                isCurrentLiveSession(
                  liveSession,
                  generation,
                  sessionRef.current,
                  liveGenerationRef.current,
                ) && !stoppingRef.current,
            });
          } catch (e) {
            console.warn("[Gemini Live] Termination speech failed:", e);
          }
        }

        setSavedActiveSession(null);
        interviewSessionIdRef.current = null;
        currentQuestionIdRef.current = null;
        setCurrentQuestionId(null);
        setInterviewLifecycle(terminalState);
        setIsProcessingAnswer(false);
        setPreparingResponse(false);
        await stop("interview_terminal");

        return;
      }

      // A clarification can come from message or question.text.
      let nextPrompt = promptHandoff?.prompt;

      if (!nextPrompt) {
        if (data.manualReviewRequired) {
          diagnostic("manual_review_without_next_prompt", { responseType });
          setInterviewLifecycle("manual_review");
          setIsProcessingAnswer(false);
          setPreparingResponse(false);
          await stop("manual_review_without_prompt");
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
          diagnostic("prompt_recovery_unavailable", {
            requestId,
            action: "hold_without_advancing",
          });
          setIsProcessingAnswer(false);
          setPreparingResponse(false);
          setError("Sorry, I couldn't prepare the next question. Please ask me to repeat it or try your answer again.");
          return;
        }
      }

      setIsProcessingAnswer(false);
      setPreparingResponse(true);

      requestStage = "playback_drain";
      diagnostic("response_playback_wait_started", {
        responseType,
        scheduledSources: playbackSourcesRef.current.size,
      });
      const playbackWait = await waitForPlaybackAndPause({
        playbackQueue: playbackQueueRef.current,
        pause: pauseFor,
        drainTimeoutMs: Math.min(
          30000,
          Math.max(
            12000,
            ((audioContextRef.current && nextPlayTimeRef.current > audioContextRef.current.currentTime)
              ? (nextPlayTimeRef.current - audioContextRef.current.currentTime) * 1000
              : 0) + 5000,
          ),
        ),
        onDrainTimeout: () => {
          const context = audioContextRef.current;
          for (const source of playbackSourcesRef.current) {
            try { source.stop(); } catch { /* The source may already have ended. */ }
          }
          playbackSourcesRef.current.clear();
          pendingWaitAnnouncementRef.current?.sources.clear();
          nextPlayTimeRef.current = context?.currentTime || 0;
          setSpeakingState(false, "playback_stalled");
          setError("I couldn't play the question. Please ask me to repeat it before answering.");
          diagnostic("playback_drain_recovered", { requestId, responseType });
        },
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
      if (!playbackWait.ready) {
        setPreparingResponse(false);
        return;
      }

      if (playbackWait.playbackOutcome === "playback_stalled") {
        diagnostic("prompt_handoff_blocked", {
          requestId,
          responseType,
          reason: "previous_audio_playback_stalled",
        });

        setPreparingResponse(false);
        setIsProcessingAnswer(false);
        setError("I couldn't play the question. Please click Repeat Question to hear it again.");
        return;
      }

      if (
        !isCurrentLiveSession(
          liveSession,
          generation,
          sessionRef.current,
          liveGenerationRef.current,
        ) ||
        stoppingRef.current
      ) {
        setPreparingResponse(false);
        diagnostic("prompt_handoff_skipped", {
          reason: stoppingRef.current ? "stopping" : "session_unavailable",
        });
        return;
      }

      if (promptHandoff.questionId) {
        currentQuestionIdRef.current = promptHandoff.questionId;
        setCurrentQuestionId(promptHandoff.questionId);
      }
      if (data.candidateName) {
        setCandidateName(data.candidateName);
      }
      const isIdentityWarning = Boolean(
        promptHandoff.identityMismatchWarning ||
        (promptHandoff.questionId === "A2_NAME" && promptHandoff.warningLevel)
      );
      activePromptRef.current = {
        questionId: promptHandoff.questionId || currentQuestionIdRef.current,
        text: nextPrompt,
        clarificationRequired: promptHandoff.clarificationRequired,
        identityMismatchWarning: isIdentityWarning,
        warningLevel: promptHandoff.warningLevel || null,
      };
      promptTurnRef.current += 1;
      audioChunkSequenceRef.current = 0;
      requestStage = "live_prompt_send";
      const promptSentAt = performance.now();
      turnMetricsRef.current.promptHandoffSentAt = promptSentAt;
      turnMetricsRef.current.firstAudioChunkReceivedAt = null;
      turnMetricsRef.current.firstPlaybackStartedAt = null;
      turnMetricsRef.current.playbackFinishedAt = null;
      if (audioContextRef.current && audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume().catch(() => { });
      }
      promptTimingRef.current = {
        generation,
        promptTurn: promptTurnRef.current,
        sentAt: promptSentAt,
      };
      diagnostic("prompt_handoff_started", {
        promptType: isIdentityWarning
          ? "identity_warning"
          : promptHandoff.clarificationRequired
            ? "clarification"
            : "question",
        responseType,
        promptChars: nextPrompt.length,
      });

      if (data.language) {
        candidateLanguageRef.current = data.language;
      }

      const isNameConfirmationTurn =
        !isIdentityWarning &&
        (promptHandoff.questionId === "A2_NAME_CONFIRM" || expectedQuestionId === "A2_NAME");
      const candidateNameForHandoff = isNameConfirmationTurn || isIdentityWarning
        ? null
        : expectedQuestionId === "A2_NAME" ? (data.candidateName || normalizedAnswer) : null;
      const acknowledgementForHandoff = isNameConfirmationTurn || isIdentityWarning
        ? null
        : promptHandoff.acknowledgement;

      const spokenTargetText = acknowledgementForHandoff
        ? `${acknowledgementForHandoff} ${nextPrompt}`
        : nextPrompt;

      setCurrentQuestion(nextPrompt);
      setCaptionText("");
      captionsControllerRef.current.beginTurn({ targetQuestionText: spokenTargetText });
      inputTurnRef.current.beginModelTurn();
      suppressWaitingSpeechRef.current = false;
      authorizedModelTurnRef.current = true;
      audioChunksReceivedForTurnRef.current = 0;
      const promptText = isIdentityWarning
        ? buildIdentityWarningPrompt(nextPrompt, candidateLanguageRef.current)
        : promptHandoff.warningLevel
          ? buildInvalidWarningPrompt(nextPrompt, promptHandoff.warningLevel)
          : promptHandoff.clarificationRequired
            ? buildClarificationPrompt(nextPrompt)
            : isNameConfirmationTurn
              ? buildNameConfirmationPrompt(nextPrompt, candidateLanguageRef.current)
              : buildQuestionHandoffPrompt(
                nextPrompt,
                candidateNameForHandoff,
                candidateLanguageRef.current,
                acknowledgementForHandoff,
              );

      sessionRef.current.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [
              {
                text: promptText,
              },
            ],
          },
        ],
        turnComplete: true,
      });
      diagnostic("prompt_handoff_sent", {
        promptType: isIdentityWarning
          ? "identity_warning"
          : promptHandoff.warningLevel
            ? `warning_${promptHandoff.warningLevel}`
            : promptHandoff.clarificationRequired
              ? "clarification"
              : "question",
        sendCallElapsedMs: Number((performance.now() - promptSentAt).toFixed(1)),
      });
    } catch (err) {
      diagnostic("answer_flow_error", {
        stage: requestStage,
        errorName: err?.name || "Error",
      });
      console.error("[Interview] Answer submission failed:", err?.name || "Error");
      cancelPendingWaitAnnouncement("answer_failed", true);
      if (mountedRef.current && isCurrentLiveGeneration(generation, liveGenerationRef.current)) {
        setError(answerRequest.reason === "timeout"
          ? "The response took too long. Please try your answer again."
          : "Sorry, your answer couldn't be processed. Please try again.");
        setPreparingResponse(false);
      }
      inputTurnRef.current.retry();
    } finally {
      answerRequest.clear();
      if (answerRequestRef.current === answerRequest) answerRequestRef.current = null;
      if (pendingWaitAnnouncementRef.current?.requestId === requestId) {
        cancelPendingWaitAnnouncement("request_finished");
      }
      answerSubmittingRef.current = false;
      if (mountedRef.current) {
        setIsProcessingAnswer(false);
        setIsWaitingForBackend(false);
      }
    }
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

      if (speakingStateRef.current && audioContextRef.current) {
        const progressive = captionsControllerRef.current.updatePlaybackProgress(audioContextRef.current.currentTime);
        if (mountedRef.current && progressive) {
          setCaptionText(progressive);
        }
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  }

  async function startOrResume(isResume = false) {
    if (startingRef.current || connectedRef.current) return;
    clearAnswerSettleTimer();
    clearNoSpeechTimer();

    const generation = ++liveGenerationRef.current;
    setIsInterviewOpen(true);
    setInterviewLifecycle("starting");
    if (!isResume) {
      interviewSessionIdRef.current = null;
      currentQuestionIdRef.current = null;
      setCurrentQuestionId(null);
      setCurrentQuestion("");
      setCaptionText("");
      setCandidateName("");
      setSavedActiveSession(null);
      captionsControllerRef.current.reset();
      inputTurnRef.current.reset();
      promptTurnRef.current = 0;
      audioChunkSequenceRef.current = 0;
      activePromptRef.current = null;
      answerRequestRef.current = null;
    }
    setIsInterviewActive(false);
    setIsProcessingAnswer(false);
    setPreparingResponse(false);
    setIsWaitingForBackend(false);
    suppressWaitingSpeechRef.current = false;

    let liveToken = "";
    const safeErrorMessage = (error, fallback) => {
      const message = error?.message || fallback;
      return liveToken ? message.replaceAll(liveToken, "[redacted]") : message;
    };

    startingRef.current = true;
    stoppingRef.current = false;
    setError("");

    try {
      const tokenResponse = await fetch(`${API_URL}/api/voice/session`, {
        method: "POST",
        credentials: "include",
      });
      const tokenData = await tokenResponse.json();

      if (tokenResponse.status === 401) {
        window.location.replace("/candidate/login");
        throw new Error("Candidate sign-in is required. Redirecting to Candidate Sign In.");
      }
      if (!tokenResponse.ok || !tokenData.token) {
        throw new Error(tokenData.message || "Gemini Live token nahi mila.");
      }
      liveToken = tokenData.token;

      // Start or Resume the official Urban Company interview session
      const interviewEndpoint = isResume
        ? `${API_URL}/api/interview/resume`
        : `${API_URL}/api/interview/start`;
      const interviewBody = isResume && interviewSessionIdRef.current
        ? JSON.stringify({ sessionId: interviewSessionIdRef.current })
        : JSON.stringify({});

      const interviewResponse = await fetch(interviewEndpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: interviewBody,
      });

      const interviewData = await interviewResponse.json();

      if (interviewResponse.status === 401) {
        window.location.replace("/candidate/login");
        throw new Error("Candidate sign-in expired. Please sign in again.");
      }
      if (!interviewResponse.ok || !interviewData.success) {
        throw new Error(
          interviewData.message || (isResume ? "Interview session resume nahi hua." : "Interview session start nahi hua."),
        );
      }

      interviewSessionIdRef.current = interviewData.sessionId;
      currentQuestionIdRef.current = interviewData.question?.id || null;
      setCurrentQuestionId(interviewData.question?.id || null);
      if (interviewData.candidateName) {
        setCandidateName(interviewData.candidateName);
      }
      setCurrentQuestion(interviewData.question?.text || "");
      setCaptionText("");
      captionsControllerRef.current.beginTurn({
        targetQuestionText: interviewData.question?.text || "",
      });
      setSavedActiveSession(null);
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
          setIsInterviewActive(true);
          setInterviewLifecycle("in_progress");
        },

        onmessage: (message) => {
          if (
            stoppingRef.current ||
            !isCurrentLiveGeneration(generation, liveGenerationRef.current)
          ) return;

          const content = message.serverContent;
          if (!content) return;

          if (content.outputTranscription?.text) {
            captionsControllerRef.current.appendTranscription(content.outputTranscription.text);
            const progressive = captionsControllerRef.current.updatePlaybackProgress(audioContextRef.current?.currentTime || 0);
            if (mountedRef.current && progressive) {
              setCaptionText(progressive);
            }
          }

          const isPlaybackActive =
            playbackSourcesRef.current.size > 0 ||
            speakingStateRef.current ||
            authorizedModelTurnRef.current;
          const inputTurn = inputTurnRef.current.handleServerContent(content, { isPlaybackActive });

          const scheduleAnswerSubmission = (answerText) => {
            clearNoSpeechTimer();
            if (answerSettleTimerRef.current) {
              clearTimeout(answerSettleTimerRef.current);
            }
            turnMetricsRef.current.settleStartedAt = performance.now();
            diagnostic("answer_settle_scheduled", {
              answerTextSnippet: typeof answerText === "string" ? answerText.slice(0, 30) : null,
              delayMs: ANSWER_SETTLE_MS,
            });

            const runner = () => {
              answerSettleTimerRef.current = null;
              pendingAnswerRunnerRef.current = null;
              turnMetricsRef.current.settleEndedAt = performance.now();

              if (
                answerSubmittingRef.current ||
                stoppingRef.current ||
                !connectedRef.current
              ) {
                return;
              }

              // Always read the complete merged transcript from inputTurnRef at settle time
              const fullAnswer = (inputTurnRef.current.getTranscript?.() || answerText || "").trim();
              diagnostic("answer_settle_fired", {
                transcriptChars: fullAnswer.length,
                hasTranscript: Boolean(fullAnswer),
              });
              if (!fullAnswer || isInternalSpeechMarker(fullAnswer)) {
                return;
              }

              inputTurnRef.current.commitAnswer();
              const finalizedInput = classifyFinalizedInput(fullAnswer, activePromptRef.current);
              if (finalizedInput.type === "repeat_question") {
                const repeatRequest = finalizedInput.repeatRequest;
                const requestId = `p${promptTurnRef.current}-r${++repeatRequestSequenceRef.current}`;
                diagnostic("repeat_question_request_finalized", {
                  requestId,
                  transcriptChars: fullAnswer.length,
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
              void submitCandidateAnswer(answer, requestId, transcriptFinalizedAt);
            };

            pendingAnswerRunnerRef.current = runner;
            answerSettleTimerRef.current = setTimeout(runner, ANSWER_SETTLE_MS);
          };

          const liveCandidateText =
            content.interimInputTranscription?.text || content.inputTranscription?.text || "";
          if (content.inputTranscription?.text && content.inputTranscription?.finished !== false) {
            turnMetricsRef.current.speechEndedAt = performance.now();
          }
          if (
            answerSubmittingRef.current &&
            liveCandidateText.trim() &&
            !isInternalSpeechMarker(liveCandidateText)
          ) {
            candidateSpeechSinceSubmitRef.current = true;
          }

          if (inputTurn.activity) {
            if (pendingWaitAnnouncementRef.current) {
              candidateSpeechSinceSubmitRef.current = true;
            }
            clearAnswerSettleTimer();
            clearNoSpeechTimer();
            setError("");
          }

          // Play audio chunks in order at 24 kHz.
          const context = audioContextRef.current;

          if (content.interrupted) {
            diagnostic("model_interrupted_event_received", {
              wasAuthorized: authorizedModelTurnRef.current,
              inputPhase: inputTurnRef.current.phase(),
              hasInputTranscription: Boolean(content.inputTranscription?.text),
              inputTranscription: content.inputTranscription?.text || null,
              hasInterimTranscription: Boolean(content.interimInputTranscription?.text),
              modelAudioParts: (content.modelTurn?.parts || []).filter(
                (part) => Boolean(part.inlineData)
              ).length,
              activeQuestionId: currentQuestionIdRef.current,
              promptTurn: promptTurnRef.current,
            });

            authorizedModelTurnRef.current = false;
            captionsControllerRef.current.handleInterruption();
            if (mountedRef.current) {
              setCaptionText(captionsControllerRef.current.getCaptionText());
            }
            const pendingAnnouncement = pendingWaitAnnouncementRef.current;
            if (pendingAnnouncement?.coordinator.announced) {
              pendingAnnouncement.coordinator.markSpeechFinished("interrupted");
              suppressWaitingSpeechRef.current = true;
            }
            setPreparingResponse(false);
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
            if (part.text) {
              captionsControllerRef.current.appendTranscription(part.text);
              const progressive = captionsControllerRef.current.updatePlaybackProgress(audioContextRef.current?.currentTime || 0);
              if (mountedRef.current && progressive) {
                setCaptionText(progressive);
              }
            }

            const audio = part.inlineData;
            const chunkSequence = audio ? ++audioChunkSequenceRef.current : null;

            if (audio) {

              if (!turnMetricsRef.current.firstAudioChunkReceivedAt) {
                turnMetricsRef.current.firstAudioChunkReceivedAt = performance.now();
              }
              if (context && context.state === "suspended") {
                context.resume().catch(() => { });
              }
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

            if (suppressWaitingSpeechRef.current) {
              diagnostic("audio_chunk_skipped", { reason: "cancelled_wait_announcement" });
              continue;
            }

            if (!authorizedModelTurnRef.current) {
              if (audio) {
                diagnostic("audio_chunk_skipped", {
                  reason: "unauthorized_model_turn",
                  chunkSequence,
                  activeQuestionId: currentQuestionIdRef.current,
                });
              }
              continue;
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

            if (context.state === "suspended") {
              context.resume().catch(() => { });
            }

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
            const pendingAnnouncement = pendingWaitAnnouncementRef.current;
            if (pendingAnnouncement?.coordinator.announced) {
              pendingAnnouncement.sources.add(source);
            }

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
            setPreparingResponse(false);
            try {
              source.start(startAt);

              missingAudioRetryCountRef.current = 0;

              if (!turnMetricsRef.current.firstPlaybackStartedAt) {
                turnMetricsRef.current.firstPlaybackStartedAt = performance.now();
              }

              audioChunksReceivedForTurnRef.current += 1;
              playbackQueueRef.current.sourceStarted(source);
            } catch (err) {
              playbackSourcesRef.current.delete(source);
              diagnostic("audio_schedule_error", {
                errorName: err?.name || "Error",
                scheduledSources: playbackSourcesRef.current.size,
                audioContextState: context.state,
              });
              if (playbackSourcesRef.current.size === 0) {
                setSpeakingState(false, "audio_schedule_error");
              }
              throw err;
            }
            nextPlayTimeRef.current = startAt + buffer.duration;
            captionsControllerRef.current.registerAudioChunk({
              startAt,
              duration: buffer.duration,
              chunkSequence,
            });
            const scheduledProgressive = captionsControllerRef.current.updatePlaybackProgress(context.currentTime);
            if (mountedRef.current && scheduledProgressive) {
              setCaptionText(scheduledProgressive);
            }
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
              pendingAnnouncement?.sources.delete(source);
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
                turnMetricsRef.current.playbackFinishedAt = performance.now();
                setSpeakingState(false, "audio_queue_ended");
                const m = turnMetricsRef.current;
                diagnostic("turn_latency_metrics", {
                  requestId: currentRequestIdRef.current,
                  activeQuestionId: currentQuestionIdRef.current,
                  questionGeneratedAt: m.backendResponseReceivedAt ? Number(m.backendResponseReceivedAt.toFixed(1)) : null,
                  promptSentAt: m.promptHandoffSentAt ? Number(m.promptHandoffSentAt.toFixed(1)) : null,
                  firstAudioChunkReceivedAt: m.firstAudioChunkReceivedAt ? Number(m.firstAudioChunkReceivedAt.toFixed(1)) : null,
                  firstPlaybackStartedAt: m.firstPlaybackStartedAt ? Number(m.firstPlaybackStartedAt.toFixed(1)) : null,
                  playbackCompletedAt: m.playbackFinishedAt ? Number(m.playbackFinishedAt.toFixed(1)) : null,
                  candidateListeningEnabledAt: m.candidateListeningEnabledAt ? Number(m.candidateListeningEnabledAt.toFixed(1)) : null,
                  candidateSpeechEndedAt: m.speechEndedAt ? Number(m.speechEndedAt.toFixed(1)) : null,
                  settleWindowElapsedMs:
                    m.settleStartedAt && m.settleEndedAt
                      ? Number((m.settleEndedAt - m.settleStartedAt).toFixed(1))
                      : null,
                  backendAnswerSubmitDurationMs:
                    m.backendRequestStartedAt && m.backendResponseReceivedAt
                      ? Number((m.backendResponseReceivedAt - m.backendRequestStartedAt).toFixed(1))
                      : null,
                  backendServiceElapsedMs: m.backendServiceElapsedMs,
                  llmInterpretationDurationMs: m.llmInterpretationMs,
                  modelCallElapsedMs: m.modelCallElapsedMs,
                  timeToFirstAudioChunkMs:
                    m.promptHandoffSentAt && m.firstAudioChunkReceivedAt
                      ? Number((m.firstAudioChunkReceivedAt - m.promptHandoffSentAt).toFixed(1))
                      : null,
                  timeToFirstPlaybackMs:
                    m.promptHandoffSentAt && m.firstPlaybackStartedAt
                      ? Number((m.firstPlaybackStartedAt - m.promptHandoffSentAt).toFixed(1))
                      : null,
                  totalAudioPlaybackDurationMs:
                    m.firstPlaybackStartedAt && m.playbackFinishedAt
                      ? Number((m.playbackFinishedAt - m.firstPlaybackStartedAt).toFixed(1))
                      : null,
                  playbackToListeningMs:
                    m.playbackFinishedAt && m.candidateListeningEnabledAt
                      ? Number((m.candidateListeningEnabledAt - m.playbackFinishedAt).toFixed(1))
                      : null,
                });
                const playbackEndTurn = inputTurnRef.current.finishModelPlayback?.();
                const completedCaption = captionsControllerRef.current.markPlaybackComplete();
                if (mountedRef.current && completedCaption) {
                  setCaptionText(completedCaption);
                }
                if (playbackEndTurn?.answer && !answerSubmittingRef.current) {
                  scheduleAnswerSubmission(playbackEndTurn.answer);
                }
              }
            };
          }

          if (content.turnComplete) {
            const wasAuthorizedTurn = authorizedModelTurnRef.current;
            authorizedModelTurnRef.current = false;
            pendingWaitAnnouncementRef.current?.coordinator.markSpeechFinished();

            if (
              wasAuthorizedTurn &&
              audioChunksReceivedForTurnRef.current === 0 &&
              playbackSourcesRef.current.size === 0
            ) {
              diagnostic("turn_complete_without_audio", {
                activeQuestionId: currentQuestionIdRef.current,
                msSincePromptSent: promptElapsedMs(generation),
                retryCount: missingAudioRetryCountRef.current,
              });
              if (
                missingAudioRetryCountRef.current < 1 &&
                activePromptRef.current &&
                !answerSubmittingRef.current &&
                !stoppingRef.current
              ) {
                missingAudioRetryCountRef.current += 1;
                if (audioContextRef.current && audioContextRef.current.state === "suspended") {
                  audioContextRef.current.resume().catch(() => { });
                }
                const repeatReq = {
                  questionId: activePromptRef.current.questionId,
                  prompt: activePromptRef.current.text,
                  clarificationRequired: activePromptRef.current.clarificationRequired,
                  identityMismatchWarning: activePromptRef.current.identityMismatchWarning,
                  warningLevel: activePromptRef.current.warningLevel,
                  isMissingAudioRetry: true,
                };
                const reqId = `p${promptTurnRef.current}-missing-audio-repeat`;
                void repeatActivePrompt(generation, reqId, repeatReq);
                return;
              } else {
                diagnostic("missing_audio_retries_exhausted", {
                  activeQuestionId: currentQuestionIdRef.current,
                });
                missingAudioRetryCountRef.current = 0;
                setPreparingResponse(false);

                const fallbackText = activePromptRef.current?.text || currentQuestion;
                if (fallbackText && mountedRef.current && !stoppingRef.current) {
                  diagnostic("missing_audio_tts_fallback_started", {
                    activeQuestionId: currentQuestionIdRef.current,
                    textLength: fallbackText.length,
                  });
                  ttsCancelRef.current = speakTextFallback({
                    text: fallbackText,
                    language: candidateLanguageRef.current,
                    onStart: () => {
                      setSpeakingState(true, "tts_fallback_started");
                    },
                    onEnd: () => {
                      ttsCancelRef.current = null;
                      setSpeakingState(false, "tts_fallback_ended");
                      const completedCaption = captionsControllerRef.current.markPlaybackComplete();
                      if (mountedRef.current && completedCaption) {
                        setCaptionText(completedCaption);
                      }
                    },
                    onError: (err) => {
                      diagnostic("tts_fallback_error", { error: err?.message || String(err) });
                      ttsCancelRef.current = null;
                      setSpeakingState(false, "tts_fallback_error");
                    },
                  });
                  return;
                }
                setSpeakingState(false, "missing_audio_fallback");
              }
            } else {
              setPreparingResponse(false);
            }
            diagnostic("live_turn_complete", {
              wasAuthorizedTurn,
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
              const completedCaption = captionsControllerRef.current.markPlaybackComplete();
              if (mountedRef.current && completedCaption) {
                setCaptionText(completedCaption);
              }
            }

            if (
              wasAuthorizedTurn &&
              !inputTurn.answer &&
              !inputTurn.activity &&
              !answerSubmittingRef.current &&
              !noSpeechTimerRef.current
            ) {
              noSpeechTimerRef.current = setTimeout(() => {
                noSpeechTimerRef.current = null;
                if (!stoppingRef.current && connectedRef.current && !answerSubmittingRef.current) {
                  setError("I couldn't hear you. Please continue speaking or try again.");
                }
              }, NO_SPEECH_TIMEOUT_MS);
            }
          }

          if (!isPlaybackActive && !answerSubmittingRef.current) {
            if (inputTurn.answer) {
              diagnostic("candidate_turn_answer_ready", { textLength: inputTurn.answer.length });
              scheduleAnswerSubmission(inputTurn.answer);
            } else if (
              inputTurnRef.current.hasCandidateSpoken?.() &&
              !answerSettleTimerRef.current
            ) {
              const currentTranscript = inputTurnRef.current.getTranscript();
              diagnostic("candidate_turn_transcript_settle_started", { textLength: currentTranscript.length });
              scheduleAnswerSubmission(currentTranscript);
            }
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
          void stop("connection_error").finally(() => {
            if (interviewSessionIdRef.current) {
              setInterviewLifecycle("paused");
              setError("The connection was interrupted. Your progress is saved. Click Resume Interview to continue.");
            } else {
              setError("Sorry, the connection was interrupted. Please restart the interview.");
              setInterviewLifecycle("error");
            }
          });
        },

        onclose: () => {
          if (
            stoppingRef.current ||
            !isCurrentLiveGeneration(generation, liveGenerationRef.current)
          ) return;
          connectedRef.current = false;
          setIsInterviewActive(false);
          setPreparingResponse(false);
          if (interviewSessionIdRef.current) {
            setInterviewLifecycle("paused");
            setError("The connection was interrupted. Your progress is saved. Click Resume Interview to continue.");
          } else {
            setInterviewLifecycle("error");
            setError("Sorry, the connection closed. Please restart the interview.");
          }
          diagnostic("live_connection_closed", {
            scheduledSources: playbackSourcesRef.current.size,
          });
          setSpeakingState(false, "connection_closed");
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

        // Do not stream microphone audio to Gemini Live while waiting for the model to prepare its response or while submitting answer
        // Suppress streaming while AI is speaking or audio playback is active to completely prevent speaker-to-mic echo loop and false model interruption
        // Issue 1 Fix: Also suppress during authorizedModelTurn (transit gap between prompt send and first audio chunk)
        if (
          isPreparingResponseRef.current ||
          answerSubmittingRef.current ||
          authorizedModelTurnRef.current ||
          speakingStateRef.current ||
          playbackSourcesRef.current.size > 0
        ) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);

        // Debounce settle timer if candidate resumes speaking into microphone during the settle period
        if (answerSettleTimerRef.current && pendingAnswerRunnerRef.current) {
          let sum = 0;
          for (let i = 0; i < input.length; i++) {
            sum += input[i] * input[i];
          }
          const rms = Math.sqrt(sum / input.length);
          if (rms > 0.04) {
            diagnostic("mic_speech_extended_settle", { rms: Number(rms.toFixed(3)) });
            clearTimeout(answerSettleTimerRef.current);
            answerSettleTimerRef.current = setTimeout(pendingAnswerRunnerRef.current, ANSWER_SETTLE_MS);
          }
        }

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
      suppressWaitingSpeechRef.current = false;
      authorizedModelTurnRef.current = true;
      audioChunksReceivedForTurnRef.current = 0;
      setPreparingResponse(true);
      promptTurnRef.current += 1;
      audioChunkSequenceRef.current = 0;
      const initialPromptSentAt = performance.now();
      promptTimingRef.current = {
        generation,
        promptTurn: promptTurnRef.current,
        sentAt: initialPromptSentAt,
      };
      const promptType = isResume ? "question_handoff" : "initial_question";
      diagnostic("prompt_handoff_started", {
        promptType,
        promptChars: interviewData.question.text.length,
      });
      try {
        if (interviewData.language) {
          candidateLanguageRef.current = interviewData.language;
        }
        const promptText = isResume
          ? buildQuestionHandoffPrompt(
            interviewData.question.text,
            interviewData.candidateName,
            candidateLanguageRef.current,
          )
          : buildInitialQuestionPrompt(interviewData.question.text);
        session.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: promptText,
                },
              ],
            },
          ],
          turnComplete: true,
        });
        diagnostic("prompt_handoff_sent", {
          promptType,
          sendCallElapsedMs: Number((performance.now() - initialPromptSentAt).toFixed(1)),
        });
      } catch (err) {
        diagnostic("prompt_handoff_error", {
          errorName: err?.name || "Error",
        });
        throw err;
      }

    } catch (err) {
      if (!isCurrentLiveGeneration(generation, liveGenerationRef.current)) {
        return;
      }
      const messageText = safeErrorMessage(
        err,
        "Voice connection start nahi ho paaya.",
      );
      console.error("[Gemini Live] Start/Resume failed:", messageText);
      setInterviewLifecycle(isResume ? "paused" : "error");
      setPreparingResponse(false);
      setError(err?.name === "NotAllowedError" || err?.name === "SecurityError"
        ? "Microphone permission is needed. Please allow access and try again."
        : isResume
          ? "Sorry, the interview couldn't be resumed. Please try again."
          : "Sorry, the interview couldn't start. Please check your connection and try again.");
      await stop("start_failure");
    } finally {
      startingRef.current = false;
    }
  }

  async function start() {
    setIsInterviewOpen(true);
    setSavedActiveSession(null);
    interviewSessionIdRef.current = null;
    currentQuestionIdRef.current = null;
    setCurrentQuestionId(null);
    setCurrentQuestion("");
    setCaptionText("");
    setCandidateName("");
    captionsControllerRef.current.reset();
    inputTurnRef.current.reset();
    promptTurnRef.current = 0;
    audioChunkSequenceRef.current = 0;
    activePromptRef.current = null;
    answerRequestRef.current = null;
    return startOrResume(false);
  }

  async function resume() {
    setIsInterviewOpen(true);
    return startOrResume(true);
  }

  async function pause() {
    if (stoppingRef.current) return;
    const sessionId = interviewSessionIdRef.current;
    if (sessionId) {
      try {
        await fetch(`${API_URL}/api/interview/pause`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
      } catch (err) {
        console.warn("[Interview] Pause endpoint warning:", err);
      }
    }

    answerRequestRef.current?.cancel("interview_paused");
    cancelPendingWaitAnnouncement("interview_paused");
    captionsControllerRef.current.handlePause();
    clearAnswerSettleTimer();
    clearNoSpeechTimer();
    clearPreparingResponseTimer();
    liveGenerationRef.current += 1;
    connectedRef.current = false;
    authorizedModelTurnRef.current = false;
    setIsInterviewActive(false);
    setIsProcessingAnswer(false);
    setPreparingResponse(false);

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch { }
    }
    playbackQueueRef.current.cancelAll("session_paused");
    playbackSourcesRef.current.clear();
    if (ttsCancelRef.current) {
      ttsCancelRef.current();
      ttsCancelRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      try {
        processorRef.current.disconnect();
      } catch { }
    }

    try {
      micSourceRef.current?.disconnect();
      outputAnalyserRef.current?.disconnect();
      outputGainRef.current?.disconnect();
      micMuteGainRef.current?.disconnect();
      sessionRef.current?.close();
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        await audioContextRef.current.close();
      }
    } catch { }

    sessionRef.current = null;
    audioContextRef.current = null;
    micStreamRef.current = null;
    micSourceRef.current = null;
    processorRef.current = null;
    micMuteGainRef.current = null;
    outputAnalyserRef.current = null;
    outputGainRef.current = null;
    nextPlayTimeRef.current = 0;
    inputTurnRef.current.reset();

    setAudioLevel(0);
    setSpeakingState(false, "pause_cleanup");
    if (mountedRef.current) {
      setInterviewLifecycle("paused");
    }
  }

  async function stop(reason = "user_requested") {
    if (stoppingRef.current) return;
    answerRequestRef.current?.cancel("interview_stopped");
    cancelPendingWaitAnnouncement("interview_stopped");
    if (ttsCancelRef.current) {
      ttsCancelRef.current();
      ttsCancelRef.current = null;
    }
    captionsControllerRef.current.reset();
    setCaptionText("");
    clearAnswerSettleTimer();
    clearNoSpeechTimer();
    clearPreparingResponseTimer();
    liveGenerationRef.current += 1;
    stoppingRef.current = true;
    connectedRef.current = false;
    authorizedModelTurnRef.current = false;
    setIsInterviewActive(false);
    const safeReason = typeof reason === "string" ? reason : "user_requested";
    const sessionIdToFinalize = interviewSessionIdRef.current;
    const shouldFinalizeSession = safeReason === "user_requested" && Boolean(sessionIdToFinalize);
    if (shouldFinalizeSession) setInterviewLifecycle("ending");
    setIsProcessingAnswer(false);
    setPreparingResponse(false);

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
      } catch { }
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
        if (!response.ok || !data?.success) throw new Error("Interview end was not confirmed");
        if (mountedRef.current) {
          setSavedActiveSession(null);
          interviewSessionIdRef.current = null;
          currentQuestionIdRef.current = null;
          setInterviewLifecycle(resolveTerminalInterviewState({
            sessionStatus: data.sessionStatus,
            completed: data.sessionStatus === "completed",
            manualReviewRequired: data.sessionStatus === "manual_review",
            eligibilityOutcome: data.eligibilityOutcome,
            terminated: data.sessionStatus === "terminated",
          }));
        }
      } catch (endError) {
        diagnostic("interview_end_request_failed", {
          errorName: endError?.name || "Error",
        });
        if (mountedRef.current) {
          setSavedActiveSession(null);
          interviewSessionIdRef.current = null;
          currentQuestionIdRef.current = null;
          setInterviewLifecycle("end_unconfirmed");
          setError("I couldn't confirm that the interview ended. Please contact support.");
        }
      }
    }
    stoppingRef.current = false;
  }

  async function submitTextAnswer(text) {
    if (!text || typeof text !== "string") return;
    const clean = text.trim();
    if (!clean) return;
    if (
      isAiSpeaking ||
      isProcessingAnswer ||
      isPreparingResponse ||
      isWaitingForBackend ||
      !interviewSessionIdRef.current ||
      !currentQuestionIdRef.current
    ) {
      return;
    }
    clearNoSpeechTimer();
    clearAnswerSettleTimer();
    setError("");
    inputTurnRef.current = createLiveInputTurn();
    const requestId = `req_txt_${Date.now()}`;
    await submitCandidateAnswer(clean, requestId, performance.now());
  }

  async function confirmName(isConfirmed) {
    if (
      isAiSpeaking ||
      isProcessingAnswer ||
      isPreparingResponse ||
      isWaitingForBackend ||
      answerSubmittingRef.current ||
      !interviewSessionIdRef.current ||
      !currentQuestionIdRef.current ||
      stoppingRef.current
    ) {
      return;
    }
    clearNoSpeechTimer();
    clearAnswerSettleTimer();
    setError("");
    inputTurnRef.current = createLiveInputTurn();
    const answer = isConfirmed ? "yes" : "no";
    const requestId = `req_confirm_${Date.now()}`;
    await submitCandidateAnswer(answer, requestId, performance.now());
  }

  async function updateName(newName) {
    if (!newName || typeof newName !== "string" || !interviewSessionIdRef.current) return false;
    try {
      const res = await fetch(`${API_URL}/api/interview/update-name`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: interviewSessionIdRef.current,
          name: newName.trim(),
        }),
      });
      const data = await res.json();
      if (data.success && data.candidateName) {
        setCandidateName(data.candidateName);
        return true;
      }
      return false;
    } catch (e) {
      console.warn("[Interview] Name update failed:", e);
      return false;
    }
  }

  return {
    error,
    interviewLifecycle,
    currentQuestion,
    currentQuestionId,
    candidateName,
    captionText,
    isProcessingAnswer,
    isPreparingResponse,
    isWaitingForBackend,
    audioLevel,
    isAiSpeaking,
    isInterviewActive,
    startingRef,
    start,
    pause,
    resume,
    stop,
    savedActiveSession,
    isInterviewOpen,
    setIsInterviewOpen,
    isCheckingActiveSession,
    submitTextAnswer,
    confirmName,
    updateName,
  };
}
