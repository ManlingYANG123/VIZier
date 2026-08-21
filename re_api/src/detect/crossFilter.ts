/**
 * Cross-filter gap detector.
 *
 * Signal (README Seam A): >= 2 tiles share a categorical dimension, at least
 * one tile encodes it on a positional/color channel (so it *looks* selectable),
 * but no tile defines a selection that would coordinate the views. The chart
 * therefore looks interactive but is inert. Fully deterministic — the LLM only
 * phrases the finding, it never asserts the gap.
 */
import type { Finding, SpecMap } from "../contracts.ts";
import {
  encodesCategory,
  encodesSelectableCategory,
  encodedFieldsDeep,
  fieldDomainValues,
  hasSelectionOnField,
  referencesField,
} from "./specUtil.ts";

export function detectCrossFilterGaps(specMap: SpecMap): Finding[] {
  const tileIds = Object.keys(specMap);
  const findings: Finding[] = [];

  // Candidate categorical fields = anything encoded as nominal/ordinal on a
  // source channel in some tile.
  const candidates = new Set<string>();
  for (const id of tileIds) {
    for (const e of encodedFieldsDeep(specMap[id])) {
      if ((e.type === "nominal" || e.type === "ordinal") && encodesCategory(specMap[id], e.field)) {
        if (encodesSelectableCategory(specMap[id], e.field)) candidates.add(e.field);
      }
    }
  }

  for (const field of candidates) {
    const sources = tileIds.filter((id) => encodesSelectableCategory(specMap[id], field));
    const source = sources[0];
    if (!source) continue;
    const sourceValues = fieldDomainValues(specMap[source], field);
    const carriers = tileIds.filter((id) => {
      if (!referencesField(specMap[id], field)) return false;
      if (id === source) return true;
      const targetValues = fieldDomainValues(specMap[id], field);
      if (!sourceValues.size || !targetValues.size) return true;
      return [...sourceValues].some((value) => targetValues.has(value));
    });
    // Need the field shared across >= 2 tiles to be a coordination opportunity.
    if (carriers.length < 2) continue;

    // Already coordinated? Then it is not a gap.
    const linked = tileIds.some((id) => hasSelectionOnField(specMap[id], field));
    if (linked) continue;

    const targets = carriers.filter((id) => id !== source);
    if (targets.length === 0) continue;

    findings.push({
      id: `finding-crossfilter-${field}`,
      kind: "cross-filter-gap",
      dimension: "interaction",
      proposalKind: "add-cross-filter",
      surface: "interaction",
      interactionKind: "cross-filter",
      severity: "high",
      evidence: {
        detail:
          `${carriers.length} views reference the shared dimension "${field}"; ` +
          `"${source}" encodes it as a category (so it looks selectable) but no ` +
          `tile defines a selection param bound to it, so clicking coordinates nothing.`,
        sharedField: field,
        sourceTile: source,
        targetTiles: targets,
      },
      target: {
        granularity: "cross-view-interaction",
        ref: { source, targets, field },
      },
      tileId: null,
    });
  }

  return findings;
}
