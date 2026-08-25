import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverDashboardCritiques,
  iterationProposalSignature,
  proseFiguresAreGrounded,
  scopeLocalReviewInput,
} from "../src/generate/discover.ts";
import type { SpecMap } from "../src/contracts.ts";
import { dashboardBoard, dashboardSpecMap, tileBounds } from "../fixtures/specs.ts";
import { SequenceClient, StubClient, diagnosisPayload } from "./helpers.ts";
import { reevaluate } from "../src/reevaluate.ts";

function clientStyleIterationSignature(item: any): string {
  const proposal = item?.proposal || {};
  const tileIds = [
    item?.tileId,
    item?.target?.ref?.tile,
    item?.target?.ref?.source,
    ...(Array.isArray(item?.target?.ref?.tiles) ? item.target.ref.tiles : []),
    ...(Array.isArray(proposal.layout) ? proposal.layout.map((entry: any) => entry?.tile) : []),
  ].filter(Boolean).sort();
  const payload = JSON.stringify({
    edits: proposal.edits || [],
    palette: proposal.palette || [],
    layout: proposal.layout || [],
    kpis: proposal.kpis || [],
    label: proposal.label || "",
    subtitle: proposal.subtitle || "",
  });
  const structure = [
    proposal.kpiLayout,
    proposal.kpiStyle,
    proposal.composition,
    proposal.filterId,
  ].filter(Boolean).join(",");
  const manualRemedy = proposal.kind === "manual"
    ? item?.recommendation || item?.suggestion || ""
    : "";
  return [
    proposal.kind || "manual",
    item?.object || "",
    item?.problem || "",
    tileIds.join(","),
    payload,
    structure,
    manualRemedy,
  ].join("|").slice(0, 800);
}

/** A model critique in the new contract: object (+ optional problem) diagnosed,
 * a recommendation leaf prescribed, grounded by evidence. This one is a manual
 * guidance leaf about a compact categorical axis. */
const critique = {
  object: "readability",
  problem: "overly complex | difficult",
  recommendation: "chart:support perception",
  kind: "dense-category-labels",
  priority: "medium",
  surface: "encoding",
  tileId: "department-tasks",
  title: "Department labels may be difficult to scan",
  issue: "The categorical department view relies on compact axis labels.",
  rationale: "Project leads need to compare departments quickly without decoding crowded labels.",
  evidence: "The department-tasks tile uses department as a categorical field on its axis.",
  suggestion: "Increase label spacing and test whether horizontal bars improve scanability.",
  judgmentBasis: ["dashboard evidence", "general design principle"],
  requiredContext: [],
  contextStatus: "not_applicable",
  evidenceRefs: [{
    source: "dashboard",
    path: "tile.department-tasks.encoding.x",
    detail: "The department-tasks tile encodes department on a compact categorical axis.",
    tileId: "department-tasks",
    field: "department",
    channel: "x",
  }],
  proposal: { kind: "manual", mode: "guidance_only" },
  target: { granularity: "chart encoding", ref: { tile: "department-tasks" } },
};

test("open-ended review uses the model's dynamic finding set", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { scope: ["chart"] },
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique])),
  );
  assert.equal(result.critiques.length, 1);
  // dimension is the prescribed recommendation leaf's branch.
  assert.equal(result.critiques[0].dimension, "chart");
  assert.equal(result.critiques[0].object, "readability");
  assert.equal(result.critiques[0].problem, "overly complex | difficult");
  assert.equal(result.critiques[0].recommendation, "chart:support perception");
  assert.equal(result.critiques[0].title, critique.title);
  assert.equal(result.critiques[0].phrasingSource, "llm");
  assert.equal(result.findings[0].kind, "dense-category-labels");
});

test("a narrowed Feedback Scope strictly excludes unchecked dimensions", async () => {
  const textCritique = {
    ...critique,
    recommendation: "text:use familiar terms",
    kind: "ambiguous-department-abbreviations",
    title: "Department abbreviations need clarification",
    suggestion: "Expand ambiguous abbreviations or provide a nearby key.",
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { scope: ["chart"] },
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique, textCritique])),
  );

  assert.ok(result.critiques.length > 0);
  assert.ok(result.critiques.every((item) => item.dimension === "chart"));
  assert.ok(result.findings.every((item) => item.dimension === "chart"));
});

test("a narrowed Feedback Scope fails clearly instead of returning a silent empty review", async () => {
  await assert.rejects(
    discoverDashboardCritiques(
      dashboardSpecMap(),
      { scope: ["layout"] },
      dashboardBoard(),
      new StubClient(diagnosisPayload([critique])),
    ),
    /no grounded critique or strength for the selected Feedback Scope/,
  );
});

test("a later narrowed round may complete cleanly after prior suggestions were exhausted", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { scope: ["layout"] },
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique])),
    undefined,
    undefined,
    undefined,
    undefined,
    0.6,
    [],
    undefined,
    {
      round: 2,
      dashboardVersion: 2,
      applied: [],
      rejectedSignatures: [],
      changedTargets: ["dashboard.layout"],
    },
  );
  assert.equal(result.critiques.length, 0);
  assert.equal(result.strengths.length, 0);
});

test("a custom-only Feedback Scope keeps uncatalogued custom feedback", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { scope: ["custom:mobile"], customTypes: ["Mobile"] },
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      critique,
      { ...critique, kind: "mobile-layout", recommendation: "layout:mobile-specific adaptation" },
    ])),
  );

  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].dimension, "other");
  assert.equal(result.critiques[0].title, critique.title);
});

test("one object×problem can retain multiple dashboard-specific manual leaves on the same tile", async () => {
  const secondLeaf = {
    ...critique,
    recommendation: "text:use familiar terms",
    kind: "ambiguous-department-abbreviations",
    priority: "low",
    title: "Department abbreviations need clarification",
    issue: "Several compact category labels do not explain their abbreviations.",
    rationale: "Readers may not be able to distinguish similarly abbreviated departments.",
    evidence: "The same department axis contains compact categorical names.",
    suggestion: "Expand ambiguous abbreviations or provide a nearby key.",
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique, secondLeaf])),
  );
  assert.equal(result.critiques.length, 2);
  assert.deepEqual(
    new Set(result.findings.map((finding) => finding.kind)),
    new Set(["dense-category-labels", "ambiguous-department-abbreviations"]),
  );
});

test("full review retains at most twenty distinct critique leaves", async () => {
  const leaves = Array.from({ length: 25 }, (_, index) => ({
    ...critique,
    kind: `legibility-leaf-${index + 1}`,
    title: `Legibility observation ${index + 1}`,
    issue: `Supported label issue ${index + 1}.`,
  }));
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload(leaves)),
  );
  assert.equal(result.critiques.length, 20);
});

test("valid shorthand evidence is canonicalized and unsupported basis labels are dropped", async () => {
  const shorthand = {
    ...critique,
    judgmentBasis: ["dashboard evidence", "audience"],
    evidenceRefs: [{
      source: "dashboard",
      path: "department-tasks.encoding.x",
      detail: "The department-tasks tile uses a categorical x encoding.",
      tileId: "department-tasks",
      field: "department",
      channel: "x",
    }],
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([shorthand])),
  );
  // "audience" is dropped: no context.audience evidence supports it.
  assert.deepEqual(result.critiques[0].judgmentBasis, ["dashboard evidence"]);
  assert.equal(result.critiques[0].evidenceRefs?.[0].path, "tile.department-tasks.encoding.x");
});

test("board typography is a valid canonical evidence address", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    {
      ...dashboardBoard(),
      typography: { titleFontPx: 30, titleFontFamily: "Georgia" },
    },
    new StubClient(diagnosisPayload([{
      ...critique,
      evidenceRefs: [{
        source: "dashboard",
        path: "typography",
        detail: "The dashboard title is set in 30px Georgia.",
      }],
    }])),
  );
  assert.equal(result.critiques[0].evidenceRefs?.[0].path, "board.typography");
});

test("a critique inherits already-validated basis and evidence from its diagnosis", async () => {
  const { judgmentBasis: _basis, evidenceRefs: _refs, ...withoutRepeatedMetadata } = critique;
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient({
      diagnoses: [{
        object: critique.object,
        problem: critique.problem,
        outcome: "evaluated_issue",
        judgmentBasis: critique.judgmentBasis,
        requiredContext: [],
        contextStatus: "not_applicable",
        evidenceRefs: critique.evidenceRefs,
        rationale: critique.rationale,
      }],
      critiques: [withoutRepeatedMetadata],
    }),
  );
  assert.equal(result.critiques.length, 1);
  assert.deepEqual(result.critiques[0].judgmentBasis, critique.judgmentBasis);
  assert.equal(result.critiques[0].evidenceRefs?.[0].path, "tile.department-tasks.encoding.x");
});

test("preliminary feedback repairs non-critical metadata instead of dropping the critique", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient({
      diagnoses: [{
        object: critique.object,
        problem: critique.problem,
        outcome: "evaluated_issue",
        judgmentBasis: critique.judgmentBasis,
        requiredContext: [],
        contextStatus: "not_applicable",
        evidenceRefs: critique.evidenceRefs,
        rationale: critique.rationale,
      }],
      critiques: [{
        ...critique,
        title: "",
        rationale: "",
        evidence: "",
        priority: "urgent",
        surface: "unknown",
        judgmentBasis: ["audience"],
        evidenceRefs: [
          { source: "dashboard", path: "tile.invented", detail: "Invalid ref." },
        ],
        proposal: { kind: "add-tooltip", mode: "executable" },
      }],
    }),
  );
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].supportStatus, "tentative");
  // dimension still comes from the prescribed leaf's branch.
  assert.equal(result.critiques[0].dimension, "chart");
  assert.equal(result.critiques[0].priority, "medium");
  assert.equal(result.critiques[0].surface, "encoding");
  // Missing copy falls back to the dashboard-specific issue, never canned leaf text.
  assert.equal(result.critiques[0].title, critique.issue);
  // A tentative DIAGNOSIS (weak/unsupported grounding) no longer forces the FIX
  // to guidance: the add-tooltip proposal is a valid, reversible component change,
  // so it stays executable and the UI flags it with the "Tentative" chip that
  // supportStatus drives. Executability is orthogonal to diagnostic confidence.
  assert.equal(result.critiques[0].proposal.mode, "executable");
  assert.equal(result.critiques[0].grounded, false);
  assert.equal(result.critiques[0].evidenceRefs?.[0].path, "tile.department-tasks.encoding.x");
});

