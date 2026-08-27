import { test } from "node:test";
import assert from "node:assert/strict";
import type { LLMClient } from "../src/llm/client.ts";
import type { Critique, Finding } from "../src/contracts.ts";
import { buildEvidencePacket } from "../src/generate/evidence.ts";
import { judgeSolutionQuality, __test__ } from "../src/generate/solution-quality.ts";
import { dashboardBoard, dashboardSpecMap } from "../fixtures/specs.ts";

function candidate(): { critique: Critique; finding: Finding } {
  const critique = {
    id: "quality-1",
    tileId: "department-tasks",
    dimension: "chart",
    priority: "high",
    status: "pending",
    source: "ai",
    title: "Make department differences easier to compare",
    issue: "The categories are not ordered by task count.",
    rationale: "Scanning an unsorted ranking slows comparison.",
    evidence: "department-tasks encodes department on x and tasks on y.",
    suggestion: "Sort departments by tasks.",
    target: { granularity: "chart", ref: { tile: "department-tasks" } },
    proposal: {
      kind: "edit-spec",
      mode: "executable",
      edits: [{ op: "set", path: ["encoding", "x", "sort"], value: "-y" }],
    },
    object: "chart",
    judgmentBasis: ["dashboard evidence"],
    requiredContext: [],
    contextStatus: "not_applicable",
    evidenceRefs: [],
  } as Critique;
  return {
    critique,
    finding: {
      id: "finding-quality-1",
      kind: "sort-departments",
      dimension: "chart",
      proposalKind: "edit-spec",
      surface: "encoding",
      severity: "high",
      evidence: { detail: critique.evidence, tile: "department-tasks" },
      target: critique.target,
      tileId: "department-tasks",
    },
  };
}

test("solution judge receives the current target spec and returns a typed rewrite", async () => {
  let userPrompt = "";
  const client: LLMClient = {
    available: () => true,
    complete: async () => "",
    completeJson: async (input) => {
      userPrompt = input;
      return {
        decisions: [{
          id: "quality-1",
          verdict: "rewrite",
          reason: "The proposed path is too weak for the stated comparison issue.",
          suggestion: "Use a descending order and readable axis labels.",
          proposal: { kind: "edit-spec", mode: "executable", edits: [] },
          target: { granularity: "chart", ref: { tile: "department-tasks" } },
        }],
      };
    },
  };
  const decisions = await judgeSolutionQuality(
    [candidate()],
    buildEvidencePacket(dashboardSpecMap(), dashboardBoard(), undefined),
    { dashboardType: "analytical", goal: "Compare department workload." },
    "focused",
    {
      request: "Sort the department chart.",
      explicitChange: true,
      actions: ["fix"],
      targetPaths: ["tile.department-tasks"],
      targetKinds: ["chart"],
      mustPreserve: [],
      successCriteria: ["The requested chart visibly changes."],
    },
    client,
  );
  assert.equal(decisions.get("quality-1")?.verdict, "rewrite");
  assert.match(userPrompt, /CURRENT TARGET SPECS/);
  assert.match(userPrompt, /department-tasks/);
  assert.match(userPrompt, /AUTHOR REQUEST CONTRACT/);
});

test("solution judge ignores unknown ids and fails open on provider errors", async () => {
  const parsed = __test__.parseDecisions({
    decisions: [
      { id: "unknown", verdict: "drop", reason: "no" },
      { id: "quality-1", verdict: "pass", reason: "yes" },
    ],
  }, new Set(["quality-1"]));
  assert.deepEqual([...parsed.keys()], ["quality-1"]);

  const failing: LLMClient = {
    available: () => true,
    complete: async () => "",
    completeJson: async () => { throw new Error("offline"); },
  };
  const decisions = await judgeSolutionQuality(
    [candidate()],
    buildEvidencePacket(dashboardSpecMap(), dashboardBoard(), undefined),
    {},
    "full",
    undefined,
    failing,
  );
  assert.equal(decisions.size, 0);
});
