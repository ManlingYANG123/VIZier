/**
 * Shared contracts for the VIZier v2 critique engine.
 *
 * These mirror the frontend contracts already defined in prototype/v2:
 *   - the critique schema in prototype/v2/README.md (§6)
 *   - the request/response shape in prototype/v2/README.md (lines 83-105)
 *   - reevaluateMock's delta in prototype/v2/src/recommendation-engine.js
 *
 * The engine is renderer-agnostic: its input is a map of addressable
 * Vega-Lite tile specs (a "spec map"), never a .twbx. twbx2vegalite is only
 * one possible upstream adapter and is out of scope here.
 */

/** A loose Vega-Lite unit spec. We treat specs structurally, not nominally. */
export type VegaLiteSpec = Record<string, unknown>;

/** Addressable tile specs, keyed by tile id (matches v2 tile ids). */
export type SpecMap = Record<string, VegaLiteSpec>;

/** The operations the engine can detect across every review dimension. */
export type ProposalKind =
  // interaction branch
  | "add-cross-filter"
  | "add-tooltip"
  | "show-filter-state"
  | "wire-filter-control"
  // color / data branches
  | "add-kpis"
  | "recompose-kpis"
  | "v2-palette"
  | "preserve-brand-palette"
  // text branch
  | "dashboard-title"
  | "chart-subtitles"
  // general spec-edit primitive: model-proposed, engine-sanitized JSON edits to
  // a single tile spec. This is the executable route for the many catalog fixes
  // that reduce to a Vega-Lite spec change (chart form, color, axes, sort,
  // scale, labels, legends, spec-internal layout) — everything is in the JSON,
  // so most component-level fixes are applyable through it.
  | "edit-spec"
  // dashboard-level layout primitive: model-proposed new canvas-space bounds for
  // one or more tiles (move / resize / re-flow). Tile position and size live on
  // the board (`board.tiles[].bounds`), NOT in any Vega-Lite unit spec, so this
  // is the only executable route for a board-layout change. The engine validates
  // every proposed box against the canvas and sets `board.tiles[].bounds`.
  | "edit-layout"
  | (string & {});

/**
 * A recommendation branch. In v2 this is the top-level grouping of the leaf
 * recommendation codebook (recommendation_v3_examples.csv); a finding/critique carries
 * the branch of its prescribed recommendation. Branch is a display/grouping
 * label only — DIAGNOSING (object×problem) does not gate which branch a
 * prescription may come from.
 *
 * The first 11 values are exactly the branches enumerated in
 * RECOMMENDATION_BRANCHES (generate/recommendations.ts); those two lists must
 * stay in lockstep. The former v1 review-dimension values ('visual' |
 * 'narrative' | 'accessibility' | 'performance') are gone: `accessibility` is
 * now a Crosscutting tag (below), and `performance`/`visual`/`narrative` are
 * covered by object codes and the 'visual design' branch respectively.
 *
 * `other` is NOT a recommendation branch — it is the sentinel a critique
 * carries when it was admitted on merit (grounded, specific, actionable) but no
 * catalog leaf matched its prescribed fix. It marks an uncatalogued
 * recommendation: kept as guidance, never routed to an executable branch, and
 * its rate is a coverage signal for where recommendation_v3_examples.csv is missing a
 * leaf. It deliberately sits outside the branch lockstep.
 */
export type Dimension =
  | "chart"
  | "color"
  | "layout"
  | "data"
  | "text"
  | "visual design"
  | "cognition"
  | "context"
  | "interaction"
  | "task"
  | "design process"
  | "other";

/** Crosscutting concern carried independently of the recommendation branch.
 * `accessibility` was a review dimension in v1; in v2 it can apply to a finding
 * in ANY branch, so it is a tag rather than a branch value. */
export type Crosscutting = "accessibility";
export type Priority = "high" | "medium" | "low";
export type Surface = "interaction" | "encoding" | "structural" | "text";
export type InteractionKind = "cross-filter" | "hover-tooltip";
/** What the author asked the common review engine to inspect. This is a scope,
 * not a generation route: every scope uses the same criteria-aware pipeline. */
export type ReviewScope = "full" | "focused" | "selected-region";

/** Temporary input compatibility for older v2 clients. The unified engine no
 * longer changes behavior based on either legacy value. */
export type LegacyReviewMode = "rubric" | "synthesis";

/** Outcome of DIAGNOSING one object (optionally with a problem). Mirrors the
 * former criterion outcomes so trace/observability code is unchanged. */
export type DiagnosisOutcome =
  | "evaluated_issue"
  | "evaluated_no_issue"
  | "not_evaluated_missing_context"
  | "out_of_scope"
  | "unsupported";

