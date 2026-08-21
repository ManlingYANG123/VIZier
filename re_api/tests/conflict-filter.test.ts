/**
 * Silent conflict filter — drop/keep behavior against hard design constraints.
 * Covers Layer 1 (deterministic palette lock), Layer 2 (LLM judge), graceful
 * degradation, the direct-answer exemption, and the byte-identical short-circuit
 * when no constraint set is present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ConstraintSet,
  Critique,
  Finding,
  HardConstraint,
  Proposal,
} from "../src/contracts.ts";
import {
  filterConflictingCritiques,
  type RankedItem,
} from "../src/generate/conflict-filter.ts";
import { discoverDashboardCritiques } from "../src/generate/discover.ts";
import { dashboardBoard, dashboardSpecMap } from "../fixtures/specs.ts";
import { StubClient, SequenceClient, diagnosisPayload } from "./helpers.ts";

/** A minimal ranked item — the filter reads only these critique fields. */
function item(critique: Partial<Critique> & { id: string; proposal: Proposal }): RankedItem {
  const full = {
    tileId: null,
    dimension: "other",
    priority: "medium",
    status: "pending",
    source: "ai",
    title: critique.title ?? `critique ${critique.id}`,
    issue: critique.issue ?? "issue text",
    rationale: "rationale",
    evidence: "evidence",
    suggestion: critique.suggestion ?? "suggestion text",
    target: { granularity: "dashboard", ref: {} },
    surface: "chart",
    findingId: `f-${critique.id}`,
    grounded: true,
    phrasingSource: "llm",
    ...critique,
  } as Critique;
  const finding = { id: `f-${critique.id}` } as Finding;
  return { critique: full, finding };
}

function lockedPaletteSet(): ConstraintSet {
  const constraint: HardConstraint = {
    id: "hc-1-abcd1234",
    category: "palette",
    rule: "Use only the brand palette (locked)",
    sourceText: "All charts must use the brand palette; do not recolor.",
    confidence: "high",
    value: { colors: ["#0A2540", "#00B4D8"], locked: true },
  };
  return { id: "ct-locked", sourceKind: "pdf-text", provenance: "brand.pdf", constraints: [constraint] };
}

const recolorEdit: Proposal = {
  kind: "edit-spec",
  edits: [{ op: "set", path: ["encoding", "color", "scale", "scheme"], value: "tableau10" }],
};

test("no constraint set returns the exact same array (byte-identical)", async () => {
  const ranked = [item({ id: "a", proposal: { kind: "v2-palette" } })];
  const result = await filterConflictingCritiques(ranked, undefined, undefined);
  assert.equal(result.kept, ranked, "kept must be the same reference");
  assert.deepEqual(result.dropped, []);
});

test("empty constraint set short-circuits to the same array", async () => {
  const ranked = [item({ id: "a", proposal: { kind: "v2-palette" } })];
  const empty: ConstraintSet = { id: "ct-empty", sourceKind: "raw-text", provenance: "x", constraints: [] };
  const result = await filterConflictingCritiques(ranked, empty, undefined);
  assert.equal(result.kept, ranked);
});

test("Layer 1 drops a v2-palette recolor when the palette is locked", async () => {
  const ranked = [
    item({ id: "recolor", proposal: { kind: "v2-palette" } }),
    item({ id: "tooltip", proposal: { kind: "add-tooltip" } as Proposal }),
  ];
  // No client → Layer 2 never runs; the drop is purely deterministic.
  const result = await filterConflictingCritiques(ranked, lockedPaletteSet(), undefined);
  assert.deepEqual(result.kept.map((i) => i.critique.id), ["tooltip"]);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].id, "recolor");
  assert.equal(result.dropped[0].category, "palette");
});

test("Layer 1 drops an edit-spec that rewrites the color scale scheme", async () => {
  const ranked = [item({ id: "recolor-edit", proposal: recolorEdit })];
  const result = await filterConflictingCritiques(ranked, lockedPaletteSet(), undefined);
  assert.deepEqual(result.kept.map((i) => i.critique.id), []);
  assert.equal(result.dropped[0].id, "recolor-edit");
});

test("ordinary best-practice color advice does not lock the palette", async () => {
  const advice: HardConstraint = {
    id: "hc-color-advice",
    category: "palette",
    rule: "Use color only to highlight what matters",
    sourceText: "Use color only when it communicates meaningful information.",
    confidence: "high",
  };
  const set: ConstraintSet = {
    id: "ct-color-advice",
    sourceKind: "pdf-text",
    provenance: "best-practices.pdf",
    constraints: [advice],
  };
  const ranked = [item({ id: "recolor", proposal: { kind: "v2-palette" } })];
  const result = await filterConflictingCritiques(ranked, set, undefined);
  assert.deepEqual(result.kept.map((entry) => entry.critique.id), ["recolor"]);
  assert.deepEqual(result.dropped, []);
});

test("explicit high-confidence text can lock a palette without a machine value", async () => {
  const lock: HardConstraint = {
    id: "hc-text-lock",
    category: "palette",
    rule: "Use only the approved brand palette",
    sourceText: "All dashboards must use only the approved brand palette.",
    confidence: "high",
  };
  const set: ConstraintSet = {
    id: "ct-text-lock",
    sourceKind: "pdf-text",
    provenance: "brand.pdf",
    constraints: [lock],
  };
  const result = await filterConflictingCritiques(
    [item({ id: "recolor", proposal: { kind: "v2-palette" } })],
    set,
    undefined,
  );
  assert.deepEqual(result.kept, []);
  assert.equal(result.dropped[0].id, "recolor");
});

