import assert from "node:assert/strict";
import test from "node:test";
import { createLiveInputTurn } from "./liveInputTurn.js";

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

test("candidate final before response turnComplete waits for that response", () => {
  const turn = createLiveInputTurn();
  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.handleServerContent({ interimInputTranscription: { text: "My ans" } });

  assert.equal(
    turn.handleServerContent(finalTranscript("My answer", "4s", "5s")).answer,
    null,
  );
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    "My answer",
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
    null,
  );
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    "My answer",
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
  turn.handleServerContent({
    inputTranscription: {
      text: "I can travel",
      startOffset: "13s",
      endOffset: "15s",
      finished: true,
    },
  });

  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    "I can travel",
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
    null,
  );
  assert.equal(turn.handleServerContent({ turnComplete: true }).answer, "Yes");

  turn.beginModelTurn();
  turn.handleServerContent({ turnComplete: true });
  turn.handleServerContent({ interimInputTranscription: { text: "Yes" } });
  assert.equal(
    turn.handleServerContent(finalTranscript("Yes", "9s", "10s")).answer,
    null,
  );
  assert.equal(
    turn.handleServerContent({ turnComplete: true }).answer,
    "Yes",
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
