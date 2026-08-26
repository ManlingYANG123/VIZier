import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../src/app.js", import.meta.url), "utf8");
const readStyles = () => readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("fixable critiques offer accept, rationale-required refinement, and issue rejection in one row", async () => {
  const source = await readApp();
  const styles = await readStyles();

  assert.match(source, /<footer class="focus-actions\$\{backgroundRefreshActive \? " is-updating" : ""\}"/);
  assert.match(source, /id="focusRefineSolution"/);
  assert.match(source, /<span>Refine Solution<\/span>/);
  assert.match(source, /"Reject Issue"/);
  assert.match(source, /What should change about this solution\?/);
  assert.match(source, /Generate Alternative\(s\)/);
  assert.match(source, /function setRefineSolutionGenerating\(/);
  assert.match(source, /setRefineSolutionGenerating\(true\)/);
  assert.match(source, /class="focus-action refine\$\{state\.solutionRefinementRunning \? " is-generating" : ""\}"/);
  assert.match(source, /refiningSolution && !ta\.value\.trim\(\)/);
  assert.match(source, /critiqueSolutionRefinementRequest\(critique, rationale, \{/);
  assert.match(source, /solutionRefinementAlignment\(critique, replacement, rationale\)/);
  assert.match(source, /solutionRefinementCandidateMatches\(critique, replacement\)/);
  assert.match(source, /previewResults: viable\.map/);
  assert.match(source, /pending\.previewResults\?\.\[index\]/);
  assert.match(source, /if \(refreshCombinedPreview\) await refreshBatchPreview\(\)/);
  assert.match(styles, /\.focus-actions:has\(#focusRefineSolution\)\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.focus-action\.refine/);
  assert.match(styles, /\.focus-action\.refine\.is-generating::before/);
});

test("refinement generates alternatives, then waits for confirmation", async () => {
  const [source, styles] = await Promise.all([readApp(), readStyles()]);

  assert.match(source, /REFINEMENT_ALTERNATIVE_STRATEGIES = \[/);
  assert.match(source, /joint: true/);
  assert.match(source, /allowPracticePreset: false/);
  assert.match(source, /id="refinementChoices"[\s\S]*?aria-label="Alternative solutions"/);
  assert.match(source, /Option \$\{index \+ 1\}/);
  assert.match(source, /Choose this fix/);
  assert.match(source, /previewRefinementAlternative\(/);
  assert.match(source, /commitRefinementAlternative\(/);
  assert.match(source, /viable\.length >= 1/);
  assert.match(styles, /\.refinement-choice:has\(input:checked\)/);
  assert.match(styles, /\.context-modal\[data-intent="refine-solution"\]/);
});

test("solution generation can be closed and ignores a late response", async () => {
  const source = await readApp();

  assert.doesNotMatch(source, /close\.disabled = true/);
  assert.doesNotMatch(source, /contextInput"\)\?\.disabled\) return/);
  assert.match(source, /const requestToken = \+\+state\.refinementRequestToken/);
  assert.match(source, /isCancelled: \(\) => requestToken !== state\.refinementRequestToken/);
  assert.match(source, /if \(isCancelled\(\)\) return "cancelled"/);
  assert.match(source, /You can close this window to cancel this attempt/);
});

test("focused engine requests distinguish author asks, stale refreshes, and solution refinements", async () => {
  const source = await readApp();
  assert.match(source, /focusPurpose:\s*"solution-refinement"/);
  assert.match(source, /focusPurpose:\s*"stale-refresh"/);
  assert.match(source, /purpose:\s*options\.focusPurpose\s*\|\|\s*"author-request"/);
});

test("the refinement popover opens by its trigger", async () => {
  const [source, styles] = await Promise.all([readApp(), readStyles()]);

  assert.match(source, /if \(anchorRect\) \{/);
  assert.match(styles, /\.rationale-popover-head \{[\s\S]*?cursor: grab/);
  assert.match(styles, /\.context-modal\.is-dragging \.rationale-popover-head \{ cursor: grabbing; \}/);
});

test("guidance critiques keep their existing decision and rationale actions without solution refinement", async () => {
  const source = await readApp();

  assert.match(source, /canAcceptGuidance \? "Mark as Considered" : "Accept Change"/);
  assert.match(source, /critiqueIsExecutable\(critique\) \? "" : `[\s\S]*?id="focusAddContext"/);
  assert.match(source, /critiqueIsExecutable\(critique\) \? "Reject Issue" : "Reject"/);
});
