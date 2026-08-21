import { test } from "node:test";
import assert from "node:assert/strict";
import { runCritique, runApply, clampReviewTemperature, DEFAULT_REVIEW_TEMPERATURE } from "../src/engine.ts";
import { Tracer } from "../src/trace.ts";
import { dashboardBoard, dashboardSpecMap } from "../fixtures/specs.ts";
import { StubClient, assertSubsequence, diagnosisPayload } from "./helpers.ts";
import type { Critique } from "../src/contracts.ts";

const titleCritique = {
  object: "text",
  problem: "unclear | ambiguous",
  recommendation: "text:communicate takeaways",
  kind: "clarify-purpose",
  priority: "medium",
  surface: "text",
  tileId: null,
  title: "Clarify the dashboard purpose",
  issue: "The current title is generic and does not orient the reader.",
  rationale: "Readers need a specific subject before interpreting the views.",
  evidence: "The board title is generic.",
  suggestion: "Use a subject-specific dashboard title and subtitle.",
  judgmentBasis: ["dashboard evidence", "general design principle"],
  evidenceRefs: [{
    source: "detector",
    path: "finding.finding-generic-title",
    findingId: "finding-generic-title",
    detail: "The current board title is generic.",
  }],
  proposal: {
    kind: "dashboard-title",
    mode: "executable",
    label: "Weekly Delivery Decisions",
    subtitle: "Delivery progress, capacity, and project risk at a glance",
  },
  target: { granularity: "dashboard", ref: {} },
};

const crossFilterCritique = {
  object: "interaction",
  problem: "limited affordance",
  recommendation: "interaction:support exploration and detail access",
  kind: "coordinate-department",
  priority: "high",
  surface: "interaction",
  tileId: null,
  interactionKind: "cross-filter",
  title: "Coordinate the department views",
  issue: "Selecting a department leaves the related velocity view unchanged.",
  rationale: "If department comparison is the primary goal, coordination supports that task.",
  evidence: "The department field is shared but no selection links the views.",
  suggestion: "Bind a department selection and filter the related velocity view.",
  judgmentBasis: ["dashboard evidence", "analytical task"],
  evidenceRefs: [
    {
      source: "detector",
      path: "finding.finding-crossfilter-department",
      findingId: "finding-crossfilter-department",
      detail: "Compatible views share department without a coordinated selection.",
    },
    {
      source: "context",
      path: "context.goal",
      detail: "The goal is to compare department performance.",
    },
  ],
  proposal: { kind: "add-cross-filter", mode: "executable" },
  target: {
    granularity: "interaction",
    ref: { source: "department-tasks", targets: ["task-velocity"], field: "department" },
  },
};

const tooltipCritique = {
  object: "tooltip",
  problem: "missing | absent | unsupported",
  recommendation: "interaction:support exploration and detail access",
  kind: "add-velocity-tooltip",
  priority: "medium",
  surface: "interaction",
  tileId: "task-velocity",
  interactionKind: "hover-tooltip",
  title: "Expose exact velocity values",
  issue: "The velocity line does not expose exact values on hover.",
  rationale: "Detail on demand supports accurate inspection without persistent labels.",
  evidence: "The task-velocity spec has no tooltip encoding.",
  suggestion: "Add a tooltip to the task-velocity line.",
  judgmentBasis: ["dashboard evidence", "general design principle"],
  evidenceRefs: [{
    source: "detector",
    path: "finding.finding-tooltip-task-velocity",
    findingId: "finding-tooltip-task-velocity",
    detail: "The task-velocity line has no tooltip encoding.",
  }],
  proposal: { kind: "add-tooltip", mode: "executable" },
  target: { granularity: "chart", ref: { tile: "task-velocity" } },
};