test("an invented target tile remains a hard rejection", async () => {
  await assert.rejects(
    discoverDashboardCritiques(
      dashboardSpecMap(),
      {},
      dashboardBoard(),
      new StubClient(diagnosisPayload([{
        ...critique,
        target: { granularity: "chart", ref: { tile: "invented-tile" } },
      }])),
    ),
    /LLM_GUARDRAIL_FAILED/,
  );
});

test("definitive claims based on inferred context are marked tentative", async () => {
  const inferredTaskLeaf = {
    ...critique,
    object: "chart",
    problem: "not purposeful",
    recommendation: "chart:choose suitable encoding",
    kind: "task-fit-claim",
    title: "The chart blocks the primary task",
    issue: "This encoding prevents the intended comparison.",
    rationale: "Engineering leaders require direct department comparison.",
    suggestion: "Replace the view with a ranked comparison.",
    judgmentBasis: ["dashboard evidence", "analytical task"],
    requiredContext: ["analytical_task"],
    evidenceRefs: [
      critique.evidenceRefs[0],
      {
        source: "context",
        path: "context.goal",
        detail: "Compare department performance.",
      },
    ],
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {
      goal: "Compare department performance.",
      fieldStatus: { goal: "inferred" },
    },
    dashboardBoard(),
    new StubClient(diagnosisPayload([inferredTaskLeaf])),
  );
  assert.equal(result.critiques[0].supportStatus, "tentative");
  assert.equal(result.critiques[0].grounded, false);
});

test("open-ended review rejects invented tile ids", async () => {
  await assert.rejects(
    discoverDashboardCritiques(
      dashboardSpecMap(),
      {},
      dashboardBoard(),
      new StubClient(diagnosisPayload([{ ...critique, tileId: "invented-tile" }])),
    ),
    /LLM_GUARDRAIL_FAILED/,
  );
});

test("open-ended review requires a real model client", async () => {
  await assert.rejects(
    discoverDashboardCritiques(dashboardSpecMap(), {}, dashboardBoard(), undefined),
    /LLM_REQUIRED/,
  );
});

test("detector-backed critiques remain available when the model call fails", async () => {
  const failingClient = {
    available: () => true,
    complete: async () => { throw new Error("provider timeout"); },
    completeJson: async () => { throw new Error("provider timeout"); },
  } as never;
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Compare department performance." },
    dashboardBoard(),
    failingClient,
  );
  assert.ok(result.critiques.length > 0);
  assert.ok(result.critiques.every((item) => item.grounded));
  assert.ok(result.critiques.some((item) => item.proposal.mode === "executable"));
  // Fallback critiques carry object/problem/recommendation provenance.
  assert.ok(result.critiques.every((item) => Boolean(item.object) && Boolean(item.recommendation)));
  assert.match(result.fallbackReason || "", /provider timeout/);
});

test("a diagnosed detector gap the model left uncritiqued is filled by a fallback", async () => {
  // The model critiques one diagnosed combo (interaction|limited affordance) at
  // department-tasks, and separately diagnoses tooltip|missing as an issue but
  // writes no critique for it. The detector fallback fills that gap at
  // task-velocity without displacing the model's own critique.
  const departmentDetailLeaf = {
    ...critique,
    object: "interaction",
    problem: "limited affordance",
    recommendation: "interaction:support exploration and detail access",
    kind: "department-detail-density",
    surface: "interaction",
    tileId: "department-tasks",
    title: "Department marks need richer detail",
    issue: "The department view does not expose supporting detail for each mark.",
    rationale: "Additional detail could help readers inspect the department comparison.",
    evidence: "The department-tasks tile contains department and task fields.",
    suggestion: "Expose the supporting values on demand.",
    proposal: { kind: "manual", mode: "guidance_only" },
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient({
      diagnoses: [
        {
          object: "interaction",
          problem: "limited affordance",
          outcome: "evaluated_issue",
          judgmentBasis: ["dashboard evidence", "general design principle"],
          requiredContext: [],
          contextStatus: "not_applicable",
          evidenceRefs: critique.evidenceRefs,
          rationale: "The department view offers limited affordance for detail.",
        },
        {
          object: "tooltip",
          problem: "missing | absent | unsupported",
          outcome: "evaluated_issue",
          judgmentBasis: ["dashboard evidence", "general design principle"],
          requiredContext: [],
          contextStatus: "not_applicable",
          evidenceRefs: [{
            source: "detector",
            path: "finding.finding-tooltip-task-velocity",
            findingId: "finding-tooltip-task-velocity",
            detail: "The task-velocity line has no tooltip encoding.",
          }],
          rationale: "The task-velocity line exposes no values on hover.",
        },
      ],
      critiques: [departmentDetailLeaf],
    }),
  );
  assert.ok(result.critiques.some((item) => item.tileId === "department-tasks" && item.phrasingSource === "llm"));
  assert.ok(result.critiques.some((item) => item.tileId === "task-velocity" && item.phrasingSource === "template"));
});

test("invented cross-filter fields are downgraded to manual guidance", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Compare department performance." },
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
        ...critique,
        object: "interaction",
        problem: "limited affordance",
        recommendation: "interaction:support exploration and detail access",
        surface: "interaction",
        proposal: { kind: "add-cross-filter" },
        target: {
          granularity: "cross-view interaction",
          ref: {
            source: "department-tasks",
            targets: ["task-velocity"],
            field: "invented_field",
          },
        },
      }])),
  );
  assert.equal(result.critiques[0].proposal.kind, "manual");
});

test("an edit-layout proposal validates real tiles into an executable layout change", async () => {
  const boardWithBounds = {
    ...dashboardBoard(),
    tiles: dashboardBoard().tiles!.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] })),
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Group related views so the comparison reads top to bottom." },
    boardWithBounds,
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "layout",
      problem: "misaligned or disorganized",
      recommendation: "layout:organize related views",
      surface: "structural",
      tileId: null,
      proposal: {
        kind: "edit-layout",
        mode: "executable",
        layout: [
          { tile: "task-velocity", bounds: { x: 28, y: 700, w: 1044, h: 300 } },
          { tile: "not-a-real-tile", bounds: { x: 0, y: 0, w: 500, h: 300 } },
          { tile: "department-tasks", bounds: { x: 5, y: 5, w: 10, h: 10 } },
        ],
      },
      target: { granularity: "dashboard", ref: {} },
      evidenceRefs: [{
        source: "dashboard",
        path: "board.tiles",
        detail: "The board arranges four chart tiles.",
      }],
    }])),
  );
  const layout = result.critiques.find((c) => c.proposal.kind === "edit-layout");
  assert.ok(layout, "edit-layout should survive as executable");
  assert.equal(layout!.proposal.mode, "executable");
  // Only the well-formed box for a real tile is kept; the fake tile and the
  // degenerate 10x10 box are dropped.
  assert.deepEqual(layout!.proposal.layout, [
    { tile: "task-velocity", bounds: { x: 28, y: 700, w: 1044, h: 300 } },
  ]);
});

test("a named layout composition survives validation without model-authored pixel arithmetic", async () => {
  const boardWithBounds = {
    ...dashboardBoard(),
    tiles: dashboardBoard().tiles!.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] })),
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Make the most important view dominate the analytical path." },
    boardWithBounds,
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "layout",
      problem: "misaligned or disorganized",
      recommendation: "layout:organize related views",
      surface: "structural",
      tileId: null,
      proposal: {
        kind: "edit-layout",
        mode: "executable",
        composition: "hero-left",
        layoutTiles: boardWithBounds.tiles.map((tile) => tile.id),
      },
      target: { granularity: "dashboard", ref: {} },
      evidenceRefs: [{
        source: "dashboard",
        path: "board.tiles",
        detail: "The current equal-weight grid does not establish a dominant analytical view.",
      }],
    }])),
  );
  const layout = result.critiques.find((item) => item.proposal.kind === "edit-layout");
  assert.equal(layout?.proposal.composition, "hero-left");
  assert.deepEqual(layout?.proposal.layoutTiles, boardWithBounds.tiles.map((tile) => tile.id));
});

test("a control-placement critique cannot masquerade as a tile-layout fix", async () => {
  const boardWithControl = {
    ...dashboardBoard(),
    canvasWidth: 1100,
    canvasHeight: 720,
    tiles: dashboardBoard().tiles!.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] })),
    filters: [{
      id: "maximum-revenue",
      label: "Maximum revenue",
      kind: "range" as const,
      field: "revenue",
      targets: ["task-velocity"],
      wired: true,
      variant: "slider" as const,
      placement: "floating" as const,
      position: { x: 760, y: 82, w: 290 },
    }],
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Keep dashboard controls easy to find." },
    boardWithControl,
    new SequenceClient([diagnosisPayload([{
      ...critique,
      object: "layout",
      problem: "misaligned or disorganized",
      recommendation: "layout:organize related views",
      surface: "structural",
      tileId: null,
      title: "Keep the controls together at the top",
      issue: "The revenue threshold slider floats above the right column instead of reading as part of the main control area.",
      rationale: "Related controls should form one predictable filtering region.",
      evidence: "The Maximum revenue filter uses floating placement.",
      suggestion: "Move the slider into the same top control band so all filtering starts in one place.",
      proposal: {
        kind: "edit-layout",
        mode: "executable",
        composition: "hero-left",
        layoutTiles: boardWithControl.tiles.map((tile) => tile.id),
      },
      target: { granularity: "dashboard control", ref: {} },
      evidenceRefs: [{
        source: "dashboard",
        path: "board.filters",
        detail: "Maximum revenue is a floating slider.",
      }],
    }]), {
      repairs: [{
        index: 0,
        proposal: {
          kind: "edit-layout",
          mode: "executable",
          composition: "hero-left",
          layoutTiles: boardWithControl.tiles.map((tile) => tile.id),
        },
        target: { ref: {} },
      }],
    }]),
  );
  const controlPlacement = result.critiques.find((item) => item.title === "Keep the controls together at the top");
  assert.ok(controlPlacement);
  assert.equal(controlPlacement!.proposal.kind, "manual");
  assert.equal(controlPlacement!.proposal.mode, "guidance_only");
});

