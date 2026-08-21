import { test } from "node:test";
import assert from "node:assert/strict";
import { runDetectors } from "../src/detect/index.ts";
import { applyProposals } from "../src/apply/index.ts";
import { dashboardBoard, dashboardSpecMap } from "../fixtures/specs.ts";
import { critiquesFixture } from "./helpers.ts";
import { assembleCritique } from "../src/generate/critique.ts";

test("detects the cross-filter gap on the shared department dimension", async () => {
  const findings = runDetectors(dashboardSpecMap());
  const cf = findings.find((f) => f.kind === "cross-filter-gap");
  assert.ok(cf, "expected a cross-filter-gap finding");
  assert.equal(cf.evidence.sharedField, "department");
  assert.equal(cf.evidence.sourceTile, "department-tasks");
  assert.deepEqual(cf.evidence.targetTiles?.sort(), ["project-status", "task-velocity"]);
  assert.equal(cf.severity, "high");
});

test("detects the missing tooltip on the line-mark velocity tile only", async () => {
  const findings = runDetectors(dashboardSpecMap());
  const tips = findings.filter((f) => f.kind === "missing-tooltip");
  assert.equal(tips.length, 1);
  assert.equal(tips[0].tileId, "task-velocity");
});

test("does not flag sprint-burndown (it has points + tooltip)", async () => {
  const findings = runDetectors(dashboardSpecMap());
  assert.ok(!findings.some((f) => f.tileId === "sprint-burndown"));
});

test("produces exactly two interaction findings for the v2 dashboard", async () => {
  const interaction = runDetectors(dashboardSpecMap()).filter((f) => f.dimension === "interaction");
  assert.equal(interaction.length, 2);
});

test("detects missing hover detail inside concatenated and layered Vega-Lite specs", async () => {
  const findings = runDetectors({
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
  });
  const tooltip = findings.find((finding) => finding.kind === "missing-tooltip");
  assert.ok(tooltip);
  assert.equal(tooltip.tileId, "trends");
  assert.deepEqual(tooltip.target.ref.specPaths, [
    ["vconcat", 0, "layer", 0],
    ["vconcat", 1, "layer", 0],
  ]);
});

test("finds shared categorical fields nested inside composed specs", async () => {
  const findings = runDetectors({
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
      vconcat: [{
        mark: "line",
        point: true,
        encoding: {
          x: { field: "region", type: "nominal" },
          y: { field: "profit", type: "quantitative" },
          tooltip: [{ field: "profit" }],
        },
      }],
    },
  });
  const crossFilter = findings.find((finding) => finding.kind === "cross-filter-gap");
  assert.ok(crossFilter);
  assert.equal(crossFilter.evidence.sharedField, "region");
  assert.equal(crossFilter.evidence.sourceTile, "source");
  assert.deepEqual(crossFilter.evidence.targetTiles, ["target"]);
});

test("does not infer a click affordance from a categorical line encoding", async () => {
  const findings = runDetectors({
    first: {
      data: { values: [{ month: "Jan", value: 10 }] },
      mark: "line",
      encoding: {
        x: { field: "month", type: "ordinal" },
        y: { field: "value", type: "quantitative" },
      },
    },
    second: {
      data: { values: [{ month: "Jan", value: 12 }] },
      mark: "line",
      point: true,
      encoding: {
        x: { field: "month", type: "ordinal" },
        y: { field: "value", type: "quantitative" },
        tooltip: [{ field: "value" }],
      },
    },
  });
  assert.ok(!findings.some((finding) => finding.kind === "cross-filter-gap"));
});

