let JWT;
try {
  ({ JWT } = require("google-auth-library"));
} catch (_err) {
  JWT = null;
}

const questionBank = require("../data/questionBank.json");
const { persistence } = require("./persistence");

const SCREENING_TAB = "Screening Sheet";
const ANSWERS_TAB = "Answers";

// Map question IDs to official text and short descriptive labels
const questionMap = new Map();
const questionLabelMap = new Map();

if (Array.isArray(questionBank?.questions)) {
  for (const q of questionBank.questions) {
    const id = q.id || q.Step;
    const text = q.text || q["Bot says (primary)"] || q["Bot says(primary)"];
    if (id && text) {
      questionMap.set(id, text);
    }
    if (id) {
      const shortDesc = q.Block || q["Signal captured → sheet field"] || "Question";
      questionLabelMap.set(id, `${id}: ${shortDesc}`);
    }
  }
}

function getQuestionLabel(questionId) {
  if (!questionId) return "General Question";
  if (questionLabelMap.has(questionId)) {
    return questionLabelMap.get(questionId);
  }
  const baseId = questionId.split("_")[0];
  if (questionLabelMap.has(baseId)) {
    return `${questionId}: Follow-up (${questionLabelMap.get(baseId)})`;
  }
  return questionId;
}

// 69 Column Section Headings (Row 1 of Screening Sheet)
const SCREENING_SECTIONS = [
  // A-G (Cols 0-6): Candidate (7 cols)
  "Candidate", "Candidate", "Candidate", "Candidate", "Candidate", "Candidate", "Candidate",
  // H-W (Cols 7-22): Basic checks (16 cols)
  "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks", "Basic checks",
  // X-AD (Cols 23-29): Experience (7 cols)
  "Experience", "Experience", "Experience", "Experience", "Experience", "Experience", "Experience",
  // AE-AM (Cols 30-38): Need for money (9 cols)
  "Need for money", "Need for money", "Need for money", "Need for money", "Need for money", "Need for money", "Need for money", "Need for money", "Need for money",
  // AN-AO (Cols 39-40): Intent (2 cols)
  "Intent", "Intent",
  // AP-AW (Cols 41-48): Availability (8 cols)
  "Availability", "Availability", "Availability", "Availability", "Availability", "Availability", "Availability", "Availability",
  // AX-BG (Cols 49-58): Disha result (10 cols)
  "Disha result", "Disha result", "Disha result", "Disha result", "Disha result", "Disha result", "Disha result", "Disha result", "Disha result", "Disha result",
  // BH-BQ (Cols 59-68): Team to fill (10 cols)
  "Team to fill", "Team to fill", "Team to fill", "Team to fill", "Team to fill", "Team to fill", "Team to fill", "Team to fill", "Team to fill", "Team to fill",
];

