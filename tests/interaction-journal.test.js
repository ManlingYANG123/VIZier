import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRevisionCheckpoint,
  createCritiqueContextSnapshot,
  createCritiqueRationale,
  createJournalEvent,
  createWorkingDraft,
  mergePendingContextSuggestions,
  mergeSuggestionIntoContext,
  recordWorkingDraftApplication,
  strongInteractionEventCount,
  upsertCritiqueRationale,
} from "../src/interaction-journal.js";

test("the journal counts decisions without treating browsing as strong evidence", () => {
  const events = [
    createJournalEvent({ id: "event-1", version: 1, kind: "critique_opened", summary: "Opened" }),
    createJournalEvent({ id: "event-2", version: 1, kind: "preview_viewed", summary: "Previewed" }),
    createJournalEvent({ id: "event-3", version: 1, kind: "recommendation_rejected", summary: "Rejected" }),
    createJournalEvent({ id: "event-4", version: 1, kind: "context_saved", summary: "Saved context" }),
  ];
  assert.equal(strongInteractionEventCount(events), 2);
});

test("revision checkpoints retain applied changes and validation results", () => {
  const beforeSnapshot = {
    specMap: { "task-velocity": { mark: "line" } },
    board: { title: "Workspace Overview", subtitle: "", hasKpis: false, tiles: [] },
  };
  const afterSnapshot = {
    specMap: { "task-velocity": { mark: { type: "line", point: true } } },
    board: { title: "Team Delivery Health", subtitle: "Monitor delivery risk.", hasKpis: false, tiles: [] },
  };
  const checkpoint = buildRevisionCheckpoint({
    version: 2,
    appliedCritiques: [{
      id: "critique-1",
      title: "Add a dashboard title",
      dimension: "narrative",
      suggestion: "Use a decision-oriented title.",
      tileId: null,
    }],
    result: {
      applicationOrder: ["critique-1"],
      changedTargets: ["dashboard.title"],
      recommendationDelta: {
        kept: ["critique-2"],
        updated: ["critique-3"],
        removed: ["critique-1"],
        added: ["critique-4"],
        changedTargets: ["dashboard.title"],
      },
      evaluationReport: {
        compiled: true,
        compileError: null,
        remainingFindings: 2,
        computed: [],
      },
    },
    createdFromEventIds: ["event-1"],
    beforeSnapshot,
    afterSnapshot,
    beforeScreenshot: "data:image/webp;base64,before",
    afterScreenshot: "data:image/webp;base64,after",
  });

  assert.equal(checkpoint.label, "Checkpoint 2 · 1 Change Applied");
  assert.equal(checkpoint.appliedRecommendations[0].title, "Add a dashboard title");
  assert.deepEqual(checkpoint.changedTargets, ["dashboard.title"]);
  assert.equal(checkpoint.evaluationReport.compiled, true);
  assert.equal(checkpoint.beforeSnapshot.board.title, "Workspace Overview");
  assert.equal(checkpoint.afterSnapshot.board.title, "Team Delivery Health");
  assert.equal(checkpoint.beforeScreenshot, "data:image/webp;base64,before");
  assert.equal(checkpoint.afterScreenshot, "data:image/webp;base64,after");

  beforeSnapshot.board.title = "Mutated outside the checkpoint";
  afterSnapshot.specMap["task-velocity"].mark.point = false;
  assert.equal(checkpoint.beforeSnapshot.board.title, "Workspace Overview");
  assert.equal(checkpoint.afterSnapshot.specMap["task-velocity"].mark.point, true);
});

test("confirming inferred context appends instead of overwriting explicit context", () => {
  const context = {
    goal: "Monitor delivery risk.",
    constraints: "Keep the blue brand palette.",
    notes: [],
  };
  const suggestion = {
    field: "constraints",
    text: "Keep charts readable on wall displays.",
  };
  const next = mergeSuggestionIntoContext(context, suggestion);

  assert.equal(
    next.constraints,
    "Keep the blue brand palette.\nKeep charts readable on wall displays.",
  );
  assert.equal(context.constraints, "Keep the blue brand palette.");
});

