/**
 * Title/subtitle text detectors. Their findings map to the `text`
 * recommendation branch.
 *
 * Grounded in board chrome (heading text + per-tile subtitle presence), which is
 * outside the Vega-Lite unit specs, so it arrives via `board`. The checks are
 * still deterministic string/structure facts; the LLM only phrases them.
 */
import type { BoardMeta, Finding, SpecMap } from "../contracts.ts";

/** Headings that name no metric, audience, or decision the dashboard supports. */
const GENERIC_TITLES = new Set([
  "workspace overview",
  "dashboard",
  "overview",
  "report",
  "untitled",
  "summary",
]);

/**
 * Generic-title detector. Signal: the dashboard heading is a short/boilerplate
 * label and carries no subtitle, so it sets no analytical expectation.
 */
export function detectGenericTitle(_specMap: SpecMap, board?: BoardMeta): Finding[] {
  const title = board?.title?.trim();
  if (!title) return [];
  const wordCount = title.split(/\s+/).filter(Boolean).length;
  const looksGeneric = GENERIC_TITLES.has(title.toLowerCase()) || wordCount <= 2;
  const hasSubtitle = Boolean(board?.subtitle?.trim());
  if (!looksGeneric && hasSubtitle) return [];

  return [
    {
      id: "finding-generic-title",
      kind: "generic-title",
      dimension: "text",
      proposalKind: "dashboard-title",
      surface: "text",
      severity: "high",
      evidence: {
        detail:
          `The dashboard heading is "${title}" (${wordCount} word${wordCount === 1 ? "" : "s"}) ` +
          `with ${hasSubtitle ? "a subtitle" : "no subtitle"}; it names no metric, ` +
          `audience, or decision the dashboard supports.`,
        title,
      },
      target: { granularity: "dashboard-title", ref: { component: "dashboard-heading" } },
      tileId: null,
      bounds: { x: 28, y: 20, w: 690, h: 64 },
    },
  ];
}

/**
 * Missing-subtitles detector. Signal: chart tiles carry a title but no takeaway
 * subtitle, so each chart names a metric without any interpretation guidance.
 */
export function detectMissingSubtitles(_specMap: SpecMap, board?: BoardMeta): Finding[] {
  const tiles = board?.tiles ?? [];
  const titled = tiles.filter((t) => t.title && t.title.trim());
  const missing = titled.filter((t) => !t.hasSubtitle);
  if (titled.length === 0 || missing.length === 0) return [];

  return [
    {
      id: "finding-missing-subtitles",
      kind: "missing-subtitles",
      dimension: "text",
      proposalKind: "chart-subtitles",
      surface: "structural",
      severity: "medium",
      evidence: {
        detail:
          `${missing.length} of ${titled.length} chart tiles have a title but no ` +
          `takeaway subtitle (${missing.map((t) => t.id).join(", ")}), so each chart ` +
          `names a metric without telling the reader what to notice.`,
        tiles: missing.map((t) => t.id),
        missingCount: missing.length,
        tileCount: titled.length,
      },
      target: { granularity: "all-chart-labels", ref: { component: "chart-subtitle" } },
      tileId: null,
      bounds: { x: 28, y: 178, w: 1044, h: 286 },
    },
  ];
}
