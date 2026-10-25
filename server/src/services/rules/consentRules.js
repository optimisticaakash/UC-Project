function classifyConsent(answer) {
  const text = answer.trim().toLowerCase();

  // Check unclear answers first.
  const unclearPatterns = [
    /\bpata nahi\b/,
    /\bpata nahin\b/,
    /\bnot sure\b/,
    /\bmaybe\b/,
    /\bunsure\b/,
    /\bsamajh nahi aaya\b/,
    /\bcan you explain\b/,
  ];

  if (unclearPatterns.some((pattern) => pattern.test(text))) {
    return "unclear";
  }

  const refusalPatterns = [
    /\bno\b/,
    /\bnope\b/,
    /\bnahin\b/,
    /\bnahi\b/,
    /\bmain agree nahi karti\b/,
    /\bmain agree nahi karta\b/,
    /\bnot comfortable\b/,
    /\bdo not agree\b/,
    /\bdon't agree\b/,
    /\bi do not consent\b/,
    /\bshuru nahi karna\b/,
    /\brecord mat karo\b/,
  ];

  const agreementPatterns = [
    /\byes\b/,
    /\byep\b/,
    /\bhaan\b/,
    /\bhan\b/,
    /\bthik hai\b/,
    /\bha\b/,
    /\bji haan\b/,
    /\btheek hai\b/,
    /\bshuru karein\b/,
    /\bi agree\b/,
    /\bi consent\b/,
    /\bi am okay\b/,
    /\bi'm okay\b/,
    /\bokay\b/,
  ];

  const hasRefusal = refusalPatterns.some((pattern) => pattern.test(text));

  const hasAgreement = agreementPatterns.some((pattern) => pattern.test(text));

  if (hasRefusal && hasAgreement) {
    return "unclear";
  }

  if (hasRefusal) {
    return "refused";
  }

  if (hasAgreement) {
    return "accepted";
  }

  return "unclear";
}

module.exports = { classifyConsent };
