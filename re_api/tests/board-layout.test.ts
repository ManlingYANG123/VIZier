import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardMeta, Critique, SpecMap } from "../src/contracts.ts";
import { applyBoardProposal } from "../src/apply/index.ts";
import { computeKpis } from "../src/compute/kpis.ts";
import { dashboardSpecMap } from "../fixtures/specs.ts";

/** A one-tile spec map with arbitrary inline rows, for KPI-computation unit tests. */
function inlineSpecMap(rows: Record<string, unknown>[]): SpecMap {
  return { t: { mark: "point", data: { values: rows } } } as unknown as SpecMap;
}

/** A minimal board with laid-out tiles, mirroring an uploaded dashboard. */
function board(): BoardMeta {
  return {
    title: "Workspace Overview",
    subtitle: "",
    hasKpis: false,
    canvasWidth: 1100,
    canvasHeight: 720,
    tiles: [
      { id: "task-velocity", title: "Task Velocity", bounds: { x: 28, y: 96, w: 508, h: 258 } },
      { id: "department-tasks", title: "Tasks by Department", bounds: { x: 564, y: 96, w: 508, h: 258 } },
      { id: "sprint-burndown", title: "Sprint Burndown", bounds: { x: 28, y: 400, w: 508, h: 272 } },
      { id: "project-status", title: "Project Status", bounds: { x: 564, y: 400, w: 508, h: 272 } },
    ],
  };
}

/** Build an executable board-proposal critique with an arbitrary proposal. */
function boardCritique(proposal: Critique["proposal"]): Critique {
  return {
    id: "c-board",
    tileId: null,
    dimension: "layout",
    priority: "medium",
    status: "pending",
    source: "ai",
    title: "Board change",
    issue: "i",
    rationale: "r",
    evidence: "e",
    suggestion: "s",
    target: { granularity: "dashboard", ref: {} },
    proposal,
    surface: "structural",
    findingId: "f",
    grounded: true,
    phrasingSource: "llm",
  } as Critique;
}

test("edit-layout rejects a tile that would leave the fixed canvas", () => {
  const b = board();
  const before = structuredClone(b.tiles);
  const applied = applyBoardProposal(b, boardCritique({
    kind: "edit-layout",
    mode: "executable",
    layout: [
      { tile: "task-velocity", bounds: { x: 28, y: 700, w: 1044, h: 300 } },
    ],
  }));
  assert.equal(applied, false);
  assert.deepEqual(b.tiles, before);
});

test("edit-layout never grows the original canvas", () => {
  const b = board();
  const applied = applyBoardProposal(b, boardCritique({
    kind: "edit-layout",
    mode: "executable",
    layout: [{ tile: "project-status", bounds: { x: 564, y: 900, w: 508, h: 300 } }],
  }));
  assert.equal(applied, false);
  assert.deepEqual({ width: b.canvasWidth, height: b.canvasHeight }, { width: 1100, height: 720 });
});

test("edit-layout rejects degenerate and off-canvas boxes (no change -> false)", () => {
  const b = board();
  const before = JSON.stringify(b.tiles);
  const applied = applyBoardProposal(b, boardCritique({
    kind: "edit-layout",
    mode: "executable",
    layout: [
      { tile: "task-velocity", bounds: { x: -10, y: 5, w: 500, h: 200 } }, // negative x
      { tile: "department-tasks", bounds: { x: 5, y: 5, w: 10, h: 10 } },   // too small
    ],
  }));
  assert.equal(applied, false);
  assert.equal(JSON.stringify(b.tiles), before, "no tile should move when every box is invalid");
});

test("edit-layout ignores an unknown tile id", () => {
  const b = board();
  const applied = applyBoardProposal(b, boardCritique({
    kind: "edit-layout",
    mode: "executable",
    layout: [{ tile: "does-not-exist", bounds: { x: 0, y: 0, w: 500, h: 300 } }],
  }));
  assert.equal(applied, false);
});

test("edit-layout accepts a readable shrink so hierarchy can materially change", () => {
  const b = board();
  const applied = applyBoardProposal(b, boardCritique({
    kind: "edit-layout",
    mode: "executable",
    layout: [{ tile: "department-tasks", bounds: { x: 564, y: 96, w: 280, h: 258 } }],
  }));
  assert.equal(applied, true);
  assert.deepEqual(
    b.tiles!.find((tile) => tile.id === "department-tasks")!.bounds,
    { x: 564, y: 96, w: 280, h: 258 },
  );
});

