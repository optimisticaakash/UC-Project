/**
 * Handles candidate counter-questions, clarification inquiries, and out-of-scope policy requests
 * using grounded Urban Company salon-at-home facts without hallucinations or unsupported promises.
 */

const { classifyLanguage } = require("./rules/consentRules");

function isEnglishRequestToAsk(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const clean = text.trim().toLowerCase().replace(/[.,?!।]/g, " ").replace(/\s+/g, " ").trim();
  return (
    /^(?:can|could|may)\s+i\s+(?:please\s+)?ask\s+(?:you\s+)?(?:a\s+question|something|a\s+query|a\s+doubt|one\s+question)?[.!?\s]*$/i.test(clean) ||
    /^(?:i\s+have|i've\s+got)\s+(?:a\s+question|a\s+doubt|a\s+query|one\s+question|some\s+questions|a\s+clarification|another\s+question|another\s+doubt|one\s+more\s+question|one\s+more\s+doubt)[.!?\s]*$/i.test(clean) ||
    /^(?:i\s+wanted\s+to|i\s+want\s+to|wanted\s+to|just\s+wanted\s+to)\s+ask\s+(?:you\s+)?(?:a\s+question|something|a\s+query|one\s+question|another\s+question)?[.!?\s]*$/i.test(clean) ||
    /^(?:can|could|would)\s+you\s+(?:please\s+)?clarify\s+something[.!?\s]*$/i.test(clean) ||
    /^(?:can\s+i\s+ask\s+something|i\s+have\s+a\s+question|i\s+wanted\s+to\s+ask\s+something|can\s+you\s+clarify\s+something|can\s+i\s+ask\s+a\s+question)[.!?\s]*$/i.test(clean) ||
    /^(?:(?:wait|hold\s+on|not\s+yet)\s+)?(?:i\s+have|i\s+still\s+have|there\s+is|one\s+more|another)\s+(?:a\s+|another\s+|one\s+more\s+)?(?:question|doubt|query)[.!?\s]*$/i.test(clean) ||
    /^(?:one\s+more|another)\s+(?:question|doubt|query)[.!?\s]*$/i.test(clean)
  );
}

function isRequestToAskQuestion(answer, { language = "Hindi" } = {}) {
  if (typeof answer !== "string" || !answer.trim()) return false;
  const raw = answer.trim();
  const clean = raw.toLowerCase().replace(/[.,?!।]/g, " ").replace(/\s+/g, " ").trim();

  // If the utterance has an actual question attached, e.g. "ki cloud computing kya hai"
  // or "what is cloud computing" or question words with substantive content, let it be an actual question.
  const hasEmbeddedQuestion =
    /\b(?:ki|that|about|regarding)\s+(?:kya|kyun|kyu|kaise|kahan|kidhar|kitna|kitni|kitne|what|why|how|where|when|who)\b/i.test(clean) ||
    /\b(?:poochna\s+tha|poochhna\s+tha|poochna\s+hai|poochhna\s+hai|ask\s+something|ask\s+a\s+question)\s+(?:ki|that|what|how|why|where|when|kya|kyun|kaise|kahan)\b/i.test(clean);

  if (hasEmbeddedQuestion) {
    return false;
  }

  // 1. English variations
  if (isEnglishRequestToAsk(clean)) return true;

  // 2. Hindi / Hinglish variations
  const isHindiRequest =
    /\b(?:mujhe|humein|hume|mera|meri|humara)\s+(?:ek|1|kuch|kuchh)?\s*(?:question|sawal|sawaal|doubt|query|baat|cheez)\s*(?:poochhna|poochna|puchna|puchhna|hai|tha|thi)\b/i.test(clean) ||
    /^(?:ek|1)\s+(?:question|sawal|sawaal|doubt|query|baat|cheez)\s+(?:hai|tha|thi|poochna|poochhna|poochni|poochhni|puchna|puchhna|puchni|puchhni)\b/i.test(clean) ||
    /\b(?:kya\s+)?(?:main|hum)\s*(?:aapse\s*)?(?:ek\s*)?(?:question|sawal|sawaal|doubt|query|kuch|kuchh)\s*(?:pooch|poochh|puch|puchh)(?:h)?\s*(?:sakta|sakti|sakte)\s*(?:hoon|hain|hu)?\b/i.test(clean) ||
    /^(?:kuch|kuchh)\s+(?:poochna|poochhna|puchna|puchhna)\s*(?:hai|tha|chahta|chahti|chahata|chahati)?\b/i.test(clean) ||
    /\b(?:mera|meri)\s+(?:ek|1)?\s*(?:question|sawal|sawaal|doubt|query)\s*(?:hai|tha)\b/i.test(clean) ||
    /\b(?:question|sawal|sawaal|doubt)\s+(?:pooch|poochh|puch|puchh)(?:h)?\s*(?:sakta|sakti|sakte)\s*(?:hoon|hain|hu)?\b/i.test(clean) ||
    /\b(?:abhi\s+)?(?:nahi\s+)?(?:ek\s+aur|aur\s+ek|doosra|dusra)\s+(?:question|sawal|sawaal|doubt|query|baat|cheez)\s*(?:hai|tha|thi|poochna|poochhna|poochni|poochhni)?\b/i.test(clean) ||
    /\b(?:ek\s+aur|aur\s+ek)\s+(?:question|sawal|sawaal|doubt|query)\b/i.test(clean) ||
    /\b(?:ek\s+)?(?:doubt|question|sawal|sawaal)\s+aur\s+hai\b/i.test(clean) ||
    /\b(?:ruko|rukiye|wait|hold\s+on)[,\s]+(?:ek\s+)?(?:question|sawal|sawaal|doubt)\s*(?:hai|tha|poochna)?\b/i.test(clean) ||
    /\b(?:abhi\s+bhi|abhi\s+ek)\s+(?:doubt|sawal|sawaal|question)\s+hai\b/i.test(clean);

  if (isHindiRequest) return true;

  return false;
}

function isCandidateDecidingNotToAsk(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const clean = text.trim().toLowerCase().replace(/[.,?!।]/g, " ").replace(/\s+/g, " ").trim();
  return (
    /^(?:nahi|nahin|no|nope|leave\s+it|nothing|never\s*mind|rehne\s+do|rehne\s+dijiye|kuch\s+nahi|kuchh\s+nahi|kuch\s+bhi\s+nahi|chhodo|chodo|it's\s+okay|its\s+okay|no\s+nothing|koi\s+baat\s+nahi|kuch\s+na)[.!?\s]*$/i.test(clean) ||
    /\b(?:kuch\s+nahi\s+poochna|kuch\s+nahi\s+poochhna|nahi\s+poochna|nahi\s+poochhna|rehne\s+do|leave\s+it|never\s*mind|koi\s+sawal\s+nahi|no\s+questions?|no\s+doubts?|koi\s+doubt\s+nahi)\b/i.test(clean)
  );
}

function detectCounterQuestion(answer, question = {}, { language = "Hindi", activeInquiry = null } = {}) {
  if (typeof answer !== "string" || !answer.trim()) {
    return { isCounterQuestion: false };
  }

  const text = answer.trim();
  const normalized = text.toLowerCase();
  const isEnglish = language === "English" || (
    language !== "Hindi" &&
    /^[a-z0-9\s.,?!'"-]+$/i.test(text) &&
    /\b(?:what|why|who|where|how|is|are|can|could|please|purpose|screening|interview|question|something|doubt)\b/i.test(normalized) &&
    !/\b(?:hai|hain|kya|kyun|kyu|kaun|kaise|kahan|kidhar|karna|hoga|padega|mein|me|meri|mera)\b/i.test(normalized)
  );

  // 0. Permission to ask a question (REQUEST_TO_ASK_QUESTION)
  if (isRequestToAskQuestion(text, { language })) {
    const isEnglishReq = isEnglish || isEnglishRequestToAsk(text);
    const reply = isEnglishReq
      ? "Sure, please go ahead and ask your question. I am here to help."
      : "Ji haan, bilkul poochiye, aap apna question poochhiye. Main aapki madad karti hoon.";
    return {
      isCounterQuestion: true,
      isRequestToAskQuestion: true,
      intent: "REQUEST_TO_ASK_QUESTION",
      topic: "candidate_question_request",
      reply,
      isEnglish: isEnglishReq,
    };
  }

  // 1. Travel / Location / Distance / "Nearby" inquiries
  const isCityResidencyOrRelocationQuery =
    /\b(?:kya\s+(?:bangalore|bengaluru|is\s+sheher|sheher|city)\s*(?:mein\s*)?(?:rehna|hona|ka\s+hona)\s*(?:hi\s*)?zaroori\s*hai|(?:bangalore|bengaluru|is\s+sheher|sheher|city)\s*(?:mein\s*)?(?:rehna|hona|ka\s+hona)\s*(?:hi\s*)?zaroori\s*hai|kya\s+(?:bangalore|bengaluru)\s*(?:hi\s*)?(?:zaroori|compulsory|mandatory)\s*hai|bangalore\s*(?:hi\s*)?(?:zaroori|compulsory|mandatory)\s*hai|is\s+(?:living|staying|being|residing)\s+in\s+bangalore\s+(?:mandatory|compulsory|necessary|required)|is\s+bangalore\s+(?:mandatory|compulsory|necessary|required)|do\s+i\s+have\s+to\s+(?:live|stay|be)\s+in\s+bangalore|do\s+i\s+need\s+to\s+(?:live|stay|be)\s+in\s+bangalore|is\s+it\s+mandatory\s+to\s+(?:live|stay|be)\s+in\s+bangalore|is\s+it\s+compulsory\s+to\s+(?:live|stay|be)\s+in\s+bangalore|bangalore\s+mein\s+hi\s+rehna\s+padega|bangalore\s+me\s+rehna\s+jaruri\s+hai|bangalore\s+me\s+rehna\s+zaroori\s+hai|bangalore\s+mein\s+rehna\s+zaroori|bangalore\s+mein\s+rehna\s+jaruri|bangalore\s+mein\s+rehna\s+compulsory)\b/i.test(normalized) ||
    (/\b(?:kya|is|do\s+i|why)\b/i.test(normalized) && /\b(?:bangalore|bengaluru)\b/i.test(normalized) && /\b(?:rehna|stay|live|zaroori|zaruri|compulsory|mandatory|required)\b/i.test(normalized));

  if (isCityResidencyOrRelocationQuery) {
    const reply = isEnglish
      ? "Urban Company bookings take place in local service areas. Cross-city eligibility, active service areas, and relocation requirements are confirmed by the Urban Company onboarding team. Could you please clarify if you are open to working in Bangalore, or prefer your current city?"
      : "Urban Company bookings local service areas mein hoti hain. Cross-city eligibility, active service areas aur relocation requirements Urban Company onboarding team confirm karti hai. Kripya spasht karein ki kya aap Bangalore mein kaam karne ke liye open hain, ya apne sheher mein hi kaam karna chahte hain?";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "location_requirement",
      reply,
    };
  }

  const isAccommodationQuery =
    (/\b(?:accommodation|stay|living\s+facility|living\s+support)\b/i.test(normalized) &&
      /\b(?:provide|provide\s+kart[ie]|mileg[ai]|milta|milti|mile|deti|dete|hai|hoga|hogi|free|facility|arrangement|consider)\b/i.test(normalized)) ||
    /\b(?:kya\s+)?(?:rehne\s+ki\s+(?:jagah|suvidha|vyavastha)|accommodation)\s*(?:bhi\s*)?(?:mileg[ai]|hoti|hoga|hogi|milti|milta|mile|provide|dete|deti|karegi|karta|consider)\b/i.test(normalized) ||
    /\b(?:company|urban\s+company)\s+(?:rehne\s+ki\s+jagah|accommodation)\s+(?:degi|deti|provide)\b/i.test(normalized) ||
    /\b(?:does|will)\s+(?:urban\s+company|the\s+company|uc)\s+provide\s+(?:accommodation|stay|housing)\b/i.test(normalized) ||
    /\b(?:agar\s+accommodation\s+mile|if\s+accommodation\s+is\s+provided)\b/i.test(normalized);

  if (isAccommodationQuery) {
    const reply = isEnglish
      ? "Urban Company does not offer guaranteed company accommodation during preliminary screening. Cross-city transfer policies and relocation support details are confirmed directly by the Urban Company onboarding team."
      : "Urban Company screening ke dauran accommodation ya rehne ki suvidha ki guarantee nahi hoti hai. Cross-city eligibility aur relocation support se judi jaankari onboarding team confirm karti hai.";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "location_requirement",
      reply,
    };
  }

  const isConditionalOpportunityQuery =
    /\b(?:agar\s+(?:bangalore|bengaluru|dusre\s+sheher|dusri\s+city)\s+mein\s+opportunity\s+mile|if\s+(?:i\s+get\s+an?\s+|there\s+is\s+an?\s+)?opportunity\s+in\s+bangalore|what\s+if\s+there\s+is\s+an\s+opportunity)\b/i.test(normalized);

  if (isConditionalOpportunityQuery) {
    const reply = isEnglish
      ? "Urban Company service bookings depend on local customer demand. If you are open to opportunities in Bangalore, the onboarding team will evaluate cross-city options with you. Could you clarify your preference?"
      : "Urban Company mein bookings local customer demand par depend karti hain. Agar aap Bangalore mein opportunity ke liye open hain, toh onboarding team aapse options discuss karegi. Kripya apni preference spasht karein.";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "location_requirement",
      reply,
    };
  }

  const isNearbyQuery =
    /\b(?:nearby|paas\s+mein|aas\s*paas)\b/i.test(normalized) &&
    /\b(?:what|matlab|meaning|kya|samajh|kitna|distance|door|area|explain)\b/i.test(normalized);

  const isTravelQuestion =
    isNearbyQuery ||
    /^(?:how\s+far(?:\s+is\s+it)?|kitn[aie]\s+door|kitna\s+distance|how\s+much\s+distance)[.!?\s]*$/i.test(normalized) ||
    /\b(?:where\s+(?:would\s+i|do\s+i|to|should\s+i|can\s+i)?\s*(?:need\s+to\s+travel|have\s+to\s+go|need\s+to\s+relocate|have\s+to\s+relocate|need\s+to\s+shift|have\s+to\s+shift|travel|relocate|shift|go)|kahan\s+(?:travel\s+karna|jana|jaana|shift\s+hona|relocate\s+karna)\s+(?:hoga|padega|hai)|kidhar\s+(?:travel\s+karna|jana|jaana|shift\s+hona|relocate\s+karna)\s+(?:hoga|padega|hai)|kitn[aie](?:\s+door)?\s+(?:jana|jaana|travel|hoga|padega|shift)|which\s+area.*(?:visit|go|travel|relocate|shift)|kahan\s+hoga\s+kaam|kaam\s+kahan\s+hoga|kaam\s+kahan|kiske\s+ghar\s+jana)\b/i.test(
      normalized,
    ) ||
    /\b(?:travel\s+karna\s+(?:hoga|padega|hai)|travel\s+kaise|kaise\s+travel|relocate\s+karna\s+(?:hoga|padega|hai)|shift\s+hona\s+(?:hoga|padega|hai)|is\s+relocation\s+compulsory|relocation\s+zaroori\s+hai|relocate\s+karna\s+zaroori\s+hai|do\s+i\s+have\s+to\s+(?:relocate|shift|move)|do\s+i\s+need\s+to\s+(?:relocate|shift|move)|have\s+to\s+(?:relocate|shift|move)|need\s+to\s+(?:relocate|shift|move)|must\s+i\s+(?:relocate|shift|move)|shift\s+cities|relocate\s+cities|move\s+cities|doosre\s+sheher|dusre\s+sheher)\b/i.test(
      normalized,
    ) ||
    (/\b(?:where|kahan|kidhar|which\s+area|kis\s+area|kaunse?\s+area|kitn[aie](?:\s+door)?|how\s+far|why|kyun|kyu|does\s+this\s+mean|do\s+i|will\s+i|would\s+i|kya\s+mujhe|kya\s+humein)\b/i.test(normalized) &&
      /\b(?:travel|relocate|relocation|shift|shifting|move|moving|jana|jaana|visit|go|location|distance|ghar|cluster|kaam|work|cities|city)\b/i.test(normalized));

  if (isTravelQuestion) {
    const reply = isEnglish
      ? "In Urban Company, service appointments are at customer homes in nearby local areas. Relocation and specific work zones are discussed with the onboarding team."
      : "Urban Company salon-at-home service hai, isliye bookings aapke aas-paas ke local area mein customer ke ghar par hoti hain. Travel zones aur relocation ki jaankari onboarding team aapse discuss karegi.";
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
  const isRepeatQuery =
    /\b(?:repeat\s+(?:the\s+)?(?:question|sawal)|can\s+you\s+repeat|could\s+you\s+repeat|please\s+repeat|repeat\s+kijiye|repeat\s+karein|repeat\s+kar\s+do|repeat\s+karo|dobara\s+(?:boliye|bataiye|poochiye|puchiye|kahiye|repeat)|phir\s+se\s+(?:boliye|bataiye|poochiye|puchiye|kahiye|repeat)|ek\s+baar\s+(?:aur|phir\s+se|dobara)?\s*(?:boliye|bataiye|repeat\s+kijiye|repeat\s+karein)|pardon(?:\s+me)?)\b/i.test(
      normalized,
    ) ||
    /^\s*(?:repeat(?:\s+the\s+question)?|repeat\s+please|please\s+repeat|dobara|phir\s+se|pardon)[.!?\s]*$/i.test(normalized);

  const isGeneralClarificationQuery =
    isRepeatQuery ||
    /\b(?:what\s+do\s+you\s+mean|what\s+does\s+(?:that|this|it)\s+mean|what\s+are\s+you\s+asking|kya\s+matlab|matlab\s+kya|iska\s+(?:kya\s+)?matlab|(?:sawal|question)\s+samajh|samajh\s+nahi\s+aaya|samajh\s+nahi\s+aa\s+raha|(?:aap\s+)?kya\s+p(?:oo|u)ch\s+rahe\s+(?:ho|hain|hai)|thoda\s+explain|explain\s+kar|can\s+you\s+explain|please\s+explain|iska\s+matlab\s+bataiye|thoda\s+aur\s+bataiye)\b/i.test(
      normalized,
    ) ||
    /^\s*(?:samajh\s+nahi\s+aaya|kya\s+matlab|what\s+do\s+you\s+mean|explain\s+kijiye|explain\s+kariye|please\s+explain|explain\s+karo|kya\s+p(?:oo|u)ch\s+rahe\s+(?:ho|hain|hai))[.!?\s]*$/i.test(
      normalized,
    );

  if (isGeneralClarificationQuery) {
    if (isRepeatQuery) {
      const reply = isEnglish
        ? "Certainly, let me repeat the question:"
        : "Bilkul, main sawal dobara poochhti hoon:";
      return {
        isCounterQuestion: true,
        intent: "CLARIFICATION_REQUEST",
        topic: "repeat_question",
        reply,
      };
    }

    const qId = question.id || question.Step || "";
    let reply;
    if (qId === "A0") {
      reply = isEnglish
        ? "In simple words, we want to know if you agree to this screening interview:"
        : "Aasaan shabdon mein, hum sirf ye jaanna chahte hain ki kya aap is screening interview ke liye taiyaar hain:";
    } else if (qId === "A1") {
      reply = isEnglish
        ? "In simple words, please tell us which city and local area you live in:"
        : "Aasaan shabdon mein, kripya batayein ki aap kis sheher aur local area mein rehti hain:";
    } else if (qId === "A2") {
      reply = isEnglish
        ? "In simple words, please tell me your age in years."
        : "Aasaan shabdon mein, kripya apni umar saal mein batayein.";
    } else if (qId === "A2_NAME_CONFIRM") {
      reply = isEnglish
        ? "We just want to confirm whether this is your correct full name:"
        : "Hum sirf ye confirm karna chahte hain ki kya ye aapka sahi naam hai:";
    } else if (qId === "A9") {
      reply = isEnglish
        ? "In simple words, are you able to travel to customer homes in nearby local areas for salon services?"
        : "Aasaan shabdon mein, kya aap apne local area mein customer ke ghar jakar salon service dene ke liye comfortable hain?";
    } else {
      reply = isEnglish
        ? "Let me explain simply. We want to understand your experience and response:"
        : "Aasaan shabdon mein, hum is baare mein aapka anubhav jaanna chahte hain:";
    }

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
      subIntent: "QUESTION_RATIONALE_INQUIRY",
      topic: "age_policy",
      reply,
    };
  }

  // 5. Training inquiries
  const isTrainingQuery =
    /\b(?:training\s+(?:milegi|hogi|hoti|dete|karenge|kitne\s+din|provide|kahan|online|offline|center)|(?:kya|do\s+you)\s+.*training|will\s+i\s+get\s+training|training\s+milegi\s+kya)\b/i.test(
      normalized,
    ) ||
    (/\btraining\b/i.test(normalized) && /\b(?:milegi|hogi|dete|provide|get|have|kahan|online|offline|center|centre|where)\b/i.test(normalized));

  if (isTrainingQuery) {
    const isLocationOrFormat = /\b(?:kahan|online|offline|center|centre|where)\b/i.test(normalized);
    const reply = isEnglish
      ? (isLocationOrFormat
          ? "Training is provided through partner training centers and digital modules after screening."
          : "Yes, Urban Company provides professional service and safety training to all selected partners after screening.")
      : (isLocationOrFormat
          ? "Screening ke baad Urban Company partner training center aur digital modules ke through training deti hai."
          : "Ji haan, screening clear karne ke baad Urban Company selected partners ko proper service aur safety training provide karti hai.");
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
    /\b(?:aap\s+kaun\s+hain|aap\s+kaun\s+bol\s+rahi|who\s+are\s+you|who\s+is\s+speaking|kya\s+aap\s+ai|are\s+you\s+ai|are\s+you\s+a\s+robot|robot\s+ho\s+kya|recording\s+kyun|why\s+is\s+this\s+recorded|ye\s+kya\s+hai|what\s+is\s+this\s+interview|ye\s+(?:screening|interview|call)\s+(?:kis\s+liye|kyun|kyu|kis\s+baare\s+mein|kisliye)|(?:screening|interview|call)\s+(?:kis\s+liye|kyun|kyu|kisliye)|what\s+is\s+this\s+(?:screening|call|interview)\s+(?:for|about)|purpose\s+of\s+(?:this\s+)?(?:screening|interview|call)|why\s+(?:is\s+)?this\s+screening)\b/i.test(
      normalized,
    );

  if (isIdentityQuery) {
    const isA0 = (question.id || question.Step) === "A0";
    const reply = isEnglish
      ? (isA0
          ? "I am Urban Company's AI screening assistant conducting your preliminary evaluation for salon-at-home services."
          : "I am Urban Company's AI screening assistant conducting your preliminary evaluation. This interview is recorded solely for screening purposes. Let's continue with this question:")
      : (isA0
          ? "Main Urban Company ki AI screening assistant hoon. Ye interview aapki basic qualification screening ke liye hai."
          : "Main Urban Company ki AI screening assistant hoon. Ye interview sirf aapki basic qualification screening ke liye hai. Chaliye aage badhte hain:");
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "identity",
      reply,
      isEnglish: Boolean(isEnglish),
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
      subIntent: "QUESTION_RATIONALE_INQUIRY",
      topic: "question_purpose",
      reply,
    };
  }

  // 9. Customer Complaint / Scenario Handling Inquiry
  const isComplaintHandlingQuery =
    /\b(?:agar\s+customer\s+(?:complain|shikayat|naraz|angry|gussa|upset)|if\s+(?:a\s+)?customer\s+(?:complains?|is\s+angry|gets\s+angry)|complain\s+kare\s+toh|gussa\s+kare\s+toh|angry\s+ho\s+toh|kya\s+karna\s+(?:hoga|padega)|what\s+(?:to\s+do|should\s+i\s+do)\s+if\s+customer)\b/i.test(
      normalized,
    ) &&
    /\b(?:customer|client|grahak|complain|shikayat|naraz|angry|gussa|upset)\b/i.test(normalized);

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

  // 10b. Equipment / Uniform / Kit / Products inquiry
  const isEquipmentQuery =
    /\b(?:uniform|kit|bag|samaan|samagri|tools|equipment|products?|dress\s*code)\b/i.test(normalized) &&
    /\b(?:kya|khud|chahiye|khareedna|lana|milegi|milega|dete|dena|provide|buy|bring|own)\b/i.test(normalized);

  if (isEquipmentQuery) {
    const reply = isEnglish
      ? "Urban Company provides standard service kits and uniforms to partners after onboarding. Details are explained during onboarding."
      : "Urban Company onboarding ke dauran service kit aur uniform provide karti hai. Iski poori jaankari onboarding ke samay di jaati hai.";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "equipment",
      reply,
    };
  }

  // 11. Verification / ID proof inquiries
  const isVerificationDocsQuery =
    /\b(?:document|documents|id\s+proof|aadhaar|voter\s*id|pan\s*card|certificate|qualification|paper)\b/i.test(normalized) &&
    /\b(?:kya|kaun|chahiye|lagega|lagte|dena|submit|verify|verification|upload|dikha|chalega)\b/i.test(normalized);

  if (isVerificationDocsQuery) {
    const reply = isEnglish
      ? "Urban Company requires a valid government photo ID and basic qualification details for partner verification. Let's continue with our question:"
      : "Urban Company partner verification ke liye valid government photo ID aur basic details zaroori hoti hain. Chaliye aage badhte hain:";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "verification_docs",
      reply,
    };
  }

  // 11b. Candidate permission to ask a question / inquiry request (e.g. "Can I ask a question?", "Mujhe ek sawal poochna hai")
  const isQuestionPermissionRequest =
    /^(?:i\s+have\s+(?:a|one)\s+question|i\s+want\s+to\s+ask\s+(?:a\s+)?question|can\s+i\s+ask\s+(?:a\s+)?question|may\s+i\s+ask\s+(?:a\s+)?question|can\s+i\s+ask\s+something|may\s+i\s+ask\s+something|i\s+need\s+to\s+ask\s+something|i\s+have\s+(?:a|one)\s+doubt|can\s+i\s+ask)[.!?]*$/i.test(normalized) ||
    /^(?:mujhe|main|mai)\s+(?:(?:ek|kuch)\s+)?(?:question|sawal|sawaal|prashn)\s+(?:poochna|puchna)\s+(?:hai|tha)[.!?]*$/i.test(normalized) ||
    /^mera\s+(?:ek\s+)?(?:question|sawal|sawaal|prashn)\s+hai[.!?]*$/i.test(normalized) ||
    /^(?:mujhe|mere\s+paas)\s+(?:ek\s+)?(?:question|sawal|sawaal|doubt)\s+hai[.!?]*$/i.test(normalized) ||
    /^(?:ek\s+)?(?:question|sawal|sawaal|doubt)\s+hai[.!?]*$/i.test(normalized) ||
    /^(?:kya\s+)?(?:main|mai)\s+(?:ek\s+)?(?:question|sawal|sawaal)\s+(?:pooch|puch)\s+sakti\s+hoon[.!?]*$/i.test(normalized) ||
    /^(?:मुझे|मैं)\s*(?:एक\s*)?(?:सवाल|प्रश्न)\s*पूछना\s*है[।.!?]*$/u.test(normalized) ||
    /^(?:मेरा|मेरे\s*पास)\s*(?:एक\s*)?(?:सवाल|प्रश्न|संदेह)\s*है[।.!?]*$/u.test(normalized) ||
    /^(?:एक\s*)?(?:सवाल|प्रश्न|संदेह)\s*है[।.!?]*$/u.test(normalized);

  if (isQuestionPermissionRequest) {
    const reply = isEnglish
      ? "Sure, please go ahead and ask your question. I am here to help."
      : "Ji haan, bilkul poochiye, aap apna question poochhiye. Main aapki madad karti hoon.";
    return {
      isCounterQuestion: true,
      isRequestToAskQuestion: true,
      intent: "REQUEST_TO_ASK_QUESTION",
      topic: "candidate_question_request",
      reply,
    };
  }

  // 12. Candidate constraint, hesitation, or personal situation
  const isA9Conveyance =
    (question?.id === "A9" || question?.Step === "A9") &&
    /scooty\s+nahi|bike\s+nahi|vehicle\s+nahi|gaadi\s+nahi/i.test(normalized);

  const isWillingTravel = /\b(?:travel\s+kar\s+sakt[aei]?|can\s+travel|ready\s+to\s+travel|willing\s+to\s+travel|door\s+bhi\s+ja)\b/i.test(normalized);

  const isTravelConstraint =
    !isA9Conveyance &&
    !isWillingTravel &&
    ((/\b(?:conveyance|vehicle|bike|scooty|gaadi|bus|auto)\b/i.test(normalized) &&
      /\b(?:nahi|nahin|problem|mushkil|issue|dikkat|kaise|without|no)\b/i.test(normalized)) ||
    /\b(?:what\s+if\s+i\s+(?:can\s*not|can'?t|cannot)\s+travel|agar\s+(?:main|mai)\s+(?:roz\s+)?travel\s+na\s+kar|can(?:not|'t)\s+travel\s+every\s+day|door\s+(?:nahi|travel\s+nahi|jana\s+mushkil|kaise)|late\s+(?:nahi|mushkil|aa\s+sakti)|shaam\s+ko\s+late|night\s+mein|shift\s+(?:nahi|mushkil)|relocate\s+(?:nahi|mushkil))\b/i.test(normalized) ||
    (/\b(?:what\s+if|agar)\b/i.test(normalized) && /\b(?:travel|relocate|shift|jana|jaana|every\s+day|daily|roz)\b/i.test(normalized)) ||
    /\b(?:family|ghar\s+wale|husband)\s+(?:allow\s+nahi|permission\s+nahi|mana\s+karte)\b/i.test(normalized));

  const isFamilyConstraint =
    /\b(?:bachh?e?|baby|child|children|family|saas|sasur)\b/i.test(normalized) &&
    /\b(?:chhot[a-z]|small|dekhna|sambhalna|care|responsib|problem|mushkil|dikkat|flexible|timing)\b/i.test(normalized);

  const isGeneralHesitation =
    /\b(?:dar\s+lag\s+raha|tension\s+hai|doubt\s+hai|confusion\s+hai|kar\s+paungi\s+ya\s+nahi|ho\s+payega\s+ya\s+nahi|nervous)\b/i.test(normalized);

  if (isTravelConstraint) {
    const reply = isEnglish
      ? "At Urban Company, service appointments are arranged at customer homes in nearby local areas. Partner safety support is available, and specific travel zones are confirmed with the onboarding team. Does this help with your concern?"
      : "Hum samajhte hain. Urban Company mein kaam aapke aas-paas ke local area mein customer ke ghar par hi hota hai. Saath hi safety support bhi rehta hai, aur travel zones ki jaankari onboarding team share karegi. Kya isse aapki travel ki chinta kam hoti hai?";
    return {
      isCounterQuestion: true,
      intent: "CANDIDATE_CONSTRAINT_OR_HESITATION",
      topic: "travel_constraint",
      reply,
    };
  }

  if (isFamilyConstraint) {
    const reply = isEnglish
      ? "We understand family responsibilities. Service booking timings and availability preferences are discussed with the partner onboarding team. Does that help?"
      : "Hum aapki pareshani samajhte hain. Kaam ke time slots aur timing preferences onboarding team ke saath discuss kiye jaate hain. Kya isse madad milegi?";
    return {
      isCounterQuestion: true,
      intent: "CANDIDATE_CONSTRAINT_OR_HESITATION",
      topic: "family_constraint",
      reply,
    };
  }

  if (isGeneralHesitation) {
    const reply = isEnglish
      ? "It is completely normal to feel that way. Urban Company provides full professional and safety training to all selected partners after screening. Let's continue step by step."
      : "Bilkul pareshan mat hoiye. Selection ke baad Urban Company sabhi partners ko poori professional aur safety training deti hai. Chaliye aage badhte hain.";
    return {
      isCounterQuestion: true,
      intent: "CANDIDATE_CONSTRAINT_OR_HESITATION",
      topic: "hesitation",
      reply,
    };
  }

  // 13. General Knowledge / Technical / Conceptual Inquiries
  // Examples: "Cloud computing kya hai?", "AI aur machine learning mein kya difference hai?",
  // "Internet kaise work karta hai?", "Iska example batao", "Iska benefit kya hai?", "Ye kaise work karta hai?"
  const isGkDefinition =
    /\b(?:what\s+is|what\s+are|what\s+does|how\s+does\s+.*\s+work|difference\s+between)\b/i.test(normalized) ||
    /\b(?:kya\s+(?:hota|hoti|hote)\s+hai|kya\s+hai|kya\s+h|kaise\s+(?:work|kaam)\s+karta\s+hai|kaise\s+(?:work|kaam)\s+karti\s+hai|kaise\s+work\s+karta|kaise\s+kaam\s+karta|kya\s+(?:difference|antar|farak)\s+hai)\b/i.test(normalized);

  const isGkFollowUp =
    /\b(?:(?:aur\s+)?(?:iska|uska|iska\s+bhi)\s+(?:example|benefit|fayda|faida|use|istemaal)|(?:aur\s+)?ye\s+kaise\s+(?:work|kaam)|example\s+(?:batao|bataiye|do|dijiye)|benefit\s+(?:kya\s+hai|batao|bataiye)|fayda\s+(?:kya\s+hai|batao|bataiye)|give\s+(?:an?\s+)?example|what\s+is\s+its\s+benefit|what\s+are\s+the\s+benefits|how\s+does\s+it\s+work)\b/i.test(normalized) ||
    /^(?:iska\s+example|iska\s+benefit|iska\s+fayda|ye\s+kaise\s+work\s+karta\s+hai|aur\s+iska\s+benefit|aur\s+iska\s+example)[.!?\s]*$/i.test(normalized);

  const isGkConcept =
    /\b(?:cloud\s+computing|cloud|machine\s+learning|ml\b|artificial\s+intelligence|ai\b|internet|software|hardware|algorithm|database|server|api|network|web|coding|programming|python|computer)\b/i.test(normalized) ||
    (activeInquiry && activeInquiry.currentTopic === "general_knowledge" && (isGkFollowUp || isGkDefinition || /\b(?:iska|ye|ye\s+kaise|aur\s+ye|kya\s+difference)\b/i.test(normalized)));

  const isGeneralKnowledgeQuery =
    (isGkConcept && (isGkDefinition || isGkFollowUp || /[?]/.test(text))) ||
    (isGkDefinition && /\b(?:cloud|internet|machine\s+learning|ai|difference|work\s+karta|kaam\s+karta)\b/i.test(normalized)) ||
    (activeInquiry && activeInquiry.currentTopic === "general_knowledge" && isGkFollowUp);

  if (isGeneralKnowledgeQuery) {
    let reply;
    if (/\b(?:cloud\s+computing|cloud)\b/i.test(normalized) && isGkDefinition) {
      reply = isEnglish
        ? "Cloud computing is the delivery of computing services, including servers, storage, and software, over the internet."
        : "Cloud computing internet ke zariye servers, storage aur computing services use karne ki technology hai.";
    } else if (/\b(?:difference|antar|farak)\b/i.test(normalized) || (/\bai\b/i.test(normalized) && /\b(?:machine\s+learning|ml)\b/i.test(normalized))) {
      reply = isEnglish
        ? "AI is the broad field of building smart machines, while machine learning is a subset of AI where systems learn from data."
        : "AI ek broad technology hai jo smart machines banati hai, jabki machine learning AI ka ek hissa hai jisme computers data se seekhte hain.";
    } else if (/\binternet\b/i.test(normalized) && (isGkDefinition || /\bwork\b/i.test(normalized))) {
      reply = isEnglish
        ? "The internet works by connecting computer networks worldwide to transmit data packets between devices."
        : "Internet duniya bhar ke computer networks ko aapas mein jodkar data packets ke through information share karta hai.";
    } else if (/\b(?:example|udaharan)\b/i.test(normalized)) {
      reply = isEnglish
        ? "For example, cloud storage services like Google Drive allow users to store and access files online from any device."
        : "Jaise Google Drive ya online cloud storage iska ek aam example hai jahan aap apna data internet par save karte hain.";
    } else if (/\b(?:benefit|fayda|faida)\b/i.test(normalized)) {
      reply = isEnglish
        ? "The main benefit is flexible access to data and tools from anywhere without maintaining local physical infrastructure."
        : "Iska sabse bada benefit hai ki aap kisi bhi device se aur kahin se bhi apna data access kar sakte hain.";
    } else if (/\bapi\b/i.test(normalized)) {
      reply = isEnglish
        ? "An API is a tool that allows different software applications to communicate and share data. For this interview, we focus on your salon service experience."
        : "API ek aisa system hota hai jo alag-alag apps ko aapas mein baat karne aur data share karne mein madad karta hai. Is screening mein hum aapke salon kaam ke baare mein baat kar rahe hain.";
    } else {
      reply = isEnglish
        ? "I can answer general questions as well. For this screening, let's keep our focus on your professional salon experience."
        : "Main is baare mein jaankari share kar sakti hoon. Is screening ke liye chaliye aapke salon kaam aur anubhav par baat karte hain.";
    }

    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "general_knowledge",
      reply,
    };
  }

  // 14. Unknown answer / process guidance (e.g. "Agar mujhe answer nahi pata toh?")
  const isUnknownAnswerQuery =
    /\b(?:agar\s+(?:mujhe\s+)?(?:answer|jawab|kuch)\s+nahi\s+pata|pata\s+na\s+ho|what\s+if\s+i\s+don'?t\s+know\s+(?:the\s+)?answer|answer\s+nahi\s+pata)\b/i.test(
      normalized,
    );

  if (isUnknownAnswerQuery) {
    const reply = isEnglish
      ? "That is completely fine. Please just share your honest thoughts or experience based on what you know."
      : "Koi baat nahi, bilkul pareshan mat hoiye. Aapko jaisa sahi lage aur jitna anubhav ho, spasht batayein.";
    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic: "interview_guidance",
      reply,
    };
  }

  // 15. Conversational inquiry follow-up when active inquiry is in progress
  if (activeInquiry && activeInquiry.status === "in_progress") {
    const isDurationFollowUp = /\b(?:kitne?\s+(?:din|mahine|ghante|saal|hafte)|how\s+(?:many|long)\s+(?:days|months|hours|weeks|time)|kitna\s+(?:samay|time))\b/i.test(normalized);
    const isSequenceFollowUp = /\b(?:aur\s+uske\s+baad|uske\s+baad\s+kya|and\s+after\s+that|what\s+after\s+that|what\s+happens\s+next|aage\s+kya)\b/i.test(normalized);
    const isMeaningFollowUp = /\b(?:iska\s+matlab|what\s+about\s+that|why\s+is\s+that|aur\s+uska|iska\s+kya)\b/i.test(normalized);
    const isTimingFollowUp = /\b(?:aur\s+(?:timings?|samay|schedule)|what\s+about\s+(?:timings?|schedule))\b/i.test(normalized);
    const hasQuestionIndicator =
      /[?؟]/.test(text) ||
      /\b(?:what|where|how|why|when|who|which|can\s+i|will\s+i|do\s+i|kya|kaise|kahan|kitna|kitne|kitni|kab|kyun|kyu|kaun)\b/i.test(normalized);

    if (isDurationFollowUp || isSequenceFollowUp || isMeaningFollowUp || isTimingFollowUp || hasQuestionIndicator) {
      const parentTopic = activeInquiry.currentTopic || "general_inquiry";
      let reply;
      if (parentTopic === "general_knowledge") {
        reply = isEnglish
          ? "I can explain that further. Let's also keep our focus on your professional salon experience."
          : "Main is baare mein aur vistaar se bata sakti hoon. Saath hi chaliye aapke salon kaam aur anubhav par bhi focus karte hain.";
      } else {
        reply = isEnglish
          ? "Further details on that will be confirmed during partner onboarding. Let's return to the question:"
          : "Is baare mein vistaar se jaankari partner onboarding team aapse share karegi. Chaliye sawal par wapas aate hain:";
      }
      return {
        isCounterQuestion: true,
        intent: "RELEVANT_COUNTER_QUESTION",
        topic: parentTopic,
        reply,
      };
    }
  }

  // 16. Dynamic Candidate Inquiry / General & Professional Cross-Questions
  // Candidate asks an unexpected, unseen question about customer handling, communication,
  // service quality, salon practices, general knowledge, technology, interview guidance, etc.
  const isOffTopicTrivia =
    /\b(?:cricket|ipl|match|football|sports|game|movie|movies|cinema|film|actor|actress|weather|mausam|barish|rain|score|winner|capital\s+of|france|modi|rahul|election|politics|president|minister|news|song|sing|dance|chai|coffee|biryani|burger|pizza)\b/i.test(
      normalized,
    );

  const hasGeneralInterrogative =
    /\b(?:what\s+is|what\s+are|what\s+does|what\s+if|what\s+about|what\s+happens|what\s+should|why\s+is|why\s+are|why\s+do|why\s+does|why\s+should|why\s+would|how\s+do|how\s+can|how\s+to|how\s+should|how\s+would|how\s+does|can\s+you\s+explain|could\s+you\s+explain|please\s+explain|tell\s+me\s+about|explain\s+to\s+me|difference\s+between|i\s+want\s+to\s+know|i\s+wanted\s+to\s+know|i\s+have\s+a\s+doubt\s+about|what\s+should\s+i\s+do)\b/i.test(
      normalized,
    ) ||
    /\b(?:kya\s+(?:hota|hoti|hote)\s+hai|kya\s+hai|kya\s+h|kaise\s+(?:karein|kare|karun|karte|hoga|hogi|handle)|kyun\s+(?:zaroori|zaruri|hota|hote|chahiye|hai)|agar\s+(?:customer|client|koi)|kya\s+karna\s+(?:chahiye|hoga|padega)|samjha\s+dijiye|samjhao|explain\s+(?:kijiye|karein|kar\s+do)|bataiye|batao|poochna\s+(?:tha|hai)|poochhna\s+(?:tha|hai)|doubt\s+hai|sawal\s+hai)\b/i.test(
      normalized,
    ) ||
    (/[?؟]/.test(text) && !isOffTopicTrivia);

  const isSubstantiveCandidateQuery =
    hasGeneralInterrogative &&
    !isOffTopicTrivia &&
    text.length >= 5 &&
    !isSubDialogueResolution(text) &&
    !isResumptionConfirmation(text);

  if (isSubstantiveCandidateQuery) {
    let topic = "general_inquiry";
    let reply = "";

    if (/\b(?:customer|grahak|client|unhappy|naraz|angry|gussa|upset|refuse|pay|payment|shikayat|complain)\b/i.test(normalized)) {
      topic = "customer_handling";
      reply = isEnglish
        ? "In customer service and salon work, listening calmly, understanding the client's concern respectfully, and finding a polite solution is our priority."
        : "Customer handling mein grahak ki baat shanti se sunna, unki pareshani samajhna aur politely solution dena sabse zaroori hota hai.";
    } else if (/\b(?:communication|baat|bolna|polite|respect)\b/i.test(normalized)) {
      topic = "communication";
      reply = isEnglish
        ? "Clear and respectful communication builds trust with clients and ensures high service satisfaction."
        : "Spasht aur respectful communication se clients ke saath bharosa banta hai aur service experience behtar hota hai.";
    } else if (/\b(?:quality|service|improve|waxing|facial|technique|hygiene|safety|cleanliness)\b/i.test(normalized)) {
      topic = "service_quality";
      reply = isEnglish
        ? "Service quality depends on hygiene, proper technique, and paying close attention to client comfort."
        : "Service quality hygiene, sahi technique aur customer ke aaram ka dhyan rakhne par depend karti hai.";
    } else if (/\b(?:interview|nervous|dar|process|selection|evaluation|screening)\b/i.test(normalized)) {
      topic = "interview_guidance";
      reply = isEnglish
        ? "Feeling nervous is completely natural. Please answer comfortably based on your real experience; we are here to support you."
        : "Nervous hona bilkul aam baat hai. Aap bina kisi tension ke apne sachhe anubhav ke hisab se jawab dein.";
    } else if (/\b(?:cloud|machine\s+learning|ai|internet|technology|computer|software)\b/i.test(normalized)) {
      topic = "general_knowledge";
      reply = isEnglish
        ? "I can explain that technical concept. In this interview, let's also connect your skills with professional salon work."
        : "Main is technical concept ke baare mein bata sakti hoon. Is screening mein chaliye ise aapke salon kaam se bhi jodkar dekhte hain.";
    } else {
      topic = "general_inquiry";
      reply = isEnglish
        ? "I understand your question. In professional salon services, having clear knowledge and practical skill is very valuable."
        : "Main aapka sawal samajh gayi. Professional salon service mein achhi samajh aur practical anubhav bahut madadgar hota hai.";
    }

    return {
      isCounterQuestion: true,
      intent: "RELEVANT_COUNTER_QUESTION",
      topic,
      reply,
      isEnglish: Boolean(isEnglish),
    };
  }

  return { isCounterQuestion: false };
}

