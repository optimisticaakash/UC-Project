let JWT;
try {
  ({ JWT } = require("google-auth-library"));
} catch (_err) {
  JWT = null;
}

const SHEET_HEADERS = [
  "Session ID",
  "Candidate ID",
  "Candidate Name",
  "Question ID",
  "Official Question",
  "Candidate Response",
  "Interpreted Status",
  "Follow-ups",
  "Validation Result",
  "Manual Review Required",
  "Interview Status",
  "Timestamp",
  "Report Reference",
];

const syncedKeys = new Set();
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

function formatRow({ session, answerRecord, candidateName, reportReference }) {
  const sessionId = session?.sessionId || "";
  const candidateId = session?.candidateId || "N/A";
  const name = candidateName || session?.candidateName || "Name not recorded";
  const questionId = answerRecord?.questionId || "";
  const questionText = answerRecord?.questionText || "";
  const answer = answerRecord?.answer || "";

  const interpretationStatus =
    answerRecord?.interpretation?.answerStatus ||
    answerRecord?.locationOutcome ||
    answerRecord?.consentOutcome ||
    answerRecord?.eligibilityOutcome ||
    "recorded";

  let followUps = "None";
  if (answerRecord?.isFollowUp) {
    followUps = `Follow-up to ${answerRecord.parentQuestionId || "question"}: ${answer}`;
  } else if (answerRecord?.followUpAnswer) {
    followUps = `Follow-up: ${answerRecord.followUpAnswer}`;
  }

  const validationResult =
    answerRecord?.eligibilityOutcome ||
    answerRecord?.locationOutcome ||
    answerRecord?.consentOutcome ||
    (answerRecord?.interpretation ? "interpreted" : "accepted");

  const manualReview =
    session?.manualReviewRequired || answerRecord?.manualReviewRequired
      ? "Yes"
      : "No";

  const interviewStatus = session?.status || "in_progress";
  const timestamp = answerRecord?.answeredAt || new Date().toISOString();
  const ref = reportReference || `/api/interview/${sessionId}/report`;

  return [
    sessionId,
    candidateId,
    name,
    questionId,
    questionText,
    answer,
    interpretationStatus,
    followUps,
    validationResult,
    manualReview,
    interviewStatus,
    timestamp,
    ref,
  ];
}

async function syncAnswerToSheet({
  session,
  answerRecord,
  candidateName,
  fetchImpl = fetch,
  jwtClientFactory = getJwtClient,
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
    const tabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Interview Responses";
    const client = jwtClientFactory();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse?.token || tokenResponse;

    const row = formatRow({ session, answerRecord, candidateName });
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(tabName)}!A:M:append?valueInputOption=USER_ENTERED`;

    const response = await fetchImpl(appendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        values: [row],
      }),
    });

    if (!response.ok) {
      console.error("[UC Google Sheets] Failed to append row to Google Sheet:", {
        status: response.status,
      });
      return { success: false, reason: `http_${response.status}` };
    }

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

function clearSyncCache() {
  syncedKeys.clear();
  unconfiguredLogged = false;
}

module.exports = {
  SHEET_HEADERS,
  isConfigured,
  formatRow,
  syncAnswerToSheet,
  clearSyncCache,
};