test("edit-layout atomically rejects overlapping tiles", () => {
  const b = board();
  const before = JSON.stringify(b.tiles);
  const applied = applyBoardProposal(b, boardCritique({
    kind: "edit-layout",
    mode: "executable",
    layout: [{ tile: "task-velocity", bounds: { x: 28, y: 96, w: 800, h: 300 } }],
  }));
  assert.equal(applied, false);
  assert.equal(JSON.stringify(b.tiles), before);
});

/** An add-kpis carrying at least one resolvable KPI (the real-KPI design). */
function kpiCritique() {
  return boardCritique({
    kind: "add-kpis",
    mode: "executable",
    kpis: [{ label: "Total Tasks", tile: "department-tasks", field: "tasks", agg: "sum" }],
    kpiLayout: "hero-support",
  });
}

test("add-kpis reserves its band and refits tiles inside the fixed canvas", () => {
  const b = board();
  const applied = applyBoardProposal(b, kpiCritique(), dashboardSpecMap());
  assert.equal(applied, true);
  assert.equal(b.hasKpis, true);
  assert.equal(b.tiles!.find((t) => t.id === "task-velocity")!.bounds!.y, 204);
  assert.equal(b.tiles!.find((t) => t.id === "sprint-burndown")!.bounds!.y, 462);
  assert.equal(b.canvasHeight, 720);
});

test("recompose-kpis changes a top hero band into a side rail and reflows tiles", () => {
  const b = board();
  assert.equal(applyBoardProposal(b, kpiCritique(), dashboardSpecMap()), true);
  const afterHero = structuredClone(b.tiles);
  const applied = applyBoardProposal(b, boardCritique({
    kind: "recompose-kpis",
    mode: "executable",
    kpiLayout: "side-rail",
    kpiStyle: "technical",
    kpiDensity: "dense",
    kpiChrome: "ruled",
  }), dashboardSpecMap());
  assert.equal(applied, true);
  assert.equal(b.kpiLayout, "side-rail");
  assert.equal(b.kpiStyle, "technical");
  const beforeTile = afterHero!.find((tile) => tile.id === "task-velocity")!.bounds!;
  const afterTile = b.tiles!.find((tile) => tile.id === "task-velocity")!.bounds!;
  assert.equal(afterTile.x, 232);
  assert.equal(afterTile.y, 96);
});

test("an invalid client-supplied KPI layout cannot crash apply", () => {
  const b = board();
  b.kpiLayout = "not-a-layout" as BoardMeta["kpiLayout"];
  assert.doesNotThrow(() => applyBoardProposal(b, kpiCritique(), dashboardSpecMap()));
  assert.equal(b.kpiLayout, "hero-support");
});

test("named small-multiples composition computes a safe equalized grid", () => {
  const b = board();
  const applied = applyBoardProposal(b, boardCritique({
    kind: "edit-layout",
    mode: "executable",
    composition: "small-multiples",
    layoutTiles: b.tiles!.map((tile) => tile.id),
  }));
  assert.equal(applied, true);
  const widths = new Set(b.tiles!.map((tile) => tile.bounds!.w));
  const heights = new Set(b.tiles!.map((tile) => tile.bounds!.h));
  assert.equal(widths.size, 1);
  assert.equal(heights.size, 1);
});

test("named compositions remain executable below a top KPI band", () => {
  const b = board();
  assert.equal(applyBoardProposal(b, kpiCritique(), dashboardSpecMap()), true);
  const applied = applyBoardProposal(b, boardCritique({
    kind: "edit-layout",
    mode: "executable",
    composition: "small-multiples",
    layoutTiles: b.tiles!.map((tile) => tile.id),
  }));
  assert.equal(applied, true);
  assert.ok(b.tiles!.every((tile) =>
    tile.bounds && tile.bounds.x + tile.bounds.w <= 1100 && tile.bounds.y + tile.bounds.h <= 720));
});

test("add-kpis with no resolvable KPI is an honest no-op (no empty band, no shift)", () => {
  const b = board();
  const before = JSON.stringify(b);
  // No kpis authored -> nothing real to compute -> must not reserve dead space.
  const applied = applyBoardProposal(b, boardCritique({ kind: "add-kpis", mode: "executable" }), dashboardSpecMap());
  assert.equal(applied, false);
  assert.equal(JSON.stringify(b), before, "an empty add-kpis must not touch the board");
});

test("add-kpis is rejected at apply time when embedded KPI tiles already exist", () => {
  const b = { ...board(), hasEmbeddedKpis: true };
  const before = structuredClone(b);
  const applied = applyBoardProposal(b, boardCritique({
    kind: "add-kpis",
    mode: "executable",
    kpis: [
      { label: "Total Tasks", tile: "department-tasks", field: "tasks", agg: "sum" },
    ],
  }), dashboardSpecMap());
  assert.equal(applied, false);
  assert.deepEqual(b, before);
});

