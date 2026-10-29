import test from "node:test";
import assert from "node:assert/strict";
import {
  loadAdminSession,
  logoutAdmin,
  loadAuthSession,
  loginCandidate,
  logoutCandidate,
} from "./authSession.js";

test("refresh restores Admin state only from the backend session endpoint", async () => {
  let request;
  const state = await loadAdminSession("http://localhost:5001", async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ success: true, user: { role: "admin" } }) };
  });

  assert.deepEqual(state, { status: "authenticated", role: "admin" });
  assert.equal(request.url, "http://localhost:5001/api/admin/me");
  assert.equal(request.options.credentials, "include");
});

test("a signed-out session and a non-admin role do not authenticate the navbar", async () => {
  assert.deepEqual(
    await loadAdminSession("http://localhost:5001", async () => ({ ok: false, status: 401 })),
    { status: "signed_out" },
  );
  assert.deepEqual(
    await loadAdminSession("http://localhost:5001", async () => ({ ok: true, status: 200, json: async () => ({ success: true, user: { role: "candidate" } }) })),
    { status: "signed_out" },
  );
});

test("Admin sign out requires successful backend confirmation", async () => {
  let request;
  await assert.rejects(
    logoutAdmin("http://localhost:5001", async (url, options) => {
      request = { url, options };
      return { ok: false, status: 503, json: async () => ({ success: false }) };
    }),
    /sign out failed/i,
  );
  assert.equal(request.url, "http://localhost:5001/api/admin/logout");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.credentials, "include");

  assert.equal(
    await logoutAdmin("http://localhost:5001", async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })),
    true,
  );
});

test("refresh restores Candidate state only from the candidate session endpoint", async () => {
  const requests = [];
  const responses = [
    { ok: false, status: 401 },
    { ok: true, status: 200, json: async () => ({ success: true, user: { role: "candidate", candidateId: "candidate-1", name: "Riya", loginIdentifier: "riya@example.test" } }) },
  ];
  const state = await loadAuthSession("http://localhost:5001", async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  });

  assert.deepEqual(state, { status: "authenticated", role: "candidate", candidateId: "candidate-1", name: "Riya", loginIdentifier: "riya@example.test" });
  assert.match(requests[0].url, /\/api\/admin\/me$/);
  assert.match(requests[1].url, /\/api\/candidate\/me$/);
  assert.equal(requests[1].options.credentials, "include");
});

test("Candidate sign-in sends the provisioned identifier and uses a cookie session", async () => {
  let request;
  const user = await loginCandidate("http://localhost:5001", "riya@example.test", "private-test-password", async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ success: true, user: { role: "candidate", candidateId: "candidate-1" } }) };
  });
  assert.equal(user.candidateId, "candidate-1");
  assert.equal(request.url, "http://localhost:5001/api/candidate/login");
  assert.equal(request.options.credentials, "include");
  assert.deepEqual(JSON.parse(request.options.body), { loginIdentifier: "riya@example.test", password: "private-test-password" });
});

test("Candidate logout requires backend confirmation", async () => {
  let request;
  assert.equal(await logoutCandidate("http://localhost:5001", async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }), true);
  assert.equal(request.url, "http://localhost:5001/api/candidate/logout");
  assert.equal(request.options.credentials, "include");
});

test("Candidate logout normalizes trailing slash in base URL and produces no double slash", async () => {
  let request;
  const baseUrlWithSlash = "https://uc-project-o71w.onrender.com/";
  const result = await logoutCandidate(baseUrlWithSlash, async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });

  assert.equal(result, true);
  assert.equal(
    request.url,
    "https://uc-project-o71w.onrender.com/api/candidate/logout",
  );
  assert.equal(request.url.includes("//api"), false);
  assert.equal(request.options.credentials, "include");
});

