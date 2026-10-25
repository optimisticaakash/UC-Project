function classifyConsent(answer) {
  const text = answer.trim().toLowerCase();

  // 1. Unclear answers
  const unclearPatterns = [
    /\bpata nahi\b/,
    /\bpata nahin\b/,
    /\bnot sure\b/,
    /\bmaybe\b/,
    /\bunsure\b/,
    /\bsamajh nahi aaya\b/,
    /\bcan you explain\b/,
    /पता नहीं/,
    /समझ नहीं आया/,
    /समझ नहीं आई/,
  ];

  if (unclearPatterns.some((pattern) => pattern.test(text))) {
    return "unclear";
  }

  // 2. Refusal patterns
  const refusalPatterns = [
    /\bno\b/,
    /\bnope\b/,
    /\bnot comfortable\b/,
    /\bdo not agree\b/,
    /\bdon't agree\b/,
    /\bi do not consent\b/,
    /\bshuru nahi karna\b/,
    /\brecord mat karo\b/,
    /\bsahmat nahi\b/,
    /\bmain interview nahi dena chahti\b/,
    /\bmain interview nahi dena chahta\b/,
    /नहीं/,
    /नही/,
    /मना है/,
    /सहमत नहीं/,
    /नहीं चाहती/,
    /नहीं चाहता/,
    /रिकॉर्ड मत/,
  ];

  // 3. Agreement patterns
  const agreementPatterns = [
    /\byes\b/,
    /\byep\b/,
    /\bhaan\b/,
    /\bhan\b/,
    /\bbilkul\b/,
    /\bthik hai\b/,
    /\bji haan\b/,
    /\btheek hai\b/,
    /\bshuru karein\b/,
    /\bi agree\b/,
    /\bi consent\b/,
    /\bi am okay\b/,
    /\bi'm okay\b/,
    /\bokay\b/,
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

  const hasRefusal = refusalPatterns.some((pattern) => pattern.test(text));

  const hasAgreement = agreementPatterns.some((pattern) => pattern.test(text));

  // Conflicting intent should not be accepted automatically.
  if (hasRefusal && hasAgreement) {
    return "unclear";
  }

  if (hasRefusal) return "refused";
  if (hasAgreement) return "accepted";

  return "unclear";
}

module.exports = { classifyConsent };

