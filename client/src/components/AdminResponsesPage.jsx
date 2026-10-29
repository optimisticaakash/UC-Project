import { useEffect, useState, useMemo } from "react";
import { API_URL } from "../config/geminiConfig";
import { loadAdminSession } from "../utils/authSession.js";
import { fetchReportPdf } from "../utils/reportPdfDownload.js";
import {
  GOOGLE_SHEET_URL,
  formatResponseTimestamp,
  filterResponses,
  groupResponsesBySession,
} from "../utils/responsesModel.js";

export default function AdminResponsesPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [responses, setResponses] = useState([]);
  const [source, setSource] = useState("");
  const [sheetUrl, setSheetUrl] = useState(GOOGLE_SHEET_URL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters and search
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [manualReviewFilter, setManualReviewFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");

  // Selected session for candidate-wise details modal
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState("");

  async function checkAdminAuth() {
    try {
      const auth = await loadAdminSession(API_URL);
      if (auth.status !== "authenticated") {
        window.location.replace("/admin/login");
        return false;
      }
      setAuthorized(true);
      return true;
    } catch {
      setError("Could not verify your admin session. Please sign in again.");
      return false;
    } finally {
      setAuthChecked(true);
    }
  }

  async function loadResponses() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/responses`, {
        credentials: "include",
      });

      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Failed to load interview responses.");
      }

      setResponses(data.responses || data.rows || []);
      setSource(data.source || "unknown");
      if (data.sheetUrl) setSheetUrl(data.sheetUrl);
    } catch (loadError) {
      setError(
        loadError.message ||
          "Unable to load responses. Check your backend and Google Sheets connection.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    checkAdminAuth().then((isAuth) => {
      if (active && isAuth) {
        loadResponses();
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Filtered and sorted responses
  const filteredResponses = useMemo(() => {
    return filterResponses(responses, {
      search,
      statusFilter,
      manualReviewFilter,
      sortOrder,
    });
  }, [responses, search, statusFilter, manualReviewFilter, sortOrder]);

  // Grouped sessions map for modal view
  const groupedSessions = useMemo(() => {
    return groupResponsesBySession(responses);
  }, [responses]);

  const activeSelectedSession = useMemo(() => {
    if (!selectedSessionId) return null;
    return groupedSessions.find((s) => s.sessionId === selectedSessionId) || null;
  }, [selectedSessionId, groupedSessions]);

  // Modal keyboard accessibility: Close on Escape
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape" && selectedSessionId) {
        setSelectedSessionId(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedSessionId]);

  async function downloadPdf(sessionId) {
    if (downloadingPdf) return;
    setDownloadingPdf(true);
    setPdfError("");
    try {
      const blob = await fetchReportPdf(API_URL, sessionId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `interview-report-${sessionId}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      setPdfError(err.message || "Could not download the interview PDF.");
    } finally {
      setDownloadingPdf(false);
    }
  }

  function resetFilters() {
    setSearch("");
    setStatusFilter("all");
    setManualReviewFilter("all");
    setSortOrder("newest");
  }

  const hasActiveFilters =
    search.trim() !== "" ||
    statusFilter !== "all" ||
    manualReviewFilter !== "all" ||
    sortOrder !== "newest";

  if (!authChecked) {
    return (
      <main className="min-h-[calc(100vh-112px)] bg-[#f7f7f7] px-4 py-12">
        <div className="mx-auto max-w-5xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-neutral-600">Verifying admin session…</p>
        </div>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="min-h-[calc(100vh-112px)] bg-[#f7f7f7] px-4 py-12">
        <section className="mx-auto max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Admin sign-in required</h1>
          <p className="mt-2 text-sm text-neutral-600">
            {error || "Redirecting to admin sign-in."}
          </p>
          <a
            className="mt-5 inline-flex rounded-lg bg-neutral-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800"
            href="/admin/login"
          >
            Open admin login
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-112px)] bg-[#f7f7f7] px-4 py-8 text-neutral-950 sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Navigation & Header */}
        <div>
          <a
            className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-neutral-600 transition hover:text-neutral-950"
            href="/internal-assessment"
          >
            <span>←</span>
            <span className="underline underline-offset-2">Back to Assessment Dashboard</span>
          </a>

          <header className="flex flex-col gap-5 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:flex-row sm:items-end sm:justify-between sm:p-8">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
                  Urban Company · Admin Responses
                </p>
                {source === "google_sheets" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800 border border-emerald-200">
                    <span className="size-1.5 rounded-full bg-emerald-600"></span>
                    Google Sheets Sync Active
                  </span>
                )}
                {source === "mongodb" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 border border-amber-200">
                    <span className="size-1.5 rounded-full bg-amber-600"></span>
                    MongoDB (Google Sheets Fallback)
                  </span>
                )}
              </div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
                Interview Responses
              </h1>
              <p className="mt-2 text-sm leading-6 text-neutral-600">
                View candidate answers, official questions, verification outcomes, and review flags.
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <button
                onClick={loadResponses}
                disabled={loading}
                className="inline-flex h-11 items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 text-sm font-semibold text-neutral-800 transition hover:bg-neutral-50 disabled:opacity-60"
                type="button"
                title="Refresh responses from backend"
              >
                {loading ? "Refreshing…" : "↻ Refresh"}
              </button>

              <a
                href={sheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#0F9D58] px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-[#0b8043] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0F9D58]/30"
              >
                <svg
                  aria-hidden="true"
                  className="size-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 7h10v2H7zm0 4h10v2H7zm0 4h7v2H7z" />
                </svg>
                <span>Open Google Sheet</span>
                <span className="text-xs opacity-90">↗</span>
              </a>
            </div>
          </header>
        </div>

        {/* Search, Filters, and Summary Controls */}
        <section
          aria-labelledby="responses-filters-heading"
          className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6"
        >
          <h2 className="sr-only" id="responses-filters-heading">
            Search and Filter Responses
          </h2>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {/* Search Input */}
            <div>
              <label
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-neutral-600"
                htmlFor="search-responses"
              >
                Search
              </label>
              <div className="relative">
                <input
                  id="search-responses"
                  type="text"
                  placeholder="Candidate, ID, or session…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3.5 pr-8 text-sm outline-none transition placeholder:text-neutral-400 hover:border-neutral-400 focus:border-neutral-950 focus:ring-4 focus:ring-neutral-900/10"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-neutral-400 hover:text-neutral-700"
                    type="button"
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>

            {/* Status Filter */}
            <div>
              <label
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-neutral-600"
                htmlFor="filter-status"
              >
                Interview Status
              </label>
              <select
                id="filter-status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm outline-none transition hover:border-neutral-400 focus:border-neutral-950 focus:ring-4 focus:ring-neutral-900/10"
              >
                <option value="all">All Statuses</option>
                <option value="completed">Completed</option>
                <option value="in_progress">In Progress</option>
                <option value="paused">Paused</option>
                <option value="manual_review">Manual Review</option>
                <option value="rejected">Rejected</option>
                <option value="incomplete">Incomplete</option>
              </select>
            </div>

            {/* Manual Review Filter */}
            <div>
              <label
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-neutral-600"
                htmlFor="filter-manual-review"
              >
                Manual Review
              </label>
              <select
                id="filter-manual-review"
                value={manualReviewFilter}
                onChange={(e) => setManualReviewFilter(e.target.value)}
                className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm outline-none transition hover:border-neutral-400 focus:border-neutral-950 focus:ring-4 focus:ring-neutral-900/10"
              >
                <option value="all">All Records</option>
                <option value="yes">Manual Review Required (Yes)</option>
                <option value="no">No Manual Review (No)</option>
              </select>
            </div>

            {/* Sort Order */}
            <div>
              <label
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-neutral-600"
                htmlFor="sort-order"
              >
                Sort Timestamp
              </label>
              <select
                id="sort-order"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm outline-none transition hover:border-neutral-400 focus:border-neutral-950 focus:ring-4 focus:ring-neutral-900/10"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
              </select>
            </div>
          </div>

          {/* Counts and reset */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3 text-xs text-neutral-600">
            <div>
              Showing <strong className="text-neutral-950">{filteredResponses.length}</strong> of{" "}
              <strong className="text-neutral-950">{responses.length}</strong> response rows
              {groupedSessions.length > 0 && (
                <span className="ml-1 text-neutral-500">
                  (across {groupedSessions.length} interview sessions)
                </span>
              )}
            </div>
            {hasActiveFilters && (
              <button
                onClick={resetFilters}
                className="font-medium text-neutral-900 underline underline-offset-2 hover:text-black"
                type="button"
              >
                Reset all filters
              </button>
            )}
          </div>
        </section>

        {/* Error message */}
        {error && (
          <div
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            role="alert"
          >
            <p className="font-semibold">Error loading responses</p>
            <p className="mt-1">{error}</p>
            <button
              onClick={loadResponses}
              className="mt-3 inline-flex items-center rounded-lg bg-red-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-900"
              type="button"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Responses Table Container */}
        <section
          aria-labelledby="responses-table-heading"
          className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm"
        >
          <div className="border-b border-neutral-200 px-6 py-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-neutral-950" id="responses-table-heading">
                Logged Question & Response Rows
              </h2>
              <p className="text-xs text-neutral-500">
                Synchronized with Google Sheets (Screening Sheet &amp; Answers tabs) and MongoDB repository.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="p-12 text-center">
              <div className="inline-block size-8 animate-spin rounded-full border-4 border-neutral-300 border-t-neutral-950"></div>
              <p className="mt-3 text-sm text-neutral-600">Loading interview responses…</p>
            </div>
          ) : responses.length === 0 ? (
            <div className="p-12 text-center">
              <p className="font-medium text-neutral-800">No interview responses logged yet</p>
              <p className="mt-1 text-sm text-neutral-500">
                Candidate answers will automatically appear here as interviews progress.
              </p>
            </div>
          ) : filteredResponses.length === 0 ? (
            <div className="p-12 text-center">
              <p className="font-medium text-neutral-800">No responses match the active filters</p>
              <p className="mt-1 text-sm text-neutral-500">
                Try adjusting your search query or reset the filters.
              </p>
              <button
                onClick={resetFilters}
                className="mt-4 inline-flex items-center rounded-lg border border-neutral-300 px-3.5 py-2 text-xs font-semibold text-neutral-800 hover:bg-neutral-50"
                type="button"
              >
                Reset filters
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-neutral-800">
                <thead className="border-b border-neutral-200 bg-neutral-50 text-[11px] font-semibold uppercase tracking-wider text-neutral-600">
                  <tr>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      #
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      Candidate Name
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      Candidate ID
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      Session ID
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      Question ID
                    </th>
                    <th scope="col" className="px-4 py-3.5 min-w-[240px]">
                      Official Question
                    </th>
                    <th scope="col" className="px-4 py-3.5 min-w-[240px]">
                      Candidate Response
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      Interpreted Status
                    </th>
                    <th scope="col" className="px-4 py-3.5 min-w-[140px]">
                      Follow-ups
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      Validation Result
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap text-center">
                      Manual Review
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      Interview Status
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">
                      Timestamp
                    </th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200">
                  {filteredResponses.map((row, index) => {
                    const isManualReview =
                      String(row.manualReviewRequired || "").toLowerCase() === "yes" ||
                      row.manualReviewRequired === true;

                    return (
                      <tr
                        key={`${row.sessionId}-${row.questionId}-${index}`}
                        className="transition hover:bg-neutral-50/75"
                      >
                        <td className="px-4 py-3 text-neutral-400 font-mono">
                          {index + 1}
                        </td>
                        <td className="px-4 py-3 font-semibold text-neutral-950 whitespace-nowrap">
                          {row.candidateName || "Name not recorded"}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-neutral-600 whitespace-nowrap">
                          {row.candidateId || "N/A"}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-neutral-600 whitespace-nowrap">
                          <button
                            onClick={() => setSelectedSessionId(row.sessionId)}
                            className="text-neutral-900 underline decoration-neutral-300 hover:text-black hover:decoration-black"
                            title="Open candidate-wise session Q&A"
                            type="button"
                          >
                            {row.sessionId ? row.sessionId.slice(0, 12) + "…" : "N/A"}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-mono font-medium text-neutral-900 whitespace-nowrap">
                          {row.questionId || "—"}
                        </td>
                        <td className="px-4 py-3 text-neutral-700">
                          <div className="max-w-xs break-words" title={row.officialQuestion}>
                            {row.officialQuestion || "—"}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-medium text-neutral-950">
                          <div className="max-w-xs break-words bg-neutral-100/70 p-2 rounded-lg" title={row.candidateResponse}>
                            {row.candidateResponse || "—"}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                            {row.interpretedStatus || "recorded"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-neutral-600">
                          <div className="max-w-[180px] truncate" title={row.followUps}>
                            {row.followUps || "None"}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-neutral-700">
                          {row.validationResult || "accepted"}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-center">
                          {isManualReview ? (
                            <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-[11px] font-semibold text-red-800">
                              Yes
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-0.5 text-[11px] font-medium text-neutral-600">
                              No
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                              row.interviewStatus === "completed"
                                ? "bg-emerald-100 text-emerald-800"
                                : row.interviewStatus === "in_progress"
                                  ? "bg-blue-100 text-blue-800"
                                  : row.interviewStatus === "paused"
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-neutral-100 text-neutral-700"
                            }`}
                          >
                            {row.interviewStatus || "in_progress"}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-neutral-500 font-mono text-[11px]">
                          {formatResponseTimestamp(row.timestamp)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-right space-x-1.5">
                          <button
                            onClick={() => setSelectedSessionId(row.sessionId)}
                            className="inline-flex h-8 items-center rounded-lg border border-neutral-300 bg-white px-2.5 text-[11px] font-semibold text-neutral-800 hover:bg-neutral-50"
                            type="button"
                          >
                            Q&A Details
                          </button>
                          <a
                            href={`/internal-assessment/${encodeURIComponent(row.sessionId)}`}
                            className="inline-flex h-8 items-center rounded-lg bg-neutral-950 px-2.5 text-[11px] font-semibold text-white hover:bg-neutral-800"
                          >
                            Report
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Candidate-wise Details Modal */}
        {activeSelectedSession && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-modal-title"
          >
            <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl overflow-hidden">
              {/* Modal Header */}
              <div className="flex items-start justify-between border-b border-neutral-200 p-6">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                      Candidate Q&A History
                    </span>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        activeSelectedSession.interviewStatus === "completed"
                          ? "bg-emerald-100 text-emerald-800"
                          : activeSelectedSession.interviewStatus === "in_progress"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-neutral-100 text-neutral-700"
                      }`}
                    >
                      {activeSelectedSession.interviewStatus}
                    </span>
                    {activeSelectedSession.manualReviewRequired && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                        Manual review required
                      </span>
                    )}
                  </div>
                  <h3 className="mt-1 text-2xl font-bold tracking-tight text-neutral-950" id="session-modal-title">
                    {activeSelectedSession.candidateName}
                  </h3>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500 font-mono">
                    <span>Candidate ID: {activeSelectedSession.candidateId}</span>
                    <span>Session ID: {activeSelectedSession.sessionId}</span>
                    <span>{activeSelectedSession.responses.length} total answers logged</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <a
                    href={`/internal-assessment/${encodeURIComponent(activeSelectedSession.sessionId)}`}
                    className="inline-flex h-9 items-center justify-center rounded-lg bg-neutral-950 px-3.5 text-xs font-semibold text-white transition hover:bg-neutral-800"
                  >
                    Open Full Report
                  </a>
                  <button
                    onClick={() => downloadPdf(activeSelectedSession.sessionId)}
                    disabled={downloadingPdf}
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-xs font-semibold text-neutral-800 transition hover:bg-neutral-50 disabled:opacity-50"
                    type="button"
                  >
                    {downloadingPdf ? "Downloading…" : "Download PDF"}
                  </button>
                  <button
                    onClick={() => setSelectedSessionId(null)}
                    className="grid size-9 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
                    type="button"
                    aria-label="Close modal"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {pdfError && (
                <div className="bg-red-50 px-6 py-2 text-xs text-red-800 border-b border-red-200">
                  {pdfError}
                </div>
              )}

              {/* Modal Body: Sequential Questions and Responses */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                  Interview Dialogue In Sequence
                </p>

                {activeSelectedSession.responses.map((resp, idx) => (
                  <div
                    key={`${resp.questionId}-${idx}`}
                    className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-4 space-y-3"
                  >
                    {/* Question Header */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="grid size-6 place-items-center rounded-full bg-neutral-950 text-xs font-bold text-white">
                          {idx + 1}
                        </span>
                        <span className="font-mono text-xs font-bold text-neutral-900">
                          {resp.questionId || `Question #${idx + 1}`}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-neutral-500">
                        {formatResponseTimestamp(resp.timestamp)}
                      </span>
                    </div>

                    {/* Official Question */}
                    <div className="rounded-lg border border-neutral-200 bg-white p-3 text-sm text-neutral-800">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-1">
                        Official Question
                      </p>
                      <p className="font-medium text-neutral-900">
                        {resp.officialQuestion || "Question text not recorded"}
                      </p>
                    </div>

                    {/* Candidate Response */}
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-sm text-emerald-950">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-800 mb-1">
                        Candidate Answer
                      </p>
                      <p className="font-medium">
                        {resp.candidateResponse || "No answer recorded"}
                      </p>
                    </div>

                    {/* Metadata chips */}
                    <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-neutral-600">
                      <span className="rounded bg-neutral-200/80 px-2 py-0.5">
                        Status: <strong>{resp.interpretedStatus || "recorded"}</strong>
                      </span>
                      <span className="rounded bg-neutral-200/80 px-2 py-0.5">
                        Validation: <strong>{resp.validationResult || "accepted"}</strong>
                      </span>
                      {resp.followUps && resp.followUps !== "None" && (
                        <span className="rounded bg-blue-100 text-blue-800 px-2 py-0.5">
                          {resp.followUps}
                        </span>
                      )}
                      {(String(resp.manualReviewRequired || "").toLowerCase() === "yes" ||
                        resp.manualReviewRequired === true) && (
                        <span className="rounded bg-red-100 text-red-800 font-semibold px-2 py-0.5">
                          Manual Review
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Modal Footer */}
              <div className="flex justify-end border-t border-neutral-200 bg-neutral-50 px-6 py-4">
                <button
                  onClick={() => setSelectedSessionId(null)}
                  className="rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-100"
                  type="button"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

