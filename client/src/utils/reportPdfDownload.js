import { buildApiUrl } from "./apiUrl.js";

export async function fetchReportPdf(apiUrl, sessionId, fetchImpl = fetch) {
  const url = buildApiUrl(apiUrl, `/api/interview/${encodeURIComponent(sessionId)}/report.pdf`);
  const response = await fetchImpl(url, {
    credentials: "include",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new Error(data?.message || "Could not download the interview PDF.");
    error.status = response.status;
    throw error;
  }
  const contentType = response.headers?.get?.("content-type") || "";
  if (!contentType.toLowerCase().includes("application/pdf")) {
    throw new Error("The server did not return a valid PDF file.");
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("The server returned an empty PDF file.");
  return blob;
}
