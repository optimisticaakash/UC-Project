import { useEffect, useRef, useState } from "react";
import InterviewReport from "./InterviewReport";
import { API_URL } from "../config/geminiConfig";
import { reportBelongsToSession } from "../utils/internalAssessment";

export default function InternalAssessmentDashboard() {
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [report, setReport] = useState(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const reportRequestSequence = useRef(0);

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
    } catch {
      setError("Session list unavailable. Check your admin sign-in and confirm the backend is running.");
    } finally {
      setLoadingSessions(false);
    }
  }

  async function viewReport(sessionId) {
    const requestSequence = ++reportRequestSequence.current;
    setSelectedSessionId(sessionId);
    setReport(null);
    setLoadingReport(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/interview/${encodeURIComponent(sessionId)}/report`, { credentials: "include" });
      const data = await response.json();
      if (requestSequence !== reportRequestSequence.current) return;
      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok || !data.success || !reportBelongsToSession(data.report, sessionId)) {
        throw new Error("Report does not match the selected session");
      }
      setReport(data.report);
    } catch {
      if (requestSequence === reportRequestSequence.current) {
        setError("Could not load the selected session report.");
      }
    } finally {
      if (requestSequence === reportRequestSequence.current) setLoadingReport(false);
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
        return true;
      })
      .then((isAuthorized) => {
        if (!active || !isAuthorized) return;
        setAuthorized(true);
        loadSessions();
      })
      .catch(() => {
        if (active) setError("Could not verify the admin session. Please sign in again.");
      })
      .finally(() => {
        if (active) setAuthChecked(true);
      });
    return () => { active = false; };
  }, []);

  async function logout() {
    try {
      await fetch(`${API_URL}/api/admin/logout`, { method: "POST", credentials: "include" });
    } finally {
      window.location.replace("/admin/login");
    }
  }

  if (!authChecked) return <main><p>Verifying admin session…</p></main>;
  if (!authorized) return <main><h1>Admin sign-in required</h1><p>{error || "Redirecting to admin sign-in."}</p><a href="/admin/login">Open admin login</a></main>;

  return (
    <main className="uc-internal-dashboard">
      <header>
        <p>URBAN COMPANY · INTERNAL ONLY</p>
        <h1>Assessment dashboard</h1>
        <p>Internal candidate interview reports</p>
        <p role="status">Prototype storage: reports remain available only while this backend process is running and are lost after restart.</p>
        <button type="button" onClick={logout}>Log out</button>
        <a href="/">Candidate interview portal</a>
      </header>
      <section aria-label="Interview sessions">
        <h2>Sessions</h2>
        {loadingSessions ? <p>Loading sessions…</p> : sessions.length === 0 ? <p>No interview sessions found.</p> : (
          <ul>
            {sessions.map((session) => (
              <li key={session.sessionId}>
                <strong>{session.candidateName}</strong> · {session.status} · {session.answeredQuestions} answers
                {session.manualReviewRequired && <strong> · Manual review</strong>}
                <button type="button" onClick={() => viewReport(session.sessionId)}>View Report</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p role="alert">{error}</p>}
      {selectedSessionId && <InterviewReport report={reportBelongsToSession(report, selectedSessionId) ? report : null} loading={loadingReport} error={reportBelongsToSession(report, selectedSessionId) ? "" : error} onRetry={() => viewReport(selectedSessionId)} />}
    </main>
  );
}
