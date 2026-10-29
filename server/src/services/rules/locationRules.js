function classifyLocation(answer) {
  const text = answer.trim().toLowerCase();

  // An empty, vague, or irrelevant response needs clarification.
  const irrelevantPattern =
    /\b(?:biryani|pizza|burger|cricket|movie|movies|anime|song|songs|dance|dancing|gaana|khana|aaloo|aloo|potato|football|habba\s+jabba|bla\s+bla|asdf|qwerty|chair|table|desk|sofa|bed|furniture|mobile|phone|smartphone|laptop|computer|tablet|pen|pencil|paper|book|bottle|cup|glass|plate|spoon|fork|fan|light|tv|television|ac|fridge|refrigerator|door|window|wall|floor|roof|cat|dog|billi|kutta|animal|bird|clothes|shirt|pant|shoes|chappal|samosa|chai|tea|coffee|ice\s*cream|zxcv|foo|bar|baz|qux|test|testing|kuch\s+bhi|koi\s+bhi|random)\b/i;

  const isOnlyVehicle =
    /^(?:car|bike|scooty|scooter|bus|metro|auto|train|gaadi|two\s*wheeler)[.!?\s]*$/i.test(text);

  const hasRepeatedChars = /(.)\1{2,}/u.test(text);

  if (
    !text ||
    text.length < 2 ||
    /^(pata nahi|not sure|don't know|dont know|samajh nahi aaya)[.!?]*$/i.test(
      text,
    ) ||
    irrelevantPattern.test(text) ||
    isOnlyVehicle ||
    hasRepeatedChars
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
    /nahi ja sakti/,
    /nahi ja sakta/,
    /nahi kar sakti/,
    /nahi kar sakta/,
    /^(नहीं|नही)[.!?।]*$/,
    /नहीं.*(जा|कर|शिफ्ट|ट्रैवल|यात्रा|रिलोकेट)/,
    /नही.*(जा|कर|शिफ्ट|ट्रैवल|यात्रा|रिलोकेट)/,
    /relocate nahi kar/,
    /shift nahi ho sakti/,
    /travel karna possible nahi/,
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

    // Hindi / Hinglish affirmative answers
    /haan.*(kar sakti|kar sakta|ja sakti|ja sakta)/,
    /han.*(kar sakti|kar sakta|ja sakti|ja sakta)/,
    /हाँ.*(कर सकती|कर सकता|जा सकती|जा सकता)/,
    /हां.*(कर सकती|कर सकता|जा सकती|जा सकता)/,
    /ज़रूरत पड़ने पर.*(जा सकती|जा सकता|शिफ्ट)/,
    /जरूरत पड़ने पर.*(जा सकती|जा सकता|शिफ्ट)/,
    /आवश्यकता पड़ने पर.*(जा सकती|जा सकता|शिफ्ट)/,
    /शिफ्ट हो सकती/,
    /शिफ्ट हो सकता/,
    /रिलोकेट कर सकती/,
    /रिलोकेट कर सकता/,
    /ट्रैवल कर सकती/,
    /ट्रैवल कर सकता/,
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
