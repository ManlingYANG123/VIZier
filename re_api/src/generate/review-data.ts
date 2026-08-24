import type { JudgmentBasis, Priority } from "../contracts.ts";
import { recommendationCatalogPrompt } from "./recommendations.ts";

/** Research content is versioned independently from engine and prompt code.
 * The identifiers are kept stable (imported across the engine); only the
 * values change now that the registry is the empirical diagnostic codebook
 * (object × problem × grounding) rather than a fixed list of criteria. */
export const CRITERION_REGISTRY_VERSION = "diagnostic-knowledge-v4-2026-08-23";
// v10: the review output schema gains a top-level `strengths` array — standout
// positive observations, grounded under the same gate as diagnoses and produced
// independently of critiques (so a zero-critique scope can still return them).
// v12: each strength now carries a `dimension` (grouping topic), so praise
// renders as a positive card inside its matching topic group (no separate panel).
// v13: the positive card is slimmed to two lines — `title` is a one-sentence
// positive takeaway and `detail` names the concrete artifact evidence concisely;
// the separate `groundedIn` grounding footer is dropped.
// v14: a scope the author explicitly chooses must come back non-empty. A focused
// or selected-region request, and a NARROWED Feedback Scope (a proper subset of
// the review dimensions, now surfaced to the prompt as REQUEST SCOPE
// .authorSelectedScopes), each must yield a grounded critique — or a grounded
// strength (Well Done) when no fault is found. Never manufactured to fill a scope.
// v15: empirical vocabularies and recommendation leaves are explicitly framed as
// a scaffold rather than a closed solution space; uncatalogued but grounded
// component fixes may use the normal executable proposal pipeline.
// v16: add-kpis must choose a dashboard-adaptive typography preset instead of
// inheriting one fixed KPI treatment across every generated dashboard.
// v17: problem claims stay evidence-gated while solution synthesis explicitly
// explores bolder dashboard-specific transformations instead of additive defaults.
// v18: visible dashboard filter controls enter the evidence packet and broken
// wiring uses a dedicated executable repair instead of generic interaction prose.
// v21: the opt-in second-pass directive now down-ranks reflexive cross-board
// moves (blanket "unify typography", generic "add source/metadata") — they are
// admissible only when they cite the exact inconsistency in THIS artifact, so a
// second pass spends its slots on board-specific structural transforms instead
// of the handful of moves that read the same on every dashboard.
// v22: confirmed design-document constraints and a clipped PDF/txt extract
// enter the review user prompt (still filtered after generation).
// v23: recommendation ids, definitions, and empirical few-shot examples load
// from recommendation_v3_examples.csv as one maintainable source of truth.
// v24: six fixed, provenance-tracked end-to-end critique demonstrations teach
// evidence→diagnosis→critique structure, genre applicability, target level,
// recommendation choice, and focused-scope discipline.
export const REVIEW_PROMPT_VERSION = "diagnostic-review-v24-2026-08-24";
// v3.2: the engine now assembles and returns the grounded `strengths` array
// alongside critiques/diagnoses (rendered as inline positive cards in the
// critique list, grouped by dimension).
// v3.1: post-generation silent conflict filter can drop critiques that violate
// an author's uploaded hard design constraints (intake module).
// v3.3: uncatalogued component proposals and authored palettes pass the same
// evidence/sanitization/apply gates as catalogued proposals.
// v3.4: sanitized KPI typography presets survive generation, apply, and render.
// v3.5: embedded KPI tiles suppress duplicate add-kpis proposals.
// v3.6: dashboard category/range controls render, filter target specs, and can
// be diagnosed and repaired through wire-filter-control.
// v3.8: two generation-side relaxations to reduce guidance-inflation and
// silent count-loss — (E) a tentative DIAGNOSIS no longer forces its FIX to
// guidance (the fix stays executable+reversible, UI shows a "Tentative" chip),
// and (H) the mergeAndRank slot key is edit-payload-aware so two genuinely
// different edit-spec fixes on one tile (both often problem-less) no longer
// collapse to one slot before the result limit is applied.
// v3.9: (I) a full review can run a second discovery pass — same evidence and
// gates, told what pass one covered — to reach the coverage a rich multi-view
// board supports (the ceiling was generation, not the executable gate).
// v3.10: the second pass is now ON by default in the running server (server.ts
// sets RE_API_SECOND_PASS=1 unless already set); operators opt out with
// RE_API_SECOND_PASS=0. It still costs one extra LLM call per full review.
// Engine-library consumers (tests, scripts) that never boot the server keep the
// flag unset and so run a single pass unless they set it themselves.
export const REVIEW_ENGINE_VERSION = "diagnostic-engine-v3.10";

