import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = () => readFile(new URL("../src/app.js", import.meta.url), "utf8");

test("a full review opens an uncommitted, quality-gated combined preview", async () => {
  const source = await appSource();

  assert.match(source, /if \(attemptedScope === "full"\) \{\s*await startAutomaticCombinedPreview\(\)/);
  assert.match(source, /async function startAutomaticCombinedPreview\(\)/);
  assert.match(source, /let finalOutcome = safeIds\.length \? await validateCandidate\(safeIds\) : null/);
  assert.match(source, /for \(const critiqueId of structurallySafe\)/);
  assert.match(source, /committed: false/);
  assert.match(source, /Nothing is applied yet\./);
});

test("a combined preview is validated again after the browser renders it", async () => {
  const source = await appSource();

  assert.match(source, /function renderedBatchPreviewErrors\(\)/);
  assert.match(source, /The dashboard heading overlaps the KPI summary/);
  assert.match(source, /rendered without visible data or narrative content/);
  assert.match(source, /has labels clipped outside its chart frame/);
  assert.match(source, /await afterDashboardPaint\(\)/);
  assert.match(source, /state\.batchPreviewValidated = true;\s*if \(renderBar\)/);
  assert.match(source, /await clearBatchPreview\(\);\s*if \(renderBar\)/);
});

test("automatic retries use the committed dashboard and require rendered validation", async () => {
  const source = await appSource();

  assert.match(source, /const source = \{\s*specMap: buildEngineSpecMap\(\),\s*board: buildEngineBoardMeta\(\)/);
  assert.match(source, /const outcome = await computeBatchPreview\(ids, source\)/);
  assert.match(source, /const presentation = await presentBatchPreview\(outcome, \{ renderBar: false \}\)/);
  assert.match(source, /if \(presentation\.ok\) return outcome/);
});

test("a combined revision requires explicit critique review before Apply", async () => {
  const source = await appSource();

  assert.match(source, /batchReviewedIds: new Set\(\)/);
  assert.match(source, /Review combined changes/);
  assert.match(source, /Review next \(\$\{reviewedIds\.length\}\/\$\{count\}\)/);
  assert.match(source, /Apply \$\{count\} reviewed/);
  assert.match(source, /state\.batchReviewedIds\.add\(critique\.id\)/);
  assert.match(source, /selectedIds\.some\(\(id\) => !state\.batchReviewedIds\.has\(id\)\)/);
  assert.match(source, /const omitted = plan\.requested\.filter\(\(id\) => !appliedIds\.has\(id\)\)/);
  assert.match(source, /resolvedPlan\?\.canApply && state\.batchPreviewValidated/);
  assert.match(source, /state\.batchPreviewFailure = reason/);
  assert.match(source, /clearButton\.hidden = isCuratedRevision/);
  assert.match(source, /selectAllButton\.hidden = isCuratedRevision/);
  assert.doesNotMatch(source, /you can still apply the selection/);
});

test("excluded critiques stay visible with a reason and a refinement path", async () => {
  const source = await appSource();

  assert.match(source, /Not in this revision/);
  assert.match(source, /batchExclusionReason\(critique\.id\)/);
  assert.match(source, /The issue is still valid/);
  assert.match(source, /Add rationale and refine the solution/);
  assert.match(source, /excludedIds: finalExcludedIds/);
  assert.match(source, /exclusionReasons/);
  assert.match(source, /id="focusRefineSolution"/);
});

test("revision cards open critique evidence instead of toggling checkboxes", async () => {
  const source = await appSource();

  assert.match(source, /Cards always open their diagnosis\/evidence\/solution detail/);
  assert.match(source, /await openCritiqueDetail\(critique\)/);
  assert.doesNotMatch(source, /role="checkbox" aria-checked/);
  assert.doesNotMatch(source, /if \(state\.batchSelection\.has\(critique\.id\)\) state\.batchSelection\.delete/);
});
