/**
 * Detector registry. Runs every deterministic static check over a spec map (plus
 * the board chrome) and returns structured findings — the grounding for the
 * LLM-authored critiques.
 *
 * Adding a branch/detector here; the generate/apply/reevaluate layers key off
 * `finding.proposalKind`, so nothing downstream needs to change.
 */
import type { BoardMeta, Finding, SpecMap } from "../contracts.ts";
import { detectCrossFilterGaps } from "./crossFilter.ts";
import { detectMissingTooltips } from "./tooltip.ts";
import { detectMissingKpis, detectUniformPalette } from "./visual.ts";
import { detectGenericTitle, detectMissingSubtitles } from "./narrative.ts";
import { detectIneffectiveFilterControls } from "./filterControl.ts";

export type Detector = (specMap: SpecMap, board?: BoardMeta) => Finding[];

export const DETECTORS: Detector[] = [
  // interaction branch
  detectCrossFilterGaps,
  detectMissingTooltips,
  detectIneffectiveFilterControls,
  // data / color branches
  detectMissingKpis,
  detectUniformPalette,
  // text branch
  detectGenericTitle,
  detectMissingSubtitles,
];

export function runDetectors(specMap: SpecMap, board?: BoardMeta): Finding[] {
  return DETECTORS.flatMap((detect) => detect(specMap, board));
}

export {
  detectCrossFilterGaps,
  detectMissingTooltips,
  detectMissingKpis,
  detectUniformPalette,
  detectGenericTitle,
  detectMissingSubtitles,
  detectIneffectiveFilterControls,
};
