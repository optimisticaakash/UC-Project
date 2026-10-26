import { useState } from "react";
import { API_URL } from "../config/geminiConfig";

export default function AdminLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.message || "Admin sign-in failed.");
        return;
      }
      window.location.replace("/internal-assessment");
    } catch {
      setError("Could not reach the sign-in service. Check that the backend is running.");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <main className="uc-internal-dashboard">
      <section aria-labelledby="admin-login-heading">
        <p>URBAN COMPANY · INTERNAL ONLY</p>
        <h1 id="admin-login-heading">Admin sign-in</h1>
        <form onSubmit={submit}>
          <label htmlFor="admin-username">Username</label>
          <input
            autoComplete="username"
            id="admin-username"
            name="username"
            onChange={(event) => setUsername(event.target.value)}
            required
            value={username}
          />
          <label htmlFor="admin-password">Password</label>
          <input
            autoComplete="current-password"
            id="admin-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          {error && <p role="alert">{error}</p>}
          <button disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
        </form>
      </section>
    </main>
  );
}