/* ------------------------------------------------------------------ *
 * GROUNDING (uniform authorization / evidence gate)
 *
 * Grounding is the judgment basis a claim rests on. It is the ONE gate every
 * diagnosis and critique passes: a claim is authorized only when it cites at
 * least one grounding label supported by its evidence. The five codebook
 * grounding types (general design principle, analytical task, audience, author
 * constraint, personal preference) plus the always-available "dashboard
 * evidence" artifact basis are preserved verbatim from the Slack coding.
 * ------------------------------------------------------------------ */

export const JUDGMENT_BASIS_LABELS: readonly JudgmentBasis[] = [
  "dashboard evidence",
  "general design principle",
  "analytical task",
  "audience",
  "author constraint",
  "personal preference",
] as const;

export const JUDGMENT_BASIS_REGISTRY = {
  version: "grounding-v1-2026-08-03",
  definitions: [
    { id: "artifact.dashboard-evidence", label: "dashboard evidence", requiresContext: [] },
    { id: "principle.general-design", label: "general design principle", requiresContext: [] },
    { id: "context.analytical-task", label: "analytical task", requiresContext: ["analytical_task"] },
    { id: "context.audience", label: "audience", requiresContext: ["audience"] },
    { id: "context.author-constraint", label: "author constraint", requiresContext: ["author_constraint"] },
    { id: "context.personal-preference", label: "personal preference", requiresContext: ["author_intent"] },
  ] as const,
};

export type JudgmentBasisId = typeof JUDGMENT_BASIS_REGISTRY.definitions[number]["id"];

/** Provisional registry IDs. The exact label list remains a research decision,
 * so engine contracts store these as data strings rather than a closed TS enum. */
export const CONTEXT_DEPENDENCY_LABELS = [
  "analytical_task",
  "audience",
  "use_setting",
  "author_intent",
  "author_constraint",
  "domain_or_metric_meaning",
  "data_provenance_or_quality",
] as const;

const basisIdByLabel = new Map<JudgmentBasis, JudgmentBasisId>(
  JUDGMENT_BASIS_REGISTRY.definitions.map((definition) => [definition.label, definition.id]),
);

export function judgmentBasisId(label: JudgmentBasis): JudgmentBasisId {
  return basisIdByLabel.get(label)!;
}

export function judgmentBasisLabel(id: JudgmentBasisId): JudgmentBasis {
  return JUDGMENT_BASIS_REGISTRY.definitions.find((definition) => definition.id === id)!.label;
}

export function contextDependenciesForBasis(label: JudgmentBasis): string[] {
  const definition = JUDGMENT_BASIS_REGISTRY.definitions.find(
    (candidate) => candidate.label === label,
  );
  return definition ? [...definition.requiresContext] : [];
}

/* ------------------------------------------------------------------ *
 * DIAGNOSING vocabulary (object × problem)
 *
 * The engine covers ALL object × problem combinations — it is a comprehensive
 * critique tool. The Slack coding only sets priorWeight (prior confidence /
 * how empirically common a combination is); it never bars a combination from
 * being diagnosed. `problem` is optional: an object may be diagnosed on its own
 * (e.g. "the task is unclear" needs no separate problem code).
 *
 * Sources: slack_codebook/object.csv, slack_codebook/problem.csv.
 * ------------------------------------------------------------------ */

export interface VocabEntry {
  /** Higher-level cluster this code belongs to (slack_codebook/*_groups.csv).
   * Display/navigation scaffolding only — it groups codes for the model and the
   * feedback-scope UI. It NEVER gates selection, priors, or grounding. */
  category: string;
  code: string;
  definition: string;
}

/** The 21 objects a critique can be about (object.csv). `category` mirrors
 * slack_codebook/object_groups.csv (source of truth for the clustering). */
