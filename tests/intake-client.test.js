import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildConstraintSource,
  constraintChipLabel,
  isSupportedDesignDoc,
  ACCEPTED_DESIGN_DOC,
} from "../src/intake-client.js";

test("buildConstraintSource normalizes newlines and keeps pdf provenance", () => {
  const source = buildConstraintSource({
    text: "  Use brand blue.\r\nHelvetica only.  ",
    filename: "brand.pdf",
    pageCount: 12,
    kind: "pdf-text",
  });
  assert.equal(source.kind, "pdf-text");
  assert.equal(source.text, "Use brand blue.\nHelvetica only.");
  assert.equal(source.filename, "brand.pdf");
  assert.equal(source.pageCount, 12);
});

test("buildConstraintSource omits pageCount when not a finite number", () => {
  const source = buildConstraintSource({ text: "x", filename: "b.pdf", pageCount: undefined, kind: "pdf-text" });
  assert.ok(!("pageCount" in source));
});

test("buildConstraintSource supports raw-text without file metadata", () => {
  const source = buildConstraintSource({ text: "Notes here", kind: "raw-text" });
  assert.deepEqual(source, { kind: "raw-text", text: "Notes here" });
});

test("buildConstraintSource carries a trimmed author note and omits an empty one", () => {
  const withNote = buildConstraintSource({
    text: "x",
    filename: "b.pdf",
    kind: "pdf-text",
    note: "  use the color palette in here \r\n",
  });
  assert.equal(withNote.note, "use the color palette in here");
  const withoutNote = buildConstraintSource({ text: "x", filename: "b.pdf", kind: "pdf-text", note: "   " });
  assert.ok(!("note" in withoutNote), "blank note is omitted, not sent as empty");
});

test("constraintChipLabel summarizes count and provenance", () => {
  assert.equal(
    constraintChipLabel({ constraints: [{}, {}, {}], provenance: "brand.pdf · 12 page(s)" }),
    "3 design rules loaded from brand.pdf · 12 page(s)",
  );
  assert.equal(constraintChipLabel({ constraints: [{}], provenance: "x" }), "1 design rule loaded from x");
  assert.equal(constraintChipLabel({ constraints: [], provenance: "notes.txt" }), "No design rules found from notes.txt");
  assert.equal(constraintChipLabel(null), "");
});

test("isSupportedDesignDoc accepts pdf and txt, rejects others", () => {
  assert.ok(isSupportedDesignDoc({ name: "brand.pdf", type: "application/pdf" }));
  assert.ok(isSupportedDesignDoc({ name: "notes.txt", type: "text/plain" }));
  assert.ok(isSupportedDesignDoc({ name: "BRAND.PDF", type: "" }));
  assert.ok(!isSupportedDesignDoc({ name: "logo.png", type: "image/png" }));
  assert.ok(!isSupportedDesignDoc(null));
});

test("the accepted-doc filter advertises pdf and text", () => {
  assert.match(ACCEPTED_DESIGN_DOC, /\.pdf/);
  assert.match(ACCEPTED_DESIGN_DOC, /\.txt/);
});

test("api-client exposes a plain-JSON extractConstraints POST to /intake-constraints", async () => {
  const source = await readFile(new URL("../src/api-client.js", import.meta.url), "utf8");
  assert.match(source, /export async function extractConstraints/);
  assert.match(source, /"\/intake-constraints"/);
  // The trace panel still surfaces design-doc filtering to the author: the
  // constraint_filter phase maps to a stage and reports what was set aside.
  assert.match(source, /constraint_filter: "prioritize"/);
  assert.match(source, /set aside by your design doc/);
});