/** Grounding: the basis a claim rests on. The five codebook grounding types
 * plus the always-available artifact basis "dashboard evidence". This is the
 * uniform authorization gate — a claim is admitted only when at least one cited
 * label is supported by its evidence. Exact labels from the Slack coding. */
export type JudgmentBasis =
  | "dashboard evidence"
  | "general design principle"
  | "analytical task"
  | "audience"
  | "author constraint"
  | "personal preference";

export type ContextField = "goal" | "audience" | "constraints";
export type ContextValueStatus = "inferred" | "confirmed" | "missing";
export type ContextStatus = "available" | "missing" | "inferred" | "not_applicable";

/** The communicative genre of the dashboard, inferred at scaffold time and
 * author-editable. It is a review LENS, never a grounding basis: different
 * genres value different things, so it modulates how strictly each review
 * dimension is judged (see src/generate/dashboard-type.ts) — it never admits or
 * rejects a claim on its own (grounding remains the only authorization gate).
 *   - analytical:  self-service exploration and pattern-finding
 *   - operational: at-a-glance status monitoring and anomaly detection
 *   - infographic: a narrative that delivers one explicit conclusion
 *   - executive:   a high-level so-what summary for decision-makers */
export type DashboardType = "analytical" | "operational" | "infographic" | "executive";

export interface EvidenceRef {
  source: "dashboard" | "context" | "interaction" | "detector";
  /** Stable address such as tile.task-velocity.encoding.x or context.goal. */
  path: string;
  detail: string;
  tileId?: string;
  field?: string;
  channel?: string;
  findingId?: string;
  findingKind?: FindingKind;
}

/** One DIAGNOSING result: an object (optionally a problem) evaluated against
 * the dashboard evidence and context, authorized by grounding. This replaces
 * the former per-criterion evaluation. `object` and the optional `problem` are
 * exact codebook codes; `priorWeight` is empirical prior confidence and never
 * gates admission. */
export interface Diagnosis {
  /** Exact object code (object.csv). */
  object: string;
  /** Exact problem code (problem.csv). Optional — an object may be diagnosed alone. */
  problem?: string;
  outcome: DiagnosisOutcome;
  /** Grounding labels the claim rests on (the authorization gate). */
  judgmentBasis: JudgmentBasis[];
  /** Prior confidence from Slack co-occurrence; display/ranking hint only. */
  priorWeight: Priority;
  /** Typed registry IDs. Kept data-driven because the final list is not adjudicated. */
  requiredContext: string[];
  contextStatus: ContextStatus;
  evidenceRefs: EvidenceRef[];
  rationale: string;
}

/** One standout POSITIVE observation: something the dashboard does genuinely
 * well, authorized by the SAME grounding gate as a Diagnosis. It is produced by
 * the review LLM call independently of critiques, so it can exist for a scope
 * that yields zero critiques. `title`/`detail` are author-facing copy;
 * `object` is an exact codebook code; `evidenceRefs`/`judgmentBasis` ground the
 * praise so it stays objective and is never manufactured. Rendered as a
 * positive card INSIDE its matching dimension group in the critique list — a
 * praise-only critique card, not a separate panel. */
export interface Strength {
  id: string;
  /** Exact object code (object.csv) the strength is about. */
  object: string;
  /** Grouping dimension for the positive card — the topic section it sits
   * under in the critique list (e.g. "color", "text"). Model-emitted grouping
   * tag, NOT the protected object×problem→recommendation mapping; defaults to
   * "other" when absent or unrecognized. */
  dimension: Dimension;
  /** Tile the strength is about (null = whole board). */
  tileId?: string | null;
  /** One concise sentence summarizing the positive takeaway — the card's lead
   * line ("why this is well done"). */
  title: string;
  /** One short line naming the CONCRETE, artifact-specific evidence behind the
   * praise (the specific charts/fields/encodings) — the card's small line
   * beneath the title. Kept concise; the honesty gate still requires real
   * evidenceRefs, so this line describes evidence that provably exists. */
  detail: string;
  /** Grounding labels the praise rests on (the authorization gate). */
  judgmentBasis: JudgmentBasis[];
  /** Validated evidence the praise cites (never empty after the gate). */
  evidenceRefs: EvidenceRef[];
  /** The author-request scope handled by the common generation path. */
  reviewScope?: ReviewScope;
}

export type FindingKind =
  | "cross-filter-gap"
  | "ineffective-filter-control"
  | "missing-tooltip"
  | "missing-kpi"
  | "uniform-palette"
  | "preserve-brand"
  | "generic-title"
  | "missing-subtitles"
  | (string & {});