export const OBJECTS: readonly VocabEntry[] = [
  { category: "visuals & layout", code: "component", definition: "a generic dashboard element, unspecified or not fitting another category" },
  { category: "visuals & layout", code: "chart", definition: "a data-encoding view on the dashboard" },
  { category: "visuals & layout", code: "color", definition: "color choices and their use" },
  { category: "visuals & layout", code: "layout", definition: "spatial arrangement and organization of views" },
  { category: "visuals & layout", code: "tooltip", definition: "hover/detail tooltips and their content" },
  { category: "visuals & layout", code: "text", definition: "text elements and properties: labels, annotations, titles, formatting" },
  { category: "visuals & layout", code: "visual design", definition: "high-level design aspects: visual polish, look & feel" },
  { category: "data & performance", code: "data", definition: "the data shown, its scope, granularity, and relationships" },
  { category: "data & performance", code: "metadata", definition: "source, metric definitions, and surrounding context" },
  { category: "data & performance", code: "performance", definition: "slowness and opportunities for optimization" },
  { category: "interaction & usability", code: "interaction", definition: "interaction aspects and affordances" },
  { category: "interaction & usability", code: "usability", definition: "usage and usability aspects not fitting elsewhere" },
  { category: "interaction & usability", code: "accessibility", definition: "access for a broader range of users and conditions" },
  { category: "clarity & insight", code: "cognition", definition: "preemptive processing and cognitive load" },
  { category: "clarity & insight", code: "readability", definition: "reading and interpretability" },
  { category: "clarity & insight", code: "clarity", definition: "clarity and understanding, e.g. ambiguity" },
  { category: "clarity & insight", code: "storytelling", definition: "flow and narrative" },
  { category: "clarity & insight", code: "insights", definition: "extracting insights from the dashboard" },
  { category: "purpose & fit", code: "task", definition: "support for the user's analytical goals" },
  { category: "purpose & fit", code: "usage context", definition: "contextual aspects of users and usage" },
  { category: "purpose & fit", code: "design process", definition: "practices and strategies for authoring the dashboard" },
];

/** The 21 problems an object can exhibit (problem.csv). `problem` is optional.
 * `category` mirrors slack_codebook/problem_groups.csv. Each cluster names a
 * KIND OF DEFECT (negative polarity), since a problem is "what is wrong." */
export const PROBLEMS: readonly VocabEntry[] = [
  { category: "sloppiness", code: "unpolished | poorly done", definition: "needs improvement" },
  { category: "sloppiness", code: "cluttered | crowded", definition: "too many elements or concepts" },
  { category: "incoherence", code: "inconsistent | mismatched", definition: "breaks patterns" },
  { category: "irrelevance", code: "not purposeful", definition: "unclear rationale for choices" },
  { category: "incoherence", code: "breaks established principles", definition: "accessibility, gestalt, usability, ..." },
  { category: "sloppiness", code: "misaligned or disorganized", definition: "not neat enough" },
  { category: "unavailability", code: "missing | absent | unsupported", definition: "should be present but is not" },
  { category: "unavailability", code: "incomplete", definition: "something is missing" },
  { category: "unavailability", code: "obscured | not discoverable", definition: "available, but hard to find" },
  { category: "miscommunication", code: "unclear | ambiguous", definition: "message present but vague or confusing" },
  { category: "miscommunication", code: "misleading", definition: "sends a different message than intended" },
  { category: "miscommunication", code: "incorrect | invalid", definition: "message or execution is wrong" },
  { category: "incoherence", code: "conflicting", definition: "two or more elements contradict each other" },
  { category: "friction", code: "unfamiliar", definition: "hard to relate to" },
  { category: "friction", code: "overly complex | difficult", definition: "cognitively challenging to understand or navigate" },
  { category: "friction", code: "slow, time-consuming", definition: "doable, but takes time and effort" },
  { category: "miscalibration", code: "limited affordance", definition: "poor coverage of capabilities" },
  { category: "miscalibration", code: "too granular", definition: "too much detail" },
  { category: "miscalibration", code: "not granular enough", definition: "not detailed enough" },
  { category: "irrelevance", code: "not significant | irrelevant", definition: "focus on unimportant facets" },
  { category: "irrelevance", code: "distracting", definition: "elements take attention away from what matters" },
];

export const OBJECT_CODES: ReadonlySet<string> = new Set(OBJECTS.map((entry) => entry.code));
export const PROBLEM_CODES: ReadonlySet<string> = new Set(PROBLEMS.map((entry) => entry.code));

export function isObjectCode(code: unknown): code is string {
  return typeof code === "string" && OBJECT_CODES.has(code);
}

export function isProblemCode(code: unknown): code is string {
  return typeof code === "string" && PROBLEM_CODES.has(code);
}

/* ------------------------------------------------------------------ *
 * Diagnostic priors (priorWeight only — never an admission gate)
 *
 * Co-occurrence counts from the completed Slack critique coding
 * (slack_codebook/diagnostic-priors.json). Tiers: high >=4, medium 2-3,
 * low 1 or unobserved. Only the high/medium combinations are listed; every
 * other combination (including all unobserved ones) defaults to "low".
 * priorWeight expresses prior confidence and how much careful grounding a
 * claim deserves; it NEVER prevents a combination from being diagnosed.
 * ------------------------------------------------------------------ */

