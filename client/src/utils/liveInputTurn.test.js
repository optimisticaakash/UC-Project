import assert from "node:assert/strict";
import test from "node:test";
import { createLiveInputTurn, isInternalSpeechMarker } from "./liveInputTurn.js";

function finalTranscript(text, startOffset, endOffset) {
  return {
    inputTranscription: {
      text,
      startOffset,
      endOffset,
    },
  };
}

test("candidate final before turnComplete waits for interrupted model turn", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  assert.equal(turn.handleServerContent(finalTranscript("My answer", "1s", "2s")).answer, null);
  assert.equal(turn.handleServerContent({ interrupted: true }).answer, null);
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    "My answer",
  );
});

test("finalized answer before model turnComplete submits without interruption event", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  assert.equal(
    turn.handleServerContent({
      inputTranscription: {
        text: "Sunita",
        startOffset: "1s",
        endOffset: "2s",
        finished: true,
      },
    }).answer,
    null,
  );
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    "Sunita",
  );
});

test("interim during model turn and final after turnComplete submit together", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  assert.equal(
    turn.handleServerContent({ interimInputTranscription: { text: "Suni" } }).answer,
    null,
  );
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, null);
  assert.equal(
    turn.handleServerContent({
      inputTranscription: {
        text: "Sunita",
        startOffset: "1s",
        endOffset: "2s",
        finished: true,
      },
    }).answer,
    "Sunita",
  );
});

test("candidate final after response turnComplete is submitted", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  turn.handleServerContent({ turnComplete: true });
  turn.handleServerContent({ interimInputTranscription: { text: "My ans" } });
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, null);
  assert.equal(
    turn.handleServerContent(finalTranscript("My answer", "3s", "4s")).answer,
    "My answer",
  );
});

test("final-only transcription after turnComplete submits without another model turn", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  // The question's model turn has completed. No interim event preceded the
  // final transcription, so the finalized input itself must close this answer.
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, null);
  assert.equal(
    turn.handleServerContent({
      inputTranscription: {
        text: "My complete answer",
        startOffset: "3s",
        endOffset: "5s",
        finished: true,
      },
    }).answer,
    "My complete answer",
  );
});

test("unfinished late transcription waits for its finalized event", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });

  assert.equal(
    turn.handleServerContent({
      inputTranscription: {
        text: "My answer",
        startOffset: "3s",
        endOffset: "4s",
        finished: false,
      },
    }).answer,
    null,
  );
  assert.equal(
    turn.handleServerContent({
      inputTranscription: {
        text: "My answer",
        startOffset: "3s",
        endOffset: "4s",
        finished: true,
      },
    }).answer,
    "My answer",
  );
});

test("candidate final after interim submits immediately and does not require another turnComplete", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.handleServerContent({ interimInputTranscription: { text: "My ans" } });

  assert.equal(
    turn.handleServerContent(finalTranscript("My answer", "4s", "5s")).answer,
    "My answer",
  );
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    null,
  );
});

test("interim transcription is ignored and finalized text submits once", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });

  assert.equal(
    turn.handleServerContent({ interimInputTranscription: { text: "My ans" } })
      .answer,
    null,
  );
  assert.equal(
    turn.handleServerContent(finalTranscript("My answer", "5s", "6s")).answer,
    "My answer",
  );
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    null,
  );
  assert.equal(
    turn.handleServerContent(finalTranscript("My answer", "5s", "6s")).answer,
    null,
  );
});

test("transcription chunks are merged into the complete finalized answer", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.handleServerContent({ interimInputTranscription: { text: "I can" } });
  turn.handleServerContent({
    inputTranscription: {
      text: "I can",
      startOffset: "13s",
      endOffset: "14s",
      finished: false,
    },
  });
  assert.equal(
    turn.handleServerContent({
      inputTranscription: {
        text: "I can travel",
        startOffset: "13s",
        endOffset: "15s",
        finished: true,
      },
    }).answer,
    "I can travel",
  );
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    null,
  );
});

