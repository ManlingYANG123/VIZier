/**
 * Frontend intake client — the browser half of the constraint-intake module.
 *
 * Turns an uploaded design document (PDF today, .txt as a convenience) into a
 * text-only `ConstraintSource` that the backend `/intake-constraints` route
 * parses into hard constraints. Extraction happens here so the backend stays
 * text-only (the LLM client sends only text content blocks); adding a new
 * source type later is a localized change here plus one adapter in re_api.
 *
 * pdf.js is imported lazily inside `extractPdfText` so this module — and its
 * pure helpers — load without the dependency present (e.g. under `node --test`).
 */

/** Files we can turn into text in the browser today. */
export const ACCEPTED_DESIGN_DOC = ".pdf,.txt,text/plain,application/pdf";

/** Build the text-only ConstraintSource posted to /intake-constraints. Pure and
 * synchronous so it is unit-testable without a DOM or pdf.js. An optional `note`
 * (e.g. "use the color palette in here") is carried through to steer which rules
 * the intake model extracts and treats as hard. */
export function buildConstraintSource({ text, filename, pageCount, kind, note }) {
  const clean = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const cleanNote = String(note ?? "").replace(/\r\n?/g, "\n").trim();
  const noteField = cleanNote ? { note: cleanNote } : {};
  if (kind === "raw-text") {
    return { kind: "raw-text", text: clean, ...noteField };
  }
  return {
    kind: "pdf-text",
    text: clean,
    ...(filename ? { filename } : {}),
    ...(Number.isFinite(pageCount) ? { pageCount } : {}),
    ...noteField,
  };
}

/** A short, human-readable summary of a loaded ConstraintSet for the chip UI.
 * "12 brand rules loaded from brand-guide.pdf" / "No rules found in notes.txt". */
export function constraintChipLabel(constraintSet) {
  if (!constraintSet || !Array.isArray(constraintSet.constraints)) return "";
  const count = constraintSet.constraints.length;
  const where = constraintSet.provenance ? ` from ${constraintSet.provenance}` : "";
  if (!count) return `No design rules found${where}`;
  return `${count} design rule${count === 1 ? "" : "s"} loaded${where}`;
}

/** True when a file looks like a design document we can extract text from. */
export function isSupportedDesignDoc(file) {
  if (!file) return false;
  const name = String(file.name || "").toLowerCase();
  const type = String(file.type || "").toLowerCase();
  return (
    name.endsWith(".pdf") ||
    name.endsWith(".txt") ||
    type === "application/pdf" ||
    type === "text/plain"
  );
}

/** Extract text from a design document File. PDFs go through pdf.js (imported
 * lazily); .txt is read directly. Returns { text, pageCount, filename }. */
export async function extractDesignDocText(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (name.endsWith(".txt") || type === "text/plain") {
    return { text: await file.text(), pageCount: undefined, filename: file.name };
  }
  return extractPdfText(file);
}

/** Extract text from a PDF File with pdf.js. The worker is wired via Vite's
 * `?url` import — the one Vite gotcha for pdf.js in a bundled app. */
export async function extractPdfText(file) {
  const pdfjs = await import("pdfjs-dist");
  // Vite resolves this to a hashed asset URL; the worker must be set once.
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => (typeof item.str === "string" ? item.str : "")).join(" "));
  }
  return { text: pages.join("\n\n"), pageCount: doc.numPages, filename: file.name };
}
