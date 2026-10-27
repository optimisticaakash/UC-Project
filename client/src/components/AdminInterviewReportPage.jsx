import { useEffect, useState } from "react";
import InterviewReport from "./InterviewReport";
import { API_URL } from "../config/geminiConfig";
import { loadAdminSession } from "../utils/authSession.js";
import { reportBelongsToSession } from "../utils/internalAssessment";
import { fetchReportPdf } from "../utils/reportPdfDownload.js";

export default function AdminInterviewReportPage({ sessionId }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadReport() {
    setLoading(true);
    setError("");
    try {
      const auth = await loadAdminSession(API_URL);
      if (auth.status !== "authenticated") {
        window.location.replace("/admin/login");
        return;
      }
      const response = await fetch(`${API_URL}/api/interview/${encodeURIComponent(sessionId)}/report`, { credentials: "include" });
      const data = await response.json();
      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok || !data.success || !reportBelongsToSession(data.report, sessionId)) {
        throw new Error(data.message || "This interview report is unavailable.");
      }
      setReport(data.report);
    } catch (loadError) {
      setError(loadError.message || "This interview report is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadReport(); }, [sessionId]);

  async function downloadPdf() {
    try {
      const blob = await fetchReportPdf(API_URL, sessionId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `interview-report-${sessionId}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      if (downloadError.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      setError(downloadError.message || "Could not download the interview PDF.");
    }
  }

  return (
    <main className="mx-auto min-h-[calc(100vh-112px)] max-w-5xl px-4 py-8 sm:px-8 print:max-w-none print:px-0">
      <a className="mb-5 inline-block text-sm font-semibold underline print:hidden" href="/internal-assessment">← Back to Assessment Dashboard</a>
      <header className="mb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Admin report</p>
        <h1 className="mt-2 text-3xl font-semibold">Interview Report</h1>
      </header>
      <InterviewReport report={report} loading={loading} error={error} onRetry={loadReport} onDownload={downloadPdf} />
    </main>
  );
}