test("assistant-only turn does not create a candidate submission", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  assert.equal(turn.handleServerContent({ modelTurn: { parts: [{ text: "Question" }] } }).answer, null);
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, null);
});

test("identical candidate answers on separate prompt turns both submit", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.handleServerContent({ interimInputTranscription: { text: "Yes" } });

  assert.equal(
    turn.handleServerContent(finalTranscript("Yes", "7s", "8s")).answer,
    "Yes",
  );
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, null);

  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.handleServerContent({ interimInputTranscription: { text: "Yes" } });
  assert.equal(
    turn.handleServerContent(finalTranscript("Yes", "9s", "10s")).answer,
    "Yes",
  );
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    null,
  );
});

test("a duplicate final event from a submitted turn is ignored on the next turn", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  const previousFinal = {
    inputTranscription: {
      text: "Yes",
      startOffset: "7s",
      endOffset: "8s",
      finished: true,
    },
  };

  assert.equal(turn.handleServerContent(previousFinal).answer, "Yes");

  turn.beginModelTurn();
  assert.equal(turn.handleServerContent(previousFinal).answer, null);
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    null,
  );
});

test("duplicate final transcription in an interrupted turn submits once", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  const final = finalTranscript("My answer", "11s", "12s");

  turn.handleServerContent(final);
  turn.handleServerContent(final);
  turn.handleServerContent({ interrupted: true });
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, "My answer");
  assert.equal(turn.handleServerContent(final).answer, null);
});

test("internal no-speech and pause markers do not become candidate answers", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  for (const marker of ["no pause", "<no speech>", "<no speech>{pause}", "{pause}"]) {
    const result = turn.handleServerContent({
      inputTranscription: { text: marker, finished: true },
    });
    assert.equal(result.answer, null, marker);
    assert.equal(result.transcript, "", marker);
  }
  assert.equal(isInternalSpeechMarker("<no speech>{pause}"), true);
  assert.equal(isInternalSpeechMarker("I paused before I answered"), false);
});

test("empty and whitespace speech events do not count as activity or submit answers", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  const emptyEvents = ["", "   ", null];
  for (const text of emptyEvents) {
    const result = turn.handleServerContent({ inputTranscription: { text, finished: true } });
    assert.equal(result.answer, null);
    assert.equal(result.transcript, "");
    assert.equal(result.activity, false);
  }
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, null);
});

test("answer remains open during the settle window and can include continued speech", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.handleServerContent({ interimInputTranscription: { text: "I would" } });
  assert.equal(turn.handleServerContent(finalTranscript("I would travel", "1s", "2s")).answer, "I would travel");
  assert.equal(turn.handleServerContent({ interimInputTranscription: { text: "if needed" } }).answer, null);
  assert.equal(turn.handleServerContent(finalTranscript("I would travel if needed", "1s", "4s")).answer, "I would travel if needed");
  turn.commitAnswer();
  assert.equal(turn.handleServerContent(finalTranscript("I would travel if needed", "1s", "4s")).answer, null);
});

test("interim speech activity prevents premature answer emission until final transcription", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });

  // Candidate is speaking: interim arrives
  const interimResult = turn.handleServerContent({ interimInputTranscription: { text: "Mera naam" } });
  assert.equal(interimResult.answer, null);
  assert.equal(interimResult.activity, true);

  // An unprompted turnComplete from the model arrives while candidate is speaking
  const turnCompleteResult = turn.handleServerContent({ turnComplete: true });
  assert.equal(turnCompleteResult.answer, null, "Should not advance before candidate finishes speaking");

  // Candidate finishes speaking: final transcription arrives
  const finalResult = turn.handleServerContent(finalTranscript("Mera naam Priya hai", "1s", "3s"));
  assert.equal(finalResult.answer, "Mera naam Priya hai");
});

