import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProposals } from "../src/apply/index.ts";
import { reevaluate } from "../src/reevaluate.ts";
import { runDetectors } from "../src/detect/index.ts";
import { dashboardSpecMap } from "../fixtures/specs.ts";
import { critiquesFixture } from "./helpers.ts";
import type { Critique } from "../src/contracts.ts";

test("applying cross-filter resolves it and introduces the show-filter-state follow-up", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const cf = critiques.find((c) => c.proposal.kind === "add-cross-filter")!;
  const outcome = await applyProposals(specMap, critiques, [cf.id]);

  const result = reevaluate(critiques, [cf.id], outcome.specMap, outcome.changedTargets);
  assert.ok(result.delta.added.includes("c-show-filter-state"));
  const resolved = result.critiques.find((c) => c.id === cf.id);
  assert.equal(resolved?.status, "resolved");
});

test("the show-filter-state follow-up carries an applyable source tile", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const cf = critiques.find((c) => c.proposal.kind === "add-cross-filter")!;
  const outcome = await applyProposals(specMap, critiques, [cf.id]);

  const result = reevaluate(critiques, [cf.id], outcome.specMap, outcome.changedTargets);
  const followUp = result.critiques.find((c) => c.id === "c-show-filter-state")!;
  // The follow-up must resolve to the cross-filter source so applyShowFilterState
  // has a concrete tile to stamp; otherwise applying it throws APPLY_NO_CHANGE.
  assert.equal(followUp.target.ref.source, cf.target.ref.source);
  assert.equal(followUp.tileId, cf.target.ref.source);

  // Applying the follow-up on the mutated map produces a real change.
  const applied = await applyProposals(outcome.specMap, [followUp], [followUp.id]);
  assert.equal(applied.rollback.rolledBack, false);
  assert.deepEqual(applied.changedTargets, [cf.target.ref.source]);
  const source = String(cf.target.ref.source);
  assert.equal(
    (applied.specMap[source].usermeta as Record<string, unknown>).activeFilterState,
    true,
  );
});

test("the follow-up resolves the source from usermeta when the applied ref is unavailable", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const cf = critiques.find((c) => c.proposal.kind === "add-cross-filter")!;
  const outcome = await applyProposals(specMap, critiques, [cf.id]);

  // Simulate a caller that lost the original critique ref (e.g. only ids echoed
  // back). The follow-up must still find the source via the stamped usermeta.
  const stripped = critiques.map((c) =>
    c.id === cf.id
      ? { ...c, target: { granularity: c.target.granularity, ref: {} } }
      : c
  );
  const result = reevaluate(stripped, [cf.id], outcome.specMap, outcome.changedTargets);
  const followUp = result.critiques.find((c) => c.id === "c-show-filter-state")!;
  assert.equal(followUp.target.ref.source, cf.target.ref.source);
});

test("re-running reevaluate does not duplicate the follow-up", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const cf = critiques.find((c) => c.proposal.kind === "add-cross-filter")!;
  const outcome = await applyProposals(specMap, critiques, [cf.id]);
  const first = reevaluate(critiques, [cf.id], outcome.specMap, outcome.changedTargets);
  const second = reevaluate(first.critiques, [cf.id], outcome.specMap, outcome.changedTargets);
  assert.equal(second.delta.added.length, 0);
});

test("a consolidated multi-tile critique is marked updated when a sibling tile changes", async () => {
  const specMap = dashboardSpecMap();
  // A consolidated interpretive critique: representative tile task-velocity plus
  // sibling department-tasks, both listed in target.ref.tiles. It carries no
  // detector refs, so it takes the interpretive "updated" path (never wrongly
  // resolved or left stale) when any member tile changes.
  const consolidated = {
    id: "c-consolidated",
    tileId: "task-velocity",
    status: "pending",
    proposal: { kind: "add-tooltip", mode: "executable" },
    evidenceRefs: [{
      source: "dashboard",
      path: "tile.task-velocity",
      detail: "The consolidated hover fix spans several tiles.",
    }],
    target: {
      granularity: "chart",
      ref: { tile: "task-velocity", tiles: ["task-velocity", "department-tasks"] },
    },
  } as unknown as Critique;
  // Only the SIBLING (not the representative) changed. Without ref.tiles in the
  // targetIds set the card would be left stale; the fix marks it updated.
  const result = reevaluate([consolidated], [], specMap, ["department-tasks"]);
  const updated = result.critiques.find((c) => c.id === "c-consolidated");
  assert.equal(updated?.status, "updated");
  assert.ok(result.delta.updated.includes("c-consolidated"));
});