test("rejects same-name fields whose observed domains do not overlap", async () => {
  const findings = runDetectors({
    source: {
      data: { values: [{ status: "Profit", value: 10 }, { status: "Loss", value: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "status", type: "nominal" },
        y: { field: "value", type: "quantitative" },
      },
    },
    target: {
      data: { values: [{ status: "Above", value: 12 }, { status: "Below", value: 4 }] },
      mark: "bar",
      encoding: {
        x: { field: "status", type: "nominal" },
        y: { field: "value", type: "quantitative" },
      },
    },
  });
  assert.ok(!findings.some((finding) => finding.kind === "cross-filter-gap"));
});

test("does not treat partially transparent emphasis points as selection affordances", async () => {
  const findings = runDetectors({
    first: {
      data: { values: [{ month: "Jan", kind: "Normal", value: 10 }] },
      mark: "point",
      encoding: {
        x: { field: "month", type: "ordinal" },
        y: { field: "value", type: "quantitative" },
        color: {
          field: "kind",
          type: "nominal",
          scale: { domain: ["Min", "Max", "Normal"], range: ["red", "blue", "transparent"] },
        },
      },
    },
    second: {
      data: { values: [{ month: "Jan", kind: "Normal", value: 12 }] },
      mark: "line",
      point: true,
      encoding: {
        x: { field: "month", type: "ordinal" },
        y: { field: "value", type: "quantitative" },
        tooltip: [{ field: "value" }],
      },
    },
  });
  assert.ok(!findings.some((finding) => finding.kind === "cross-filter-gap"));
});

test("detects missing KPIs from board chrome", async () => {
  const findings = runDetectors(dashboardSpecMap(), dashboardBoard());
  const kpi = findings.find((f) => f.kind === "missing-kpi");
  assert.ok(kpi, "expected a missing-kpi finding");
  assert.equal(kpi.proposalKind, "add-kpis");
  assert.equal(kpi.dimension, "data");
  // Suppressed once the board declares a KPI row.
  const withKpis = runDetectors(dashboardSpecMap(), { ...dashboardBoard(), hasKpis: true });
  assert.ok(!withKpis.some((f) => f.kind === "missing-kpi"));
  // Existing KPI tiles also suppress the recommendation even when legacy board
  // metadata incorrectly says there is no dedicated KPI band.
  const embedded = {
    ...dashboardSpecMap(),
    "kpi-revenue": {
      data: { values: [{ x: 0 }] },
      mark: { type: "text" },
      encoding: { text: { value: "$4.28M" } },
    },
  };
  const withEmbeddedKpi = runDetectors(embedded, { ...dashboardBoard(), hasKpis: false });
  assert.ok(!withEmbeddedKpi.some((f) => f.kind === "missing-kpi"));
  // A large narrative text panel is not a KPI just because it uses literal text.
  const narrative = {
    takeaway: {
      data: { values: [{ x: 0 }] },
      mark: { type: "text" },
      encoding: { text: { value: "Air quality improved during the period." } },
    },
  };
  const narrativeBoard = {
    ...dashboardBoard(),
    hasKpis: false,
    tiles: [{ id: "takeaway", title: "Takeaway", bounds: { x: 28, y: 96, w: 320, h: 576 } }],
  };
  assert.ok(runDetectors(narrative, narrativeBoard).some((f) => f.kind === "missing-kpi"));
});

test("detects a visible dashboard filter that is not wired to compatible views", async () => {
  const board = {
    ...dashboardBoard(),
    tiles: dashboardBoard().tiles!.map((tile) => ({
      ...tile,
      ...(tile.id === "department-tasks"
        ? { bounds: { x: 564, y: 96, w: 508, h: 258 } }
        : {}),
    })),
    filters: [{
      id: "department-filter",
      label: "Department",
      kind: "category" as const,
      field: "department",
      targets: ["department-tasks", "task-velocity"],
      options: ["Design", "Eng"],
      wired: false,
      placement: "chart-header" as const,
      anchorTile: "department-tasks",
    }],
  };
  const finding = runDetectors(dashboardSpecMap(), board)
    .find((item) => item.kind === "ineffective-filter-control");
  assert.ok(finding);
  assert.equal(finding.proposalKind, "wire-filter-control");
  assert.equal(finding.evidence.filterId, "department-filter");
  assert.deepEqual(finding.bounds, { x: 578, y: 150, w: 340, h: 54 });
  const critique = assembleCritique(finding, {
    title: "Connect the Department filter",
    issue: "The visible control is not wired.",
    rationale: "An inert control breaks the expected interaction.",
    evidence: "The Department control is visible and unwired.",
    suggestion: "Connect it to the compatible views.",
  });
  assert.equal(critique.proposal.filterId, "department-filter");
});

test("detects the shared navy palette across velocity + department tiles", async () => {
  const findings = runDetectors(dashboardSpecMap(), dashboardBoard());
  const palette = findings.find((f) => f.kind === "uniform-palette");
  assert.ok(palette, "expected a uniform-palette finding");
  assert.equal(palette.evidence.colorFamily, "blue");
  assert.deepEqual(palette.evidence.tiles?.sort(), ["department-tasks", "task-velocity"]);
  assert.equal(palette.proposalKind, "v2-palette");
  // Paired brand trade-off (they conflict by kind on the frontend).
  assert.ok(findings.some((f) => f.proposalKind === "preserve-brand-palette"));
});

test("detects the generic title and missing chart subtitles from board chrome", async () => {
  const findings = runDetectors(dashboardSpecMap(), dashboardBoard());
  assert.ok(findings.some((f) => f.kind === "generic-title" && f.proposalKind === "dashboard-title"));
  const subtitles = findings.find((f) => f.kind === "missing-subtitles");
  assert.ok(subtitles);
  assert.equal(subtitles.evidence.missingCount, 4);
  // A descriptive title + subtitle clears the generic-title finding.
  const named = runDetectors(dashboardSpecMap(), {
    ...dashboardBoard(),
    title: "Q3 Delivery Health for the Program Office",
    subtitle: "How each team is tracking against sprint targets",
  });
  assert.ok(!named.some((f) => f.kind === "generic-title"));
});

test("produces a grounded finding for every review dimension", async () => {
  const kinds = new Set(runDetectors(dashboardSpecMap(), dashboardBoard()).map((f) => f.kind));
  for (const expected of [
    "cross-filter-gap",
    "missing-tooltip",
    "missing-kpi",
    "uniform-palette",
    "preserve-brand",
    "generic-title",
    "missing-subtitles",
  ]) {
    assert.ok(kinds.has(expected as never), `expected a ${expected} finding`);
  }
});

test("no interaction findings remain after both interaction fixes are applied", async () => {
  const specMap = dashboardSpecMap();
  const critiques = await critiquesFixture();
  const outcome = await applyProposals(specMap, critiques, critiques.map((c) => c.id));
  assert.equal(outcome.rollback.rolledBack, false);
  const interaction = runDetectors(outcome.specMap).filter((f) => f.dimension === "interaction");
  assert.equal(interaction.length, 0);
});
