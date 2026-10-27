export async function fetchReportPdf(apiUrl, sessionId, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiUrl}/api/interview/${encodeURIComponent(sessionId)}/report.pdf`, {
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
