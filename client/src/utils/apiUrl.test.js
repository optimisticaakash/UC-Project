import test from "node:test";
import assert from "node:assert/strict";
import { normalizeApiUrl, buildApiUrl } from "./apiUrl.js";

test("normalizeApiUrl trims whitespace and strips trailing slashes", () => {
  assert.equal(normalizeApiUrl("https://uc-project-o71w.onrender.com/"), "https://uc-project-o71w.onrender.com");
  assert.equal(normalizeApiUrl("https://uc-project-o71w.onrender.com///"), "https://uc-project-o71w.onrender.com");
  assert.equal(normalizeApiUrl(" https://uc-project-o71w.onrender.com/  "), "https://uc-project-o71w.onrender.com");
  assert.equal(normalizeApiUrl("https://uc-project-o71w.onrender.com"), "https://uc-project-o71w.onrender.com");
  assert.equal(normalizeApiUrl("http://localhost:5001/"), "http://localhost:5001");
  assert.equal(normalizeApiUrl(""), "");
  assert.equal(normalizeApiUrl(null), "");
  assert.equal(normalizeApiUrl(undefined), "");
});

test("buildApiUrl joins base URL ending in / with /api/candidate/logout without double slashes", () => {
  const result = buildApiUrl("https://uc-project-o71w.onrender.com/", "/api/candidate/logout");
  assert.equal(result, "https://uc-project-o71w.onrender.com/api/candidate/logout");
  assert.equal(result.includes("//api"), false);
});

test("buildApiUrl handles edge cases in base URL and endpoint formatting", () => {
  // Multiple slashes at boundary
  assert.equal(
    buildApiUrl("https://uc-project-o71w.onrender.com///", "///api/candidate/logout"),
    "https://uc-project-o71w.onrender.com/api/candidate/logout",
  );

  // Missing leading slash on endpoint
  assert.equal(
    buildApiUrl("https://uc-project-o71w.onrender.com", "api/candidate/logout"),
    "https://uc-project-o71w.onrender.com/api/candidate/logout",
  );

  // Both with slashes
  assert.equal(
    buildApiUrl("http://localhost:5001/", "/api/admin/logout"),
    "http://localhost:5001/api/admin/logout",
  );

  // Empty endpoint returns normalized base
  assert.equal(
    buildApiUrl("https://uc-project-o71w.onrender.com/", ""),
    "https://uc-project-o71w.onrender.com",
  );

  // Empty base returns leading slash path
  assert.equal(
    buildApiUrl("", "/api/candidate/logout"),
    "/api/candidate/logout",
  );
  assert.equal(
    buildApiUrl("", "api/candidate/logout"),
    "/api/candidate/logout",
  );
});

