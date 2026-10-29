import GeminiVoicePrototype from "./GeminiVoicePrototype";
import InternalAssessmentDashboard from "./components/InternalAssessmentDashboard";
import AdminLogin from "./components/AdminLogin";
import CandidateLogin from "./components/CandidateLogin";
import SiteNavbar from "./components/SiteNavbar";
import CandidateInterviewHistory from "./components/CandidateInterviewHistory";
import AdminInterviewReportPage from "./components/AdminInterviewReportPage";
import AdminResponsesPage from "./components/AdminResponsesPage";

export default function App() {
  const path = window.location.pathname;
  let page;
  if (path === "/admin/login") page = <AdminLogin />;
  else if (path === "/admin/responses" || path === "/internal-assessment/responses") page = <AdminResponsesPage />;
  else if (path === "/internal-assessment") page = <InternalAssessmentDashboard />;
  else if (path.startsWith("/internal-assessment/")) page = <AdminInterviewReportPage sessionId={decodeURIComponent(path.slice("/internal-assessment/".length))} />;
  else if (path === "/candidate/login") page = <CandidateLogin />;
  else if (path === "/candidate/interviews") page = <CandidateInterviewHistory />;
  else page = (
    <div className="min-h-screen bg-neutral-100 text-neutral-950">
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-14">
        <div className="mb-7">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-neutral-500">
            Salon Professional Screening
          </p>

          <h1 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
            Your skills.
            <br className="hidden sm:block" /> Your experience.
          </h1>

          <p className="mt-4 max-w-2xl text-sm leading-7 text-neutral-600 sm:text-base">
            Welcome to your professional assessment. Is interview mein hum aapke
            experience, communication aur customer-handling skills ko samjhenge.
          </p>
        </div>

        <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
          <GeminiVoicePrototype />
        </section>
      </main>
    </div>
  );

  return (
    <>
      <SiteNavbar />
      {page}
    </>
  );
}
