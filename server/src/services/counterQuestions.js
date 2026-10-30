/**
 * Handles candidate counter-questions, clarification inquiries, and out-of-scope policy requests
 * using grounded Urban Company salon-at-home facts without hallucinations or unsupported promises.
 */

function detectCounterQuestion(answer, question = {}, { language = "Hindi" } = {}) {
  if (typeof answer !== "string" || !answer.trim()) {
    return { isCounterQuestion: false };
  }

  const text = answer.trim();
  const normalized = text.toLowerCase();
  const isEnglish = language === "English";

  // 1. Travel / Location / Distance / "Nearby" inquiries
  const isNearbyQuery =
    /\b(?:nearby|paas\s+mein|aas\s*paas)\b/i.test(normalized) &&
    /\b(?:what|matlab|meaning|kya|samajh|kitna|distance|door|area|explain)\b/i.test(normalized);

  const isTravelQuestion =
    isNearbyQuery ||
    /\b(?:where\s+(?:would\s+i|do\s+i|to|should\s+i)\s+(?:need\s+to\s+travel|have\s+to\s+go|travel|go)|kahan\s+(?:travel\s+karna|jana)\s+(?:hoga|padega|hai)|kidhar\s+(?:travel\s+karna|jana)\s+(?:hoga|padega|hai)|kitn[aie]\s+door\s+(?:jana|travel|hoga|padega)|which\s+area.*(?:visit|go|travel)|kahan\s+hoga\s+kaam|kiske\s+ghar\s+jana)\b/i.test(
      normalized,
    ) ||
    (/\b(?:where|kahan|kidhar|which\s+area|kitn[aie]\s+door|how\s+far)\b/i.test(normalized) &&
      /\b(?:travel|jana|visit|go|location|distance|ghar|cluster)\b/i.test(normalized));

  if (isTravelQuestion) {
    const reply = isEnglish
      ? "In Urban Company, service appointments are at customer homes within a 3-4 km cluster of your local area. You do not need to travel far."
      : "Urban Company salon-at-home service hai, isliye bookings aapke local area ke 3-4 km cluster mein customer ke ghar par hoti hain. Aapko door nahi jana hota.";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "travel",
      reply,
    };
  }

  // 2. Specific Term or Concept Clarification (e.g. "unhappy customer", "customer handling")
  const isUnhappyCustomerQuery =
    /\b(?:unhappy\s+customer|naraz\s+grahak|shikayat)\b/i.test(normalized) &&
    /\b(?:what|matlab|meaning|kya|samajh|explain|kise|kaun)\b/i.test(normalized);

  if (isUnhappyCustomerQuery) {
    const reply = isEnglish
      ? "An unhappy customer is someone who is dissatisfied with a service, product, or experience, and needs their issue resolved politely."
      : "Unhappy customer ka matlab hai koi grahak jo kisi service ya product se santusht nahi hain aur unki baat sunkar solution dena hota hai.";
    return {
      isCounterQuestion: true,
      intent: "CLARIFICATION_REQUEST",
      topic: "term_clarification",
      reply,
    };
  }

  const isCustomerHandlingQuery =
    /\b(?:customer\s+handling)\b/i.test(normalized) &&
    /\b(?:what|matlab|meaning|kya|samajh|explain)\b/i.test(normalized);

  if (isCustomerHandlingQuery) {
    const reply = isEnglish
      ? "Customer handling means listening to the client politely, understanding their needs, and resolving any concern with patience."
      : "Customer handling ka matlab hai ki aap client se politely kaise baat karti hain aur agar koi complaint ho to use calmly kaise solve karti hain.";
    return {
      isCounterQuestion: true,
      intent: "CLARIFICATION_REQUEST",
      topic: "term_clarification",
      reply,
    };
  }

  // 3. General Question Clarification / Repetition inquiries
  const isGeneralClarificationQuery =
    /\b(?:what\s+do\s+you\s+mean|what\s+does\s+(?:that|this|it)\s+mean|kya\s+matlab|matlab\s+kya|iska\s+(?:kya\s+)?matlab|sawal\s+samajh|samajh\s+nahi\s+aaya|samajh\s+nahi\s+aa\s+raha|thoda\s+explain|explain\s+kar\s+sakte|can\s+you\s+explain|please\s+explain|iska\s+matlab\s+bataiye)\b/i.test(
      normalized,
    ) ||
    (/^\s*(?:samajh\s+nahi\s+aaya|kya\s+matlab|what\s+do\s+you\s+mean|explain\s+kijiye|please\s+explain|explain\s+karo)[.!?\s]*$/i.test(normalized));

  if (isGeneralClarificationQuery) {
    const reply = isEnglish
      ? "Let me explain simply. We want to understand your experience and response:"
      : "Aasaan shabdon mein, hum is baare mein aapka anubhav jaanna chahte hain:";
    return {
      isCounterQuestion: true,
      intent: "CLARIFICATION_REQUEST",
      topic: "question_clarification",
      reply,
    };
  }

  // 4. Age Requirement policy inquiries
  const isAgePolicyQuery =
    /\b(?:age\s+limit|minimum\s+age|umar\s+kitni|umar\s+kyun|why.*age|kitni\s+umar|age\s+requirement)\b/i.test(normalized);

  if (isAgePolicyQuery) {
    const reply = isEnglish
      ? "Urban Company requires all service partners to be at least 18 years of age."
      : "Urban Company ke saath partner banne ke liye kam se kam 18 saal ki umar honi chahiye.";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "age_policy",
      reply,
    };
  }

  // 5. Training inquiries
  const isTrainingQuery =
    /\b(?:training\s+(?:milegi|hogi|hoti|dete|karenge|kitne\s+din|provide)|(?:kya|do\s+you)\s+.*training|will\s+i\s+get\s+training|training\s+milegi\s+kya)\b/i.test(
      normalized,
    ) ||
    (/\btraining\b/i.test(normalized) && /\b(?:milegi|hogi|dete|provide|get|have)\b/i.test(normalized));

  if (isTrainingQuery) {
    const reply = isEnglish
      ? "Yes, Urban Company provides professional service and safety training to all selected partners after screening."
      : "Ji haan, screening clear karne ke baad Urban Company selected partners ko proper service aur safety training provide karti hai.";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "training",
      reply,
    };
  }

  // 6. Unavailable / Partner Team Information (Earnings, Salary, Exact timings, Joining)
  const isUnavailableInfoQuery =
    /\b(?:(?:salary|kamai|pay|payout)\s*(?:kitni|kitna|kya|milegi|hogi|hai|karegi)|kitn[aie]\s*(?:salary|kamai|paisa|paise|milega|milenge|hogi)|what\s+(?:is|will\s+be)\s+(?:the\s+)?salary|how\s+much\s+(?:can|will)\s+i\s+earn|joining\s+(?:date|kab)|kab\s+se\s+kaam\s+shuru|working\s+hours\s+(?:kya|kitne)|timing\s+kya\s+hai|kitne\s+baje\s+kaam)\b/i.test(
      normalized,
    ) ||
    (/\b(?:salary|earnings|kamai|payout|joining)\b/i.test(normalized) &&
      (/[?]$/.test(text) || /\b(?:milegi|kitni|kitna|kya|kab|how\s+much)\b/i.test(normalized)));

  if (isUnavailableInfoQuery) {
    const reply = isEnglish
      ? "I am the screening assistant, so exact earnings, payout structures, and onboarding schedules will be confirmed by the Urban Company partner team. Let's complete this question first:"
      : "Main screening assistant hoon, earnings, payout aur onboarding ki poori jaankari partner team aapse share karegi. Chaliye pehle ye sawal poora kar lete hain:";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "unavailable_info",
      reply,
    };
  }

  // 7. Interviewer Identity / Call Purpose / Recording inquiries
  const isIdentityQuery =
    /\b(?:aap\s+kaun\s+hain|aap\s+kaun\s+bol\s+rahi|who\s+are\s+you|who\s+is\s+speaking|kya\s+aap\s+ai|are\s+you\s+ai|are\s+you\s+a\s+robot|robot\s+ho\s+kya|recording\s+kyun|why\s+is\s+this\s+recorded|ye\s+kya\s+hai|what\s+is\s+this\s+interview)\b/i.test(
      normalized,
    );

  if (isIdentityQuery) {
    const reply = isEnglish
      ? "I am Urban Company's AI screening assistant conducting your preliminary evaluation. This interview is recorded solely for screening purposes. Let's continue with this question:"
      : "Main Urban Company ki AI screening assistant hoon. Ye interview sirf aapki basic qualification screening ke liye hai. Chaliye aage badhte hain:";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "identity",
      reply,
    };
  }

  // 8. Purpose of Question Inquiry (e.g. "Aap mujhse ye question kyun pooch rahe ho?")
  const isQuestionPurposeQuery =
    /\b(?:why\s+(?:are\s+you|do\s+you)\s+ask(?:ing)?|why\s+this\s+question|ye\s+(?:question|sawal)\s+kyun|kyun\s+pooch\s+rahe\s+ho|kyun\s+puch\s+rahe\s+ho|kyun\s+poocha|ye\s+kyun\s+poocha|ye\s+sawal\s+kyun|kyun\s+poochte\s+ho|is\s+sawal\s+ka\s+kya\s+matlab|ye\s+puchne\s+ki\s+kya\s+zaroorat)\b/i.test(
      normalized,
    ) ||
    (/\b(?:question|sawal)\b/i.test(normalized) &&
      /\b(?:kyun|kyu|why)\b/i.test(normalized));

  if (isQuestionPurposeQuery) {
    const reply = isEnglish
      ? "We ask this question to understand your experience, skills, and preferences so we can match you with the right bookings. Let's return to the question:"
      : "Ye sawal hum isliye pooch rahe hain taaki aapke experience, skills aur preferences ko samajh sakein aur aapko sahi bookings mil sakein. Chaliye is sawal par wapas aate hain:";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "question_purpose",
      reply,
    };
  }

  // 9. Customer Complaint / Scenario Handling Inquiry
  const isComplaintHandlingQuery =
    /\b(?:agar\s+customer\s+(?:complain|shikayat|naraz)|if\s+(?:a\s+)?customer\s+complains?|complain\s+kare\s+toh|kya\s+karna\s+(?:hoga|padega)|what\s+(?:to\s+do|should\s+i\s+do)\s+if\s+customer)\b/i.test(
      normalized,
    ) &&
    /\b(?:customer|client|grahak|complain|shikayat|naraz)\b/i.test(normalized);

  if (isComplaintHandlingQuery) {
    const reply = isEnglish
      ? "In Urban Company, we listen politely to resolve customer concerns and partner support is always available. But in this question, we want to know what you would personally do:"
      : "Urban Company mein hum customer ki baat shanti se sunkar solve karte hain aur partner support bhi madad karta hai. Par is sawal mein hum jaanna chahte hain ki aap aisi sthiti mein kya karengi:";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "complaint_handling",
      reply,
    };
  }

  // 10. General question inquiring about other company policies
  const isPolicyQuery =
    /[?]$/.test(text) &&
    /\b(?:company|urban\s+company|rule|policy|leaves?|chhutti|dress\s*code|kit|bag)\b/i.test(normalized);

  if (isPolicyQuery) {
    const reply = isEnglish
      ? "I cannot confirm the exact policy on that as I am the screening assistant, but our onboarding team will provide full details after screening. Let's return to the question:"
      : "Main screening assistant hoon, is baare mein exact jaankari hamari partner onboarding team aapse share karegi. Chaliye wapas apne sawal par aate hain:";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "policy_query",
      reply,
    };
  }

  return { isCounterQuestion: false };
}

module.exports = {
  detectCounterQuestion,
};
