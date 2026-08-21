import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySourceSelectionState,
  applyTargetFilterState,
  applyDashboardFilterState,
  buildInteractionScenario,
  normalizeDashboardDocument,
  walkUnitSpecs,
} from "../src/vega-dashboard-adapter.js";
// The backend "truth" the on-canvas simulation must match byte-for-byte. Node's
// native TS type-stripping lets this .js test import the engine's .ts directly.
import { computeCrossFilterSlice } from "../re_api/src/compute/crossFilter.ts";

const composed = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  data: {
    values: [
      { Week: 1, Sales: 10, Region: "East" },
      { Week: 2, Sales: 14, Region: "West" },
    ],
  },
  vconcat: [{
    layer: [{
      mark: "line",
      encoding: {
        x: { field: "Week", type: "quantitative" },
        y: { field: "Sales", type: "quantitative" },
      },
    }],
  }],
};

const filterSpec = {
  data: { values: [{ group: "Fish", depth: 1000 }, { group: "Corals", depth: 6000 }] },
  mark: "bar",
  encoding: { x: { field: "group" }, y: { field: "depth" } },
};

test("normalizes canonical, specMap, and raw Vega-Lite JSON inputs", () => {
  const canonical = normalizeDashboardDocument({
    dashboard: {
      title: "Sales",
      kpis: [{ label: "Revenue", value: "$24k", computed: true }],
      kpiStyle: "product",
      kpiLayout: "side-rail",
      kpiAlignment: "end",
      kpiDensity: "dense",
      kpiChrome: "ruled",
    },
    tiles: [{ id: "trend", spec: composed }],
  });
  assert.equal(canonical.tiles[0].id, "trend");
  assert.ok(canonical.tiles[0].bounds);
  assert.ok(canonical.dashboard.canvasWidth >= 1100);
  assert.ok(canonical.dashboard.canvasHeight >= 720);
  assert.equal(canonical.dashboard.kpiStyle, "product");
  assert.equal(canonical.dashboard.kpiLayout, "side-rail");
  assert.equal(canonical.dashboard.kpiAlignment, "end");
  assert.equal(canonical.dashboard.kpiDensity, "dense");
  assert.equal(canonical.dashboard.kpiChrome, "ruled");
  assert.equal(canonical.dashboard.kpis.length, 1);

  const specMap = normalizeDashboardDocument({
    board: { title: "Sales" },
    specMap: { trend: composed },
  });
  assert.equal(specMap.tiles[0].id, "trend");

  const raw = normalizeDashboardDocument(composed, "trend.json");
  assert.equal(raw.dashboard.title, "trend");
  assert.equal(raw.tiles.length, 1);
});

test("recognizes embedded KPI tiles without creating a second KPI band", () => {
  const normalized = normalizeDashboardDocument({
    dashboard: { title: "Sales", hasKpis: false },
    tiles: [{
      id: "kpi-revenue",
      label: "Total Revenue",
      bounds: { x: 28, y: 96, w: 336, h: 120 },
      spec: {
        data: { values: [{ x: 0 }] },
        mark: { type: "text" },
        encoding: { text: { value: "$4.28M" } },
      },
    }],
  });
  assert.equal(normalized.dashboard.hasKpis, false);
  assert.equal(normalized.dashboard.hasEmbeddedKpis, true);
});

test("dashboard controls render as inert or wired filters from their metadata", () => {
  const spec = {
    data: { values: [{ group: "Fish", depth: 1000 }, { group: "Corals", depth: 6000 }] },
    mark: "bar",
    encoding: { x: { field: "group" }, y: { field: "depth" } },
  };
  const controls = [
    { id: "group", kind: "category", field: "group", targets: ["chart"], value: "Fish", wired: false },
    { id: "depth", kind: "range", field: "depth", targets: ["chart"], value: 5000, wired: true },
  ];
  const filtered = applyDashboardFilterState(spec, controls, "chart");
  assert.equal(filtered.transform.length, 1);
  assert.match(filtered.transform[0].filter, /depth/);
  controls[0].wired = true;
  const fullyFiltered = applyDashboardFilterState(spec, controls, "chart");
  assert.equal(fullyFiltered.transform.length, 2);
  assert.match(fullyFiltered.transform[0].filter, /group/);
});

