import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardMeta, SpecMap } from "../src/contracts.ts";
import { validateAppliedDashboard } from "../src/apply/validate.ts";

function board(): BoardMeta {
  return {
    canvasWidth: 1100,
    canvasHeight: 720,
    typography: { titleFontPx: 32, subtitleFontPx: 16 },
    tiles: [
      { id: "a", bounds: { x: 28, y: 96, w: 500, h: 260 } },
      { id: "b", bounds: { x: 556, y: 96, w: 516, h: 260 } },
    ],
  };
}

const specs: SpecMap = {
  a: { mark: "bar", config: { axis: { labelFontSize: 12 } } },
  b: { mark: "line", config: { axis: { labelFontSize: 12 } } },
};

test("post-apply validation rejects newly overlapping tiles", () => {
  const original = board();
  const next = structuredClone(original);
  next.tiles![1].bounds = { x: 400, y: 96, w: 516, h: 260 };
  const result = validateAppliedDashboard(original, next, specs, specs);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /overlap/);
});

test("post-apply validation rejects canvas resizing", () => {
  const original = board();
  const next = { ...structuredClone(original), canvasHeight: 900 };
  const result = validateAppliedDashboard(original, next, specs, specs);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /canvas dimensions/);
});

test("post-apply validation rejects newly extreme font imbalance", () => {
  const original = board();
  const nextSpecs = structuredClone(specs);
  nextSpecs.a.config = { axis: { labelFontSize: 4 }, title: { fontSize: 120 } };
  const result = validateAppliedDashboard(original, original, specs, nextSpecs);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /font sizes/);
});

test("post-apply validation does not block an unrelated change for a pre-existing defect", () => {
  const original = board();
  original.tiles![1].bounds = { x: 400, y: 96, w: 516, h: 260 };
  const next = structuredClone(original);
  const result = validateAppliedDashboard(original, next, specs, specs);
  assert.equal(result.ok, true);
});

test("post-apply validation rejects charts compressed into unreadable strips", () => {
  const original = board();
  const next = structuredClone(original);
  next.tiles![1].bounds = { x: 556, y: 96, w: 516, h: 110 };
  const result = validateAppliedDashboard(original, next, specs, specs);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /compressed below half/);
});

test("post-apply validation rejects a tile enlarged into a dashboard-dominating billboard", () => {
  const original = board();
  const next = structuredClone(original);
  next.tiles = [
    { id: "a", bounds: { x: 28, y: 96, w: 800, h: 600 } },
    { id: "b", bounds: { x: 850, y: 96, w: 222, h: 260 } },
  ];
  const result = validateAppliedDashboard(original, next, specs, specs);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /expands disproportionately/);
});

test("post-apply validation still permits a readable hierarchy change", () => {
  const original = board();
  const next = structuredClone(original);
  next.tiles![0].bounds = { x: 28, y: 96, w: 620, h: 320 };
  next.tiles![1].bounds = { x: 676, y: 96, w: 396, h: 260 };
  const result = validateAppliedDashboard(original, next, specs, specs);
  assert.equal(result.ok, true);
});
