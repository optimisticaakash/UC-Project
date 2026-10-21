import { useState } from "react";

const API_URL = "http://localhost:5001";

export default function App() {
  const [sessionId, setSessionId] = useState("");
  const [question, setQuestion] = useState(null);
  const [answer, setAnswer] = useState("");
  const [questionNumber, setQuestionNumber] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);

  async function startInterview() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_URL}/api/interview/start`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Interview start nahi ho paaya.");
      }

      setSessionId(data.sessionId);
      setQuestion(data.question);
      setQuestionNumber(data.questionNumber);
      setTotalQuestions(data.totalQuestions);
      setAnswer("");
      setCompleted(false);
    } catch (err) {
      setError(
        err.message || "Backend se connect nahi ho paaya. Server check karein.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function submitAnswer() {
    if (!answer.trim()) {
      setError("Please pehle apna answer likhein.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_URL}/api/interview/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          answer,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Answer submit nahi hua.");
      }

      setAnswer("");

      if (data.completed) {
        setCompleted(true);
        setQuestion(null);
      } else {
        setQuestion(data.question);
        setQuestionNumber(data.questionNumber);
        setTotalQuestions(data.totalQuestions ?? totalQuestions);
      }
    } catch (err) {
      setError(err.message || "Kuch galat hua. Dobara try karein.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-950">
      {/* Header */}
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-5 sm:px-8">
          <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-black text-lg font-extrabold text-white">
            UC
          </div>

          <div>
            <h2 className="text-base font-bold tracking-tight">
              Urban Company
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Professional Skill Assessment
            </p>
          </div>

          <div className="ml-auto hidden items-center gap-2 rounded-full border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 sm:flex">
            <span className="size-2 rounded-full bg-black" />
            Interview Portal
          </div>
        </div>
      </header>

      {/* Main content */}
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
          {/* Card header */}
          <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4 sm:px-8">
            <span className="text-sm font-semibold">Interview Session</span>

            <span className="rounded-full bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600">
              {completed
                ? "Completed"
                : question
                  ? "In progress"
                  : "Not started"}
            </span>
          </div>

          <div className="p-5 sm:p-8">
            {/* Welcome screen */}
            {!question && !completed && (
              <div className="py-6 text-center sm:py-10">
                <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-neutral-100 text-2xl text-black">
                  ✦
                </div>

                <h2 className="mt-6 text-xl font-bold sm:text-2xl">
                  Ready to begin?
                </h2>

                <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-neutral-500">
                  Aap shaant jagah baithkar interview shuru kar sakti hain.
                  Filhaal aap answers type karengi; voice features baad mein
                  integrate honge.
                </p>

                <button
                  type="button"
                  onClick={startInterview}
                  disabled={loading}
                  className="mt-7 inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-black px-7 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-4 focus:ring-neutral-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Starting interview..." : "Start Interview"}
                  {!loading && <span aria-hidden="true">→</span>}
                </button>
              </div>
            )}

            {/* Active question */}
            {question && (
              <div>
                <p className="mb-4 text-xs text-neutral-500">
                  Session ID: {sessionId}
                </p>
                <div className="mb-7">
                  <div className="mb-3 flex items-center justify-between gap-4 text-xs font-medium text-neutral-500">
                    <span>YOUR PROGRESS</span>
                    <span>
                      Question {questionNumber} of {totalQuestions}
                    </span>
                  </div>

                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-neutral-100"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={totalQuestions}
                    aria-valuenow={questionNumber}
                  >
                    <div
                      className="h-full rounded-full bg-black transition-all duration-300"
                      style={{
                        width: `${
                          totalQuestions
                            ? (questionNumber / totalQuestions) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-5 sm:p-7">
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-neutral-500">
                    Question {questionNumber}
                  </p>

                  <h2 className="mt-4 text-xl font-semibold leading-8 tracking-tight sm:text-2xl">
                    {question.text}
                  </h2>
                </div>

                <div className="mt-7">
                  <label
                    htmlFor="candidate-answer"
                    className="mb-2 block text-sm font-semibold"
                  >
                    Your answer
                  </label>

                  <textarea
                    id="candidate-answer"
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        submitAnswer();
                      }
                    }}
                    placeholder="Apna answer yahan type karein..."
                    rows={5}
                    disabled={loading}
                    className="w-full resize-y rounded-xl border border-neutral-300 bg-white p-4 text-sm leading-7 outline-none transition placeholder:text-neutral-400 focus:border-black focus:ring-4 focus:ring-neutral-200 disabled:bg-neutral-50"
                  />

                  <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-neutral-500">
                      Tip: Ctrl + Enter se answer submit kar sakte hain.
                    </p>

                    <button
                      type="button"
                      onClick={submitAnswer}
                      disabled={loading}
                      className="inline-flex min-h-11 items-center justify-center gap-3 rounded-xl bg-black px-6 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-4 focus:ring-neutral-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {loading ? "Submitting..." : "Submit & Continue"}
                      {!loading && <span aria-hidden="true">→</span>}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Completion screen */}
            {completed && (
              <div className="py-8 text-center sm:py-12">
                <div className="mx-auto grid size-16 place-items-center rounded-full bg-black text-2xl text-white">
                  ✓
                </div>

                <h2 className="mt-6 text-2xl font-bold">Interview completed</h2>

                <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-neutral-500">
                  Aapke responses successfully receive ho gaye hain. Assessment
                  report aur scoring abhi implement karna baaki hai.
                </p>

                <button
                  type="button"
                  onClick={startInterview}
                  disabled={loading}
                  className="mt-7 rounded-xl border border-neutral-300 bg-white px-6 py-3 text-sm font-semibold transition hover:bg-neutral-100 disabled:opacity-50"
                >
                  Start New Interview
                </button>
              </div>
            )}

            {/* Error message */}
            {error && (
              <div
                role="alert"
                className="mt-6 rounded-xl border border-neutral-300 bg-neutral-100 p-4 text-sm text-neutral-800"
              >
                <p className="font-semibold">Something went wrong</p>
                <p className="mt-1 leading-6">{error}</p>

                <button
                  type="button"
                  onClick={() => setError("")}
                  className="mt-3 text-xs font-semibold underline underline-offset-4"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {/* Footer */}
          <footer className="border-t border-neutral-200 bg-neutral-50 px-5 py-4 sm:px-8">
            <p className="text-center text-xs leading-5 text-neutral-500">
              Urban Company · Professional Screening Demo
            </p>
          </footer>
        </section>
      </main>
    </div>
  );
}