test("filter presentation adapts to task shape and preserves authored overrides", () => {
  const normalized = normalizeDashboardDocument({
    dashboard: {
      title: "Filter study",
      filters: [
        {
          id: "group",
          kind: "category",
          field: "group",
          targets: ["chart"],
          options: ["Fish", "Corals", "Birds"],
          wired: true,
        },
        {
          id: "depth",
          kind: "range",
          field: "depth",
          targets: ["chart"],
          min: 0,
          max: 6000,
          wired: true,
          placement: "right-rail",
          container: "panel",
        },
      ],
    },
    tiles: [{ id: "chart", spec: filterSpec }],
  });
  assert.equal(normalized.dashboard.filters[0].variant, "segmented");
  assert.equal(normalized.dashboard.filters[0].placement, "top-row");
  assert.equal(normalized.dashboard.filters[1].variant, "slider");
  assert.equal(normalized.dashboard.filters[1].placement, "right-rail");
  assert.equal(normalized.dashboard.filters[1].container, "panel");
});

test("checkbox filters apply a multi-value category selection", () => {
  const filtered = applyDashboardFilterState(filterSpec, [{
    id: "group",
    kind: "category",
    field: "group",
    targets: ["chart"],
    value: ["Fish", "Corals"],
    wired: true,
  }], "chart");
  assert.equal(filtered.transform.length, 1);
  assert.match(filtered.transform[0].filter, /indexof/);
  assert.match(filtered.transform[0].filter, /Fish/);
  assert.match(filtered.transform[0].filter, /Corals/);
});

test("dashboard controls reach composed units that own or inherit the target field", () => {
  const controls = [{
    id: "week",
    kind: "range",
    field: "Week",
    targets: ["trend"],
    value: 1,
    wired: true,
  }];
  const filtered = applyDashboardFilterState(composed, controls, "trend");
  const unit = walkUnitSpecs(filtered)[0];
  assert.equal(unit.spec.transform.length, 1);
  assert.match(unit.spec.transform[0].filter, /Week/);
  assert.equal(filtered.transform, undefined);
});

test("walkUnitSpecs preserves inherited inline data for nested marks", () => {
  const units = walkUnitSpecs(composed);
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].path, ["vconcat", 0, "layer", 0]);
  assert.equal(units[0].rows[0].Week, 1);
});

test("builds tooltip scenarios from uploaded data rather than demo constants", () => {
  const scenario = buildInteractionScenario({
    tileId: "trend",
    interactionKind: "hover-tooltip",
    target: {
      ref: { tile: "trend", specPaths: [["vconcat", 0, "layer", 0]] },
    },
  }, { trend: composed });
  assert.equal(scenario.sourceTile, "trend");
  assert.deepEqual(scenario.values, [
    { field: "Week", value: 1 },
    { field: "Sales", value: 10 },
  ]);
});

test("builds cross-filter scenarios and source styling from actual field values", () => {
  const source = {
    data: { values: [{ Region: "East", Sales: 10 }, { Region: "West", Sales: 14 }] },
    hconcat: [{
      mark: "bar",
      encoding: {
        x: { field: "Region", type: "nominal" },
        y: { field: "Sales", type: "quantitative" },
      },
    }],
  };
  const scenario = buildInteractionScenario({
    interactionKind: "cross-filter",
    target: { ref: { source: "source", targets: ["target"], field: "Region" } },
  }, { source, target: composed });
  assert.equal(scenario.value, "East");
  assert.equal(scenario.field, "Region");

  const selected = applySourceSelectionState(source, { field: "Region", value: "East" });
  const unit = walkUnitSpecs(selected)[0];
  assert.equal(unit.spec.mark.cursor, "pointer");
  assert.ok(unit.spec.encoding.opacity);
});

test("infers the interaction kind from proposal.kind when the model omits interactionKind", () => {
  const source = {
    data: { values: [{ Region: "East", Sales: 10 }, { Region: "West", Sales: 14 }] },
    hconcat: [{
      mark: "bar",
      encoding: {
        x: { field: "Region", type: "nominal" },
        y: { field: "Sales", type: "quantitative" },
      },
    }],
  };
  // No interactionKind on the critique — only the executable proposal kind. The
  // scenario must still resolve so the Proposed preview is a real coordinated
  // state rather than an identical (fake) copy of Original.
  const crossFilter = buildInteractionScenario({
    proposal: { kind: "add-cross-filter" },
    target: { ref: { source: "source", targets: ["target"], field: "Region" } },
  }, { source, target: composed });
  assert.equal(crossFilter.kind, "cross-filter");
  assert.equal(crossFilter.value, "East");

  // The show-filter-state follow-up also carries no interactionKind; it recovers
  // the coordination from the applied cross-filter usermeta.
  const withCoordination = {
    ...source,
    usermeta: { crossFilter: { role: "source", field: "Region", targets: ["target"] } },
  };
  const followUp = buildInteractionScenario({
    proposal: { kind: "show-filter-state" },
    target: { ref: { source: "source" } },
  }, { source: withCoordination, target: composed });
  assert.equal(followUp.kind, "cross-filter");
  assert.equal(followUp.showsFilterState, true);

  const tooltip = buildInteractionScenario({
    proposal: { kind: "add-tooltip" },
    target: { ref: { tile: "trend", specPaths: [["vconcat", 0, "layer", 0]] } },
    tileId: "trend",
  }, { trend: composed });
  assert.equal(tooltip.kind, "hover-tooltip");
});

