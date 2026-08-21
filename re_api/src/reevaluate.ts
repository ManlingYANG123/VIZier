/**
 * Living-recommendation re-evaluation after a fix is applied.
 *
 * Mirrors reevaluateMock in prototype/v2/src/recommendation-engine.js, but the
 * signal is REAL: we re-run the deterministic detectors on the mutated spec map
 * and mark critiques resolved when their gap no longer exists. Applying a
 * cross-filter introduces a follow-up "show the active filter" critique, just
 * like the mock.
 */
import type { BoardMeta, Critique, RecommendationDelta, SpecMap } from "./contracts.ts";
import { runDetectors } from "./detect/index.ts";
import {
  CRITERION_REGISTRY_VERSION,
  REVIEW_ENGINE_VERSION,
  REVIEW_PROMPT_VERSION,
  priorWeightFor,
} from "./generate/review-data.ts";

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * The tiles a critique's fix is meant to span. Only ref.tiles marks a card as
 * consolidated (the multi-tile marker mergeAndRank / the model-obeys path set);
 * ref.tile and tileId are the single-tile identity. Cross-view refs
 * (source/targets) are deliberately excluded so cross-filter resolution is
 * unchanged — this set only governs the "all listed tiles must have changed"
 * check for consolidated cards.
 */
function consolidatedTargetTiles(critique: Critique): string[] {
  const ref = (critique.target?.ref ?? {}) as Record<string, unknown>;
  const tiles = [
    ...(critique.tileId ? [critique.tileId] : []),
    ...(typeof ref.tile === "string" ? [ref.tile] : []),
    ...(Array.isArray(ref.tiles) ? ref.tiles.filter((id): id is string => typeof id === "string") : []),
  ];
  return [...new Set(tiles)];
}

/**
 * The follow-up carries the cross-filter source tile in `target.ref.source` so
 * the show-filter-state transform (apply/index.ts::applyShowFilterState) has a
 * concrete tile to stamp. Without it the engine would propose a fix it then
 * refuses to apply (applyProposals -> APPLY_NO_CHANGE). `component` is retained
 * only as the display label of the affected board region.
 */
export function activeFilterFollowUp(source?: string): Critique {
  return {
    id: "c-show-filter-state",
    tileId: source ?? null,
    dimension: "interaction",
    priority: "medium",
    status: "pending",
    source: "ai",
    title: "Active filter selection is not visible",
    issue:
      "Cross-filtering now works, but the dashboard does not persistently show which value is active, so a reader can't tell why the coordinated views changed.",
    rationale:
      "Visible system status helps readers understand why values changed and how to return to the full view.",
    evidence:
      "The new cross-filter updates the coordinated views while the selection is only encoded in the source chart.",
    suggestion: "Add a compact active-filter chip with a clear action above the coordinated views.",
    target: {
      granularity: "cross-view-interaction",
      ref: source
        ? { source, component: "active-filter-state" }
        : { component: "active-filter-state" },
    },
    proposal: { kind: "show-filter-state", mode: "executable" },
    surface: "interaction",
    interactionKind: "cross-filter",
    findingId: "followup-active-filter",
    grounded: true,
    phrasingSource: "template",
    reviewScope: "full",
    object: "interaction",
    problem: "missing | absent | unsupported",
    recommendation: "interaction:show system status and response",
    diagnosisOutcome: "evaluated_issue",
    priorWeight: priorWeightFor("interaction", "missing | absent | unsupported"),
    judgmentBasis: ["dashboard evidence", "general design principle"],
    requiredContext: [],
    contextStatus: "not_applicable",
    evidenceRefs: [{
      source: "interaction",
      path: "interaction.active-filter-state",
      detail: "The applied cross-filter changes coordinated views without a persistent visible selection state.",
      ...(source ? { tileId: source } : {}),
    }],
    supportStatus: "validated",
    registryVersion: CRITERION_REGISTRY_VERSION,
    promptVersion: REVIEW_PROMPT_VERSION,
    engineVersion: REVIEW_ENGINE_VERSION,
  };
}

export interface ReevalResult {
  critiques: Critique[];
  added: string[];
  delta: RecommendationDelta;
  remainingFindings: number;
}

