import { useState } from "react";
import { API_URL } from "../config/geminiConfig";
import { loginCandidate, logoutAdmin } from "../utils/authSession.js";
import {
  isValidCandidateEmail,
  isValidLegacyCandidateIdentifier,
  normalizeCandidateLoginIdentifier,
} from "../utils/candidateProvisionValidation.js";

export default function CandidateLogin() {
  const [loginIdentifier, setLoginIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [identifierError, setIdentifierError] = useState("");
  const [passwordError, setPasswordError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const normalizedIdentifier = normalizeCandidateLoginIdentifier(loginIdentifier);
    if (!normalizedIdentifier) {
      setIdentifierError("Enter your email address.");
      setPasswordError("");
      setError("");
      return;
    }
    if (!isValidCandidateEmail(normalizedIdentifier) && !isValidLegacyCandidateIdentifier(normalizedIdentifier)) {
      setIdentifierError("Enter a valid email address.");
      setPasswordError("");
      setError("");
      return;
    }
    setIdentifierError("");
    if (!password) {
      setPasswordError("Enter your password.");
      setError("");
      return;
    }
    setPasswordError("");
    setBusy(true);
    setError("");
    try {
      await logoutAdmin(API_URL);
      await loginCandidate(API_URL, normalizedIdentifier, password);
      window.location.replace("/");
    } catch (loginError) {
      setError(loginError.message || "Candidate sign-in failed.");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <main className="flex min-h-[calc(100vh-112px)] items-start justify-center bg-[#f7f7f7] px-4 py-12 sm:items-center sm:px-6 sm:py-16">
      <section aria-labelledby="candidate-login-heading" className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-[0_12px_40px_rgba(0,0,0,0.07)] sm:p-9">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Urban Company · Candidate access</p>
        <h1 id="candidate-login-heading" className="mt-3 text-3xl font-semibold tracking-tight text-neutral-950">Candidate Sign In</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">Use the email and password shared by the Urban Company team to open your interview.</p>
        <form className="mt-8 space-y-5" noValidate onSubmit={submit}>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-800" htmlFor="candidate-login-identifier">Email address</label>
            <input aria-describedby={identifierError ? "candidate-login-email-error" : "candidate-login-legacy-help"} aria-invalid={Boolean(identifierError)} autoComplete="username" className={`h-12 w-full rounded-lg border px-3.5 text-base outline-none focus:ring-4 ${identifierError ? "border-red-600 focus:border-red-700 focus:ring-red-700/10" : "border-neutral-300 focus:border-neutral-900 focus:ring-neutral-900/10"}`} id="candidate-login-identifier" name="loginIdentifier" onChange={(event) => { setLoginIdentifier(event.target.value); setIdentifierError(""); }} required value={loginIdentifier} />
            {identifierError && <p className="text-sm text-red-700" id="candidate-login-email-error" role="alert">{identifierError}</p>}
            <p className="text-xs text-neutral-500" id="candidate-login-legacy-help">Existing accounts created with a username may continue using that identifier.</p>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-800" htmlFor="candidate-login-password">Password</label>
            <div className="relative">
              <input aria-describedby={passwordError ? "candidate-login-password-error" : undefined} aria-invalid={Boolean(passwordError)} autoComplete="current-password" className={`h-12 w-full rounded-lg border px-3.5 pr-12 text-base outline-none focus:ring-4 ${passwordError ? "border-red-600 focus:border-red-700 focus:ring-red-700/10" : "border-neutral-300 focus:border-neutral-900 focus:ring-neutral-900/10"}`} id="candidate-login-password" name="password" onChange={(event) => { setPassword(event.target.value); setPasswordError(""); }} required type={showPassword ? "text" : "password"} value={password} />
              <button aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} aria-controls="candidate-login-password" className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-neutral-500 transition hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-900" onClick={() => setShowPassword((visible) => !visible)} type="button">
                {showPassword ? (
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
            {passwordError && <p className="text-sm text-red-700" id="candidate-login-password-error" role="alert">{passwordError}</p>}
          </div>
          {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800" role="alert">{error}</p>}
          <button className="h-12 w-full rounded-lg bg-neutral-950 px-4 text-sm font-semibold text-white hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/25 disabled:cursor-wait disabled:bg-neutral-500" disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign In"}
          </button>
        </form>
        <p className="mt-5 text-xs leading-5 text-neutral-500">Need access? Contact the Urban Company team. Candidate accounts are provisioned by an Admin.</p>
      </section>
    </main>
  );
}