test("artifact-only review uses the unified LLM path and returns diagnostic provenance", async () => {
  const tracer = new Tracer("t-crit", { logDir: null });
  const res = await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard() },
    tracer,
    { client: new StubClient(diagnosisPayload([titleCritique])) },
  );
  const phases = tracer.events.map((event) => event.phase);
  assertSubsequence(phases, ["run_start", "evidence_start", "eligibility_start", "generate_start", "evidence_done", "eligibility_done", "guardrail_done", "rank_done", "generate_done", "done"]);
  assert.equal(res.reviewScope, "full");
  assert.equal(res.critiques.length, 1);
  assert.ok(res.critiques[0].grounded);
  assert.equal(res.critiques[0].object, "text");
  assert.equal(res.critiques[0].problem, "unclear | ambiguous");
  assert.equal(res.critiques[0].recommendation, "text:communicate takeaways");
  // dimension is the prescribed recommendation leaf's branch.
  assert.equal(res.critiques[0].dimension, "text");
  assert.equal(res.critiques[0].judgmentBasis?.[0], "dashboard evidence");
  assert.match(res.registryVersion, /^diagnostic-knowledge-v3/);
  // The run reports the diagnosis outcomes, not legacy criterion evaluations.
  assert.ok(res.diagnoses.some((diagnosis) =>
    diagnosis.object === "text" && diagnosis.outcome === "evaluated_issue"
  ));
});

test("runCritique surfaces the grounded strengths array on the response", async () => {
  const boardStrength = {
    object: "text",
    dimension: "text",
    title: "The dashboard title names its subject at a glance",
    detail: "A descriptive board title identifying the subject.",
    judgmentBasis: ["dashboard evidence", "general design principle"],
    evidenceRefs: [{
      source: "dashboard",
      path: "board.title",
      detail: "The dashboard has a descriptive title.",
    }],
  };
  const res = await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard() },
    new Tracer("t-strengths", { logDir: null }),
    { client: new StubClient(diagnosisPayload([titleCritique], [boardStrength])) },
  );
  assert.equal(res.strengths.length, 1);
  assert.equal(res.strengths[0].object, "text");
  assert.equal(res.strengths[0].title, boardStrength.title);
  // The grouping dimension reaches the response so the positive card can slot
  // into its topic group.
  assert.equal(res.strengths[0].dimension, "text");
  // Stamped with the review scope that produced it (a full review here).
  assert.equal(res.strengths[0].reviewScope, "full");
});

test("clampReviewTemperature guards the boundary the author-set slider value can reach", () => {
  // The client owns the number now, so the engine only sanitizes: in-range
  // values round to the slider's 0.1 step, out-of-range values clamp to [0, 1],
  // and anything non-finite or omitted falls back to the historical default.
  assert.equal(clampReviewTemperature(0), 0);
  assert.equal(clampReviewTemperature(1), 1);
  assert.equal(clampReviewTemperature(0.7), 0.7);
  assert.equal(clampReviewTemperature(0.24), 0.2);
  assert.equal(clampReviewTemperature(1.9), 1);
  assert.equal(clampReviewTemperature(-3), 0);
  assert.equal(clampReviewTemperature(Number.NaN), DEFAULT_REVIEW_TEMPERATURE);
  assert.equal(clampReviewTemperature(undefined), DEFAULT_REVIEW_TEMPERATURE);
});

test("the request's reviewTemperature (clamped) is the temperature sent to the model", async () => {
  const focused = new StubClient(diagnosisPayload([titleCritique]));
  await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard(), reviewTemperature: 0 },
    new Tracer("t-focused", { logDir: null }),
    { client: focused },
  );
  assert.equal(focused.completeOptions[0]?.temperature, 0);

  const divergent = new StubClient(diagnosisPayload([titleCritique]));
  await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard(), reviewTemperature: 0.9 },
    new Tracer("t-divergent", { logDir: null }),
    { client: divergent },
  );
  assert.equal(divergent.completeOptions[0]?.temperature, 0.9);

  // An out-of-range value is clamped, never passed through raw.
  const clamped = new StubClient(diagnosisPayload([titleCritique]));
  await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard(), reviewTemperature: 5 },
    new Tracer("t-clamped", { logDir: null }),
    { client: clamped },
  );
  assert.equal(clamped.completeOptions[0]?.temperature, 1);

  // An older client that omits reviewTemperature gets moderate exploration.
  const legacy = new StubClient(diagnosisPayload([titleCritique]));
  await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard() },
    new Tracer("t-legacy", { logDir: null }),
    { client: legacy },
  );
  assert.equal(legacy.completeOptions[0]?.temperature, 0.4);
});