test("a vertical hero composition with too many side charts degrades to guidance", async () => {
  const base = dashboardBoard();
  const tiles = [
    ...base.tiles!.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] })),
    { id: "extra-a", title: "Extra A", bounds: { x: 28, y: 690, w: 508, h: 258 } },
    { id: "extra-b", title: "Extra B", bounds: { x: 564, y: 690, w: 508, h: 258 } },
  ];
  const specMap = {
    ...dashboardSpecMap(),
    "extra-a": { mark: "bar", data: { values: [{ category: "A", value: 1 }] }, encoding: { x: { field: "category" }, y: { field: "value" } } },
    "extra-b": { mark: "line", data: { values: [{ category: "A", value: 1 }] }, encoding: { x: { field: "category" }, y: { field: "value" } } },
  } as SpecMap;
  const result = await discoverDashboardCritiques(
    specMap,
    { goal: "Create a stronger hierarchy." },
    { ...base, canvasWidth: 1100, canvasHeight: 1000, tiles },
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "layout",
      problem: "misaligned or disorganized",
      recommendation: "layout:organize related views",
      surface: "structural",
      tileId: null,
      proposal: {
        kind: "edit-layout",
        mode: "executable",
        composition: "hero-left",
        layoutTiles: tiles.map((tile) => tile.id),
      },
      target: { granularity: "dashboard", ref: {} },
      evidenceRefs: [{ source: "dashboard", path: "board.tiles", detail: "Six dashboard tiles." }],
    }])),
  );
  const layout = result.critiques.find((item) => item.dimension === "layout");
  assert.ok(layout);
  assert.equal(layout!.proposal.kind, "manual");
  assert.equal(layout!.proposal.mode, "guidance_only");
});

test("a later review excludes an already adopted proposal signature", async () => {
  const payload = diagnosisPayload([{
    ...critique,
    proposal: {
      kind: "edit-spec",
      mode: "executable",
      edits: [{ op: "set", path: ["encoding", "x", "axis", "labelAngle"], value: -35 }],
    },
    target: { granularity: "chart", ref: { tile: "department-tasks" } },
  }]);
  const first = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(payload),
  );
  const adopted = first.critiques.find((item) => item.proposal.kind === "edit-spec");
  assert.ok(adopted);
  assert.equal(iterationProposalSignature(adopted!), clientStyleIterationSignature(adopted));
  const second = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(payload),
    undefined,
    undefined,
    undefined,
    undefined,
    0.6,
    [],
    undefined,
    {
      round: 2,
      dashboardVersion: 2,
      applied: [{
        signature: clientStyleIterationSignature(adopted),
        kind: "edit-spec",
        tileIds: ["department-tasks"],
      }],
      rejectedSignatures: [],
      changedTargets: ["department-tasks"],
    },
  );
  assert.ok(second.critiques.every((item) => iterationProposalSignature(item) !== iterationProposalSignature(adopted!)));
});

test("an edit-layout that only restates current tile bounds degrades to guidance (no-op is not executable)", async () => {
  // A layout whose boxes equal the tiles' current positions moves nothing;
  // applyLayout would return false and the apply would throw APPLY_NO_CHANGE.
  // The sanitizer must recognize the no-op and degrade to guidance so the UI
  // never offers an "executable" fix that errors on Accept.
  const boardWithBounds = {
    ...dashboardBoard(),
    tiles: [
      { id: "task-velocity", title: "Task Velocity", bounds: { x: 28, y: 96, w: 508, h: 258 } },
      { id: "department-tasks", title: "Tasks by Department", bounds: { x: 564, y: 96, w: 508, h: 258 } },
    ],
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Reorganize the dashboard." },
    boardWithBounds as never,
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "layout",
      problem: "misaligned or disorganized",
      recommendation: "layout:organize related views",
      surface: "structural",
      tileId: null,
      proposal: {
        kind: "edit-layout",
        mode: "executable",
        // Exactly the current boxes -> nothing to move.
        layout: [
          { tile: "task-velocity", bounds: { x: 28, y: 96, w: 508, h: 258 } },
          { tile: "department-tasks", bounds: { x: 564, y: 96, w: 508, h: 258 } },
        ],
      },
      target: { granularity: "dashboard", ref: {} },
      evidenceRefs: [{ source: "dashboard", path: "board.tiles", detail: "Two tiles." }],
    }])),
  );
  const layout = result.critiques.find((c) => c.dimension === "layout");
  assert.ok(layout);
  assert.equal(layout!.proposal.kind, "manual");
  assert.equal(layout!.proposal.mode, "guidance_only");
});

test("an edit-layout with no usable boxes degrades to guidance instead of a fake change", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Reorganize the dashboard." },
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "layout",
      problem: "misaligned or disorganized",
      recommendation: "layout:organize related views",
      surface: "structural",
      tileId: null,
      proposal: {
        kind: "edit-layout",
        mode: "executable",
        layout: [{ tile: "ghost-tile", bounds: { x: 0, y: 0, w: 500, h: 300 } }],
      },
      target: { granularity: "dashboard", ref: {} },
      evidenceRefs: [{ source: "dashboard", path: "board.tiles", detail: "Four tiles." }],
    }])),
  );
  const layout = result.critiques.find((c) => c.dimension === "layout");
  assert.ok(layout);
  assert.equal(layout!.proposal.kind, "manual");
  assert.equal(layout!.proposal.mode, "guidance_only");
});

test("add-kpis keeps only KPI definitions that name real fields and computes nothing itself", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Surface headline totals." },
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "data",
      problem: "missing | absent | unsupported",
      recommendation: "data:summarize key information",
      surface: "structural",
      tileId: null,
      proposal: {
        kind: "add-kpis",
        mode: "executable",
        kpiStyle: "product",
        kpis: [
          { label: "Total Tasks", tile: "department-tasks", field: "tasks", agg: "sum" },
          {
            label: "Engineering Tasks",
            tile: "department-tasks",
            field: "tasks",
            agg: "sum",
            filter: { field: "department", value: "Eng" },
          },
          { label: "Bogus", tile: "department-tasks", field: "no-such-field", agg: "sum" },
          { label: "Rows", tile: "department-tasks", agg: "count" },
        ],
      },
      target: { granularity: "dashboard", ref: {} },
      evidenceRefs: [{ source: "dashboard", path: "board.hasKpis", detail: "hasKpis = false" }],
    }])),
  );
  const kpi = result.critiques.find((c) => c.proposal.kind === "add-kpis");
  assert.ok(kpi, "add-kpis should stay executable");
  assert.equal(kpi!.proposal.kpiStyle, "product");
  const defs = kpi!.proposal.kpis as Array<{
    label: string;
    field?: string;
    filter?: { field: string; value: string | number | boolean };
  }>;
  const labels = defs.map((d) => d.label);
  assert.ok(labels.includes("Total Tasks"));
  assert.ok(labels.includes("Engineering Tasks"));
  assert.ok(labels.includes("Rows"));
  assert.ok(!labels.includes("Bogus"), "a KPI naming a non-existent field is dropped");
  assert.deepEqual(
    defs.find((d) => d.label === "Engineering Tasks")!.filter,
    { field: "department", value: "Eng" },
  );
  // No numeric value is authored by the model — only the field/agg to compute from.
  assert.ok(defs.every((d) => !("value" in d)));
});

test("add-kpis cannot stack a duplicate band above existing KPI tiles", async () => {
  const specMap = {
    ...dashboardSpecMap(),
    "kpi-revenue": {
      data: { values: [{ x: 0 }] },
      mark: { type: "text" },
      encoding: { text: { value: "$4.28M" } },
    },
  };
  const result = await discoverDashboardCritiques(
    specMap,
    { goal: "Monitor sales performance." },
    { ...dashboardBoard(), hasKpis: false },
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "data",
      recommendation: "data:summarize key information",
      tileId: null,
      proposal: {
        kind: "add-kpis",
        mode: "executable",
        kpis: [
          { label: "Total Tasks", tile: "department-tasks", field: "tasks", agg: "sum" },
        ],
      },
      target: { granularity: "dashboard", ref: {} },
      evidenceRefs: [{ source: "dashboard", path: "board.tiles", detail: "Dashboard tiles." }],
    }])),
  );
  assert.ok(
    result.critiques.every((item) => item.proposal.kind !== "add-kpis"),
    "duplicate KPI advice should not survive as noisy guidance",
  );
});

test("recompose-kpis degrades to guidance when it repeats the current presentation", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Strengthen the KPI hierarchy." },
    {
      ...dashboardBoard(),
      hasKpis: true,
      kpis: [{ label: "Total Tasks", value: "142", computed: true }],
      kpiLayout: "hero-support",
      kpiStyle: "product",
    },
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "data",
      recommendation: "data:summarize key information",
      tileId: null,
      proposal: {
        kind: "recompose-kpis",
        mode: "executable",
        kpiLayout: "hero-support",
        kpiStyle: "product",
      },
      target: { granularity: "dashboard", ref: {} },
      evidenceRefs: [{
        source: "dashboard",
        path: "board.kpiLayout",
        detail: "The current KPI composition uses a hero-support layout.",
      }],
    }])),
  );
  const item = result.critiques.find((candidate) => candidate.object === "data");
  assert.equal(item?.proposal.kind, "manual");
  assert.equal(item?.proposal.mode, "guidance_only");
});

