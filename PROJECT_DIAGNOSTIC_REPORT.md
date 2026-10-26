# Urban Company AI Interviewer — Diagnostic Audit

Audit date: 2026-10-25  
Scope: read-only diagnosis of the current source and tests. No source code was changed.

## 1. Executive Summary

### Bug A — Multiple questions spoken consecutively

The current startup path sends the first official question once. I found no duplicate `sendClientContent()` call during startup, no React effect that starts the interview twice, and no `onmessage` registration loop. Later prompts are sent from one place after an answer request returns.

The leading code-level risk is turn attribution: the hook treats **every** `serverContent.turnComplete` as a candidate-answer boundary. It reads and clears the current candidate transcript and may post it to the backend without determining whether that event completes the candidate's audio or Gemini's own spoken question/acknowledgement. The SDK documents input transcription and model-turn completion as independently delivered events, without guaranteed ordering. Since microphone audio continues while Gemini speaks, ambient capture or speaker echo can also be mistaken for candidate input. Those are plausible causes of multiple backend prompts, but require runtime event logs to confirm.

The backend's question bank is not bypassed by the current startup prompt: `interviewData.question.text` is included in the one initial prompt. The server system instruction and prompt both say to follow backend-authorized questions. The conversational demo prompt found in `useGeminiLiveInterview.backup.js` is a backup file, not the active hook.

### Bug B — Relocation/travel clarification repeats

The exact Devanagari answer in the brief reproduces the loop in the backend without Gemini or a browser. After an A1 answer such as `Delhi` creates a `travel_clarification`, submitting `हाँ, कर सकती हूँ।` returns `clarificationRequired: true` and the same pending travel question. The Romanized `haan kar sakti hoon` advances to the relocation-timeline prompt.

The first classifier, `classifyLocation()`, recognizes the Devanagari affirmative for an initial A1 answer. The later classifier for `pending.type === "travel_clarification"` does not: its positive/negative patterns cover Romanized Hindi and English, but not Devanagari. This is the **confirmed first divergence** when the frontend submits that transcript correctly.

There is a second independent risk: the client clears `inputTextRef` on every `turnComplete`. If a finalized input transcript arrives after that event, it is not submitted until a later `turnComplete`; it can be delayed, lost at a later clear, or associated with the wrong question. This is supported by the documented event schema, but whether it caused the observed relocation loop cannot be known without a trace of actual events and the request payload.

## 2. Current Git State

- Branch: `main`
- HEAD: `c16383c` (`Save interview flow fixes and backups`)
- Working tree before this report: clean (`git status --short` returned no entries).
- `PROJECT_DIAGNOSTIC_REPORT.md` did not exist before this audit. It is the only file created for this request.
- The active frontend hook and backend interview files are tracked at HEAD. `client/src/hooks/useGeminiLiveInterview.backup.js` is a separate tracked backup and is not imported by the app.

## 3. Architecture and Interview Flow

1. `App.jsx` renders `GeminiVoicePrototype`; that component passes `start`/`stop` to `InterviewControls`.
2. `start()` fetches `/api/voice/session`, then `/api/interview/start`, obtains microphone permission, creates the audio graph, and connects to Gemini Live.
3. The server creates a one-use ephemeral token with the `gemini-3.8-live` model, audio response modality, input/output transcription, and a server-side system instruction.
4. After the Live connection and mic processor are set up, the client sends `interviewData.question.text` once using `sendClientContent()`.
5. The microphone processor continuously resamples and sends audio through `sendRealtimeInput()` while the connection is active.
6. The hook appends final `inputTranscription` text to `inputTextRef`. At **any** `turnComplete`, it copies and clears that ref and, if nonempty, posts `{ sessionId, answer }` to `/api/interview/answer`.
7. The backend returns a clarification, follow-up, next question, or completion result. For an active prompt, the client sends a new `sendClientContent()` request to speak the returned prompt.

Actual interview routes in `server/src/routes/interviewRoutes.js` are `POST /start`, `POST /answer`, `POST /interpret`, `POST /manual-review`, and `GET /:sessionId/report`, mounted under `/api/interview`. `/api/voice/session` is declared separately in `server/src/server.js`.

## 4. Bug A: Multiple Questions

