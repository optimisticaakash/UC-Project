const GREETINGS_AND_ACKNOWLEDGMENTS =
  /^(?:namaste|namaskar|hello|hi|hey|pranam|ram\s*ram|salaam|shukriya|dhanyawad|thanks|thank\s*you|theek\s*hai|thik\s*hai|ok|okay|acha|achha|accha|acche|haan|ha|han|haanji|hanji|ji|ji\s*haan|yes|yep|yeah|no|nahi|nahin|nhi|galat|sahi|bilkul|नमस्ते|नमस्कार|हेलो|हाय|प्रणाम|राम\s*राम|सलाम|शुक्रिया|धन्यवाद|थैंक्स|ठीक\s*है|अच्छा|हाँ|हां|जी|जी\s*हाँ|जी\s*हां|नहीं|नही|गलत|सही|बिल्कुल)[.!?।\s]*$/iu;

const CONVERSATIONAL_NON_LOCATION_PATTERN =
  /^(?:(?:main|hum|मैं|हम)\s+(?:ek\s+)?(?:achh[ai]|theek|thik|ready|tayar|fresher|housewife|student|तैयार|हाउसवाइफ|स्टूडेंट)\s+(?:hoon|hain|hu|हूँ|हूं|हैं)|(?:mera|meri|मेरा|मेरी)\s+naam\s+[a-z\s]+|mera\s+naam\s+.*|मेरा\s+नाम\s+.*|(?:aap|आप)\s+(?:kaise|kaun|kya|batao|bataiye|samjhao|sun\s+rahe|कैसे|कौन|क्या|बताओ|बताइए|सुन\s+रहे)[^]*|(?:kya|क्या)\s+(?:kaam|hoga|karna|hai|process|batao|काम|होगा|करना|है|प्रोसेस)[^]*|(?:mujhe|मुझे)\s+(?:kaam|job|paisa|काम|जॉब|पैसा)\s+(?:chahiye|karna|चाहिए|करना)|(?:kab|कब)\s+(?:shuru|aana|hoga|शुरू|आना|होगा)[^]*|interview\s+kab[^]*|इंटरव्यू\s+कब[^]*|aap\s+kaun\s+bol\s+rahe[^]*|आप\s+कौन\s+बोल\s+रहे[^]*|how\s+are\s+you|what\s+is\s+this|who\s+are\s+you|i\s+am\s+ready|my\s+name\s+is[^]*)[.!?।\s]*$/iu;

const KNOWN_CITIES_AND_LOCALITIES =
  /\b(?:delhi|new\s+delhi|noida|greater\s+noida|gurgaon|gurugram|ghaziabad|faridabad|mumbai|navi\s+mumbai|thane|pune|bangalore|bengaluru|hyderabad|secunderabad|chennai|kolkata|jaipur|lucknow|chandigarh|mohali|panchkula|ahmedabad|surat|indore|bhopal|patna|kanpur|nagpur|hsr|btm|koramangala|indiranagar|whitefield|jayanagar|marathahalli|bellandur|electronic\s*city|hebbal|rajajinagar|malleshwaram|banashankari|yelahanka|sarjapur|kammanahalli|rohini|dwarka|janakpuri|saket|lajpat\s*nagar|karol\s*bagh|laxmi\s*nagar|connaught\s*place|cp|okhla|pitampura|vasant\s*kunj|mayur\s*vihar|hauz\s*khas|malviya\s*nagar|uttam\s*nagar|paschim\s*vihar|kothrud|viman\s*nagar|wakad|hinjewadi|baner|hadapsar|aundh|pimpri|chinchwad|magarpatta|kalyani\s*nagar|andheri|bandra|borivali|powai|dadar|goregaon|malad|kandivali|vashi|nerul|chembur|ghatkopar|mulund|(?:sector|sec|phase|block)\s*(?:[0-9]{1,3}[a-z]?|[a-z]\b))\b|(?:दिल्ली|नई\s+दिल्ली|नोएडा|ग्रेटर\s+नोएडा|गुड़गांव|गुड़गाँव|गुरुग्राम|गाजियाबाद|फ़रीदाबाद|फरीदाबाद|मुंबई|नवी\s+मुंबई|ठाणे|पुणे|बैंगलोर|बेंगलुरु|हैदराबाद|सिकंदराबाद|चेन्नई|कोलकाता|जयपुर|लखनऊ|चंडीगढ़|मोहाली|पंचकुला|अहमदाबाद|सूरत|इंदौर|भोपाल|पटना|कानपुर|नागपुर|रोहिणी|द्वारका|द्वारिका|जनकपुरी|साकेत|लाजपत\s*नगर|करोल\s*बाग|लक्ष्मी\s*नगर|कनॉट\s*प्लेस|ओखला|पीतमपुरा|वसंत\s*कुंज|मयूर\s*विहार|हौज\s*खास|मालवीय\s*नगर|उत्तम\s*नगर|पश्चिम\s*विहार|कोथरुड|विमान\s*नगर|वाकड़|हिंजेवाड़ी|बानेर|हड़पसर|औंध|पिंपरी|चिंचवाड़|मगरपट्टा|कल्याणी\s*नगर|अंधेरी|बांद्रा|बोरीवली|पवई|दादर|गोरेगांव|मलाड|कांदिवली|वाशी|नेरुल|चेंबूर|घाटकोपर|मुलुंड|एचएसआर|बीटीएम|कोरमंगला|इंदिरानगर|व्हाइटफील्ड|जयनगर|मराठाहल्ली|बेलंदूर|इलेक्ट्रॉनिक\s*सिटी|हेब्बल|राजाजीनगर|मल्लेश्वरम|बनाशंकरी|यलहंका|सरजापुर|कम्मनहल्ली|(?:सेक्टर|फ़ेज़|फेज|ब्लॉक)\s*(?:[0-9]{1,3}[a-z]?|[a-z]\b|[०-९]{1,3}))/iu;