// 69 Column Field Headings (Row 2 of Screening Sheet)
const SCREENING_HEADERS = [
  "Date", // 0 (A)
  "Candidate", // 1 (B)
  "Report ID", // 2 (C)
  "Language", // 3 (D)
  "Area", // 4 (E)
  "Nearest hub", // 5 (F)
  "Open to moving / travel", // 6 (G)
  "Age", // 7 (H)
  "Marital status", // 8 (I)
  "Kids", // 9 (J)
  "Youngest child age", // 10 (K)
  "Caregiver for kids", // 11 (L)
  "Pregnant / baby plan", // 12 (M)
  "Own salon / own clients", // 13 (N)
  "Does pedicure", // 14 (O)
  "Bikini wax", // 15 (P)
  "Travel 3–4 km", // 16 (Q)
  "2-wheeler", // 17 (R)
  "Travels on her own", // 18 (S)
  "English reading", // 19 (T)
  "Spoken Hindi / English", // 20 (U)
  "Worked with UC before", // 21 (V)
  "UC numbers used", // 22 (W)
  "Experience (years)", // 23 (X)
  "Salons worked at", // 24 (Y)
  "Last salon name", // 25 (Z)
  "Rates quoted", // 26 (AA)
  "Salon type", // 27 (AB)
  "Why she left", // 28 (AC)
  "Physical / health note", // 29 (AD)
  "Household income sources", // 30 (AE)
  "Husband working", // 31 (AF)
  "Husband occupation", // 32 (AG)
  "Husband earning", // 33 (AH)
  "Earner type", // 34 (AI)
  "Need for money", // 35 (AJ)
  "Need detail", // 36 (AK)
  "Accepts ₹40–50k minimum", // 37 (AL)
  "Minimum she needs / month", // 38 (AM)
  "Why UC", // 39 (AN)
  "Exit risks", // 40 (AO)
  "Weekend 11 hrs OK", // 41 (AP)
  "Weekend note", // 42 (AQ)
  "Weekday hours OK", // 43 (AR)
  "Training OK", // 44 (AS)
  "Models she can bring", // 45 (AT)
  "₹2,000 kit OK", // 46 (AU)
  "Start date", // 47 (AV)
  "PAN–Aadhaar linked", // 48 (AW)
  "Disha result", // 49 (AX)
  "Score", // 50 (AY)
  "Soft skill", // 51 (AZ)
  "Technical", // 52 (BA)
  "Customer scenarios", // 53 (BB)
  "Tone role-play", // 54 (BC)
  "Not correct", // 55 (BD)
  "Attitude flags", // 56 (BE)
  "Review flags", // 57 (BF)
  "Duration (min)", // 58 (BG)
  "Hard skill result", // 59 (BH)
  "Age verified (Aadhaar)", // 60 (BI)
  "Weight (kg)", // 61 (BJ)
  "Grooming", // 62 (BK)
  "UC profile check", // 63 (BL)
  "Area / hub confirmed", // 64 (BM)
  "Batch", // 65 (BN)
  "Final decision", // 66 (BO)
  "Screener", // 67 (BP)
  "Comments", // 68 (BQ)
];

// 9 Column Headers for Answers Tab
const ANSWERS_HEADERS = [
  "Date",
  "Candidate",
  "Report ID",
  "Question",
  "What she said (verbatim)",
  "Bucket",
  "Result",
  "Correct?",
  "Key quote",
];

// In-memory cache for synchronization and deduplication
const syncedKeys = new Set();
const candidateRowIndices = new Map();
const initializedTabs = new Set();
let unconfiguredLogged = false;

function isConfigured() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  return Boolean(JWT && sheetId && clientEmail && privateKey);
}

function getJwtClient() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || "";
  if (privateKey.includes("\\n")) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  return new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

/**
 * Resolves the candidate's actual name from the authoritative MongoDB candidate record.
 * Never returns the candidate ID, session ID, user ID, or a fabricated placeholder name.
 */
async function resolveCandidateName({
  session,
  candidateId,
  persistenceImpl = persistence,
} = {}) {
  const targetId = candidateId || session?.candidateId;
  if (!targetId) {
    return "Unresolved candidate (needs review)";
  }

  try {
    if (persistenceImpl && typeof persistenceImpl.findCandidateById === "function") {
      const candidate = await persistenceImpl.findCandidateById(targetId);
      if (candidate?.name && typeof candidate.name === "string" && candidate.name.trim()) {
        return candidate.name.trim();
      }
    }
  } catch (err) {
    console.error("[UC Google Sheets] Failed to resolve candidate name:", err?.name || "Error");
  }

  return "Unresolved candidate (needs review)";
}

/**
 * Formats a 9-element row for the Answers tab.
 */
