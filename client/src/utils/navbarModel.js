export const SIGN_IN_OPTIONS = Object.freeze([
  { label: "Admin Sign In", href: "/admin/login" },
  { label: "Candidate Sign In", href: "/candidate/login" },
]);

export const INTERVIEW_PORTAL_HREF = "/";

export function getNavbarModel(authState) {
  if (authState?.status === "authenticated" && authState.role === "admin") {
    return {
      roleLabel: "Admin",
      dashboard: { label: "Admin Dashboard", href: "/internal-assessment" },
      signInOptions: [],
    };
  }
  if (authState?.status === "authenticated" && authState.role === "candidate") {
    return {
      roleLabel: "Candidate",
      dashboard: { label: "My Interviews", href: "/candidate/interviews" },
      signInOptions: [],
    };
  }
  return { roleLabel: null, dashboard: null, signInOptions: SIGN_IN_OPTIONS };
}
