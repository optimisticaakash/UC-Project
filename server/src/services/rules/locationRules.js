const GREETING_TOKEN =
  "(?:namaste|namaskar|hello|hi|hey|pranam|ram\\s*ram|salaam|shukriya|dhanyawad|thanks|thank\\s*you|theek\\s*hai|thik\\s*hai|ok|okay|acha|achha|accha|acche|haan|ha|han|haanji|hanji|ji|ji\\s*haan|yes|yep|yeah|no|nahi|nahin|nhi|galat|sahi|bilkul|good\\s*morning|good\\s*evening|good\\s*afternoon|नमस्ते|नमस्कार|हेलो|हाय|प्रणाम|राम\\s*राम|सलाम|शुक्रिया|धन्यवाद|थैंक्स|ठीक\\s*है|अच्छा|हाँ|हां|जी|जी\\s*हाँ|जी\\s*हां|नहीं|नही|गलत|सही|बिल्कुल)";

const GREETINGS_AND_ACKNOWLEDGMENTS = new RegExp(
  `^(?:${GREETING_TOKEN}[.!?।\\s]*)+$`,
  "iu",
);

const CONVERSATIONAL_NON_LOCATION_PATTERN =
  /^(?:(?:main|hum|मैं|हम)\s+(?:ek\s+)?(?:achh[ai]|theek|thik|ready|tayar|fresher|housewife|student|तैयार|हाउसवाइफ|स्टूडेंट)\s+(?:hoon|hain|hu|हूँ|हूं|हैं)|(?:mera|meri|मेरा|मेरी)\s+naam\s+[a-z\s]+|mera\s+naam\s+.*|मेरा\s+नाम\s+.*|(?:aap|आप)\s+(?:kaise|kaun|kya|batao|bataiye|samjhao|sun\s+rahe|कैसे|कौन|क्या|बताओ|बताइए|सुन\s+रहे)[^]*|(?:kya|क्या)\s+(?:kaam|hoga|karna|hai|process|batao|काम|होगा|करना|है|प्रोसेस)[^]*|(?:mujhe|मुझे)\s+(?:kaam|job|paisa|काम|जॉब|पैसा)\s+(?:chahiye|karna|चाहिए|करना)|(?:kab|कब)\s+(?:shuru|aana|hoga|शुरू|आना|होगा)[^]*|interview\s+kab[^]*|इंटरव्यू\s+कब[^]*|aap\s+kaun\s+bol\s+rahe[^]*|आप\s+कौन\s+बोल\s+रहे[^]*|how\s+are\s+you|what\s+is\s+this|who\s+are\s+you|i\s+am\s+ready|my\s+name\s+is[^]*|my\s+favourite[^]*|my\s+favorite[^]*|i\s+like\s+[^]*)[.!?।\s]*$/iu;