function normalizeHelperText(text) {
  if (typeof text !== "string") return "";
  return text
    .trim()
    .toLowerCase()
    .replace(/[,.!?;:।]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSubDialogueResolution(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const normalized = normalizeHelperText(text);

  // English resolution phrases
  if (
    /^(?:yes\s+|yeah\s+|okay\s+|ok\s+|thank\s+you\s+|thanks\s+)?(?:that(?:'s|\s+is|\s+s)?\s+clear|it(?:'s|\s+is|\s+s)?\s+clear|clear\s+now|i\s+understand|understood|got\s+it|i\s+got\s+it|makes\s+sense|no\s+more\s+questions|no\s+doubts?|now\s+i\s+understand|all\s+clear|that\s+helps|nothing\s+else|no\s+other\s+questions)(?:\s+(?:thank\s+you|thanks|please))?$/i.test(
      normalized,
    ) ||
    /^(?:thank\s+you|thanks)(?:\s+so\s+much)?$/i.test(normalized)
  ) {
    return true;
  }

  // Hindi / Hinglish resolution phrases
  if (
    /^(?:haan\s+|ji\s+haan\s+|theek\s+hai\s+|okay\s+|ok\s+|accha\s+|achha\s+|acha\s+)?(?:samajh\s+(?:aa\s+gaya|aa\s+gayi|gaya|gayi)|ab\s+samajh\s+(?:aa\s+gaya|aa\s+gayi)|clear\s+hai|ab\s+clear\s+hai|ab\s+sab\s+clear\s+hai|sab\s+clear\s+hai|ab\s+theek\s+hai|koi\s+(?:doubt|sawal|sawaal)\s+nahi(?:\s+hai)?|koi\s+dikkat\s+nahi(?:\s+hai)?|ab\s+spasht\s+hai|doubt\s+clear(?:\s+hai|\s+ho\s+gaya)?)(?:\s+(?:clear\s+hai|ab\s+clear\s+hai|samajh\s+(?:aa\s+gaya|aa\s+gayi|gaya|gayi)|theek\s+hai))*$/i.test(
      normalized,
    ) ||
    /\b(?:samajh\s+(?:aa\s+gaya|aa\s+gayi|gaya|gayi)\s+clear\s+hai|clear\s+hai\s+samajh\s+(?:aa\s+gaya|aa\s+gayi|gaya|gayi)|doubt\s+clear\s+ho\s+gaya|doubt\s+clear\s+hai)\b/i.test(
      normalized,
    ) ||
    /^(?:theek\s+hai\s+samajh\s+(?:aa\s+gaya|aa\s+gayi|gaya|gayi)|accha\s+samajh\s+(?:aa\s+gaya|aa\s+gayi)|achha\s+samajh\s+(?:aa\s+gaya|aa\s+gayi)|acha\s+samajh\s+(?:aa\s+gaya|aa\s+gayi))$/i.test(
      normalized,
    ) ||
    /^(?:nahi\s+|no\s+)?(?:koi\s+(?:doubt|sawal|sawaal)\s+nahi(?:\s+hai)?|kuch\s+aur\s+nahi\s+poochna|aur\s+kuch\s+nahi\s+poochna)$/i.test(
      normalized,
    )
  ) {
    return true;
  }

  return false;
}

function isResumptionConfirmation(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const normalized = normalizeHelperText(text);
  if (isExplicitContinueRequest(normalized)) return true;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length <= 5) {
    const allAffirmative = words.every((w) =>
      /^(?:haan|ha|han|haanji|hanji|ji|yes|yeah|yep|sure|okay|ok|theek|thik|hai|accha|achha|acha|chaliye|chalo|bilkul|zaroor|aage|proceed|continue|shuru|karein|badhiye|badho|sahi|alright|fine|please)$/i.test(
        w,
      ),
    );
    if (allAffirmative) return true;
  }

  return /^(?:haan|ha|han|haanji|hanji|ji|ji\s+haan|yes|yeah|yep|sure|sure\s+thing|okay|ok|theek\s+hai|thik\s+hai|accha|achha|acha|chaliye|chalo|bilkul|zaroor|aage|proceed|let's\s+continue|continue|aage\s+badhiye|shuru\s+karein)[.!?\s]*$/i.test(
    normalized,
  );
}

function isNotReadyToResume(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const clean = text.trim().toLowerCase().replace(/[.,?!।]/g, " ").replace(/\s+/g, " ").trim();
  return (
    /^(?:nahi|nahin|no|nope|not\s+ready|i\s+am\s+not\s+ready|i'm\s+not\s+ready|not\s+yet|abhi\s+nahi|taiyaar\s+nahi|wait|ruko|ruk\s+jao|thoda\s+ruko|ek\s+minute|ek\s+second|hold\s+on|wait\s+a\s+minute|wait\s+a\s+second)[.!?\s]*$/i.test(clean) ||
    /\b(?:not\s+ready|i(?:'m|\s+am)?\s+not\s+ready|not\s+yet|abhi\s+nahi|taiyaar\s+nahi|thoda\s+ruko|ruk\s+jao|wait\s+a\s+minute|wait\s+a\s+second|ek\s+second|ek\s+minute|hold\s+on)\b/i.test(clean) ||
    /^(?:nahi|nahin|no|nope|wait|ruko)\b/i.test(clean)
  );
}

function isGenericAcknowledgement(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const normalized = normalizeHelperText(text);
  const token = "(?:theek\\s+hai|thik\\s+hai|okay|ok|accha|achha|acha|sahi\\s+hai|alright|fine|understood|samajh\\s+(?:aa\\s+gaya|aa\\s+gayi|gaya|gayi)|haanji)";
  const pattern = new RegExp(`^(?:${token})(?:\\s+${token})*$`, "i");
  return pattern.test(normalized);
}

function isExplicitContinueRequest(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const normalized = normalizeHelperText(text);
  return (
    /\b(?:continue|aage\s+(?:badhiye|badho|chalein|chalem|chalo)|agla\s+sawal|next\s+question|sawal\s+(?:poochiye|puchiye|kariye|kijiye)|resume|return\s+to\s+interview|move\s+on|proceed|chaliye\s+shuru\s+karein)\b/i.test(
      normalized,
    ) || /^(?:continue|next|aage|proceed)$/i.test(normalized)
  );
}

function isRepetitiveInquiry(text, turns = []) {
  if (typeof text !== "string" || !text.trim() || !Array.isArray(turns)) return false;
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[?.,!]/g, "")
    .trim();
  const priorCandidateTurns = turns
    .filter((t) => t.role === "candidate")
    .map((t) =>
      t.text
        .toLowerCase()
        .replace(/[?.,!]/g, "")
        .trim(),
    );

  if (priorCandidateTurns.includes(normalized)) return true;

  const currTokens = normalized.split(/\s+/).filter((w) => w.length > 3);
  if (currTokens.length >= 2) {
    for (const prev of priorCandidateTurns) {
      const prevTokens = prev.split(/\s+/).filter((w) => w.length > 3);
      if (prevTokens.length >= 2) {
        const matches = currTokens.filter((w) => prevTokens.includes(w)).length;
        if (matches >= prevTokens.length && matches >= currTokens.length) return true;
      }
    }
  }
  return false;
}

function isAnsweringInquiryProbe(text, turns = []) {
  if (typeof text !== "string" || !text.trim() || !Array.isArray(turns)) return false;
  const normalized = text.trim().toLowerCase();

  const lastInterviewerTurn = [...turns].reverse().find((t) => t.role === "interviewer");
  if (!lastInterviewerTurn) return false;

  const interviewerAskedTravelProbe =
    /\b(?:kya\s+isse|manageable|madad\s+milegi|does\s+this\s+help|manage\s+kar|chinta\s+kam|helpful)\b/i.test(
      lastInterviewerTurn.text,
    );

  const interviewerAskedLocationProbe =
    /\b(?:clarify\s+if\s+you\s+are\s+open|open\s+to\s+working|prefer\s+your\s+current\s+city|apne\s+sheher|sheher\s+mein\s+hi|bangalore\s+mein\s+kaam|clarify\s+your\s+preference)\b/i.test(
      lastInterviewerTurn.text,
    );

  const answersTravelProbe =
    /\b(?:manage|sambhal|kar\s+lung[ai]|travel\s+kar|3-?4\s*km|itn[aie]\s+door|chalega|chinta|theek\s+rahega|madad|manageable|i\s+can\s+manage|works\s+for\s+me)\b/i.test(
      normalized,
    ) ||
    (interviewerAskedTravelProbe &&
      /^(?:haan|yes|ji\s+haan|yeah|sure|bilkul|kar\s+lung[ai]|manage\s+ho\s+jayega)[^.?!]*$/i.test(normalized));

  const answersLocationProbe =
    interviewerAskedLocationProbe &&
    (/\b(?:delhi|bangalore|current\s+city|apne\s+sheher|mein\s+hi|prefer|preference|travel\s+kar\s*sakt[aei]?|travel\s+kar|shift\s+nahi|relocate\s+nahi|cannot\s+relocate|cannot\s+shift|can\s+travel|accommodation|opportunity|consider)\b/i.test(
      normalized,
    ) ||
    /^(?:haan|yes|ji\s+haan|yeah|sure|bilkul|open\s+hoon|delhi|bangalore|apne\s+sheher)[^.?!]*$/i.test(normalized));

  return Boolean((interviewerAskedTravelProbe && answersTravelProbe) || (interviewerAskedLocationProbe && answersLocationProbe));
}

function separateProbeAndAssessmentAnswer(cleanAnswer, turns = [], question = {}) {
  if (typeof cleanAnswer !== "string" || !cleanAnswer.trim()) {
    return { isComposite: false, probePart: cleanAnswer, assessmentPart: null };
  }

  const trimmed = cleanAnswer.trim();

  const splitPatterns = [
    /(?:,\s*(?:aur|and|lekin|par|waise|but)\s*|\s+(?:aur|and|lekin|par|waise|but)\s+)/i,
    /(?:[;।!?]\s+)/,
    /,\s+/,
  ];

  for (const pattern of splitPatterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;

    const idx = match.index;
    const partA = trimmed.slice(0, idx).trim();
    const partB = trimmed.slice(idx + match[0].length).trim();

    if (!partA || !partB) continue;

    const aIsProbe = isAnsweringInquiryProbe(partA, turns);
    const bIsProbe = isAnsweringInquiryProbe(partB, turns);

    if (aIsProbe && !bIsProbe) {
      return { isComposite: true, probePart: partA, assessmentPart: partB };
    }
    if (!aIsProbe && bIsProbe) {
      return { isComposite: true, probePart: partB, assessmentPart: partA };
    }
  }

  return { isComposite: false, probePart: trimmed, assessmentPart: null };
}

/**
 * Separates candidate language selection from inquiries/questions in composite utterances.
 * e.g. "Hindi mein baat karungi, waise cloud computing kya hoti hai?"
 * -> detectedLanguage: "Hindi", hasLanguagePreference: true, hasInquiry: true, cleanQuestion: "cloud computing kya hoti hai?"
 */
function separateLanguageAndInquiry(answer, options = {}) {
  if (typeof answer !== "string" || !answer.trim()) {
    return {
      detectedLanguage: null,
      hasLanguagePreference: false,
      hasInquiry: false,
      extractedQuestion: null,
      cleanQuestion: null,
      counterQuestion: null,
    };
  }

  const raw = answer.trim();
  const detectedLanguage = classifyLanguage(raw);
  if (!detectedLanguage) {
    return {
      detectedLanguage: null,
      hasLanguagePreference: false,
      hasInquiry: false,
      extractedQuestion: null,
      cleanQuestion: null,
      counterQuestion: null,
    };
  }

  // Pure language selection utterances without an inquiry
  // e.g. "Hindi mein baat karungi", "English please", "Both are fine", "Dono chalega", "I would prefer English please"
  const langOnlyPattern = /^(?:(?:haan|ha|ji|yes|yep|sure|theek\s+hai|thik\s+hai|bilkul|okay|ok)\b[\s,;:!.\-–—]*)?(?:(?:main|mai|hum|i(?:\s+would)?|we(?:\s+can)?|please|let(?:'s|\s+us)?|mujhe|humein)\s+)?(?:(?:speak\s+in|continue\s+in|prefer|like\s+to\s+speak\s+in|baat\s+karenge|baat\s+karni\s+hai|baat\s+karna\s+chahte\s+hain|bolenge|bolna\s+hai)\s+)?(?:hindi|english|hinglish|kannada|both|either|dono|donon|koi\s+bhi|kisi\s+bhi|हिंदी|अंग्रेज़ी|अंग्रेजी|हिन्दी|दोनों|कन्नड़|कन्नड)(?:\s+(?:language|bhasha|languages))?(?:\s*(?:mein|me|in|please|hi|are|is|chalega|fine|okay|ok|में|मे))?(?:\s*(?:baat|bolna|interview|continue|chalega|fine|okay|ok|बात))?(?:\s*(?:karenge|karungi|karunga|chahti\s+hoon|chahta\s+hoon|hoga|karein|bolti\s+hoon|bolta\s+hoon|bolungi|bolunga|bolenge|hai|karni\s+hai|करेंगे|करूंगी|करेंगे|करना\s+चाहते\s+हैं))?[.!?\s]*$/i;

  if (langOnlyPattern.test(raw)) {
    return {
      detectedLanguage,
      hasLanguagePreference: true,
      hasInquiry: false,
      extractedQuestion: null,
      cleanQuestion: null,
      counterQuestion: null,
    };
  }

  // Common language selection prefixes (English / Hindi / Hinglish / Kannada)
  const prefixPattern = /^(?:(?:haan|ha|ji|yes|yep|sure|theek\s+hai|thik\s+hai|bilkul|okay|ok)\b[\s,;:!.\-–—]*)?(?:(?:main|mai|hum|i(?:\s+would)?|we(?:\s+can)?|please|let(?:'s|\s+us)?|mujhe|humein)\s+)?(?:(?:speak\s+in|continue\s+in|prefer|like\s+to\s+speak\s+in|baat\s+karenge|baat\s+karni\s+hai|baat\s+karna\s+chahte\s+hain|bolenge|bolna\s+hai)\s+)?(?:hindi|english|hinglish|kannada|both|either|dono|donon|koi\s+bhi|kisi\s+bhi|हिंदी|अंग्रेज़ी|अंग्रेजी|हिन्दी|दोनों|कन्नड़|कन्नड)(?:\s+(?:language|bhasha|languages))?(?:\s*(?:mein|me|in|please|hi|are|is|chalega|fine|okay|ok|में|मे))?(?:\s*(?:baat|bolna|interview|continue|chalega|fine|okay|ok|बात))?(?:\s*(?:karenge|karungi|karunga|chahti\s+hoon|chahta\s+hoon|hoga|karein|bolti\s+hoon|bolta\s+hoon|bolungi|bolunga|bolenge|hai|karni\s+hai|करेंगे|करूंगी|करेंगे|करना\s+चाहते\s+हैं))?[\s,;:!.\-–—]*/i;

  let remainder = raw.replace(prefixPattern, "").trim();

  // Also check suffix pattern if remainder is empty or hasn't matched:
  if (!remainder || remainder === raw) {
    const suffixPattern = /[\s,;:!.\-–—]+(?:waise\s+)?(?:(?:main|mai|hum|i)\s+)?(?:hindi|english|hinglish|kannada)(?:\s+(?:language|bhasha))?(?:\s*(?:mein|me|in|please|prefer))?(?:\s*(?:baat|bolna|interview|continue|karungi|karunga|karenge))?[.!?\s]*$/i;
    const strippedSuffix = raw.replace(suffixPattern, "").trim();
    if (strippedSuffix && strippedSuffix !== raw) {
      remainder = strippedSuffix;
    }
  }

  // Remove leading conversational bridge words from remainder
  const bridgePattern = /^(?:waise(?:\s+bhi|\s+toh)?|by\s+the\s+way|aur\s+waise|aur|lekin|par|but|and|ek\s+(?:baat|sawaal|sawal)\s+(?:batao|batayein|hai|tha)|mera\s+(?:ek\s+)?(?:sawaal|sawal)\s+hai|just\s+wanted\s+to\s+know|just\s+wanted\s+to\s+ask|i\s+have\s+a\s+question|can\s+i\s+ask|mujhe\s+ek\s+(?:sawaal|sawal)\s+poochna\s+hai)[\s,;:!.\-–—]*/i;
  const cleanQ = remainder ? remainder.replace(bridgePattern, "").trim() : "";

  // Check if remainder is empty or just standard affirmative/continuation words (not a question)
  if (!cleanQ || cleanQ.length < 3) {
    return {
      detectedLanguage,
      hasLanguagePreference: true,
      hasInquiry: false,
      extractedQuestion: null,
      cleanQuestion: null,
      counterQuestion: null,
    };
  }

  const isTrivialConfirmation =
    /^(?:theek\s+hai|thik\s+hai|okay|ok|sure|ji|haan|ha|yes|shuru\s+karein|shuru\s+kijiye|start|continue|chaliye)[.!?\s]*$/i.test(cleanQ) ||
    isExplicitContinueRequest(cleanQ);

  if (isTrivialConfirmation) {
    return {
      detectedLanguage,
      hasLanguagePreference: true,
      hasInquiry: false,
      extractedQuestion: null,
      cleanQuestion: null,
      counterQuestion: null,
    };
  }

  // Check if remainder (or full utterance) is a counter question or inquiry
  const cqRemainder = detectCounterQuestion(cleanQ, options.question || {}, {
    language: detectedLanguage,
    activeInquiry: options.activeInquiry,
  });
  const cqRaw = detectCounterQuestion(remainder, options.question || {}, {
    language: detectedLanguage,
    activeInquiry: options.activeInquiry,
  });
  const cqFull = detectCounterQuestion(raw, options.question || {}, {
    language: detectedLanguage,
    activeInquiry: options.activeInquiry,
  });

  const isCq = cqRemainder.isCounterQuestion || cqRaw.isCounterQuestion || cqFull.isCounterQuestion;
  const cqResult = cqRemainder.isCounterQuestion ? cqRemainder : (cqRaw.isCounterQuestion ? cqRaw : cqFull);

  // Question pattern indicators (Hindi or English interrogatives / conceptual queries)
  const isQuestionPattern =
    /[?]/i.test(remainder) ||
    /\b(?:kya|kyun|kyu|kaise|kahan|kidhar|kab|kitn[aie]|kaun|kaunse?|kaunsi|kisko|kiske|kiski|kis|batao|batayein|batana|samjhao|doubt|sawal|sawaal|poochna|what|why|how|when|where|who|which|can\s+i|could\s+you|do\s+i|does\s+the|will\s+i|would\s+i|is\s+it|are\s+there|tell\s+me|explain|difference|benefit|example|relocate|shift|travel|stay|accommodation|salary|kamai|paisa|training|joining|documents|timing|hours|duty|booking|bookings|payout|incentive)\b/i.test(remainder);

  const hasInquiry = Boolean(isCq || isQuestionPattern);

  return {
    detectedLanguage,
    hasLanguagePreference: true,
    hasInquiry,
    extractedQuestion: remainder,
    cleanQuestion: cleanQ || remainder,
    counterQuestion: isCq ? cqResult : null,
  };
}

module.exports = {
  detectCounterQuestion,
  isRequestToAskQuestion,
  isEnglishRequestToAsk,
  isCandidateDecidingNotToAsk,
  isSubDialogueResolution,
  isResumptionConfirmation,
  isNotReadyToResume,
  isGenericAcknowledgement,
  isExplicitContinueRequest,
  isRepetitiveInquiry,
  isAnsweringInquiryProbe,
  separateProbeAndAssessmentAnswer,
  separateLanguageAndInquiry,
};
