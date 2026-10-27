import { useState } from "react";
import { API_URL } from "../config/geminiConfig";
import { logoutCandidate } from "../utils/authSession.js";

export default function AdminLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [setupMode, setSetupMode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showSetupToken, setShowSetupToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await logoutCandidate(API_URL);
      const response = await fetch(`${API_URL}/api/admin/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.message || "Admin sign-in failed.");
      window.location.replace("/internal-assessment");
    } catch (loginError) {
      setError(loginError.message || "Could not reach the sign-in service. Check that the backend is running.");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  async function setupAdmin(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await logoutCandidate(API_URL);
      const response = await fetch(`${API_URL}/api/admin/setup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, loginIdentifier: username, password, setupToken }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.message || "First-admin setup failed.");
      window.location.replace("/internal-assessment");
    } catch (setupError) {
      setError(setupError.message || "Could not reach the admin setup service.");
    } finally {
      setBusy(false);
      setPassword("");
      setSetupToken("");
    }
  }

  return (
    <main className="flex min-h-[calc(100vh-112px)] items-start justify-center bg-[#f7f7f7] px-4 py-12 sm:items-center sm:px-6 sm:py-16">
      <section aria-labelledby="admin-login-heading" className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-[0_12px_40px_rgba(0,0,0,0.07)] sm:p-9">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">URBAN COMPANY · INTERNAL ONLY</p>
        <h1 id="admin-login-heading" className="mt-3 text-3xl font-semibold tracking-tight text-neutral-950">
          {setupMode ? "Set Up Admin Account" : "Admin Sign In"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          {setupMode ? "First-admin setup is available only with the one-time token configured on the server." : "Sign in to manage candidates and interview reports."}
        </p>

        <form className="mt-8 space-y-5" onSubmit={setupMode ? setupAdmin : submit}>
          {setupMode && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-neutral-800" htmlFor="admin-name">Admin name</label>
              <input autoComplete="name" className="h-12 w-full rounded-lg border border-neutral-300 px-3.5 text-base outline-none focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/10" disabled={busy} id="admin-name" maxLength={160} onChange={(event) => setName(event.target.value)} required value={name} />
            </div>
          )}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-800" htmlFor="admin-username">Login identifier</label>
            <input autoComplete="username" className="h-12 w-full rounded-lg border border-neutral-300 bg-white px-3.5 text-base text-neutral-950 outline-none transition focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/10 disabled:bg-neutral-100" disabled={busy} id="admin-username" name="username" onChange={(event) => setUsername(event.target.value)} required value={username} />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-800" htmlFor="admin-password">{setupMode ? "Password (minimum 12 characters)" : "Password"}</label>
            <div className="relative">
              <input autoComplete={setupMode ? "new-password" : "current-password"} className="h-12 w-full rounded-lg border border-neutral-300 bg-white px-3.5 pr-12 text-base text-neutral-950 outline-none transition focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/10 disabled:bg-neutral-100" disabled={busy} id="admin-password" minLength={setupMode ? 12 : undefined} name="password" onChange={(event) => setPassword(event.target.value)} required type={showPassword ? "text" : "password"} value={password} />
              <button aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-neutral-500 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-900 disabled:cursor-not-allowed" disabled={busy} onClick={() => setShowPassword((visible) => !visible)} type="button">
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
          </div>
          {setupMode && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-neutral-800" htmlFor="admin-setup-token">One-time setup token</label>
              <div className="relative">
                <input autoComplete="off" className="h-12 w-full rounded-lg border border-neutral-300 px-3.5 pr-12 text-base outline-none focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/10" disabled={busy} id="admin-setup-token" onChange={(event) => setSetupToken(event.target.value)} required type={showSetupToken ? "text" : "password"} value={setupToken} />
                <button aria-label={showSetupToken ? "Hide setup token" : "Show setup token"} aria-pressed={showSetupToken} className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-neutral-500 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-900 disabled:cursor-not-allowed" disabled={busy} onClick={() => setShowSetupToken((visible) => !visible)} type="button">
                  {showSetupToken ? (
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
            </div>
          )}
          {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-5 text-red-800" role="alert">{error}</p>}
          <button className="flex h-12 w-full items-center justify-center rounded-lg bg-neutral-950 px-4 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-wait disabled:bg-neutral-500" disabled={busy} type="submit">
            {busy ? "Working…" : setupMode ? "Create Admin Account" : "Sign In"}
          </button>
        </form>
        <button className="mt-5 text-sm font-medium text-neutral-700 underline underline-offset-4" disabled={busy} onClick={() => { setSetupMode((value) => !value); setError(""); }} type="button">
          {setupMode ? "Return to Admin Sign In" : "Set up the first admin account"}
        </button>
      </section>
    </main>
  );
}
