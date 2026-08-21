/**
 * Silent conflict filter — the post-generation stage that removes critiques
 * conflicting with an author's hard design constraints (an uploaded design
 * document). Runs AFTER mergeAndRank and BEFORE the response is assembled; the
 * dropped critiques never reach the author (per product decision), but each drop
 * is returned for the dev observability trace.
 *
 * Two layers, hybrid by design:
 *   Layer 1 — deterministic matcher. The unambiguous, structural cases (a locked
 *     palette vs a recolor proposal) are caught cheaply and with high precision
 *     from proposal.kind / proposal.edits. Pure, cannot throw. Generalizes the
 *     existing `/brand/i` palette tie-break in mergeAndRank.
 *   Layer 2 — LLM judge. Conflict is often semantic (typography/iconography/
 *     layout phrased in prose), which structure alone cannot detect. One small
 *     model call reasons over the survivors + the constraint set. Wrapped so any
 *     failure degrades to "keep everything Layer 1 kept" — the filter NEVER
 *     fails the review or loses a critique on error.
 *
 * Exemption: a critique that directly answers a focused/selected-region request
 * (`requestRelevance === "direct"`) is never dropped — the author's explicit
 * question wins over a constraint conflict, and dropping it would strand the
 * response-level `answer`.
 */
import type {
  ConflictDrop,
  ConstraintSet,
  Critique,
  Finding,
  HardConstraint,
  Proposal,
} from "../contracts.ts";
import type { LLMClient } from "../llm/client.ts";

export type RankedItem = { critique: Critique; finding: Finding };

export interface ConflictFilterResult {
  kept: RankedItem[];
  dropped: ConflictDrop[];
}

const RECOLOR_KINDS = new Set(["v2-palette"]);

/** A locked palette is the one machine-checkable conflict signal today: the
 * document fixes the colors, so any critique that recolors the charts conflicts.
 * `preserve-brand-palette` AGREES with the lock and is never dropped. */
function paletteIsLocked(constraint: HardConstraint): boolean {
  if (constraint.category !== "palette") return false;
  if (typeof constraint.value?.locked === "boolean") return constraint.value.locked;
  // Text fallback is deliberately narrow: best-practice prose commonly says
  // "use color only for emphasis" or mentions brand colors without locking the
  // palette. Only an explicit high-confidence lock may block recoloring.
  if (constraint.confidence !== "high") return false;
  const text = `${constraint.rule} ${constraint.sourceText}`;
  return /\b(?:palette|colors?)\s+(?:is|are|must be)\s+(?:locked|fixed|restricted to (?:the )?(?:approved|brand))\b|\b(?:use|must use|required to use)\s+(?:only|exclusively)\s+the\s+(?:approved\s+)?(?:brand\s+)?palette\b|\bonly\s+use\s+colors?\s+from\s+(?:the\s+)?(?:approved\s+|brand\s+|approved brand\s+)?palette\b|\bcharts?\s+must\s+use\s+(?:the\s+)?(?:approved\s+|brand\s+|approved brand\s+)?palette\b|\b(?:approved\s+)?brand palette\s+only(?:\s*[.;,]|$)|\bdo not (?:recolor|change (?:the )?(?:palette|colors?)|use colors? outside (?:the )?(?:approved\s+|brand\s+|approved brand\s+)?palette)\b|\b(?:palette|colors?)\s+must not (?:change|be changed)\b/i.test(text);
}

function editsRecolor(proposal: Proposal): boolean {
  if (proposal.kind !== "edit-spec" || !Array.isArray(proposal.edits)) return false;
  return proposal.edits.some((edit) => {
    const path = Array.isArray(edit?.path) ? edit.path.map((p) => String(p)) : [];
    return path.includes("color") && path.includes("scale") &&
      (path.includes("scheme") || path.includes("range"));
  });
}

/** Layer 1: deterministic, structural conflicts. Pure — never throws. */
function deterministicDrops(
  items: RankedItem[],
  constraintSet: ConstraintSet,
): Map<string, ConflictDrop> {
  const drops = new Map<string, ConflictDrop>();
  const lockedPalette = constraintSet.constraints.find(paletteIsLocked);
  if (!lockedPalette) return drops;
  for (const item of items) {
    const proposal = item.critique.proposal;
    const recolors = RECOLOR_KINDS.has(String(proposal.kind)) || editsRecolor(proposal);
    if (!recolors) continue;
    drops.set(item.critique.id, {
      id: item.critique.id,
      constraintId: lockedPalette.id,
      category: "palette",
      reason: `Recolors the charts, but the design document locks the palette (${lockedPalette.rule}).`,
    });
  }
  return drops;
}

