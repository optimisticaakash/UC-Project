import { createElement } from "react";
import { candidateCompletionMessage } from "../utils/internalAssessment.js";

export default function CandidateCompletion({ outcome = "completed" }) {
  const content = outcome === "terminated"
    ? ["Interview terminated", "The interview has ended because a relevant response was not provided after repeated warnings."]
    : outcome === "manual_review"
      ? ["Manual review required", "Our team will review your response."]
      : outcome === "end_unconfirmed"
        ? ["Interview status unavailable", "Please contact support for help."]
        : outcome === "completed"
          ? ["Interview completed", candidateCompletionMessage]
          : ["Interview ended", "Thank you. The interview has ended."];
  return createElement(
    "section",
    { "aria-live": "polite", className: "uc-candidate-completion" },
    createElement("h1", null, content[0]),
    createElement("p", null, content[1]),
  );
}
