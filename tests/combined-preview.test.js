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
  assert.match(source, /Nothing applied\./);
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

test("Apply previewed stays disabled until the exact selection validates", async () => {
  const source = await appSource();

  assert.match(source, /<span>Apply previewed<\/span>/);
  assert.match(source, /const omitted = plan\.requested\.filter\(\(id\) => !appliedIds\.has\(id\)\)/);
  assert.match(source, /resolvedPlan\?\.canApply && state\.batchPreviewValidated/);
  assert.match(source, /state\.batchPreviewFailure = reason/);
  assert.doesNotMatch(source, /you can still apply the selection/);
});
