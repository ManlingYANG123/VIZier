import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = () => readFile(new URL("../src/app.js", import.meta.url), "utf8");

test("a full review opens an uncommitted, quality-gated combined preview", async () => {
  const source = await appSource();

  assert.match(source, /if \(attemptedScope === "full"\) \{\s*await startAutomaticCombinedPreview\(\)/);
  assert.match(source, /async function startAutomaticCombinedPreview\(\)/);
  assert.match(source, /let finalOutcome = safeIds\.length \? await computeBatchPreview\(safeIds\) : null/);
  assert.match(source, /for \(const critiqueId of structurallySafe\)/);
  assert.match(source, /committed: false/);
  assert.match(source, /Nothing applied\./);
});

test("Apply previewed stays disabled until the exact selection validates", async () => {
  const source = await appSource();

  assert.match(source, /<span>Apply previewed<\/span>/);
  assert.match(source, /const omitted = plan\.requested\.filter\(\(id\) => !appliedIds\.has\(id\)\)/);
  assert.match(source, /resolvedPlan\?\.canApply && state\.batchPreviewValidated/);
  assert.match(source, /state\.batchPreviewFailure = reason/);
  assert.doesNotMatch(source, /you can still apply the selection/);
});
