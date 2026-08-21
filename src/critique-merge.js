/**
 * Cross-ask critique synchronization for the v2 interaction prototype.
 *
 * The critique engine is stateless: each /critique ask returns a fresh set with
 * no memory of prior asks (it dedups only within one response). The frontend
 * owns cross-ask memory. These pure helpers synchronize a fresh ask with the
 * persistent set so that:
 *   - new findings are added,
 *   - findings the user already decided on keep their decision,
 *   - still-valid active findings are replaced by the latest validated payload,
 *   - a full review removes active findings it no longer confirms.
 *
 * See proposals/interaction-loop-accumulation-and-context-agent.md §1.
 */

// A critique whose status reflects a decision the user already made. Re-asking
// must never resurrect one of these back to "pending".
export const DECIDED_STATUSES = new Set([
  "accepted",
  "resolved",
  "rejected",
  "superseded",
]);

export function isDecidedCritique(critique) {
  return DECIDED_STATUSES.has(critique.status);
}

// Cross-ask identity for a critique. Broadly mirrors the engine's within-response
// critiqueSlotKey (object|problem|tileId|leaf). Uncatalogued critiques have no
// recommendation leaf, so fall back to the dimension for the remedy slot.
// A consolidated critique (one identical fix on several tiles) carries
// target.ref.tiles; key it on the SORTED tile set, not the single representative
// tileId — a fresh (stateless) re-ask may pick a different representative tile
// for the same issue, and keying on one tile would double-count it as new.
export function critiqueIdentityKey(critique) {
  const object = critique.object || critique.dimension || "";
  const problem = critique.problem || "";
  const tiles = critique.target?.ref?.tiles;
  const location = Array.isArray(tiles) && tiles.length > 1
    ? [...tiles].sort().join("+")
    : critique.tileId
      || critique.target?.ref?.source
      || critique.target?.ref?.tile
      || "dashboard";
  const remedy = critique.recommendation || critique.dimension || "";
  return `${object}|${problem}|${location}|${remedy}`;
}

/**
 * Merge a fresh ask while preserving decisions and stable active-card ids.
 *
 * Rules:
 *   - incoming matches a DECIDED critique -> skip (respect the prior decision),
 *     record resurfacedByAskId on the prior for the history view;
 *   - incoming matches an ACTIVE critique -> keep its stable id but replace the
 *     complete critique/proposal with the current validated payload;
 *   - incoming is new -> add it as pending;
 *   - synchronizeActive -> remove every undecided critique not returned now.
 *
 * Every incoming critique is stamped with the ask's id + scope for the history
 * view. Mutates prior critiques in place (status/evidence refresh, provenance)
 * to match the app's existing in-place status mutations; returns the full merged
 * array (not yet enriched/ranked).
 *
 * @param {Array<object>} existing  current state.critiques
 * @param {Array<object>} incoming  critiques returned by this ask
 * @param {{askId:number, reviewScope?:string, dashboardVersion?:number, synchronizeActive?:boolean}} ask
 * @returns {Array<object>}
 */
export function mergeAskResults(existing, incoming, ask) {
  const askId = ask.askId;
  const reviewScope = ask.reviewScope || "full";
  const dashboardVersion = Number.isFinite(Number(ask.dashboardVersion))
    ? Number(ask.dashboardVersion)
    : null;
  const byKey = new Map();
  for (const critique of existing) {
    const key = critiqueIdentityKey(critique);
    const indexed = byKey.get(key);
    // A prior explicit decision always owns this identity. This prevents an
    // accidental active duplicate from resurrecting a resolved/rejected issue.
    if (!indexed || (!isDecidedCritique(indexed) && isDecidedCritique(critique))) {
      byKey.set(key, critique);
    }
  }
  const merged = [...existing];
  const currentActive = new Set();
  for (const raw of incoming) {
    const candidate = {
      ...raw,
      askId,
      askScope: reviewScope,
      ...(dashboardVersion === null ? {} : { lastEvaluatedVersion: dashboardVersion }),
    };
    const key = critiqueIdentityKey(candidate);
    const prior = byKey.get(key);
    if (!prior) {
      candidate.status = candidate.status || "pending";
      merged.push(candidate);
      byKey.set(key, candidate);
      currentActive.add(candidate);
      continue;
    }
    if (isDecidedCritique(prior)) {
      // Respect the decision; only record that this ask re-surfaced it.
      prior.resurfacedByAskId = askId;
      continue;
    }
    if (dashboardVersion !== null) {
      // Keep the stable UI id, but replace the complete recommendation payload
      // with the newest result even when the dashboard version did not change.
      // A Generate action is a synchronization pass, not an append-only log.
      const refreshed = {
        ...candidate,
        id: prior.id,
        status: candidate.status || "pending",
        introducedInVersion: prior.introducedInVersion || dashboardVersion,
        lastEvaluatedVersion: dashboardVersion,
        revision: (Number(prior.revision) || 1) + 1,
        ...(prior.revisions ? { revisions: prior.revisions } : {}),
      };
      const index = merged.indexOf(prior);
      if (index >= 0) merged[index] = refreshed;
      byKey.set(key, refreshed);
      currentActive.add(refreshed);
      continue;
    }
    // Prior is still active (pending/updated): keep it, but adopt the fresher
    // evidence when the new candidate is strictly better grounded.
    const priorRefs = prior.evidenceRefs?.length || 0;
    const candidateRefs = candidate.evidenceRefs?.length || 0;
    if (candidateRefs > priorRefs) {
      prior.evidence = candidate.evidence ?? prior.evidence;
      prior.evidenceRefs = candidate.evidenceRefs;
      prior.suggestion = candidate.suggestion ?? prior.suggestion;
      prior.supportStatus = candidate.supportStatus ?? prior.supportStatus;
    }
  }
  // An empty payload is not proof that every issue disappeared: upstream
  // filtering or a degraded model response can also produce zero critiques.
  // Keep the active set until a non-empty review can positively synchronize it.
  if (dashboardVersion !== null && ask.synchronizeActive === true && incoming.length > 0) {
    return merged.filter((critique) => isDecidedCritique(critique) || currentActive.has(critique));
  }
  return merged;
}

/**
 * Group the full critique set by the ask that produced it, for the history view.
 *
 * mergeAskResults stamps every critique with a monotonic askId + askScope. This
 * turns that provenance into ordered ask groups so the history drawer can show
 * "every critique ever generated, grouped by ask" (proposals §3). Critiques
 * predating the provenance stamp (no askId) collect into a single "Earlier"
 * group that sorts first; real asks follow in ascending askId order.
 *
 * @param {Array<object>} critiques  the complete state.critiques
 * @returns {Array<{askId:(number|null), askScope:string, items:Array<object>}>}
 */
export function groupCritiquesByAsk(critiques) {
  const groups = new Map();
  for (const critique of critiques) {
    const askId = typeof critique.askId === "number" ? critique.askId : null;
    if (!groups.has(askId)) {
      groups.set(askId, { askId, askScope: critique.askScope || "full", items: [] });
    }
    groups.get(askId).items.push(critique);
  }
  // Legacy (askId null) first, then ascending askId.
  return [...groups.values()].sort((a, b) => {
    if (a.askId === null) return -1;
    if (b.askId === null) return 1;
    return a.askId - b.askId;
  });
}