test("cross-filter target keeps the full-data quantitative domain during simulation", () => {
  const line = {
    data: {
      values: [
        { Week: 1, Region: "East", Sales: 10 },
        { Week: 1, Region: "West", Sales: 14 },
        { Week: 2, Region: "East", Sales: 12 },
        { Week: 2, Region: "West", Sales: 18 },
      ],
    },
    mark: "line",
    encoding: {
      x: { field: "Week", type: "ordinal" },
      y: { field: "Sales", type: "quantitative" },
    },
  };
  const filtered = applyTargetFilterState(line, { field: "Region", value: "East" });
  assert.match(filtered.transform[0].filter, /Region/);
  assert.deepEqual(filtered.encoding.y.scale.domain, [0, 32]);
});

// Execute the Vega filter expression the simulation actually emits, so row parity
// is proven behaviorally rather than by re-implementing the predicate. Vega's
// `toString` is JS `String` for scalars, and `datum` is the row under test.
function rowsSurvivingEmittedFilter(spec, selection) {
  const expr = applyTargetFilterState(spec, selection).transform[0].filter;
  const predicate = new Function("datum", "toString", `return (${expr});`);
  return (spec.data.values || []).filter((row) => predicate(row, String));
}

test("simulation row set matches the backend slice byte-for-byte (incl. mixed field types)", () => {
  // A field whose values mix number and string types — exactly where the old
  // naive `datum[field] === value` diverged from the engine's String()===String().
  const bars = {
    data: {
      values: [
        { Code: 1, Units: 4 },
        { Code: "1", Units: 7 },
        { Code: 2, Units: 9 },
      ],
    },
    mark: "bar",
    encoding: {
      x: { field: "Code", type: "nominal" },
      y: { field: "Units", type: "quantitative" },
    },
  };
  // Frontend receives the clicked datum's native value (number 1); the engine
  // receives the value stringified over the wire ("1"). Both must select the
  // same rows: Code=1 AND Code="1", never Code=2.
  const frontendRows = rowsSurvivingEmittedFilter(bars, { field: "Code", value: 1 });
  const backendRows = computeCrossFilterSlice(bars, "Code", "1").spec.data.values;
  assert.deepEqual(frontendRows, backendRows);
  assert.equal(frontendRows.length, 2);
});

test("simulation y domain equals the installed slice — line with an x channel", () => {
  const line = {
    data: {
      values: [
        { Week: 1, Region: "East", Sales: 10 },
        { Week: 1, Region: "West", Sales: 14 },
        { Week: 2, Region: "East", Sales: 12 },
        { Week: 2, Region: "West", Sales: 18 },
      ],
    },
    mark: "line",
    encoding: {
      x: { field: "Week", type: "ordinal" },
      y: { field: "Sales", type: "quantitative" },
    },
  };
  const frontend = applyTargetFilterState(line, { field: "Region", value: "East" });
  const backend = computeCrossFilterSlice(line, "Region", "East");
  assert.deepEqual(frontend.encoding.y.scale.domain, backend.spec.encoding.y.scale.domain);
  // Rows also agree with the engine slice.
  assert.deepEqual(
    rowsSurvivingEmittedFilter(line, { field: "Region", value: "East" }),
    backend.spec.data.values,
  );
});

test("simulation y domain equals the installed slice — line with no x channel", () => {
  // No x encoding: the engine pins to the largest individual value, not the sum
  // of every row. Before the fix the simulation summed into one bucket (17 -> 18)
  // while the engine used the max (9 -> 10); assert they now agree.
  const line = {
    data: {
      values: [
        { Region: "A", Sales: 5 },
        { Region: "A", Sales: 9 },
        { Region: "B", Sales: 3 },
      ],
    },
    mark: "line",
    encoding: {
      y: { field: "Sales", type: "quantitative" },
    },
  };
  const frontend = applyTargetFilterState(line, { field: "Region", value: "A" });
  const backend = computeCrossFilterSlice(line, "Region", "A");
  assert.deepEqual(backend.spec.encoding.y.scale.domain, [0, 10]);
  assert.deepEqual(frontend.encoding.y.scale.domain, backend.spec.encoding.y.scale.domain);
});
