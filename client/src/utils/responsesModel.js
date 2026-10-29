export const GOOGLE_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1N4_FZJMovlwRxtN1HvSGsAhbAmi1GaX1KKqrpZGE-58/edit";

export function formatResponseTimestamp(timestamp) {
  if (!timestamp) return "Date unavailable";
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return String(timestamp);
    return date.toLocaleString();
  } catch {
    return String(timestamp);
  }
}

export function filterResponses(
  responses = [],
  {
    search = "",
    statusFilter = "all",
    manualReviewFilter = "all",
    sortOrder = "newest",
  } = {},
) {
  if (!Array.isArray(responses)) return [];

  const query = search.trim().toLowerCase();

  const filtered = responses.filter((item) => {
    if (!item) return false;

    // 1. Search by candidateName, candidateId, sessionId, reportId, question, or response text
    if (query) {
      const name = String(item.candidateName || "").toLowerCase();
      const candId = String(item.candidateId || "").toLowerCase();
      const sessId = String(item.sessionId || "").toLowerCase();
      const repId = String(item.reportId || "").toLowerCase();
      const qId = String(item.questionId || "").toLowerCase();
      const qText = String(item.question || item.officialQuestion || "").toLowerCase();
      const ansText = String(item.whatSheSaid || item.candidateResponse || "").toLowerCase();
      if (
        !name.includes(query) &&
        !candId.includes(query) &&
        !sessId.includes(query) &&
        !repId.includes(query) &&
        !qId.includes(query) &&
        !qText.includes(query) &&
        !ansText.includes(query)
      ) {
        return false;
      }
    }

    // 2. Filter by interview status
    if (statusFilter && statusFilter !== "all") {
      const itemStatus = String(item.interviewStatus || "").toLowerCase();
      if (itemStatus !== statusFilter.toLowerCase()) {
        return false;
      }
    }

    // 3. Filter by manual review required
    if (manualReviewFilter && manualReviewFilter !== "all") {
      const isReviewRequired =
        String(item.manualReviewRequired || "").toLowerCase() === "yes" ||
        item.manualReviewRequired === true;

      if (manualReviewFilter.toLowerCase() === "yes" && !isReviewRequired) {
        return false;
      }
      if (manualReviewFilter.toLowerCase() === "no" && isReviewRequired) {
        return false;
      }
    }

    return true;
  });

  // 4. Sort by timestamp (newest first by default)
  return filtered.sort((left, right) => {
    const leftTime = left.timestamp || "";
    const rightTime = right.timestamp || "";
    if (sortOrder === "oldest") {
      return leftTime.localeCompare(rightTime);
    }
    return rightTime.localeCompare(leftTime);
  });
}

export function groupResponsesBySession(responses = []) {
  if (!Array.isArray(responses)) return [];

  const sessionMap = new Map();

  for (const item of responses) {
    const sessId = item.sessionId || item.reportId;
    if (!item || !sessId) continue;

    if (!sessionMap.has(sessId)) {
      sessionMap.set(sessId, {
        sessionId: sessId,
        candidateId: item.candidateId || "N/A",
        candidateName: item.candidateName || "Name not recorded",
        interviewStatus: item.interviewStatus || "in_progress",
        manualReviewRequired:
          String(item.manualReviewRequired || "").toLowerCase() === "yes" ||
          item.manualReviewRequired === true,
        reportReference: item.reportReference || `/api/interview/${sessId}/report`,
        firstTimestamp: item.timestamp || "",
        lastTimestamp: item.timestamp || "",
        responses: [],
      });
    }

    const sessionObj = sessionMap.get(sessId);
    sessionObj.responses.push(item);

    // Keep candidateName updated if earlier item had placeholder
    if (
      (!sessionObj.candidateName || sessionObj.candidateName === "Name not recorded") &&
      item.candidateName &&
      item.candidateName !== "Name not recorded"
    ) {
      sessionObj.candidateName = item.candidateName;
    }

    if (
      String(item.manualReviewRequired || "").toLowerCase() === "yes" ||
      item.manualReviewRequired === true
    ) {
      sessionObj.manualReviewRequired = true;
    }

    if (item.timestamp) {
      if (!sessionObj.firstTimestamp || item.timestamp < sessionObj.firstTimestamp) {
        sessionObj.firstTimestamp = item.timestamp;
      }
      if (!sessionObj.lastTimestamp || item.timestamp > sessionObj.lastTimestamp) {
        sessionObj.lastTimestamp = item.timestamp;
      }
    }
  }

  return [...sessionMap.values()];
}