test("without author context an empty model response still yields grounded detector fallbacks", async () => {
  const withoutContext = await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard() },
    new Tracer("t-no-context", { logDir: null }),
    { client: new StubClient({ diagnoses: [], critiques: [] }) },
  );
  // Every fallback is grounded on artifact evidence + a general design principle,
  // so none needs author context.
  assert.ok(withoutContext.critiques.length > 0);
  assert.ok(withoutContext.critiques.every((critique) => critique.grounded));
  assert.ok(withoutContext.critiques.every((critique) => critique.phrasingSource === "template"));
  assert.ok(withoutContext.critiques.every((critique) => critique.contextStatus === "not_applicable"));
  const crossFilterFallback = withoutContext.critiques.find((critique) =>
    critique.object === "interaction" && critique.problem === "limited affordance"
  );
  assert.ok(crossFilterFallback);
  // The empty model response leaves the fallback diagnoses as the diagnosis record.
  assert.ok(withoutContext.diagnoses.some((diagnosis) =>
    diagnosis.object === "interaction" &&
    diagnosis.problem === "limited affordance" &&
    diagnosis.outcome === "evaluated_issue"
  ));

  const withContext = await runCritique(
    {
      version: 1,
      context: { goal: "Compare department performance." },
      specMap: dashboardSpecMap(),
      board: dashboardBoard(),
    },
    new Tracer("t-context", { logDir: null }),
    { client: new StubClient(diagnosisPayload([crossFilterCritique])) },
  );
  assert.equal(withContext.reviewScope, "full");
  assert.equal(withContext.critiques[0]?.object, "interaction");
  assert.equal(withContext.critiques[0]?.problem, "limited affordance");
  assert.equal(withContext.critiques[0]?.recommendation, "interaction:support exploration and detail access");
  // An inferred goal grounds the analytical-task basis conditionally.
  assert.equal(withContext.critiques[0]?.contextStatus, "inferred");
});

test("runApply preserves deterministic apply, compute, and re-evaluation", async () => {
  const specMap = dashboardSpecMap();
  const board = dashboardBoard();
  const context = { goal: "Compare department performance." };
  const crit = await runCritique(
    { version: 1, context, specMap, board },
    new Tracer("t0", { logDir: null }),
    { client: new StubClient(diagnosisPayload([crossFilterCritique, tooltipCritique])) },
  );
  const tracer = new Tracer("t-apply", { logDir: null });
  const res = await runApply(
    {
      version: 1,
      context,
      specMap,
      board,
      critiques: crit.critiques,
      selectedRecommendationIds: crit.critiques.map((critique) => critique.id),
    },
    tracer,
  );
  assertSubsequence(tracer.events.map((event) => event.phase), ["run_start", "apply", "validate", "compute", "reevaluate_done", "done"]);
  assert.equal(res.rollback.rolledBack, false);
  assert.ok(res.recommendationDelta.added.includes("c-show-filter-state"));
  assert.ok(res.evaluationReport.computed.length > 0);
});

test("the cross-filter follow-up applies as a concrete change instead of no-op", async () => {
  const specMap = dashboardSpecMap();
  const board = dashboardBoard();
  const context = { goal: "Compare department performance." };
  const crit = await runCritique(
    { version: 1, context, specMap, board },
    new Tracer("t-loop-critique", { logDir: null }),
    { client: new StubClient(diagnosisPayload([crossFilterCritique])) },
  );
  // Step 1: apply the cross-filter; the engine proposes the show-filter-state follow-up.
  const first = await runApply(
    {
      version: 1,
      context,
      specMap,
      board,
      critiques: crit.critiques,
      selectedRecommendationIds: crit.critiques.map((c) => c.id),
    },
    new Tracer("t-loop-apply-1", { logDir: null }),
  );
  const followUp = first.addedCritiques.find((c) => c.id === "c-show-filter-state");
  assert.ok(followUp, "engine must propose the show-filter-state follow-up");

  // Step 2: accepting the follow-up must produce a real change, not APPLY_NO_CHANGE.
  const second = await runApply(
    {
      version: 2,
      context,
      specMap: first.specMap,
      board: first.board,
      critiques: [...crit.critiques, followUp],
      selectedRecommendationIds: [followUp.id],
    },
    new Tracer("t-loop-apply-2", { logDir: null }),
  );
  assert.equal(second.rollback.rolledBack, false);
  assert.deepEqual(second.applicationOrder, [followUp.id]);
  const source = String(followUp.target.ref.source);
  assert.equal(
    (second.specMap[source].usermeta as Record<string, unknown>).activeFilterState,
    true,
  );
});