test("confirming the same note twice does not duplicate it", () => {
  const suggestion = { field: "notes", text: "Prefer direct labels." };
  const once = mergeSuggestionIntoContext({ notes: [] }, suggestion);
  const twice = mergeSuggestionIntoContext(once, suggestion);
  assert.deepEqual(twice.notes, ["Prefer direct labels."]);
});

test("audience suggestions remain readable in the single-line audience field", () => {
  const next = mergeSuggestionIntoContext(
    { audience: "Operations leads." },
    { field: "audience", text: "Program managers." },
  );
  assert.equal(next.audience, "Operations leads. · Program managers.");
});

test("pending learned context remains until it is resolved or already saved", () => {
  const pending = [{
    id: "context-constraints-palette",
    field: "constraints",
    text: "Preserve the current palette.",
    rationale: "Repeated palette changes were rejected.",
  }];
  assert.deepEqual(
    mergePendingContextSuggestions(pending, [], [], {}),
    pending,
  );
  assert.deepEqual(
    mergePendingContextSuggestions(pending, [], [{
      id: pending[0].id,
      text: pending[0].text,
      status: "dismissed",
    }], {}),
    [],
  );
  assert.deepEqual(
    mergePendingContextSuggestions(pending, [], [], {
      constraints: "Preserve the current palette.",
    }),
    [],
  );
});

test("new learned context updates matching suggestions without clearing others", () => {
  const previous = [
    { id: "a", field: "goal", text: "Compare teams.", rationale: "Earlier evidence." },
    { id: "b", field: "audience", text: "Operations leads.", rationale: "Stable evidence." },
  ];
  const next = [{
    id: "a",
    field: "goal",
    text: "Compare teams.",
    rationale: "More recent supporting decisions.",
  }];
  const merged = mergePendingContextSuggestions(previous, next, [], {});
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.id === "a").rationale, "More recent supporting decisions.");
  assert.ok(merged.some((item) => item.id === "b"));
});

test("working draft accumulates accepted changes without creating checkpoints", () => {
  const initial = createWorkingDraft(1);
  const first = recordWorkingDraftApplication(initial, {
    appliedCritiques: [{ id: "critique-1", title: "Add a title" }],
    result: {
      applicationOrder: ["critique-1"],
      changedTargets: ["dashboard.title"],
      evaluationReport: { compiled: true, remainingFindings: 2 },
      recommendationDelta: { kept: [], updated: [], removed: ["critique-1"], added: [], changedTargets: ["dashboard.title"] },
    },
    beforeSnapshot: { board: { title: "Before" }, specMap: {} },
    afterSnapshot: { board: { title: "After" }, specMap: {} },
    createdFromEventIds: ["event-1"],
  });
  const second = recordWorkingDraftApplication(first, {
    appliedCritiques: [{ id: "critique-2", title: "Add KPIs" }],
    result: {
      applicationOrder: ["critique-2"],
      changedTargets: ["dashboard.kpis"],
      evaluationReport: { compiled: true, remainingFindings: 1 },
      recommendationDelta: { kept: [], updated: [], removed: ["critique-2"], added: [], changedTargets: ["dashboard.kpis"] },
    },
    beforeSnapshot: { board: { title: "After" }, specMap: {} },
    afterSnapshot: { board: { title: "After", hasKpis: true }, specMap: {} },
    createdFromEventIds: ["event-2"],
  });

  assert.equal(second.dirty, true);
  assert.equal(second.baseCheckpointId, 1);
  assert.deepEqual(second.applicationOrder, ["critique-1", "critique-2"]);
  assert.deepEqual(second.changedTargets, ["dashboard.title", "dashboard.kpis"]);
  assert.equal(second.beforeSnapshot.board.title, "Before");
  assert.equal(second.afterSnapshot.board.hasKpis, true);
});