test("wire-filter-control connects an existing visible filter to valid targets", () => {
  const b = {
    ...board(),
    filters: [{
      id: "department-filter",
      label: "Department",
      kind: "category" as const,
      field: "department",
      targets: ["department-tasks", "task-velocity"],
      options: ["Design", "Eng"],
      wired: false,
      value: null,
    }],
  };
  const applied = applyBoardProposal(b, boardCritique({
    kind: "wire-filter-control",
    mode: "executable",
    filterId: "department-filter",
  }), dashboardSpecMap());
  assert.equal(applied, true);
  assert.equal(b.filters![0].wired, true);
  assert.equal(b.filters![0].value, null);
});

test("add-kpis is idempotent: applying twice does not double-shift the tiles", () => {
  const b = board();
  applyBoardProposal(b, kpiCritique(), dashboardSpecMap());
  const yAfterFirst = b.tiles!.find((t) => t.id === "task-velocity")!.bounds!.y;
  applyBoardProposal(b, kpiCritique(), dashboardSpecMap());
  assert.equal(b.tiles!.find((t) => t.id === "task-velocity")!.bounds!.y, yAfterFirst);
});

test("chart-subtitles stays inside each existing tile frame", () => {
  const b = board();
  const before = structuredClone(b.tiles);
  const applied = applyBoardProposal(b, boardCritique({
    kind: "chart-subtitles",
    mode: "executable",
  }));
  assert.equal(applied, true);
  const top = b.tiles!.find((tile) => tile.id === "task-velocity")!;
  const bottom = b.tiles!.find((tile) => tile.id === "sprint-burndown")!;
  assert.deepEqual(top.bounds, before!.find((tile) => tile.id === top.id)!.bounds);
  assert.deepEqual(bottom.bounds, before!.find((tile) => tile.id === bottom.id)!.bounds);
  assert.equal(b.canvasHeight, 720);
  assert.equal(top.hasSubtitle, true);
});

test("add-kpis computes real values from tile data and returns them on board.kpis", () => {
  const b = board();
  applyBoardProposal(b, boardCritique({
    kind: "add-kpis",
    mode: "executable",
    kpiStyle: "technical",
    kpis: [
      { label: "Departments", tile: "department-tasks", field: "department", agg: "distinct" },
      { label: "Total Tasks", tile: "department-tasks", field: "tasks", agg: "sum" },
      { label: "Rows", agg: "count" },
    ],
  }), dashboardSpecMap());
  assert.ok(Array.isArray(b.kpis));
  assert.equal(b.kpiStyle, "technical");
  const byLabel = new Map(b.kpis!.map((k) => [k.label, k]));
  assert.equal(byLabel.get("Departments")!.computed, true);
  assert.equal(byLabel.get("Total Tasks")!.computed, true);
  // The engine computes, never fabricates: the sum matches the fixture data.
  const rows = dashboardSpecMap()["department-tasks"].data as { values: Array<{ tasks: number }> };
  const expected = rows.values.reduce((a, r) => a + Number(r.tasks), 0);
  assert.equal(byLabel.get("Total Tasks")!.value, String(expected));
});

test("computeKpis marks an unresolvable KPI as not computed instead of inventing one", () => {
  const resolved = computeKpis(dashboardSpecMap(), [
    { label: "Nonsense", tile: "department-tasks", field: "no-such-field", agg: "sum" },
  ]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].computed, false);
  assert.equal(resolved[0].value, "—");
});

test("computeKpis appends a unit suffix to a computed value", () => {
  // department-tasks carries no transform, so its raw rows are what the chart
  // shows and the value is faithfully computable.
  const resolved = computeKpis(dashboardSpecMap(), [
    { label: "Avg Tasks", tile: "department-tasks", field: "tasks", agg: "avg", unit: "%" },
  ]);
  assert.equal(resolved[0].computed, true);
  assert.match(resolved[0].value, /%$/);
});

