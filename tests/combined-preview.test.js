import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = () => readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styleSource = () => readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("Overall Review does not change the canvas or force a review mode", async () => {
  const source = await appSource();

  assert.match(source, /Overall Review only produces recommendations/);
  assert.match(source, /if \(attemptedScope === "full" && state\.batchMode\) await setBatchMode\(false\)/);
  assert.doesNotMatch(source, /startAutomaticCombinedPreview/);
});

test("a combined preview is validated again after the browser renders it", async () => {
  const source = await appSource();

  assert.match(source, /function renderedBatchPreviewErrors\(\)/);
  assert.match(source, /The dashboard heading overlaps the KPI summary/);
  assert.match(source, /rendered without visible data or narrative content/);
  assert.match(source, /has labels clipped outside its chart frame/);
  assert.match(source, /await afterDashboardPaint\(\)/);
  assert.match(source, /state\.batchPreviewValidated = true;\s*if \(renderBar\)/);
  assert.match(source, /state\.batchPreviewEnabled = false;[\s\S]{0,220}?await clearBatchPreview\(\)/);
});

test("Preview is explicit and Apply uses the exact reviewed subset shown on canvas", async () => {
  const source = await appSource();

  assert.match(source, /batchPreviewEnabled: false/);
  assert.match(source, /id="batchPreviewToggle"[\s\S]*?role="switch"[\s\S]*?aria-checked="false"/);
  assert.match(source, /state\.batchPreviewEnabled = !state\.batchPreviewEnabled/);
  assert.match(source, /largestCompatibleSelection\(selectedIds, state\.critiques\)/);
  assert.match(source, /state\.batchPreviewIds = new Set\(outcome\.previewedIds\)/);
  assert.match(source, /const selectedIds = state\.batchPreviewValidated\s*\? \[\.\.\.state\.batchPreviewIds\]/);
  assert.match(source, /batchReviewedIds: new Set\(\)/);
  assert.match(source, /const reviewedCount = reviewIds\.filter/);
  assert.match(source, /Review next \(\$\{reviewedCount\}\/\$\{previewCount\}\)/);
  assert.match(source, /selectedIds\.some\(\(id\) => !state\.batchReviewedIds\.has\(id\)\)/);
  assert.match(source, /state\.batchReviewedIds\.add\(critique\.id\)/);
});

test("multi-selection remains flexible and checkbox based", async () => {
  const source = await appSource();

  assert.match(source, /<span>Select multiple<\/span>/);
  assert.match(source, /role="checkbox" aria-checked/);
  assert.match(source, /if \(state\.batchSelection\.has\(critique\.id\)\) state\.batchSelection\.delete/);
  assert.match(source, /id="batchSelectAllButton"[\s\S]*?>Select all<\/button>/);
  assert.match(source, /id="batchClearButton"[\s\S]*?>Clear all<\/button>/);
  assert.match(source, /Apply \$\{previewCount\} previewed/);
  assert.match(source, /Keep & Review Next/);
  assert.match(source, /Finish Review/);
  assert.match(source, /Not in preview/);
});