test("an omitted cross-filter target is filled from a unique deterministic finding", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { goal: "Compare department performance.", fieldStatus: { goal: "confirmed" } },
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "interaction",
      problem: "limited affordance",
      recommendation: "interaction:support exploration and detail access",
      surface: "interaction",
      interactionKind: "cross-filter",
      judgmentBasis: ["dashboard evidence", "analytical task"],
      requiredContext: ["analytical_task"],
      contextStatus: "available",
      evidenceRefs: [{
        source: "detector",
        path: "finding.finding-crossfilter-department",
        findingId: "finding-crossfilter-department",
        detail: "Compatible views share department.",
      }, {
        source: "context",
        path: "context.goal",
        detail: "Compare department performance.",
      }],
      proposal: { kind: "add-cross-filter", mode: "executable" },
      target: { granularity: "interaction", ref: {} },
    }])),
  );
  assert.equal(result.critiques[0].proposal.mode, "executable");
  assert.equal(result.critiques[0].target.ref.source, "department-tasks");
  assert.equal(result.critiques[0].target.ref.field, "department");
  assert.deepEqual(result.critiques[0].target.ref.targets, ["task-velocity", "project-status"]);
});

test("unsupported executable proposal kinds are downgraded to manual guidance", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      // add-tooltip with no valid tile ref cannot execute.
      tileId: null,
      proposal: { kind: "add-tooltip", mode: "executable" },
      target: { granularity: "dashboard", ref: {} },
    }])),
  );
  assert.deepEqual(result.critiques[0].proposal, { kind: "manual", mode: "guidance_only" });
});

test("an evaluated_no_issue diagnosis without a critique produces no critique but is retained", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient({
      diagnoses: [{
        object: "text",
        problem: "unclear | ambiguous",
        outcome: "evaluated_no_issue",
        judgmentBasis: ["dashboard evidence", "general design principle"],
        requiredContext: [],
        contextStatus: "not_applicable",
        evidenceRefs: [{
          source: "dashboard",
          path: "board.title",
          detail: "The dashboard has a descriptive title.",
        }],
        rationale: "The visible title adequately identifies the dashboard subject.",
      }],
      critiques: [],
    }),
  );
  assert.equal(result.critiques.length, 0);
  const diagnosis = result.diagnoses.find((item) => item.object === "text");
  assert.equal(diagnosis?.outcome, "evaluated_no_issue");
});

test("personal preference can be grounded by an explicit context note", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { notes: ["I prefer a restrained single-color palette."] },
    dashboardBoard(),
    new StubClient({
      diagnoses: [{
        object: "color",
        problem: "not purposeful",
        outcome: "evaluated_no_issue",
        judgmentBasis: ["personal preference"],
        requiredContext: ["author_intent"],
        evidenceRefs: [
          {
            source: "context",
            path: "context.notes",
            detail: "The author prefers a restrained palette.",
          },
        ],
        rationale: "The current palette is consistent with the author's stated preference.",
      }],
      critiques: [],
    }),
  );
  const diagnosis = result.diagnoses.find((item) => item.object === "color");
  assert.equal(diagnosis?.outcome, "evaluated_no_issue");
  assert.deepEqual(diagnosis?.judgmentBasis, ["personal preference"]);
});

test("AI critiques without a supported judgment basis are not emitted", async () => {
  await assert.rejects(
    discoverDashboardCritiques(
      dashboardSpecMap(),
      {},
      dashboardBoard(),
      new StubClient(diagnosisPayload([{
        ...critique,
        judgmentBasis: [],
      }])),
    ),
    /LLM_GUARDRAIL_FAILED/,
  );
});

test("an uncatalogued reflection is kept on merit as guidance", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      recommendation: "chart:invented leaf",
    }])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  // Admitted on merit: object + evidence + grounding + suggestion all survive.
  assert.equal(kept.object, "readability");
  assert.equal(kept.suggestion, critique.suggestion);
  assert.ok((kept.evidenceRefs?.length || 0) >= 1);
  assert.ok((kept.judgmentBasis?.length || 0) >= 1);
  // Uncatalogued: no leaf id recorded, but the valid empirical branch prefix
  // still routes the observation for grouping/scope.
  assert.equal(kept.recommendation, undefined);
  assert.equal(kept.dimension, "chart");
  // This model response supplied no component proposal, so it remains guidance.
  assert.equal(kept.proposal.mode, "guidance_only");
});

test("an uncatalogued component fix stays executable after normal safety validation", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      recommendation: "chart:invented leaf",
      proposal: { kind: "add-tooltip", mode: "executable" },
      target: { granularity: "chart", ref: { tile: "department-tasks" } },
    }])),
  );
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].dimension, "chart");
  assert.equal(result.critiques[0].proposal.kind, "add-tooltip");
  assert.equal(result.critiques[0].proposal.mode, "executable");
});

test("an uncatalogued fix routes through its empirical object lens in a narrowed scope", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { scope: ["cognition"] },
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      recommendation: undefined,
      proposal: { kind: "add-tooltip", mode: "executable" },
      target: { granularity: "chart", ref: { tile: "department-tasks" } },
    }])),
  );
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].dimension, "cognition");
  assert.equal(result.critiques[0].recommendation, undefined);
  assert.equal(result.critiques[0].proposal.mode, "executable");
});

test("a catalogued recommendation still routes to its branch dimension", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique])),
  );
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].recommendation, "chart:support perception");
  assert.equal(result.critiques[0].dimension, "chart");
});

test("a dashboard-specific palette is sanitized and retained", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      object: "color",
      problem: "inconsistent | mismatched",
      recommendation: "color:encode and distinguish meaning",
      proposal: {
        kind: "v2-palette",
        mode: "executable",
        palette: ["#264653", "not-a-color", "#e9c46a", "#264653", "#e76f51"],
      },
    }])),
  );
  assert.deepEqual(result.critiques[0].proposal.palette, ["#264653", "#e9c46a", "#e76f51"]);
});

test("a component-level fix is executable through the general edit-spec proposal", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      recommendation: "chart:support perception",
      suggestion: "Sort the department axis by descending tasks so the ranking reads directly.",
      proposal: {
        kind: "edit-spec",
        mode: "executable",
        edits: [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }],
      },
      target: { granularity: "chart", ref: { tile: "department-tasks" } },
    }])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.proposal.kind, "edit-spec");
  assert.equal(kept.proposal.mode, "executable");
  assert.equal(kept.target.ref.tile, "department-tasks");
  // The engine keeps the sanitized edits on the proposal so /apply re-applies
  // exactly what was validated.
  assert.deepEqual(kept.proposal.edits, [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }]);
});

test("an edit-spec whose edits are all unsafe is downgraded to manual guidance", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      recommendation: "chart:support perception",
      proposal: {
        kind: "edit-spec",
        mode: "executable",
        // Fabricating data and referencing an invented field are both rejected
        // by the sanitizer, leaving no applyable edit.
        edits: [
          { op: "set", path: ["data", "values"], value: [{ department: "New", tasks: 999 }] },
          { op: "set", path: ["encoding", "color"], value: { field: "invented", type: "nominal" } },
        ],
      },
      target: { granularity: "chart", ref: { tile: "department-tasks" } },
    }])),
  );
  assert.equal(result.critiques.length, 1);
  assert.deepEqual(result.critiques[0].proposal, { kind: "manual", mode: "guidance_only" });
});

test("design-process advice stays guidance-only even when the model marks it executable", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      // A design-process leaf is meta advice the author acts on outside the
      // artifact, so it can never be an executable component change.
      recommendation: "design process:prototype early",
      suggestion: "Sketch a couple of rough layout variants before committing to this one.",
      proposal: {
        kind: "edit-spec",
        mode: "executable",
        edits: [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }],
      },
      target: { granularity: "chart", ref: { tile: "department-tasks" } },
    }])),
  );
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].dimension, "design process");
  assert.deepEqual(result.critiques[0].proposal, { kind: "manual", mode: "guidance_only" });
});

/** A design-process/workflow critique about the process rather than a mark, with
 * a design-process recommendation leaf, no resolvable evidenceRef, and only the
 * always-available "general design principle" basis. */
const processCritique = {
  object: "design process",
  recommendation: "design process:iterate and evaluate",
  kind: "no-evaluation-loop",
  priority: "medium",
  surface: "structural",
  tileId: null,
  title: "No feedback or evaluation loop is evident",
  issue: "The board shows no evidence of a review or usability-check cadence.",
  rationale: "Dashboards drift from user needs without a periodic evaluation step.",
  evidence: "No subtitle, annotation, or metadata indicates an evaluation cadence.",
  suggestion: "Set a regular usability check-in and revise the layout from that feedback.",
  judgmentBasis: ["general design principle"],
  requiredContext: [],
  contextStatus: "not_applicable",
  evidenceRefs: [],
  proposal: { kind: "manual", mode: "guidance_only" },
  target: { granularity: "dashboard", ref: {} },
};

test("a design-process critique survives with no resolvable evidence ref, as tentative guidance-only", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {}, // no goal/audience/constraints -> no context refs available
    dashboardBoard(),
    new StubClient(diagnosisPayload([processCritique])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.dimension, "design process");
  assert.deepEqual(kept.proposal, { kind: "manual", mode: "guidance_only" });
  assert.deepEqual(kept.evidenceRefs, []);
  assert.deepEqual(kept.judgmentBasis, ["general design principle"]);
  assert.equal(kept.supportStatus, "tentative");
  assert.equal(kept.grounded, false);
});

test("the empty-ref relaxation is scoped to advisory branches: a component critique with no ref is still dropped", async () => {
  // Same empty-ref shape, but a chart-branch (component) recommendation. A real
  // artifact ref is still mandatory here, so this must NOT slip through.
  await assert.rejects(
    discoverDashboardCritiques(
      dashboardSpecMap(),
      {},
      dashboardBoard(),
      new StubClient(diagnosisPayload([{
        ...processCritique,
        object: "readability",
        recommendation: "chart:support perception",
        kind: "unref-chart-fix",
        evidenceRefs: [],
        judgmentBasis: ["general design principle"],
      }])),
    ),
    /LLM_GUARDRAIL_FAILED/,
  );
});