test("computeKpis supports materially different deterministic number formats", () => {
  const specMap = inlineSpecMap([{ revenue: 1284500, ratio: 0.347, aboveBaseline: 1.02, score: 87.5 }]);
  const resolved = computeKpis(specMap, [
    { label: "Revenue", tile: "t", field: "revenue", agg: "sum", format: "compact" },
    { label: "Revenue exact", tile: "t", field: "revenue", agg: "sum", format: "currency" },
    { label: "Completion", tile: "t", field: "ratio", agg: "avg", format: "percent-fraction", unit: "%" },
    { label: "Above baseline", tile: "t", field: "aboveBaseline", agg: "avg", format: "percent-fraction" },
    { label: "Score", tile: "t", field: "score", agg: "avg", format: "percent" },
  ]);
  assert.equal(resolved[0].value, "1.3M");
  assert.equal(resolved[1].value, "$1,284,500");
  assert.equal(resolved[2].value, "34.7%");
  assert.equal(resolved[3].value, "102%");
  assert.equal(resolved[4].value, "87.5%");
});

test("computeKpis filters category-specific metrics before aggregating", () => {
  const specMap = inlineSpecMap([
    { band: "Good (0-50)", days: 238 },
    { band: "Moderate (51-100)", days: 104 },
    { band: "Unhealthy (151+)", days: 4 },
  ]);
  const resolved = computeKpis(specMap, [
    {
      label: "Good days",
      tile: "t",
      field: "days",
      agg: "sum",
      filter: { field: "band", value: "Good (0-50)" },
    },
    {
      label: "Unhealthy days",
      tile: "t",
      field: "days",
      agg: "sum",
      filter: { field: "band", value: "Unhealthy (151+)" },
    },
  ]);
  assert.deepEqual(resolved.map((kpi) => kpi.value), ["238", "4"]);
});

test("computeKpis does not guess an aggregate for a field KPI with no explicit agg", () => {
  // The label promises an average, but no `agg` is declared. The engine must NOT
  // fall back to summing the column (the "AVG shown as SUM" bug) — an
  // under-specified field KPI is reported uncomputed, not a misleading number.
  const specMap = inlineSpecMap([{ year: "2025", aqi: 40 }, { year: "2025", aqi: 60 }]);
  const [resolved] = computeKpis(specMap, [
    { label: "Avg AQI 2025", tile: "t", field: "aqi" },
  ]);
  assert.equal(resolved.computed, false);
  assert.equal(resolved.value, "—");
});

test("computeKpis marks two distinct-label KPIs with an identical scope as uncomputed", () => {
  // "AVG AQI 2025" and "AVG AQI 2024" authored with the SAME tile/field/agg and
  // NO year filter aggregate the entire column, so both would show the identical
  // number. Showing one figure under two names is misleading: both go to "—".
  const specMap = inlineSpecMap([
    { year: "2025", aqi: 40 }, { year: "2025", aqi: 60 },
    { year: "2024", aqi: 50 }, { year: "2024", aqi: 70 },
  ]);
  const resolved = computeKpis(specMap, [
    { label: "Avg AQI 2025", tile: "t", field: "aqi", agg: "avg" },
    { label: "Avg AQI 2024", tile: "t", field: "aqi", agg: "avg" },
  ]);
  assert.deepEqual(resolved.map((k) => k.value), ["—", "—"]);
  assert.deepEqual(resolved.map((k) => k.computed), [false, false]);
});

test("computeKpis computes both per-year KPIs when each carries its distinguishing filter", () => {
  // The correct authoring: same field+agg, DISTINCT filters. Different scopes ⇒
  // different signatures ⇒ no collision ⇒ each real per-year mean is computed.
  const specMap = inlineSpecMap([
    { year: "2025", aqi: 40 }, { year: "2025", aqi: 60 },
    { year: "2024", aqi: 50 }, { year: "2024", aqi: 70 },
  ]);
  const resolved = computeKpis(specMap, [
    { label: "Avg AQI 2025", tile: "t", field: "aqi", agg: "avg", filter: { field: "year", value: "2025" } },
    { label: "Avg AQI 2024", tile: "t", field: "aqi", agg: "avg", filter: { field: "year", value: "2024" } },
  ]);
  assert.deepEqual(resolved.map((k) => k.value), ["50", "60"]);
  assert.deepEqual(resolved.map((k) => k.computed), [true, true]);
});

test("computeKpis reports a percentage whose scale is impossible as uncomputed", () => {
  // A 0–100 field mislabeled "percent-fraction" would render "8700%"; a summed
  // quantity mislabeled "percent" would render "788,100%". Both are scale
  // mislabels, so the engine withholds them ("—") instead of a nonsense number.
  const specMap = inlineSpecMap([{ score: 87 }, { revenue: 788100 }]);
  const bogusFraction = computeKpis(specMap, [
    { label: "Score", tile: "t", field: "score", agg: "avg", format: "percent-fraction" },
  ]);
  assert.equal(bogusFraction[0].computed, false);
  assert.equal(bogusFraction[0].value, "—");
  const bogusPercent = computeKpis(specMap, [
    { label: "Revenue", tile: "t", field: "revenue", agg: "sum", format: "percent" },
  ]);
  assert.equal(bogusPercent[0].computed, false);
  // A legitimate above-baseline ratio (1.02 -> 102%) stays well under the ceiling.
  const ok = computeKpis(inlineSpecMap([{ ratio: 1.02 }]), [
    { label: "Above baseline", tile: "t", field: "ratio", agg: "avg", format: "percent-fraction" },
  ]);
  assert.equal(ok[0].value, "102%");
});