test("generation tokens stream through the unified diagnostic trace", async () => {
  const tracer = new Tracer("t-tokens", { logDir: null });
  await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard() },
    tracer,
    { client: new StubClient(diagnosisPayload([titleCritique])) },
  );
  const genStart = tracer.events.find((event) => event.phase === "generate_start");
  assert.equal((genStart?.data as { llm: boolean }).llm, true);
});

test("focused review uses the same engine and retains direct-answer metadata", async () => {
  const focused = {
    ...titleCritique,
    answer: "No—the generic heading does not tell the reader what decision the dashboard supports.",
  };
  const res = await runCritique(
    {
      version: 1,
      context: {},
      specMap: dashboardSpecMap(),
      board: dashboardBoard(),
      focus: { request: "Does the dashboard clearly state its purpose?" },
    },
    new Tracer("t-focused", { logDir: null }),
    { client: new StubClient(diagnosisPayload([focused])) },
  );
  assert.equal(res.reviewScope, "focused");
  assert.equal(res.critiques[0]?.requestRelevance, "direct");
  assert.equal(res.critiques[0]?.reviewRequest, "Does the dashboard clearly state its purpose?");
});

test("declared review scope must match the supplied focus or region input", async () => {
  await assert.rejects(
    runCritique(
      {
        version: 1,
        context: {},
        specMap: dashboardSpecMap(),
        board: dashboardBoard(),
        reviewScope: "focused",
      },
      new Tracer("t-scope-mismatch", { logDir: null }),
      { client: new StubClient({ diagnoses: [], critiques: [] }) },
    ),
    /REVIEW_SCOPE_MISMATCH/,
  );
});

test("an executable diagnostic critique applies a concrete board change", async () => {
  const initialBoard = dashboardBoard();
  const critiqueRun = await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: initialBoard },
    new Tracer("t-title", { logDir: null }),
    { client: new StubClient(diagnosisPayload([titleCritique])) },
  );
  const result = await runApply(
    {
      version: 1,
      context: {},
      specMap: dashboardSpecMap(),
      board: initialBoard,
      critiques: critiqueRun.critiques,
      selectedRecommendationIds: [critiqueRun.critiques[0].id],
    },
    new Tracer("t-apply-title", { logDir: null }),
  );
  assert.equal(result.board.title, "Weekly Delivery Decisions");
  assert.match(result.board.subtitle || "", /delivery progress/i);
  assert.ok(result.changedTargets.includes("dashboard.title"));
});