test("candidate speech arriving while AI question playback is active does not advance until playback completes", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  // Model generation finishes, but physical audio playback is still active in speakers
  turn.handleServerContent({ turnComplete: true }, { isPlaybackActive: true });

  // Mic picks up candidate speech while audio is playing
  const duringPlayback = turn.handleServerContent(
    finalTranscript("Haan main ready hoon", "1s", "2s"),
    { isPlaybackActive: true },
  );
  assert.equal(duringPlayback.answer, null, "Must not advance while question audio is playing");

  // AI question playback completes physically from speakers
  turn.finishModelPlayback();

  // Now candidate answer is emitted cleanly after playback completes
  const afterPlayback = turn.handleServerContent(
    finalTranscript("Haan main ready hoon", "1s", "2s"),
    { isPlaybackActive: false },
  );
  assert.equal(afterPlayback.answer, "Haan main ready hoon");
});

test("finishModelPlayback resets candidate if question completed without interruption, or emits if interrupted", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();

  // Model finishes generating, audio is playing
  turn.handleServerContent({ turnComplete: true }, { isPlaybackActive: true });

  // Candidate mic activity arrives while audio is playing uninterrupted
  turn.handleServerContent(
    finalTranscript("Priya Sharma", "1s", "3s"),
    { isPlaybackActive: true },
  );

  // Audio queue ends normally: uninterrupted playback resets candidate to listening, does not treat playback noise as answer
  const normalEnd = turn.finishModelPlayback();
  assert.equal(normalEnd.answer, null, "Must not emit background mic during uninterrupted playback as answer");
  assert.equal(turn.phase(), "listening");

  // If candidate interrupted the question playback
  const turnInterrupted = createLiveInputTurn();
  turnInterrupted.beginModelTurn();
  turnInterrupted.interruptModelPlayback();
  turnInterrupted.handleServerContent(
    finalTranscript("Priya Sharma", "1s", "3s"),
    { isPlaybackActive: true },
  );
  const interruptedEnd = turnInterrupted.finishModelPlayback();
  assert.equal(interruptedEnd.answer, "Priya Sharma", "Interrupted turn emits candidate answer on playback end");
});

test("regression 1: complete answer is submitted only after candidate speech ends", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.finishModelPlayback();

  // Candidate speaks first part
  turn.handleServerContent({ interimInputTranscription: { text: "Mera naam" } });
  assert.equal(turn.isCandidateSpeaking(), true);
  assert.equal(turn.handleServerContent({
    inputTranscription: { text: "Mera naam", finished: false, startOffset: "1s", endOffset: "2s" },
  }).answer, null);

  // Candidate completes full answer
  const finalResult = turn.handleServerContent({
    inputTranscription: { text: "Mera naam Priya Sharma hai", finished: true, startOffset: "1s", endOffset: "4s" },
  });
  assert.equal(turn.isCandidateSpeaking(), false);
  assert.equal(finalResult.answer, "Mera naam Priya Sharma hai");
  assert.equal(turn.getTranscript(), "Mera naam Priya Sharma hai");
});

test("regression 2: speech resuming during settle window resets and merges into complete answer", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.finishModelPlayback();

  // First sentence completed
  turn.handleServerContent({
    inputTranscription: { text: "Main haircut", finished: true, startOffset: "1s", endOffset: "2s" },
  });
  assert.equal(turn.getTranscript(), "Main haircut");

  // Candidate pauses then continues within settle window
  turn.handleServerContent({ interimInputTranscription: { text: "aur facial karti hoon" } });
  assert.equal(turn.isCandidateSpeaking(), true);

  // Full merged sentence arrives
  turn.handleServerContent({
    inputTranscription: { text: "Main haircut aur facial karti hoon", finished: true, startOffset: "1s", endOffset: "5s" },
  });
  assert.equal(turn.isCandidateSpeaking(), false);
  assert.equal(turn.getTranscript(), "Main haircut aur facial karti hoon");
});

