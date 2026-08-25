import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRefinedCritique,
  DECIDED_STATUSES,
  critiqueIdentityKey,
  critiqueRefreshLooksRetired,
  critiqueRefreshRequest,
  critiqueSolutionRefinementRequest,
  groupCritiquesByAsk,
  isDecidedCritique,
  mergeAskResults,
  pickCritiqueRefreshReplacement,
  refinementDirectionRequiresShorterText,
  solutionRefinementAlignment,
  solutionAttemptChanged,
} from "../src/critique-merge.js";

// Minimal critique factory — only the fields the merge cares about.
function critique(overrides = {}) {
  return {
    id: overrides.id || "c-1",
    object: "chart-title",
    problem: "unclear",
    tileId: "tile-a",
    recommendation: "add-title",
    dimension: "clarity",
    status: "pending",
    evidenceRefs: [],
    ...overrides,
  };
}

test("critiqueIdentityKey matches on object|problem|location|remedy", () => {
  const a = critique();
  const b = critique({ id: "c-2" });
  assert.equal(critiqueIdentityKey(a), critiqueIdentityKey(b));

  const different = critique({ id: "c-3", problem: "misleading" });
  assert.notEqual(critiqueIdentityKey(a), critiqueIdentityKey(different));
});

test("critiqueIdentityKey falls back to dimension when uncatalogued", () => {
  const uncatalogued = critique({ recommendation: undefined });
  // remedy slot falls back to dimension, not empty
  assert.match(critiqueIdentityKey(uncatalogued), /\|clarity$/);
});

test("critiqueIdentityKey falls back to 'dashboard' location without tileId", () => {
  const noTile = critique({ tileId: undefined });
  assert.match(critiqueIdentityKey(noTile), /\|dashboard\|/);
});

test("a consolidated critique keys on its sorted tile set, not the representative tile", () => {
  // The engine's consolidation is stateless: a fresh re-ask of the same shared
  // fix may pick a different representative tileId. Keying on the sorted tile set
  // (not the single representative) keeps the identity stable across asks.
  const first = critique({
    id: "first",
    tileId: "tile-a",
    target: { ref: { tile: "tile-a", tiles: ["tile-a", "tile-b", "tile-c"] } },
  });
  const reask = critique({
    id: "reask",
    tileId: "tile-c", // different representative, same tile set
    target: { ref: { tile: "tile-c", tiles: ["tile-c", "tile-b", "tile-a"] } },
  });
  assert.equal(critiqueIdentityKey(first), critiqueIdentityKey(reask));
  // The key reflects the whole set, not any single tile.
  assert.match(critiqueIdentityKey(first), /\|tile-a\+tile-b\+tile-c\|/);
});

