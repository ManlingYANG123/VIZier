import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProposals, applyTooltip } from "../src/apply/index.ts";
import { compileSpec, compileSpecMap } from "../src/apply/compile.ts";
import { hasSelectionOnField, markHasPoint } from "../src/detect/specUtil.ts";
import { dashboardSpecMap } from "../fixtures/specs.ts";
import { critiquesFixture } from "./helpers.ts";
import type { Critique } from "../src/contracts.ts";

/** A consolidated executable edit-spec critique: one identical fix carried across
 * every tile in target.ref.tiles (the shape the engine's consolidation produces).
 * Only the fields applyProposals/applyOne read are populated. */
function consolidatedEditSpec(tiles: string[], edits: unknown): Critique {
  return {
    id: "c-consolidated-fix",
    tileId: tiles[0],
    proposal: { kind: "edit-spec", mode: "executable", edits },
    target: { granularity: "chart", ref: { tile: tiles[0], tiles } },
  } as unknown as Critique;
}

/** A consolidated executable add-tooltip critique: one hover fix carried across
 * every tile in target.ref.tiles. add-tooltip is tile-portable (it reads each
 * tile's own encoded fields), so the same card applies to every sibling. */
function consolidatedAddTooltip(tiles: string[]): Critique {
  return {
    id: "c-consolidated-tooltip",
    tileId: tiles[0],
    proposal: { kind: "add-tooltip", mode: "executable" },
    target: { granularity: "chart", ref: { tile: tiles[0], tiles } },
  } as unknown as Critique;
}

test("add-cross-filter wires a point selection on the source", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const cf = critiques.find((c) => c.proposal.kind === "add-cross-filter")!;
  const outcome = await applyProposals(specMap, critiques, [cf.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.ok(hasSelectionOnField(outcome.specMap["department-tasks"], "department"));
  const meta = outcome.specMap["task-velocity"].usermeta as Record<string, unknown>;
  assert.equal((meta.crossFilter as Record<string, unknown>).role, "target");
});

test("add-tooltip adds tooltip encoding + hover points to the line", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const tip = critiques.find((c) => c.proposal.kind === "add-tooltip")!;
  const outcome = await applyProposals(specMap, critiques, [tip.id]);
  const spec = outcome.specMap["task-velocity"];
  assert.ok(Array.isArray((spec.encoding as Record<string, unknown>).tooltip));
  assert.ok(markHasPoint(spec));
});

test("v2-palette applies a safe model-authored palette instead of one house style", async () => {
  const specMap = dashboardSpecMap();
  const critique = {
    id: "c-authored-palette",
    tileId: "project-status",
    proposal: {
      kind: "v2-palette",
      mode: "executable",
      palette: ["#264653", "#e9c46a", "#e76f51"],
    },
    target: { granularity: "chart", ref: { tile: "project-status" } },
  } as unknown as Critique;
  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  const encoding = outcome.specMap["project-status"].encoding as Record<string, unknown>;
  const color = encoding.color as Record<string, unknown>;
  assert.deepEqual((color.scale as Record<string, unknown>).range, critique.proposal.palette);
});

