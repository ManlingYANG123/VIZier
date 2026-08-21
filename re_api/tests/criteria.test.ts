import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardBoard, dashboardSpecMap } from "../fixtures/specs.ts";
import {
  buildContextSnapshot,
  buildEvidencePacket,
  determineGroundingAvailability,
} from "../src/generate/evidence.ts";
import {
  JUDGMENT_BASIS_REGISTRY,
  JUDGMENT_BASIS_LABELS,
  OBJECT_CODES,
  PROBLEM_CODES,
  diagnosticKnowledgePrompt,
  isObjectCode,
  isProblemCode,
  priorWeightFor,
} from "../src/generate/review-data.ts";
import {
  RECOMMENDATION_BRANCHES,
  RECOMMENDATION_LEAVES,
  isRecommendationLeafId,
} from "../src/generate/recommendations.ts";
import { DASHBOARD_REVIEW_SYSTEM, dashboardReviewUser } from "../src/generate/prompts.ts";

test("review policy makes critique coverage primary and Well Done secondary", () => {
  assert.match(DASHBOARD_REVIEW_SYSTEM, /Work critique-first/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /strengths" array is SEPARATE and SECONDARY/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /A strength never substitutes for an evidence-grounded issue/);
  assert.doesNotMatch(DASHBOARD_REVIEW_SYSTEM, /do not let the effort spent on critiques crowd out/);
});

test("grounding registry preserves the codebook grounding labels exactly", () => {
  assert.deepEqual([...JUDGMENT_BASIS_LABELS], [
    "dashboard evidence",
    "general design principle",
    "analytical task",
    "audience",
    "author constraint",
    "personal preference",
  ]);
  assert.deepEqual(
    JUDGMENT_BASIS_REGISTRY.definitions.map((definition) => definition.label),
    [...JUDGMENT_BASIS_LABELS],
  );
  assert.equal(new Set(JUDGMENT_BASIS_REGISTRY.definitions.map((definition) => definition.id)).size, 6);
});

test("the review prompt frames DIAGNOSING, PRESENTING, and uniform grounding", () => {
  assert.match(DASHBOARD_REVIEW_SYSTEM, /DIAGNOSING/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /PRESENTING/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /GROUNDING/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /comprehensive coding system, not a checklist/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /EMPIRICAL SCAFFOLD/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /not a checklist/i);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /no default VIZier look/i);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /any branch: the recommendation branch is a grouping label/i);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /Full review may return up to 20 critiques/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /inferred is a usable working hypothesis/);
});

test("the diagnostic vocabulary exposes the codebook objects and problems", () => {
  assert.ok(OBJECT_CODES.has("chart"));
  assert.ok(OBJECT_CODES.has("color"));
  assert.ok(OBJECT_CODES.has("task"));
  assert.ok(PROBLEM_CODES.has("unclear | ambiguous"));
  assert.ok(PROBLEM_CODES.has("cluttered | crowded"));
  assert.ok(isObjectCode("interaction"));
  assert.ok(!isObjectCode("not-an-object"));
  assert.ok(isProblemCode("misleading"));
  assert.ok(!isProblemCode("not-a-problem"));
});

test("problem is optional and any object pairs with any problem (comprehensive tool)", () => {
  // An unobserved combination is still fully diagnosable — it just defaults low.
  assert.equal(priorWeightFor("color", "misleading"), "low");
  // Object-only priors resolve without a problem code.
  assert.equal(priorWeightFor("task"), "high");
  assert.equal(priorWeightFor("chart"), "high");
  // A high-prior observed combination.
  assert.equal(priorWeightFor("text", "unclear | ambiguous"), "high");
  // A medium-prior observed combination.
  assert.equal(priorWeightFor("color", "unclear | ambiguous"), "medium");
});

test("the diagnostic knowledge prompt carries objects, problems, grounding, and the full recommendation catalog", () => {
  const prompt = diagnosticKnowledgePrompt();
  assert.match(prompt, /OBJECTS/);
  assert.match(prompt, /PROBLEMS/);
  assert.match(prompt, /GROUNDING LABELS/);
  assert.match(prompt, /EMPIRICALLY OBSERVED OBJECT × PROBLEM PAIRS/);
  assert.match(prompt, /attention cues, NOT a checklist/);
  assert.match(prompt, /RECOMMENDATION CATALOG/);
  // Every branch header and every leaf id appears in the catalog block.
  for (const branch of RECOMMENDATION_BRANCHES) {
    assert.ok(prompt.includes(`[${branch}]`), branch);
  }
  for (const leaf of RECOMMENDATION_LEAVES) {
    assert.ok(prompt.includes(leaf.id), leaf.id);
  }
});

