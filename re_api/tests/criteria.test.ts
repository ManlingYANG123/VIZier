import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  parseRecommendationCsv,
} from "../src/generate/recommendations.ts";
import { DASHBOARD_REVIEW_SYSTEM, dashboardReviewUser } from "../src/generate/prompts.ts";
import {
  CRITIQUE_FEW_SHOT_CONTENT_HASH,
  CRITIQUE_FEW_SHOT_IDS,
  CRITIQUE_FEW_SHOT_SET,
  critiqueFewShotPrompt,
  runtimeCritiqueFewShotPrompt,
  parseCritiqueFewShotSet,
} from "../src/generate/critique-few-shots.ts";

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
  assert.match(DASHBOARD_REVIEW_SYSTEM, /FEW-SHOT MAPPING EXAMPLES/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /Never copy an example's tile names/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /not a checklist/i);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /no default VIZier look/i);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /any branch: the recommendation branch is a grouping label/i);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /Full review may return up to 11 critiques/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /8–12 distinct formative observations/);
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
  assert.match(prompt, /Empirical feedback examples \(few-shot mapping cues\)/);
});

test("recommendation CSV examples feed the catalog without a color dependency", () => {
  const sourceHeader = readFileSync(
    new URL("../../slack_codebook/recommendation_v3_examples.csv", import.meta.url),
    "utf8",
  ).split(/\r?\n/, 1)[0];
  assert.equal(sourceHeader, "code,definition,Example 1,Example 2,Example 3");
  const parsed = parseRecommendationCsv([
    "code,definition,Example 1,Example 2,Example 3",
    'Interaction:support coordinated views,"coordinate linked views","Filter one view.","Update the others.","Keep state visible."',
  ].join("\n"));
  assert.deepEqual(parsed, [{
    id: "interaction:support coordinated views",
    branch: "interaction",
    leaf: "support coordinated views",
    definition: "coordinate linked views",
    examples: ["Filter one view.", "Update the others.", "Keep state visible."],
  }]);
  assert.ok(RECOMMENDATION_LEAVES.some((leaf) => leaf.examples.length > 0));
  assert.ok(RECOMMENDATION_LEAVES.some((leaf) => leaf.examples.length === 3));
  assert.ok(RECOMMENDATION_LEAVES.every((leaf) => !("color" in leaf)));
  assert.ok(isRecommendationLeafId("interaction:support coordinated views"));
});

test("recommendation leaves are validated by exact id across all branches", () => {
  assert.ok(isRecommendationLeafId("interaction:support exploration and detail access"));
  assert.ok(isRecommendationLeafId("text:communicate takeaways"));
  assert.ok(!isRecommendationLeafId("interaction:invented leaf"));
  assert.equal(new Set(RECOMMENDATION_LEAVES.map((leaf) => leaf.id)).size, RECOMMENDATION_LEAVES.length);
});

test("the fixed end-to-end few-shot set is complete, compact, and provenance-safe", () => {
  assert.equal(CRITIQUE_FEW_SHOT_SET.examples.length, 6);
  assert.equal(new Set(CRITIQUE_FEW_SHOT_IDS).size, 6);
  assert.match(CRITIQUE_FEW_SHOT_CONTENT_HASH, /^[a-f0-9]{64}$/);
  const prompt = critiqueFewShotPrompt();
  assert.match(prompt, /END-TO-END CRITIQUE DEMONSTRATIONS/);
  assert.match(prompt, /INPUT:/);
  assert.match(prompt, /EXPECTED OUTPUT:/);
  assert.ok(prompt.includes("fs-03-analytical-interaction-applicability"));
  assert.ok(prompt.includes("fs-04-infographic-interaction-nonapplicability"));
  assert.ok(prompt.length < 80_000, `few-shot prompt is ${prompt.length} chars`);
  // Maintainership provenance stays in the JSON but is never sent to the LLM.
  assert.doesNotMatch(prompt, /slack-replies-coded-consolidated-08-17/);
  assert.doesNotMatch(prompt, /threadId|replyId|unitId|adaptation/);
});

test("few-shot parsing fails fast for unknown catalog codes", () => {
  const source = readFileSync(
    new URL("../data/critique-few-shots-v1.json", import.meta.url),
    "utf8",
  );
  assert.throws(
    () => parseCritiqueFewShotSet(source.replace(
      "chart:support perception",
      "chart:not-a-real-recommendation",
    )),
    /unknown recommendation/,
  );
});

test("the production system prompt uses a compact, genre-diverse demonstration set", () => {
  const runtime = runtimeCritiqueFewShotPrompt();
  assert.match(DASHBOARD_REVIEW_SYSTEM, /CURATED END-TO-END CRITIQUE DEMONSTRATIONS/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /evidence→diagnosis→critique/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /fs-03-analytical-interaction-applicability/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /fs-04-infographic-interaction-nonapplicability/);
  assert.doesNotMatch(runtime, /fs-05-keep-local-issue-local/);
  assert.doesNotMatch(runtime, /"diagnoses"\s*:/);
  assert.doesNotMatch(DASHBOARD_REVIEW_SYSTEM, /"diagnoses"\s*:/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /do not return a separate diagnoses array/);
  assert.ok(DASHBOARD_REVIEW_SYSTEM.length < 60_000, `runtime prompt is ${DASHBOARD_REVIEW_SYSTEM.length} chars`);
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

test("design document constraints and source text enter the review prompt", () => {
  const snapshot = buildContextSnapshot({});
  const packet = buildEvidencePacket(dashboardSpecMap(), dashboardBoard(), undefined);
  const userPrompt = dashboardReviewUser(
    snapshot,
    packet,
    determineGroundingAvailability(snapshot),
    undefined,
    undefined,
    [],
    undefined,
    {
      id: "ct-test",
      sourceKind: "pdf-text",
      provenance: "brand-guide.pdf · 4 pages",
      constraints: [{
        id: "c-palette",
        category: "palette",
        rule: "Use only the navy brand palette",
        sourceText: "Brand colors only: navy and white.",
        confidence: "high",
        value: { colors: ["#0f172a"], locked: true },
      }],
    },
    "Brand colors only: navy and white. Do not introduce unapproved chart hues.",
  );
  assert.match(userPrompt, /DESIGN DOCUMENT \(brand-guide\.pdf · 4 pages\)/);
  assert.match(userPrompt, /not a second artifact to diagnose/);
  assert.match(userPrompt, /HARD CONSTRAINTS/);
  assert.match(userPrompt, /Use only the navy brand palette/);
  assert.match(userPrompt, /SOURCE TEXT/);
  assert.match(userPrompt, /Do not introduce unapproved chart hues/);
  assert.match(DASHBOARD_REVIEW_SYSTEM, /uploaded DESIGN DOCUMENT/);
});

test("detectors contribute evidence helpers the diagnosis can cite", () => {
  const packet = buildEvidencePacket(dashboardSpecMap(), dashboardBoard(), undefined);
  assert.ok(packet.detectorEvidence.some((ref) => ref.findingId === "finding-generic-title"));
  assert.ok(packet.detectorFindings.length > 0);
});
