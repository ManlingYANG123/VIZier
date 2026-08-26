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
  "deferred",
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

const NOT_APPLICABLE_PATTERN = /no material issue|no longer (present|applicable|needed|relevant)|not (present|applicable) (any more|anymore|any longer)|issue (is |has been )?(gone|resolved|fixed|addressed)|keep the current treatment/i;
const SHORTER_TEXT_PATTERN = /\b(?:text|copy|title|label|wording)?\s*(?:is|are|feels?|seems?)?\s*too\s+(?:long|wordy|verbose)\b|\b(?:shorter|shorten|concise|condense|trim|less\s+text|reduce\s+(?:the\s+)?(?:text|copy|wording))\b|(?:文字|文本|标题|文案).*(?:太长|过长)|(?:缩短|精简|简短)/iu;
const AUTHORED_TEXT_KEY_PATTERN = /^(?:label|title|subtitle|text|copy|caption|description)$/i;

function normalizedTextLength(value) {
  return Array.from(String(value || "").replace(/\s+/g, " ").trim()).length;
}

function materiallyShorter(before, after) {
  const beforeLength = normalizedTextLength(before);
  const afterLength = normalizedTextLength(after);
  if (!beforeLength || !afterLength) return false;
  const requiredReduction = Math.max(1, Math.ceil(beforeLength * 0.2));
  return afterLength <= beforeLength - requiredReduction;
}

function proposalTextValues(proposal) {
  const values = [];
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (AUTHORED_TEXT_KEY_PATTERN.test(key) && value.trim()) values.push(value.trim());
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    if (
      Array.isArray(value.path)
      && typeof value.value === "string"
      && AUTHORED_TEXT_KEY_PATTERN.test(String(value.path.at(-1) || ""))
      && value.value.trim()
    ) values.push(value.value.trim());
    Object.entries(value).forEach(([childKey, child]) => {
      if (childKey === "value" && Array.isArray(value.path)) return;
      visit(child, childKey);
    });
  };
  visit(proposal);
  return values;
}

export function refinementDirectionRequiresShorterText(rationale) {
  return SHORTER_TEXT_PATTERN.test(String(rationale || "").trim());
}

/** Validate user-authored refinement constraints before replacing the visible fix. */
export function solutionRefinementAlignment(previous, replacement, rationale) {
  if (!refinementDirectionRequiresShorterText(rationale)) {
    return { aligned: true, reason: "" };
  }
  const previousProposalText = proposalTextValues(previous?.proposal).join(" ");
  const nextProposalText = proposalTextValues(replacement?.proposal).join(" ");
  if (previousProposalText && !nextProposalText) {
    return {
      aligned: false,
      reason: "The regenerated solution did not provide the requested shorter replacement text.",
    };
  }
  if (
    previousProposalText
    && nextProposalText
    && !materiallyShorter(previousProposalText, nextProposalText)
  ) {
    return {
      aligned: false,
      reason: "The proposed replacement text was not materially shorter than the current proposal.",
    };
  }
  return { aligned: true, reason: "" };
}

function critiqueTargetLocation(critique) {
  const tiles = critique?.target?.ref?.tiles;
  if (Array.isArray(tiles) && tiles.length) return [...tiles].sort().join("+");
  return critique?.tileId
    || critique?.target?.ref?.tile
    || critique?.target?.ref?.source
    || "dashboard";
}

/** A solution refinement may change the remedy, but never the accepted
 * diagnosis or its dashboard target. Reject model drift before proposal data
 * validated for one tile is combined with the stable id/target of another. */
export function solutionRefinementCandidateMatches(previous, replacement) {
  if (!previous || !replacement) return false;
  if (critiqueTargetLocation(previous) !== critiqueTargetLocation(replacement)) return false;
  if (previous.dimension && replacement.dimension !== previous.dimension) return false;
  if (previous.object && replacement.object !== previous.object) return false;
  if (previous.problem && replacement.problem !== previous.problem) return false;
  return true;
}

/** Prompt that asks the engine to refresh one stale recommendation, not the whole board. */
export function critiqueRefreshRequest(critique) {
  const target = critique?.tileId
    || critique?.target?.ref?.tile
    || critique?.target?.ref?.source
    || "the dashboard";
  return [
    "Re-evaluate this ONE previously identified issue against the CURRENT dashboard after other fixes were applied.",
    "Do not start a full new review and do not invent unrelated new issues.",
    "If the issue still exists, return an updated executable recommendation for this issue only.",
    "If the issue is gone or no longer applicable, say so clearly in the answer and do not propose a substitute issue.",
    `Issue title: ${critique?.title || ""}`,
    `Target: ${target}`,
    critique?.issue ? `Problem: ${critique.issue}` : "",
    critique?.suggestion ? `Previous suggestion: ${critique.suggestion}` : "",
    critique?.dimension ? `Dimension: ${critique.dimension}` : "",
  ].filter(Boolean).join("\n");
}