const KNOWN_CITIES_AND_LOCALITIES =
  /\b(?:delhi|new\s+delhi|noida|greater\s+noida|gurgaon|gurugram|ghaziabad|faridabad|indirapuram|vaishali|vasundhara|kaushambi|mumbai|navi\s+mumbai|thane|pune|bangalore|bengaluru|hyderabad|secunderabad|chennai|kolkata|jaipur|lucknow|chandigarh|mohali|panchkula|ahmedabad|surat|indore|bhopal|patna|kanpur|nagpur|hsr|btm|koramangala|indiranagar|whitefield|jayanagar|marathahalli|bellandur|electronic\s*city|hebbal|rajajinagar|malleshwaram|banashankari|yelahanka|sarjapur|kammanahalli|rohini|dwarka|janakpuri|saket|lajpat\s*nagar|karol\s*bagh|laxmi\s*nagar|connaught\s*place|cp|okhla|pitampura|vasant\s*kunj|mayur\s*vihar|hauz\s*khas|malviya\s*nagar|uttam\s*nagar|paschim\s*vihar|kothrud|viman\s*nagar|wakad|hinjewadi|baner|hadapsar|aundh|pimpri|chinchwad|magarpatta|kalyani\s*nagar|andheri|bandra|borivali|powai|dadar|goregaon|malad|kandivali|vashi|nerul|chembur|ghatkopar|mulund|hoskote|(?:sector|sec|phase|block)\s*(?:[0-9]{1,3}[a-z]?|[a-z]\b))\b|(?:दिल्ली|नई\s+दिल्ली|नोएडा|ग्रेटर\s+नोएडा|गुड़गांव|गुड़गाँव|गुरुग्राम|गाजियाबाद|फ़रीदाबाद|फरीदाबाद|इंदिरापुरम|वैशाली|वसुंधरा|कौशाम्बी|मुंबई|नवी\s+मुंबई|ठाणे|पुणे|बैंगलोर|बेंगलुरु|हैदराबाद|सिकंदराबाद|चेन्नई|कोलकाता|जयपुर|लखनऊ|चंडीगढ़|मोहाली|पंचकुला|अहमदाबाद|सूरत|इंदौर|भोपाल|पटना|कानपुर|नागपुर|रोहिणी|द्वारका|द्वारिका|जनकपुरी|साकेत|लाजपत\s*नगर|करोल\s*बाग|लक्ष्मी\s*नगर|कनॉट\s*प्लेस|ओखला|पीतमपुरा|वसंत\s*कुंज|मयूर\s*विहार|हौज\s*खास|मालवीय\s*नगर|उत्तम\s*नगर|पश्चिम\s*विहार|कोथरुड|विमान\s*नगर|वाकड़|हिंजेवाड़ी|बानेर|हड़पसर|औंध|पिंपरी|चिंचवाड़|मगरपट्टा|कल्याणी\s*नगर|अंधेरी|बांद्रा|बोरीवली|पवई|दादर|गोरेगांव|मलाड|कांदिवली|वाशी|नेरुल|चेंबूर|घाटकोपर|मुलुंड|एचएसआर|बीटीएम|कोरमंगला|इंदिरानगर|व्हाइटफील्ड|जयनगर|मराठाहल्ली|बेलंदूर|इलेक्ट्रॉनिक\s*सिटी|हेब्बल|राजाजीनगर|मल्लेश्वरम|बनाशंकरी|यलहंका|सरजापुर|कम्मनहल्ली|होसकोटे|होसकोटा|(?:सेक्टर|फ़ेज़|फेज|ब्लॉक)\s*(?:[0-9]{1,3}[a-z]?|[a-z]\b|[०-९]{1,3}))/iu;

const BARE_GENERIC_LOCATION_DESCRIPTORS =
  /^(?:(?:apn[aei]|local|kisi|mere|mera|meri|main|ye|yeh|kuch|is|ek|the|अपने|अपनी|अपना|लोकल|किसी|मेरे|मेरा|मेरी|मैं|ये|यह|कुछ|इस|एक|मेन)\s+)?(?:area|market|bazar|bazaar|sector|sec|road|colony|block|society|apartment|apartments|gali|street|chowk|village|gaon|dist|district|ilaqa|ilaqe|city|sheher|place|jagah|location|एरिया|मार्केट|बाजार|बाज़ार|सेक्टर|रोड|सड़क|सडक|कॉलोनी|कालोनी|ब्लॉक|सोसायटी|सोसाइटी|अपार्टमेंट|गली|चौक|गांव|गाँव|जिला|ज़िला|इलाका|इलाके|शहर|जगह|स्थान)(?:\s+(?:mein|pe|par|se|ke|ki|ka|hai|hain|hoon|hu|rehti|rehta|rahe|hoti|hota|में|पे|पर|से|के|की|का|है|हैं|हूँ|हूं|रहती|रहता|रहे|होती|होता))*[.!?।\s]*$/iu;

