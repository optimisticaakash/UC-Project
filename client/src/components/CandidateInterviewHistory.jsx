import { useEffect, useState } from "react";
import { API_URL } from "../config/geminiConfig";
import { loadCandidateSession } from "../utils/authSession.js";

export default function CandidateInterviewHistory() {
  const [interviews, setInterviews] = useState([]);
  const [candidateProfile, setCandidateProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const session = await loadCandidateSession(API_URL);
        if (session.status !== "authenticated") {
          window.location.replace("/candidate/login");
          return;
        }
        if (active) setCandidateProfile(session);
        const response = await fetch(`${API_URL}/api/candidate/interviews`, { credentials: "include" });
        const data = await response.json();
        if (response.status === 401) {
          window.location.replace("/candidate/login");
          return;
        }
        if (!response.ok || !data.success) throw new Error(data.message || "Interview history is unavailable.");
        if (active) setInterviews(data.interviews || []);
      } catch (loadError) {
        if (active) setError(loadError.message || "Interview history is unavailable.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <main className="mx-auto min-h-[calc(100vh-112px)] max-w-5xl px-4 py-8 sm:px-8">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Candidate portal</p>
        <h1 className="mt-2 text-3xl font-semibold">My Interviews</h1>
        {candidateProfile && <div className="mt-3">
          <p className="text-base font-semibold text-neutral-950">{candidateProfile.name}</p>
          <p className="mt-0.5 text-sm text-neutral-600">Email / login identifier: {candidateProfile.loginIdentifier}</p>
        </div>}
        <a className="mt-3 inline-block underline" href="/">Open interview portal</a>
      </header>
      <section className="rounded-2xl border border-neutral-200 bg-white p-5" aria-label="Your interview history">
        {loading ? <p>Loading your interviews…</p> : interviews.length === 0 ? <p>No interviews are linked to your account yet.</p> : (
          <ul className="space-y-3">
            {interviews.map((item) => <li className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 pb-3" key={item.sessionId}>
              <span>{item.status} · started {new Date(item.startedAt).toLocaleString()} · {item.answeredQuestions} answers{item.manualReviewRequired ? " · Manual review" : ""}</span>
            </li>)}
          </ul>
        )}
      </section>
      {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
    </main>
  );
}