test("working draft counts only critiques the engine actually applied", () => {
  const draft = recordWorkingDraftApplication(createWorkingDraft(1), {
    appliedCritiques: [
      { id: "critique-1", title: "Applied" },
      { id: "critique-2", title: "Selected but not committed" },
      { id: "critique-3", title: "Also skipped" },
    ],
    result: {
      applicationOrder: ["critique-1"],
      changedTargets: ["dashboard.title"],
    },
  });
  assert.deepEqual(draft.applicationOrder, ["critique-1"]);
  assert.deepEqual(draft.appliedCritiques.map((item) => item.id), ["critique-1"]);
});

test("critique rationale can be edited without losing its source link", () => {
  const rationale = createCritiqueRationale({
    id: "rationale-1",
    critiqueId: "critique-1",
    critiqueTitle: "Preserve compact labels",
    dimension: "visual",
    text: "This is shown on a wall display.",
    createdAt: "2026-07-29T00:00:00.000Z",
  });
  const edited = upsertCritiqueRationale([rationale], {
    ...rationale,
    text: "This is shown on a wall display from several feet away.",
    updatedAt: "2026-07-29T00:05:00.000Z",
  });

  assert.equal(edited.length, 1);
  assert.equal(edited[0].critiqueId, "critique-1");
  assert.match(edited[0].text, /several feet away/);
});

test("saved rationale retains the critique context that gives the user text meaning", () => {
  const critique = {
    id: "critique-visual-1",
    title: "Use a more distinct department palette",
    issue: "Department colors are difficult to distinguish.",
    rationale: "Similar hues slow category comparison.",
    suggestion: "Replace the current palette with more separated hues.",
    dimension: "visual",
    tileId: "department-tasks",
    target: {
      granularity: "encoding",
      ref: { tile: "department-tasks", channel: "color" },
    },
    proposal: { kind: "edit-spec", mode: "executable" },
    object: "color",
    problem: "insufficient-distinction",
    recommendation: "color.differentiate-categories",
    evidence: "The chart uses several similar blue hues.",
    judgmentBasis: ["dashboard evidence", "general design principle"],
    reviewScope: "full",
  };
  const rationale = createCritiqueRationale({
    id: "rationale-2",
    critique,
    dashboardVersion: 4,
    text: "Keep the department colors because they match the company standard.",
    createdAt: "2026-08-11T00:00:00.000Z",
  });

  assert.equal(rationale.critiqueId, critique.id);
  assert.equal(rationale.dashboardVersion, 4);
  assert.deepEqual(rationale.critiqueContext, createCritiqueContextSnapshot(critique));
  assert.equal(rationale.critiqueContext.issue, critique.issue);
  assert.equal(rationale.critiqueContext.rationale, critique.rationale);
  assert.equal(rationale.critiqueContext.suggestion, critique.suggestion);
  assert.equal(rationale.critiqueContext.targetTileId, "department-tasks");
  assert.equal(rationale.critiqueContext.proposalKind, "edit-spec");
  assert.equal(rationale.critiqueContext.recommendation, "color.differentiate-categories");

  critique.target.ref.channel = "size";
  critique.judgmentBasis.push("analytical task");
  assert.equal(rationale.critiqueContext.target.ref.channel, "color");
  assert.deepEqual(
    rationale.critiqueContext.judgmentBasis,
    ["dashboard evidence", "general design principle"],
  );
});

test("a sparse legacy rationale does not invent a dashboard target", () => {
  const rationale = createCritiqueRationale({
    id: "rationale-legacy",
    critiqueId: "critique-legacy",
    critiqueTitle: "Legacy critique",
    dimension: "visual",
    text: "Keep this choice.",
    createdAt: "2026-08-11T00:00:00.000Z",
  });

  assert.equal(rationale.critiqueContext.targetTileId, undefined);
});