test("advisory guidance-only critiques are capped at the reserve so they cannot flood a review", async () => {
  // Five distinct, valid design-process critiques; only GUIDANCE_RESERVE (3) survive.
  const leaves = [
    "design process:iterate and evaluate",
    "design process:involve stakeholders",
    "design process:formalize process",
    "design process:study users",
    "design process:prototype early",
  ];
  const processLeaves = leaves.map((recommendation, index) => ({
    ...processCritique,
    recommendation,
    kind: `process-leaf-${index + 1}`,
    title: `Process observation ${index + 1}`,
    issue: `Supported process gap ${index + 1}.`,
  }));
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload(processLeaves)),
  );
  assert.equal(result.critiques.length, 3);
  assert.ok(result.critiques.every((c) => c.dimension === "design process"));
});

test("a validated design-process critique is reserved a slot instead of being crowded out by executable fixes", async () => {
  // Twenty strong, validated executable critiques would fill every slot on their
  // own (limit 20). Two tentative design-process critiques rank below them, so
  // pure ranking would cut both; the reserve guarantees they still appear.
  const chartLeaves = Array.from({ length: 20 }, (_, index) => ({
    ...critique,
    kind: `legibility-leaf-${index + 1}`,
    title: `Legibility observation ${index + 1}`,
    issue: `Supported label issue ${index + 1}.`,
  }));
  const processLeaves = [
    { ...processCritique, recommendation: "design process:iterate and evaluate", kind: "no-evaluation-loop", title: "No evaluation loop", issue: "No evaluation cadence is evident." },
    { ...processCritique, recommendation: "design process:involve stakeholders", kind: "no-stakeholder-input", title: "No stakeholder input", issue: "No sign stakeholders were consulted." },
  ];
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([...chartLeaves, ...processLeaves])),
  );
  assert.equal(result.critiques.length, 20);
  const processCount = result.critiques.filter((c) => c.dimension === "design process").length;
  assert.equal(processCount, 2);
});

test("a guidance-only component fix is repaired into an executable edit-spec via a follow-up call", async () => {
  // The review leaves a grounded, component-level fix as prose. The repair pass
  // asks the model to encode its own suggestion as a proposal; it is validated
  // and compile-checked through the same gate /apply uses, then promoted so the
  // fix runs the full pipeline.
  const client = new SequenceClient([
    diagnosisPayload([{
      ...critique,
      recommendation: "chart:support perception",
      suggestion: "Sort the department axis by descending tasks so the ranking reads directly.",
      proposal: { kind: "manual", mode: "guidance_only" },
      target: { granularity: "chart", ref: { tile: "department-tasks" } },
    }]),
    { repairs: [{
      index: 0,
      proposal: { kind: "edit-spec", mode: "executable", edits: [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }] },
      target: { ref: { tile: "department-tasks" } },
    }] },
  ]);
  const result = await discoverDashboardCritiques(dashboardSpecMap(), {}, dashboardBoard(), client);
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.proposal.kind, "edit-spec");
  assert.equal(kept.proposal.mode, "executable");
  assert.equal(kept.target.ref.tile, "department-tasks");
  assert.deepEqual(kept.proposal.edits, [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }]);
  // The finding's proposalKind is updated so downstream routing treats it as executable.
  assert.equal(result.findings[0].proposalKind, "edit-spec");
  // The repair call carries the tile spec and the model's own suggestion.
  assert.match(client.userTexts[1], /Encode each item's suggestion/);
  assert.match(client.userTexts[1], /"tileId": "department-tasks"/);
});

test("a guidance-only board-level fix is repaired into an executable board proposal", async () => {
  // A dashboard-framing fix (no tile) is a component too: the repair pass routes
  // it to a dedicated board proposal validated by the same gate.
  const client = new SequenceClient([
    diagnosisPayload([{
      ...critique,
      tileId: null,
      recommendation: "chart:support perception",
      suggestion: "Give the dashboard a descriptive title that names the metric and audience.",
      proposal: { kind: "manual", mode: "guidance_only" },
      target: { granularity: "dashboard", ref: {} },
    }]),
    { repairs: [{
      index: 0,
      proposal: { kind: "dashboard-title", mode: "executable", label: "Department Task Load for Team Leads" },
      target: { ref: {} },
    }] },
  ]);
  const result = await discoverDashboardCritiques(dashboardSpecMap(), {}, dashboardBoard(), client);
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.proposal.kind, "dashboard-title");
  assert.equal(kept.proposal.mode, "executable");
  assert.equal(kept.proposal.label, "Department Task Load for Team Leads");
  assert.equal(kept.target.granularity, "dashboard");
});

test("the repair pass leaves a fix guidance-only when it returns no safe proposal", async () => {
  // The model's repair proposal fabricates data / references an invented field,
  // so nothing survives sanitization and the critique honestly stays guidance-only.
  const client = new SequenceClient([
    diagnosisPayload([{
      ...critique,
      recommendation: "chart:support perception",
      proposal: { kind: "manual", mode: "guidance_only" },
      target: { granularity: "chart", ref: { tile: "department-tasks" } },
    }]),
    { repairs: [{
      index: 0,
      proposal: { kind: "edit-spec", mode: "executable", edits: [
        { op: "set", path: ["data", "values"], value: [{ department: "New", tasks: 1 }] },
        { op: "set", path: ["encoding", "color"], value: { field: "invented", type: "nominal" } },
      ] },
      target: { ref: { tile: "department-tasks" } },
    }] },
  ]);
  const result = await discoverDashboardCritiques(dashboardSpecMap(), {}, dashboardBoard(), client);
  assert.equal(result.critiques.length, 1);
  assert.deepEqual(result.critiques[0].proposal, { kind: "manual", mode: "guidance_only" });
});

test("the repair pass never touches design-process guidance", async () => {
  // A design-process leaf is inherently non-artifact advice; even if the model
  // returns a proposal for it, the repair pass must not issue a call that promotes it.
  const client = new SequenceClient([
    diagnosisPayload([{
      ...critique,
      recommendation: "design process:prototype early",
      suggestion: "Sketch a couple of rough layout variants before committing.",
      proposal: { kind: "manual", mode: "guidance_only" },
      target: { granularity: "chart", ref: { tile: "department-tasks" } },
    }]),
    { repairs: [{
      index: 0,
      proposal: { kind: "edit-spec", mode: "executable", edits: [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }] },
      target: { ref: { tile: "department-tasks" } },
    }] },
  ]);
  const result = await discoverDashboardCritiques(dashboardSpecMap(), {}, dashboardBoard(), client);
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].dimension, "design process");
  assert.deepEqual(result.critiques[0].proposal, { kind: "manual", mode: "guidance_only" });
  // No repair call was made: the only user text is the review prompt.
  assert.equal(client.userTexts.length, 1);
});

test("a critique with an invalid object code is rejected", async () => {
  await assert.rejects(
    discoverDashboardCritiques(
      dashboardSpecMap(),
      {},
      dashboardBoard(),
      new StubClient({
        diagnoses: [],
        critiques: [{ ...critique, object: "not-an-object" }],
      }),
    ),
    /LLM_GUARDRAIL_FAILED/,
  );
});

test("detector reevaluation does not supersede model-discovered findings", async () => {
  const discovered = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique])),
  );
  const result = reevaluate(discovered.critiques, [], dashboardSpecMap(), [], dashboardBoard());
  assert.equal(result.critiques[0].status, "pending");
  assert.equal(result.delta.removed.length, 0);
});

test("local review scope includes only tiles that intersect the selected area", () => {
  const board = dashboardBoard();
  board.tiles = board.tiles?.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] }));
  const scoped = scopeLocalReviewInput(
    dashboardSpecMap(),
    board,
    {
      bounds: { x: 40, y: 110, w: 180, h: 120 },
      request: "Check whether this trend is easy to interpret.",
      dimension: "chart",
    },
  );

  assert.deepEqual(Object.keys(scoped.specMap), ["task-velocity"]);
  assert.deepEqual(scoped.board?.tiles?.map((tile) => tile.id), ["task-velocity"]);
  assert.equal(scoped.region?.dimension, "chart");
});

test("local review requires a direct answer and preserves the author's request", async () => {
  const board = dashboardBoard();
  board.tiles = board.tiles?.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] }));
  const localCritique = {
    ...critique,
    object: "tooltip",
    problem: "missing | absent | unsupported",
    recommendation: "interaction:support exploration and detail access",
    surface: "interaction",
    tileId: "task-velocity",
    interactionKind: "hover-tooltip",
    answer: "Yes—the missing hover detail explains why exact values are difficult to inspect.",
    title: "Expose exact values on hover",
    issue: "The selected trend does not expose exact values on hover.",
    rationale: "The author's question asks how to inspect individual trend values.",
    evidence: "The selected task-velocity chart has no tooltip encoding.",
    suggestion: "Add a tooltip with the period and velocity values.",
    evidenceRefs: [{
      source: "detector",
      path: "finding.finding-tooltip-task-velocity",
      findingId: "finding-tooltip-task-velocity",
      detail: "The selected task-velocity line has no tooltip encoding.",
    }],
    proposal: { kind: "add-tooltip", mode: "executable" },
    target: { granularity: "chart", ref: { tile: "task-velocity" } },
  };
  const relatedCritique = {
    ...critique,
    tileId: "task-velocity",
    title: "Keep the month labels easy to scan",
    issue: "The selected chart relies on a compact ordinal month axis.",
    rationale: "Dense labels can make a trend harder to scan even when exact values are available.",
    evidence: "The selected chart encodes month on the x-axis.",
    suggestion: "Preserve sufficient spacing for the month labels.",
    evidenceRefs: [{
      source: "dashboard",
      path: "tile.task-velocity.encoding.x",
      detail: "The selected chart uses month on the x-axis.",
      tileId: "task-velocity",
      field: "month",
      channel: "x",
    }],
    proposal: { kind: "manual", mode: "guidance_only" },
    target: { granularity: "chart", ref: { tile: "task-velocity" } },
  };
  const higherSeverityDuplicate = {
    ...localCritique,
    answer: undefined,
    priority: "high",
    title: "Related tooltip observation",
  };
  const client = new StubClient(diagnosisPayload([
    localCritique,
    higherSeverityDuplicate,
    relatedCritique,
  ]));
  const request = "Why is it difficult to inspect exact values, and how should I fix it?";
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    board,
    client,
    undefined,
    {
      bounds: { x: 40, y: 110, w: 180, h: 120 },
      request,
    },
  );

  assert.equal(result.critiques.length, 2);
  assert.equal(result.critiques[0]?.requestRelevance, "direct");
  assert.equal(result.critiques[0]?.reviewRequest, request);
  assert.match(result.critiques[0]?.answer || "", /^Yes/);
  assert.equal(
    result.critiques.find((item) => item.object === "readability")?.requestRelevance,
    undefined,
  );
  assert.match(client.firstUserText, /"kind": "selected-region"/);
});