function formatAnswerRow({
  session,
  answerRecord,
  candidateName,
  reportId,
}) {
  const date = answerRecord?.answeredAt || session?.startedAt || new Date().toISOString();
  const name = candidateName || "Unresolved candidate (needs review)";
  const repId = reportId || session?.reportId || session?.sessionId || "";
  const questionId = answerRecord?.questionId || "";
  const questionLabel = getQuestionLabel(questionId);

  const verbatim =
    typeof answerRecord?.answer === "string"
      ? answerRecord.answer
      : answerRecord?.answer != null
        ? String(answerRecord.answer)
        : "";

  const bucket = answerRecord?.bucket || answerRecord?.interpretation?.bucket || "";
  const result =
    answerRecord?.interpretation?.answerStatus ||
    answerRecord?.eligibilityOutcome ||
    answerRecord?.locationOutcome ||
    answerRecord?.consentOutcome ||
    "";

  let isCorrect = "";
  if (answerRecord?.correct != null) {
    isCorrect = answerRecord.correct ? "Correct" : "Not correct";
  } else if (answerRecord?.isCorrect != null) {
    isCorrect = answerRecord.isCorrect ? "Correct" : "Not correct";
  }

  const keyQuote =
    answerRecord?.keyQuote ||
    answerRecord?.interpretation?.keyQuote ||
    (answerRecord?.manualReviewReason ? answerRecord.manualReviewReason : "");

  return [
    date,
    name,
    repId,
    questionLabel,
    verbatim,
    bucket,
    result,
    isCorrect,
    keyQuote,
  ];
}

/**
 * Formats a 69-element horizontal row for the Screening Sheet tab.
 */
