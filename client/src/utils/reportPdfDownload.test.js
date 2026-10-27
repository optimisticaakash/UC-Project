import test from "node:test";
import assert from "node:assert/strict";
import { fetchReportPdf } from "./reportPdfDownload.js";

test("PDF download requests credentials and returns actual PDF bytes", async () => {
  let request;
  const bytes = new Blob(["%PDF-test"], { type: "application/pdf" });
  const result = await fetchReportPdf("http://localhost:5001", "session/one", async (url, options) => {
    request = { url, options };
    return { ok: true, headers: { get: () => "application/pdf" }, blob: async () => bytes };
  });
  assert.equal(request.url, "http://localhost:5001/api/interview/session%2Fone/report.pdf");
  assert.equal(request.options.credentials, "include");
  assert.equal(await result.text(), "%PDF-test");
});

test("PDF download returns a safe backend error for non-200 responses", async () => {
  await assert.rejects(
    fetchReportPdf("http://localhost:5001", "session-1", async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, message: "Unable to generate the interview PDF." }),
    })),
    (error) => error.status === 500 && error.message === "Unable to generate the interview PDF.",
  );
});

test("PDF download rejects non-PDF and empty success responses", async () => {
  await assert.rejects(
    fetchReportPdf("http://localhost:5001", "session-1", async () => ({
      ok: true, headers: { get: () => "application/json" }, blob: async () => new Blob(["{}"]),
    })),
    /did not return a valid PDF/,
  );
  await assert.rejects(
    fetchReportPdf("http://localhost:5001", "session-1", async () => ({
      ok: true, headers: { get: () => "application/pdf" }, blob: async () => new Blob([]),
    })),
    /empty PDF/,
  );
});