test("local review adds direct guidance when model output does not answer the request", async () => {
  const board = dashboardBoard();
  board.tiles = board.tiles?.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] }));
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    board,
    new StubClient(diagnosisPayload([{
        ...critique,
        object: "tooltip",
        problem: "missing | absent | unsupported",
        recommendation: "interaction:support exploration and detail access",
        surface: "interaction",
        tileId: "task-velocity",
        interactionKind: "hover-tooltip",
        evidenceRefs: [{
          source: "detector",
          path: "finding.finding-tooltip-task-velocity",
          findingId: "finding-tooltip-task-velocity",
          detail: "The selected task-velocity line has no tooltip encoding.",
        }],
        proposal: { kind: "add-tooltip", mode: "executable" },
        target: { granularity: "chart", ref: { tile: "task-velocity" } },
    }])),
    undefined,
    {
      bounds: { x: 40, y: 110, w: 180, h: 120 },
      request: "Explain the problem and suggest how I should improve it.",
    },
  );
  const direct = result.critiques.find((item) => item.requestRelevance === "direct");
  assert.ok(direct);
  assert.equal(direct.proposal.mode, "guidance_only");
  assert.match(direct.answer || "", /No material issue was validated/);
});

test("local review drops a critique targeting a tile outside the selection but still surfaces the answer", async () => {
  const board = dashboardBoard();
  board.tiles = board.tiles?.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] }));
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    board,
    new StubClient(diagnosisPayload([{
      ...critique,
      tileId: "department-tasks",
      answer: "The selected chart should be revised.",
    }])),
    undefined,
    {
      bounds: { x: 40, y: 110, w: 180, h: 120 },
      request: "Review this trend chart.",
    },
  );
  // The invalid executable card is dropped, but the direct answer is preserved
  // as an explicit guidance-only critique tied to the selected region.
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].proposal.mode, "guidance_only");
  assert.equal(result.critiques[0].requestRelevance, "direct");
  assert.deepEqual(result.critiques[0].bounds, { x: 40, y: 110, w: 180, h: 120 });
  assert.equal(result.answer, "The selected chart should be revised.");
});

test("focused review requires a direct answer and tags results for request-first ranking", async () => {
  const focusedCritique = {
      ...critique,
      answer: "Partly—the department comparison is visible, but compact labels slow scanning.",
    };
  const client = new StubClient(diagnosisPayload([focusedCritique]));
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    client,
    undefined,
    undefined,
    { request: "Does this chart make department differences easy to compare?" },
  );

  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].requestRelevance, "direct");
  assert.match(result.critiques[0].answer || "", /^Partly/);
  assert.equal(
    result.critiques[0].reviewRequest,
    "Does this chart make department differences easy to compare?",
  );
  assert.match(client.firstUserText, /"kind": "focused"/);
  assert.match(client.firstUserText, /Diagnose each object the evidence supports/);
});

test("a focused review returns guidance even when the evaluated claim has no issue", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient({
      diagnoses: [{
        object: "text",
        problem: "unclear | ambiguous",
        outcome: "evaluated_no_issue",
        judgmentBasis: ["dashboard evidence", "general design principle"],
        requiredContext: [],
        contextStatus: "not_applicable",
        evidenceRefs: [{
          source: "dashboard",
          path: "board.title",
          detail: "The dashboard has a descriptive title.",
        }],
        rationale: "The visible title adequately identifies the dashboard subject.",
      }],
      critiques: [],
    }),
    undefined,
    undefined,
    { request: "Does the dashboard title identify its subject?" },
  );
  assert.equal(result.reviewScope, "focused");
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].proposal.mode, "guidance_only");
  assert.equal(result.critiques[0].requestRelevance, "direct");
  assert.match(result.critiques[0].answer || "", /No material issue was validated/);
});

test("focused review adds direct guidance when model output does not answer the question", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique])),
    undefined,
    undefined,
    { request: "Does this chart make department differences easy to compare?" },
  );
  const direct = result.critiques.find((item) => item.requestRelevance === "direct");
  assert.ok(direct);
  assert.equal(direct.proposal.mode, "guidance_only");
});

test("focused review surfaces the answer even when the answering critique fails validation", async () => {
  // The model answers the question, but its executable critique targets a tile
  // outside the packet. Preserve the answer as a guidance-only critique.
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      tileId: "does-not-exist",
      answer: "No—the compact labels make department comparison slower than it should be.",
    }])),
    undefined,
    undefined,
    { request: "Does this chart make department differences easy to compare?" },
  );
  assert.equal(result.reviewScope, "focused");
  assert.equal(result.critiques.length, 1);
  assert.equal(result.critiques[0].proposal.mode, "guidance_only");
  assert.equal(result.critiques[0].requestRelevance, "direct");
  assert.match(result.answer || "", /^No—the compact labels/);
});

test("a full review never carries a response-level answer", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { scope: ["chart"] },
    dashboardBoard(),
    new StubClient(diagnosisPayload([{
      ...critique,
      answer: "This should be ignored for a full review.",
    }])),
  );
  // answer is a response to an explicit author request; a full review has none.
  assert.equal(result.answer, undefined);
});

/* ------------------------------------------------------------------ *
 * Cross-tile consolidation: one identical fix on several tiles collapses
 * into ONE critique carrying every affected tile in target.ref.tiles, so the
 * author reads a single card that applies everywhere on Accept. Two paths:
 * the model obeys the prompt (validatedProposal, Change B) or the engine
 * backstops per-tile duplicates it still emitted (mergeAndRank, Change C).
 * ------------------------------------------------------------------ */

/** target.ref is an open Record<string, unknown>, so `tiles` reads back as
 * `unknown`; narrow it to the string[] the engine writes for assertions. */
function tilesOf(critique: { target: { ref: Record<string, unknown> } }): string[] | undefined {
  const tiles = critique.target.ref.tiles;
  return Array.isArray(tiles) ? tiles as string[] : undefined;
}

/** An evidence ref that resolves for any tile (points at the whole tile spec,
 * which every tile has — sidesteps per-tile channel differences like the arc
 * tile lacking an x encoding). */
function tileEvidenceRef(tileId: string) {
  return {
    source: "dashboard",
    path: `tile.${tileId}`,
    detail: `The ${tileId} tile is part of this dashboard.`,
    tileId,
  };
}

/** A grounded, executable edit-spec critique on one tile. `tiles` (optional)
 * mirrors what the model would put in target.ref.tiles for a consolidated fix. */
function editSpecCritique(options: {
  tileId: string;
  edits: unknown;
  tiles?: string[];
  priority?: string;
  object?: string;
  problem?: string;
}) {
  const object = options.object ?? "chart";
  const problem = options.problem ?? "cluttered | crowded";
  return {
    object,
    problem,
    recommendation: "chart:support perception",
    kind: `crowded-labels-${options.tileId}`,
    priority: options.priority ?? "medium",
    surface: "encoding",
    tileId: options.tileId,
    title: "Axis labels are crowded",
    issue: "The axis labels overlap and are hard to read.",
    rationale: "Readers need legible axis labels to compare values.",
    evidence: `The ${options.tileId} tile renders crowded axis labels.`,
    suggestion: "Angle the axis labels so they no longer overlap.",
    judgmentBasis: ["dashboard evidence", "general design principle"],
    evidenceRefs: [tileEvidenceRef(options.tileId)],
    proposal: { kind: "edit-spec", mode: "executable", edits: options.edits },
    target: {
      granularity: "chart",
      ref: {
        tile: options.tileId,
        ...(options.tiles ? { tiles: options.tiles } : {}),
      },
    },
  };
}

const LABEL_ANGLE_EDIT = [{ op: "set", path: ["encoding", "x", "axis", "labelAngle"], value: -40 }];

test("a consolidated edit-spec the model emits keeps every affected tile in target.ref.tiles", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      editSpecCritique({
        tileId: "task-velocity",
        tiles: ["task-velocity", "department-tasks"],
        edits: LABEL_ANGLE_EDIT,
      }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.target.ref.tile, "task-velocity");
  assert.deepEqual(
    new Set(tilesOf(kept)),
    new Set(["task-velocity", "department-tasks"]),
  );
  // The one edit set is unchanged — it is applied to each tile at /apply time.
  assert.deepEqual(kept.proposal.edits, LABEL_ANGLE_EDIT);
});

