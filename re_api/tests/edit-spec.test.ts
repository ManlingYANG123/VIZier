import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySpecEdits,
  editIsSafe,
  realFieldsOf,
  safeSpecEdits,
} from "../src/apply/editSpec.ts";
import { applyProposals } from "../src/apply/index.ts";
import { compileSpecMap } from "../src/apply/validate.ts";
import type { Critique } from "../src/contracts.ts";

function barTile() {
  return {
    data: { values: [{ region: "East", sales: 10 }, { region: "West", sales: 14 }] },
    mark: "bar",
    encoding: {
      x: { field: "region", type: "nominal" },
      y: { field: "sales", type: "quantitative" },
    },
  };
}

test("realFieldsOf collects encoded and inline-data fields", async () => {
  const fields = realFieldsOf(barTile());
  assert.ok(fields.has("region"));
  assert.ok(fields.has("sales"));
  assert.equal(fields.has("profit"), false);
});

test("editIsSafe accepts a targeted set on a real channel", async () => {
  const fields = realFieldsOf(barTile());
  assert.ok(editIsSafe({ op: "set", path: ["encoding", "x", "sort"], value: "-y" }, fields));
  assert.ok(editIsSafe({ op: "set", path: ["encoding", "y", "axis", "title"], value: "Sales (USD)" }, fields));
  assert.ok(editIsSafe({ op: "remove", path: ["encoding", "x", "axis"] }, fields));
});

test("editIsSafe rejects fabricated data, unknown fields, and engine-owned roots", async () => {
  const fields = realFieldsOf(barTile());
  // No inline data payloads.
  assert.equal(editIsSafe({ op: "set", path: ["data", "values"], value: [{ region: "North", sales: 99 }] }, fields), false);
  assert.equal(editIsSafe({ op: "set", path: ["encoding", "x"], value: { field: "region", data: { values: [] } } }, fields), false);
  // No inventing a field the tile does not have.
  assert.equal(editIsSafe({ op: "set", path: ["encoding", "color"], value: { field: "invented", type: "nominal" } }, fields), false);
  // Engine-owned coordination stays out of edit-spec.
  assert.equal(editIsSafe({ op: "set", path: ["params"], value: [] }, fields), false);
  assert.equal(editIsSafe({ op: "set", path: ["usermeta", "crossFilter"], value: {} }, fields), false);
  // Malformed shapes.
  assert.equal(editIsSafe({ op: "set", path: [] }, fields), false);
  assert.equal(editIsSafe({ op: "bogus", path: ["mark"] }, fields), false);
});

test("safeSpecEdits keeps only the safe edits and drops the rest", async () => {
  const spec = barTile();
  const kept = safeSpecEdits(spec, [
    { op: "set", path: ["encoding", "x", "sort"], value: "-y" },
    { op: "set", path: ["encoding", "color"], value: { field: "invented", type: "nominal" } },
    { op: "remove", path: ["mark", "point"] },
  ]);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((edit) => edit.op), ["set", "remove"]);
});

test("safeSpecEdits trusts a field the edits' own transform derives (two-step fix)", async () => {
  const spec = barTile();
  const kept = safeSpecEdits(spec, [
    // Step 1 derives `profit` from real columns; step 2 encodes it via the path
    // form. Both must survive so a real chart-form change is executable, not
    // downgraded to guidance for referencing a field not yet on the chart.
    { op: "set", path: ["transform"], value: [{ calculate: "datum.sales - 3", as: "profit" }] },
    { op: "set", path: ["encoding", "y", "field"], value: "profit" },
  ]);
  assert.equal(kept.length, 2);
});

test("safeSpecEdits drops a path-form field encode when no column or transform provides it", async () => {
  const spec = barTile();
  const kept = safeSpecEdits(spec, [
    { op: "set", path: ["encoding", "y", "field"], value: "phantom" }, // fabricated -> dropped
  ]);
  assert.equal(kept.length, 0);
});