// A board with laid-out tiles, so a layout/KPI apply has geometry to change.
function laidOutBoard() {
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

function boardChangeCritique(id: string, proposal: Critique["proposal"]): Critique {
  return {
    id,
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

test("runApply relocates tiles inside the fixed canvas and reports dashboard.layout", async () => {
  const critique = boardChangeCritique("c-layout", {
    kind: "edit-layout",
    mode: "executable",
    layout: [{ tile: "task-velocity", bounds: { x: 28, y: 96, w: 400, h: 258 } }],
  });
  const result = await runApply(
    {
      version: 1,
      context: {},
      specMap: dashboardSpecMap(),
      board: laidOutBoard(),
      critiques: [critique],
      selectedRecommendationIds: ["c-layout"],
    },
    new Tracer("t-apply-layout", { logDir: null }),
  );
  assert.equal(result.rollback.rolledBack, false);
  assert.ok(result.changedTargets.includes("dashboard.layout"));
  const moved = result.board.tiles!.find((t) => t.id === "task-velocity");
  assert.deepEqual(moved!.bounds, { x: 28, y: 96, w: 400, h: 258 });
  assert.deepEqual(
    { width: result.board.canvasWidth, height: result.board.canvasHeight },
    { width: 1100, height: 720 },
  );
});

test("runApply computes real KPI values and shifts tiles for add-kpis", async () => {
  const critique = boardChangeCritique("c-kpis", {
    kind: "add-kpis",
    mode: "executable",
    kpis: [{ label: "Total Tasks", tile: "department-tasks", field: "tasks", agg: "sum" }],
    kpiLayout: "hero-support",
  });
  const result = await runApply(
    {
      version: 1,
      context: {},
      specMap: dashboardSpecMap(),
      board: laidOutBoard(),
      critiques: [critique],
      selectedRecommendationIds: ["c-kpis"],
    },
    new Tracer("t-apply-kpis", { logDir: null }),
  );
  assert.equal(result.rollback.rolledBack, false);
  assert.ok(result.changedTargets.includes("dashboard.kpis"));
  assert.equal(result.board.hasKpis, true);
  assert.ok(Array.isArray(result.board.kpis) && result.board.kpis.length === 1);
  assert.equal(result.board.kpis![0].computed, true);
  // The reserved band pushed the top row down.
  assert.equal(result.board.tiles!.find((t) => t.id === "task-velocity")!.bounds!.y, 204);
});

test("edit-layout and add-kpis in one apply do not clobber each other (layout runs first)", async () => {
  // Author add-kpis EARLIER in the selection than edit-layout. add-kpis reserves
  // a composition-specific band by pushing every tile down; edit-layout writes absolute boxes
  // that predate the band. If add-kpis ran last it would re-shift the moved tile
  // OR edit-layout (running last) would overwrite the band offset and land the
  // tile in the band. The engine's ordering runs edit-layout first, so the tile
  // ends at its authored y PLUS the uniform band shift — clear of the band.
  const kpis = boardChangeCritique("c-kpis", {
    kind: "add-kpis",
    mode: "executable",
    kpis: [{ label: "Total Tasks", tile: "department-tasks", field: "tasks", agg: "sum" }],
    kpiLayout: "hero-support",
  });
  const layout = boardChangeCritique("c-layout", {
    kind: "edit-layout",
    mode: "executable",
    layout: [{ tile: "task-velocity", bounds: { x: 28, y: 110, w: 508, h: 258 } }],
  });
  const result = await runApply(
    {
      version: 1,
      context: {},
      specMap: dashboardSpecMap(),
      board: laidOutBoard(),
      critiques: [kpis, layout],
      selectedRecommendationIds: ["c-kpis", "c-layout"], // KPIs selected first on purpose
    },
    new Tracer("t-apply-layout-kpis", { logDir: null }),
  );
  assert.equal(result.rollback.rolledBack, false);
  assert.ok(result.changedTargets.includes("dashboard.kpis"));
  assert.ok(result.changedTargets.includes("dashboard.layout"));
  // The fixed-canvas reflow lands the tile below the KPI band without growing.
  assert.equal(result.board.tiles!.find((t) => t.id === "task-velocity")!.bounds!.y, 216);
  assert.equal(result.board.canvasHeight, 720);
});

test("three adopted rounds accumulate KPI composition and structural layout change", async () => {
  const specMap = dashboardSpecMap();
  const initialBoard = laidOutBoard();
  const initialBounds = structuredClone(initialBoard.tiles);
  const add = boardChangeCritique("round-1-kpis", {
    kind: "add-kpis",
    mode: "executable",
    kpis: [
      { label: "Total Tasks", tile: "department-tasks", field: "tasks", agg: "sum", format: "compact" },
      { label: "Teams", tile: "department-tasks", field: "department", agg: "distinct", format: "integer" },
    ],
    kpiLayout: "hero-support",
    kpiStyle: "product",
    kpiChrome: "plain",
  });
  const round1 = await runApply({
    version: 1,
    context: {},
    specMap,
    board: initialBoard,
    critiques: [add],
    selectedRecommendationIds: [add.id],
  }, new Tracer("t-round-1", { logDir: null }));

  const recompose = boardChangeCritique("round-2-kpis", {
    kind: "recompose-kpis",
    mode: "executable",
    kpiLayout: "side-rail",
    kpiStyle: "technical",
    kpiDensity: "dense",
    kpiChrome: "ruled",
  });
  const round2 = await runApply({
    version: 2,
    context: {},
    specMap: round1.specMap,
    board: round1.board,
    critiques: [recompose],
    selectedRecommendationIds: [recompose.id],
  }, new Tracer("t-round-2", { logDir: null }));

  const layout = boardChangeCritique("round-3-layout", {
    kind: "edit-layout",
    mode: "executable",
    composition: "asymmetric-grid",
    layoutTiles: round2.board.tiles!.map((tile) => tile.id),
  });
  const round3 = await runApply({
    version: 3,
    context: {},
    specMap: round2.specMap,
    board: round2.board,
    critiques: [layout],
    selectedRecommendationIds: [layout.id],
  }, new Tracer("t-round-3", { logDir: null }));

  assert.equal(round3.board.kpiLayout, "side-rail");
  assert.equal(round3.board.kpiStyle, "technical");
  assert.ok(round3.changedTargets.includes("dashboard.layout"));
  assert.notDeepEqual(round3.board.tiles, initialBounds);
  assert.ok(round3.board.tiles!.some((tile, index) =>
    tile.bounds!.w !== initialBounds![index].bounds!.w ||
    tile.bounds!.h !== initialBounds![index].bounds!.h
  ));
});

test("compile rollback remains a structured result instead of a no-change error", async () => {
  const specMap = dashboardSpecMap();
  specMap.broken = { data: { values: [] }, encoding: {} };
  const critiqueRun = await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard() },
    new Tracer("t-tooltip-for-rollback", { logDir: null }),
    { client: new StubClient(diagnosisPayload([tooltipCritique])) },
  );
  const tooltip = critiqueRun.critiques.find((critique) =>
    critique.proposal.kind === "add-tooltip"
  );
  assert.ok(tooltip);
  const result = await runApply(
    {
      version: 1,
      context: {},
      specMap,
      board: dashboardBoard(),
      critiques: critiqueRun.critiques,
      selectedRecommendationIds: [tooltip.id],
    },
    new Tracer("t-rollback-result", { logDir: null }),
  );
  assert.equal(result.rollback.rolledBack, true);
  assert.match(result.rollback.reason || "", /compile/i);
  assert.deepEqual(result.changedTargets, []);
});

test("guidance-only critiques are rejected by the apply boundary", async () => {
  const guidance = {
    ...titleCritique,
    id: "guidance-only",
    proposal: { kind: "manual", mode: "guidance_only" },
  } as never;
  await assert.rejects(
    runApply(
      {
        version: 1,
        context: {},
        specMap: dashboardSpecMap(),
        board: dashboardBoard(),
        critiques: [guidance],
        selectedRecommendationIds: ["guidance-only"],
      },
      new Tracer("t-guidance", { logDir: null }),
    ),
    /APPLY_NOT_EXECUTABLE/,
  );
});

test("an executable label is not accepted when it produces no concrete change", async () => {
  const noOp = {
    ...titleCritique,
    id: "unsupported-executable",
    proposal: { kind: "unsupported-operation", mode: "executable" },
  } as never;
  await assert.rejects(
    runApply(
      {
        version: 1,
        context: {},
        specMap: dashboardSpecMap(),
        board: dashboardBoard(),
        critiques: [noOp],
        selectedRecommendationIds: ["unsupported-executable"],
      },
      new Tracer("t-no-op", { logDir: null }),
    ),
    /APPLY_NO_CHANGE/,
  );
});

test("mixed apply reports only recommendations that changed the dashboard", async () => {
  const critiqueRun = await runCritique(
    { version: 1, context: {}, specMap: dashboardSpecMap(), board: dashboardBoard() },
    new Tracer("t-mixed-source", { logDir: null }),
    { client: new StubClient(diagnosisPayload([titleCritique])) },
  );
  const title = critiqueRun.critiques[0];
  const noOp = {
    ...title,
    id: "unsupported-mixed",
    proposal: { kind: "unsupported-operation", mode: "executable" },
  } as never;
  const result = await runApply(
    {
      version: 1,
      context: {},
      specMap: dashboardSpecMap(),
      board: dashboardBoard(),
      critiques: [title, noOp],
      selectedRecommendationIds: [title.id, "unsupported-mixed"],
    },
    new Tracer("t-mixed-apply", { logDir: null }),
  );
  assert.deepEqual(result.applicationOrder, [title.id]);
});
