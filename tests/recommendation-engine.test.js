import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPlan,
  buildApplicationPlan,
  enrichRecommendations,
  reevaluateMock,
} from "../src/recommendation-engine.js";

function recommendation(id, kind, overrides = {}) {
  return {
    id,
    title: id,
    status: "pending",
    proposal: { kind },
    ...overrides,
  };
}

test("independent recommendations preserve selected order", () => {
  const recommendations = enrichRecommendations([
    recommendation("title", "dashboard-title"),
    recommendation("tooltip", "add-tooltip"),
  ]);
  const first = buildApplicationPlan(["title", "tooltip"], recommendations);
  const second = buildApplicationPlan(["tooltip", "title"], recommendations);

  assert.equal(first.canApply, true);
  assert.deepEqual(first.order, ["title", "tooltip"]);
  assert.deepEqual(second.order, ["tooltip", "title"]);
  assert.deepEqual(new Set(first.changedTargets), new Set(second.changedTargets));
});

test("dependencies are included and topologically ordered", () => {
  const recommendations = enrichRecommendations([
    recommendation("kpis", "add-kpis"),
    recommendation("subtitles", "chart-subtitles"),
  ]);
  const plan = buildApplicationPlan(["subtitles"], recommendations);

  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.order, ["kpis", "subtitles"]);
  assert.deepEqual(plan.dependent, ["subtitles"]);
});

test("unresolved conflicts block application", () => {
  const recommendations = enrichRecommendations([
    recommendation("multi", "v2-palette"),
    recommendation("brand", "preserve-brand-palette"),
  ]);
  const unresolved = buildApplicationPlan(["multi", "brand"], recommendations);

  assert.equal(unresolved.canApply, false);
  assert.equal(unresolved.unresolvedConflicts.length, 1);

  const key = unresolved.conflicts[0].key;
  const resolved = buildApplicationPlan(
    ["multi", "brand"],
    recommendations,
    { [key]: "brand" },
  );
  assert.equal(resolved.canApply, true);
  assert.deepEqual(resolved.order, ["brand"]);
});

test("a conflict choice cannot exclude a required dependency", () => {
  const recommendations = enrichRecommendations([
    recommendation("multi", "v2-palette"),
    recommendation("brand", "preserve-brand-palette"),
    recommendation("dependent", "manual", { dependsOn: ["brand"] }),
  ]);
  const initial = buildApplicationPlan(["multi", "brand", "dependent"], recommendations);
  const key = initial.conflicts[0].key;
  const invalid = buildApplicationPlan(
    ["multi", "brand", "dependent"],
    recommendations,
    { [key]: "multi" },
  );

  assert.equal(invalid.canApply, false);
  assert.deepEqual(invalid.missingDependencies, [
    { recommendationId: "dependent", dependencyId: "brand" },
  ]);
});

test("applyPlan mutates a clone and leaves input state unchanged", () => {
  const recommendations = enrichRecommendations([
    recommendation("title", "dashboard-title"),
  ]);
  const plan = buildApplicationPlan(["title"], recommendations);
  const original = { applied: [] };
  const result = applyPlan(plan, original, (draft, id) => {
    draft.applied.push(id);
    return true;
  });

  assert.equal(result.ok, true);
  assert.deepEqual(original, { applied: [] });
  assert.deepEqual(result.dashboardState, { applied: ["title"] });
});

test("re-evaluation reports kept, updated, removed, and added recommendations", () => {
  const recommendations = enrichRecommendations([
    recommendation("kpis", "add-kpis"),
    recommendation("subtitles", "chart-subtitles"),
    recommendation("multi", "v2-palette"),
    recommendation("brand", "preserve-brand-palette"),
    recommendation("filter", "add-cross-filter"),
    recommendation("tooltip", "add-tooltip"),
  ]);

  const result = reevaluateMock(
    recommendations,
    ["kpis", "multi", "filter"],
    ["dashboard.layout", "chart.encodings.color", "dashboard.cross-filter"],
    2,
  );

  assert.deepEqual(result.delta.updated, ["subtitles"]);
  assert.deepEqual(result.delta.removed, ["brand"]);
  assert.equal(result.delta.added.length, 1);
  assert.ok(result.delta.kept.includes("tooltip"));
  assert.equal(
    result.recommendations.find((item) => item.id === "subtitles").status,
    "updated",
  );
  const followUp = result.recommendations.find((item) =>
    item.proposal.kind === "show-filter-state");
  assert.deepEqual(followUp.dependsOn, ["filter"]);
});
