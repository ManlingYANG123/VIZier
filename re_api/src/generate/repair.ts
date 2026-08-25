/**
 * Guidance -> executable repair pass.
 *
 * The primary review is asked to encode every component-level fix as a real
 * proposal, but a model still sometimes leaves a grounded, component-level fix
 * as prose (kind "manual", guidance-only). The user's requirement is that any
 * fix touching a dashboard component runs the full pipeline
 * (diagnosing -> presenting -> implementing), so a second, focused call asks the
 * model to encode ITS OWN suggestion as a concrete executable proposal.
 *
 * Trust invariant is preserved end to end: the model authors the proposal (the
 * engine never invents which fix a critique needs); the engine validates it
 * through validatedProposal — the SAME gate the primary path uses — and, for
 * spec-changing proposals, runs it through applyProposals (the SAME compile gate
 * /apply uses) on a clone. A critique is promoted only when a real, applyable,
 * compile-safe fix survives; otherwise it honestly stays guidance-only.
 */
import type { Critique, Dimension, Finding, SpecMap } from "../contracts.ts";
import type { LLMClient } from "../llm/client.ts";
import type { EvidencePacket } from "./evidence.ts";
import { applyProposals } from "../apply/index.ts";
import { asksToRepositionControl, validatedProposal } from "./discover.ts";

/** Only process advice is inherently non-artifact. An uncatalogued (`other`)
 * component critique may be repaired when it is tied to real dashboard evidence. */
const PROCESS_ONLY_BRANCHES = new Set<Dimension>(["design process"]);
/** Executable kinds that change the board chrome, not a tile spec — they never
 * enter applyProposals (which is spec-only), so validatedProposal alone gates
 * them. */
const BOARD_KINDS = new Set(["add-kpis", "recompose-kpis", "dashboard-title", "chart-subtitles", "edit-layout", "wire-filter-control"]);
const MAX_REPAIRS = 12;

interface RepairCandidate {
  index: number;
  critique: Critique;
  finding: Finding;
  tileId: string | null;
}

/** A component-level fix the model left as prose. Advisory branches (design
 * process / other) are excluded. A tentative critique IS repairable: support
 * status is about how confident we are the *issue* is real, which is orthogonal
 * to whether the *fix* is encodable — we make the fix executable so the author
 * can apply it if they agree, while the "Tentative" label stays on the critique
 * (supportStatus is never changed here) so the preliminary diagnosis is visible. */
function isRepairable(value: { critique: Critique }): boolean {
  const c = value.critique;
  const groundedComponent = c.dimension !== "other" || Boolean(
    c.supportStatus === "validated" &&
    c.evidenceRefs?.some((ref) => ref.source === "dashboard" || ref.source === "detector"),
  );
  return c.proposal.mode === "guidance_only" &&
    !PROCESS_ONLY_BRANCHES.has(c.dimension) &&
    groundedComponent;
}

const REPAIR_SYSTEM = `You are the implementation component of VIZier's dashboard review engine.
You previously flagged specific, grounded issues but left some fixes as prose. For each item, encode YOUR OWN suggestion as one concrete executable proposal so the engine can apply it.

Return ONLY JSON: {"repairs":[{"index":<item index>,"proposal":{...},"target":{"ref":{...}}}]}.

Choose the proposal kind that implements the suggestion:
- edit-spec — the general route for any change to ONE tile's Vega-Lite spec (sort, axis title/format, label angle, chart title, color scheme, legend placement, scale domain, mark options, spec-internal layout). Set target.ref.tile to that tile id and give proposal.edits: an array of {"op":"set"|"remove","path":[...],"value":<present only for set>}. The path addresses into that tile's spec exactly. Only reference fields that ALREADY exist; never add data, datasets, inline values, params, usermeta, or root width/height/autosize (tile size comes from edit-layout).
- add-tooltip — add tooltips to a tile. Set target.ref.tile.
- add-cross-filter — wire a selection from a source tile to targets on a shared field. Set target.ref.source, target.ref.targets (array), target.ref.field.
- edit-layout — move/resize dashboard tiles (a board-level layout change: tile position/size lives on the board, NOT in any spec). Give proposal.layout: an array of {"tile":<tile id>,"bounds":{"x":<num>,"y":<num>,"w":<num>,"h":<num>}} in canvas pixels. Only list the tiles whose box changes; keep boxes on-canvas, non-overlapping, and at least 80×80. Never reduce a tile's current width or height; reflow or enlarge instead so axes, legends, and text cannot be clipped. This operation cannot move filters or controls; omit a repair whose suggestion is to relocate one.
- add-kpis — add a summary KPI row to the board. Optionally give proposal.kpis: an array of {"label":<short label>,"tile":<tile id whose data backs it>,"field":<field name>,"agg":"count"|"sum"|"avg"|"min"|"max"|"distinct","filter":<optional {"field":<real category field>,"value":<exact real row value>}>,"highlight":<optional true>,"unit":<optional "%"|"d">}. Choose proposal.kpiStyle as "editorial", "product", "compact", or "technical" to fit the dashboard's existing typography and density rather than defaulting to one look. The engine computes each value from that tile's real data — never state a number yourself. A category-specific KPI must include its exact category filter. Omit proposal.kpis only if you cannot name real fields.
- wire-filter-control — repair an existing visible board filter with proposal.filterId set to its exact id.
- dashboard-title — set a descriptive dashboard title. Give proposal.label (required) and optionally proposal.subtitle.
- chart-subtitles — add takeaway subtitles to the chart tiles. No tile needed.
- v2-palette / preserve-brand-palette — adapt color while preserving this dashboard's visual identity. For v2-palette, include proposal.palette with 2–12 six-digit hex colors grounded in the current palette, semantic needs, and author constraints; do not impose a generic house palette by habit.

Rules:
- Keep edits minimal and targeted; include only what implements the stated suggestion.
- The empirical recommendation catalog is a scaffold, not an execution allowlist. Encode a grounded component suggestion even when it has no exact catalog leaf.
- If a given item genuinely cannot be implemented (it needs new data or a new field, or it is process/meta advice), omit it from repairs entirely. Do not invent an unrelated fix.`;