const LOCATION_STRUCTURAL_INDICATORS =
  /\b(?:nagar|colony|layout|road|street|gali|chowk|village|gaon|sector|sec|phase|block|cross|main|circle|gate|halli|puram|pura|bad|pally|palli|wadi|pali|market|bazar|bazaar|society|apartment|apartments|enclave|vihar|ext|extension|dist|district|station|stand|stop)\b|\b[a-z]+(?:nagar|puram|pura|vihar|enclave|layout|colony|pally|palli|wadi|garh|ganj)\b|(?:नगर|कॉलोनी|कालोनी|लेआउट|रोड|सड़क|सडक|मार्ग|गली|चौक|गांव|गाँव|सेक्टर|ब्लॉक|सर्कल|गेट|पुरम|पुरा|मार्केट|बाजार|बाज़ार|सोसायटी|सोसाइटी|अपार्टमेंट|विहार|एक्सटेंशन|जिला|ज़िला|स्टेशन)/iu;

const RESIDENTIAL_FRAMING =
  /(?:(?:mein|me|pe|par)\s+(?:rehti|rehta|rahe|rehte|rehta\s+hoon|rehti\s+hoon|rahe\s+hain|rehte\s+hain|hu|hoon|hai|hain)|(?:rehti|rehta|rehte)\s+(?:hoon|hu|hain|hai)\s+(?:.*?\s+)?(?:mein|me|pe|par)|(?:mera|meri|humara|apna)\s+(?:ghar|area|ilaqa|jagah)\s+.*?\s+(?:mein|hai|pe)|\b(?:i\s+live\s+in|i\s+stay\s+in|i\s+stay\s+at|living\s+in|staying\s+in|based\s+in|located\s+in|reside\s+in|residing\s+in|my\s+area\s+is|my\s+location\s+is|near\s+|close\s+to\s+|opposite\s+|behind\s+)\b)/iu;

function hasLocationEvidence(text) {
  return (
    KNOWN_CITIES_AND_LOCALITIES.test(text) ||
    LOCATION_STRUCTURAL_INDICATORS.test(text) ||
    RESIDENTIAL_FRAMING.test(text)
  );
}

