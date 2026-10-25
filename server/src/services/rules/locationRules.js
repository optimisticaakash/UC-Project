function classifyLocation(answer) {
  const text = answer.trim().toLowerCase();

  // An empty or vague response needs clarification.
  if (
    !text ||
    /^(pata nahi|not sure|don't know|dont know|samajh nahi aaya)[.!?]*$/i.test(
      text,
    )
  ) {
    return {
      outcome: "clarification",
      area: null,
      travelWillingness: "unknown",
      followUp: null,
      manualReviewRequired: false,
      message: "Please tell me which area you live in.",
    };
  }

  // Do not infer exact distance or proximity from the answer.
  const unwillingPatterns = [
    /sirf apne area mein/,
    /sirf apne area tak/,
    /door nahi ja/,
    /travel nahi kar/,
    /shift nahi kar/,
    /move nahi kar/,
    /not willing to travel/,
    /cannot travel/,
    /can't travel/,
    /not willing to move/,
  ];

  const willingPatterns = [
    /travel kar sak/,
    /door bhi ja/,
    /shift ho sak/,
    /shift kar sak/,
    /move kar sak/,
    /ready to travel/,
    /willing to travel/,
    /willing to move/,
    /can travel/,
    /can relocate/,
  ];

  const unwilling = unwillingPatterns.some((pattern) => pattern.test(text));
  const willing = willingPatterns.some((pattern) => pattern.test(text));

  if (unwilling && willing) {
    return {
      outcome: "clarification",
      area: answer.trim(),
      travelWillingness: "unclear",
      followUp: null,
      manualReviewRequired: false,
      message:
        "Could you clarify whether you are willing to travel or relocate?",
    };
  }

  if (unwilling) {
    return {
      outcome: "manual_review",
      area: answer.trim(),
      travelWillingness: "no",
      followUp: null,
      manualReviewRequired: true,
      message:
        "Location and travel preference captured for manual proximity review.",
    };
  }

  if (willing) {
    return {
      outcome: "manual_review",
      area: answer.trim(),
      travelWillingness: "yes",
      followUp: "move_timeline",
      manualReviewRequired: true,
      message:
        "Location captured. Ask when the candidate could relocate if needed.",
    };
  }

  return {
    outcome: "manual_review",
    area: answer.trim(),
    travelWillingness: "unknown",
    followUp: "travel_clarification",
    manualReviewRequired: true,
    message: "Location captured. Clarify travel or relocation willingness.",
  };
}

module.exports = { classifyLocation };