function repairUser(candidates: RepairCandidate[], packet: EvidencePacket): string {
  const items = candidates.map((candidate) => ({
    index: candidate.index,
    tileId: candidate.tileId,
    dimension: candidate.critique.dimension,
    issue: candidate.critique.issue,
    suggestion: candidate.critique.suggestion,
    ...(candidate.tileId ? { tileSpec: packet.specMap[candidate.tileId] } : {}),
  }));
  return [
    "Encode each item's suggestion as one executable proposal. Items:",
    JSON.stringify(items, null, 2),
    `TILE IDS ON THE BOARD: ${JSON.stringify(Object.keys(packet.specMap))}`,
    `FULL TILE SPECS (cite paths against these):\n${JSON.stringify(packet.specMap, null, 2)}`,
    "Return only the JSON object described in the instructions.",
  ].join("\n\n");
}

interface RawRepair {
  proposal: unknown;
  target: unknown;
}

function parseRepairs(value: unknown): Map<number, RawRepair> {
  const out = new Map<number, RawRepair>();
  const repairs = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).repairs
    : undefined;
  if (!Array.isArray(repairs)) return out;
  for (const entry of repairs) {
    if (!entry || typeof entry !== "object") continue;
    const index = (entry as Record<string, unknown>).index;
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    out.set(index, {
      proposal: (entry as Record<string, unknown>).proposal,
      target: (entry as Record<string, unknown>).target,
    });
  }
  return out;
}

/**
 * Promote repairable guidance-only critiques to executable proposals, in place.
 * Makes at most one LLM call and only when there is something to repair; a no-op
 * otherwise. Never throws — a failed repair leaves the critiques exactly as they
 * were (honest guidance-only).
 */
export async function repairGuidanceToExecutable(
  candidates: Array<{ critique: Critique; finding: Finding }>,
  packet: EvidencePacket,
  client: LLMClient | undefined,
): Promise<void> {
  if (!client?.available()) return;
  const repairable: RepairCandidate[] = [];
  candidates.forEach((value, index) => {
    if (repairable.length >= MAX_REPAIRS) return;
    const controlPlacement = asksToRepositionControl(
      value.critique as unknown as Record<string, unknown>,
      value.critique.evidenceRefs || [],
      packet,
    );
    if (isRepairable(value) && !controlPlacement) {
      repairable.push({ index, critique: value.critique, finding: value.finding, tileId: value.critique.tileId });
    }
  });
  if (!repairable.length) return;

  let response: unknown;
  try {
    response = await client.completeJson(repairUser(repairable, packet), {
      system: REPAIR_SYSTEM,
      temperature: 0.1,
      maxTokens: 6000,
    });
  } catch {
    return; // leave everything as guidance-only on any failure
  }
  const byIndex = parseRepairs(response);

  for (const candidate of repairable) {
    const raw = byIndex.get(candidate.index);
    if (!raw) continue;
    await promote(candidate, raw, packet.specMap, packet);
  }
}

/** Validate the model's proposal through the primary gate and, for spec-changing
 * proposals, the /apply compile gate. Mutates the candidate in place and returns
 * true only when a real executable fix survived. */
async function promote(
  candidate: RepairCandidate,
  raw: RawRepair,
  specMap: SpecMap,
  packet: EvidencePacket,
): Promise<boolean> {
  const { proposal, ref } = validatedProposal(
    { proposal: raw.proposal, target: raw.target } as Record<string, unknown>,
    candidate.tileId,
    packet,
  );
  if (proposal.mode !== "executable") return false;

  const isBoard = BOARD_KINDS.has(proposal.kind);
  const granularity = isBoard && !candidate.tileId ? "dashboard" : (candidate.critique.target?.granularity || "chart");
  const synthetic: Critique = {
    ...candidate.critique,
    proposal,
    target: { granularity, ref },
  };

  if (!isBoard) {
    // Spec-changing kinds go through the exact gate /apply uses: apply to a clone
    // (applyProposals clones internally, so specMap is untouched) and require the
    // result to compile and to have actually changed a tile.
    const outcome = await applyProposals(specMap, [synthetic], [synthetic.id]);
    if (outcome.rollback.rolledBack || !outcome.changedTargets.length) return false;
  }

  candidate.critique.proposal = proposal;
  candidate.critique.target = { granularity, ref };
  candidate.finding.proposalKind = proposal.kind;
  return true;
}