function classifyLocation(answer) {
  const text = answer.trim().toLowerCase();

  // An empty, vague, or irrelevant response needs clarification.
  // Standalone "door" is removed because in Hinglish it means "far" (दूर).
  const irrelevantPattern =
    /\b(?:biryani|pizza|burger|cricket|movie|movies|anime|song|songs|dance|dancing|gaana|khana|aaloo|aloo|potato|football|habba\s+jabba|bla\s+bla|asdf|qwerty|chair|table|desk|sofa|bed|furniture|mobile|phone|smartphone|laptop|computer|tablet|pen|pencil|paper|book|bottle|cup|glass|plate|spoon|fork|fan|light|tv|television|ac|fridge|refrigerator|window|wall|floor|roof|cat|dog|billi|kutta|animal|bird|clothes|shirt|pant|shoes|chappal|samosa|chai|tea|coffee|ice\s*cream|zxcv|foo|bar|baz|qux|test|testing|kuch\s+bhi|koi\s+bhi|random)\b/i;

  const isOnlyVehicle =
    /^(?:car|bike|scooty|scooter|bus|metro|auto|train|gaadi|two\s*wheeler)[.!?\s]*$/i.test(text);

  const hasRepeatedChars = /(.)\1{2,}/u.test(text);

  const words = text.split(/\s+/).filter(Boolean);
  const isConversationalWithoutLocation =
    words.length >= 3 &&
    !KNOWN_CITIES_AND_LOCALITIES.test(text) &&
    (/\b(?:main|mera|meri|mere|mujhe|aap|aapka|aapki|aapke|tum|hum|kya|kyun|kyu|kaise|kaun|kab|batao|bataiye|chahiye|hoga|hogi|karna|karengi|hoon|hai|hain|tha|thi|the|achha|achhi|lagta|lagti|kuch|pasand|rehti|rehta|main\s+road)\b|(?:मुझे|पसंद|है|हैं|हूँ|हूं|मैं|हम|मेरा|मेरी|मेरे|आपका|आपकी|आपके|आप|तुम|क्या|क्यों|क्यूं|कैसे|कौन|कब|बताओ|बताइए|चाहिए|होगा|होगी|करना|करूंगी|रहती|रहता|था|थी|थे|अच्छा|अच्छी|लगता|लगती|कुछ|में|पे|पर|से|पसंद\s+है)/iu.test(text) ||
     /\b(?:my|i|i'm|i\s+am|we|our|you|your|favourite|favorite|colour|color|blue|red|green|pizza|eating|weather|today|random|unrelated|like|likes|love)\b/iu.test(text));

  if (
    !text ||
    text.length < 2 ||
    /^(pata nahi|not sure|don't know|dont know|samajh nahi aaya)[.!?]*$/i.test(
      text,
    ) ||
    GREETINGS_AND_ACKNOWLEDGMENTS.test(text) ||
    CONVERSATIONAL_NON_LOCATION_PATTERN.test(text) ||
    BARE_GENERIC_LOCATION_DESCRIPTORS.test(text) ||
    isConversationalWithoutLocation ||
    irrelevantPattern.test(text) ||
    isOnlyVehicle ||
    hasRepeatedChars ||
    !hasLocationEvidence(text)
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
  const unwillingTravelPatterns = [
    /sirf apne area mein/,
    /sirf apne area tak/,
    /door nahi ja/,
    /travel nahi kar/,
    /nahi ja sakti/,
    /nahi ja sakta/,
    /travel karna possible nahi/,
    /not willing to travel/,
    /cannot travel/,
    /can't travel/,
    /won't travel/,
    /no,?\s+i\s+can(?:not|'t)\s+travel/,
    /^(नहीं|नही)[.!?।]*$/,
    /नहीं.*(जा|कर|ट्रैवल|यात्रा)/,
    /नही.*(जा|कर|ट्रैवल|यात्रा)/,
    /ट्रैवल nahi/,
  ];

  const willingTravelPatterns = [
    /travel kar sak/,
    /door bhi ja/,
    /ready to travel/,
    /willing to travel/,
    /can travel/,
    /yes,?\s+i\s+can\s+travel/,
    /haan.*(kar sakti|kar sakta|ja sakti|ja sakta)/,
    /han.*(kar sakti|kar sakta|ja sakti|ja sakta)/,
    /हाँ.*(कर सकती|कर सकता|जा सकती|जा सकता)/,
    /हां.*(कर सकती|कर सकता|जा सकती|जा सकता)/,
    /ट्रैवल कर सकती/,
    /ट्रैवल कर सकता/,
  ];

  const unwillingRelocatePatterns = [
    /shift nahi kar/,
    /move nahi kar/,
    /relocate nahi kar/,
    /shift nahi ho sakti/,
    /shift nahi ho sakta/,
    /shift nahi/,
    /relocate nahi/,
    /not willing to move/,
    /not willing to relocate/,
    /cannot relocate/,
    /can't relocate/,
    /cannot shift/,
    /can't shift/,
    /won't relocate/,
    /won't shift/,
    /no,?\s+i\s+can(?:not|'t)\s+(?:relocate|shift|move)/,
    /नहीं.*(शिफ्ट|रिलोकेट)/,
    /नही.*(शिफ्ट|रिलोकेट)/,
  ];

  const willingRelocatePatterns = [
    /shift ho sak/,
    /shift kar sak/,
    /move kar sak/,
    /relocate kar sak/,
    /willing to move/,
    /can relocate/,
    /can shift/,
    /ready to relocate/,
    /willing to relocate/,
    /ready to shift/,
    /willing to shift/,
    /yes,?\s+i\s+can\s+(?:relocate|shift|move)/,
    /ज़रूरत पड़ने पर.*(शिफ्ट|रिलोकेट)/,
    /जरूरत पड़ने पर.*(शिफ्ट|रिलोकेट)/,
    /आवश्यकता पड़ने पर.*(शिफ्ट|रिलोकेट)/,
    /शिफ्ट हो सकती/,
    /शिफ्ट हो सकता/,
    /रिलोकेट कर सकती/,
    /रिलोकेट कर सकता/,
  ];

  const conditionalRelocatePatterns = [
    /agar\s+(?:accommodation|rehne\s+ki\s+jagah|opportunity|offer)\s+(?:mile|ho|de)\s*toh/i,
    /consider\s+kar\s+sakt/i,
    /if\s+(?:accommodation|opportunity)\s+is\s+provided/i,
    /can\s+consider/i,
  ];

  const cityPreferencePatterns = [
    /(?:main|mai|hum|i\s+want\s+to\s+work\s+in|prefer\s+to\s+work\s+in|prefer)\s+([a-z\s]+?)\s*(?:mein\s+hi|me\s+hi)\s+(?:kaam\s+karna|rehna)/i,
    /(?:apne\s+sheher|current\s+city)\s+(?:mein\s+hi)/i,
    /prefer\s+(?:delhi|bangalore|my\s+current\s+city)/i,
  ];

  const unwillingTravel = unwillingTravelPatterns.some((pattern) => pattern.test(text));
  const willingTravel = willingTravelPatterns.some((pattern) => pattern.test(text));
  const unwillingRelocate = unwillingRelocatePatterns.some((pattern) => pattern.test(text));
  const willingRelocate = willingRelocatePatterns.some((pattern) => pattern.test(text));
  const conditionalRelocate = conditionalRelocatePatterns.some((pattern) => pattern.test(text));
  const hasCityPreference = cityPreferencePatterns.some((pattern) => pattern.test(text));

  // Determine travel willingness:
  let travelWillingness = "unknown";
  if (unwillingTravel && willingTravel) {
    travelWillingness = "unclear";
  } else if (unwillingTravel) {
    travelWillingness = "no";
  } else if (willingTravel) {
    travelWillingness = "yes";
  }

  // Determine relocation willingness:
  let relocationWillingness = "unknown";
  if (unwillingRelocate && willingRelocate) {
    relocationWillingness = "unclear";
  } else if (conditionalRelocate) {
    relocationWillingness = "conditional";
  } else if (unwillingRelocate) {
    relocationWillingness = "no";
  } else if (willingRelocate) {
    relocationWillingness = "yes";
  } else if (hasCityPreference) {
    relocationWillingness = "preference_current_city";
  }

  // Contradiction on travel specifically
  if (travelWillingness === "unclear") {
    return {
      outcome: "clarification",
      area: answer.trim(),
      travelWillingness: "unclear",
      relocationWillingness,
      followUp: null,
      manualReviewRequired: false,
      message: "Could you clarify whether you are willing to travel?",
    };
  }

  // Contradiction on relocation specifically
  if (relocationWillingness === "unclear") {
    return {
      outcome: "clarification",
      area: answer.trim(),
      travelWillingness,
      relocationWillingness: "unclear",
      followUp: null,
      manualReviewRequired: false,
      message: "Could you clarify whether you are willing to relocate?",
    };
  }

  let followUp = null;
  if (willingRelocate || travelWillingness === "yes") {
    followUp = "move_timeline";
  } else if (travelWillingness === "no" || hasCityPreference) {
    followUp = null;
  } else if (travelWillingness === "unknown") {
    followUp = "travel_clarification";
  }

  return {
    outcome: "manual_review",
    area: answer.trim(),
    travelWillingness,
    relocationWillingness,
    followUp,
    manualReviewRequired: true,
    message: "Location and travel preference captured for manual proximity review.",
  };
}

module.exports = { classifyLocation };