const BARE_GENERIC_LOCATION_DESCRIPTORS =
  /^(?:(?:apn[aei]|local|kisi|mere|mera|meri|main|ye|yeh|kuch|is|ek|the|अपने|अपनी|अपना|लोकल|किसी|मेरे|मेरा|मेरी|मैं|ये|यह|कुछ|इस|एक|मेन)\s+)?(?:area|market|bazar|bazaar|sector|sec|road|colony|block|society|apartment|apartments|gali|street|chowk|village|gaon|dist|district|ilaqa|ilaqe|city|sheher|place|jagah|location|एरिया|मार्केट|बाजार|बाज़ार|सेक्टर|रोड|सड़क|सडक|कॉलोनी|कालोनी|ब्लॉक|सोसायटी|सोसाइटी|अपार्टमेंट|गली|चौक|गांव|गाँव|जिला|ज़िला|इलाका|इलाके|शहर|जगह|स्थान)(?:\s+(?:mein|pe|par|se|ke|ki|ka|hai|hain|hoon|hu|rehti|rehta|rahe|hoti|hota|में|पे|पर|से|के|की|का|है|हैं|हूँ|हूं|रहती|रहता|रहे|होती|होता))*[.!?।\s]*$/iu;

function classifyLocation(answer) {
  const text = answer.trim().toLowerCase();

  // An empty, vague, or irrelevant response needs clarification.
  const irrelevantPattern =
    /\b(?:biryani|pizza|burger|cricket|movie|movies|anime|song|songs|dance|dancing|gaana|khana|aaloo|aloo|potato|football|habba\s+jabba|bla\s+bla|asdf|qwerty|chair|table|desk|sofa|bed|furniture|mobile|phone|smartphone|laptop|computer|tablet|pen|pencil|paper|book|bottle|cup|glass|plate|spoon|fork|fan|light|tv|television|ac|fridge|refrigerator|door|window|wall|floor|roof|cat|dog|billi|kutta|animal|bird|clothes|shirt|pant|shoes|chappal|samosa|chai|tea|coffee|ice\s*cream|zxcv|foo|bar|baz|qux|test|testing|kuch\s+bhi|koi\s+bhi|random)\b/i;

  const isOnlyVehicle =
    /^(?:car|bike|scooty|scooter|bus|metro|auto|train|gaadi|two\s*wheeler)[.!?\s]*$/i.test(text);

  const hasRepeatedChars = /(.)\1{2,}/u.test(text);

  const words = text.split(/\s+/).filter(Boolean);
  const isConversationalWithoutLocation =
    words.length >= 3 &&
    !KNOWN_CITIES_AND_LOCALITIES.test(text) &&
    /\b(?:main|mera|meri|mere|mujhe|aap|aapka|aapki|aapke|tum|hum|kya|kyun|kyu|kaise|kaun|kab|batao|bataiye|chahiye|hoga|hogi|karna|karengi|hoon|hai|hain|tha|thi|the|achha|achhi|lagta|lagti|kuch|pasand|rehti|rehta|main\s+road)\b|(?:मुझे|पसंद|है|हैं|हूँ|हूं|मैं|हम|मेरा|मेरी|मेरे|आपका|आपकी|आपके|आप|तुम|क्या|क्यों|क्यूं|कैसे|कौन|कब|बताओ|बताइए|चाहिए|होगा|होगी|करना|करूंगी|रहती|रहता|था|थी|थे|अच्छा|अच्छी|लगता|लगती|कुछ|में|पे|पर|से|पसंद\s+है)/iu.test(text);

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
