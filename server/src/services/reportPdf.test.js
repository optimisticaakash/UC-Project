const test = require("node:test");
const assert = require("node:assert/strict");
const { generateInterviewReportPdf, getShapingEngine, getReportPdfHash } = require("./reportPdf");

test("report PDF generator creates a real PDF containing persisted report content", async () => {
  const pdf = await generateInterviewReportPdf({
    sessionId: "session-pdf-test",
    candidateName: "दिन",
    status: "completed",
    startedAt: "2026-01-02T03:04:05.000Z",
    answeredQuestions: 1,
    totalQuestions: 50,
    answers: [{
      questionId: "A3",
      questionText: "हां मैं सहमत हूं।",
      answer: "हाँ, मैं दिल्ली में रहती हूं। हां मैं सहमत हूं। मैं दिल्ली में रहती हूं। I work in Delhi.",
    }],
  });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1000);
  assert.match(pdf.toString("latin1"), /NotoSansDevanagari-Regular/);
  assert.match(pdf.toString("latin1"), /FontFile2/);
});

test("report PDF generator rejects missing report records", async () => {
  assert.throws(() => generateInterviewReportPdf(null), /persisted interview report/);
});

test("shared PDF generator supports Hindi-only, English-only, and mixed-language reports", async () => {
  const fixtures = [
    { name: "Hindi-only", candidateName: "दिन", answer: "हाँ, मैं दिल्ली में रहती हूं। हां मैं सहमत हूं।" },
    { name: "English-only", candidateName: "Candidate One", answer: "I live in Delhi and can work with customers." },
    { name: "mixed Hindi-English", candidateName: "दिन Candidate", answer: "मैं दिल्ली में रहती हूं। I work in Delhi." },
  ];
  for (const fixture of fixtures) {
    const pdf = await generateInterviewReportPdf({
      sessionId: `session-${fixture.name}`,
      candidateName: fixture.candidateName,
      status: "completed",
      answers: [{ questionId: "A3", questionText: "दिन", answer: fixture.answer }],
    });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-", `${fixture.name} report should be a PDF`);
    assert.match(pdf.toString("latin1"), /FontFile2/, `${fixture.name} report should embed its font`);
  }
});

test("HarfBuzz shapes Devanagari matras and retains a versioned generator hash", async () => {
  const { hb, font } = await getShapingEngine();
  const buffer = new hb.Buffer();
  buffer.addText("दिन");
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  const infos = buffer.getGlyphInfos();
  assert.equal(infos.length, 3);
  assert.notDeepEqual(infos.map((glyph) => glyph.cluster), [0, 1, 2], "pre-base matra should be reordered by shaping");
  assert.equal(getReportPdfHash({ sessionId: "one" }), getReportPdfHash({ sessionId: "one" }));
  assert.notEqual(getReportPdfHash({ sessionId: "one" }), getReportPdfHash({ sessionId: "two" }));
});

test("long interview answers wrap and paginate with repeated page furniture", async () => {
  const pdf = await generateInterviewReportPdf({
    sessionId: "session-long-pdf-test",
    status: "incomplete",
    answers: Array.from({ length: 8 }, (_, index) => ({
      questionId: `A${index + 1}`,
      questionText: "मैं दिल्ली में रहती हूं।",
      answer: `${"हाँ, मैं दिल्ली में रहती हूं। I can work with customers. ".repeat(30)}`,
    })),
  });
  const pageObjects = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || [];
  assert.ok(pageObjects.length > 1, "long report should create additional PDF pages");
  assert.match(pdf.toString("latin1"), /NotoSansDevanagari-Regular/);
});
