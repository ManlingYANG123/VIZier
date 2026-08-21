import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProposals } from "../src/apply/index.ts";
import {
  conflictGroupKey,
  detectEditSpecConflicts,
  pathsOverlap,
} from "../src/apply/merge.ts";
import type { Critique, SpecMap } from "../src/contracts.ts";
import { StubClient } from "./helpers.ts";

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

function editCritique(id: string, tile: string, edits: Array<Record<string, unknown>>): Critique {
  return {
    id,
    tileId: tile,
    dimension: "chart",
    priority: "medium",
    status: "pending",
    source: "ai",
    title: `Edit ${id}`,
    issue: "x",
    rationale: "x",
    evidence: "x",
    suggestion: `apply ${id}`,
    target: { granularity: "chart", ref: { tile } },
    proposal: { kind: "edit-spec", mode: "executable", edits },
    surface: "encoding",
    findingId: `finding-${id}`,
    grounded: true,
    phrasingSource: "llm",
  } as unknown as Critique;
}

function statusOf(outcome: Awaited<ReturnType<typeof applyProposals>>, id: string) {
  return outcome.critiqueStatuses.find((s) => s.id === id)?.status;
}

test("pathsOverlap treats a prefix as overlapping and siblings as independent", () => {
  assert.equal(pathsOverlap(["encoding", "x"], ["encoding", "x", "sort"]), true);
  assert.equal(pathsOverlap(["encoding", "x", "sort"], ["encoding", "x", "sort"]), true);
  assert.equal(pathsOverlap(["encoding", "x"], ["encoding", "y"]), false);
  assert.equal(pathsOverlap(["mark"], ["encoding", "x"]), false);
});

test("detectEditSpecConflicts groups overlapping same-tile fixes and ignores siblings", () => {
  const specMap: SpecMap = { revenue: barTile() };
  // A rewrites the whole x channel; B edits a leaf inside it — a prefix overlap.
  const overlapA = editCritique("a", "revenue", [{ op: "set", path: ["encoding", "x"], value: { field: "region", type: "nominal" } }]);
  const overlapB = editCritique("b", "revenue", [{ op: "set", path: ["encoding", "x", "title"], value: "Region" }]);
  const sibling = editCritique("c", "revenue", [{ op: "set", path: ["encoding", "y", "title"], value: "Sales" }]);

  const conflicts = detectEditSpecConflicts(specMap, [overlapA, overlapB, sibling]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].critiqueIds.sort(), ["a", "b"]);
  assert.equal(conflicts[0].tileId, "revenue");
  assert.equal(conflicts[0].key, conflictGroupKey(["a", "b"]));
});

test("a valid model merge reconciles both overlapping fixes into one applied change", async () => {
  const specMap: SpecMap = { revenue: barTile() };
  const a = editCritique("a", "revenue", [{ op: "set", path: ["encoding", "x"], value: { field: "region", type: "nominal", sort: "-y" } }]);
  const b = editCritique("b", "revenue", [{ op: "set", path: ["encoding", "x", "title"], value: "Region" }]);
  const client = new StubClient({
    edits: [
      { op: "set", path: ["encoding", "x"], value: { field: "region", type: "nominal", sort: "-y" } },
      { op: "set", path: ["encoding", "x", "title"], value: "Region" },
    ],
  });

  const outcome = await applyProposals(specMap, [a, b], ["a", "b"], { client });
  assert.equal(outcome.rollback.rolledBack, false);
  assert.equal(outcome.unresolvedConflicts.length, 0);
  assert.equal(statusOf(outcome, "a"), "merged");
  assert.equal(statusOf(outcome, "b"), "merged");
  assert.ok(outcome.changedTargets.includes("revenue"));
  const x = (outcome.specMap.revenue.encoding as Record<string, Record<string, unknown>>).x;
  assert.equal(x.sort, "-y");
  assert.equal(x.title, "Region");
});