function formatScreeningRow({
  session,
  candidateName,
  reportId,
}) {
  const date = session?.completedAt || session?.endedAt || session?.startedAt || new Date().toISOString();
  const name = candidateName || "Unresolved candidate (needs review)";
  const repId = reportId || session?.reportId || session?.sessionId || "";

  const answers = Array.isArray(session?.answers) ? session.answers : [];
  const getAns = (qId) => answers.find((a) => a.questionId === qId)?.answer || "";
  const getRec = (qId) => answers.find((a) => a.questionId === qId);

  // A0: Language & Consent
  const a0Rec = getRec("A0");
  const lang = session?.language || (a0Rec?.consentOutcome ? "Hindi" : "") || getAns("A0");

  // A1: Area, Nearest hub, Open to moving
  const a1Rec = getRec("A1");
  const area = a1Rec?.location || getAns("A1");
  const nearestHub = a1Rec?.nearestHub || "";
  const openToMoving = a1Rec?.travelWillingness || (a1Rec ? "Yes" : "");

  // A2: Age
  const a2Rec = getRec("A2");
  const age = a2Rec?.age || getAns("A2");

  // A3: Marital status & kids
  const maritalStatus = getAns("A3");
  const kids =
    session?.childQuestionApplicability?.hasChildren === false
      ? "0"
      : getAns("A3") || "";

  // A4: Youngest child age
  const youngestChildAge = getAns("A4");

  // A5: Caregiver for kids
  const caregiver = getAns("A5");

  // A6: Pregnant / baby plan
  const pregnant = getAns("A6");

  // A7: Own salon / own clients
  const ownSalon = getAns("A7");

  // A8: Does pedicure & bikini wax
  const doesPedicure = getAns("A8");
  const bikiniWax = getAns("A8");

  // A9: Travel 3-4km, 2-wheeler, travels on her own
  const travel34 = getAns("A9");
  const twoWheeler = getAns("A9");
  const travelsOwn = getAns("A9");

  // A10: English reading
  const englishReading = getAns("A10");

  // A11: Spoken Hindi / English
  const spokenLanguage = getAns("A11");

  // A12: Worked with UC before & numbers used
  const workedUc = getAns("A12");
  const ucNumbers = getAns("A12");

  // Experience: B2, B3, B4, B1
  const experienceYears = getAns("B2");
  const salonsWorked = getAns("B2");
  const lastSalon = getAns("B3");
  const ratesQuoted = getAns("B3");
  const salonType = getAns("B3");
  const whyLeft = getAns("B4");
  const physicalNote = getAns("B1");

  // Need for money: B5, B6, B7, B8
  const householdIncome = getAns("B5");
  const husbandWorking = getAns("B5");
  const husbandOccupation = getAns("B5");
  const husbandEarning = getAns("B5");
  const earnerType = getAns("B6");
  const needMoney = getAns("B7");
  const needDetail = getAns("B7");
  const acceptsMin = getAns("B8");
  const minNeeded = getAns("B8");

  // Intent: B10, B12
  const whyUc = getAns("B10");
  const exitRisks = getAns("B12");

  // Availability: B13-B19
  const weekendOk = getAns("B13");
  const weekendNote = getAns("B13");
  const weekdayOk = getAns("B14");
  const trainingOk = getAns("B15");
  const models = getAns("B16");
  const kitOk = getAns("B17");
  const startDate = getAns("B18");
  const panAadhaar = getAns("B19");

  // Disha Result & Scoring
  let dishaResult = "In progress";
  if (session?.status === "completed") {
    dishaResult = session?.manualReviewRequired ? "Manual review" : "Auto-pass";
  } else if (session?.status === "rejected") {
    dishaResult = "Reject";
  } else if (session?.status === "terminated") {
    dishaResult = "Terminated";
  } else if (session?.manualReviewRequired) {
    dishaResult = "Manual review";
  } else if (session?.status) {
    dishaResult = session.status;
  }

  const score = session?.score != null ? String(session.score) : "";
  const softSkill = session?.softSkillScore != null ? String(session.softSkillScore) : "";
  const technical = session?.technicalScore != null ? String(session.technicalScore) : "";
  const customerScenarios = session?.scenarioScore != null ? String(session.scenarioScore) : "";
  const toneRolePlay = session?.toneScore != null ? String(session.toneScore) : "";
  const notCorrect = session?.notCorrectSummary || "";
  const attitudeFlags = session?.attitudeFlags || "";
  const reviewFlags = session?.manualReviewReason || (session?.manualReviewRequired ? "Yes" : "");

  let durationMin = "";
  if (session?.startedAt && (session?.completedAt || session?.endedAt)) {
    const startMs = new Date(session.startedAt).getTime();
    const endMs = new Date(session.completedAt || session.endedAt).getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
      durationMin = String(Math.round(((endMs - startMs) / 60000) * 10) / 10);
    }
  }

  return [
    date, // 0 (A)
    name, // 1 (B)
    repId, // 2 (C)
    lang, // 3 (D)
    area, // 4 (E)
    nearestHub, // 5 (F)
    openToMoving, // 6 (G)
    age, // 7 (H)
    maritalStatus, // 8 (I)
    kids, // 9 (J)
    youngestChildAge, // 10 (K)
    caregiver, // 11 (L)
    pregnant, // 12 (M)
    ownSalon, // 13 (N)
    doesPedicure, // 14 (O)
    bikiniWax, // 15 (P)
    travel34, // 16 (Q)
    twoWheeler, // 17 (R)
    travelsOwn, // 18 (S)
    englishReading, // 19 (T)
    spokenLanguage, // 20 (U)
    workedUc, // 21 (V)
    ucNumbers, // 22 (W)
    experienceYears, // 23 (X)
    salonsWorked, // 24 (Y)
    lastSalon, // 25 (Z)
    ratesQuoted, // 26 (AA)
    salonType, // 27 (AB)
    whyLeft, // 28 (AC)
    physicalNote, // 29 (AD)
    householdIncome, // 30 (AE)
    husbandWorking, // 31 (AF)
    husbandOccupation, // 32 (AG)
    husbandEarning, // 33 (AH)
    earnerType, // 34 (AI)
    needMoney, // 35 (AJ)
    needDetail, // 36 (AK)
    acceptsMin, // 37 (AL)
    minNeeded, // 38 (AM)
    whyUc, // 39 (AN)
    exitRisks, // 40 (AO)
    weekendOk, // 41 (AP)
    weekendNote, // 42 (AQ)
    weekdayOk, // 43 (AR)
    trainingOk, // 44 (AS)
    models, // 45 (AT)
    kitOk, // 46 (AU)
    startDate, // 47 (AV)
    panAadhaar, // 48 (AW)
    dishaResult, // 49 (AX)
    score, // 50 (AY)
    softSkill, // 51 (AZ)
    technical, // 52 (BA)
    customerScenarios, // 53 (BB)
    toneRolePlay, // 54 (BC)
    notCorrect, // 55 (BD)
    attitudeFlags, // 56 (BE)
    reviewFlags, // 57 (BF)
    durationMin, // 58 (BG)
    "", // 59 (BH) Hard skill result (Team to fill)
    "", // 60 (BI) Age verified (Aadhaar)
    "", // 61 (BJ) Weight (kg)
    "", // 62 (BK) Grooming
    "", // 63 (BL) UC profile check
    "", // 64 (BM) Area / hub confirmed
    "", // 65 (BN) Batch
    "", // 66 (BO) Final decision
    "", // 67 (BP) Screener
    "", // 68 (BQ) Comments
  ];
}