test("combined preview has a prominent temporary banner and a blue ON state", async () => {
  const [source, styles] = await Promise.all([appSource(), styleSource()]);

  assert.match(source, /id="combinedPreviewBanner"[\s\S]*?PREVIEW MODE[\s\S]*?Temporary · Nothing applied/);
  assert.match(source, /selected changes shown · Nothing applied/);
  assert.match(source, /combinedBanner\.hidden = !combinedPreviewVisible/);
  assert.match(styles, /\.combined-preview-banner \{[\s\S]*?background: #e7f0ff/);
  assert.match(styles, /\.batch-preview-toggle\.is-on \.batch-preview-switch-track \{ border-color: #2f6bd8; background: #2f6bd8; \}/);
});

test("review navigation restores the validated combined preview without recomputing", async () => {
  const [source, styles] = await Promise.all([appSource(), styleSource()]);

  assert.match(source, /batchCanvasPreview: null/);
  assert.match(source, /function cachedBatchPreviewIsCurrent\(\)/);
  assert.match(source, /state\.canvasPreview = restoreCombinedRevision && cachedBatchPreviewIsCurrent\(\)/);
  assert.match(source, /Only a real[\s\S]*selection\/spec\/version change earns another engine round-trip/);
  assert.doesNotMatch(source, /id="batchReviewProgress"/);
  assert.doesNotMatch(source, /function renderBatchReviewProgress\(\)/);
  assert.match(source, /const focusDocked = Boolean\(state\.batchMode && state\.selectedCritiqueId\)/);
  assert.match(source, /desiredHost\.appendChild\(bar\)/);
  assert.doesNotMatch(source, /\$\{batchReviewProgressMarkup\(critique\.id\)\}/);
  assert.match(source, /applyButton\.style\.setProperty\([\s\S]*?"--batch-review-progress"/);
  assert.match(source, /Review next \(\$\{reviewedCount\}\/\$\{previewCount\}\)/);
  assert.match(source, /Keep & Review Next/);
  assert.match(source, /await openCritiqueDetail\(nextCritique\)/);
  assert.match(source, /UPDATING PREVIEW/);
  assert.match(source, /Your current dashboard remains unchanged/);
  assert.match(styles, /#batchApplyButton\[data-action="review"\]::before/);
  assert.match(styles, /transform: scaleX\(var\(--batch-review-progress, 0\)\)/);
  assert.doesNotMatch(styles, /\.batch-review-progress \{/);
  assert.match(styles, /\.batch-apply-bar\.focus-docked \{/);
  assert.match(styles, /\.combined-preview-banner\.is-updating \{/);
});

test("combined preview computation visibly occupies the canvas without implying an apply", async () => {
  const [source, styles] = await Promise.all([appSource(), styleSource()]);

  assert.match(source, /id="canvasPreviewUpdating"[\s\S]*?Updating preview[\s\S]*?Nothing applied/);
  assert.match(source, /class="preview-bouncing-dots"[\s\S]*?<i><\/i><i><\/i><i><\/i>/);
  assert.match(source, /updatingOverlay\.hidden = !state\.batchPreviewPending/);
  assert.match(source, /Combining \$\{count\} selected/);
  assert.match(source, /canvasViewport\.setAttribute\("aria-busy", String\(state\.batchPreviewPending\)\)/);
  assert.match(styles, /\.canvas-preview-updating \{[\s\S]*?background: rgb\(232 235 241 \/ 62%\)/);
  assert.match(styles, /\.canvas-preview-updating-card \{/);
  assert.match(styles, /@keyframes preview-dot-bounce/);
  assert.match(styles, /\.batch-preview-status \{[\s\S]*?background: var\(--brand-soft\)/);
});

test("excluded selections remain checked and receive a visible recovery path", async () => {
  const [source, styles] = await Promise.all([appSource(), styleSource()]);

  assert.match(source, /id="batchExclusionNotice"[\s\S]*?Show excluded/);
  assert.match(source, /state\.batchPreviewExcluded = new Map\(outcome\.excluded/);
  assert.match(source, /async function recoverEngineBatchPreview\(selectedIds, token\)/);
  assert.match(source, /async function recoverRenderedBatchPreview\(selectedIds, initialOutcome, baselineErrors, token\)/);
  assert.match(source, /const baselineErrors = renderedBatchPreviewErrors\(\)/);
  assert.match(source, /batchChecked[\s\S]*?batchExcluded/);
  assert.match(styles, /\.batch-exclusion-notice \{/);
  assert.match(styles, /\.critique-list-view \.critique-card\.batch-checked\.batch-excluded/);
  assert.doesNotMatch(styles, /\.batch-exclusion-notice \{[\s\S]{0,360}?#fff8e8/);
});

test("solution alternatives remain on demand through Refine Solution", async () => {
  const source = await appSource();

  assert.match(source, /id="focusRefineSolution"/);
  assert.match(source, /critiqueSolutionRefinementRequest\(critique, rationale, \{/);
  assert.match(source, /id="refinementChoices"/);
  assert.match(source, /allowPracticePreset: false/);
});