test("a model-supplied tile that cannot take the fix is dropped from target.ref.tiles", async () => {
  // Setting a color encoding to {field:"department"} sanitizes only on tiles that
  // actually carry a `department` column (velocity + department tiles); the sprint
  // burndown has no such field, so the fix cannot fabricate it there.
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      editSpecCritique({
        tileId: "task-velocity",
        tiles: ["task-velocity", "department-tasks", "sprint-burndown"],
        edits: [{ op: "set", path: ["encoding", "color"], value: { field: "department", type: "nominal" } }],
      }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.deepEqual(
    new Set(tilesOf(kept)),
    new Set(["task-velocity", "department-tasks"]),
  );
  assert.ok(!tilesOf(kept)!.includes("sprint-burndown"));
});

test("a consolidated set that collapses to one tile omits target.ref.tiles", async () => {
  // `tasks` only exists on the department tile, so the second tile is filtered out
  // and the set degenerates to one — it must behave as a normal single-tile fix.
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      editSpecCritique({
        tileId: "department-tasks",
        tiles: ["department-tasks", "sprint-burndown"],
        edits: [{ op: "set", path: ["encoding", "y"], value: { field: "tasks", type: "quantitative" } }],
      }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.target.ref.tile, "department-tasks");
  assert.equal(tilesOf(kept), undefined);
});

test("the engine backstop collapses per-tile duplicates the model emitted into one card", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      // Same object/problem/leaf and IDENTICAL edits, emitted once per tile — the
      // shape the prompt nudge is meant to prevent but cannot guarantee. The
      // highest-priority member becomes the representative.
      editSpecCritique({ tileId: "task-velocity", edits: LABEL_ANGLE_EDIT, priority: "high" }),
      editSpecCritique({ tileId: "department-tasks", edits: LABEL_ANGLE_EDIT }),
      editSpecCritique({ tileId: "sprint-burndown", edits: LABEL_ANGLE_EDIT }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.tileId, "task-velocity"); // highest-ranked representative
  assert.deepEqual(
    new Set(tilesOf(kept)),
    new Set(["task-velocity", "department-tasks", "sprint-burndown"]),
  );
  // The finding mirrors the tile set so downstream consumers stay consistent.
  assert.equal(result.findings.length, 1);
  assert.deepEqual(
    new Set(tilesOf(result.findings[0])),
    new Set(["task-velocity", "department-tasks", "sprint-burndown"]),
  );
});

test("genuinely different fixes on different tiles are never merged", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      editSpecCritique({
        tileId: "task-velocity",
        edits: [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }],
      }),
      editSpecCritique({
        tileId: "department-tasks",
        edits: [{ op: "set", path: ["encoding", "x", "sort"], value: "-x" }],
      }),
    ])),
  );
  // Different edit values => different signatures => two distinct cards.
  assert.equal(result.critiques.length, 2);
  for (const kept of result.critiques) {
    assert.equal(tilesOf(kept), undefined);
  }
});

test("consolidation is order-insensitive for the edit value payload", async () => {
  // The two edits are identical up to key order inside `value`; a naive
  // JSON.stringify signature would treat them as different and refuse to merge.
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      editSpecCritique({
        tileId: "task-velocity",
        edits: [{ op: "set", path: ["encoding", "color"], value: { field: "department", type: "nominal" } }],
      }),
      editSpecCritique({
        tileId: "department-tasks",
        edits: [{ op: "set", path: ["encoding", "color"], value: { type: "nominal", field: "department" } }],
      }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  assert.deepEqual(
    new Set(tilesOf(result.critiques[0])),
    new Set(["task-velocity", "department-tasks"]),
  );
});

test("collapsing duplicates frees limit slots for other non-advisory critiques", async () => {
  // Four per-tile duplicates of one fix + seventeen distinct other critiques =
  // 21 candidates. Without consolidation the 20-critique cap would crowd one out;
  // collapsing the four into one leaves room for all seventeen (1 + 17 = 18).
  const duplicates = ["task-velocity", "department-tasks", "sprint-burndown", "project-status"].map((tileId) =>
    editSpecCritique({ tileId, edits: LABEL_ANGLE_EDIT, priority: "high" }),
  );
  const others = Array.from({ length: 17 }, (_, index) => ({
    ...critique,
    kind: `distinct-observation-${index + 1}`,
    title: `Distinct observation ${index + 1}`,
    issue: `A separate, grounded issue number ${index + 1}.`,
  }));
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([...duplicates, ...others])),
  );
  assert.equal(result.critiques.length, 18);
  const consolidated = result.critiques.find((c) => tilesOf(c));
  assert.ok(consolidated, "expected one consolidated critique");
  assert.equal(new Set(tilesOf(consolidated)).size, 4);
  // Every one of the seventeen distinct critiques survived (none crowded out).
  const keptKinds = new Set(result.findings.map((finding) => finding.kind));
  for (let index = 1; index <= 17; index += 1) {
    assert.ok(keptKinds.has(`distinct-observation-${index}`), `missing distinct-observation-${index}`);
  }
});

/* ------------------------------------------------------------------ *
 * Cross-tile consolidation is GENERAL, not edit-spec-only: any tile-portable
 * fix repeated per tile collapses into one card. add-tooltip is the second
 * consolidatable kind — it derives each tile's tooltip from that tile's own
 * encoded fields at apply time, so N identical hover critiques on sibling
 * tiles (the KPI-row hover case) become ONE multi-tile card.
 * ------------------------------------------------------------------ */

/** A grounded, executable add-tooltip critique on one tile. `tiles` (optional)
 * mirrors what the model would put in target.ref.tiles for a consolidated hover
 * fix. object/problem default to the tooltip/missing pair the KPI-hover cards
 * carry, but are overridable to exercise the (object, problem, kind) signature. */
function addTooltipCritique(options: {
  tileId: string;
  tiles?: string[];
  priority?: string;
  object?: string;
  problem?: string;
}) {
  const object = options.object ?? "tooltip";
  const problem = options.problem ?? "missing | absent | unsupported";
  return {
    object,
    problem,
    recommendation: "interaction:support exploration and detail access",
    kind: `no-hover-detail-${options.tileId}`,
    priority: options.priority ?? "medium",
    surface: "interaction",
    interactionKind: "hover-tooltip",
    tileId: options.tileId,
    title: "No detail on hover",
    issue: `The ${options.tileId} tile reveals no exact values on hover.`,
    rationale: "Readers need exact values on hover to inspect individual marks.",
    evidence: `The ${options.tileId} tile exposes no hover detail.`,
    suggestion: "Add a hover tooltip exposing the encoded fields.",
    judgmentBasis: ["dashboard evidence", "general design principle"],
    evidenceRefs: [tileEvidenceRef(options.tileId)],
    proposal: { kind: "add-tooltip", mode: "executable" },
    target: {
      granularity: "chart",
      ref: {
        tile: options.tileId,
        ...(options.tiles ? { tiles: options.tiles } : {}),
      },
    },
  };
}

test("the engine backstop collapses per-tile add-tooltip duplicates into one card", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      // The KPI-hover shape: the same "no detail on hover" fix emitted once per
      // tile because the model ignored the consolidation nudge. The highest
      // priority member becomes the representative.
      addTooltipCritique({ tileId: "task-velocity", priority: "high" }),
      addTooltipCritique({ tileId: "department-tasks" }),
      addTooltipCritique({ tileId: "sprint-burndown" }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.proposal.kind, "add-tooltip");
  assert.equal(kept.tileId, "task-velocity"); // highest-ranked representative
  assert.deepEqual(
    new Set(tilesOf(kept)),
    new Set(["task-velocity", "department-tasks", "sprint-burndown"]),
  );
  // The finding mirrors the tile set so downstream consumers stay consistent.
  assert.deepEqual(
    new Set(tilesOf(result.findings[0])),
    new Set(["task-velocity", "department-tasks", "sprint-burndown"]),
  );
});

test("a consolidated add-tooltip the model emits keeps every affected tile in target.ref.tiles", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      addTooltipCritique({
        tileId: "task-velocity",
        tiles: ["task-velocity", "department-tasks"],
      }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.target.ref.tile, "task-velocity");
  assert.deepEqual(
    new Set(tilesOf(kept)),
    new Set(["task-velocity", "department-tasks"]),
  );
});

test("a model-named add-tooltip sibling that resolves to no tile degenerates and omits target.ref.tiles", async () => {
  // The model names a non-existent sibling; exactTile drops it, so the set
  // collapses to the primary alone and must behave as a normal single-tile fix.
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      addTooltipCritique({
        tileId: "task-velocity",
        tiles: ["task-velocity", "tile-that-does-not-exist"],
      }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.target.ref.tile, "task-velocity");
  assert.equal(tilesOf(kept), undefined);
});

test("an add-tooltip and an edit-spec under the same object+problem are never merged", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      // Identical (object, problem) but different proposal kind: the signature
      // includes kind, so a hover fix and a spec edit stay separate cards even
      // when they share a diagnosis.
      addTooltipCritique({ tileId: "department-tasks", object: "chart", problem: "cluttered | crowded" }),
      editSpecCritique({ tileId: "task-velocity", edits: LABEL_ANGLE_EDIT, object: "chart", problem: "cluttered | crowded" }),
    ])),
  );
  assert.equal(result.critiques.length, 2);
  for (const kept of result.critiques) {
    assert.equal(tilesOf(kept), undefined);
  }
});

/** A composed KPI sparkline: NO top-level encoding, its fields live in the
 * vconcat/layer units. This is the shape of the real dashboard's KPI tiles, so
 * field counting must be DEEP for the executable gate and consolidation to see it. */
function kpiSparkSpec() {
  return {
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
  };
}

/** A literal-value KPI tile: a text mark showing a number, with no field
 * anywhere. A tooltip has nothing to surface here. */
function kpiNumberSpec() {
  return {
    data: { values: [{ total: 42 }] },
    mark: { type: "text" },
    encoding: { text: { value: "42" } },
  };
}

test("a composed KPI tile stays an executable add-tooltip and folds into consolidation", async () => {
  // task-velocity (flat, high) is the representative; the composed kpi-spark has no
  // top-level encoding but real fields in its units. Deep field counting is what
  // lets it survive the executable gate AND be folded in — a shallow check would
  // downgrade it to guidance and drop it from the merged card.
  const result = await discoverDashboardCritiques(
    { ...dashboardSpecMap(), "kpi-spark": kpiSparkSpec() },
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      addTooltipCritique({ tileId: "task-velocity", priority: "high" }),
      addTooltipCritique({ tileId: "kpi-spark" }),
    ])),
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.proposal.kind, "add-tooltip");
  assert.equal(kept.proposal.mode, "executable");
  assert.deepEqual(new Set(tilesOf(kept)), new Set(["task-velocity", "kpi-spark"]));
});