test("add-tooltip updates the exact nested units identified by the detector", async () => {
  const specMap = {
    trends: {
      data: { values: [{ week: 1, sales: 10, profit: 2 }] },
      vconcat: [{
        layer: [{
          mark: "line",
          encoding: {
            x: { field: "week", type: "quantitative" },
            y: { field: "sales", type: "quantitative" },
          },
        }],
      }, {
        layer: [{
          mark: "line",
          encoding: {
            x: { field: "week", type: "quantitative" },
            y: { field: "profit", type: "quantitative" },
          },
        }],
      }],
    },
  };
  const critiques = await critiquesFixture(specMap);
  const tooltip = critiques.find((critique) => critique.proposal.kind === "add-tooltip")!;
  const outcome = await applyProposals(specMap, critiques, [tooltip.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  const result = outcome.specMap.trends as {
    vconcat: Array<{ layer: Array<{ mark: Record<string, unknown>; encoding: Record<string, unknown> }> }>;
  };
  for (const section of result.vconcat) {
    assert.ok(Array.isArray(section.layer[0].encoding.tooltip));
    assert.ok(section.layer[0].mark.point);
  }
});

test("add-cross-filter annotates a nested categorical source without adding an invalid top-level mark", async () => {
  const specMap = {
    source: {
      data: { values: [{ region: "East", sales: 10 }] },
      hconcat: [{
        mark: "bar",
        encoding: {
          x: { field: "region", type: "nominal" },
          y: { field: "sales", type: "quantitative" },
        },
      }],
    },
    target: {
      data: { values: [{ region: "East", profit: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "region", type: "nominal" },
        y: { field: "profit", type: "quantitative" },
      },
    },
  };
  const critiques = await critiquesFixture(specMap);
  const crossFilter = critiques.find((critique) => critique.proposal.kind === "add-cross-filter")!;
  const outcome = await applyProposals(specMap, critiques, [crossFilter.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.equal(outcome.specMap.source.mark, undefined);
  const nested = (outcome.specMap.source.hconcat as Array<Record<string, unknown>>)[0];
  assert.equal((nested.mark as Record<string, unknown>).cursor, "pointer");
  assert.ok((nested.encoding as Record<string, unknown>).opacity);
});

test("applied specs still compile", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const outcome = await applyProposals(specMap, critiques, critiques.map((c) => c.id));
  assert.equal(compileSpecMap(outcome.specMap).ok, true);
});

test("compile gate accepts good specs and rejects malformed ones", async () => {
  assert.equal(
    compileSpec({ mark: "bar", encoding: { x: { field: "a", type: "nominal" } }, data: { values: [] } }).ok,
    true,
  );
  assert.equal(compileSpec({ data: { values: [] }, encoding: {} }).ok, false);
});

test("render gate rejects newly introduced Vega-Lite warnings that discard proposal edits", () => {
  const original = {
    data: { values: [{ category: "A", value: 1 }] },
    mark: { type: "text" },
    encoding: {
      text: { field: "category", type: "nominal" },
      x: { field: "value", type: "quantitative" },
    },
  };
  const lossy = structuredClone(original) as Record<string, unknown>;
  (lossy.encoding as Record<string, unknown>).strokeDash = {
    field: "category",
    type: "nominal",
  };

  const result = compileSpec(lossy as never, original as never);
  assert.equal(result.ok, false);
  assert.ok(result.lossyWarnings.length > 0);
  assert.match(result.error || "", /discard or override.*strokeDash.*incompatible.*text/is);
});

test("render gate permits a pre-existing lossy warning", () => {
  const original = {
    data: { values: [{ category: "A", value: 1 }] },
    mark: { type: "text" },
    encoding: {
      text: { field: "category", type: "nominal" },
      x: { field: "value", type: "quantitative" },
      strokeDash: { field: "category", type: "nominal" },
    },
  };
  const unchanged = structuredClone(original);
  assert.equal(compileSpec(unchanged as never, original as never).ok, true);
});

test("render gate rejects a layered proposal whose compiled Vega has duplicate selection signals", async () => {
  // Regression from the garden-birds critique "Put the garden-bird counts on
  // the bars". Vega-Lite compile() accepts this shape, but the browser's Vega
  // parser throws `Duplicate signal name: bird_sel_tuple`, leaving the tile
  // blank. The backend must reject it before the UI can call it Applied.
  const original = {
    data: { values: [{ bird: "House Sparrow", count: 4.3 }, { bird: "Blue Tit", count: 3 }] },
    params: [{
      name: "bird_sel",
      select: { type: "point", fields: ["bird"], on: "click", clear: "dblclick" },
    }],
    mark: { type: "bar" },
    encoding: {
      y: { field: "bird", type: "nominal" },
      x: { field: "count", type: "quantitative" },
      opacity: { condition: { param: "bird_sel", value: 1 }, value: 0.3 },
    },
  };
  const critique = {
    id: "c-layer-labels",
    tileId: "birds-ranking",
    proposal: {
      kind: "edit-spec",
      mode: "executable",
      edits: [{
        op: "set",
        path: ["layer"],
        value: [{
          mark: { type: "bar" },
          encoding: {
            y: { field: "bird", type: "nominal" },
            x: { field: "count", type: "quantitative" },
            opacity: { condition: { param: "bird_sel", value: 1 }, value: 0.3 },
          },
        }, {
          mark: { type: "text", dx: 6 },
          encoding: {
            y: { field: "bird", type: "nominal" },
            x: { field: "count", type: "quantitative" },
            text: { field: "count", type: "quantitative" },
            opacity: { condition: { param: "bird_sel", value: 1 }, value: 0.3 },
          },
        }],
      }, { op: "remove", path: ["mark"] }, { op: "remove", path: ["encoding"] }],
    },
    target: { granularity: "chart", ref: { tile: "birds-ranking" } },
  } as unknown as Critique;

  const invalid = structuredClone(original);
  const edits = critique.proposal.edits!;
  // The public apply path is the assertion that matters; compileSpec's direct
  // result documents the precise validation layer that catches it.
  const directOutcome = await applyProposals({ "birds-ranking": invalid }, [critique], [critique.id]);
  assert.equal(compileSpec(directOutcome.specMap["birds-ranking"]).ok, true, "rollback must restore the valid original");
  assert.equal(directOutcome.rollback.rolledBack, true);
  assert.match(directOutcome.rollback.reason ?? "", /Duplicate signal name: "bird_sel_tuple"/);
  assert.deepEqual(directOutcome.specMap["birds-ranking"], original);
  assert.ok(edits.length > 0);
});

test("a consolidated edit-spec fans out to every tile in target.ref.tiles", async () => {
  const specMap = dashboardSpecMap();
  const tiles = ["task-velocity", "department-tasks", "sprint-burndown"];
  const critique = consolidatedEditSpec(tiles, [
    { op: "set", path: ["encoding", "x", "axis", "labelAngle"], value: -40 },
  ]);
  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  // changedTargets is the union of every tile the one fix actually touched.
  assert.deepEqual(new Set(outcome.changedTargets), new Set(tiles));
  for (const tile of tiles) {
    const axis = ((outcome.specMap[tile].encoding as Record<string, unknown>).x as Record<string, unknown>).axis;
    assert.equal((axis as Record<string, unknown>).labelAngle, -40);
  }
  // A tile outside the set is left untouched.
  const untouched = (outcome.specMap["project-status"].encoding as Record<string, unknown>).x;
  assert.equal(untouched, undefined);
});

test("a consolidated edit-spec commits the tiles it fits and skips the ones it does not", async () => {
  const specMap = dashboardSpecMap();
  // Recoloring by `department` fits the two tiles that carry that column; the
  // sprint burndown has no department field, so the fix no-ops there (never
  // fabricated) and the batch still commits the rest — a true "2 of 3".
  const critique = consolidatedEditSpec(
    ["task-velocity", "department-tasks", "sprint-burndown"],
    [{ op: "set", path: ["encoding", "color"], value: { field: "department", type: "nominal" } }],
  );
  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.deepEqual(new Set(outcome.changedTargets), new Set(["task-velocity", "department-tasks"]));
  assert.ok(!outcome.changedTargets.includes("sprint-burndown"));
});

test("a consolidated add-tooltip fans out to every tile, adding to those missing a tooltip and preserving those that already have one", async () => {
  // Three sibling charts under one consolidated card. Two lack a tooltip and must
  // gain one; the third already ships a tooltip and must be left EXACTLY as-is —
  // add-tooltip only fills the MISSING hover affordance and never clobbers an
  // existing tooltip. (This is the sibling-clobber regression: a dropped per-tile
  // detector specPath must not cause the generic fallback to overwrite a sibling's
  // already-correct tooltip.) changedTargets reflects only the two that changed.
  const specMap = {
    "bar-a": {
      data: { values: [{ label: "A", value: 3 }] },
      mark: "bar",
      encoding: { x: { field: "label", type: "nominal" }, y: { field: "value", type: "quantitative" } },
    },
    "bar-b": {
      data: { values: [{ label: "B", value: 5 }] },
      mark: "bar",
      encoding: { x: { field: "label", type: "nominal" }, y: { field: "value", type: "quantitative" } },
    },
    "bar-c": {
      data: { values: [{ label: "C", value: 7 }] },
      mark: "bar",
      encoding: {
        x: { field: "label", type: "nominal" },
        y: { field: "value", type: "quantitative" },
        tooltip: [{ field: "label" }],
      },
    },
  } as unknown as ReturnType<typeof dashboardSpecMap>;
  const before = structuredClone((specMap["bar-c"].encoding as Record<string, unknown>).tooltip);
  const critique = consolidatedAddTooltip(["bar-a", "bar-b", "bar-c"]);
  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.deepEqual(new Set(outcome.changedTargets), new Set(["bar-a", "bar-b"]));
  assert.ok(!outcome.changedTargets.includes("bar-c"));
  for (const tile of ["bar-a", "bar-b"]) {
    assert.ok(Array.isArray((outcome.specMap[tile].encoding as Record<string, unknown>).tooltip));
  }
  // The already-tooltipped sibling keeps its exact original tooltip, untouched.
  assert.deepEqual((outcome.specMap["bar-c"].encoding as Record<string, unknown>).tooltip, before);
});

test("applyTooltip reports no change for a tile with no encodable fields", async () => {
  // A KPI-style text tile whose only encoding is a literal value has no field to
  // surface, so applyTooltip must add nothing AND report [] — otherwise a
  // consolidated card would claim a tile it never actually changed.
  const specMap = {
    kpi: { mark: { type: "text" }, encoding: { text: { value: "42" } } },
  } as unknown as Parameters<typeof applyTooltip>[0];
  const changed = applyTooltip(specMap, "kpi");
  assert.deepEqual(changed, []);
  assert.equal((specMap.kpi.encoding as Record<string, unknown>).tooltip, undefined);
});

test("a consolidated add-tooltip skips a fieldless tile and omits it from changedTargets", async () => {
  // One card spanning a real chart and a fieldless KPI tile: the chart gets a
  // tooltip, the KPI no-ops, and changedTargets reports only what truly changed.
  const specMap = {
    chart: {
      data: { values: [{ label: "A", value: 3 }] },
      mark: "bar",
      encoding: {
        x: { field: "label", type: "nominal" },
        y: { field: "value", type: "quantitative" },
      },
    },
    kpi: {
      data: { values: [{ total: 42 }] },
      mark: { type: "text" },
      encoding: { text: { value: "42" } },
    },
  } as unknown as ReturnType<typeof dashboardSpecMap>;
  const critique = consolidatedAddTooltip(["chart", "kpi"]);
  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.deepEqual(new Set(outcome.changedTargets), new Set(["chart"]));
  assert.ok(!outcome.changedTargets.includes("kpi"));
  assert.ok(Array.isArray((outcome.specMap.chart.encoding as Record<string, unknown>).tooltip));
  assert.equal((outcome.specMap.kpi.encoding as Record<string, unknown>).tooltip, undefined);
});

test("a consolidated add-tooltip skips a field-less PRIMARY tile and still fixes its field-bearing sibling", async () => {
  // Order-independence: the field-less tile is FIRST in ref.tiles (the primary),
  // the field-bearing chart second. The skip must not hinge on tile order — the
  // field-less primary no-ops (omitted from changedTargets, no tooltip added)
  // while the sibling still gains one. Guards against a fix that only checked
  // non-primary siblings.
  const specMap = {
    kpi: {
      data: { values: [{ total: 42 }] },
      mark: { type: "text" },
      encoding: { text: { value: "42" } },
    },
    chart: {
      data: { values: [{ label: "A", value: 3 }] },
      mark: "bar",
      encoding: {
        x: { field: "label", type: "nominal" },
        y: { field: "value", type: "quantitative" },
      },
    },
  } as unknown as ReturnType<typeof dashboardSpecMap>;
  const critique = consolidatedAddTooltip(["kpi", "chart"]);
  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.deepEqual(new Set(outcome.changedTargets), new Set(["chart"]));
  assert.ok(!outcome.changedTargets.includes("kpi"));
  assert.equal((outcome.specMap.kpi.encoding as Record<string, unknown>).tooltip, undefined);
  assert.ok(Array.isArray((outcome.specMap.chart.encoding as Record<string, unknown>).tooltip));
});

test("applyTooltip on a composed tile with mixed leaf units tooltips only the field-bearing one", async () => {
  // A composed tile with MIXED units: one line unit carries fields (gains a
  // tooltip + hover points), a sibling text unit shows a literal value with no
  // field (nothing to surface, left untouched). The tile reports [tileId] because
  // it changed at least one unit — and never fabricates a tooltip on the
  // field-less unit.
  const specMap = {
    kpi: {
      data: { values: [{ month: "Jan", cy: 2 }] },
      vconcat: [
        {
          mark: { type: "line" },
          encoding: {
            x: { field: "month", type: "temporal" },
            y: { field: "cy", type: "quantitative" },
          },
        },
        {
          mark: { type: "text" },
          encoding: { text: { value: "2" } },
        },
      ],
    },
  } as unknown as Parameters<typeof applyTooltip>[0];
  const changed = applyTooltip(specMap, "kpi");
  assert.deepEqual(changed, ["kpi"]);
  const units = (specMap.kpi.vconcat as Array<{ mark: Record<string, unknown>; encoding: Record<string, unknown> }>);
  // Field-bearing line unit gains a tooltip + hover points.
  assert.ok(Array.isArray(units[0].encoding.tooltip));
  assert.ok(units[0].mark.point);
  // Field-less text unit is left exactly as-is (no tooltip fabricated).
  assert.equal(units[1].encoding.tooltip, undefined);
});

test("a model add-tooltip reaches the leaf units of a composed tile (no specPaths)", async () => {
  // A composed KPI sparkline: no top-level encoding, its fields live in the
  // vconcat/layer units. A model-emitted add-tooltip carries no detector specPaths,
  // so a whole-spec tooltip would find nothing; applyTooltip must instead tooltip
  // the field-bearing leaf units, otherwise the card silently no-ops.
  const specMap = {
    "kpi-spark": {
      data: { values: [{ month: "Jan", py: 1, cy: 2 }] },
      vconcat: [{
        layer: [{
          mark: { type: "line" },
          encoding: {
            x: { field: "month", type: "temporal" },
            y: { field: "cy", type: "quantitative" },
          },
        }],
      }],
    },
  } as unknown as ReturnType<typeof dashboardSpecMap>;
  const critique = consolidatedAddTooltip(["kpi-spark"]);
  const outcome = await applyProposals(specMap, [critique], [critique.id]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.deepEqual(outcome.changedTargets, ["kpi-spark"]);
  const unit = (outcome.specMap["kpi-spark"].vconcat as Array<{
    layer: Array<{ mark: Record<string, unknown>; encoding: Record<string, unknown> }>;
  }>)[0].layer[0];
  assert.ok(Array.isArray(unit.encoding.tooltip));
  assert.ok(unit.mark.point); // a line unit also gains hover points
});

test("a spec that fails to compile triggers rollback with no partial mutation", async () => {
  const specMap = dashboardSpecMap();
  // Corrupt one tile so the post-apply compile gate must fail.
  specMap["broken"] = { data: { values: [] }, encoding: {} };
  const critiques = await critiquesFixture();
  const before = JSON.stringify(specMap);
  const outcome = await applyProposals(specMap, critiques, critiques.map((c) => c.id));
  assert.equal(outcome.rollback.rolledBack, true);
  assert.match(outcome.rollback.reason ?? "", /compile/i);
  assert.equal(JSON.stringify(outcome.specMap), before, "spec map must be returned untouched");
});