### Confirmed startup path

- Start is guarded by `startingRef` and `connectedRef`: [useGeminiLiveInterview.js:171-179](client/src/hooks/useGeminiLiveInterview.js#L171).
- The backend start response is saved as the active session at lines 190–208.
- The first prompt is sent once at [useGeminiLiveInterview.js:441-459](client/src/hooks/useGeminiLiveInterview.js#L441). It contains `interviewData.question.text`.
- Later prompts are sent at [useGeminiLiveInterview.js:91-134](client/src/hooks/useGeminiLiveInterview.js#L91), after `/api/interview/answer` returns.
- The current server system instruction says to ask only backend-provided prompts and not invent, skip, reorder, or independently repeat questions: [server.js:37-47](server/src/server.js#L37).

Thus, **a repeated first-question call is not evident in the current source**. One model turn could still contain more than one spoken question, but there is no runtime output fixture/log showing that.

### Likely event-sequencing cause

The microphone stream is not paused while Gemini speaks: [useGeminiLiveInterview.js:409-438](client/src/hooks/useGeminiLiveInterview.js#L409). Every server `turnComplete` then runs the same candidate-answer check and clears both transcript refs at [useGeminiLiveInterview.js:361-378](client/src/hooks/useGeminiLiveInterview.js#L361). There is no state distinguishing “Gemini finished speaking the authorized prompt” from “candidate finished answering.”

The relevant event sequence can therefore be:

```text
start
  → send official Q1 once
  → mic audio continues during Gemini output
  → candidate input transcript and Gemini turnComplete arrive in either order
  → any turnComplete consumes/clears the current transcript
  → nonempty transcript posts /answer
  → backend advances or returns a follow-up
  → client sends next authorized prompt
```

If the mic acoustically captures Gemini output, or if speech is transcribed while a prompt is playing, the same path can submit unintended text and cause another backend prompt. Echo cancellation is requested, but the code does not measure or filter speaker echo. This is a likely cause, not confirmed without real mic/device measurements.

### Duplicate submission and reconnect risks

- `answerSubmittingRef` prevents concurrent requests while a fetch is pending ([hook:31, 34–43](client/src/hooks/useGeminiLiveInterview.js#L31)). It does not bind an answer to a specific Live input turn. `lastSubmittedAnswerRef` is declared but unused ([hook:32](client/src/hooks/useGeminiLiveInterview.js#L32)).
- The flag resets as soon as the HTTP response and synchronous `sendClientContent()` call finish, not when the resulting audio turn finishes ([hook:139-141](client/src/hooks/useGeminiLiveInterview.js#L139)).
- `onclose` changes the status and `connectedRef` but does not clean up the old mic graph/session ([hook:388-393](client/src/hooks/useGeminiLiveInterview.js#L388)). A subsequent Start can build another graph. Old processors read shared refs, so an old graph can send audio into the newly assigned session. This is a concrete reconnect hazard, but no reconnect was reproduced.
- There are no React effects in the hook that install duplicate callbacks. One `connectGeminiLive()` call occurs per successful start.

### Playback coordination

Output PCM is decoded and scheduled in order at 24 kHz ([hook:305-359](client/src/hooks/useGeminiLiveInterview.js#L305)). The `source.onended` handler clears the speaking state when the scheduled queue ends. However, `turnComplete` also immediately sets `isAiSpeaking` false ([hook:361-372](client/src/hooks/useGeminiLiveInterview.js#L361)), regardless of scheduled playback state. This can make UI state inaccurate. It does not itself send an extra question, but the client has no speaking-state gate on microphone upload.

## 5. Bug B: Relocation Loop

### End-to-end reproduction

The backend trace is:

1. `Haan` answers A0 and advances the session index to A1 ([interview.js:318-373](server/src/services/interview.js#L318)).
2. `Delhi` is not classified as willing or unwilling by `classifyLocation()`, so it returns `followUp: "travel_clarification"` ([locationRules.js:109-116](server/src/services/rules/locationRules.js#L109)). The A1 branch stores the follow-up without advancing the question index ([interview.js:376-445](server/src/services/interview.js#L376)).
3. For a pending travel clarification, `interview.js` checks Romanized/English positive and negative expressions ([interview.js:151-162](server/src/services/interview.js#L151)). The exact Devanagari affirmative matches neither list.
4. It calls `askAgain()`, which keeps the pending follow-up and current question index, returns `clarificationRequired: true`, and returns the same pending question ([interview.js:129-148, 170-173](server/src/services/interview.js#L129)).
5. The frontend chooses `data.message` when `clarificationRequired` is true ([useGeminiLiveInterview.js:91-95](client/src/hooks/useGeminiLiveInterview.js#L91)), then asks Gemini to explain that clarification ([hook:112-134](client/src/hooks/useGeminiLiveInterview.js#L112)). The repeated wording is backend output, not an invented classifier decision by the voice model.

I ran a local, non-network diagnostic against the service. Its result for `हाँ, कर सकती हूँ।` was `clarificationRequired: true` with the same `travel_clarification` pending question. `haan kar sakti hoon` returned the `move_timeline` prompt. No secrets or external API calls were involved.

### Classifier coverage

- `classifyLocation()` recognizes positive Devanagari forms such as `हाँ ... कर सकती` and `हां ... कर सकती` at [locationRules.js:54-68](server/src/services/rules/locationRules.js#L54). The same direct diagnostic classified both `हाँ, कर सकती हूँ।` and `हां कर सकती हूं` as willing for an initial A1 answer.
- Initial negative Devanagari such as `नहीं, मैं नहीं जा सकती` is **not** recognized by the unwilling patterns, which contain Romanized/English forms ([locationRules.js:22-40](server/src/services/rules/locationRules.js#L22)). The diagnostic classified it as `travelWillingness: "unknown"` with a travel follow-up.
- The pending `travel_clarification` handler is a separate, narrower classifier and recognizes neither Devanagari affirmative nor negative forms ([interview.js:151-174](server/src/services/interview.js#L151)). This precisely explains why the initial classifier can accept a phrase that the follow-up handler rejects.
- The pending `move_timeline` handler treats most non-unclear strings as a valid timeline and advances, even when the answer is not a timeline ([interview.js:248-297](server/src/services/interview.js#L248)). This is a separate input-validation risk.

### Request payload and prompt selection

The hook posts the trimmed current transcript as `answer` with the session ID ([useGeminiLiveInterview.js:34-55](client/src/hooks/useGeminiLiveInterview.js#L34)). There is no runtime request capture in this audit, so I cannot confirm what the browser actually posted. For clarification responses, the hook prefers `data.message`; for ordinary follow-up/next questions, it uses `data.question.text` ([hook:91-95](client/src/hooks/useGeminiLiveInterview.js#L91)). For the failed Hindi answer, the backend's `message` is the repeated clarification, so the client faithfully speaks the repeated text.

## 6. Gemini Live Turn Lifecycle

- Installed version: `@google/genai 2.31.0` in both client and server lockfiles.
- Active model: `gemini-3.8-live` in [geminiConfig.js](client/src/config/geminiConfig.js#L1) and server token constraints ([server.js:49-62](server/src/server.js#L49)). Google’s current model page lists `gemini-3.8-live` as a stable Live API model. [Official model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)
- `connectGeminiLive()` uses the ephemeral token as the SDK `apiKey`, `v1beta`, `responseModalities: ["AUDIO"]`, and both transcription options: [geminiService.js:1-19](client/src/services/geminiService.js#L1).
- Input audio is converted to PCM16 and sent as `audio/pcm;rate=16000`; this matches Google’s documented Live input format. Output is decoded as signed PCM16 at 24 kHz, also matching the documentation. [Live audio guide](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- The installed SDK types expose `serverContent.inputTranscription`, `interimInputTranscription`, `outputTranscription`, `turnComplete`, and `interrupted`. The client uses final input/output transcription and `turnComplete`; it ignores interim transcription and `interrupted`.
- Google documents final input transcription as the committed speech segment and interim transcription as speculative. It also documents that input transcription has no guaranteed ordering relative to other server messages. [Live transcription guide](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) · [Live WebSocket event reference](https://ai.google.dev/api/live)
- The client does not use `audioStreamEnd`; automatic activity detection is enabled by default for `sendRealtimeInput`, so its absence is not by itself a schema error. A final transcript still depends on the service’s VAD deciding that the speech segment ended.

## 7. Backend Session and Question State

- `startInterview()` creates an in-memory session with index 0 and returns the first of 49 validated questions ([interview.js:9-53](server/src/services/interview.js#L9)).
- A0 unclear: returns a clarification without appending/incrementing. A0 accepted: records consent and increments. A0 refused: completes to manual review.
- A1 unclear without a follow-up: returns clarification without incrementing. A1 recognized with a follow-up: stores the answer/check and pending follow-up while leaving the index on A1. A1 without a follow-up increments to the next question.
- Pending travel clarification: invalid/ambiguous answers preserve pending state and index; positive answers switch pending state to move timeline; negative answers clear pending state and increment the index.
- Pending move timeline: unclear answers preserve pending state; other answers are saved, pending is cleared, and the index increments.
- A2 clarification preserves the index. Reject completes the session; pass/manual-review increments.
- Other questions call the Gemini interpreter, preserve the index on clarification, otherwise save and increment ([interview.js:524-587](server/src/services/interview.js#L524)).
- **Manual-review report mismatch:** A1 stores `answerRecord.manualReviewRequired` and manual checks, but does not set `session.manualReviewRequired`; A2 can return `manualReviewRequired: true` without setting that session flag either. `getReport()` reports only `Boolean(session.manualReviewRequired)` ([interview.js:395-413, 507-520, 616-646](server/src/services/interview.js#L395)). Thus the report-level flag can be false while a location/age record requires review. This does not cause the repeated clarification but is relevant state inconsistency.
- `submitAnswer()` is async because it awaits interpretation for normal questions. It has no per-session lock/idempotency key around that await. Duplicate requests for a normal question could both observe the same index and later each append/increment. The frontend suppresses overlapping requests during its own fetch, but retries or duplicate client events are not guarded at the backend.

## 8. Existing Tests

- `server/package.json` defines `npm test` as `node --test src/services/interviewTest.js`.
- `client/package.json` defines build/lint scripts but no client test script.
- `server/src/services/interviewTest.js` has 24 tests for consent, age, question progression, location follow-ups, reports, and manual review. It has no Gemini Live event, transcription-order, frontend answer-payload, or duplicate-turn tests. Its `submitAnswer()` calls are synchronous and do not `await` the now-async service.
- I ran the server test command. **11 passed, 13 failed.** Most interview failures dereference the returned Promise as if it were a result. One separate failing assertion expects `classifyConsent("Nahi, main agree nahi karti")` to return `refused`, but the current classifier returns `unclear`; its refusal patterns do not match this mixed Hindi/English wording. This is an existing test/code disagreement, not a Gemini Live failure.
- A local diagnostic exercised the Hindi relocation answer through the real interview service and separately exercised initial location classification. It made no external API call and confirmed the loop described above.

## 9. Root-Cause Ranking

### Confirmed

1. **High — Hindi travel clarification loop:** the pending travel handler omits Devanagari affirmative/negative patterns. The actual service returns the same clarification for `हाँ, कर सकती हूँ।`; confirmed by execution.
2. **High — Transcript buffer cleared on every model turn completion:** code consumes and clears candidate transcript at every `turnComplete`; official API documentation says input transcription has no guaranteed ordering relative to other server events. The risk is confirmed in code; its contribution to a particular browser run is unverified.
3. **High — Existing server test suite is red:** 13/24 fail. Most call async `submitAnswer()` without awaiting; the refusal-classification test separately disagrees with current `consentRules.js`.
4. **Medium — Mic is sent during Gemini playback:** there is no output-speaking gate in the audio callback. This permits overlap and possible speaker echo to become candidate input; effect depends on acoustic setup.
5. **Medium — Current client can send multiple prompts over a session without turn identity:** the request guard only covers the HTTP request; turn boundaries are not tied to specific input events. Reconnect cleanup is also incomplete.

### Likely, needs runtime evidence

1. **Bug A likely begins with incorrect turn classification or acoustic echo**, causing an unintended nonempty candidate transcript to be submitted at a model `turnComplete`, after which the backend legitimately returns the next approved question. The current code does not prove that this occurred.
2. **Bug B may also be worsened by late/mis-associated transcription**, because the client clears the text buffer on any turn completion. But if the posted request body is exactly `हाँ, कर सकती हूँ।`, the backend classifier alone is sufficient to reproduce the repeat.

## 10. Minimal Fix Plan (Not Implemented)

1. **`server/src/services/interview.js`, pending `travel_clarification` branch:** recognize Hindi Devanagari affirmative and negative variants consistently with `classifyLocation()`, preferably via a shared rule function. Keep ambiguous/conflicting answers on clarification. Add regression tests for the exact positive and negative phrases. Risk: overly broad patterns can misclassify mixed or contradictory answers; test those explicitly.
2. **`client/src/hooks/useGeminiLiveInterview.js`, Live event handler:** associate transcript completion with the candidate input turn; do not clear candidate text on arbitrary model `turnComplete`. Preserve late final transcript events and submit once per finalized candidate turn. Add an event fixture where final input transcription arrives before and after `turnComplete`. Risk: waiting too long can make the interaction feel slow; submitting too early can truncate answers.
3. **Same hook, microphone/output lifecycle:** prevent Gemini speaker output from being treated as candidate speech where practical, track playback and listening state consistently, and dispose mic/session resources on close before allowing reconnect. Add a mocked speaker-output/turn-completion regression scenario. Risk: an overly aggressive output gate could clip candidate barge-in.
4. **`server/src/services/interviewTest.js`:** await all `submitAnswer()` calls, add direct `travel_clarification` cases in Devanagari and Roman Hindi, add an invalid/ambiguous answer case, and resolve the consent test’s mismatch with the intended accepted/refused policy. Risk: tests may reveal policy ambiguity; do not broaden consent acceptance without confirming rules.
5. **`server/src/services/interview.js`, report state:** set and test session-level manual-review state consistently for A1/A2/refusal where the existing policy requires it. Risk: could change report semantics; verify the intended workbook manual-review outcome first.

## 11. Verification Plan

- Run `npm test` after updating test awaits and adding Hindi travel/relocation cases; all service results should be awaited and assertions should cover session index, pending follow-up, travel willingness, and the returned `question.text`/`message`.
- Add frontend fixtures for: one initial prompt, one candidate transcript, model `turnComplete` before final transcription, final transcription before `turnComplete`, duplicate final text, output transcription/audio chunks, and reconnection. Assert one `/answer` request per completed candidate answer and no request on an assistant-only turn.
- In browser testing, log event type/timestamp (not transcript content), speaking/listening state, audio callback sample RMS, frame count, transcription arrival, `turnComplete`, request ID, and response question ID. Confirm one input segment yields one request and one backend prompt.
- Verify one real Hindi positive and negative relocation answer through the UI and inspect the request payload and backend response. Use no transcript/answer logging in production logs.
- Confirm the first utterance spoken is the backend’s exact A0 question, not an independently generated conversational prompt.

## 12. Uncertainties

- No real Gemini Live connection or microphone session was run; acoustic echo, actual sample levels, transcription accuracy, event timing, and consecutive spoken output are unverified.
- No browser Network capture was available, so the observed payload and whether the answer endpoint was called in the failing run are unknown.
- Gemini event ordering can vary; source and official docs establish that transcription and model-turn events are independent, but not their order in the reported session.
- The model may produce multiple spoken sentences in one response despite a single client prompt; no captured `modelTurn`/audio transcript fixture was supplied.
- API token validity, quota, service-side entitlement, and runtime connection behavior were not checked. No secrets or `.env` content were read or reported.

## Terminal Summary

- Branch `main`, HEAD `c16383c`; working tree was clean before this report.
- Confirmed relocation loop: Devanagari affirmative fails the pending travel classifier and repeats the same clarification; Roman affirmative advances.
- Confirmed turn-boundary risk: every `turnComplete` consumes and clears candidate text, although Live transcription events are not guaranteed to arrive in order relative to model events.
- Confirmed first prompt is sent once and is sourced from the question bank; no duplicate startup send is visible in the active hook.
- Server tests: 11 passed, 13 failed; async service calls are not awaited in tests, plus the consent-refusal expectation differs from the classifier.
- No source code changed. This report is the only file created.