test("with no merge model the overlapping fixes surface as an unresolved conflict, unchanged", async () => {
  const specMap: SpecMap = { revenue: barTile() };
  const before = JSON.stringify(specMap);
  const a = editCritique("a", "revenue", [{ op: "set", path: ["encoding", "x"], value: { field: "region", type: "nominal", sort: "-y" } }]);
  const b = editCritique("b", "revenue", [{ op: "set", path: ["encoding", "x", "title"], value: "Region" }]);

  const outcome = await applyProposals(specMap, [a, b], ["a", "b"]);
  assert.equal(outcome.rollback.rolledBack, false);
  assert.equal(outcome.unresolvedConflicts.length, 1);
  assert.equal(outcome.unresolvedConflicts[0].reason, "no_merge_model");
  assert.equal(statusOf(outcome, "a"), "conflict");
  assert.equal(statusOf(outcome, "b"), "conflict");
  assert.equal(outcome.changedTargets.length, 0);
  assert.equal(JSON.stringify(outcome.specMap), before); // conflicting tile untouched
});

test("a conflict choice keeps the chosen fix and supersedes the other", async () => {
  const specMap: SpecMap = { revenue: barTile() };
  // A would replace the whole x channel (dropping any title); B only sets a title.
  const a = editCritique("a", "revenue", [{ op: "set", path: ["encoding", "x"], value: { field: "region", type: "nominal", sort: "-y" } }]);
  const b = editCritique("b", "revenue", [{ op: "set", path: ["encoding", "x", "title"], value: "Region" }]);
  const key = conflictGroupKey(["a", "b"]);

  const outcome = await applyProposals(specMap, [a, b], ["a", "b"], { conflictChoices: { [key]: "b" } });
  assert.equal(outcome.unresolvedConflicts.length, 0);
  assert.equal(statusOf(outcome, "b"), "applied");
  assert.equal(statusOf(outcome, "a"), "superseded");
  const x = (outcome.specMap.revenue.encoding as Record<string, Record<string, unknown>>).x;
  assert.equal(x.title, "Region");
  assert.equal(x.sort, undefined); // the superseded fix never applied
});

test("a merge that changes nothing falls back to an unresolved conflict", async () => {
  const specMap: SpecMap = { revenue: barTile() };
  const a = editCritique("a", "revenue", [{ op: "set", path: ["encoding", "x"], value: { field: "region", type: "nominal", sort: "-y" } }]);
  const b = editCritique("b", "revenue", [{ op: "set", path: ["encoding", "x", "title"], value: "Region" }]);
  // The model "merges" to a no-op (mark is already "bar"): merge produces no real
  // change, so it must not be adopted and the group is surfaced for a choice.
  const client = new StubClient({ edits: [{ op: "set", path: ["mark"], value: "bar" }] });

  const outcome = await applyProposals(specMap, [a, b], ["a", "b"], { client });
  assert.equal(outcome.unresolvedConflicts.length, 1);
  assert.equal(outcome.unresolvedConflicts[0].reason, "merge_failed");
  assert.equal(statusOf(outcome, "a"), "conflict");
});

test("per-tile isolation lets an unrelated fix survive a fix that breaks compile", async () => {
  const specMap: SpecMap = { revenue: barTile(), cost: barTile() };
  // Removing the mark makes `revenue` uncompilable; `cost` is untouched by it.
  const bad = editCritique("bad", "revenue", [{ op: "remove", path: ["mark"] }]);
  const good = editCritique("good", "cost", [{ op: "set", path: ["title"], value: "Cost by region" }]);

  const outcome = await applyProposals(specMap, [bad, good], ["bad", "good"]);
  assert.equal(outcome.rollback.rolledBack, false); // the whole batch is NOT rolled back
  assert.equal(statusOf(outcome, "bad"), "rolled_back");
  assert.equal(statusOf(outcome, "good"), "applied");
  assert.deepEqual(outcome.changedTargets, ["cost"]);
  assert.equal(outcome.specMap.cost.title, "Cost by region");
  assert.ok(outcome.specMap.revenue.mark, "revenue keeps its mark (its fix was isolated out)");
});
