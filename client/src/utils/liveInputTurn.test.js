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