/** Ask for a different solution without reopening the accepted diagnosis. */
export function critiqueSolutionRefinementRequest(critique, rationale, {
  optionIndex = 1,
  optionCount = 3,
  strategy = "Use a materially different executable approach from the current solution.",
  allowNoAlternative = false,
  joint = false,
} = {}) {
  const target = critique?.tileId
    || critique?.target?.ref?.tile
    || critique?.target?.ref?.source
    || "the dashboard";
  const diagnosisContract = JSON.stringify({
    object: critique?.object || null,
    problem: critique?.problem || null,
    dimension: critique?.dimension || null,
    tileId: critique?.tileId ?? null,
    target: critique?.target || null,
  });
  const previousProposal = JSON.stringify(critique?.proposal || null);
  const shorterTextConstraint = refinementDirectionRequiresShorterText(rationale)
    ? [
        "HARD ACCEPTANCE CONSTRAINT: Make the recommendation wording and every proposed replacement text at least 20% shorter than the previous attempt.",
        "Use direct, compact language. A different but similarly long sentence does not satisfy the request.",
      ]
    : [];
  return [
    joint
      ? "Generate 1–3 ALTERNATIVE SOLUTIONS for this ONE previously identified issue in a single response."
      : "Generate an ALTERNATIVE SOLUTION for this ONE previously identified issue.",
    joint ? "Return fewer than three when the issue has fewer genuinely distinct executable solutions."
      : `You are generating option ${optionIndex} of ${optionCount}.`,
    "The author accepts the diagnosis. Keep the issue, evidence, target, and scope fixed.",
    `EXACT DIAGNOSIS AND TARGET CONTRACT: ${diagnosisContract}`,
    "Every returned option MUST repeat that exact object, problem, dimension, tileId, target granularity, and target ref. Do not modify any other tile or dashboard element.",
    "Do not start a full review, introduce a substitute issue, or repeat the previous solution unchanged.",
    "Treat the author's refinement direction as a hard acceptance constraint, not optional context.",
    `ALTERNATIVE STRATEGY: ${String(strategy || "").trim()}`,
    "Make this option meaningfully distinct in both its recommendation and executable proposal, not merely reworded.",
    joint
      ? "Return each meaningful alternative as a separate critique with the SAME diagnosis, evidence, target, and scope. Make their executable proposals visibly distinct."
      : allowNoAlternative
      ? "Return one concrete executable recommendation only if it is meaningfully different. Otherwise return no critique and state that no distinct alternative is warranted."
      : "Return exactly one concrete executable recommendation that follows the author's refinement direction.",
    ...shorterTextConstraint,
    `Issue title: ${critique?.title || ""}`,
    `Target: ${target}`,
    critique?.issue ? `Accepted problem: ${critique.issue}` : "",
    critique?.evidence ? `Evidence: ${critique.evidence}` : "",
    critique?.suggestion ? `Previous solution: ${critique.suggestion}` : "",
    `Previous executable proposal: ${previousProposal}`,
    "Each new proposal must produce a non-identical dashboard/spec state when executed against the contracted target.",
    `Author's refinement direction: ${String(rationale || "").trim()}`,
    critique?.dimension ? `Dimension: ${critique.dimension}` : "",
  ].filter(Boolean).join("\n");
}

/** Preserve diagnosis identity while replacing only the mutable solution attempt. */
export function buildRefinedCritique(previous, replacement, rationale, dashboardVersion) {
  const nextSuggestion = replacement?.suggestion || previous?.suggestion || "";
  return {
    ...structuredClone(previous),
    suggestion: nextSuggestion,
    proposal: structuredClone(replacement?.proposal || previous?.proposal),
    // The replacement was generated through an internal focused meta-prompt.
    // Its requestContract describes that prompt, not an author-facing dashboard
    // request, and carrying it forward can incorrectly roll back a valid fix.
    requestContract: structuredClone(previous?.requestContract),
    recommendation: replacement?.recommendation || previous?.recommendation,
    surface: replacement?.surface || previous?.surface,
    fixability: replacement?.fixability || previous?.fixability,
    status: "pending",
    lifecycle: "active",
    lastEvaluatedVersion: dashboardVersion,
    revision: (Number(previous?.revision) || 1) + 1,
    revisions: [
      ...(structuredClone(previous?.revisions) || []),
      { rationale: String(rationale || "").trim(), suggestion: nextSuggestion },
    ],
  };
}

export function solutionAttemptChanged(previous, replacement) {
  const beforeSuggestion = String(previous?.suggestion || "").trim();
  const afterSuggestion = String(replacement?.suggestion || "").trim();
  if (beforeSuggestion !== afterSuggestion) return true;
  return JSON.stringify(previous?.proposal || null) !== JSON.stringify(replacement?.proposal || null);
}

export function critiqueRefreshLooksRetired(critique, answer = "") {
  const text = [
    answer,
    critique?.answer,
    critique?.title,
    critique?.issue,
    critique?.suggestion,
    critique?.diagnosisOutcome,
  ].filter(Boolean).join("\n");
  if (NOT_APPLICABLE_PATTERN.test(text)) return true;
  if (
    critique?.proposal?.kind === "manual"
    && critique?.proposal?.mode === "guidance_only"
    && /guidance for this review request/i.test(critique?.title || "")
  ) return true;
  return false;
}

/** Choose the refreshed payload for one card. Extra focused-review critiques are ignored. */
export function pickCritiqueRefreshReplacement(previous, incoming = [], answer = "") {
  if (critiqueRefreshLooksRetired(null, answer)) return null;
  const list = (Array.isArray(incoming) ? incoming : []).filter(Boolean);
  const applicable = list.filter((item) => !critiqueRefreshLooksRetired(item, answer));
  if (!applicable.length) return null;
  const prevKey = previous ? critiqueIdentityKey(previous) : "";
  const sameIdentity = prevKey
    ? applicable.find((item) => critiqueIdentityKey(item) === prevKey)
    : null;
  if (sameIdentity) return sameIdentity;
  const sameKind = applicable.find((item) => (
    item.proposal?.kind && item.proposal.kind === previous?.proposal?.kind
  ));
  if (sameKind) return sameKind;
  const sameTarget = applicable.find((item) => (
    (item.tileId || null) === (previous?.tileId || null)
    && item.dimension === previous?.dimension
  ));
  if (sameTarget) return sameTarget;
  const direct = applicable.find((item) => item.requestRelevance === "direct");
  if (direct) return direct;
  return applicable[0];
}