const OBSERVED_COMBO_PRIORS: Record<string, Priority> = {
  "text|unclear | ambiguous": "high",
  "layout|misaligned or disorganized": "high",
  "task|unclear | ambiguous": "high",
  "component|not purposeful": "medium",
  "task|not purposeful": "medium",
  "tooltip|not significant | irrelevant": "medium",
  "chart|limited affordance": "medium",
  "chart|not purposeful": "medium",
  "chart|overly complex | difficult": "medium",
  "chart|unclear | ambiguous": "medium",
  "color|breaks established principles": "medium",
  "color|inconsistent | mismatched": "medium",
  "color|unclear | ambiguous": "medium",
  "color|unpolished | poorly done": "medium",
  "data|too granular": "medium",
  "interaction|slow, time-consuming": "medium",
  "interaction|unclear | ambiguous": "medium",
  "layout|cluttered | crowded": "medium",
  "text|unpolished | poorly done": "medium",
  "tooltip|not granular enough": "medium",
  "visual design|cluttered | crowded": "medium",
  "visual design|distracting": "medium",
};

const OBJECT_ONLY_PRIORS: Record<string, Priority> = {
  task: "high",
  chart: "high",
  "design process": "medium",
  layout: "medium",
  text: "medium",
  performance: "medium",
};

/** Prior confidence for an object (optionally with a problem). Unobserved
 * combinations return "low" — they are still fully diagnosable. */
export function priorWeightFor(object: string, problem?: string): Priority {
  if (problem) return OBSERVED_COMBO_PRIORS[`${object}|${problem}`] ?? "low";
  return OBJECT_ONLY_PRIORS[object] ?? "low";
}

/** Surface the empirical co-occurrence signal as hypotheses worth checking,
 * rather than using it as a hidden allowlist. Unobserved combinations remain
 * fully valid when the dashboard evidence supports them. */
function empiricalPriorsPrompt(): string {
  return Object.entries(OBSERVED_COMBO_PRIORS)
    .map(([combo, weight]) => {
      const separator = combo.indexOf("|");
      const object = combo.slice(0, separator);
      const problem = combo.slice(separator + 1);
      return `  - ${weight}: ${object} × ${problem}`;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Prompt-facing diagnostic knowledge
 * ------------------------------------------------------------------ */

/** Serialize a vocabulary under its `[cluster]` headers, in first-appearance
 * order, mirroring `recommendationCatalogPrompt()`'s `[branch]` layout. The
 * cluster is a reading aid for the model (and the same grouping shown in the
 * feedback-scope UI); the exact code the model returns is still one of the flat
 * codes, and clustering never gates selection, priors, or grounding. */
function clusteredVocabPrompt(entries: readonly VocabEntry[]): string {
  const byCategory = new Map<string, VocabEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  const lines: string[] = [];
  for (const [category, members] of byCategory) {
    lines.push(`[${category}]`);
    for (const entry of members) {
      lines.push(`  - ${entry.code} — ${entry.definition}`);
    }
  }
  return lines.join("\n");
}

/** The static reasoning vocabulary handed to the model in the system prompt:
 * the object list, the optional problem list, the grounding labels, and the
 * full recommendation-leaf catalog it may prescribe from freely. Objects and
 * problems are grouped under `[cluster]` headers (see slack_codebook/
 * object_groups.csv and problem_groups.csv) purely to aid reading and to match
 * the feedback-scope grouping in the UI; the model still returns one exact flat
 * code, and the cluster never gates anything. */
export function diagnosticKnowledgePrompt(): string {
  const objects = clusteredVocabPrompt(OBJECTS);
  const problems = clusteredVocabPrompt(PROBLEMS);
  const grounding = JUDGMENT_BASIS_LABELS.map((label) => `  - ${label}`).join("\n");
  return [
    "OBJECTS (what the critique is about — grouped by cluster for reading only;",
    "choose exactly one exact code, from any cluster):",
    objects,
    "",
    "PROBLEMS (what is wrong with the object — grouped by cluster for reading only;",
    "optional; choose one exact code from any cluster, or omit):",
    problems,
    "",
    "GROUNDING LABELS (the basis a claim rests on — cite one or more exact labels):",
    grounding,
    "",
    "EMPIRICALLY OBSERVED OBJECT × PROBLEM PAIRS (attention cues, NOT a checklist,",
    "quota, or admission gate; unlisted combinations are equally allowed when grounded):",
    empiricalPriorsPrompt(),
    "",
    "RECOMMENDATION CATALOG (the fix to prescribe — choose one exact leaf id from ANY branch;",
    "use as an empirical strategy scaffold; omit when no leaf precisely fits; the branch",
    "a leaf belongs to does not have to match the object):",
    recommendationCatalogPrompt(),
  ].join("\n");
}