test("computeKpis rejects a category filter that matches no real row", () => {
  const specMap = inlineSpecMap([{ band: "Good", days: 238 }]);
  const [resolved] = computeKpis(specMap, [{
    label: "Imaginary days",
    tile: "t",
    field: "days",
    agg: "sum",
    filter: { field: "band", value: "Imaginary" },
  }]);
  assert.equal(resolved.computed, false);
  assert.equal(resolved.value, "—");
});

test("computeKpis renders '—' for a KPI over a tile that reshapes its rows", () => {
  // task-velocity aggregates+folds before display, so a raw-row avg of `completed`
  // would contradict the plotted monthly totals. The honest result is "—", never a
  // real-looking number that disagrees with the chart beside it.
  const resolved = computeKpis(dashboardSpecMap(), [
    { label: "Avg Completed", tile: "task-velocity", field: "completed", agg: "avg" },
  ]);
  assert.equal(resolved[0].computed, false);
  assert.equal(resolved[0].value, "—");
});

test("computeKpis renders '—' for a bare count with no source tile (no fabricated 0)", () => {
  // A count with no tile has no rows to count; returning "0" would fabricate a
  // figure on a board that names no source. It must stay uncomputed.
  const resolved = computeKpis(dashboardSpecMap(), [{ label: "Rows", agg: "count" }]);
  assert.equal(resolved[0].computed, false);
  assert.equal(resolved[0].value, "—");
});

test("computeKpis does not borrow another tile's rows when the named tile lacks data", () => {
  // A KPI is an attributed claim; a real number from the wrong tile is the subtle
  // cousin of fabrication. A tile with no inline data resolves to "—".
  const specMap = { a: { mark: "point", data: { url: "x.csv" } }, b: { mark: "bar", data: { values: [{ v: 5 }] } } } as unknown as SpecMap;
  const resolved = computeKpis(specMap, [{ label: "A total", tile: "a", field: "v", agg: "sum" }]);
  assert.equal(resolved[0].computed, false);
  assert.equal(resolved[0].value, "—");
});

test("computeKpis excludes null/blank/boolean cells so avg and min are not deflated", () => {
  // A bare Number()+isFinite would coerce null->0, ""->0, false->0 and count
  // them, dragging avg to 42.5 and min to 0. The trust invariant forbids that
  // misleading real-looking number: only real measurements must be aggregated.
  const rows = [{ score: 90 }, { score: 80 }, { score: null }, { score: "" }, { score: false }, { score: "  " }];
  const specMap = inlineSpecMap(rows);
  const avg = computeKpis(specMap, [{ label: "Avg Score", tile: "t", field: "score", agg: "avg" }]);
  assert.equal(avg[0].computed, true);
  assert.equal(avg[0].value, "85"); // (90 + 80) / 2, not (90 + 80 + 0 + 0 + 0 + 0) / 6
  const min = computeKpis(specMap, [{ label: "Min Score", tile: "t", field: "score", agg: "min" }]);
  assert.equal(min[0].value, "80"); // not 0 from a coerced null/blank
});

test("computeKpis keeps a numeric string that parses cleanly", () => {
  // "42" is a real measurement typed as a string; it must count, unlike "".
  const specMap = inlineSpecMap([{ v: "42" }, { v: 8 }, { v: "not a number" }]);
  const sum = computeKpis(specMap, [{ label: "Sum", tile: "t", field: "v", agg: "sum" }]);
  assert.equal(sum[0].value, "50"); // 42 + 8; the non-numeric string is skipped
});

test("computeKpis counts 1 and \"1\" as distinct values (no type collision)", () => {
  // Tagging by type keeps the number 1 and the string "1" in separate buckets,
  // so a distinct count is not silently under-reported.
  const specMap = inlineSpecMap([{ id: 1 }, { id: "1" }, { id: 2 }, { id: "2" }]);
  const distinct = computeKpis(specMap, [{ label: "Distinct Ids", tile: "t", field: "id", agg: "distinct" }]);
  assert.equal(distinct[0].value, "4");
});