test("the review request carries constraintSet only when active rules exist", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // Both review paths (full/focused and selected-region) send the set through
  // designDocumentForEngine(), which no-ops when nothing is loaded OR the
  // author unchecked every rule in the design-rules review popup.
  const matches = source.match(/\.\.\.designDocumentForEngine\(\)/g) || [];
  assert.equal(matches.length, 2, "both streamCritique bodies must send the design document via designDocumentForEngine");
  assert.match(source, /function designDocumentForEngine\(\)/);
  assert.match(source, /function effectiveConstraintSet\(\)/);
  assert.match(source, /if \(state\.constraintSelection === null\) return set;/);
  assert.match(source, /designDocumentText/);
  assert.match(source, /constraintSet: null/);
  assert.match(source, /constraintSelection: null/);
  assert.match(source, /handleDesignDoc/);
});

test("loaded design rules open a review popup where each rule can be unchecked", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // Fresh candidates stay inactive until the author confirms the review.
  assert.match(source, /state\.constraintSelection = state\.constraintSet \? \[\] : null/);
  // ...and surfaces the review popup once rules load.
  assert.match(source, /state\.designDoc\.status === "loaded" &&\s*state\.constraintSet\?\.constraints\?\.length/);
  assert.match(source, /openConstraintReview\(\{ selectAllByDefault: true \}\)/);
  assert.match(source, /function openConstraintReview\(\{ selectAllByDefault = false \} = \{\}\)/);
  assert.match(source, /selectAllByDefault \|\| state\.constraintSelection === null/);
  assert.match(source, /rules\.map\(\(c\) => c\.id\)/);
  // The popup renders one checkbox row per rule.
  assert.match(source, /function constraintReviewRowMarkup\(constraint, checked\)/);
  assert.match(source, /class="constraint-check" data-cr-id=/);
  // Edits live on a draft and only commit on confirm, so Cancel / scrim / Escape
  // leave the active rules untouched.
  assert.match(source, /const draft = new Set\(/);
  assert.match(source, /state\.constraintSelection = kept\.length === total \? null : kept;/);
  assert.match(source, /function closeConstraintReview\(\)/);
  assert.match(source, /if \(e\.key === "Escape"\)/);
});

test("the design-rules review popup is styled as a modal", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.constraint-review \{/);
  assert.match(css, /\.constraint-row\.is-off/);
  assert.match(css, /\.design-doc-action-link/);
});

test("the design-doc control is shared by onboarding and the workspace panel", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // One markup helper, rendered in both places with distinct scopes.
  assert.match(source, /function designDocControlMarkup\(scope\)/);
  assert.match(source, /designDocControlMarkup\("onboarding"\)/);
  assert.match(source, /designDocControlMarkup\("workspace"\)/);
  // The optional author note is captured and passed to the intake source.
  assert.match(source, /function setDesignDocNote/);
  assert.match(source, /note,\n/, "handleDesignDoc forwards the note to buildConstraintSource");
});

test("upload and the steering note live in one combined uploader", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // The note field and the file input sit inside the same bordered uploader.
  assert.match(source, /class="doc-uploader"/);
  assert.match(source, /class="design-doc-note doc-note-input" disabled/);
  // The note stays disabled until a document loads (post-upload add-on).
  assert.match(source, /noteEl\.disabled = status !== "loaded"/);
});

test("the workspace context fields live in one editable text box with a single infer control", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // The old separate describe box and the three separate inputs are gone.
  assert.doesNotMatch(source, /id="contextDescribeInput"/);
  assert.doesNotMatch(source, /id="rawBriefInput"/);
  assert.doesNotMatch(source, /id="briefGoal"/);
  assert.doesNotMatch(source, /id="briefAudience"/);
  assert.doesNotMatch(source, /id="briefConstraints"/);
  // One merged container, one text box, one infer control.
  assert.match(source, /class="context-merged"/);
  assert.match(source, /id="briefContextBox"/);
  assert.match(source, /id="contextInferBtn"/);
  // The box round-trips through the parse/serialize seam into goal/audience/constraints.
  assert.match(source, /parseContextBox/);
  assert.match(source, /serializeContextBox/);
  assert.match(source, /from "\.\/context-box\.js"/);
});