/**
 * Backward compatibility helper for legacy format tests.
 */
function formatRow({ session, answerRecord, candidateName, reportReference }) {
  const ansRow = formatAnswerRow({
    session,
    answerRecord,
    candidateName,
    reportId: session?.reportId || session?.sessionId,
  });
  const questionId = answerRecord?.questionId || "";
  const questionText = answerRecord?.questionText || questionMap.get(questionId) || "";

  return [
    session?.sessionId || "",
    session?.candidateId || "N/A",
    candidateName || session?.candidateName || "Unresolved candidate (needs review)",
    questionId,
    questionText,
    ansRow[4], // verbatim answer
    ansRow[6] || "recorded", // interpreted status
    answerRecord?.followUpAnswer ? `Follow-up: ${answerRecord.followUpAnswer}` : "None",
    ansRow[6] || "accepted", // validation result
    session?.manualReviewRequired || answerRecord?.manualReviewRequired ? "Yes" : "No",
    session?.status || "in_progress",
    ansRow[0], // timestamp
    reportReference || `/api/interview/${session?.sessionId || ""}/report`,
  ];
}

/**
 * Ensures both 'Screening Sheet' and 'Answers' tabs exist and their headers are initialized.
 * If removeObsoleteInterviewResponses is true and 'Interview Responses' is completely empty
 * (apart from its 1 header row), removes the obsolete tab.
 */