test("regression 3: partial transcription (finished === false or interim) never triggers submission", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.finishModelPlayback();

  // Interim event
  const interimResult = turn.handleServerContent({ interimInputTranscription: { text: "Haan" } });
  assert.equal(interimResult.answer, null);
  assert.equal(turn.isCandidateSpeaking(), true);

  // Unfinished final event (finished === false)
  const partialResult = turn.handleServerContent({
    inputTranscription: { text: "Haan main", finished: false, startOffset: "1s", endOffset: "2s" },
  });
  assert.equal(partialResult.answer, null);
  assert.equal(turn.isCandidateSpeaking(), true);
  assert.equal(turn.phase(), "listening");
});

test("regression 4: each completed answer is submitted exactly once", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.finishModelPlayback();

  // Candidate finishes speaking
  const result = turn.handleServerContent({
    inputTranscription: { text: "Do saal ka experience hai", finished: true, startOffset: "1s", endOffset: "3s" },
  });
  assert.equal(result.answer, "Do saal ka experience hai");

  // Settle timer fires and commits answer
  turn.commitAnswer();
  assert.equal(turn.phase(), "submitted");

  // Duplicate transcription or late turnComplete arrives
  const duplicateResult = turn.handleServerContent({
    inputTranscription: { text: "Do saal ka experience hai", finished: true, startOffset: "1s", endOffset: "3s" },
  });
  assert.equal(duplicateResult.answer, null);

  const turnCompleteResult = turn.handleServerContent({ turnComplete: true });
  assert.equal(turnCompleteResult.answer, null);
});

test("regression 5: question remains pending until backend response transitions turn", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.finishModelPlayback();

  // Candidate answers Question 1
  turn.handleServerContent({
    inputTranscription: { text: "Priya", finished: true, startOffset: "1s", endOffset: "2s" },
  });
  turn.commitAnswer();

  // While waiting for backend decision, turn is submitted and locked
  assert.equal(turn.phase(), "submitted");
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, null);

  // Only when backend hands off Question 2 does beginModelTurn start next turn
  turn.beginModelTurn();
  assert.equal(turn.phase(), "model");
  assert.equal(turn.getTranscript(), "");
});

test("Name confirmation audio completes before listening starts and accepts confirmation", () => {
  const turn = createLiveInputTurn();
  // Name confirmation turn begins
  turn.beginModelTurn();

  // Model generation produces chunks, turnComplete arrives while audio playback is active
  turn.handleServerContent({ turnComplete: true }, { isPlaybackActive: true });

  // Candidate confirmation utterance arriving while question audio is playing is ignored
  const premature = turn.handleServerContent(
    finalTranscript("Haan, yahi hai", "1s", "2s"),
    { isPlaybackActive: true },
  );
  assert.equal(premature.answer, null, "Must not accept confirmation while name confirmation question is speaking");

  // Name confirmation audio finishes playing
  turn.finishModelPlayback();
  assert.equal(turn.phase(), "listening", "Transitions to listening only after audio playback finishes");

  // Candidate confirms after audio completes
  const confirmed = turn.handleServerContent(
    finalTranscript("Haan, yahi hai", "2s", "3s"),
    { isPlaybackActive: false },
  );
  assert.equal(confirmed.answer, "Haan, yahi hai", "Accepts confirmation after audio playback finishes");
});

test("Single-word candidate name 'Rajesh' in interim transcript is captured and accessible via getTranscript", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.finishModelPlayback();

  // Interim transcript arrives first
  turn.handleServerContent({
    interimInputTranscription: { text: "Rajesh" },
  });
  assert.equal(turn.hasCandidateSpoken(), true);
  assert.equal(turn.getTranscript(), "Rajesh");

  // Final transcript arrives
  const finalResult = turn.handleServerContent({
    inputTranscription: { text: "Rajesh", finished: true, startOffset: "1s", endOffset: "2s" },
  });
  assert.equal(finalResult.answer, "Rajesh");
  assert.equal(turn.getTranscript(), "Rajesh");
});
