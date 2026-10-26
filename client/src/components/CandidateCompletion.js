import { createElement } from "react";
import { candidateCompletionMessage } from "../utils/internalAssessment.js";

export default function CandidateCompletion({ endedEarly = false }) {
  return createElement(
    "section",
    { "aria-live": "polite", className: "uc-candidate-completion" },
    createElement("h1", null, endedEarly ? "Interview ended" : "Interview complete"),
    createElement("p", null, endedEarly
      ? "धन्यवाद। आपका इंटरव्यू समाप्त हो गया है।"
      : candidateCompletionMessage),
  );
}
