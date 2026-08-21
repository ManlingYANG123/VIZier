/**
 * Missing-tooltip detector.
 *
 * Signal (README Seam A): a line/area mark that renders no points and encodes
 * no tooltip invites hover but reveals nothing. Deterministic structural check.
 */
import type { Finding, SpecMap } from "../contracts.ts";
import { hasTooltip, markType, markHasPoint, unitSpecs } from "./specUtil.ts";

const HOVER_MARKS = new Set(["line", "area", "trail"]);

export function detectMissingTooltips(specMap: SpecMap): Finding[] {
  const findings: Finding[] = [];
  for (const tileId of Object.keys(specMap)) {
    const spec = specMap[tileId];
    const missing = unitSpecs(spec).filter(({ spec: unit }) =>
      HOVER_MARKS.has(markType(unit)) &&
      !hasTooltip(unit) &&
      !markHasPoint(unit));
    if (!missing.length) continue;
    const kinds = [...new Set(missing.map(({ spec: unit }) => markType(unit)))];
    const markLabel = kinds.join("/");

    findings.push({
      id: `finding-tooltip-${tileId}`,
      kind: "missing-tooltip",
      dimension: "interaction",
      proposalKind: "add-tooltip",
      surface: "interaction",
      interactionKind: "hover-tooltip",
      severity: "medium",
      evidence: {
        detail:
          `"${tileId}" contains ${missing.length} ${markLabel} ` +
          `${missing.length === 1 ? "mark" : "marks"} with no encoding.tooltip and ` +
          `no rendered points, so hovering reveals no exact values.`,
        tile: tileId,
        channel: "tooltip",
      },
      target: {
        granularity: "mark-interaction",
        ref: {
          tile: tileId,
          channel: "tooltip",
          specPaths: missing.map(({ path }) => path),
        },
      },
      tileId,
    });
  }
  return findings;
}
