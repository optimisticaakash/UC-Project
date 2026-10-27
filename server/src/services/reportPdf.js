const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const PDFDocument = require("pdfkit");

const devanagariFont = path.join(__dirname, "../../assets/fonts/NotoSansDevanagari-Regular.ttf");
const DEVANAGARI_PATTERN = /[\u0900-\u097f]/u;
const REPORT_PDF_GENERATOR_VERSION = "harfbuzz-noto-devanagari-v1";
let shapingPromise;

function getShapingEngine() {
  if (!shapingPromise) {
    shapingPromise = import("harfbuzzjs").then((hb) => {
      const fontBytes = new Uint8Array(fs.readFileSync(devanagariFont));
      const blob = new hb.Blob(fontBytes);
      const face = new hb.Face(blob);
      const font = new hb.Font(face);
      font.setScale(face.upem, face.upem);
      return { hb, font };
    });
  }
  return shapingPromise;
}

function getReportPdfHash(report) {
  return crypto.createHash("sha256")
    .update(`${REPORT_PDF_GENERATOR_VERSION}:${JSON.stringify(report)}`)
    .digest("hex");
}

function installDevanagariShaping(pdfDocument, { hb, font }) {
  const embeddedFont = pdfDocument._font;
  const fallbackLayoutRun = embeddedFont.layoutRun.bind(embeddedFont);

  embeddedFont.layoutRun = function layoutWithHarfBuzz(text, features) {
    if (!DEVANAGARI_PATTERN.test(text)) return fallbackLayoutRun(text, features);

    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb.shape(font, buffer);

    const infos = buffer.getGlyphInfos();
    const shapedPositions = buffer.getGlyphPositions();
    const characters = Array.from(text);
    const clusterStarts = [...new Set(infos.map((info) => info.cluster))].sort((a, b) => a - b);
    const clusterText = new Map();
    clusterStarts.forEach((start, index) => {
      clusterText.set(
        start,
        characters.slice(start, clusterStarts[index + 1] ?? characters.length)
          .map((character) => character.codePointAt(0)),
      );
    });

    // PDFKit embeds and subsets the Noto font as before. HarfBuzz supplies
    // the reordered/substituted glyph IDs and exact positioning; logical
    // Unicode is retained once per cluster for the PDF's ToUnicode map.
    const mappedClusters = new Set();
    const glyphs = infos.map((info) => {
      const codePoints = mappedClusters.has(info.cluster)
        ? []
        : clusterText.get(info.cluster) || [];
      mappedClusters.add(info.cluster);
      return this.font.getGlyph(info.codepoint, codePoints);
    });
    const positions = shapedPositions.map((position) => ({
      xAdvance: position.xAdvance,
      yAdvance: position.yAdvance,
      xOffset: position.xOffset,
      yOffset: position.yOffset,
    }));

    let advanceWidth = 0;
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index];
      for (const key of Object.keys(position)) position[key] *= this.scale;
      position.advanceWidth = glyphs[index].advanceWidth * this.scale;
      advanceWidth += shapedPositions[index].xAdvance * this.scale;
    }

    return { glyphs, positions, advanceWidth };
  };
}

