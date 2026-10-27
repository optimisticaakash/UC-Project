import { useEffect, useRef, useState } from "react";
import { API_URL } from "../config/geminiConfig";
import { loadAuthSession, logoutAdmin, logoutCandidate } from "../utils/authSession.js";
import { getNavbarModel, INTERVIEW_PORTAL_HREF } from "../utils/navbarModel.js";

export default function SiteNavbar() {
  const [authState, setAuthState] = useState({ status: "signed_out" });
  const [authError, setAuthError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const navModel = getNavbarModel(authState);

  useEffect(() => {
    let active = true;
    loadAuthSession(API_URL)
      .then((state) => { if (active) setAuthState(state); })
      .catch(() => {
        if (active) setAuthError("Could not verify sign-in. Protected pages still require server authorization.");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    function closeMenu(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        menuRef.current.open = false;
        setMenuOpen(false);
      }
    }
    function closeOnEscape(event) {
      if (event.key === "Escape" && menuRef.current?.open) {
        menuRef.current.open = false;
        setMenuOpen(false);
        menuRef.current.querySelector("summary")?.focus();
      }
    }
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setAuthError("");
    try {
      if (authState.role === "candidate") await logoutCandidate(API_URL);
      else await logoutAdmin(API_URL);
      setAuthState({ status: "signed_out" });
      window.location.replace(authState.role === "candidate" ? "/candidate/login" : "/admin/login");
    } catch {
      setAuthError("Sign out could not be confirmed. Your session is still active; please try again.");
    } finally {
      setSigningOut(false);
    }
  }

  function closeAfterNavigation() {
    if (menuRef.current) menuRef.current.open = false;
    setMenuOpen(false);
  }

  return (
    <header className="w-full border-b border-neutral-200 bg-white">
      <div className="flex w-full flex-wrap items-center justify-between gap-3 px-6 py-4 sm:px-10 lg:px-12">
        <a href="/" className="flex items-center gap-3 text-inherit no-underline">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-black text-lg font-extrabold text-white">UC</span>
          <span>
            <span className="block text-base font-bold tracking-tight">Urban Company</span>
            <span className="mt-0.5 block text-xs text-neutral-500">Professional Skill Assessment</span>
          </span>
        </a>

        <nav aria-label="Account navigation" className="ml-auto flex items-center gap-3">
          <a
            aria-label="Interview Portal home"
            className="hidden rounded-full border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 no-underline hover:border-neutral-400 hover:text-neutral-950 focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2 sm:inline-flex sm:items-center sm:gap-2"
            href={INTERVIEW_PORTAL_HREF}
          >
            <span className="size-2 rounded-full bg-black" /> Interview Portal
          </a>
          {navModel.roleLabel ? (
            <>
              <span className="rounded-full bg-neutral-100 px-3 py-2 text-xs font-semibold text-neutral-700">{navModel.roleLabel}</span>
              <a className="text-sm font-medium text-neutral-700 underline-offset-4 hover:underline" href={navModel.dashboard.href}>{navModel.dashboard.label}</a>
              <button className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50 disabled:opacity-60" disabled={signingOut} onClick={signOut} type="button">
                {signingOut ? "Signing out…" : "Sign Out"}
              </button>
            </>
          ) : (
            <details className="relative" onToggle={(event) => setMenuOpen(event.currentTarget.open)} ref={menuRef}>
              <summary aria-expanded={menuOpen} aria-haspopup="menu" className="list-none cursor-pointer rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2 [&::-webkit-details-marker]:hidden">
                Sign In
              </summary>
              <div className="absolute right-0 z-50 mt-2 w-52 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg" role="menu">
                {navModel.signInOptions.map((option) => (
                  <a key={option.href} className="block rounded-lg px-3 py-2.5 text-sm font-medium text-neutral-800 hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none" href={option.href} onClick={closeAfterNavigation} role="menuitem">{option.label}</a>
                ))}
              </div>
            </details>
          )}
        </nav>
      </div>
      {authError && <p className="px-6 pb-2 text-right text-xs text-red-700 sm:px-10" role="alert">{authError}</p>}
    </header>
  );
}
