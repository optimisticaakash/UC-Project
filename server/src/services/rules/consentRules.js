const HINDI_PATTERNS = [
  /\bhindi\b/i,
  /हिंदी/,
  /हिन्दी/,
];

const ENGLISH_PATTERNS = [
  /\benglish\b/i,
  /\bangrezi\b/i,
  /\bangreji\b/i,
  /अंग्रेज़ी/,
  /अंग्रेजी/,
];

const HINGLISH_OR_BOTH_PATTERNS = [
  /\bhinglish\b/i,
  /\bboth\b/i,
  /\beither\b/i,
  /\bdono\b/i,
  /\bdonon\b/i,
  /दोनों/,
  /\bkoi\s+bhi\b/i,
  /\bkisi\s+bhi\b/i,
];

const KANNADA_PATTERNS = [
  /\bkannada\b/i,
  /कन्नड़/,
  /कन्नड/,
];

function classifyLanguage(answer) {
  if (!answer || typeof answer !== "string") return null;
  const text = answer.trim().toLowerCase();

  if (HINGLISH_OR_BOTH_PATTERNS.some((pattern) => pattern.test(text))) {
    return "Hinglish";
  }

  const hasHindi = HINDI_PATTERNS.some((pattern) => pattern.test(text));
  const hasEnglish = ENGLISH_PATTERNS.some((pattern) => pattern.test(text));

  if (hasHindi && hasEnglish) {
    return "Hinglish";
  }
  if (hasEnglish) {
    return "English";
  }
  if (hasHindi) {
    return "Hindi";
  }
  if (KANNADA_PATTERNS.some((pattern) => pattern.test(text))) {
    return "Kannada";
  }
  return null;
}

// 1. Explicit refusal patterns (recording refused, interview refused)
const explicitRefusalPatterns = [
  /\bnot comfortable\b/i,
  /\bdo not agree\b/i,
  /\bdon't agree\b/i,
  /\bi do not consent\b/i,
  /\bno consent\b/i,
  /\bshuru nahi karna\b/i,
  /\brecord mat karo\b/i,
  /\brecording mat karo\b/i,
  /\bsahmat nahi\b/i,
  /\bmain interview nahi dena\b/i,
  /\binterview nahi dena\b/i,
  /\binterview nahi karna\b/i,
  /मना है/,
  /सहमत नहीं/,
  /रिकॉर्ड मत/,
  /रिकॉर्डिंग मत/,
  /\bnahi\b[\s,;:!?.\-–—]*(?:main|mai)\s+agree\s+nahi\b/i,
];

// General refusal words
const generalRefusalPatterns = [
  /\bno\b/i,
  /\bnope\b/i,
  /\bnahi\b/i,
  /\bnahin\b/i,
  /नहीं/,
  /नही/,
  /नहीं चाहती/,
  /नहीं चाहता/,
];

// Agreement words
const agreementPatterns = [
  /\byes\b/i,
  /\byep\b/i,
  /\bhaan\b/i,
  /\bhan\b/i,
  /\bbilkul\b/i,
  /\bthik hai\b/i,
  /\bji haan\b/i,
  /\btheek hai\b/i,
  /\bshuru karein\b/i,
  /\bi agree\b/i,
  /\bi consent\b/i,
  /\bi am okay\b/i,
  /\bi'm okay\b/i,
  /\bokay\b/i,
  /\bsure\b/i,
  /हाँ/,
  /हां/,
  /जी हाँ/,
  /जी हां/,
  /ठीक है/,
  /सहमत हूँ/,
  /सहमत हूं/,
  /शुरू करें/,
  /शुरू करिए/,
];

// Unclear patterns
const unclearPatterns = [
  /\bpata nahi\b/i,
  /\bpata nahin\b/i,
  /\bnot sure\b/i,
  /\bmaybe\b/i,
  /\bunsure\b/i,
  /\bsamajh nahi aaya\b/i,
  /\bcan you explain\b/i,
  /पता नहीं/,
  /समझ नहीं आया/,
  /समझ नहीं आई/,
];

function classifyConsent(answer) {
  if (!answer || typeof answer !== "string") return "unclear";
  const raw = answer.trim();
  const text = raw.toLowerCase();

  // 1. Check for genuine uncertainty
  if (unclearPatterns.some((pattern) => pattern.test(text))) {
    return "unclear";
  }

  // 2. Explicit refusal of recording or interview takes priority
  const hasExplicitRefusal = explicitRefusalPatterns.some((pattern) =>
    pattern.test(text),
  );
  if (hasExplicitRefusal) {
    return "refused";
  }

  // 3. Check for valid language selection (Hindi, English, Hinglish, Both, Kannada)
  const detectedLang = classifyLanguage(raw);

  // Filter out non-refusal filler words like "no problem", "no issue", "koi problem nahi"
  const sanitized = text
    .replace(/\bno\s+(?:problem|issue|worries|concern|dikkat)\b/gi, " ")
    .replace(/\bkoi\s+(?:problem|issue|dikkat|baat)\s+nahi\b/gi, " ")
    .replace(/\bkisi\s+bhi\s+language\b/gi, " ");

  const hasGeneralAgreement = agreementPatterns.some((pattern) =>
    pattern.test(sanitized),
  );
  const hasGeneralRefusal = generalRefusalPatterns.some((pattern) =>
    pattern.test(sanitized),
  );

  // If candidate selected a language without an explicit refusal, they agree to the screening
  if (detectedLang) {
    return "accepted";
  }

  // If answer contains conflicting agreement and refusal words without language choice
  if (hasGeneralAgreement && hasGeneralRefusal) {
    return "unclear";
  }

  if (hasGeneralRefusal) {
    return "refused";
  }

  if (hasGeneralAgreement) {
    return "accepted";
  }

  return "unclear";
}

module.exports = { classifyConsent, classifyLanguage };

