import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groundText,
  isGroundedText,
  templateText,
  generateCritiques,
} from "../src/generate/critique.ts";
import {
  crossFilterFinding,
  tooltipFinding,
  StubClient,
  findingsFixture,
  allFindingsFixture,
} from "./helpers.ts";

test("well-grounded model text is accepted", () => {
  const finding = crossFilterFinding();
  const { text, usedFallbackFor } = groundText(finding, {
    title: "Department bars don't coordinate the other views",
    issue: "Selecting a department in the bar chart leaves the velocity and status views unchanged.",
    rationale: "Coordinated views let readers isolate one team quickly.",
    evidence: "The bar chart encodes department but no view defines a linked selection.",
    suggestion: "Bind a point selection on department and filter the other two views.",
  });
  assert.equal(usedFallbackFor.length, 0);
  assert.match(text.title, /coordinate/);
});

test("guardrail rejects text that drifts to the wrong interaction", () => {
  const finding = crossFilterFinding(); // cross-filter; mentioning tooltip is drift
  const { text, usedFallbackFor } = groundText(finding, {
    issue: "The chart needs a tooltip on hover to reveal values.",
  });
  assert.ok(usedFallbackFor.includes("issue"));
  assert.equal(text.issue, templateText(finding).issue); // fell back to grounded template
});

test("guardrail rejects fabricated numeric interaction results", () => {
  const finding = crossFilterFinding();
  assert.equal(isGroundedText("Clicking Eng shows 12 tasks in the other views.", finding), false);
  assert.equal(isGroundedText("Selecting a department filters the coordinated views.", finding), true);
});

test("tooltip finding rejects text claiming it already works", () => {
  const finding = tooltipFinding();
  assert.equal(isGroundedText("The line already reveals values on hover.", finding), false);
});

test("color/data/text findings map to their proposal kind + surface", async () => {
  const critiques = await generateCritiques(allFindingsFixture(), { goal: "g" });
  const byKind = (k: string) => critiques.find((c) => c.proposal.kind === k)!;

  const palette = byKind("v2-palette");
  assert.equal(palette.dimension, "color");
  assert.equal(palette.surface, "encoding");
  assert.equal(palette.interactionKind, undefined);

  const kpi = byKind("add-kpis");
  assert.equal(kpi.dimension, "data");
  assert.equal(kpi.surface, "structural");

  const title = byKind("dashboard-title");
  assert.equal(title.dimension, "text");
  assert.equal(title.surface, "text");

  // The v2 conflict pair (both color proposals) is present and grounded.
  assert.ok(byKind("preserve-brand-palette").grounded);
  assert.ok(critiques.every((c) => c.phrasingSource === "template"));
});

test("a color-palette guardrail does not reject legitimate color language", () => {
  const palette = allFindingsFixture().find((f) => f.kind === "uniform-palette")!;
  assert.equal(
    isGroundedText("Both charts lean on the same navy tone, so their roles blur together.", palette),
    true,
  );
});

test("structural fields always come from the finding, never the model", async () => {
  // A malicious stub tries to change the proposal + assert a different interaction.
  const stub = new StubClient({
    title: "unrelated",
    proposalKind: "add-cross-filter", // should be ignored
    interactionKind: "cross-filter", // should be ignored
    issue: "add a tooltip please", // drift keyword -> rejected for the cf critique
  });
  const critiques = await generateCritiques(findingsFixture(), { goal: "g" }, { client: stub });
  const tip = critiques.find((c) => c.findingId === "finding-tooltip-task-velocity")!;
  assert.equal(tip.proposal.kind, "add-tooltip");
  assert.equal(tip.interactionKind, "hover-tooltip");
  assert.equal(tip.grounded, true);
});

test("real mode fails instead of returning templates without an LLM", async () => {
  await assert.rejects(
    generateCritiques(findingsFixture(), { goal: "g" }, { requireLLM: true }),
    /LLM_REQUIRED/,
  );
});

test("real mode rejects model text that requires template fallback", async () => {
  const stub = new StubClient({ title: "Only one field is present" });
  await assert.rejects(
    generateCritiques([crossFilterFinding()], { goal: "g" }, { client: stub, requireLLM: true }),
    /LLM_GUARDRAIL_FAILED/,
  );
});