async function ensureTabsAndHeaders({
  sheetId,
  accessToken,
  fetchImpl,
  removeObsoleteInterviewResponses = false,
}) {
  const cacheKey = `${sheetId}:both_tabs`;
  if (initializedTabs.has(cacheKey)) {
    return true;
  }

  try {
    // 1. Get spreadsheet sheets metadata
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets.properties`;
    const metaRes = await fetchImpl(metaUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!metaRes.ok) {
      console.error("[UC Google Sheets] Failed to fetch spreadsheet metadata:", metaRes.status);
      return false;
    }

    const metaData = await metaRes.json();
    const existingSheets = metaData?.sheets || [];
    const sheetTitles = new Set(existingSheets.map((s) => s.properties?.title));

    const requests = [];
    if (!sheetTitles.has(SCREENING_TAB)) {
      requests.push({ addSheet: { properties: { title: SCREENING_TAB } } });
    }
    if (!sheetTitles.has(ANSWERS_TAB)) {
      requests.push({ addSheet: { properties: { title: ANSWERS_TAB } } });
    }

    if (requests.length > 0) {
      const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`;
      const batchRes = await fetchImpl(batchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests }),
      });
      if (!batchRes.ok) {
        console.error("[UC Google Sheets] Failed to add required tabs:", batchRes.status);
        return false;
      }
    }

    // 2. Initialize Screening Sheet headers if blank
    const screeningCheckUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(SCREENING_TAB)}!A1:BQ2`;
    const screeningCheckRes = await fetchImpl(screeningCheckUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (screeningCheckRes.ok) {
      const sData = await screeningCheckRes.json().catch(() => null);
      const isBlank = !sData?.values || sData.values.length === 0 || !sData.values[0] || sData.values[0].length === 0;
      if (isBlank) {
        const initUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(SCREENING_TAB)}!A1:BQ2?valueInputOption=USER_ENTERED`;
        await fetchImpl(initUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            values: [SCREENING_SECTIONS, SCREENING_HEADERS],
          }),
        });
      }
    }

    // 3. Initialize Answers headers if blank
    const answersCheckUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(ANSWERS_TAB)}!A1:I1`;
    const answersCheckRes = await fetchImpl(answersCheckUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (answersCheckRes.ok) {
      const aData = await answersCheckRes.json().catch(() => null);
      const isBlank = !aData?.values || aData.values.length === 0 || !aData.values[0] || aData.values[0].length === 0;
      if (isBlank) {
        const initUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(ANSWERS_TAB)}!A1:I1?valueInputOption=USER_ENTERED`;
        await fetchImpl(initUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            values: [ANSWERS_HEADERS],
          }),
        });
      }
    }

    // 4. Safe removal of obsolete Interview Responses tab if requested
    if (removeObsoleteInterviewResponses) {
      const obsoleteSheet = existingSheets.find((s) => s.properties?.title === "Interview Responses");
      if (obsoleteSheet) {
        // Verify it is completely empty apart from header row
        const valUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/Interview%20Responses!A:A`;
        const valRes = await fetchImpl(valUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (valRes.ok) {
          const valData = await valRes.json();
          const rowCount = (valData?.values || []).length;
          if (rowCount <= 1) {
            // Safe to delete obsolete empty tab
            const delUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`;
            await fetchImpl(delUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                requests: [{ deleteSheet: { sheetId: obsoleteSheet.properties.sheetId } }],
              }),
            });
            console.info("[UC Google Sheets] Safely deleted obsolete Interview Responses tab (0 candidate data rows).");
          } else {
            console.warn(
              "[UC Google Sheets] Preserved Interview Responses tab: contains data rows beyond header.",
            );
          }
        }
      }
    }

    initializedTabs.add(cacheKey);
    return true;
  } catch (err) {
    console.error("[UC Google Sheets] Header & tab initialization failed:", err?.name || "Error");
    return false;
  }
}

/**
 * Updates or appends the candidate summary row in the 'Screening Sheet' tab.
 * Updates the existing candidate row rather than appending a new row for every question.
 */
