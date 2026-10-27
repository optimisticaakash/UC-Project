import test from "node:test";
import assert from "node:assert/strict";
import { getNavbarModel, INTERVIEW_PORTAL_HREF } from "./navbarModel.js";

test("Interview Portal navigation opens the existing public interview landing page", () => {
  assert.equal(INTERVIEW_PORTAL_HREF, "/");
});

test("signed-out navbar exposes both existing sign-in destinations", () => {
  const model = getNavbarModel({ status: "signed_out" });
  assert.equal(model.roleLabel, null);
  assert.deepEqual(model.signInOptions, [
    { label: "Admin Sign In", href: "/admin/login" },
    { label: "Candidate Sign In", href: "/candidate/login" },
  ]);
});

test("authenticated Admin receives only Admin navigation", () => {
  assert.deepEqual(getNavbarModel({ status: "authenticated", role: "admin" }), {
    roleLabel: "Admin",
    dashboard: { label: "Admin Dashboard", href: "/internal-assessment" },
    signInOptions: [],
  });
});

test("Candidate receives personal interview-history navigation without Admin navigation", () => {
  assert.deepEqual(getNavbarModel({ status: "authenticated", role: "candidate" }), {
    roleLabel: "Candidate",
    dashboard: { label: "My Interviews", href: "/candidate/interviews" },
    signInOptions: [],
  });
  assert.equal(getNavbarModel({ status: "checking" }).roleLabel, null);
});