test("re-asking a consolidated critique with a different representative does not duplicate it", () => {
  const existing = [critique({
    id: "kept",
    status: "pending",
    tileId: "tile-a",
    target: { ref: { tile: "tile-a", tiles: ["tile-a", "tile-b"] } },
  })];
  const incoming = [critique({
    id: "fresh",
    status: "pending",
    tileId: "tile-b", // stateless re-ask picked the other tile as representative
    target: { ref: { tile: "tile-b", tiles: ["tile-b", "tile-a"] } },
  })];
  const merged = mergeAskResults(existing, incoming, { askId: 8, reviewScope: "full" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "kept");
});

test("isDecidedCritique reflects DECIDED_STATUSES", () => {
  for (const status of DECIDED_STATUSES) {
    assert.equal(isDecidedCritique(critique({ status })), true, status);
  }
  for (const status of ["pending", "updated", "tentative"]) {
    assert.equal(isDecidedCritique(critique({ status })), false, status);
  }
});

test("a genuinely new critique enters as pending", () => {
  const incoming = [critique({ id: "new", status: undefined })];
  const merged = mergeAskResults([], incoming, { askId: 1, reviewScope: "full" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "pending");
  assert.equal(merged[0].askId, 1);
  assert.equal(merged[0].askScope, "full");
});

test("re-asking an accepted critique keeps it accepted (never reset to pending)", () => {
  const existing = [critique({ id: "acc", status: "accepted" })];
  const incoming = [critique({ id: "fresh", status: "pending" })]; // same identity
  const merged = mergeAskResults(existing, incoming, { askId: 2, reviewScope: "full" });

  // No duplicate card added; the decided one survives unchanged.
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "acc");
  assert.equal(merged[0].status, "accepted");
  // Provenance: the prior records that this ask re-surfaced it.
  assert.equal(merged[0].resurfacedByAskId, 2);
});

test("re-asking a rejected critique keeps it rejected", () => {
  const existing = [critique({ id: "rej", status: "rejected" })];
  const incoming = [critique({ id: "fresh", status: "pending" })];
  const merged = mergeAskResults(existing, incoming, { askId: 3, reviewScope: "focused" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "rejected");
});

test("duplicate pending critique is deduped, not doubled", () => {
  const existing = [critique({ id: "p1", status: "pending" })];
  const incoming = [critique({ id: "p2", status: "pending" })]; // same identity
  const merged = mergeAskResults(existing, incoming, { askId: 4, reviewScope: "full" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "p1"); // existing card kept
});

test("a strictly better-grounded refresh updates the active critique in place", () => {
  const existing = [
    critique({ id: "p1", status: "pending", evidenceRefs: ["e1"], suggestion: "old" }),
  ];
  const incoming = [
    critique({
      id: "p2",
      status: "pending",
      evidenceRefs: ["e1", "e2"],
      evidence: "richer",
      suggestion: "new",
      supportStatus: "validated",
    }),
  ];
  const merged = mergeAskResults(existing, incoming, { askId: 5, reviewScope: "full" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "p1"); // same card
  assert.deepEqual(merged[0].evidenceRefs, ["e1", "e2"]); // adopted fresher evidence
  assert.equal(merged[0].evidence, "richer");
  assert.equal(merged[0].suggestion, "new");
  assert.equal(merged[0].supportStatus, "validated");
});

test("a weaker-grounded refresh does not overwrite the active critique", () => {
  const existing = [
    critique({ id: "p1", status: "pending", evidenceRefs: ["e1", "e2"], suggestion: "keep" }),
  ];
  const incoming = [
    critique({ id: "p2", status: "pending", evidenceRefs: ["e1"], suggestion: "worse" }),
  ];
  const merged = mergeAskResults(existing, incoming, { askId: 6, reviewScope: "full" });
  assert.equal(merged[0].suggestion, "keep");
  assert.deepEqual(merged[0].evidenceRefs, ["e1", "e2"]);
});

test("prior critiques not re-returned by this ask are retained (accumulation)", () => {
  const existing = [
    critique({ id: "keep-me", problem: "unclear", status: "pending" }),
  ];
  const incoming = [
    critique({ id: "brand-new", problem: "misleading", status: "pending" }),
  ];
  const merged = mergeAskResults(existing, incoming, { askId: 7, reviewScope: "selected-region" });
  assert.equal(merged.length, 2);
  const ids = merged.map((c) => c.id).sort();
  assert.deepEqual(ids, ["brand-new", "keep-me"]);
});

test("a matching critique on a new dashboard version replaces the stale proposal", () => {
  const existing = [critique({
    id: "stable-card",
    askId: 3,
    askScope: "selected-region",
    origin: "local-review",
    localReview: { request: "Review this area" },
    bounds: { x: 10, y: 20, w: 100, h: 80 },
    revisions: [{ rationale: "Try a stronger hierarchy" }],
    lastEvaluatedVersion: 1,
    proposal: { kind: "edit-spec", edits: [{ op: "set", path: ["mark", "color"], value: "red" }] },
    suggestion: "Old transformation",
  })];
  const incoming = [critique({
    id: "fresh-engine-id",
    proposal: { kind: "edit-layout", composition: "hero-left" },
    suggestion: "Current transformation",
  })];
  const merged = mergeAskResults(existing, incoming, {
    askId: 8,
    reviewScope: "full",
    dashboardVersion: 2,
    synchronizeActive: true,
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "stable-card");
  assert.equal(merged[0].proposal.kind, "edit-layout");
  assert.equal(merged[0].suggestion, "Current transformation");
  assert.equal(merged[0].lastEvaluatedVersion, 2);
  assert.equal(merged[0].revision, 2);
  assert.equal(merged[0].askId, 8);
  assert.equal(merged[0].origin, undefined);
  assert.deepEqual(merged[0].revisions, [{ rationale: "Try a stronger hierarchy" }]);
});

test("a full review removes active critiques that it no longer confirms", () => {
  const existing = [critique({
    id: "stale",
    lastEvaluatedVersion: 1,
    problem: "unclear",
  })];
  const incoming = [critique({
    id: "new",
    lastEvaluatedVersion: 2,
    problem: "misleading",
  })];
  const merged = mergeAskResults(existing, incoming, {
    askId: 9,
    reviewScope: "full",
    dashboardVersion: 2,
    synchronizeActive: true,
  });
  assert.equal(merged.some((item) => item.id === "stale"), false);
  assert.equal(merged.find((item) => item.id === "new").status, "pending");
});

test("a focused review does not retire unrelated stale critique history", () => {
  const existing = [critique({ id: "unrelated", lastEvaluatedVersion: 1 })];
  const merged = mergeAskResults(existing, [], {
    askId: 10,
    reviewScope: "focused",
    dashboardVersion: 2,
  });
  assert.equal(merged[0].status, "pending");
});

test("an empty full response does not treat generation failure as proof issues disappeared", () => {
  const existing = [
    critique({ id: "remove", lastEvaluatedVersion: 1 }),
    critique({ id: "decision", status: "rejected", lastEvaluatedVersion: 1 }),
  ];
  const merged = mergeAskResults(existing, [], {
    askId: 11,
    reviewScope: "full",
    dashboardVersion: 2,
    synchronizeActive: true,
  });
  assert.deepEqual(merged.map((item) => item.id), ["remove", "decision"]);
});

test("a same-version full review replaces duplicate active content with the latest result", () => {
  const existing = [critique({
    id: "stable",
    lastEvaluatedVersion: 2,
    suggestion: "Old suggestion",
    proposal: { kind: "edit-spec", edits: [] },
  })];
  const incoming = [critique({
    id: "duplicate",
    suggestion: "Latest suggestion",
    proposal: { kind: "dashboard-title", label: "Current title" },
  })];
  const merged = mergeAskResults(existing, incoming, {
    askId: 12,
    reviewScope: "full",
    dashboardVersion: 2,
    synchronizeActive: true,
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "stable");
  assert.equal(merged[0].suggestion, "Latest suggestion");
  assert.equal(merged[0].proposal.kind, "dashboard-title");
});

test("a decided duplicate owns its identity even when an active copy follows it", () => {
  const existing = [
    critique({ id: "decision", status: "resolved" }),
    critique({ id: "accidental-active", status: "pending" }),
  ];
  const merged = mergeAskResults(existing, [critique({ id: "incoming" })], {
    askId: 13,
    reviewScope: "full",
    dashboardVersion: 3,
    synchronizeActive: true,
  });
  assert.equal(merged.some((item) => item.id === "incoming"), false);
  assert.deepEqual(merged.map((item) => item.id), ["decision"]);
});

test("merge is monotonic across a full then focused then region sequence", () => {
  let set = [];
  set = mergeAskResults(set, [critique({ id: "a", problem: "p1" })], { askId: 1, reviewScope: "full" });
  set = mergeAskResults(set, [critique({ id: "b", problem: "p2" })], { askId: 2, reviewScope: "focused" });
  set = mergeAskResults(set, [critique({ id: "c", problem: "p3" })], { askId: 3, reviewScope: "selected-region" });
  assert.equal(set.length, 3);
  assert.deepEqual(set.map((c) => c.askScope), ["full", "focused", "selected-region"]);
});

test("groupCritiquesByAsk groups by askId in ascending order", () => {
  const critiques = [
    critique({ id: "a2", askId: 2, askScope: "focused" }),
    critique({ id: "a1", askId: 1, askScope: "full" }),
    critique({ id: "a3", askId: 3, askScope: "selected-region" }),
  ];
  const groups = groupCritiquesByAsk(critiques);
  assert.deepEqual(groups.map((g) => g.askId), [1, 2, 3]);
  assert.deepEqual(groups.map((g) => g.askScope), ["full", "focused", "selected-region"]);
});

test("groupCritiquesByAsk keeps multiple critiques from one ask together", () => {
  const critiques = [
    critique({ id: "a", askId: 1, askScope: "full", problem: "p1" }),
    critique({ id: "b", askId: 1, askScope: "full", problem: "p2" }),
    critique({ id: "c", askId: 2, askScope: "focused", problem: "p3" }),
  ];
  const groups = groupCritiquesByAsk(critiques);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map((c) => c.id), ["a", "b"]);
  assert.deepEqual(groups[1].items.map((c) => c.id), ["c"]);
});

test("groupCritiquesByAsk collects legacy critiques (no askId) into a first group", () => {
  const critiques = [
    critique({ id: "new", askId: 2, askScope: "focused" }),
    critique({ id: "legacy", askId: undefined, problem: "p2" }),
  ];
  const groups = groupCritiquesByAsk(critiques);
  assert.equal(groups[0].askId, null);
  assert.equal(groups[0].items[0].id, "legacy");
  assert.equal(groups[1].askId, 2);
});

test("groupCritiquesByAsk preserves every item exactly once", () => {
  const critiques = [
    critique({ id: "a", askId: 1, problem: "p1" }),
    critique({ id: "b", askId: 1, problem: "p2" }),
    critique({ id: "c", askId: 2, problem: "p3" }),
    critique({ id: "d", askId: undefined, problem: "p4" }),
  ];
  const groups = groupCritiquesByAsk(critiques);
  const flatIds = groups.flatMap((g) => g.items.map((c) => c.id)).sort();
  assert.deepEqual(flatIds, ["a", "b", "c", "d"]);
});

test("critiqueRefreshRequest asks the engine to refresh one issue only", () => {
  const request = critiqueRefreshRequest(critique({
    title: "Hard-coded KPI row",
    issue: "KPIs are static",
    suggestion: "Compute them from the data",
    tileId: null,
    dimension: "layout",
  }));
  assert.match(request, /ONE previously identified issue/);
  assert.match(request, /Hard-coded KPI row/);
  assert.match(request, /Do not start a full new review/);
});

test("solution refinement keeps the diagnosis fixed and asks for one executable alternative", () => {
  const previous = critique({
    title: "The callout dominates the analysis",
    issue: "A small supporting fact occupies most of the canvas",
    evidence: "The callout is larger than both analytical charts",
    suggestion: "Shrink the callout",
    proposal: { kind: "edit-layout", mode: "executable" },
    revision: 2,
  });
  const request = critiqueSolutionRefinementRequest(previous, "Keep the layout; reduce only the empty space.");
  assert.match(request, /author accepts the diagnosis/i);
  assert.match(request, /Keep the issue, evidence, target, and scope fixed/);
  assert.match(request, /exactly one concrete executable recommendation/);
  assert.match(request, /Keep the layout; reduce only the empty space/);

  const refined = buildRefinedCritique(previous, {
    title: "A different title that must not replace the diagnosis",
    issue: "A different issue that must not be accepted",
    suggestion: "Tighten padding inside the callout",
    proposal: { kind: "edit-spec", mode: "executable" },
  }, "Keep the layout", 4);
  assert.equal(refined.id, previous.id);
  assert.equal(refined.title, previous.title);
  assert.equal(refined.issue, previous.issue);
  assert.equal(refined.evidence, previous.evidence);
  assert.equal(refined.suggestion, "Tighten padding inside the callout");
  assert.equal(refined.proposal.kind, "edit-spec");
  assert.equal(refined.revision, 3);
  assert.equal(refined.lastEvaluatedVersion, 4);
  assert.deepEqual(refined.revisions.at(-1), {
    rationale: "Keep the layout",
    suggestion: "Tighten padding inside the callout",
  });
  assert.equal(solutionAttemptChanged(previous, refined), true);
  assert.equal(solutionAttemptChanged(previous, {
    suggestion: previous.suggestion,
    proposal: structuredClone(previous.proposal),
  }), false);
});

test("shorter-text refinement becomes a prompt constraint and a client acceptance check", () => {
  const previous = critique({
    suggestion: "Replace the current heading with a concise statement of the dashboard's main takeaway.",
    proposal: {
      kind: "dashboard-title",
      label: "Britain's favourite garden birds remain common, but several familiar species have declined sharply",
    },
  });
  assert.equal(refinementDirectionRequiresShorterText("the text is too long"), true);
  assert.equal(refinementDirectionRequiresShorterText("文本太长，请精简"), true);
  assert.match(
    critiqueSolutionRefinementRequest(previous, "the text is too long"),
    /HARD ACCEPTANCE CONSTRAINT[\s\S]*at least 20% shorter/,
  );

  const stillLong = solutionRefinementAlignment(previous, {
    suggestion: "Replace the current heading with another concise statement of the dashboard's main takeaway.",
    proposal: {
      kind: "dashboard-title",
      label: "Britain's garden birds remain common, though several familiar species have declined sharply",
    },
  }, "the text is too long");
  assert.equal(stillLong.aligned, false);
  assert.match(stillLong.reason, /not materially shorter/i);

  const dodgesTextChange = solutionRefinementAlignment(previous, {
    suggestion: "Shorten the heading to its core takeaway.",
    proposal: { kind: "edit-layout", composition: "hero-left" },
  }, "the text is too long");
  assert.equal(dodgesTextChange.aligned, false);
  assert.match(dodgesTextChange.reason, /did not provide.*shorter replacement text/i);

  const shorter = solutionRefinementAlignment(previous, {
    suggestion: "Shorten the heading to its core conservation takeaway.",
    proposal: { kind: "dashboard-title", label: "Britain's garden birds are declining" },
  }, "the text is too long");
  assert.deepEqual(shorter, { aligned: true, reason: "" });
});

test("shorter-text validation checks concrete text inside edit-spec proposals", () => {
  const previous = critique({
    suggestion: "Use a shorter axis title that keeps the measure clear for readers.",
    proposal: {
      kind: "edit-spec",
      edits: [{ op: "set", path: ["encoding", "x", "axis", "title"], value: "Average number of birds observed per garden" }],
    },
  });
  const result = solutionRefinementAlignment(previous, {
    suggestion: "Shorten the axis title for faster scanning.",
    proposal: {
      kind: "edit-spec",
      edits: [{ op: "set", path: ["encoding", "x", "axis", "title"], value: "Average birds observed per garden" }],
    },
  }, "the axis text is too long");
  assert.equal(result.aligned, true);
});

test("pickCritiqueRefreshReplacement keeps the matching issue and ignores extras", () => {
  const previous = critique({
    id: "kpi",
    title: "KPI row",
    proposal: { kind: "add-kpi-band", mode: "executable" },
  });
  const match = critique({
    id: "fresh",
    title: "Computed KPI band",
    proposal: { kind: "add-kpi-band", mode: "executable" },
    suggestion: "Use engine KPIs",
  });
  const extra = critique({
    id: "other",
    object: "color",
    problem: "inconsistent",
    recommendation: "palette",
    dimension: "color",
    tileId: "chart-b",
    proposal: { kind: "v2-palette", mode: "executable" },
  });
  const picked = pickCritiqueRefreshReplacement(previous, [extra, match]);
  assert.equal(picked.id, "fresh");
  assert.equal(picked.suggestion, "Use engine KPIs");
});

test("pickCritiqueRefreshReplacement retires the card when the issue is gone", () => {
  assert.equal(
    pickCritiqueRefreshReplacement(critique(), [], "No material issue remains; the KPI row is now computed."),
    null,
  );
  assert.equal(
    pickCritiqueRefreshReplacement(
      critique(),
      [critique({
        title: "Guidance for this review request",
        proposal: { kind: "manual", mode: "guidance_only" },
        issue: "Keep the current treatment unless testing shows a problem.",
      })],
    ),
    null,
  );
  assert.equal(critiqueRefreshLooksRetired(null, "This issue is no longer applicable after the applied change."), true);
});