/** Structured, deterministic finding produced by a detector (the grounding). */
export interface Finding {
  id: string;
  kind: FindingKind;
  /** Recommendation branch of the prescribed fix (display/grouping label). */
  dimension: Dimension;
  /** Zero-or-more crosscutting concerns (e.g. accessibility) that apply
   * regardless of the branch. */
  crosscutting?: Crosscutting[];
  proposalKind: ProposalKind;
  /** Which UI surface the fix touches (drives the frontend change preview). */
  surface: Surface;
  /** Only set for interaction findings. */
  interactionKind?: InteractionKind;
  severity: Priority;
  /** Machine-checkable structural evidence; the LLM may only phrase this. */
  evidence: {
    detail: string;
    sharedField?: string;
    sourceTile?: string;
    targetTiles?: string[];
    tile?: string;
    tiles?: string[];
    channel?: string;
    colorFamily?: string;
    colors?: string[];
    title?: string;
    tileCount?: number;
    missingCount?: number;
    filterId?: string;
    controlLabel?: string;
    field?: string;
    targets?: string[];
    validTargets?: string[];
  };
  target: CritiqueTarget;
  /** Tile the box should be drawn on (null = whole board). */
  tileId: string | null;
  bounds?: Bounds;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CritiqueTarget {
  granularity: string;
  ref: Record<string, unknown>;
}

/** A rendered element intersecting an author-drawn review region. Unlike raw
 * canvas pixels, this identifies what the author could actually see/select. */
export interface RegionSemanticTarget {
  kind:
    | "dashboard-title"
    | "dashboard-subtitle"
    | "filter-control"
    | "tile"
    | "tile-title"
    | "tile-subtitle"
    | "chart"
    | "axis"
    | "legend"
    | "mark"
    | "annotation";
  /** Canonical evidence/application address such as board.title or
   * tile.task-velocity.encoding. */
  path: string;
  tileId?: string;
  filterId?: string;
  text?: string;
  bounds: Bounds;
  /** Intersection area divided by this element's rendered area. */
  overlapRatio: number;
}

export type RequestAction =
  | "shorten"
  | "lengthen"
  | "remove"
  | "rename"
  | "reposition"
  | "resize"
  | "recolor"
  | "simplify"
  | "emphasize"
  | "deemphasize"
  | "restructure"
  | "fix"
  | "evaluate";

/** A compact, inspectable interpretation of an explicit focused/local ask.
 * This is not hidden chain-of-thought: it is an acceptance contract used by
 * generation, preview, Apply, telemetry, and tests. */
export interface ReviewRequestContract {
  request: string;
  explicitChange: boolean;
  actions: RequestAction[];
  targetPaths: string[];
  targetKinds: RegionSemanticTarget["kind"][];
  mustPreserve: string[];
  successCriteria: string[];
}

export interface Proposal {
  kind: ProposalKind;
  /** Guidance-only recommendations are visible but can never enter /apply. */
  mode?: "executable" | "guidance_only";
  /** For kind "edit-spec": the sanitized set/remove edits to apply to the tile
   * spec identified by target.ref.tile. Each edit is `{op, path, value?}`. The
   * engine re-sanitizes these against the tile's real fields before applying. */
  edits?: Array<{ op: "set" | "remove"; path: Array<string | number>; value?: unknown }>;
  /** For kind "edit-layout": model-proposed new canvas-space bounds per tile.
   * The engine re-validates each box (real tile id, on-canvas, non-degenerate)
   * before writing it to `board.tiles[].bounds`. */
  layout?: Array<{ tile: string; bounds: Bounds }>;
  /** Named deterministic board composition. The engine computes safe bounds from
   * current tiles, so ambitious reflows do not rely on brittle model arithmetic. */
  composition?: "hero-left" | "hero-top" | "asymmetric-grid" | "kpi-rail" | "small-multiples";
  layoutTiles?: string[];
  /** Exact tile that owns the dominant slot in a named composition. */
  heroTileId?: string;
  /** For kind "add-kpis": model-authored KPI definitions. The engine computes
   * each `value` from the real inline tile data (never fabricated) and returns
   * the resolved KPIs on `board.kpis`. */
  kpis?: KpiDefinition[];
  /** A constrained, model-selected typography treatment for the KPI band.
   * Presets preserve legibility while avoiding one house style on every board. */
  kpiStyle?: KpiStyle;
  /** Structural KPI composition, independent from the typography voice. */
  kpiLayout?: KpiLayout;
  kpiAlignment?: "start" | "center" | "end";
  kpiDensity?: "airy" | "balanced" | "dense";
  kpiChrome?: "plain" | "ruled" | "filled";
  /** For wire-filter-control: exact id of a visible board filter to repair. */
  filterId?: string;
  /** Optional model-authored palette for `v2-palette`. Values are sanitized
   * before apply; this lets the empirical color recommendation adapt to the
   * dashboard/design-document direction instead of imposing one house palette. */
  palette?: string[];
  [extra: string]: unknown;
}

/** A model-authored KPI definition. The label is copy; the aggregate names a
 * real field + reducer the engine evaluates against a tile's inline data. */
export interface KpiDefinition {
  label: string;
  /** Which tile's inline data to read (a real tile id). */
  tile?: string;
  field?: string;
  agg?: KpiAggregate;
  /** Optional exact row filter for category-specific KPIs. For example,
   * "Good days" must aggregate only rows whose `band` is "Good", rather than
   * summing the entire category table and displaying a plausible wrong total. */
  filter?: { field: string; value: string | number | boolean };
  /** Exact row filters combined with AND. Use this when a KPI is scoped by
   * more than one dimension, such as one species in one specific year. The
   * singular `filter` remains supported for backwards compatibility. */
  filters?: Array<{ field: string; value: string | number | boolean }>;
  /** Set true to draw the eye to a headline / at-risk figure. */
  highlight?: boolean;
  /** Optional unit suffix ("%", "d") appended to the computed number. */
  unit?: string;
  /** Deterministic display treatment applied after computing the real value. */
  format?: "auto" | "compact" | "currency" | "percent" | "percent-fraction" | "integer";
}

export type KpiAggregate = "count" | "sum" | "avg" | "min" | "max" | "distinct";
export type KpiStyle = "editorial" | "product" | "compact" | "technical";
export type KpiLayout = "hero-support" | "card-grid" | "side-rail" | "inline-summary";

/** A KPI after the engine has computed its value from real data. `value` is the
 * display string ("31", "67%"); `computed` is false when no data backed it. */
export interface ResolvedKpi {
  label: string;
  value: string;
  highlight?: boolean;
  computed: boolean;
}

/** The critique object the v2 frontend consumes (README §6). */
export interface Critique {
  id: string;
  tileId: string | null;
  /** Recommendation branch (display/grouping label). */
  dimension: Dimension;
  /** Zero-or-more crosscutting concerns (e.g. accessibility) that apply
   * regardless of the branch; rendered as separate tags in the UI. */
  crosscutting?: Crosscutting[];
  priority: Priority;
  status: "pending" | "resolved" | "updated" | "superseded" | "accepted" | "rejected";
  source: "ai" | "manual";
  title: string;
  issue: string;
  rationale: string;
  evidence: string;
  suggestion: string;
  target: CritiqueTarget;
  proposal: Proposal;
  surface: Surface;
  interactionKind?: InteractionKind;
  bounds?: Bounds;
  /** Provenance: the validated finding record backing this critique. */
  findingId: string;
  /** True after schema, evidence text, and dashboard target references validate.
   * This does not imply the finding came from a deterministic detector. */
  grounded: boolean;
  /** Whether the visible critique copy came from the model or an explicit
   * offline-template run. Real-mode requests never return template copy. */
  phrasingSource: "llm" | "template" | "mixed";
  /** The author-request scope handled by the common generation path. */
  reviewScope?: ReviewScope;
  /** Diagnosis and evidence provenance for validation, research, and
   * re-evaluation. `object`/`problem` are the DIAGNOSING codes; `recommendation`
   * is the exact prescribed leaf id (its branch is `dimension`) when the fix
   * matched a catalog leaf, and is omitted for an uncatalogued fix (in which
   * case `dimension` is "other"); `judgmentBasis` is the grounding that
   * authorized the claim. */
  object?: string;
  problem?: string;
  recommendation?: string;
  diagnosisOutcome?: DiagnosisOutcome;
  priorWeight?: Priority;
  judgmentBasis?: JudgmentBasis[];
  requiredContext?: string[];
  contextStatus?: ContextStatus;
  evidenceRefs?: EvidenceRef[];
  supportStatus?: "validated" | "tentative" | "rejected";
  registryVersion?: string;
  promptVersion?: string;
  engineVersion?: string;
  model?: string;
  contextSnapshotId?: string;
  /** A concise answer to the author's explicit focused or selected-region
   * review request. */
  answer?: string;
  /** Ranking relevance is intentionally separate from issue severity. A direct
   * answer is surfaced first without falsely upgrading a low-severity issue. */
  requestRelevance?: "direct";
  /** Echoed review request keeps the result understandable after the input
   * changes or the critique is opened from another part of the interface. */
  reviewRequest?: string;
  /** Deterministic acceptance contract for a direct focused/local request. */
  requestContract?: ReviewRequestContract;
}

/** ---- Observability: the trace event stream ---- */

export type TracePhase =
  | "run_start"
  | "evidence_start"
  | "evidence_done"
  | "eligibility_start"
  | "eligibility_done"
  | "detect_start"
  | "detect_done"
  | "generate_start"
  | "generate_token"
  | "generate_done"
  | "guardrail_done"
  | "rank_done"
  | "constraint_filter"
  | "apply"
  | "validate"
  | "compute"
  | "reevaluate_done"
  | "error"
  | "done";

export interface TraceEvent {
  runId: string;
  seq: number;
  ts: number;
  phase: TracePhase;
  message?: string;
  data?: unknown;
}

/** ---- Request / response contracts (README lines 83-105) ---- */

export interface DashboardContext {
  goal?: string;
  audience?: string;
  constraints?: string;
  scope?: string[];
  /** Communicative genre lens for per-dimension review strictness. Inferred at
   * scaffold time, author-editable, never a grounding basis. */
  dashboardType?: DashboardType;
  notes?: string[];
  customTypes?: string[];
  /** Provenance travels separately from the editable string values so legacy
   * clients can continue to send the flat context shape during migration. */
  fieldStatus?: Partial<Record<ContextField, ContextValueStatus>>;
  snapshotId?: string;
}

/** ---- Design-document hard constraints (explicit-context intake) ----
 *
 * A design/brand guidelines document (brand colors, fonts, icons, layout rules)
 * becomes a set of HARD constraints, produced by the dedicated intake module
 * (src/intake/) and used AFTER generation to silently drop conflicting
 * critiques. The same confirmed set — plus a clipped copy of the extracted
 * source text — is also included in the review prompt so the model can avoid
 * proposing those conflicts instead of only losing them in the filter.
 * This is a channel SEPARATE from `DashboardContext.constraints`:
 * the free-text `constraints` string still drives the "author constraint"
 * grounding basis; a ConstraintSet does not change the context snapshot hash. */
export type ConstraintCategory =
  | "palette"
  | "typography"
  | "iconography"
  | "layout"
  | "format"
  | "other";

/** A design source the intake module can normalize. Adding a new source type
 * (url/image/…) is a localized addition here plus one adapter in
 * src/intake/sources.ts — the generation path is untouched. `pdf-text` and
 * `raw-text` are the MVP text-only sources; `url`/`image` are declared for the
 * future adapters (image also needs a vision-capable LLM content block, which
 * the text-only llm/client.ts does not yet send).
 *
 * `note` is an optional author instruction that steers extraction — e.g. "use
 * the color palette in here" tells the intake model to focus on the palette and
 * treat it as locked. It never invents constraints the document does not state;
 * it only directs emphasis (intake/prompt.ts). */
export type ConstraintSource =
  | { kind: "pdf-text"; text: string; filename?: string; pageCount?: number; note?: string }
  | { kind: "raw-text"; text: string; note?: string }
  | { kind: "url"; url: string }
  | { kind: "image"; dataUrl: string };

/** One hard constraint extracted from a design document. `value` carries the
 * category-specific machine-usable fields the deterministic filter keys on
 * (e.g. a locked palette); `rule`/`sourceText` keep the human phrasing the LLM
 * judge reasons over. */
export interface HardConstraint {
  id: string;
  category: ConstraintCategory;
  /** Human phrasing of the locked rule (e.g. "Only brand palette colors"). */
  rule: string;
  /** Original text the rule was extracted from. */
  sourceText: string;
  confidence: "high" | "medium" | "low";
  /** Category-specific machine-usable fields, present where extractable. */
  value?: {
    colors?: string[];
    scheme?: string;
    locked?: boolean;
    fontFamilies?: string[];
    iconStyle?: string;
    iconSet?: string;
    aspectRatio?: string;
    grid?: string;
    regionsFixed?: boolean;
  };
}

/** The normalized, content-addressed constraint representation produced by the
 * intake module and carried on CritiqueRequest. */
export interface ConstraintSet {
  /** Content hash, `ct-<sha256:12>`. */
  id: string;
  sourceKind: ConstraintSource["kind"];
  /** Human-readable provenance, e.g. "brand-guide.pdf · 12 pages". */
  provenance: string;
  constraints: HardConstraint[];
}

/** One critique the conflict filter removed because it conflicts with a hard
 * constraint. Surfaced on CriteriaReviewResult for dev observability only; the
 * author-facing critique list simply omits the dropped critique. */
export interface ConflictDrop {
  id: string;
  constraintId: string;
  category: ConstraintCategory;
  reason: string;
}

/** POST /intake-constraints: turn a single design source into a ConstraintSet. */
export interface IntakeConstraintsRequest {
  source: ConstraintSource;
  /** When true the API fails loudly instead of returning an empty set if no
   * model is configured (mirrors ScaffoldRequest.requireLLM). */
  requireLLM?: boolean;
}

export interface IntakeConstraintsResponse {
  constraintSet: ConstraintSet;
  source: "llm" | "empty";
}

/** First-stage context scaffold: unstructured author material becomes the same
 * living DashboardContext consumed by critique/apply. */
export interface ScaffoldRequest {
  rawText?: string;
  mode?: "paste" | "dashboard-draft";
  /** The onboarding UI requires a real model call. When true, the API must
   * fail rather than silently returning deterministic copy. */
  requireLLM?: boolean;
  dashboard?: {
    title?: string;
    tileTitles?: string[];
    visibleMetrics?: string[];
  };
  specMap?: SpecMap;
  board?: BoardMeta;
}

export interface ScaffoldResponse {
  context: Required<Pick<DashboardContext, "goal" | "audience" | "constraints" | "scope" | "dashboardType">>;
  assumptions: string[];
  missingFields: Array<"goal" | "audience" | "constraints">;
  source: "llm" | "template";
  fieldStatus: Record<ContextField, ContextValueStatus>;
  contextSnapshotId: string;
}

/** Per-tile board metadata that isn't expressible in a Vega-Lite unit spec
 * (chart title/subtitle chrome lives in the dashboard frame, not the spec). */
export interface BoardTileMeta {
  id: string;
  title?: string;
  hasSubtitle?: boolean;
  /** Canvas-space bounds used to scope a local critique request. */
  bounds?: Bounds;
}

/** Dashboard-level chrome the detectors need but that is outside the spec map:
 * the heading text, whether a KPI row exists, and per-tile subtitle presence. */
export interface BoardMeta {
  title?: string;
  subtitle?: string;
  /** Rendered heading typography (px) captured from the live DOM. The board
   * title/subtitle font sizes live in CSS, not in any spec, so without this the
   * engine cannot ground size or hierarchy judgments about the heading. */
  typography?: {
    titleFontPx?: number;
    subtitleFontPx?: number;
    titleToSubtitleRatio?: number;
    titleFontFamily?: string;
    subtitleFontFamily?: string;
    kpiValueFontFamily?: string;
    kpiValueFontPx?: number;
  };
  hasKpis?: boolean;
  /** True when KPI/metric tiles already exist inside the tile grid, even though
   * no separate engine-owned KPI band is present. */
  hasEmbeddedKpis?: boolean;
  /** Visible dashboard-level categorical/range controls. `wired:false` keeps
   * prepared broken examples visible while the detector can diagnose them. */
  filters?: DashboardFilterControl[];
  tiles?: BoardTileMeta[];
  /** Immutable uploaded canvas dimensions. Recommendations may reflow content
   * inside this boundary but may never grow or shrink the artboard. */
  canvasWidth?: number;
  canvasHeight?: number;
  /** KPIs the engine computed from real tile data for an applied add-kpis. When
   * present the frontend renders these instead of any placeholder band. */
  kpis?: ResolvedKpi[];
  /** Sanitized typography preset selected for the KPI band. */
  kpiStyle?: KpiStyle;
  kpiLayout?: KpiLayout;
  kpiAlignment?: "start" | "center" | "end";
  kpiDensity?: "airy" | "balanced" | "dense";
  kpiChrome?: "plain" | "ruled" | "filled";
  /** Engine-owned space reserved by the current KPI composition. */
  kpiReservedHeight?: number;
  kpiReservedWidth?: number;
}

export interface DashboardFilterControl {
  id: string;
  label: string;
  kind: "category" | "range";
  field: string;
  targets: string[];
  wired: boolean;
  options?: Array<string | number>;
  min?: number;
  max?: number;
  step?: number;
  value?: string | number | Array<string | number> | null;
  /** Dashboard-authored presentation metadata. Interaction semantics stay
   * independent, so controls can inherit each dashboard's layout and visual
   * language instead of converging on one global filter bar. */
  variant?: "select" | "segmented" | "chips" | "checkboxes" | "slider";
  placement?: "top-row" | "title-inline" | "left-rail" | "right-rail" | "chart-header" | "floating";
  container?: "plain" | "panel" | "pill" | "ruled";
  tone?: "neutral" | "accent" | "contrast";
  accent?: string;
  anchorTile?: string;
  position?: { x: number; y: number; w?: number };
}

/** A user-selected dashboard region for the common criteria-aware review. */
export interface LocalCritiqueRegion {
  bounds: Bounds;
  request: string;
  /** Optional branch hint from the author (non-authoritative). */
  dimension?: Dimension;
  crosscutting?: Crosscutting[];
  /** Rendered semantic elements intersecting the author's box. Supplied by the
   * browser and sanitized against the current board/spec map by the engine. */
  semanticTargets?: RegionSemanticTarget[];
  /** Optional client interpretation. The engine always rebuilds and sanitizes
   * its own contract before prompting or applying. */
  requestContract?: ReviewRequestContract;
}

/** A review-scoped author question. Unlike DashboardContext, this instruction
 * selects and ranks what the current generation run should answer; it is not
 * stored as durable background knowledge about the dashboard. */
export interface FocusedReviewRequest {
  request: string;
  /** Distinguishes an author ask from engine-authored maintenance prompts. */
  purpose?: "author-request" | "stale-refresh" | "solution-refinement";
  /** Engine-derived acceptance contract for an explicit change request. */
  requestContract?: ReviewRequestContract;
}

/** Author-authored rationale plus the point-in-time critique snapshot that makes
 * the statement interpretable. Critique copy is explanatory metadata only; it
 * must never be treated as author-authored context or grounding evidence. */
export interface SavedCritiqueRationale {
  id: string;
  userRationale: string;
  dashboardVersion: number;
  sourceCritiqueId: string;
  currentCritiqueId: string;
  critique: {
    id?: string;
    title?: string;
    issue?: string;
    rationale?: string;
    suggestion?: string;
    dimension?: Dimension;
    targetTileId?: string;
    target?: CritiqueTarget;
    proposalKind?: ProposalKind;
    object?: string;
    problem?: string;
    recommendation?: string;
    evidence?: string;
    judgmentBasis?: JudgmentBasis[];
    reviewScope?: ReviewScope;
    reviewRequest?: string;
  };
}

export interface CritiqueRequest {
  version: number;
  context: DashboardContext;
  specMap: SpecMap;
  /** Cumulative design trajectory supplied by the authoring client. This is
   * iteration memory, never grounding evidence: prior model prose cannot prove a
   * new claim, but accepted/rejected proposal signatures prevent repetitive
   * rounds and let later reviews increase structural ambition deliberately. */
  iterationContext?: IterationContext;
  /** Real UI requests require model-authored copy and fail loudly if the
   * gateway or grounding guardrail cannot produce it. */
  requireLLM?: boolean;
  /** Dashboard chrome (title/KPIs/subtitles) grounding non-spec findings. */
  board?: BoardMeta;
  /** Optional live interaction state (e.g. current cross-filter selection). */
  interactionState?: Record<string, unknown>;
  /** Common-engine scope. Prefer this over the temporary legacy `mode`. */
  reviewScope?: ReviewScope;
  /** Accepted only while the v2 frontend migrates; ignored for generation routing. */
  mode?: LegacyReviewMode;
  /** Optional canvas selection that limits review evidence to a local area. */
  region?: LocalCritiqueRegion;
  /** Optional author question that limits review across the full dashboard. */
  focus?: FocusedReviewRequest;
  /** Confirmed author rationales with their source critique snapshots. Kept
   * separate from context.notes so model-authored critique copy cannot satisfy
   * an author-context grounding gate. */
  savedRationales?: SavedCritiqueRationale[];
  /** Author-set model temperature for the review draft, on the model's own 0–1
   * scale (0 = a strict, high-confidence sanity check; higher = more divergent
   * exploration). The engine clamps out-of-range or non-finite values and falls
   * back to its default when omitted, so older clients are unaffected. */
  reviewTemperature?: number;
  /** Hard constraints from an uploaded design document. When present, the engine
   * silently drops critiques that conflict with them AFTER ranking, before the
   * response. Omitted by older clients → no filtering (behavior unchanged). */
  constraintSet?: ConstraintSet;
  /** Extracted text of the uploaded design document (PDF/txt), already clipped
   * by the client. Shown to the review model as background for matching the
   * document; only `constraintSet` entries are locked rules. */
  designDocumentText?: string;
}

export interface IterationProposalSummary {
  signature: string;
  kind: string;
  tileIds: string[];
  object?: string;
  problem?: string;
  recommendation?: string;
  version?: number;
}

export interface IterationContext {
  round: number;
  dashboardVersion: number;
  applied: IterationProposalSummary[];
  rejectedSignatures: string[];
  changedTargets: string[];
}

export interface CritiqueResponse {
  runId: string;
  reviewScope: ReviewScope;
  findings: Finding[];
  critiques: Critique[];
  /** DIAGNOSING outcomes (object × optional problem), one per diagnosed pair. */
  diagnoses: Diagnosis[];
  /** Standout positive observations, produced independently of critiques and
   * rendered inline as a positive card inside their matching dimension group in
   * the critique list (not a separate panel). Empty when nothing grounded stands
   * out (never padded with manufactured praise). */
  strengths: Strength[];
  registryVersion: string;
  promptVersion: string;
  engineVersion: string;
  /** Exact end-to-end demonstration set used in the model request. The content
   * hash disambiguates runs even if a maintainer forgets to bump the version. */
  fewShotSetId: string;
  fewShotVersion: string;
  fewShotIds: string[];
  fewShotContentHash: string;
  contextSnapshotId: string;
  /** Echoes the normalized focused-review request used for this run. */
  focus?: FocusedReviewRequest;
  /** A plain-language direct answer to a focused or selected-region request,
   * surfaced even when no standard critique survives validation. Absent for a
   * full review (which has no explicit author question to answer). */
  answer?: string;
}

export interface ApplyRequest {
  version: number;
  context: DashboardContext;
  specMap: SpecMap;
  board?: BoardMeta;
  critiques: Critique[];
  selectedRecommendationIds: string[];
  conflictChoices?: Record<string, string>;
}

export interface RecommendationDelta {
  kept: string[];
  updated: string[];
  removed: string[];
  added: string[];
  changedTargets: string[];
}

export interface EvaluationReport {
  compiled: boolean;
  compileError: string | null;
  remainingFindings: number;
  computed: Array<{ tileId: string; note: string }>;
}

/** What actually happened to one selected critique during apply. The UI marks
 * only `applied`/`merged` critiques resolved, so a fix that was silently dropped
 * by a same-tile clobber is never reported as done. */
export type CritiqueApplyStatus =
  | "applied" // applied on its own and produced a real change
  | "merged" // combined with an overlapping same-tile fix by the merge model
  | "superseded" // dropped because the author chose a different fix for this conflict
  | "conflict" // in an unresolved same-tile conflict — awaiting an author choice
  | "rolled_back" // dropped by per-tile compile isolation so unrelated fixes survive
  | "no_change"; // applied cleanly but the spec/board was already in the target state

export interface CritiqueApplyResult {
  id: string;
  status: CritiqueApplyStatus;
  tileId?: string;
}

/** A set of selected fixes whose JSON edits overlap on the same tile and which
 * the engine could not auto-merge. The author picks one to keep; re-apply with
 * `conflictChoices[key] = chosenCritiqueId`. */
export interface ApplyConflictGroup {
  /** Stable identity = the group's critique ids sorted and joined by "::". */
  key: string;
  tileId: string;
  critiqueIds: string[];
  /** Why the engine could not resolve it automatically. */
  reason: "no_merge_model" | "merge_failed";
}

export interface ApplyResponse {
  runId: string;
  specMap: SpecMap;
  board: BoardMeta;
  applicationOrder: string[];
  changedTargets: string[];
  recommendationDelta: RecommendationDelta;
  addedCritiques: Critique[];
  evaluationReport: EvaluationReport;
  rollback: { rolledBack: boolean; reason: string | null };
  /** Per-critique honest outcome, so the UI never marks a clobbered fix done. */
  critiqueStatuses: CritiqueApplyResult[];
  /** Same-tile conflicts that need an author choice (empty when none). */
  unresolvedConflicts: ApplyConflictGroup[];
}

/** ---- Dashboard-scoped interaction memory and context inference ---- */

export type InteractionEventKind =
  | "context_saved"
  | "context_note_added"
  | "local_critique_requested"
  | "critique_opened"
  | "preview_viewed"
  | "critique_rationale_added"
  | "critique_rationale_updated"
  | "critique_rationale_removed"
  | "recommendation_accepted"
  | "recommendation_rejected"
  | "changes_applied"
  | "revision_reevaluated"
  | "inferred_context_accepted"
  | "inferred_context_dismissed";

/** A semantic author action. The browser records product decisions rather than
 * raw pointer or keyboard telemetry, keeping the journal useful and legible. */
export interface InteractionEvent {
  id: string;
  kind: InteractionEventKind;
  version: number;
  summary: string;
  detail?: string;
  critiqueId?: string;
  dimension?: Dimension;
  crosscutting?: Crosscutting[];
  proposalKind?: ProposalKind;
  bounds?: Bounds;
  data?: Record<string, unknown>;
}

export type ContextSuggestionField = "goal" | "audience" | "constraints" | "notes";

export interface ContextSuggestion {
  id: string;
  field: ContextSuggestionField;
  text: string;
  rationale: string;
  evidenceEventIds: string[];
  confidence: "tentative" | "supported";
  scope: "dashboard";
  /** Ranking weight (higher = stronger). Derived from the count of strong-signal
   * evidence events plus a bump for "supported" confidence. The backend sorts by
   * it before capping; the client re-sorts the accumulated list by it so the
   * highest-signal suggestions stay surfaced and the rest collapse behind "More". */
  signalStrength: number;
}

export interface PreferenceSynthesisRequest {
  dashboardId?: string;
  context: DashboardContext;
  events: InteractionEvent[];
  /** Previously proposed, accepted, or dismissed text prevents the agent from
   * repeatedly presenting the same inference. */
  resolvedSuggestionTexts?: string[];
}

export interface PreferenceSynthesisResponse {
  suggestions: ContextSuggestion[];
  analyzedEventCount: number;
  source: "llm";
}
