import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeDashboard,
  critiqueEditPaths,
  isLayoutComposition,
  jaccard,
  recommendationKey,
} from "./metrics.mjs";

test("Jaccard handles identical empty and partially overlapping sets", () => {
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
});

test("recommendation identity prefers catalog leaf and has a deterministic fallback", () => {
  assert.equal(recommendationKey({ recommendation: "Show exact values" }), "leaf:show exact values");
  assert.equal(
    recommendationKey({ object: "axis", problem: "hard to read", dimension: "chart" }),
    "uncatalogued:axis|hard to read|chart",
  );
});

test("edit paths include explicit and canonical board paths", () => {
  assert.deepEqual(
    critiqueEditPaths({ tileId: "trend", proposal: { kind: "edit-spec", edits: [{ op: "set", path: ["encoding", "x", "sort"] }] } }),
    ["trend:spec.encoding.x.sort"],
  );
  assert.deepEqual(
    critiqueEditPaths({ proposal: { kind: "dashboard-title" } }),
    ["dashboard:board.title"],
  );
});

test("layout-composition classifier catches reflow and KPI composition", () => {
  assert.equal(isLayoutComposition({ proposal: { kind: "edit-layout" } }), true);
  assert.equal(isLayoutComposition({ proposal: { kind: "add-kpis" } }), true);
  assert.equal(isLayoutComposition({ proposal: { kind: "add-tooltip" } }), false);
});

test("stability is the equal-weight mean of the three disclosed components", () => {
  const critique = (id) => ({
    id,
    recommendation: "same-leaf",
    tileId: "chart",
    proposal: { kind: "edit-spec", mode: "executable", edits: [{ op: "set", path: ["encoding", "x", "sort"] }] },
  });
  const runs = [1, 2].map((runNumber) => ({ dashboardCode: "A", runNumber, response: { critiques: [critique(`c${runNumber}`)] } }));
  const result = analyzeDashboard(runs);
  assert.equal(result.withinDashboard.stabilityIndex, 1);
  assert.equal(result.executable.ratio, 1);
});