test("common brand-lock phrasing still protects the empirical design constraint", async () => {
  const phrasings = [
    "Only use colors from the brand palette",
    "Charts must use the approved palette",
    "Do not use colors outside the brand palette",
    "Colors are restricted to the brand palette",
  ];
  for (const [index, rule] of phrasings.entries()) {
    const set: ConstraintSet = {
      id: `ct-brand-lock-${index}`,
      sourceKind: "pdf-text",
      provenance: "brand.pdf",
      constraints: [{
        id: `hc-brand-lock-${index}`,
        category: "palette",
        rule,
        sourceText: rule,
        confidence: "high",
      }],
    };
    const result = await filterConflictingCritiques(
      [item({ id: `recolor-${index}`, proposal: { kind: "v2-palette" } })],
      set,
      undefined,
    );
    assert.equal(result.kept.length, 0, rule);
  }
});

test("preserve-brand-palette agrees with the lock and is kept", async () => {
  const ranked = [item({ id: "preserve", proposal: { kind: "preserve-brand-palette" } as Proposal })];
  const result = await filterConflictingCritiques(ranked, lockedPaletteSet(), undefined);
  assert.deepEqual(result.kept.map((i) => i.critique.id), ["preserve"]);
  assert.deepEqual(result.dropped, []);
});

test("Layer 2 drops a semantic (prose) conflict the LLM judge flags", async () => {
  const ranked = [
    item({ id: "font", title: "Switch to Inter", proposal: { kind: "guidance" } as Proposal }),
    item({ id: "keep", title: "Add a subtitle", proposal: { kind: "chart-subtitles" } as Proposal }),
  ];
  const constraints: HardConstraint[] = [{
    id: "hc-1-typo0001",
    category: "typography",
    rule: "All text must use Helvetica Neue",
    sourceText: "Typography: Helvetica Neue only.",
    confidence: "high",
  }];
  const set: ConstraintSet = { id: "ct-typo", sourceKind: "pdf-text", provenance: "brand.pdf", constraints };
  const judge = new StubClient({ drops: [{ id: "font", constraintId: "hc-1-typo0001", reason: "swaps a required font" }] });
  const result = await filterConflictingCritiques(ranked, set, judge);
  assert.deepEqual(result.kept.map((i) => i.critique.id), ["keep"]);
  assert.equal(result.dropped[0].id, "font");
  assert.equal(result.dropped[0].category, "typography");
});

test("graceful degradation: a judge failure keeps every Layer-1 survivor", async () => {
  const failing = new (class extends StubClient {
    async completeJson(): Promise<never> {
      throw new Error("gateway exploded");
    }
  })({});
  const ranked = [
    item({ id: "recolor", proposal: { kind: "v2-palette" } }),
    item({ id: "font", proposal: { kind: "guidance" } as Proposal }),
  ];
  const result = await filterConflictingCritiques(ranked, lockedPaletteSet(), failing);
  // Layer 1 still drops the recolor; Layer 2's failure loses nothing else.
  assert.deepEqual(result.kept.map((i) => i.critique.id), ["font"]);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].id, "recolor");
});

test("direct-answer critique is never dropped, even when it conflicts", async () => {
  const ranked = [
    item({ id: "recolor", proposal: { kind: "v2-palette" }, requestRelevance: "direct", answer: "Yes, recolor it." }),
  ];
  // Judge would also flag it, but the exemption wins.
  const judge = new StubClient({ drops: [{ id: "recolor", constraintId: "hc-1-abcd1234", reason: "recolor" }] });
  const result = await filterConflictingCritiques(ranked, lockedPaletteSet(), judge);
  assert.deepEqual(result.kept.map((i) => i.critique.id), ["recolor"]);
  assert.deepEqual(result.dropped, []);
});

const REVIEW_CRITIQUE = {
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

test("byte-identical: an undefined constraint set leaves the review output untouched", async () => {
  const payload = diagnosisPayload([REVIEW_CRITIQUE]);
  const baseline = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { scope: ["chart"] },
    dashboardBoard(),
    new StubClient(payload),
  );
  const withUndefined = await discoverDashboardCritiques(
    dashboardSpecMap(),
    { scope: ["chart"] },
    dashboardBoard(),
    new StubClient(payload),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined, // constraintSet omitted
  );
  assert.deepEqual(withUndefined.critiques, baseline.critiques);
  assert.deepEqual(withUndefined.findings, baseline.findings);
  assert.equal(withUndefined.answer, baseline.answer);
  assert.equal(withUndefined.droppedByConstraint, undefined);
});

test("the judge never sees a direct-answer critique among the survivors", async () => {
  const ranked = [
    item({ id: "direct", proposal: { kind: "guidance" } as Proposal, requestRelevance: "direct" }),
    item({ id: "other", proposal: { kind: "guidance" } as Proposal }),
  ];
  const set: ConstraintSet = {
    id: "ct-typo",
    sourceKind: "raw-text",
    provenance: "notes",
    constraints: [{ id: "hc-1-x", category: "typography", rule: "font", sourceText: "font", confidence: "low" }],
  };
  const seq = new SequenceClient([{ drops: [] }]);
  await filterConflictingCritiques(ranked, set, seq);
  assert.ok(!seq.firstUserText.includes('"direct"'), "direct-answer id must be excluded from the judge payload");
  assert.ok(seq.firstUserText.includes('"other"'));
});