test("a model add-tooltip that names a composed KPI sibling keeps it (deep filter), dropping only a field-less one", async () => {
  // Model-obeys path (discover.ts sibling filter): the model itself lists both a
  // composed sibling (kpi-spark — fields live in its units, top-level encoding is
  // empty) and a truly field-less sibling (kpi-number) in target.ref.tiles. The
  // filter counts fields DEEP, so the composed sibling SURVIVES (a shallow check
  // would wrongly drop it) while the field-less one is dropped (the fix would
  // no-op there). This is the model-obeys counterpart to the backstop test above.
  const result = await discoverDashboardCritiques(
    { ...dashboardSpecMap(), "kpi-spark": kpiSparkSpec(), "kpi-number": kpiNumberSpec() },
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      addTooltipCritique({
        tileId: "task-velocity",
        priority: "high",
        tiles: ["task-velocity", "kpi-spark", "kpi-number"],
      }),
    ])),
  );
  const kept = result.critiques.find(
    (c) => c.tileId === "task-velocity" && c.proposal.kind === "add-tooltip",
  );
  assert.ok(kept, "the model-named add-tooltip should survive as executable");
  assert.equal(kept!.proposal.mode, "executable");
  assert.deepEqual(new Set(tilesOf(kept)), new Set(["task-velocity", "kpi-spark"]));
});

test("a model add-tooltip on a field-less KPI tile degrades to guidance", async () => {
  // kpi-number has no field to surface on hover, so applyTooltip would no-op. The
  // executable gate degrades it to guidance rather than present an add-tooltip that
  // throws APPLY_NO_CHANGE on accept or claims a tile it never changes.
  const result = await discoverDashboardCritiques(
    { ...dashboardSpecMap(), "kpi-number": kpiNumberSpec() },
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      addTooltipCritique({ tileId: "kpi-number" }),
    ])),
  );
  // (Other tiles carry their own detector-driven tooltip fallbacks; assert on the
  // field-less tile's own critique rather than the total count.)
  const kept = result.critiques.find((c) => c.tileId === "kpi-number");
  assert.ok(kept, "the kpi-number critique should survive as guidance");
  assert.equal(kept!.proposal.mode, "guidance_only");
  assert.notEqual(kept!.proposal.kind, "add-tooltip");
});

test("a direct-answer critique seeds a consolidation group and folds an identical non-direct sibling", async () => {
  // The direct answer (task-velocity) must be able to SEED the group and carry the
  // answer, with the identical non-direct sibling (department-tasks) folded in — ONE
  // card, not two. The direct guard only blocks folding a direct critique AWAY as a
  // member, never its role as representative.
  const request = "The axis labels overlap — can you angle them consistently?";
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([
      {
        ...editSpecCritique({ tileId: "task-velocity", edits: LABEL_ANGLE_EDIT, priority: "high" }),
        answer: "Yes — angling the labels to -40° removes the overlap.",
      },
      editSpecCritique({ tileId: "department-tasks", edits: LABEL_ANGLE_EDIT }),
    ])),
    undefined,
    undefined,
    { request },
  );
  assert.equal(result.critiques.length, 1);
  const kept = result.critiques[0];
  assert.equal(kept.requestRelevance, "direct");
  assert.equal(kept.tileId, "task-velocity");
  assert.deepEqual(new Set(tilesOf(kept)), new Set(["task-velocity", "department-tasks"]));
});

// A standout POSITIVE observation in the model contract. It is a top-level
// output (never welded to a critique) and passes the SAME grounding gate as a
// diagnosis: a real object, at least one resolvable evidenceRef, and at least
// one supported grounding label. This one reuses the department-tasks evidence
// the shared `critique` fixture already grounds.
const strength = {
  object: "layout",
  dimension: "layout",
  tileId: "department-tasks",
  title: "The department view reads cleanly left to right",
  detail: "A consistent left-to-right categorical order on the department axis.",
  judgmentBasis: ["dashboard evidence", "general design principle"],
  evidenceRefs: [{
    source: "dashboard",
    path: "tile.department-tasks.encoding.x",
    detail: "The department-tasks tile encodes department on a categorical axis.",
    tileId: "department-tasks",
    field: "department",
    channel: "x",
  }],
};

test("a grounded strength round-trips into result.strengths, independent of critiques", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique], [strength])),
  );
  assert.equal(result.strengths.length, 1);
  const built = result.strengths[0];
  assert.equal(built.object, "layout");
  assert.equal(built.title, strength.title);
  assert.equal(built.detail, strength.detail);
  assert.equal(built.tileId, "department-tasks");
  // The grouping dimension routes the positive card into the "layout" topic.
  assert.equal(built.dimension, "layout");
  // "general design principle" is always warranted; "dashboard evidence" is
  // supported by the resolved dashboard ref — both survive.
  assert.deepEqual(built.judgmentBasis, ["dashboard evidence", "general design principle"]);
  assert.equal(built.evidenceRefs[0].path, "tile.department-tasks.encoding.x");
  // Produced by a full review, so the strength is stamped with that scope.
  assert.equal(built.reviewScope, "full");
});

test("a strength is produced independently of the model's critiques array", async () => {
  // The model returns zero critiques of its own — the case the inline positive
  // card is built for (a scope with nothing wrong still earns praise). (The engine
  // may still inject grounded detector fallbacks, so this asserts on the strength
  // surviving, not on the final critique count.)
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([], [strength])),
  );
  assert.equal(result.strengths.length, 1);
  assert.equal(result.strengths[0].title, strength.title);
});

test("a strength with an invented object is dropped, not hard-rejected", async () => {
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique], [{ ...strength, object: "not-a-real-object" }])),
  );
  // The critique still validates; only the ungrounded strength is silently dropped.
  assert.equal(result.critiques.length, 1);
  assert.equal(result.strengths.length, 0);
});

test("a strength citing only an invented evidenceRef is dropped", async () => {
  const invented = {
    ...strength,
    evidenceRefs: [{
      source: "dashboard",
      path: "tile.invented-tile.encoding.x",
      detail: "A reference to a tile that does not exist.",
      tileId: "invented-tile",
    }],
  };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique], [invented])),
  );
  assert.equal(result.strengths.length, 0);
});

test("a strength with no supported judgment basis is dropped", async () => {
  // A resolvable dashboard ref, but the only cited basis is "audience" — which
  // needs audience context that is absent — so no basis survives the gate.
  const ungrounded = { ...strength, judgmentBasis: ["audience"] };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique], [ungrounded])),
  );
  assert.equal(result.strengths.length, 0);
});

test("a strength's author-facing copy is capped defensively", async () => {
  const longCopy = { ...strength, title: "T".repeat(200), detail: "D".repeat(400) };
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique], [longCopy])),
  );
  assert.equal(result.strengths.length, 1);
  // Two-line card: the summary title and the concise evidence line are each capped.
  assert.equal(result.strengths[0].title.length, 120);
  assert.equal(result.strengths[0].detail.length, 180);
});

test("an unrecognized or missing dimension defaults to 'other' without dropping the strength", async () => {
  const bogus = { ...strength, dimension: "not-a-dimension" };
  const { dimension: _drop, ...noDimension } = strength;
  const result = await discoverDashboardCritiques(
    dashboardSpecMap(),
    {},
    dashboardBoard(),
    new StubClient(diagnosisPayload([critique], [bogus, noDimension])),
  );
  // Neither the bad value nor the absence gates admission — both survive, both
  // fall through to the "other" grouping topic.
  assert.equal(result.strengths.length, 2);
  assert.ok(result.strengths.every((s) => s.dimension === "other"));
});

// ---- Numeric grounding of author-facing prose (proseFiguresAreGrounded) ----

function salesUniverseSpec(): SpecMap {
  // Rows sum to 788,122; individual values include 20,301 and 118,448.
  return {
    "kpi-sales": {
      data: {
        values: [
          { Month: "Jan", CY2023: 50000 },
          { Month: "Feb", CY2023: 20301 },
          { Month: "Nov", CY2023: 118448 },
          { Month: "Dec", CY2023: 599373 },
        ],
      },
    },
  } as unknown as SpecMap;
}

test("proseFiguresAreGrounded rejects a currency total that no aggregate supports", () => {
  // Real total is $788K; the prose claims $733K (7% off) — fabricated.
  const grounded = proseFiguresAreGrounded(
    "Sales are strong: $733K Total Sales this year.",
    ["kpi-sales"],
    salesUniverseSpec(),
  );
  assert.equal(grounded, false);
});

test("proseFiguresAreGrounded accepts the correct rounded total and a real row value", () => {
  assert.equal(
    proseFiguresAreGrounded("$788K Total Sales, peaking at $118,448 in November.", ["kpi-sales"], salesUniverseSpec()),
    true,
  );
});

test("proseFiguresAreGrounded exempts percentages, years, and small structural counts", () => {
  // None of these are policed forms, so a critique that only cites them is never
  // rejected for numeric drift even when the exact figure is not in the data.
  const spec = salesUniverseSpec();
  assert.equal(proseFiguresAreGrounded("Sales rose 20.4% versus 2022 across 3 charts.", ["kpi-sales"], spec), true);
  assert.equal(proseFiguresAreGrounded("The 2024 redesign improved clarity.", ["kpi-sales"], spec), true);
});

test("proseFiguresAreGrounded checks a data-bound count and rejects a wrong one", () => {
  const spec = { t: { data: { values: [{ band: "Good", days: 238 }, { band: "Moderate", days: 104 }] } } } as unknown as SpecMap;
  assert.equal(proseFiguresAreGrounded("Air quality was Good on 238 days.", ["t"], spec), true);
  assert.equal(proseFiguresAreGrounded("Air quality was Good on 999 days.", ["t"], spec), false);
});

test("proseFiguresAreGrounded does not reject when there is no inline data to verify against", () => {
  const spec = { t: { mark: "bar", encoding: {} } } as unknown as SpecMap;
  assert.equal(proseFiguresAreGrounded("$733K Total Sales.", ["t"], spec), true);
});