test("a consolidated add-tooltip is only 'resolved' when every listed tile actually changed", async () => {
  // The card spans a field-bearing chart and a field-less KPI. Applying it changes
  // only the chart (the KPI no-ops), so the fix did NOT land on every listed tile.
  // Even though the card's id is in the applied set, reevaluate must mark it
  // 'updated' (kept surfaced for re-review) rather than falsely 'resolved' on a
  // tile it never touched.
  const partialMap = {
    chart: {
      data: { values: [{ label: "A", value: 3 }] },
      mark: "bar",
      encoding: { x: { field: "label", type: "nominal" }, y: { field: "value", type: "quantitative" } },
    },
    kpi: {
      data: { values: [{ total: 42 }] },
      mark: { type: "text" },
      encoding: { text: { value: "42" } },
    },
  } as unknown as ReturnType<typeof dashboardSpecMap>;
  const partialCard = {
    id: "c-consolidated-partial",
    tileId: "chart",
    status: "pending",
    proposal: { kind: "add-tooltip", mode: "executable" },
    evidenceRefs: [{ source: "dashboard", path: "tile.chart", detail: "One hover fix across two tiles." }],
    target: { granularity: "chart", ref: { tile: "chart", tiles: ["chart", "kpi"] } },
  } as unknown as Critique;
  const partial = await applyProposals(partialMap, [partialCard], [partialCard.id]);
  assert.deepEqual(new Set(partial.changedTargets), new Set(["chart"]));
  // applicationOrder carries the id because the fix DID change at least one tile.
  assert.deepEqual(partial.applicationOrder, ["c-consolidated-partial"]);
  const partialResult = reevaluate([partialCard], partial.applicationOrder, partial.specMap, partial.changedTargets);
  const reeval = partialResult.critiques.find((c) => c.id === "c-consolidated-partial");
  assert.equal(reeval?.status, "updated");
  assert.ok(partialResult.delta.updated.includes("c-consolidated-partial"));

  // Control: when BOTH listed tiles are field-bearing and change, the same shape
  // of card resolves fully — the guard only downgrades genuine partial application.
  const fullMap = {
    chart: {
      data: { values: [{ label: "A", value: 3 }] },
      mark: "bar",
      encoding: { x: { field: "label", type: "nominal" }, y: { field: "value", type: "quantitative" } },
    },
    chart2: {
      data: { values: [{ label: "B", value: 5 }] },
      mark: "bar",
      encoding: { x: { field: "label", type: "nominal" }, y: { field: "value", type: "quantitative" } },
    },
  } as unknown as ReturnType<typeof dashboardSpecMap>;
  const fullCard = {
    ...partialCard,
    id: "c-consolidated-full",
    target: { granularity: "chart", ref: { tile: "chart", tiles: ["chart", "chart2"] } },
  } as unknown as Critique;
  const full = await applyProposals(fullMap, [fullCard], [fullCard.id]);
  assert.deepEqual(new Set(full.changedTargets), new Set(["chart", "chart2"]));
  const fullResult = reevaluate([fullCard], full.applicationOrder, full.specMap, full.changedTargets);
  assert.equal(fullResult.critiques.find((c) => c.id === "c-consolidated-full")?.status, "resolved");
});

test("applying every interaction fix resolves the interaction findings", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const ids = critiques.map((c) => c.id);
  const outcome = await applyProposals(specMap, critiques, ids);
  const result = reevaluate(critiques, ids, outcome.specMap, outcome.changedTargets);
  // Each applied interaction critique is marked resolved...
  assert.ok(critiques.every((c) => result.critiques.find((r) => r.id === c.id)?.status === "resolved"));
  // ...and no interaction gap remains in the mutated spec map.
  const interactionLeft = runDetectors(outcome.specMap).filter((f) => f.dimension === "interaction");
  assert.equal(interactionLeft.length, 0);
});
