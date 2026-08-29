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
  assert.match(source, /critiqueSolutionRefinementRequest\(critique, direction, \{/);
  assert.match(source, /solutionRefinementAlignment\(critique, replacement, direction\)/);
  assert.match(source, /solutionRefinementCandidateMatches\(critique, replacement\)/);
  assert.match(source, /previewResults: viable\.map/);
  assert.match(source, /pending\.previewResults\?\.\[index\]/);
  assert.match(source, /if \(refreshCombinedPreview\) await refreshBatchPreview\(\)/);
  assert.match(styles, /\.focus-actions:has\(#focusRefineSolution\)\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.focus-action\.refine/);
  assert.match(styles, /\.focus-action\.refine\.is-generating::before/);
});

test("refinement directions stay transient and never become saved rationale", async () => {
  const source = await readApp();
  const transientBranch = source.indexOf("A refinement direction is an ephemeral generation instruction");
  const rationaleWrite = source.indexOf("state.rationales = upsertCritiqueRationale");
  const recoverableCache = source.match(
    /state\.lastRefinementBatch = \{\n    critiqueId: critique\.id,[\s\S]*?\n  \};/,
  )?.[0] || "";

  assert.ok(transientBranch >= 0);
  assert.ok(rationaleWrite > transientBranch);
  assert.match(source, /refinementDirection: text/);
  assert.doesNotMatch(source, /refinementRationale/);
  assert.doesNotMatch(source, /state\.rationaleEditId = rationale\.id/);
  assert.match(recoverableCache, /alternatives: clone\(safeAlternatives\)/);
  assert.doesNotMatch(recoverableCache, /direction/);
  assert.match(source, /function refinementAlternativeSnapshot\(alternative\)/);
  assert.doesNotMatch(
    source.match(/function refinementAlternativeSnapshot[\s\S]*?\n}/)?.[0] || "",
    /reviewRequest|requestContract/,
  );
});

test("refinement options preview on selection and commit only through an explicit action", async () => {
  const [source, styles] = await Promise.all([readApp(), readStyles()]);

  assert.match(source, /REFINEMENT_ALTERNATIVE_STRATEGIES = \[/);
  assert.match(source, /joint: true/);
  assert.match(source, /usePracticeOverallCache: false/);
  assert.match(source, /id="refinementChoices"[\s\S]*?aria-label="Alternative solutions"/);
  assert.match(source, /Option \$\{index \+ 1\}/);
  assert.match(source, /previewRefinementAlternative\(/);
  assert.match(source, /submit\.textContent = "Use Selected Solution"/);
  assert.match(source, /Option \$\{selectedIndex \+ 1\} is previewed on the canvas/);
  assert.match(source, /commitRefinementAlternative\(/);
  assert.match(source, /closeContextModal\(\{ cancelPending: false \}\)/);
  assert.match(source, /document\.getElementById\("focusAccept"\)\?\.focus\(\)/);
  assert.match(source, /previewResult: pendingAlternatives\.previewResults\?\.\[selectedIndex\]/);
  assert.match(source, /applied: false/);
  assert.doesNotMatch(source, /Choose this fix/);
  assert.match(source, /viable\.length >= 1/);
  assert.match(styles, /\.refinement-choice:has\(input:checked\)/);
  assert.match(styles, /\.refinement-choice input::before/);
  assert.match(styles, /\.refinement-choice input:checked::before/);
  assert.match(styles, /\.context-modal\[data-intent="refine-solution"\]/);
});

test("generated alternatives can be reopened without regenerating or reviving their prompt", async () => {
  const [source, styles] = await Promise.all([readApp(), readStyles()]);

  assert.match(source, /lastRefinementBatch: null/);
  assert.match(source, /function recoverableRefinementBatch\(critique\)/);
  assert.match(source, /batch\.dashboardVersion !== state\.version/);
  assert.match(source, /batch\.critiqueRevision !== \(Number\(critique\.revision\) \|\| 1\)/);
  assert.match(source, /id="focusReviewAlternatives"/);
  assert.match(source, /Review generated alternatives \(\$\{refinementBatch\.alternatives\.length\}\)/);
  assert.match(source, /reopenRefinementAlternatives\(critique, batch, event\.currentTarget\)/);
  assert.match(source, /renderRefinementAlternatives\(critique, batch\.alternatives, "", batch\)/);
  assert.match(source, /state\.lastRefinementBatch = null;[\s\S]*?state\.previewCache\.clear\(\)/);
  assert.match(source, /function contextModalReturnTarget\(\)/);
  assert.match(styles, /\.focus-action-link:focus-visible/);
});

test("solution generation can be closed and ignores a late response", async () => {
  const source = await readApp();

  assert.doesNotMatch(source, /close\.disabled = true/);
  assert.doesNotMatch(source, /contextInput"\)\?\.disabled\) return/);
  assert.match(source, /const requestToken = \+\+state\.refinementRequestToken/);
  assert.match(source, /state\.refinementAbortController\?\.abort\(\)/);
  assert.match(source, /signal: abortController\.signal/);
  assert.match(source, /isCancelled: \(\) => requestToken !== state\.refinementRequestToken/);
  assert.match(source, /if \(isCancelled\(\)\) return "cancelled"/);
  assert.match(source, /close this window to cancel/);
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
