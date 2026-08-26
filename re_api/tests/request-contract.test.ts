import test from "node:test";
import assert from "node:assert/strict";
import type { BoardMeta, Critique, SpecMap } from "../src/contracts.ts";
import {
  buildReviewRequestContract,
  sanitizeRegionSemanticTargets,
} from "../src/generate/request-contract.ts";
import { normalizeFocusedReview } from "../src/generate/discover.ts";
import { validateAppliedRequestIntent } from "../src/apply/requestIntent.ts";
import { dashboardReviewSystem } from "../src/generate/prompts.ts";

const specs: SpecMap = {
  trend: {
    mark: "line",
    data: { values: [{ month: "Jan", value: 10 }] },
    encoding: {
      x: { field: "month", type: "nominal" },
      y: { field: "value", type: "quantitative" },
    },
  },
};

const board: BoardMeta = {
  title: "A very long dashboard headline about declining garden birds",
  subtitle: "Evidence from the annual survey",
  canvasWidth: 1200,
  canvasHeight: 760,
  filters: [],
  tiles: [{ id: "trend", title: "Bird trend", bounds: { x: 20, y: 120, w: 600, h: 420 } }],
};

test("selected-region semantic targets are bound to real board and tile paths", () => {
  const targets = sanitizeRegionSemanticTargets([
    {
      kind: "dashboard-title",
      path: "board.title",
      text: board.title,
      bounds: { x: 20, y: 20, w: 760, h: 60 },
      overlapRatio: 0.95,
    },
    {
      kind: "axis",
      path: "tile.trend.encoding",
      tileId: "trend",
      bounds: { x: 40, y: 450, w: 520, h: 50 },
      overlapRatio: 0.8,
    },
    {
      kind: "axis",
      path: "tile.invented.encoding",
      tileId: "invented",
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      overlapRatio: 1,
    },
  ], specs, board);
  assert.deepEqual(targets.map((target) => target.path), ["board.title", "tile.trend.encoding"]);
});

test("an explicit title request becomes a deterministic acceptance contract", () => {
  const contract = buildReviewRequestContract(
    "Shorten the dashboard headline substantially while preserving its conservation takeaway.",
    [{
      kind: "dashboard-title",
      path: "board.title",
      text: board.title,
      bounds: { x: 20, y: 20, w: 760, h: 60 },
      overlapRatio: 1,
    }],
  );
  assert.equal(contract.explicitChange, true);
  assert.ok(contract.actions.includes("shorten"));
  assert.deepEqual(contract.targetPaths, ["board.title"]);
  assert.deepEqual(contract.mustPreserve, ["its conservation takeaway"]);
  assert.match(contract.successCriteria.join(" "), /materially shorter/);
});

test("a whitespace-normalized refinement request still retains its named tile target", () => {
  const contract = buildReviewRequestContract(
    "The text is too long. Target: task-velocity Current solution: Keep all evidence.",
  );
  assert.equal(contract.explicitChange, true);
  assert.ok(contract.actions.includes("shorten"));
  assert.deepEqual(contract.targetPaths, ["tile.task-velocity"]);
});

test("a stale refresh evaluates the old issue instead of treating its quoted suggestion as a new author command", () => {
  const focus = normalizeFocusedReview({
    purpose: "stale-refresh",
    request: "Re-evaluate this issue. Target: trend Previous suggestion: Left-align the text.",
  });
  assert.equal(focus?.purpose, "stale-refresh");
  assert.equal(focus?.requestContract?.explicitChange, false);
  assert.deepEqual(focus?.requestContract?.actions, ["evaluate"]);
});

function directTitleCritique(contract: ReturnType<typeof buildReviewRequestContract>): Critique {
  return {
    id: "title-fix",
    tileId: null,
    dimension: "text",
    priority: "high",
    status: "pending",
    source: "ai",
    title: "Shorten the title",
    issue: "The title is long.",
    rationale: "A shorter title improves scanning.",
    evidence: "The current title contains eleven words.",
    suggestion: "Use a shorter headline.",
    target: { granularity: "dashboard", ref: {} },
    proposal: { kind: "dashboard-title", mode: "executable", label: "Garden Birds in Decline" },
    surface: "text",
    findingId: "finding-title",
    grounded: true,
    phrasingSource: "llm",
    requestRelevance: "direct",
    reviewRequest: contract.request,
    requestContract: contract,
  };
}

test("post-apply intent gate rejects a safe but unchanged direct proposal", () => {
  const contract = buildReviewRequestContract("Shorten the dashboard headline.", [{
    kind: "dashboard-title",
    path: "board.title",
    bounds: { x: 20, y: 20, w: 760, h: 60 },
    overlapRatio: 1,
  }]);
  const result = validateAppliedRequestIntent(
    [directTitleCritique(contract)],
    ["title-fix"],
    board,
    structuredClone(board),
    specs,
    structuredClone(specs),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /did not change any requested semantic target/);
});

test("post-apply intent gate accepts a visibly shorter requested title", () => {
  const contract = buildReviewRequestContract("Shorten the dashboard headline.", [{
    kind: "dashboard-title",
    path: "board.title",
    bounds: { x: 20, y: 20, w: 760, h: 60 },
    overlapRatio: 1,
  }]);
  const nextBoard = { ...structuredClone(board), title: "Garden Birds in Decline" };
  const result = validateAppliedRequestIntent(
    [directTitleCritique(contract)],
    ["title-fix"],
    board,
    nextBoard,
    specs,
    structuredClone(specs),
  );
  assert.equal(result.ok, true);
});

test("directed reviews use a materially smaller scope-matched system prompt", () => {
  const full = dashboardReviewSystem("full");
  const local = dashboardReviewSystem("selected-region");
  assert.ok(local.length < full.length * 0.55, `${local.length} should be less than 55% of ${full.length}`);
  assert.match(local, /DIRECTED REVIEW DEMONSTRATION/);
  assert.match(local, /selected-region/);
  assert.doesNotMatch(local, /RECOMMENDATION CATALOG/);
});