test("safeSpecEdits does not let a bare {as} bless an otherwise-unknown field", async () => {
  const spec = barTile();
  const kept = safeSpecEdits(spec, [
    // A bare {"as":"ghost"} computes nothing, so `ghost` is not a real derived
    // field; the encode that references it must be dropped as fabricated. The
    // no-op transform edit itself carries no field reference and is kept (compile
    // + rollback is the backstop for a structurally inert transform).
    { op: "set", path: ["transform"], value: [{ as: "ghost" }] },
    { op: "set", path: ["encoding", "y", "field"], value: "ghost" },
  ]);
  assert.ok(!kept.some((edit) => edit.path.join(".") === "encoding.y.field"));
});

test("safeSpecEdits does not treat a non-transform as property as a derived field", async () => {
  const spec = barTile();
  const kept = safeSpecEdits(spec, [
    { op: "set", path: ["encoding", "color", "legend"], value: { as: "profit_margin", title: "Margin" } },
    { op: "set", path: ["encoding", "y", "field"], value: "profit_margin" },
  ]);
  assert.ok(!kept.some((edit) => edit.path.join(".") === "encoding.y.field"));
});

test("applySpecEdits mutates only through safe edits", async () => {
  const spec = barTile() as Record<string, unknown>;
  const applied = applySpecEdits(spec, [
    { op: "set", path: ["encoding", "x", "sort"], value: "-y" },
    { op: "set", path: ["title"], value: "Sales by region" },
    { op: "set", path: ["data", "values"], value: [{ region: "North", sales: 99 }] }, // dropped
  ]);
  assert.equal(applied, true);
  assert.equal(((spec.encoding as Record<string, Record<string, unknown>>).x).sort, "-y");
  assert.equal(spec.title, "Sales by region");
  // Fabricated data must not have landed.
  assert.equal((spec.data as { values: unknown[] }).values.length, 2);
});

test("edit-spec routes through applyProposals and survives the compile gate", async () => {
  const specMap = { revenue: barTile() };
  const critique = {
    id: "c-edit-1",
    tileId: "revenue",
    dimension: "chart",
    priority: "medium",
    status: "pending",
    source: "ai",
    title: "Sort the bars so the ranking reads directly",
    issue: "Bars are in data order, so the comparison is harder than it needs to be.",
    rationale: "A ranked axis makes the largest region obvious at a glance.",
    evidence: "The revenue tile encodes region on x with no sort.",
    suggestion: "Sort the region axis by descending sales.",
    target: { granularity: "chart", ref: { tile: "revenue" } },
    proposal: {
      kind: "edit-spec",
      mode: "executable",
      edits: [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }],
    },
    surface: "encoding",
    findingId: "finding-edit-1",
    grounded: true,
    phrasingSource: "llm",
  } as unknown as Critique;

  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.deepEqual(outcome.changedTargets, ["revenue"]);
  const encoding = outcome.specMap.revenue.encoding as Record<string, Record<string, unknown>>;
  assert.equal(encoding.x.sort, "-y");
  assert.equal(compileSpecMap(outcome.specMap).ok, true);
});

test("an edit-spec that breaks compilation rolls back with no mutation", async () => {
  const specMap = { revenue: barTile() };
  const critique = {
    id: "c-edit-bad",
    tileId: "revenue",
    dimension: "chart",
    priority: "medium",
    status: "pending",
    source: "ai",
    title: "Remove the y field",
    issue: "x",
    rationale: "x",
    evidence: "x",
    suggestion: "x",
    target: { granularity: "chart", ref: { tile: "revenue" } },
    proposal: {
      kind: "edit-spec",
      mode: "executable",
      // Removing the mark leaves a spec Vega-Lite cannot compile -> the gate
      // must roll the whole apply back with no partial mutation.
      edits: [{ op: "remove", path: ["mark"] }],
    },
    surface: "encoding",
    findingId: "finding-edit-bad",
    grounded: true,
    phrasingSource: "llm",
  } as unknown as Critique;

  const before = JSON.stringify(specMap);
  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  assert.equal(outcome.rollback.rolledBack, true);
  assert.equal(JSON.stringify(outcome.specMap), before);
});