export function reevaluate(
  previous: Critique[],
  appliedIds: string[],
  newSpecMap: SpecMap,
  changedTargets: string[],
  board?: BoardMeta,
): ReevalResult {
  const applied = new Set(appliedIds);
  const appliedKinds = new Set(
    previous.filter((c) => applied.has(c.id)).map((c) => c.proposal.kind),
  );

  const remainingFindings = runDetectors(newSpecMap, board);
  const remainingFindingIds = new Set(remainingFindings.map((f) => f.id));
  const changed = new Set(changedTargets);

  const kept: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];

  const next: Critique[] = previous.map((prev) => {
    const c = clone(prev);
    if (applied.has(c.id)) {
      // A consolidated multi-tile card lists every tile the one fix spans in
      // ref.tiles. It is only truly resolved when the fix actually landed on ALL
      // of them; if a listed tile never changed (e.g. an earlier same-batch edit
      // stripped its fields, or a stale client applied a subset), mark the card
      // "updated" so it stays surfaced for re-review rather than falsely reading
      // as fully applied on a tile it never touched. Single-tile critiques (no
      // ref.tiles) keep the prior behavior exactly.
      const consolidatedTiles = consolidatedTargetTiles(c);
      if (consolidatedTiles.length > 1 && !consolidatedTiles.every((id) => changed.has(id))) {
        c.status = "updated";
        updated.push(c.id);
        return c;
      }
      c.status = "resolved";
      return c;
    }
    // A critique whose finding disappeared (side-effect of another fix) but was
    // not explicitly applied is now stale -> removed.
    const detectorRefs = (c.evidenceRefs || [])
      .filter((ref) => ref.source === "detector" && ref.findingId)
      .map((ref) => ref.findingId!);
    if (c.status === "pending" && detectorRefs.length && detectorRefs.every((id) => !remainingFindingIds.has(id))) {
      c.status = "superseded";
      removed.push(c.id);
      return c;
    }
    const targetRef = c.target?.ref || {};
    const targetIds = [
      c.tileId,
      typeof targetRef.tile === "string" ? targetRef.tile : null,
      typeof targetRef.source === "string" ? targetRef.source : null,
      // A consolidated multi-tile critique lists every affected tile in ref.tiles;
      // a change to ANY of them must be able to mark the card updated, so include
      // the full set (not just the representative tile).
      ...(Array.isArray(targetRef.tiles) ? targetRef.tiles.filter((item): item is string => typeof item === "string") : []),
      ...(Array.isArray(targetRef.targets) ? targetRef.targets.filter((item): item is string => typeof item === "string") : []),
    ].filter((item): item is string => Boolean(item));
    if (c.status === "pending" && !detectorRefs.length && targetIds.some((id) => changed.has(id))) {
      // Interpretive findings require a later criterion-aware model check. Mark
      // them updated instead of falsely resolving or leaving stale copy intact.
      c.status = "updated";
      updated.push(c.id);
      return c;
    }
    if (c.status === "pending") kept.push(c.id);
    return c;
  });

  const added: string[] = [];
  if (
    appliedKinds.has("add-cross-filter") &&
    !next.some((c) => c.proposal.kind === "show-filter-state")
  ) {
    // Resolve the source tile of the cross-filter that was just applied so the
    // follow-up carries an applyable target ref. Prefer the critique that was
    // actually applied; fall back to a tile whose usermeta now records the
    // cross-filter selection so the follow-up still resolves after reloads.
    const appliedCrossFilter = previous.find(
      (c) => applied.has(c.id) && c.proposal.kind === "add-cross-filter",
    );
    const refSource = appliedCrossFilter?.target?.ref?.source;
    const source =
      (typeof refSource === "string" && refSource) ||
      // Fall back to the tile whose usermeta records it as the cross-filter
      // source (stamped by applyCrossFilter), so the follow-up still resolves
      // if the applied critique's ref was unavailable.
      Object.keys(newSpecMap).find((tileId) => {
        const meta = (newSpecMap[tileId] as { usermeta?: { crossFilter?: { role?: unknown } } })?.usermeta;
        return meta?.crossFilter?.role === "source";
      }) ||
      undefined;
    const followUp = activeFilterFollowUp(source);
    next.push(followUp);
    added.push(followUp.id);
  }

  return {
    critiques: next,
    added,
    delta: {
      kept: [...new Set(kept)],
      updated: [...new Set(updated)],
      removed: [...new Set(removed)],
      added,
      changedTargets: [...new Set(changedTargets)],
    },
    remainingFindings: next.filter((critique) => critique.status === "pending" || critique.status === "updated").length,
  };
}
