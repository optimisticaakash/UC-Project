import { useEffect, useState } from "react";
import { API_URL } from "../config/geminiConfig";
import {
  normalizeCandidateLoginIdentifier,
  validateCandidateProvision,
} from "../utils/candidateProvisionValidation.js";
import { fetchReportPdf } from "../utils/reportPdfDownload.js";
import {
  getAdminDeletionConfirmation,
  getCandidateDeletionConfirmation,
  getCandidateDeactivationConfirmation,
  getCandidateStatusAction,
  getReportDeletionConfirmation,
} from "../utils/accountDeletion.js";

export default function InternalAssessmentDashboard() {
  const [sessions, setSessions] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [currentAdminId, setCurrentAdminId] = useState("");
  const [accountActionMessage, setAccountActionMessage] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const [loginIdentifier, setLoginIdentifier] = useState("");
  const [initialPassword, setInitialPassword] = useState("");
  const [showInitialPassword, setShowInitialPassword] = useState(false);
  const [creatingCandidate, setCreatingCandidate] = useState(false);
  const [candidateNotice, setCandidateNotice] = useState("");
  const [candidateSuccess, setCandidateSuccess] = useState(null);
  const [candidateFormError, setCandidateFormError] = useState("");
  const [candidateValidationError, setCandidateValidationError] = useState(null);
  const [createdCredentials, setCreatedCredentials] = useState(null);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [candidateHistory, setCandidateHistory] = useState([]);
  const [loadingCandidateHistory, setLoadingCandidateHistory] = useState(false);
  const [stats, setStats] = useState(null);
  const [storageMode, setStorageMode] = useState("unknown");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [deletingSessionId, setDeletingSessionId] = useState(null);
  const [error, setError] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  async function loadSessions() {
    setLoadingSessions(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/interview/sessions`, { credentials: "include" });
      const data = await response.json();
      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok || !data.success) throw new Error("Unable to load sessions");
      setSessions(data.sessions || []);
      setStorageMode(data.storageMode || "unknown");
    } catch {
      setError("Session list unavailable. Check your admin sign-in and confirm the backend is running.");
    } finally {
      setLoadingSessions(false);
    }
  }

  async function loadCandidates() {
    try {
      const response = await fetch(`${API_URL}/api/admin/candidates`, { credentials: "include" });
      const data = await response.json();
      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok || !data.success) throw new Error("Unable to load candidates");
      setCandidates(data.candidates || []);
    } catch {
      setError("Candidate accounts are unavailable. Check Admin access and MongoDB connectivity.");
    }
  }

  async function loadAdmins() {
    try {
      const response = await fetch(`${API_URL}/api/admin/admins`, { credentials: "include" });
      const data = await response.json();
      if (response.status === 401) { window.location.replace("/admin/login"); return; }
      if (!response.ok || !data.success) throw new Error("Unable to load admin accounts");
      setAdmins(data.admins || []);
    } catch {
      setError("Admin accounts are unavailable. Check your admin sign-in and MongoDB connectivity.");
    }
  }

  async function changeCandidateStatus(candidate) {
    const action = getCandidateStatusAction(candidate);
    if (action === "removed") return;
    if (action === "deactivate") {
      const confirmation = getCandidateDeactivationConfirmation(candidate);
      if (!confirmation || !window.confirm(confirmation)) return;
    }
    setError("");
    setAccountActionMessage("");
    try {
      const response = await fetch(`${API_URL}/api/admin/candidates/${encodeURIComponent(candidate.candidateId)}/${action}`, {
        method: "PATCH", credentials: "include",
      });
      const data = await response.json();
      if (response.status === 401) { window.location.replace("/admin/login"); return; }
      if (!response.ok || !data.success) throw new Error(data.message || `Candidate account could not be ${action}d.`);
      setCandidates((current) => current.map((item) => item.candidateId === candidate.candidateId ? { ...item, ...data.candidate } : item));
      setAccountActionMessage(data.message);
      await Promise.all([loadCandidates(), loadStats()]);
    } catch (actionError) {
      setError(actionError.message || `Candidate account could not be ${action}d.`);
    }
  }

  async function deleteCandidateAccount(candidate) {
    const confirmation = getCandidateDeletionConfirmation(candidate);
    if (!confirmation || !window.confirm(confirmation)) return;
    setError("");
    setAccountActionMessage("");
    try {
      const response = await fetch(`${API_URL}/api/admin/candidates/${encodeURIComponent(candidate.candidateId)}`, {
        method: "DELETE", credentials: "include",
      });
      const data = await response.json();
      if (response.status === 401) { window.location.replace("/admin/login"); return; }
      if (!response.ok || !data.success) throw new Error(data.message || "Candidate account could not be removed.");
      setCandidates((current) => current.map((item) => item.candidateId === candidate.candidateId ? { ...item, ...data.candidate } : item));
      setAccountActionMessage(data.message);
      await Promise.all([loadCandidates(), loadStats()]);
    } catch (actionError) {
      setError(actionError.message || "Candidate account could not be removed.");
    }
  }

  async function deleteAdmin(admin) {
    const confirmation = getAdminDeletionConfirmation(admin, currentAdminId);
    if (!confirmation || !window.confirm(confirmation)) return;
    setError("");
    setAccountActionMessage("");
    try {
      const response = await fetch(`${API_URL}/api/admin/admins/${encodeURIComponent(admin.adminId)}`, {
        method: "DELETE", credentials: "include",
      });
      const data = await response.json();
      if (response.status === 401) { window.location.replace("/admin/login"); return; }
      if (!response.ok || !data.success) throw new Error(data.message || "Admin account could not be deleted.");
      setAccountActionMessage(data.message);
      await loadAdmins();
    } catch (actionError) {
      setError(actionError.message || "Admin account could not be deleted.");
    }
  }

  async function loadStats() {
    try {
      const response = await fetch(`${API_URL}/api/admin/stats`, { credentials: "include" });
      const data = await response.json();
      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok || !data.success) throw new Error("Unable to load dashboard statistics");
      setStats(data.stats);
    } catch {
      setError("Dashboard statistics are unavailable. Check admin access and MongoDB connectivity.");
    }
  }

  async function loadCandidateHistory(candidate) {
    setSelectedCandidate(candidate);
    setCandidateHistory([]);
    setLoadingCandidateHistory(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/candidates/${encodeURIComponent(candidate.candidateId)}/interviews`, { credentials: "include" });
      const data = await response.json();
      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok || !data.success) throw new Error(data.message || "Could not load candidate interview history.");
      setCandidateHistory(data.interviews || []);
    } catch (historyError) {
      setError(historyError.message || "Could not load candidate interview history.");
    } finally {
      setLoadingCandidateHistory(false);
    }
  }

  async function provisionCandidate(event) {
    event.preventDefault();
    if (creatingCandidate) return;
    const validationError = validateCandidateProvision({ name: candidateName, loginIdentifier, password: initialPassword });
    setCandidateValidationError(validationError);
    if (validationError) {
      setCandidateFormError("");
      return;
    }
    setCreatingCandidate(true);
    setCandidateFormError("");
    setCandidateNotice("");
    setCandidateSuccess(null);
    setCreatedCredentials(null);
    try {
      const issuedPassword = initialPassword;
      const response = await fetch(`${API_URL}/api/admin/candidates`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: candidateName.trim(),
          loginIdentifier: normalizeCandidateLoginIdentifier(loginIdentifier),
          password: initialPassword,
        }),
      });
      const data = await response.json();
      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok || !data.success) {
        if (data.field) {
          setCandidateValidationError({ field: data.field, message: data.message || "Please correct this field." });
          return;
        }
        throw new Error(data.message || "Could not create candidate account.");
      }
      setCandidateValidationError(null);
      setCandidateName("");
      setLoginIdentifier("");
      setInitialPassword("");
      setCreatedCredentials({ loginIdentifier: data.candidate.loginIdentifier, password: issuedPassword });
      setCandidateSuccess({ name: data.candidate.name, email: data.candidate.loginIdentifier, candidateId: data.candidate.candidateId });
      setCandidateNotice("The initial password is shown once below. Share it through your approved secure channel.");
      await Promise.all([loadCandidates(), loadStats()]);
    } catch (creationError) {
      setCandidateFormError(creationError.message || "Could not create candidate account.");
    } finally {
      setCreatingCandidate(false);
    }
  }

  async function copyCandidateCredentials() {
    if (!createdCredentials) return;
    const shareText = `Urban Company Candidate Sign In\n${window.location.origin}/candidate/login\nLogin identifier: ${createdCredentials.loginIdentifier}\nInitial password: ${createdCredentials.password}`;
    try {
      await navigator.clipboard.writeText(shareText);
      setCandidateNotice("Candidate sign-in link and credentials copied. Share them through your approved secure channel.");
    } catch {
      setError("Clipboard access is unavailable. Select and copy the credentials shown below.");
    }
  }

  function viewReport(sessionId) {
    window.location.assign(`/internal-assessment/${encodeURIComponent(sessionId)}`);
  }

  async function downloadReportPdf(sessionId) {
    setError("");
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

  async function deleteReport(session) {
    if (deletingSessionId) return;
    const confirmation = getReportDeletionConfirmation(session);
    if (!confirmation || !window.confirm(confirmation)) return;
    setError("");
    setAccountActionMessage("");
    setDeletingSessionId(session.sessionId);
    try {
      const response = await fetch(`${API_URL}/api/interview/${encodeURIComponent(session.sessionId)}/report`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await response.json();
      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Interview report could not be deleted.");
      }
      setAccountActionMessage(data.message || "Interview report deleted successfully.");
      await Promise.all([loadSessions(), loadStats()]);
      if (selectedCandidate) {
        await loadCandidateHistory(selectedCandidate);
      }
    } catch (deleteError) {
      setError(deleteError.message || "Interview report could not be deleted.");
    } finally {
      setDeletingSessionId(null);
    }
  }

  useEffect(() => {
    let active = true;
    fetch(`${API_URL}/api/admin/me`, { credentials: "include" })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.replace("/admin/login");
          return false;
        }
        if (!response.ok) throw new Error("Admin session check failed");
        return response.json();
      })
      .then((data) => {
        if (!active || !data) return;
        setCurrentAdminId(data.user?.adminId || "");
        setAuthorized(true);
        loadSessions();
        loadCandidates();
        loadAdmins();
        loadStats();
      })
      .catch(() => {
        if (active) setError("Could not verify the admin session. Please sign in again.");
      })
      .finally(() => {
        if (active) setAuthChecked(true);
      });
    return () => { active = false; };
  }, []);

  if (!authChecked) return <main className="min-h-[calc(100vh-112px)] bg-[#f7f7f7] px-4 py-12"><div className="mx-auto max-w-5xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm"><p className="text-sm text-neutral-600">Verifying admin session…</p></div></main>;
  if (!authorized) return <main className="min-h-[calc(100vh-112px)] bg-[#f7f7f7] px-4 py-12"><section className="mx-auto max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm"><h1 className="text-2xl font-semibold tracking-tight">Admin sign-in required</h1><p className="mt-2 text-sm text-neutral-600">{error || "Redirecting to admin sign-in."}</p><a className="mt-5 inline-flex rounded-lg bg-neutral-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/20" href="/admin/login">Open admin login</a></section></main>;

  return (
    <main className="min-h-[calc(100vh-112px)] bg-[#f7f7f7] px-4 py-8 text-neutral-950 sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-5 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:flex-row sm:items-end sm:justify-between sm:p-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Urban Company · Internal only</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Assessment Dashboard</h1>
            <p className="mt-2 text-sm leading-6 text-neutral-600">Manage candidate accounts and review interview progress.</p>
            <p className="mt-3 text-xs text-neutral-500" role="status">
              {storageMode === "mongodb"
                ? "Reports are stored in MongoDB and remain available after a backend restart."
                : "Report storage status could not be confirmed."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <a className="inline-flex h-11 items-center justify-center rounded-lg bg-neutral-950 px-4 text-sm font-semibold text-white transition hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/20" href="/admin/responses">View Responses Log</a>
            <a className="inline-flex h-11 items-center justify-center rounded-lg border border-neutral-300 px-4 text-sm font-semibold text-neutral-800 transition hover:border-neutral-500 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10" href="/">Candidate interview portal</a>
          </div>
        </header>
        {accountActionMessage && <p className="rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-800 shadow-sm" role="status">{accountActionMessage}</p>}

        <section aria-labelledby="dashboard-admins-heading" className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
          <div>
            <h2 className="text-lg font-semibold tracking-tight" id="dashboard-admins-heading">Admin Accounts</h2>
            <p className="mt-1 text-sm text-neutral-500">Only another admin can delete an account. The last active admin is protected.</p>
          </div>
          {admins.length === 0 ? <p className="mt-4 text-sm text-neutral-500">No admin accounts are available.</p> : <ul className="mt-4 divide-y divide-neutral-200 rounded-xl border border-neutral-200">
            {admins.map((admin) => <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" key={admin.adminId}>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-neutral-950">{admin.name}{admin.adminId === currentAdminId ? " · You" : ""}</p>
                <p className="mt-1 break-all text-sm text-neutral-600">{admin.loginIdentifier}</p>
                <p className="mt-1 text-xs text-neutral-500">{admin.active ? "Active" : "Inactive"}{admin.createdAt ? ` · Created ${new Date(admin.createdAt).toLocaleString()}` : ""}</p>
              </div>
              <button className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-sm font-semibold text-neutral-800 transition hover:border-red-400 hover:text-red-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10 disabled:cursor-not-allowed disabled:opacity-50" disabled={!admin.active || admin.adminId === currentAdminId} onClick={() => deleteAdmin(admin)} type="button">Delete Admin</button>
            </li>)}
          </ul>}
        </section>

        <section aria-labelledby="dashboard-overview-heading" className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight" id="dashboard-overview-heading">Overview</h2>
              <p className="mt-1 text-sm text-neutral-500">Current candidate and interview totals</p>
            </div>
          </div>
          {stats ? <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[
              ["Candidates", stats.totalCandidates],
              ["Interviews", stats.totalInterviews],
              ["Completed", stats.completedInterviews],
              ["In Progress", stats.pendingInterviews],
              ["Incomplete", stats.incompleteInterviews],
              ["Manual Review", stats.manualReviewInterviews],
            ].map(([label, value]) => <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4" key={label}>
              <dt className="text-xs font-medium text-neutral-500">{label}</dt>
              <dd className="mt-2 text-2xl font-semibold tracking-tight">{value}</dd>
            </div>)}
          </dl> : <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-sm text-neutral-500">Overview statistics are loading…</p>}
        </section>

        <section aria-labelledby="dashboard-reports-heading" className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight" id="dashboard-reports-heading">Interview Reports</h2>
              <p className="mt-1 text-sm text-neutral-500">Recent candidate interviews and their current status</p>
            </div>
            <a className="inline-flex h-9 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-xs font-semibold text-neutral-800 transition hover:bg-neutral-50" href="/admin/responses">
              Responses Table →
            </a>
          </div>
          {loadingSessions ? <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500">Loading interview reports…</p> : sessions.length === 0 ? <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-10 text-center">
            <p className="font-medium text-neutral-800">No interview reports yet</p>
            <p className="mt-1 text-sm text-neutral-500">Candidate interviews will appear here when they begin.</p>
          </div> : <ul className="divide-y divide-neutral-200">
            {sessions.map((session) => <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between" key={session.sessionId}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="truncate text-sm font-semibold">{session.candidateName}</strong>
                  <span className="rounded-full border border-neutral-300 bg-neutral-50 px-2.5 py-1 text-xs font-medium text-neutral-700">{session.status}</span>
                  {session.manualReviewRequired && <span className="rounded-full bg-neutral-950 px-2.5 py-1 text-xs font-semibold text-white">Manual review</span>}
                </div>
                <p className="mt-1 text-xs text-neutral-500">Started {new Date(session.startedAt).toLocaleString()} · {session.answeredQuestions} answers</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button className="inline-flex h-10 items-center justify-center rounded-lg bg-neutral-950 px-4 text-sm font-semibold text-white transition hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/20" type="button" onClick={() => viewReport(session.sessionId)}>View Report</button>
                <button className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/20" type="button" onClick={() => downloadReportPdf(session.sessionId)}>Download PDF</button>
                <button className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-sm font-semibold text-neutral-800 transition hover:border-red-400 hover:text-red-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10 disabled:cursor-not-allowed disabled:opacity-50" disabled={deletingSessionId === session.sessionId} onClick={() => deleteReport(session)} type="button">{deletingSessionId === session.sessionId ? "Deleting…" : "Delete"}</button>
              </div>
            </li>)}
          </ul>}
        </section>

        <section aria-labelledby="dashboard-create-candidate-heading" className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5">
            <h2 className="text-lg font-semibold tracking-tight" id="dashboard-create-candidate-heading">Create Candidate Account</h2>
            <p className="mt-1 text-sm text-neutral-500">Provide the candidate’s sign-in details to begin an interview.</p>
          </div>
          <form className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" noValidate onSubmit={provisionCandidate}>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-neutral-800" htmlFor="candidate-name">Candidate name</label>
              <input aria-describedby={candidateValidationError?.field === "name" ? "candidate-name-validation-error" : undefined} aria-invalid={candidateValidationError?.field === "name" || undefined} className={`h-12 w-full rounded-lg border bg-white px-3.5 text-base outline-none transition placeholder:text-neutral-400 hover:border-neutral-400 focus:border-neutral-950 focus:ring-4 focus:ring-neutral-900/10 disabled:bg-neutral-100 ${candidateValidationError?.field === "name" ? "border-red-600 focus:border-red-700 focus:ring-red-700/10" : "border-neutral-300"}`} id="candidate-name" autoComplete="name" maxLength={160} onChange={(event) => { setCandidateName(event.target.value); if (candidateValidationError?.field === "name") setCandidateValidationError(null); }} required value={candidateName} />
              {candidateValidationError?.field === "name" && <p className="text-sm text-red-700" id="candidate-name-validation-error" role="alert">{candidateValidationError.message}</p>}
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-neutral-800" htmlFor="candidate-login-identifier">Email address</label>
              <input aria-describedby={candidateValidationError?.field === "email" ? "candidate-provision-validation-error" : "candidate-email-help"} aria-invalid={candidateValidationError?.field === "email" || undefined} className={`h-12 w-full rounded-lg border bg-white px-3.5 text-base outline-none transition placeholder:text-neutral-400 hover:border-neutral-400 focus:border-neutral-950 focus:ring-4 focus:ring-neutral-900/10 disabled:bg-neutral-100 ${candidateValidationError?.field === "email" ? "border-red-600 focus:border-red-700 focus:ring-red-700/10" : "border-neutral-300"}`} id="candidate-login-identifier" autoComplete="email" maxLength={160} onChange={(event) => { setLoginIdentifier(event.target.value); if (candidateValidationError?.field === "email") setCandidateValidationError(null); }} required value={loginIdentifier} />
              <p className="text-xs text-neutral-500" id="candidate-email-help">Existing accounts with a previous username can continue using that login.</p>
              {candidateValidationError?.field === "email" && <p className="text-sm text-red-700" id="candidate-provision-validation-error" role="alert">{candidateValidationError.message}</p>}
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-neutral-800" htmlFor="candidate-initial-password">Initial password <span className="font-normal text-neutral-500">(minimum 8 characters)</span></label>
              <div className="relative">
                <input aria-describedby={candidateValidationError?.field === "password" ? "candidate-password-validation-error" : undefined} aria-invalid={candidateValidationError?.field === "password" || undefined} className={`h-12 w-full rounded-lg border bg-white px-3.5 pr-12 text-base outline-none transition placeholder:text-neutral-400 hover:border-neutral-400 focus:border-neutral-950 focus:ring-4 focus:ring-neutral-900/10 disabled:bg-neutral-100 ${candidateValidationError?.field === "password" ? "border-red-600 focus:border-red-700 focus:ring-red-700/10" : "border-neutral-300"}`} id="candidate-initial-password" autoComplete="new-password" maxLength={1024} minLength={8} onChange={(event) => { setInitialPassword(event.target.value); if (candidateValidationError?.field === "password") setCandidateValidationError(null); }} required type={showInitialPassword ? "text" : "password"} value={initialPassword} />
                <button aria-label={showInitialPassword ? "Hide password" : "Show password"} aria-pressed={showInitialPassword} aria-controls="candidate-initial-password" className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-neutral-500 transition hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-900" onClick={() => setShowInitialPassword((visible) => !visible)} type="button">
                  {showInitialPassword ? (
                    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
                      <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.8 10.8 0 0 1 12 5c5 0 8.5 5.1 9 6-.2.4-1.2 2.2-3.1 3.7M6.2 6.2C4.2 7.6 2.8 9.7 3 11c.5.9 4 8 9 8 1 0 2-.3 2.9-.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                    </svg>
                  ) : (
                    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
                      <path d="M3 12s3.3-7 9-7 9 7 9 7-3.3 7-9 7-9-7-9-7Z" stroke="currentColor" strokeWidth="1.7" />
                      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                    </svg>
                  )}
                </button>
              </div>
              {candidateValidationError?.field === "password" && <p className="text-sm text-red-700" id="candidate-password-validation-error" role="alert">{candidateValidationError.message}</p>}
            </div>
            <div className="md:col-span-2 xl:col-span-3">
              <button className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-neutral-950 px-5 text-sm font-semibold text-white transition hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/20 disabled:cursor-wait disabled:bg-neutral-500 sm:w-auto" disabled={creatingCandidate} type="submit">{creatingCandidate ? "Creating account…" : "Create Candidate Account"}</button>
            </div>
          </form>
          {candidateFormError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{candidateFormError}</p>}
          {candidateSuccess && <div className="mt-4 rounded-xl border border-neutral-300 bg-neutral-50 p-4 text-sm" role="status">
            <p className="font-semibold text-neutral-950">Candidate account created successfully.</p>
            <p className="mt-2 text-neutral-700">Name: <strong className="text-neutral-950">{candidateSuccess.name}</strong></p>
            <p className="mt-1 break-all text-neutral-700">Registered email: <strong className="text-neutral-950">{candidateSuccess.email}</strong></p>
            <p className="mt-1 break-all font-mono text-xs text-neutral-600">Candidate ID: {candidateSuccess.candidateId}</p>
          </div>}
          {candidateNotice && <p className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-800" role="status">{candidateNotice}</p>}
          {createdCredentials && <div className="mt-4 rounded-xl border border-neutral-300 bg-neutral-50 p-4 text-sm" role="status">
            <p className="font-semibold">Initial credentials — this password is shown only here.</p>
            <p className="mt-2 text-neutral-700">Login identifier: <strong className="text-neutral-950">{createdCredentials.loginIdentifier}</strong></p>
            <p className="mt-1 text-neutral-700">Password: <code className="select-all rounded bg-white px-1.5 py-0.5 text-neutral-950">{createdCredentials.password}</code></p>
            <p className="mt-2 text-neutral-700">Candidate Sign In: <a className="font-medium text-neutral-950 underline underline-offset-2" href="/candidate/login">{window.location.origin}/candidate/login</a></p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-sm font-semibold transition hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10" onClick={copyCandidateCredentials} type="button">Copy link and credentials</button>
              <button className="inline-flex h-10 items-center justify-center rounded-lg px-3.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10" onClick={() => setCreatedCredentials(null)} type="button">Hide password</button>
            </div>
          </div>}
        </section>

        <section aria-labelledby="dashboard-candidates-heading" className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight" id="dashboard-candidates-heading">Candidate List</h2>
              <p className="mt-1 text-sm text-neutral-500">{candidates.length} candidate accounts · Search accounts and open each candidate’s interview history.</p>
            </div>
            <div className="w-full sm:max-w-sm">
              <label className="mb-1.5 block text-sm font-medium text-neutral-800" htmlFor="candidate-search">Search candidates</label>
              <input className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3.5 text-sm outline-none transition placeholder:text-neutral-400 hover:border-neutral-400 focus:border-neutral-950 focus:ring-4 focus:ring-neutral-900/10" id="candidate-search" onChange={(event) => setCandidateSearch(event.target.value)} placeholder="Name or login identifier" value={candidateSearch} />
            </div>
          </div>
          {candidates.length === 0 ? <div className="mt-5 rounded-xl border border-dashed border-neutral-300 px-4 py-10 text-center">
            <p className="font-medium text-neutral-800">No candidate accounts found</p>
            <p className="mt-1 text-sm text-neutral-500">Create a candidate account above to get started.</p>
          </div> : candidates.filter((candidate) => `${candidate.name} ${candidate.loginIdentifier}`.toLowerCase().includes(candidateSearch.trim().toLowerCase())).length === 0 ? <p className="mt-5 rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500">No candidates match that search.</p> : <ul className="mt-5 divide-y divide-neutral-200 rounded-xl border border-neutral-200">
            {candidates.filter((candidate) => `${candidate.name} ${candidate.loginIdentifier}`.toLowerCase().includes(candidateSearch.trim().toLowerCase())).map((candidate) => <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" key={candidate.candidateId}>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-neutral-950">{candidate.name}</p>
                <p className="mt-1 break-all text-sm text-neutral-600">{candidate.loginIdentifier}</p>
                <p className="mt-1 break-all font-mono text-xs text-neutral-500">Candidate ID: {candidate.candidateId || "Not assigned"}</p>
                <p className="mt-1 text-xs text-neutral-500">Created {candidate.createdAt ? new Date(candidate.createdAt).toLocaleString() : "date unavailable"} · {sessions.filter((item) => item.candidateId === candidate.candidateId).length} interviews</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700">{candidate.deletedAt ? "Deleted · history retained" : candidate.active ? "Active" : "Inactive"}</span>
                <button className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-sm font-semibold text-neutral-800 transition hover:border-neutral-500 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10" onClick={() => loadCandidateHistory(candidate)} type="button">Interview history</button>
                <button aria-label={getCandidateStatusAction(candidate) === "removed" ? "Account removed" : candidate.active ? "Deactivate account" : "Activate account"} className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-sm font-semibold text-neutral-800 transition hover:border-neutral-500 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10 disabled:cursor-not-allowed disabled:opacity-50" disabled={getCandidateStatusAction(candidate) === "removed"} onClick={() => changeCandidateStatus(candidate)} type="button">{getCandidateStatusAction(candidate) === "removed" ? "Account removed" : candidate.active ? "Deactivate account" : "Activate account"}</button>
                <button className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-sm font-semibold text-neutral-800 transition hover:border-red-400 hover:text-red-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10 disabled:cursor-not-allowed disabled:opacity-50" disabled={Boolean(candidate.deletedAt)} onClick={() => deleteCandidateAccount(candidate)} type="button">{candidate.deletedAt ? "Account removed" : "Delete account"}</button>
              </div>
            </li>)}
          </ul>}
          {selectedCandidate && <section aria-label={`${selectedCandidate.name} interview history`} className="mt-5 rounded-xl border border-neutral-200 bg-neutral-50 p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold tracking-tight">Interview history: {selectedCandidate.name}</h3>
              <span className="text-xs text-neutral-500">{selectedCandidate.loginIdentifier}</span>
            </div>
            <p className="mt-1 break-all font-mono text-xs text-neutral-500">Candidate ID: {selectedCandidate.candidateId}</p>
            {loadingCandidateHistory ? <p className="mt-4 text-sm text-neutral-500">Loading history…</p> : candidateHistory.length === 0 ? <p className="mt-4 rounded-lg border border-dashed border-neutral-300 bg-white px-4 py-6 text-center text-sm text-neutral-500">No interviews found for this candidate.</p> : <ul className="mt-4 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
              {candidateHistory.map((item) => <li className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between" key={item.sessionId}>
                <div className="min-w-0 text-sm text-neutral-700">
                  <p className="break-all font-mono text-xs text-neutral-500">Interview ID: {item.sessionId}</p>
                  <p className="mt-1">{item.status} · started {new Date(item.startedAt).toLocaleString()} · {item.answeredQuestions} answers{item.manualReviewRequired ? " · Manual review" : ""}</p>
                </div>
                <div className="flex gap-2">
                  <button className="inline-flex h-9 items-center justify-center rounded-lg bg-neutral-950 px-3.5 text-sm font-semibold text-white transition hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/20" onClick={() => viewReport(item.sessionId)} type="button">Open report</button>
                  <button className="inline-flex h-9 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-100" onClick={() => downloadReportPdf(item.sessionId)} type="button">Download PDF</button>
                  <button className="inline-flex h-9 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-sm font-semibold text-neutral-800 transition hover:border-red-400 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50" disabled={deletingSessionId === item.sessionId} onClick={() => deleteReport({ ...item, candidateName: selectedCandidate.name })} type="button">{deletingSessionId === item.sessionId ? "Deleting…" : "Delete"}</button>
                </div>
              </li>)}
            </ul>}
          </section>}
        </section>

        {error && <p className="rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-800 shadow-sm" role="alert">{error}</p>}
      </div>
    </main>
  );
}
