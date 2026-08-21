import type { DashboardType, Dimension } from "../contracts.ts";

/** Dashboard-type modulation — the single source of truth for how the inferred
 * communicative genre steers the review. A genre is a LENS, not a gate: it
 * changes how strictly each dimension is judged and which deterministic detector
 * defaults are worth manufacturing, but it never admits or rejects a claim on
 * its own. Grounding stays the only authorization gate; priors/branches/genre
 * only rank and emphasize. This keeps the type feature consistent with the
 * engine's rule that nothing but grounding gates.
 *
 * Three levers are exported:
 *   1. dashboardTypeGuidance() — prose injected into the review prompt so the
 *      LLM applies the right strictness itself (the primary, soft lever).
 *   2. suppressedDetectorsFor() — deterministic detectors whose manufactured
 *      default critique is irrelevant for the genre (the one hard lever; it
 *      gates DETECTOR MANUFACTURING, a reliability net, not the codebook
 *      object×problem→recommendation mapping).
 *   3. dimensionEmphasis() — a ±1 ranking nudge so, among similarly severe
 *      findings, genre-relevant dimensions are retained ahead of genre-
 *      irrelevant ones when the review is trimmed to its limit. */

export const DASHBOARD_TYPES: readonly DashboardType[] = [
  "analytical",
  "operational",
  "infographic",
  "executive",
];

/** Used by scaffold inference and template fallback when no genre is stated.
 * Analytical is the most permissive default: it demands the fewest genre-
 * specific features, so an uncertain guess errs toward under-, not over-,
 * critiquing. */
export const DEFAULT_DASHBOARD_TYPE: DashboardType = "analytical";

export function isDashboardType(value: unknown): value is DashboardType {
  return typeof value === "string" && (DASHBOARD_TYPES as readonly string[]).includes(value);
}

/** Per-genre dimension emphasis. +1 = genre-relevant (retain ahead of peers),
 * -1 = genre-peripheral (trim first among similarly severe findings), absent =
 * neutral. Deliberately small and applied only as a late ranking tiebreaker so a
 * genuinely severe finding in a de-emphasized dimension is never hidden. */
const DIMENSION_EMPHASIS: Record<DashboardType, Partial<Record<Dimension, number>>> = {
  analytical: {
    interaction: 1,
    data: 1,
    chart: 1,
    task: 1,
    text: -1,
    "visual design": -1,
    "design process": -1,
  },
  operational: {
    data: 1,
    cognition: 1,
    interaction: 1,
    layout: 1,
    color: 1,
    "design process": -1,
  },
  infographic: {
    text: 1,
    cognition: 1,
    context: 1,
    "visual design": 1,
    color: 1,
    interaction: -1,
    data: -1,
    task: -1,
  },
  executive: {
    text: 1,
    data: 1,
    cognition: 1,
    layout: 1,
    interaction: -1,
    "design process": -1,
  },
};

/** Deterministic detectors whose manufactured default critique does not apply to
 * a genre. Suppressing here only stops the reliability-net template from firing;
 * the LLM may still raise the issue if the evidence genuinely supports it. */
const SUPPRESSED_DETECTORS: Record<DashboardType, readonly string[]> = {
  // Exploratory dashboards value self-service over a packaged conclusion, so the
  // takeaway/subtitle nudges are not defects here (author's stated position).
  analytical: ["generic-title", "missing-subtitles"],
  operational: [],
  // A narrative artifact communicates; it does not support open exploration, so
  // interaction/self-service defaults do not apply.
  infographic: ["cross-filter-gap", "missing-tooltip", "ineffective-filter-control", "missing-kpi"],
  // A high-level summary is not an exploration surface; deep-interaction defaults
  // are off, but summarized KPIs stay in scope.
  executive: ["cross-filter-gap", "missing-tooltip", "ineffective-filter-control"],
};

const GUIDANCE: Record<DashboardType, string> = {
  analytical:
    "DASHBOARD GENRE = analytical (self-service exploration). The author values open exploration and pattern-finding over a single packaged conclusion. Do NOT treat the absence of a headline takeaway, narrative arc, or takeaway subtitles as a defect — they are optional here. Prioritize interaction affordances (filter/drill/tooltip), appropriate data granularity and detail, correct chart encodings, and fit to the analytical task.",
  operational:
    "DASHBOARD GENRE = operational (at-a-glance monitoring). Used for status and anomaly detection, often refreshed live. Prioritize scannability, summarized KPI status, clear status color semantics, glanceable layout, and alerting/advising interactions. De-prioritize long narrative and deep exploratory drill-down; a packaged story is not required.",
  infographic:
    "DASHBOARD GENRE = infographic (narrative). It tells one story and should deliver an explicit conclusion. Prioritize a clear headline takeaway, guided reading order, interpretive context and annotation, and polished visual design. Do NOT require interactive affordances (cross-filters, tooltips, filter controls) or fine-grained self-service detail — this artifact communicates, it does not support open exploration.",
  executive:
    "DASHBOARD GENRE = executive (high-level report). A summary for decision-makers who want the so-what fast. Prioritize a clear takeaway/so-what, summarized headline metrics, low cognitive load, and concision. De-prioritize fine-grained detail, deep interactivity, and authoring-process advice.",
};

/** Prose for the review prompt so the model applies the right strictness itself.
 * Falls back to the default genre for an unknown/absent value. */
export function dashboardTypeGuidance(type: DashboardType | undefined): string {
  return GUIDANCE[type ?? DEFAULT_DASHBOARD_TYPE] ?? GUIDANCE[DEFAULT_DASHBOARD_TYPE];
}

/** Detector kinds whose manufactured default critique is irrelevant for the
 * genre. Empty set for an unknown/absent value (suppress nothing). */
export function suppressedDetectorsFor(type: DashboardType | undefined): Set<string> {
  return new Set(type ? SUPPRESSED_DETECTORS[type] ?? [] : []);
}

/** Ranking nudge in [-1, 1] for a (genre, dimension) pair; 0 when neutral, or
 * when the genre is unknown/absent. */
export function dimensionEmphasis(type: DashboardType | undefined, dimension: Dimension): number {
  if (!type) return 0;
  return DIMENSION_EMPHASIS[type]?.[dimension] ?? 0;
}
