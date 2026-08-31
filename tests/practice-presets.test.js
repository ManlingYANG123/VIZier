import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PRACTICE_PRESET_VERSION,
  buildPracticeApplyResult,
  practicePresetForMaterial,
  practiceOverallReviewResponse,
  shouldUsePracticeOverallCache,
} from "../src/practice-presets.js";

function dashboardFixture(code) {
  const filename = code === "A"
    ? "public/study-materials/dashboards/A_garden-birds.json"
    : "public/study-materials/dashboards/B_retail-sales-command-center.json";
  const document = JSON.parse(fs.readFileSync(filename, "utf8"));
  return {
    specMap: Object.fromEntries(document.tiles.map((tile) => [tile.id, tile.spec])),
    board: {
      title: document.dashboard.title,
      tiles: document.tiles.map((tile) => ({ id: tile.id, bounds: tile.bounds })),
    },
  };
}

test("A and B practice packs expose symmetric Ask and Apply fixtures", () => {
  for (const code of ["A", "B"]) {
    const preset = practicePresetForMaterial(code);
    assert.equal(preset.materialCode, code);
    assert.ok(preset.editedContext);
    assert.notEqual(preset.editedContext, preset.context);
    assert.ok(preset.audience);
    assert.equal(preset.full.critiques.length, 3);
    assert.equal(preset.focused.request, "Should I change the layout?");
    assert.equal(preset.local.request, "Is this title clear enough?");
    assert.ok(preset.singleCritiqueId);
    assert.equal(preset.batchCritiqueIds.length, 2);
    assert.equal(preset.document.constraints.length, 2);
  }
  assert.match(PRACTICE_PRESET_VERSION, /^\d{4}-\d{2}-\d{2}\./);
});

test("A and B expose distinct pre-cached overall-review responses", () => {
  const a = practiceOverallReviewResponse(practicePresetForMaterial("A"));
  const b = practiceOverallReviewResponse(practicePresetForMaterial("B"));

  assert.equal(a.reviewScope, "full");
  assert.equal(b.reviewScope, "full");
  assert.equal(a.critiques.length, 3);
  assert.equal(b.critiques.length, 3);
  assert.equal(a.model, "vizier-practice-cache");
  assert.equal(b.model, "vizier-practice-cache");
  assert.notDeepEqual(a.critiques.map((critique) => critique.id), b.critiques.map((critique) => critique.id));
  assert.match(a.runId, /cache-a-full/);
  assert.match(b.runId, /cache-b-full/);
});

test("the Practice cache is restricted to one explicitly requested overall review", () => {
  const base = {
    practiceActive: true,
    explicitlyRequested: true,
    cacheConsumed: false,
    focusedRequest: "",
  };

  assert.equal(shouldUsePracticeOverallCache(base), true);
  assert.equal(shouldUsePracticeOverallCache({ ...base, practiceActive: false }), false);
  assert.equal(shouldUsePracticeOverallCache({ ...base, explicitlyRequested: false }), false);
  assert.equal(shouldUsePracticeOverallCache({ ...base, cacheConsumed: true }), false);
  assert.equal(shouldUsePracticeOverallCache({ ...base, focusedRequest: "Should I change the layout?" }), false);
  assert.equal(shouldUsePracticeOverallCache({ ...base, scopeCustomized: true }), false);
});

test("single and batch practice Apply mutate clones, not the dashboard fixture", () => {
  for (const code of ["A", "B"]) {
    const preset = practicePresetForMaterial(code);
    const fixture = dashboardFixture(code);
    const before = structuredClone(fixture);
    const single = buildPracticeApplyResult({
      critiques: preset.full.critiques,
      selectedIds: [preset.singleCritiqueId],
      ...fixture,
    });
    assert.deepEqual(fixture, before);
    assert.deepEqual(single.applicationOrder, [preset.singleCritiqueId]);
    assert.ok(single.changedTargets.length >= 1);

    const batch = buildPracticeApplyResult({
      critiques: preset.full.critiques,
      selectedIds: preset.batchCritiqueIds,
      ...fixture,
    });
    assert.deepEqual(batch.applicationOrder, preset.batchCritiqueIds);
    assert.ok(batch.changedTargets.length >= 2);
    assert.deepEqual(fixture, before);
  }
});

test("the prepared focused layout fixture still produces a reloadable board change", () => {
  const preset = practicePresetForMaterial("B");
  const fixture = dashboardFixture("B");
  const layout = buildPracticeApplyResult({
    critiques: preset.focused.critiques,
    selectedIds: [preset.focused.critiques[0].id],
    ...fixture,
  });
  assert.ok(layout.board.tiles.every((tile) => tile.id && tile.bounds));
  assert.ok(layout.changedTargets.includes("dashboard.layout"));
});