/** The compact critique projection sent to the judge — never the whole object. */
function critiqueForJudge(critique: Critique) {
  return {
    id: critique.id,
    title: critique.title,
    issue: critique.issue,
    suggestion: critique.suggestion,
    proposalKind: critique.proposal.kind,
    ...(Array.isArray(critique.proposal.palette) ? { proposedPalette: critique.proposal.palette } : {}),
    dimension: critique.dimension,
  };
}

const JUDGE_SYSTEM = `You decide which dashboard critique suggestions CONFLICT with the author's selected design rules.

A critique conflicts when following its suggestion would VIOLATE a stated constraint (e.g. changing a locked brand color, swapping a required font, replacing a mandated icon set, breaking a fixed layout or output format). A critique that is merely unrelated does NOT conflict. When unsure, do NOT flag it — only flag clear conflicts.

Confidence matters: a high-confidence rule is explicit or mandatory; medium is a clear recommendation; low is conditional guidance. Do not drop a critique for a low-confidence rule unless the stated condition clearly applies to the dashboard and the suggestion directly violates it.

You receive the constraints and a list of critiques (id, title, issue, suggestion, proposalKind, optional proposedPalette, dimension). Return ONLY JSON:
{"drops":[{"id":"<critique id>","constraintId":"<constraint id>","reason":"<short why it conflicts>"}]}
Return an empty drops array when nothing conflicts.`;

function judgeUser(items: RankedItem[], constraintSet: ConstraintSet): string {
  return [
    "AUTHOR-SELECTED DESIGN RULES:",
    JSON.stringify(constraintSet.constraints, null, 2),
    "",
    "CRITIQUES:",
    JSON.stringify(items.map((item) => critiqueForJudge(item.critique)), null, 2),
    "",
    "Return the JSON object of conflicting critique ids.",
  ].join("\n");
}

/**
 * Filter ranked critiques against hard constraints. Returns the kept items in
 * their original order plus the dropped-item records for tracing.
 */
export async function filterConflictingCritiques(
  ranked: RankedItem[],
  constraintSet: ConstraintSet | undefined,
  client: LLMClient | undefined,
): Promise<ConflictFilterResult> {
  // Layer 0 — short-circuit. No constraints → the exact same array, so a review
  // with no uploaded document is byte-for-byte unchanged.
  if (!constraintSet || !constraintSet.constraints.length) {
    return { kept: ranked, dropped: [] };
  }

  const isExempt = (item: RankedItem) => item.critique.requestRelevance === "direct";
  const drops = new Map<string, ConflictDrop>();

  // Layer 1 — deterministic (pure).
  for (const [id, drop] of deterministicDrops(ranked, constraintSet)) {
    drops.set(id, drop);
  }

  // Layer 2 — LLM judge over the survivors of Layer 1. Degrades gracefully: any
  // failure leaves the Layer-1 result intact and never throws.
  const survivors = ranked.filter((item) => !drops.has(item.critique.id) && !isExempt(item));
  if (client?.available() && survivors.length) {
    try {
      const raw = await client.completeJson<{ drops?: unknown }>(
        judgeUser(survivors, constraintSet),
        { system: JUDGE_SYSTEM, temperature: 0, maxTokens: 900 },
      );
      const judged = Array.isArray(raw?.drops) ? raw.drops : [];
      const byId = new Map(survivors.map((item) => [item.critique.id, item]));
      const constraintById = new Map(constraintSet.constraints.map((c) => [c.id, c]));
      for (const entry of judged) {
        const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        const item = byId.get(id);
        if (!item || drops.has(id)) continue;
        const constraintId = typeof record.constraintId === "string" ? record.constraintId : "";
        const category = constraintById.get(constraintId)?.category ?? "other";
        drops.set(id, {
          id,
          constraintId,
          category,
          reason: typeof record.reason === "string" && record.reason.trim()
            ? record.reason.trim().slice(0, 400)
            : "Conflicts with a stated design constraint.",
        });
      }
    } catch {
      // Semantic pass unavailable — keep every Layer-1 survivor. The review must
      // never fail because the optional judge call failed.
    }
  }

  // Never drop the direct-answer critique, even if a layer flagged it.
  for (const item of ranked) {
    if (isExempt(item)) drops.delete(item.critique.id);
  }

  const kept = ranked.filter((item) => !drops.has(item.critique.id));
  return { kept, dropped: [...drops.values()] };
}