test("recommendation leaves are validated by exact id across all branches", () => {
  assert.ok(isRecommendationLeafId("interaction:support exploration and detail access"));
  assert.ok(isRecommendationLeafId("text:communicate takeaways"));
  assert.ok(!isRecommendationLeafId("interaction:invented leaf"));
  assert.equal(new Set(RECOMMENDATION_LEAVES.map((leaf) => leaf.id)).size, RECOMMENDATION_LEAVES.length);
});

test("context provenance distinguishes missing, inferred, and confirmed values", () => {
  const snapshot = buildContextSnapshot({
    goal: "Compare department performance.",
    audience: "Operations leaders.",
    fieldStatus: { audience: "confirmed" },
  });
  assert.equal(snapshot.fieldStatus.goal, "inferred");
  assert.equal(snapshot.fieldStatus.audience, "confirmed");
  assert.equal(snapshot.fieldStatus.constraints, "missing");
  assert.match(snapshot.id, /^ctx-/);
});

test("grounding availability is computed once per run from the context snapshot", () => {
  const empty = determineGroundingAvailability(buildContextSnapshot({}));
  // Artifact + principle bases need no context, so they are always available.
  assert.ok(empty.available.includes("dashboard evidence"));
  assert.ok(empty.available.includes("general design principle"));
  // Context-dependent bases are blocked until their field is present.
  assert.ok(empty.missing.includes("analytical task"));
  assert.ok(empty.missing.includes("audience"));
  assert.ok(empty.missingContext.includes("analytical_task"));

  const withGoal = determineGroundingAvailability(
    buildContextSnapshot({ goal: "Compare department performance." }),
  );
  assert.ok(withGoal.available.includes("analytical task"));
  assert.ok(!withGoal.missing.includes("analytical task"));
});

test("the model user prompt exposes grounding availability without legacy criterion gates", () => {
  const snapshot = buildContextSnapshot({});
  const packet = buildEvidencePacket(dashboardSpecMap(), dashboardBoard(), undefined);
  const userPrompt = dashboardReviewUser(snapshot, packet, determineGroundingAvailability(snapshot));
  assert.match(userPrompt, /GROUNDING AVAILABILITY/);
  assert.doesNotMatch(userPrompt, /criterionId/);
  assert.doesNotMatch(userPrompt, /authorizationPath/);
  assert.doesNotMatch(userPrompt, /ENGINE ELIGIBILITY/);
});

test("saved rationale keeps author text separate from its critique snapshot", () => {
  const snapshot = buildContextSnapshot({ notes: ["Keep the department colors."] });
  const packet = buildEvidencePacket(dashboardSpecMap(), dashboardBoard(), undefined);
  const userPrompt = dashboardReviewUser(
    snapshot,
    packet,
    determineGroundingAvailability(snapshot),
    undefined,
    undefined,
    [{
      id: "rationale-1",
      userRationale: "Keep the department colors.",
      dashboardVersion: 2,
      sourceCritiqueId: "critique-1",
      currentCritiqueId: "critique-2",
      critique: {
        id: "critique-1",
        title: "Use a more distinct palette",
        issue: "The palette uses similar hues.",
        suggestion: "Replace the palette.",
        dimension: "color",
        targetTileId: "department-tasks",
        proposalKind: "edit-spec",
      },
    }],
  );

  assert.match(userPrompt, /AUTHOR-SAVED CRITIQUE RATIONALES/);
  assert.match(userPrompt, /"sourceCritiqueId": "critique-1"/);
  assert.match(userPrompt, /"currentCritiqueId": "critique-2"/);
  assert.match(userPrompt, /Only userRationale is author-authored context/);
  assert.match(userPrompt, /cite context\.notes when it supports a claim/);
});

test("saved rationale prompt input is capped to the ten most recent entries", () => {
  const snapshot = buildContextSnapshot({});
  const packet = buildEvidencePacket(dashboardSpecMap(), dashboardBoard(), undefined);
  const savedRationales = Array.from({ length: 12 }, (_, index) => ({
    id: `rationale-${index + 1}`,
    userRationale: `Author statement ${index + 1}`,
    dashboardVersion: 1,
    sourceCritiqueId: `source-${index + 1}`,
    currentCritiqueId: `current-${index + 1}`,
    critique: { title: `Critique ${index + 1}` },
  }));
  const userPrompt = dashboardReviewUser(
    snapshot,
    packet,
    determineGroundingAvailability(snapshot),
    undefined,
    undefined,
    savedRationales,
  );

  assert.doesNotMatch(userPrompt, /"id": "rationale-1"/);
  assert.doesNotMatch(userPrompt, /"id": "rationale-2"/);
  assert.match(userPrompt, /"id": "rationale-12"/);
});

test("detectors contribute evidence helpers the diagnosis can cite", () => {
  const packet = buildEvidencePacket(dashboardSpecMap(), dashboardBoard(), undefined);
  assert.ok(packet.detectorEvidence.some((ref) => ref.findingId === "finding-generic-title"));
  assert.ok(packet.detectorFindings.length > 0);
});