function generateInterviewReportPdf(report) {
  if (!report || typeof report !== "object" || !report.sessionId) {
    throw new TypeError("A persisted interview report is required to create a PDF.");
  }

  return new Promise((resolve, reject) => {
    getShapingEngine().then((shaper) => {
      const document = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
      const chunks = [];
      document.on("data", (chunk) => chunks.push(chunk));
      document.on("error", reject);
      document.on("end", () => resolve(Buffer.concat(chunks)));
      document.font(devanagariFont);
      installDevanagariShaping(document, shaper);

      const writeMixed = (value, options = {}) => {
        const pieces = String(value).match(/[\u0900-\u097f]+|[^\u0900-\u097f]+/gu) || [];
        pieces.forEach((piece, index) => {
          document.font(DEVANAGARI_PATTERN.test(piece) ? devanagariFont : "Helvetica");
          document.text(piece, {
            ...options,
            continued: index < pieces.length - 1 || Boolean(options.continued),
          });
        });
        if (!pieces.length) document.text("");
      };

      const text = (label, value) => {
        if (value === null || value === undefined || value === "") return;
        document.fontSize(10).fillColor("#555555");
        writeMixed(`${label} `, { continued: true });
        document.fillColor("#111111");
        writeMixed(String(value), { lineGap: 3 });
      };

      document.font("Helvetica-Bold").fontSize(20).fillColor("#111111").text("Urban Company Interview Report");
      document.moveDown(0.7);
      text("Candidate", report.candidateName || "Name not recorded");
      text("Candidate ID", report.candidateId);
      text("Session ID", report.sessionId);
      text("Status", report.status);
      text("Started", report.startedAt);
      text("Completed", report.completedAt || report.endedAt);
      text("Answered questions", `${report.answeredQuestions ?? report.answers?.length ?? 0} / ${report.totalQuestions ?? "unknown"}`);
      text("Consent outcome", report.consentOutcome);
      text("Eligibility outcome", report.eligibilityOutcome);
      text("Location outcome", report.locationOutcome);
      text("Manual review required", report.manualReviewRequired ? "Yes" : "No");
      text("Manual review reason", report.manualReviewReason);

      if (Array.isArray(report.manualChecks) && report.manualChecks.length) {
        document.moveDown().font("Helvetica-Bold").fontSize(14).fillColor("#111111").text("Manual checks");
        report.manualChecks.forEach((check, index) => {
          document.moveDown(0.3).font("Helvetica-Bold").fontSize(10).text(`${index + 1}. ${check.questionId || "Interview check"}`);
          text("Outcome", check.outcome);
          text("Area", check.area);
          text("Travel willingness", check.travelWillingness);
          text("Move timeline answer", check.moveTimelineAnswer);
          text("Follow-up answer", check.followUpAnswer);
        });
      }

      if (report.pendingInterpretation?.answer) {
        document.moveDown().font("Helvetica-Bold").fontSize(14).fillColor("#111111").text("Answer awaiting interpretation retry");
        text("Question", report.pendingInterpretation.questionText || report.pendingInterpretation.questionId);
        text("Recorded answer", report.pendingInterpretation.answer);
      }

      document.moveDown().font("Helvetica-Bold").fontSize(14).fillColor("#111111").text("Questions and recorded answers");
      const answers = Array.isArray(report.answers) ? report.answers : [];
      if (!answers.length) {
        document.moveDown(0.4).font("Helvetica").fontSize(10).text("No answers were recorded.");
      }
      answers.forEach((entry, index) => {
        document.moveDown(0.55).font("Helvetica-Bold").fontSize(12).fillColor("#111111").text(`${index + 1}. ${entry.questionId || "Answer"}`);
        text("Question", entry.questionText);
        text("Answer", entry.answer || "No answer recorded");
        if (Array.isArray(entry.previousInterpretationAttempts)) {
          entry.previousInterpretationAttempts.forEach((attempt, attemptIndex) => text(`Prior answer attempt ${attemptIndex + 1}`, attempt));
        }
        text("Interpretation", entry.interpretation?.understanding);
        text("Interpretation status", entry.interpretation?.answerStatus);
        text("Consent", entry.consentOutcome);
        text("Eligibility", entry.eligibilityOutcome);
        text("Age", entry.age);
        text("Travel willingness", entry.travelWillingness);
        text("Location / area", entry.location);
        text("Child applicability", entry.childPresence);
        if (entry.manualReviewRequired) text("Manual review", entry.manualReviewReason || "Required");
      });

      const pages = document.bufferedPageRange();
      for (let page = pages.start; page < pages.start + pages.count; page += 1) {
        document.switchToPage(page);
        document.font("Helvetica").fontSize(8).fillColor("#666666");
        if (page > pages.start) document.text("Urban Company · Interview Report", 48, 22, { lineBreak: false });
        document.text(`Page ${page - pages.start + 1} of ${pages.count}`, 48, 810, {
          width: 499,
          align: "right",
          lineBreak: false,
        });
      }
      document.end();
    }).catch(reject);
  });
}

module.exports = { generateInterviewReportPdf, getShapingEngine, getReportPdfHash, REPORT_PDF_GENERATOR_VERSION };
