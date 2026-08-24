import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PRACTICE_PRESET_VERSION,
  buildPracticeApplyResult,
  practicePresetForMaterial,
  practiceReviewResponse,
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

test("practice review responses cover full, focused, and selected-area asks", () => {
  const preset = practicePresetForMaterial("A");
  const full = practiceReviewResponse(preset, { scope: "full" });
  const focused = practiceReviewResponse(preset, { scope: "focused" });
  const bounds = { x: 10, y: 20, w: 300, h: 60 };
  const local = practiceReviewResponse(preset, { scope: "local", bounds });
  assert.equal(full.critiques.length, 3);
  assert.equal(focused.reviewScope, "focused");
  assert.equal(focused.critiques[0].proposal.kind, "edit-layout");
  assert.equal(local.reviewScope, "selected-region");
  assert.equal(local.critiques[0].proposal.kind, "dashboard-title");
  assert.deepEqual(local.critiques[0].target.ref.selectedBounds, bounds);
  assert.equal(local.model, "vizier-practice-preset");
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

test("focused layout and local title presets produce reloadable board changes", () => {
  const preset = practicePresetForMaterial("B");
  const fixture = dashboardFixture("B");
  const focused = practiceReviewResponse(preset, { scope: "focused" });
  const layout = buildPracticeApplyResult({
    critiques: focused.critiques,
    selectedIds: [focused.critiques[0].id],
    ...fixture,
  });
  assert.ok(layout.board.tiles.every((tile) => tile.id && tile.bounds));
  assert.ok(layout.changedTargets.includes("dashboard.layout"));

  const local = practiceReviewResponse(preset, {
    scope: "local",
    bounds: { x: 12, y: 14, w: 320, h: 64 },
  });
  const title = buildPracticeApplyResult({
    critiques: local.critiques,
    selectedIds: [local.critiques[0].id],
    ...fixture,
  });
  assert.equal(title.board.title, preset.local.title);
  assert.ok(title.changedTargets.includes("dashboard.title"));
});