async function syncCandidateSummaryToSheet({
  session,
  candidateName,
  sheetId,
  accessToken,
  fetchImpl,
}) {
  const repId = session?.reportId || session?.sessionId;
  if (!repId) return { success: false, reason: "missing_session_id" };

  try {
    let rowIndex = candidateRowIndices.get(repId);

    // If not cached, look up in Column C of Screening Sheet (Report ID)
    if (!rowIndex) {
      const readColUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(SCREENING_TAB)}!C3:C`;
      const colRes = await fetchImpl(readColUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (colRes.ok) {
        const colData = await colRes.json();
        const existingIds = (colData?.values || []).map((row) => row[0]);
        const matchIdx = existingIds.indexOf(repId);
        if (matchIdx !== -1) {
          rowIndex = 3 + matchIdx; // 1-based, data starts at Row 3 (Row 1=sections, Row 2=headers)
          candidateRowIndices.set(repId, rowIndex);
        }
      }
    }

    const summaryRow = formatScreeningRow({
      session,
      candidateName,
      reportId: repId,
    });

    if (rowIndex) {
      // Update existing candidate row in-place
      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(SCREENING_TAB)}!A${rowIndex}:BQ${rowIndex}?valueInputOption=USER_ENTERED`;
      const updateRes = await fetchImpl(updateUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [summaryRow] }),
      });
      return { success: updateRes.ok, updated: true, rowIndex };
    } else {
      // Append new candidate row
      const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(SCREENING_TAB)}!A:BQ:append?valueInputOption=USER_ENTERED`;
      const appendRes = await fetchImpl(appendUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [summaryRow] }),
      });

      if (appendRes.ok) {
        const appendData = await appendRes.json().catch(() => null);
        const updatedRange = appendData?.updates?.updatedRange || "";
        const rowMatch = updatedRange.match(/!A(\d+)/);
        if (rowMatch && rowMatch[1]) {
          candidateRowIndices.set(repId, parseInt(rowMatch[1], 10));
        }
      }
      return { success: appendRes.ok, appended: true };
    }
  } catch (err) {
    console.error("[UC Google Sheets] Failed to update candidate summary row:", err?.name || "Error");
    return { success: false, error: err?.name || "Error" };
  }
}

/**
 * Synchronizes an accepted candidate answer to the 'Answers' tab,
 * and updates the candidate's horizontal summary row in the 'Screening Sheet' tab.
 */
async function syncAnswerToSheet({
  session,
  answerRecord,
  candidateName: providedName,
  fetchImpl = fetch,
  jwtClientFactory = getJwtClient,
  persistenceImpl = persistence,
} = {}) {
  if (!session || !answerRecord) {
    return { success: false, reason: "missing_data" };
  }

  const syncKey = `${session.sessionId}:${answerRecord.questionId}:${answerRecord.answer}`;
  if (syncedKeys.has(syncKey)) {
    return { success: true, synced: false, reason: "already_synced" };
  }

  if (!isConfigured()) {
    if (!unconfiguredLogged) {
      unconfiguredLogged = true;
      console.info(
        "[UC Google Sheets] Google Sheets integration is unconfigured; interview data is safely persisted in MongoDB only.",
      );
    }
    return { success: true, synced: false, reason: "unconfigured" };
  }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const client = jwtClientFactory();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse?.token || tokenResponse;

    await ensureTabsAndHeaders({ sheetId, accessToken, fetchImpl });

    // Resolve authoritative candidate name via MongoDB candidate record
    const candidateName =
      providedName ||
      (await resolveCandidateName({
        session,
        candidateId: session.candidateId,
        persistenceImpl,
      }));

    const reportId = session.reportId || session.sessionId;

    // 1. Append accepted answer row to 'Answers' tab
    const answerRow = formatAnswerRow({
      session,
      answerRecord,
      candidateName,
      reportId,
    });

    const appendAnswerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(ANSWERS_TAB)}!A:I:append?valueInputOption=USER_ENTERED`;
    const response = await fetchImpl(appendAnswerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        values: [answerRow],
      }),
    });

    if (!response.ok) {
      console.error("[UC Google Sheets] Failed to append answer row:", {
        status: response.status,
      });
      return { success: false, reason: `http_${response.status}` };
    }

    // 2. Update candidate summary row in 'Screening Sheet' tab in-place
    await syncCandidateSummaryToSheet({
      session,
      candidateName,
      sheetId,
      accessToken,
      fetchImpl,
    });

    syncedKeys.add(syncKey);
    return { success: true, synced: true };
  } catch (error) {
    console.error("[UC Google Sheets] Sync error (MongoDB remains primary):", {
      errorName: error?.name || "Error",
      message: error?.message?.slice(0, 100),
    });
    return { success: false, error: error?.name || "Error" };
  }
}

/**
 * Synchronizes the candidate's final interview summary to 'Screening Sheet' on completion.
 */
