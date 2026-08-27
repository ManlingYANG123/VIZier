/** Lightweight LLM-as-judge gate for generated executable solutions.
 *
 * The primary model is good at finding issues, but can pair a valid critique
 * with a timid, unrelated, or already-satisfied proposal. This pass sees only
 * the compact candidate set and target specs. It may pass, drop, or rewrite the
 * solution; the caller still runs every rewrite through the normal sanitizer
 * and apply/compile gates, so the judge never bypasses execution safety.
 */
import type {
  Critique,
  DashboardContext,
  Finding,
  ReviewRequestContract,
  ReviewScope,
} from "../contracts.ts";
import type { LLMClient } from "../llm/client.ts";
import type { EvidencePacket } from "./evidence.ts";

export type SolutionQualityCandidate = { critique: Critique; finding: Finding };

export interface SolutionQualityDecision {
  id: string;
  verdict: "pass" | "rewrite" | "drop";
  reason: string;
  suggestion?: string;
  proposal?: unknown;
  target?: unknown;
}

const QUALITY_SYSTEM = `You are the solution-quality judge inside a dashboard design iteration engine.

The issue has already passed evidence and grounding checks. Judge whether the PROPOSED EXECUTABLE SOLUTION is a strong implementation of that issue for THIS dashboard.

Evaluate five things:
1. Target fidelity — it changes the cited tile/board element, and an explicit author request is followed literally.
2. Causal fit — the change directly resolves the stated issue rather than making a nearby generic improvement.
3. Visible materiality — the before/after difference is large enough for the issue's importance. Reject no-ops and token cosmetic changes presented as substantive iteration.
4. Case specificity — the mechanism fits this dashboard's genre, fields, encodings, hierarchy, and existing design language; it is not a reusable default pasted onto any dashboard.
5. Preservation — truthful data semantics, unrelated successful elements, and explicit must-preserve constraints remain intact.

Use "pass" when the existing proposal is already good. Use "rewrite" only when the issue is valid but the solution needs a better executable implementation. Use "drop" when no supported operation can materially resolve it, or when it is merely a styling preference/generic polish rather than dashboard-design iteration. For a direct author request, prefer rewrite over drop whenever an executable solution is possible.

For rewrite, return a replacement suggestion, proposal, and target. Use only the exact tile ids, fields, and current Vega-Lite paths supplied. Never add raw data or invent values. Keep the replacement tightly scoped to the diagnosed issue.

Return ONLY JSON:
{"decisions":[{"id":"<critique id>","verdict":"pass|rewrite|drop","reason":"one short sentence","suggestion":"rewrite only","proposal":{},"target":{}}]}
Return one decision for every supplied candidate.`;

function candidateTileIds(critique: Critique): string[] {
  const ref = critique.target?.ref || {};
  return [...new Set([
    critique.tileId,
    typeof ref.tile === "string" ? ref.tile : null,
    typeof ref.source === "string" ? ref.source : null,
    ...(Array.isArray(ref.tiles) ? ref.tiles : []),
    ...(Array.isArray(ref.targets) ? ref.targets : []),
    ...(Array.isArray(critique.proposal.layout)
      ? critique.proposal.layout.map((entry) => entry.tile)
      : []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function qualityUser(
  candidates: SolutionQualityCandidate[],
  packet: EvidencePacket,
  context: DashboardContext,
  reviewScope: ReviewScope,
  requestContract?: ReviewRequestContract,
): string {
  const tileIds = [...new Set(candidates.flatMap((item) => candidateTileIds(item.critique)))];
  const targetSpecs = Object.fromEntries(
    tileIds.filter((id) => packet.specMap[id]).map((id) => [id, packet.specMap[id]]),
  );
  const projected = candidates.map(({ critique }) => ({
    id: critique.id,
    issue: critique.issue,
    suggestion: critique.suggestion,
    priority: critique.priority,
    dimension: critique.dimension,
    tileId: critique.tileId,
    target: critique.target,
    proposal: critique.proposal,
    evidence: critique.evidence,
    directAuthorRequest: critique.requestRelevance === "direct",
  }));
  return [
    `REVIEW SCOPE: ${reviewScope}`,
    `DASHBOARD PURPOSE/GENRE:\n${JSON.stringify({
      dashboardType: context.dashboardType,
      goal: context.goal,
      audience: context.audience,
      constraints: context.constraints,
    }, null, 2)}`,
    `BOARD FACTS:\n${JSON.stringify({
      title: packet.board.title,
      subtitle: packet.board.subtitle,
      hasKpis: packet.board.hasKpis,
      hasEmbeddedKpis: packet.board.hasEmbeddedKpis,
      filters: packet.board.filters,
      tiles: packet.board.tiles,
    }, null, 2)}`,
    requestContract
      ? `AUTHOR REQUEST CONTRACT:\n${JSON.stringify(requestContract, null, 2)}`
      : "AUTHOR REQUEST CONTRACT: none (ordinary overall review)",
    `CANDIDATE SOLUTIONS:\n${JSON.stringify(projected, null, 2)}`,
    `CURRENT TARGET SPECS:\n${JSON.stringify(targetSpecs, null, 2)}`,
    "Judge every candidate and return only the JSON object.",
  ].join("\n\n");
}

function parseDecisions(value: unknown, allowedIds: Set<string>): Map<string, SolutionQualityDecision> {
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const entries = Array.isArray(root.decisions) ? root.decisions : [];
  const decisions = new Map<string, SolutionQualityDecision>();
  for (const item of entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : "";
    const verdict = raw.verdict;
    if (!allowedIds.has(id) || !["pass", "rewrite", "drop"].includes(String(verdict))) continue;
    decisions.set(id, {
      id,
      verdict: verdict as SolutionQualityDecision["verdict"],
      reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 400) : "",
      ...(typeof raw.suggestion === "string" && raw.suggestion.trim()
        ? { suggestion: raw.suggestion.trim().slice(0, 800) }
        : {}),
      ...(raw.proposal && typeof raw.proposal === "object" ? { proposal: raw.proposal } : {}),
      ...(raw.target && typeof raw.target === "object" ? { target: raw.target } : {}),
    });
  }
  return decisions;
}

/** Fail-open by design: a judge outage never fails the review. */
export async function judgeSolutionQuality(
  candidates: SolutionQualityCandidate[],
  packet: EvidencePacket,
  context: DashboardContext,
  reviewScope: ReviewScope,
  requestContract: ReviewRequestContract | undefined,
  client: LLMClient | undefined,
): Promise<Map<string, SolutionQualityDecision>> {
  const executable = candidates
    .filter((item) => item.critique.proposal.mode === "executable")
    .slice(0, reviewScope === "full" ? 14 : 4);
  if (!client?.available() || !executable.length) return new Map();
  try {
    const response = await client.completeJson(
      qualityUser(executable, packet, context, reviewScope, requestContract),
      { system: QUALITY_SYSTEM, temperature: 0, maxTokens: 2600 },
    );
    return parseDecisions(response, new Set(executable.map((item) => item.critique.id)));
  } catch {
    return new Map();
  }
}

export const __test__ = { parseDecisions, qualityUser };
