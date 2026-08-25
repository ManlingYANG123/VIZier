import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../src/app.js", import.meta.url), "utf8");
const readStyles = () => readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("fixable critiques offer accept, rationale-required refinement, and issue rejection in one row", async () => {
  const source = await readApp();
  const styles = await readStyles();

  assert.match(source, /<footer class="focus-actions">/);
  assert.match(source, /id="focusRefineSolution"/);
  assert.match(source, /<span>Refine Solution<\/span>/);
  assert.match(source, /"Reject Issue"/);
  assert.match(source, /What should change about this solution\?/);
  assert.match(source, /Generate Another Fix/);
  assert.match(source, /refiningSolution && !ta\.value\.trim\(\)/);
  assert.match(source, /critiqueSolutionRefinementRequest\(critique, refinementRationale\)/);
  assert.match(source, /solutionRefinementAlignment\(critique, replacement, refinementRationale\)/);
  assert.match(source, /state\.batchReviewedIds instanceof Set/);
  assert.match(source, /if \(refreshCombinedPreview\) await refreshBatchPreview\(\)/);
  assert.match(styles, /\.focus-actions:has\(#focusRefineSolution\)\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.focus-action\.refine/);
});

test("solution generation can be closed and ignores a late response", async () => {
  const source = await readApp();

  assert.doesNotMatch(source, /close\.disabled = true/);
  assert.doesNotMatch(source, /contextInput"\)\?\.disabled\) return/);
  assert.match(source, /const requestToken = \+\+state\.refinementRequestToken/);
  assert.match(source, /isCancelled: \(\) => requestToken !== state\.refinementRequestToken/);
  assert.match(source, /if \(isCancelled\(\)\) return "cancelled"/);
  assert.match(source, /close this window to cancel this attempt/);
});

test("guidance critiques keep their existing decision and rationale actions without solution refinement", async () => {
  const source = await readApp();

  assert.match(source, /canAcceptGuidance \? "Mark as Considered" : "Accept Change"/);
  assert.match(source, /critiqueIsExecutable\(critique\) \? "" : `[\s\S]*?id="focusAddContext"/);
  assert.match(source, /critiqueIsExecutable\(critique\) \? "Reject Issue" : "Reject"/);
});