async function syncSessionSummaryToSheet({
  session,
  candidateName: providedName,
  fetchImpl = fetch,
  jwtClientFactory = getJwtClient,
  persistenceImpl = persistence,
} = {}) {
  if (!session) return { success: false, reason: "missing_session" };
  if (!isConfigured()) return { success: true, synced: false, reason: "unconfigured" };

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const client = jwtClientFactory();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse?.token || tokenResponse;

    await ensureTabsAndHeaders({ sheetId, accessToken, fetchImpl });

    const candidateName =
      providedName ||
      (await resolveCandidateName({
        session,
        candidateId: session.candidateId,
        persistenceImpl,
      }));

    return await syncCandidateSummaryToSheet({
      session,
      candidateName,
      sheetId,
      accessToken,
      fetchImpl,
    });
  } catch (error) {
    console.error("[UC Google Sheets] Summary sync error:", error?.name || "Error");
    return { success: false, error: error?.name || "Error" };
  }
}

/**
 * Reads responses from the 'Answers' tab for the Admin Portal.
 */
async function readSheetRows({
  sheetId: overrideSheetId,
  tabName: overrideTabName,
  fetchImpl = fetch,
  jwtClientFactory = getJwtClient,
} = {}) {
  const sheetId = overrideSheetId || process.env.GOOGLE_SHEET_ID;
  const tabName = overrideTabName || ANSWERS_TAB;

  if (!isConfigured() && !overrideSheetId) {
    return { success: false, reason: "unconfigured" };
  }

  try {
    const client = jwtClientFactory();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse?.token || tokenResponse;

    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(tabName)}!A2:I`;

    const response = await fetchImpl(readUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      console.error("[UC Google Sheets] Failed to read rows from Google Sheet:", {
        status: response.status,
      });
      return { success: false, reason: `http_${response.status}` };
    }

    const data = await response.json();
    const rawRows = Array.isArray(data?.values) ? data.values : [];

    const rows = rawRows.map((row) => {
      const date = row[0] || "";
      const candidate = row[1] || "";
      const repId = row[2] || "";
      const question = row[3] || "";
      const verbatim = row[4] || "";
      const bucket = row[5] || "";
      const result = row[6] || "";
      const correct = row[7] || "";
      const keyQuote = row[8] || "";

      const questionId = question.split(":")[0].trim();
      const isManual =
        result === "manual_review" ||
        Boolean(keyQuote && /review|flag|uncertain/i.test(keyQuote));

      return {
        sessionId: repId,
        reportId: repId,
        candidateId: "",
        candidateName: candidate,
        questionId,
        question,
        officialQuestion: question,
        candidateResponse: verbatim,
        whatSheSaid: verbatim,
        bucket,
        result,
        correct,
        keyQuote,
        interpretedStatus: result || bucket || "recorded",
        followUps: "None",
        validationResult: result || "recorded",
        manualReviewRequired: isManual ? "Yes" : "No",
        interviewStatus: "recorded",
        timestamp: date,
        reportReference: `/api/interview/${repId}/report`,
      };
    });

    return {
      success: true,
      source: "google_sheets",
      rows,
    };
  } catch (error) {
    console.error("[UC Google Sheets] Read rows error:", {
      errorName: error?.name || "Error",
      message: error?.message?.slice(0, 100),
    });
    return { success: false, error: error?.name || "Error" };
  }
}

function clearSyncCache() {
  syncedKeys.clear();
  candidateRowIndices.clear();
  unconfiguredLogged = false;
  initializedTabs.clear();
}

module.exports = {
  SCREENING_TAB,
  ANSWERS_TAB,
  SCREENING_SECTIONS,
  SCREENING_HEADERS,
  ANSWERS_HEADERS,
  SHEET_HEADERS: ANSWERS_HEADERS, // Legacy alias for backward compatibility
  isConfigured,
  getQuestionLabel,
  resolveCandidateName,
  formatAnswerRow,
  formatScreeningRow,
  formatRow,
  ensureTabsAndHeaders,
  syncCandidateSummaryToSheet,
  syncAnswerToSheet,
  syncSessionSummaryToSheet,
  readSheetRows,
  clearSyncCache,
};
