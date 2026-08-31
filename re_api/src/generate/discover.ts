import type {
  BoardMeta,
  Bounds,
  ConflictDrop,
  ConstraintSet,
  Critique,
  Crosscutting,
  DashboardContext,
  Diagnosis,
  DiagnosisOutcome,
  Dimension,
  EvidenceRef,
  Finding,
  FocusedReviewRequest,
  InteractionKind,
  IterationContext,
  JudgmentBasis,
  KpiDefinition,
  KpiLayout,
  KpiStyle,
  LocalCritiqueRegion,
  Priority,
  Proposal,
  ReviewRequestContract,
  ReviewScope,
  SavedCritiqueRationale,
  SpecMap,
  Strength,
  Surface,
} from "../contracts.ts";
import type { LLMClient } from "../llm/client.ts";
import { DASHBOARD_REVIEW_SYSTEM, dashboardReviewSystem, dashboardReviewUser, secondPassDirective } from "./prompts.ts";
import {
  buildContextSnapshot,
  buildEvidencePacket,
  contextStatusForDependencies,
  determineGroundingAvailability,
  evidenceRefForFinding,
  type ContextSnapshot,
  type EvidencePacket,
} from "./evidence.ts";
import { templateText } from "./critique.ts";
import { safeSpecEdits } from "../apply/editSpec.ts";
import {
  lowMaterialityTextAlignmentReason,
  lowMaterialityTextRewriteReason,
} from "./materiality.ts";
import { encodedFieldsDeep } from "../detect/specUtil.ts";
import { hasEmbeddedKpis } from "../detect/kpi.ts";
import { specHasField } from "../detect/filterControl.ts";
import { computeKpis } from "../compute/kpis.ts";
import { repairGuidanceToExecutable } from "./repair.ts";
import { judgeSolutionQuality } from "./solution-quality.ts";
import { filterConflictingCritiques } from "./conflict-filter.ts";
import { applyProposals } from "../apply/index.ts";
import { RECOMMENDATION_BRANCHES, RECOMMENDATION_LEAF_BY_ID } from "./recommendations.ts";
import { dimensionEmphasis, suppressedDetectorsFor } from "./dashboard-type.ts";
import {
  buildReviewRequestContract,
  contractTileIds,
  sanitizeRegionSemanticTargets,
} from "./request-contract.ts";
import {
  CRITERION_REGISTRY_VERSION,
  CONTEXT_DEPENDENCY_LABELS,
  JUDGMENT_BASIS_LABELS,
  REVIEW_ENGINE_VERSION,
  REVIEW_PROMPT_VERSION,
  contextDependenciesForBasis,
  isObjectCode,
  isProblemCode,
  priorWeightFor,
} from "./review-data.ts";

/** The 11 recommendation branches double as the finding/critique `dimension`
 * (a display/grouping label). Selected-region review may carry one as an
 * optional, non-authoritative author hint. */
const BRANCHES = new Set<Dimension>(RECOMMENDATION_BRANCHES);
const PRIORITIES = new Set<Priority>(["high", "medium", "low"]);
const SURFACES = new Set<Surface>(["interaction", "encoding", "structural", "text"]);
const INTERACTIONS = new Set<InteractionKind>(["cross-filter", "hover-tooltip"]);
const OUTCOMES = new Set<DiagnosisOutcome>([
  "evaluated_issue",
  "evaluated_no_issue",
  "not_evaluated_missing_context",
  "out_of_scope",
  "unsupported",
]);
const JUDGMENT_BASES = new Set<JudgmentBasis>(JUDGMENT_BASIS_LABELS);
const CONTEXT_DEPENDENCIES = new Set<string>(CONTEXT_DEPENDENCY_LABELS);
const EXECUTABLE_PROPOSALS = new Set([
  "add-cross-filter",
  "add-tooltip",
  "wire-filter-control",
  "edit-filter-control",
  "add-kpis",
  "recompose-kpis",
  "v2-palette",
  "preserve-brand-palette",
  "dashboard-title",
  "chart-subtitles",
  // The general spec-edit primitive: the executable route for the many
  // component-level catalog fixes that reduce to a Vega-Lite spec change.
  "edit-spec",
  // The board-layout primitive: move/resize tiles (bounds live on the board,
  // not in any spec, so this is the only executable route for a layout change).
  "edit-layout",
]);
const SPEC_PREFLIGHT_PROPOSALS = new Set([
  "edit-spec",
  "add-tooltip",
  "add-cross-filter",
  "v2-palette",
  "preserve-brand-palette",
]);
/** Aggregates a KPI definition may name; mirrors KpiAggregate in contracts.ts. */
const KPI_AGGREGATES = new Set(["count", "sum", "avg", "min", "max", "distinct"]);
const KPI_STYLES = new Set<KpiStyle>(["editorial", "product", "compact", "technical"]);
const KPI_LAYOUTS = new Set<KpiLayout>(["hero-support", "card-grid", "side-rail", "inline-summary"]);
const KPI_ALIGNMENTS = new Set(["start", "center", "end"]);
const KPI_DENSITIES = new Set(["airy", "balanced", "dense"]);
const KPI_CHROME = new Set(["plain", "ruled", "filled"]);
const KPI_FORMATS = new Set(["auto", "compact", "currency", "percent", "percent-fraction", "integer"]);
const LAYOUT_COMPOSITIONS = new Set([
  "hero-left",
  "hero-top",
  "asymmetric-grid",
  "kpi-rail",
  "small-multiples",
]);
const FILTER_PLACEMENTS = new Set([
  "top-row",
  "title-inline",
  "left-rail",
  "right-rail",
  "chart-header",
  "floating",
]);
/** Layout limits mirror apply/index.ts so generation never advertises a change
 * that the apply boundary must reject. */
const MIN_LAYOUT_SIZE = 80;
const MAX_LAYOUT_EXTENT = 6000;
/** The KPI band is a single scannable row; cap authored KPIs so it never
 * overflows into an unreadable strip. */
const MAX_KPIS = 6;
const FALLBACK_EXECUTABLE_PROPOSALS = new Set([
  "add-cross-filter",
  "add-tooltip",
  "wire-filter-control",
  "edit-filter-control",
  "v2-palette",
  "preserve-brand-palette",
  "chart-subtitles",
]);

/** Only process advice is inherently non-executable. `other` means the
 * empirical recommendation catalog had no exact leaf; it may still carry a
 * grounded edit-spec or specialized proposal through the normal safety gates. */
const PROCESS_ONLY_BRANCHES = new Set<Dimension>(["design process"]);
const NO_REF_GUIDANCE_BRANCHES = new Set<Dimension>(["design process", "other"]);

function isAdvisoryCritique(critique: Critique): boolean {
  return PROCESS_ONLY_BRANCHES.has(critique.dimension) ||
    (critique.dimension === "other" && critique.proposal.mode === "guidance_only");
}

/** Guidance-only (workflow / process / uncatalogued reflection) critiques are a
 * legitimate but bounded part of a review. mergeAndRank both RESERVES up to this
 * many slots for them (so a produced-and-validated process critique reaches the
 * author instead of being crowded out by executable fixes) and CAPS them at this
 * many (so relaxed prompt wording cannot let guidance-only prose flood a review).
 * The soft target stated in the prompt (1-3) maps to this number. */
const GUIDANCE_RESERVE = 3;
/** Presentation branches describe what the artifact looks like. A complete
 * review also examines what the data means, what the reader must do/understand,
 * and how the artifact is maintained. These families are used only for recovery
 * and late slot allocation: they never manufacture, admit, or raise the severity
 * of a critique. */
const PRESENTATION_BRANCHES = new Set<Dimension>([
  "chart", "color", "layout", "text", "visual design",
]);
const ANALYTICAL_BRANCHES = new Set<Dimension>([
  "data", "cognition", "context", "interaction", "task",
]);
/** When an eleven-critique full review already contains grounded broader-lens
 * candidates, retain up to four before presentation fixes consume every slot.
 * The reserve is unused when the evidence produced no such candidates. */
const BROADER_LENS_RESERVE = 4;

/** Recommendation branch describes the prescribed remedy, so it can label an
 * encoding fix as `data` (for example, a tighter y-scale prescribed to support
 * valid inference). For breadth we care about the diagnosed SUBJECT, not the
 * remedy label. Prefer the empirical object lens and fall back to dimension only
 * for an object that has no mapping. This prevents cosmetic/encoding work from
 * creating fake non-visual coverage by changing its catalog branch. */
function substantiveLens(item: { object?: string; dimension: Dimension }): Dimension {
  return EMPIRICAL_OBJECT_BRANCH[item.object || ""] || item.dimension;
}

function broaderLensCount(critiques: Critique[]): number {
  return critiques.filter((critique) => !PRESENTATION_BRANCHES.has(substantiveLens(critique))).length;
}

function reviewCoverageNeedsRecovery(critiques: Critique[], strengths: Strength[]): boolean {
  const broaderDimensions = new Set(
    critiques
      .filter((critique) => !PRESENTATION_BRANCHES.has(substantiveLens(critique)))
      .map((critique) => substantiveLens(critique)),
  );
  return critiques.length < 11 ||
    broaderLensCount(critiques) < 3 ||
    broaderDimensions.size < 2 ||
    strengths.length < 1;
}

function coverageRecoveryLimit(critiques: Critique[]): number {
  const missingCount = Math.max(0, 11 - critiques.length);
  const missingBreadth = Math.max(0, BROADER_LENS_RESERVE - broaderLensCount(critiques));
  return Math.max(1, Math.min(6, Math.max(missingCount, missingBreadth)));
}

function strengthSignature(strength: Strength): string {
  const evidence = (strength.evidenceRefs || []).map((ref) => ref.path).sort().join(",");
  return [strength.object, strength.dimension, strength.tileId || "dashboard", evidence, strength.title].join("|");
}

/** Keep positive feedback compact and non-repetitive. In a full review, prefer
 * one broader-lens strength plus one presentation strength when both exist, then
 * fill from the remaining grounded observations. This is selection among real
 * strengths, never a requirement to produce praise. */
function selectStrengths(strengths: Strength[], limit: number): Strength[] {
  const unique: Strength[] = [];
  const signatures = new Set<string>();
  for (const strength of strengths) {
    const signature = strengthSignature(strength);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    unique.push(strength);
  }
  if (unique.length <= limit) return unique;
  const chosen: Strength[] = [];
  const broader = unique.find((strength) => !PRESENTATION_BRANCHES.has(substantiveLens(strength)));
  const presentation = unique.find((strength) => PRESENTATION_BRANCHES.has(substantiveLens(strength)));
  if (broader) chosen.push(broader);
  if (presentation && chosen.length < limit) chosen.push(presentation);
  for (const strength of unique) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(strength)) chosen.push(strength);
  }
  return chosen;
}
/** Detector templates are a reliability safety net, not the review's primary
 * author. When the model produced usable critique content, keep only a small
 * number of uncovered detector gaps so repeated defaults cannot dominate. */
const DETECTOR_SAFETY_NET_LIMIT = 2;
const BRANCH_SET = new Set<string>(RECOMMENDATION_BRANCHES);
const EMPIRICAL_OBJECT_BRANCH: Record<string, Dimension> = {
  component: "visual design",
  chart: "chart",
  color: "color",
  layout: "layout",
  tooltip: "interaction",
  text: "text",
  "visual design": "visual design",
  data: "data",
  metadata: "data",
  performance: "data",
  interaction: "interaction",
  usability: "interaction",
  accessibility: "visual design",
  cognition: "cognition",
  readability: "cognition",
  clarity: "cognition",
  storytelling: "cognition",
  insights: "cognition",
  task: "task",
  "usage context": "context",
  "design process": "design process",
};

/** Route an uncatalogued observation through the empirical structure without
 * requiring an exact leaf. A custom author scope intentionally stays `other`;
 * otherwise a valid requested branch prefix or the closest object lens wins. */
function uncataloguedDimension(
  objectCode: string,
  recommendationId: string,
  snapshot: ContextSnapshot,
): Dimension {
  const scopes = Array.isArray(snapshot.values.scope) ? snapshot.values.scope : [];
  if (scopes.some((scope) => typeof scope === "string" && scope.startsWith("custom:"))) return "other";
  const branch = recommendationId.includes(":") ? recommendationId.slice(0, recommendationId.indexOf(":")) : "";
  if (BRANCH_SET.has(branch)) return branch as Dimension;
  return EMPIRICAL_OBJECT_BRANCH[objectCode] || "other";
}

/** A proper subset of the standard Feedback Scope is an author filter, not a
 * ranking hint. Missing/empty scope remains the legacy "full review" default;
 * an explicitly narrowed set is returned even when it contains only custom
 * scopes (an empty standard set), so standard branches cannot leak back in. */
function narrowedFeedbackScope(context: DashboardContext): Set<Dimension> | null {
  if (!Array.isArray(context.scope) || context.scope.length === 0) return null;
  const selected = new Set(
    context.scope.filter((scope): scope is Dimension => BRANCHES.has(scope as Dimension)),
  );
  const hasCustomScope = context.scope.some((scope) => String(scope).startsWith("custom:"));
  // Custom scopes are encoded through the contract's "other" dimension.
  if (hasCustomScope) selected.add("other");
  return selected.size === RECOMMENDATION_BRANCHES.length && !hasCustomScope ? null : selected;
}

/** Deterministic detector findings map to a canonical DIAGNOSING pair and a
 * prescribed recommendation leaf. The leaf's branch supplies the critique
 * `dimension`; the object need not match that branch. */
interface DetectorDiagnosisMapping {
  object: string;
  problem?: string;
  recommendation: string;
}
const DETECTOR_DIAGNOSIS: Record<string, DetectorDiagnosisMapping> = {
  "cross-filter-gap": {
    object: "interaction",
    problem: "limited affordance",
    recommendation: "interaction:support exploration and detail access",
  },
  "missing-tooltip": {
    object: "tooltip",
    problem: "missing | absent | unsupported",
    recommendation: "interaction:support exploration and detail access",
  },
  "ineffective-filter-control": {
    object: "interaction",
    problem: "limited affordance",
    recommendation: "interaction:support exploration and detail access",
  },
  "missing-kpi": {
    object: "data",
    problem: "missing | absent | unsupported",
    recommendation: "data:summarize key information",
  },
  "uniform-palette": {
    object: "color",
    problem: "inconsistent | mismatched",
    recommendation: "color:encode and distinguish meaning",
  },
  "preserve-brand": {
    object: "color",
    recommendation: "color:keep color consistent",
  },
  "generic-title": {
    object: "text",
    problem: "unclear | ambiguous",
    recommendation: "text:communicate takeaways",
  },
  "missing-subtitles": {
    object: "text",
    problem: "missing | absent | unsupported",
    recommendation: "text:support interpretation and analysis",
  },
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length >= 3 ? value.trim() : null;
}

/** Stable key for a diagnosed object (optionally with a problem). */
function comboKey(objectCode: string, problemCode?: string): string {
  return `${objectCode}|${problemCode ?? ""}`;
}

function finiteBounds(value: unknown): Bounds | null {
  const raw = object(value);
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1) return null;
  return {
    x: Math.round(Math.max(0, x)),
    y: Math.round(Math.max(0, y)),
    w: Math.round(w),
    h: Math.round(h),
  };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Selected-region review keeps the common engine but narrows its evidence. */
export function scopeLocalReviewInput(
  specMap: SpecMap,
  board: BoardMeta | undefined,
  region: LocalCritiqueRegion | undefined,
): { specMap: SpecMap; board: BoardMeta | undefined; region: LocalCritiqueRegion | undefined } {
  if (!region) return { specMap, board, region: undefined };
  const bounds = finiteBounds(region.bounds);
  const request = text(region.request)?.slice(0, 600);
  if (!bounds || !request) throw new Error("LOCAL_REVIEW_INVALID: select an area and enter a review request");
  const dimension = BRANCHES.has(region.dimension as Dimension) ? region.dimension as Dimension : undefined;
  const semanticTargets = sanitizeRegionSemanticTargets(region.semanticTargets, specMap, board);
  const requestContract = buildReviewRequestContract(request, semanticTargets);
  const normalizedRegion: LocalCritiqueRegion = {
    bounds,
    request,
    ...(dimension ? { dimension } : {}),
    ...(semanticTargets.length ? { semanticTargets } : {}),
    requestContract,
  };
  const boundedTiles = (board?.tiles || []).filter((tile) => finiteBounds(tile.bounds));
  if (!boundedTiles.length) return { specMap, board, region: normalizedRegion };
  const matchingIds = new Set(
    boundedTiles.filter((tile) => intersects(bounds, finiteBounds(tile.bounds)!)).map((tile) => tile.id),
  );
  for (const tileId of contractTileIds(requestContract)) matchingIds.add(tileId);
  return {
    specMap: Object.fromEntries(Object.entries(specMap).filter(([tileId]) => matchingIds.has(tileId))),
    board: board ? { ...board, tiles: (board.tiles || []).filter((tile) => matchingIds.has(tile.id)) } : board,
    region: normalizedRegion,
  };
}

export function normalizeFocusedReview(
  focus: FocusedReviewRequest | undefined,
  specMap?: SpecMap,
  board?: BoardMeta,
): FocusedReviewRequest | undefined {
  if (!focus) return undefined;
  const request = text(focus.request)?.replace(/\s+/g, " ").slice(0, 600);
  if (!request) throw new Error("FOCUSED_REVIEW_INVALID: enter a specific review question");
  const purpose = focus.purpose === "stale-refresh" || focus.purpose === "solution-refinement"
    ? focus.purpose
    : "author-request";
  const requestContract = buildReviewRequestContract(request);
  // Focused requests do not carry the browser's selected-region semantic hits.
  // Resolve explicitly named chart titles, tile ids, and filter labels against
  // the current board so the acceptance gate checks the component the author
  // actually named (for example, "Bird filter" → board.filters.bird-filter).
  if (!requestContract.targetPaths.length && specMap) {
    const normalizedRequest = request.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const namedTileIds = new Set<string>();
    for (const tileId of Object.keys(specMap)) {
      const normalizedId = tileId.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (normalizedId && normalizedRequest.includes(normalizedId)) namedTileIds.add(tileId);
    }
    for (const tile of board?.tiles || []) {
      const normalizedTitle = String(tile.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (normalizedTitle && normalizedRequest.includes(normalizedTitle)) namedTileIds.add(tile.id);
    }
    if (namedTileIds.size) {
      requestContract.targetPaths = [...namedTileIds].slice(0, 12).map((id) => `tile.${id}`);
      requestContract.targetKinds = ["tile", "chart"];
    }
    if (!requestContract.targetPaths.length && /\b(filter|control|dropdown|selector)\b/i.test(request)) {
      const namedFilters = (board?.filters || []).filter((filter) => {
        const normalizedId = filter.id.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const normalizedLabel = filter.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        return (normalizedId && normalizedRequest.includes(normalizedId)) ||
          (normalizedLabel && normalizedRequest.includes(normalizedLabel));
      });
      if (namedFilters.length === 1) {
        requestContract.targetPaths = [`board.filters.${namedFilters[0].id}`];
        requestContract.targetKinds = ["filter-control"];
      }
    }
  }
  // A stale-card refresh quotes the old suggestion so the model can reassess
  // it. That quoted verb is not a new author instruction and must not bypass
  // materiality checks or force the old solution to be regenerated.
  if (purpose === "stale-refresh") {
    requestContract.explicitChange = false;
    requestContract.actions = ["evaluate"];
    requestContract.successCriteria = [
      "Re-evaluate whether the previously identified issue is still material in the current dashboard.",
    ];
  }
  return { request, purpose, requestContract };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

function exactTile(value: unknown, tileIds: Set<string>): string | null {
  return typeof value === "string" && tileIds.has(value) ? value : null;
}

function specContainsField(value: unknown, field: string): boolean {
  if (Array.isArray(value)) return value.some((item) => specContainsField(item, field));
  if (!value || typeof value !== "object") return false;
  const record = value as JsonObject;
  if (record.field === field || Object.prototype.hasOwnProperty.call(record, field)) return true;
  return Object.values(record).some((item) => specContainsField(item, field));
}

function specContainsChannel(value: unknown, channel: string): boolean {
  if (Array.isArray(value)) return value.some((item) => specContainsChannel(item, channel));
  if (!value || typeof value !== "object") return false;
  const record = value as JsonObject;
  const encoding = object(record.encoding);
  if (Object.prototype.hasOwnProperty.call(encoding, channel)) return true;
  return Object.values(record).some((item) => specContainsChannel(item, channel));
}

function nestedValue(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function dashboardValueAtPath(path: string, packet: EvidencePacket): unknown {
  if (path.startsWith("tile.")) {
    const tileId = Object.keys(packet.specMap).find((id) => path === `tile.${id}` || path.startsWith(`tile.${id}.`));
    if (!tileId) return undefined;
    const suffix = path === `tile.${tileId}` ? [] : path.slice(`tile.${tileId}.`.length).split(".");
    return suffix.length ? nestedValue(packet.specMap[tileId], suffix) : packet.specMap[tileId];
  }
  if (path.startsWith("board.tiles.")) {
    const tile = (packet.board.tiles || []).find((candidate) => path === `board.tiles.${candidate.id}` || path.startsWith(`board.tiles.${candidate.id}.`));
    if (!tile) return undefined;
    const prefix = `board.tiles.${tile.id}`;
    const suffix = path === prefix ? [] : path.slice(prefix.length + 1).split(".");
    return suffix.length ? nestedValue(tile, suffix) : tile;
  }
  if (path.startsWith("board.")) return nestedValue(packet.board, path.slice("board.".length).split("."));
  return undefined;
}

function evidenceDetail(path: string, value: unknown): string {
  if (value && typeof value === "object") {
    const encoded = JSON.stringify(value);
    return `${path} = ${encoded.length > 220 ? `${encoded.slice(0, 217)}...` : encoded}`;
  }
  return `${path} = ${JSON.stringify(value)}`;
}

function canonicalEvidencePath(
  rawPath: string,
  source: unknown,
  packet: EvidencePacket,
): string {
  if (source === "context") {
    const contextMatch = rawPath.match(/^(?:values|context)\.(goal|audience|constraints|notes|customTypes)$/);
    return contextMatch ? `context.${contextMatch[1]}` : rawPath;
  }
  if (source !== "dashboard") return rawPath;
  if (["title", "subtitle", "typography", "hasKpis", "hasEmbeddedKpis", "kpiStyle", "kpiLayout", "filters", "tiles"].includes(rawPath)) {
    return `board.${rawPath}`;
  }
  const indexedTile = rawPath.match(/^tiles\[(\d+)](?:\.(.+))?$/);
  if (indexedTile) {
    const tile = (packet.board.tiles || [])[Number(indexedTile[1])];
    if (tile) return `board.tiles.${tile.id}${indexedTile[2] ? `.${indexedTile[2]}` : ""}`;
  }
  const tileId = Object.keys(packet.specMap).find((id) => rawPath === id || rawPath.startsWith(`${id}.`));
  return tileId ? `tile.${rawPath}` : rawPath;
}

function validateEvidenceRef(
  value: unknown,
  packet: EvidencePacket,
  snapshot: ContextSnapshot,
): EvidenceRef | null {
  const raw = object(value);
  const source = raw.source;
  const suppliedPath = text(raw.path);
  const detail = text(raw.detail);
  if (!suppliedPath || !detail || !["dashboard", "context", "interaction", "detector"].includes(String(source))) return null;
  const path = canonicalEvidencePath(suppliedPath, source, packet);
  const tileIds = new Set(Object.keys(packet.specMap));
  const tileId = raw.tileId === undefined ? undefined : exactTile(raw.tileId, tileIds) || undefined;
  if (raw.tileId !== undefined && !tileId) return null;
  const field = typeof raw.field === "string" && raw.field.trim() ? raw.field.trim() : undefined;
  const channel = typeof raw.channel === "string" && raw.channel.trim() ? raw.channel.trim() : undefined;

  if (source === "detector") {
    const findingId = typeof raw.findingId === "string" ? raw.findingId : path.replace(/^finding\./, "");
    const canonical = packet.detectorEvidence.find((ref) => ref.findingId === findingId);
    return canonical || null;
  }
  if (source === "dashboard") {
    if (!path.startsWith("board.") && !path.startsWith("tile.")) return null;
    const pathTile = [...tileIds].find((id) => path === `tile.${id}` || path.startsWith(`tile.${id}.`));
    if (path.startsWith("tile.") && !pathTile) return null;
    if (path.startsWith("board.")) {
      const boardPathIsValid = [
        "board.title",
        "board.subtitle",
        "board.typography",
        "board.hasKpis",
        "board.hasEmbeddedKpis",
        "board.kpiStyle",
        "board.kpiLayout",
        "board.filters",
        "board.tiles",
      ].includes(path) ||
        (packet.board.tiles || []).some((tile) => path === `board.tiles.${tile.id}` || path.startsWith(`board.tiles.${tile.id}.`));
      if (!boardPathIsValid) return null;
    }
    if (field) {
      const resolvedTile = tileId || pathTile;
      const candidates = resolvedTile ? [packet.specMap[resolvedTile]] : Object.values(packet.specMap);
      if (!candidates.some((spec) => specContainsField(spec, field))) return null;
    }
    if (channel) {
      const resolvedTile = tileId || pathTile;
      const candidates = resolvedTile ? [packet.specMap[resolvedTile]] : Object.values(packet.specMap);
      if (!candidates.some((spec) => specContainsChannel(spec, channel))) return null;
    }
    const resolvedValue = dashboardValueAtPath(path, packet);
    if (resolvedValue === undefined) return null;
    return {
      source: "dashboard",
      path,
      detail: evidenceDetail(path, resolvedValue),
      ...(tileId || pathTile ? { tileId: tileId || pathTile } : {}),
      ...(field ? { field } : {}),
      ...(channel ? { channel } : {}),
    };
  }
  if (source === "context") {
    const fieldName = path.replace(/^context\./, "").split(".")[0];
    if (!["goal", "audience", "constraints", "notes", "customTypes"].includes(fieldName)) return null;
    if (path !== `context.${fieldName}`) return null;
    const contextValue = snapshot.values[fieldName as keyof DashboardContext];
    if (contextValue === undefined || contextValue === "" || (Array.isArray(contextValue) && !contextValue.length)) return null;
    return { source: "context", path, detail: evidenceDetail(path, contextValue) };
  }
  if (source === "interaction") {
    const key = path.replace(/^interaction\./, "").split(".")[0];
    if (!path.startsWith("interaction.") || !Object.prototype.hasOwnProperty.call(packet.interactionState, key)) return null;
    const interactionValue = nestedValue(packet.interactionState, path.slice("interaction.".length).split("."));
    if (interactionValue === undefined) return null;
    return { source: "interaction", path, detail: evidenceDetail(path, interactionValue) };
  }
  return {
    source: source as EvidenceRef["source"],
    path,
    detail,
    ...(tileId ? { tileId } : {}),
    ...(field ? { field } : {}),
    ...(channel ? { channel } : {}),
  };
}

function validateRefs(
  value: unknown,
  packet: EvidencePacket,
  snapshot: ContextSnapshot,
): EvidenceRef[] {
  return Array.isArray(value)
    ? value.map((ref) => validateEvidenceRef(ref, packet, snapshot)).filter((ref): ref is EvidenceRef => Boolean(ref))
    : [];
}

/** ---- Numeric grounding of author-facing prose ----
 *
 * The evidence-ref gate proves a cited PATH resolves; it never checks that a
 * figure STATED in the prose matches the data. So a critique can cite a real
 * path yet assert "$733K Total Sales" when the real total is $788K — the exact
 * class of fabrication observed in a shipped dashboard. This adds the numeric
 * half of the grounding gate, precision-first: only well-delimited, high-signal
 * quantitative claims are policed, and a critique is rejected only when such a
 * figure reconciles with NOTHING in its own tile(s)' real data. Percentages
 * (usually derived deltas the engine cannot reconstruct without the scope),
 * years, and small integers (structural counts like "3 charts") are exempt. */

/** Numeric magnitudes achievable from a tile's real inline data by any standard
 * aggregate: every row value plus each numeric field's sum / avg / min / max and
 * the row count. A prose figure that matches one of these (within tolerance) is
 * grounded; one that matches none is fabricated. */
function numericUniverse(specMap: SpecMap, tileIds: string[]): number[] {
  const out: number[] = [];
  for (const id of new Set(tileIds)) {
    const values = (specMap[id]?.data as Record<string, unknown> | undefined)?.values;
    if (!Array.isArray(values)) continue;
    out.push(values.length); // a bare row count is a real, citable figure
    const byField = new Map<string, number[]>();
    for (const row of values as Record<string, unknown>[]) {
      if (!row || typeof row !== "object") continue;
      for (const [field, raw] of Object.entries(row)) {
        let n: number | null = null;
        if (typeof raw === "number" && Number.isFinite(raw)) n = raw;
        else if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw.trim()))) n = Number(raw.trim());
        if (n === null) continue;
        if (!byField.has(field)) byField.set(field, []);
        byField.get(field)!.push(n);
      }
    }
    for (const nums of byField.values()) {
      if (!nums.length) continue;
      const sum = nums.reduce((a, b) => a + b, 0);
      out.push(...nums, sum, sum / nums.length,
        nums.reduce((a, b) => (b < a ? b : a), nums[0]),
        nums.reduce((a, b) => (b > a ? b : a), nums[0]));
    }
  }
  return out;
}

/** The absolute quantities in prose that must be backed by real data: currency
 * amounts of at least 1,000, and counts of at least 100 bound to a data noun
 * ("14,556 units", "238 days"). K/M/B suffixes are expanded. Percentages, bare
 * years, and small structural counts are deliberately NOT matched. */
function policedFigures(prose: string): number[] {
  const figures: number[] = [];
  const scale = (suffix: string) => suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1;
  const toNumber = (digits: string, suffix: string) => Number(digits.replace(/,/g, "")) * scale(suffix.toUpperCase());
  const currency = /-?\$\s?(-?[\d,]+(?:\.\d+)?)\s?([KMB])?/gi;
  for (const m of prose.matchAll(currency)) {
    const sign = m[0].trimStart().startsWith("-") ? -1 : 1;
    const value = sign * toNumber(m[1], m[2] || "");
    if (Math.abs(value) >= 1000) figures.push(value);
  }
  const countNoun = /(-?[\d,]+(?:\.\d+)?)\s?([KMB])?\s+(?:days|units|rows|records|items|orders|customers|users|products|tasks|projects|tickets|events|sessions|visits|transactions|sales)\b/gi;
  for (const m of prose.matchAll(countNoun)) {
    // A "%" immediately before the noun is a percentage, not a raw count.
    const value = toNumber(m[1], (m[2] || ""));
    if (Math.abs(value) >= 100) figures.push(value);
  }
  return figures;
}

/** Whether a prose figure reconciles with some real data magnitude, within a
 * tolerance that absorbs K/M rounding ("$788K" for 788,122) yet still rejects a
 * genuinely wrong total ("$733K" is 7% off). */
function figureReconciles(figure: number, universe: number[]): boolean {
  const tolerance = Math.max(Math.abs(figure) * 0.03, 0.5);
  return universe.some((value) => Math.abs(value - figure) <= tolerance);
}

/** Precision-first numeric grounding: false only when a policed figure in the
 * prose matches nothing in the tile data (and there IS numeric data to check
 * against). Missing data ⇒ nothing to verify ⇒ not rejected. */
export function proseFiguresAreGrounded(prose: string, tileIds: string[], specMap: SpecMap): boolean {
  const figures = policedFigures(prose);
  if (!figures.length) return true;
  const universe = numericUniverse(specMap, tileIds);
  if (!universe.length) return true; // no inline data to verify against
  return figures.every((figure) => figureReconciles(figure, universe));
}

function judgmentBases(value: unknown): JudgmentBasis[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is JudgmentBasis => JUDGMENT_BASES.has(item as JudgmentBasis)))];
}

function parseCrosscutting(value: unknown): Crosscutting[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is Crosscutting => item === "accessibility"))];
}

function declaredContextDependencies(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && CONTEXT_DEPENDENCIES.has(item))
    : [];
}

/** Uniform grounding gate: a basis is admitted only when the cited evidence
 * actually supports it. "general design principle" is warranted by the
 * diagnosis itself; every other label needs its evidence. */
function basisIsSupported(
  basis: JudgmentBasis,
  refs: EvidenceRef[],
  snapshot: ContextSnapshot,
): boolean {
  if (basis === "dashboard evidence") return refs.some((ref) => ref.source === "dashboard" || ref.source === "detector" || ref.source === "interaction");
  if (basis === "analytical task") return Boolean(snapshot.values.goal) && refs.some((ref) => ref.path.startsWith("context.goal"));
  if (basis === "audience") return Boolean(snapshot.values.audience) && refs.some((ref) => ref.path.startsWith("context.audience"));
  if (basis === "author constraint") return Boolean(snapshot.values.constraints) && refs.some((ref) => ref.path.startsWith("context.constraints"));
  if (basis === "personal preference") {
    const contextText = [snapshot.values.constraints, ...(snapshot.values.notes || [])].filter(Boolean).join(" ");
    return /\b(prefer|preference|personally|i like|i want)\b/i.test(contextText) && refs.some((ref) => ref.source === "context");
  }
  return true; // a general design principle is warranted by the diagnosis itself
}

function supportedJudgmentBases(
  bases: JudgmentBasis[],
  refs: EvidenceRef[],
  snapshot: ContextSnapshot,
): JudgmentBasis[] {
  return bases.filter((basis) => basisIsSupported(basis, refs, snapshot));
}

function dependenciesForBases(bases: JudgmentBasis[]): string[] {
  return bases.flatMap(contextDependenciesForBasis);
}

function parseDiagnosis(
  value: unknown,
  packet: EvidencePacket,
  snapshot: ContextSnapshot,
  critiqueCandidates: unknown[] = [],
): Diagnosis | null {
  const raw = object(value);
  if (!isObjectCode(raw.object)) return null;
  const objectCode = raw.object as string;
  const problemCode = isProblemCode(raw.problem) ? raw.problem as string : undefined;
  const outcome = OUTCOMES.has(raw.outcome as DiagnosisOutcome) ? raw.outcome as DiagnosisOutcome : null;
  if (!outcome) return null;
  const rationale = text(raw.rationale);
  if (!rationale) return null;
  const priorWeight = priorWeightFor(objectCode, problemCode);

  if (outcome === "not_evaluated_missing_context") {
    const declaredDependencies = declaredContextDependencies(raw.requiredContext);
    const status = contextStatusForDependencies(declaredDependencies, snapshot);
    return {
      object: objectCode,
      ...(problemCode ? { problem: problemCode } : {}),
      outcome,
      judgmentBasis: [],
      priorWeight,
      requiredContext: status.missingContext.length ? status.missingContext : declaredDependencies,
      contextStatus: "missing",
      evidenceRefs: [],
      rationale,
    };
  }
  if (outcome === "out_of_scope" || outcome === "unsupported") {
    return {
      object: objectCode,
      ...(problemCode ? { problem: problemCode } : {}),
      outcome,
      judgmentBasis: [],
      priorWeight,
      requiredContext: [],
      contextStatus: "not_applicable",
      evidenceRefs: [],
      rationale,
    };
  }

  // evaluated_issue | evaluated_no_issue: must satisfy the grounding gate.
  const declaredRefs = validateRefs(raw.evidenceRefs, packet, snapshot);
  const matchingCritiques = critiqueCandidates.map(object).filter((candidate) => {
    if (!isObjectCode(candidate.object) || candidate.object !== objectCode) return false;
    const candidateProblem = isProblemCode(candidate.problem) ? candidate.problem as string : undefined;
    return candidateProblem === problemCode;
  });
  const critiqueRefs = matchingCritiques.flatMap((candidate) => validateRefs(candidate.evidenceRefs, packet, snapshot));
  const validatedRefs = declaredRefs.length ? declaredRefs : critiqueRefs;
  const candidateBases = [...new Set([
    ...judgmentBases(raw.judgmentBasis),
    ...matchingCritiques.flatMap((candidate) => judgmentBases(candidate.judgmentBasis)),
  ])];
  const bases = supportedJudgmentBases(candidateBases, validatedRefs, snapshot);
  const requiredContext = [...new Set(dependenciesForBases(bases))];
  const contextStatus = contextStatusForDependencies(requiredContext, snapshot).contextStatus;
  if (!validatedRefs.length || !bases.length) return null;
  return {
    object: objectCode,
    ...(problemCode ? { problem: problemCode } : {}),
    outcome,
    judgmentBasis: bases,
    priorWeight,
    requiredContext,
    contextStatus,
    evidenceRefs: validatedRefs,
    rationale,
  };
}

/** Validate one standout POSITIVE observation. A strength is admitted under the
 * SAME grounding gate as a diagnosis: it must name a real object, cite at least
 * one resolvable evidenceRef, and rest on at least one supported grounding
 * label. `title` (the one-sentence positive takeaway) and `detail` (the concise
 * concrete-evidence line) are author-facing copy, capped defensively so a stray
 * long response can never dominate the card. `dimension` is the topic group the
 * positive card sits under in the critique list — accepted when it is one of the
 * catalog branches, else defaulted to "other"; it is a presentation grouping
 * tag, never a drop reason. Ungrounded praise is dropped — honesty is enforced
 * by the gate, not by prompt discipline alone. Produced independently of
 * critiques, so it can survive with zero critiques. */
function validateStrength(
  value: unknown,
  index: number,
  packet: EvidencePacket,
  snapshot: ContextSnapshot,
  reviewScope: ReviewScope,
): Strength | null {
  const raw = object(value);
  if (!isObjectCode(raw.object)) return null;
  const objectCode = raw.object as string;
  const title = text(raw.title);
  const detail = text(raw.detail);
  if (!title || !detail) return null;

  const tileIds = new Set(Object.keys(packet.specMap));
  const tileId = raw.tileId === null || raw.tileId === undefined ? null : exactTile(raw.tileId, tileIds);
  if (raw.tileId !== null && raw.tileId !== undefined && !tileId) return null;

  const validatedRefs = validateRefs(raw.evidenceRefs, packet, snapshot);
  const bases = supportedJudgmentBases(judgmentBases(raw.judgmentBasis), validatedRefs, snapshot);
  if (!validatedRefs.length || !bases.length) return null; // uniform grounding gate

  // Grouping tag for the positive card. "other" and any unrecognized value fall
  // through to "other"; never gates admission.
  const dimension: Dimension = BRANCHES.has(raw.dimension as Dimension) ? (raw.dimension as Dimension) : "other";

  return {
    id: `strength-${index + 1}-${slug(title) || objectCode}`,
    object: objectCode,
    dimension,
    tileId,
    title: title.slice(0, 120),
    detail: detail.slice(0, 180),
    judgmentBasis: bases,
    evidenceRefs: validatedRefs,
    reviewScope,
  };
}

/**
 * Canonical string for deep structural equality: object keys sorted recursively,
 * array order preserved (edit order can be semantically meaningful for
 * overlapping paths, so only object-internal key order is normalized). Used to
 * compare an edit-spec's `edits` across tiles for cross-tile consolidation —
 * naive JSON.stringify is unsound here because the model copies each edit's
 * `value` payload verbatim, so two identical fixes can differ only in key order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** When a proposal's kind label is not one we execute, infer the executable
 * primitive from the payload the model actually supplied. The kind string is a
 * routing hint, not a gate — a model that names an ad-hoc verb ("change-mark",
 * "reorder-axis", "annotate") but carries real edits/layout/kpis/palette is
 * proposing an executable fix, and discarding it as guidance is a prime source
 * of homogenized reviews. Order favors the most general component-scoped route.
 * Returns "manual" when no executable payload is present (genuine guidance). The
 * inferred kind is still fully re-sanitized downstream, so this bypasses no
 * safety gate: an inferred edit-spec whose edits don't sanitize still degrades. */
function inferKindFromPayload(proposalRaw: JsonObject): string {
  if (Array.isArray(proposalRaw.edits) && proposalRaw.edits.length) return "edit-spec";
  if (typeof proposalRaw.filterId === "string" &&
      (typeof proposalRaw.filterPlacement === "string" || proposalRaw.filterPosition)) {
    return "edit-filter-control";
  }
  if (Array.isArray(proposalRaw.layout) && proposalRaw.layout.length) return "edit-layout";
  if (typeof proposalRaw.composition === "string") return "edit-layout";
  if (Array.isArray(proposalRaw.kpis) && proposalRaw.kpis.length) return "add-kpis";
  if (Array.isArray(proposalRaw.palette) && proposalRaw.palette.length) return "v2-palette";
  return "manual";
}

export function validatedProposal(raw: JsonObject, tileId: string | null, packet: EvidencePacket): { proposal: Proposal; ref: JsonObject } {
  const tileIds = new Set(Object.keys(packet.specMap));
  const proposalRaw = object(raw.proposal);
  const requestedKind = typeof proposalRaw.kind === "string" ? proposalRaw.kind : "manual";
  let kind = EXECUTABLE_PROPOSALS.has(requestedKind) ? requestedKind : inferKindFromPayload(proposalRaw);
  const rawRef = object(object(raw.target).ref);
  const ref: JsonObject = {};
  const tile = exactTile(rawRef.tile, tileIds) || tileId;
  if (tile) ref.tile = tile;
  if (kind === "add-cross-filter") {
    let source = exactTile(rawRef.source, tileIds);
    let targets = Array.isArray(rawRef.targets)
      ? rawRef.targets.map((item) => exactTile(item, tileIds)).filter((item): item is string => Boolean(item))
      : [];
    let field = text(rawRef.field);
    const suppliedCrossFilterRef = rawRef.source !== undefined ||
      rawRef.targets !== undefined ||
      rawRef.field !== undefined;
    if (!suppliedCrossFilterRef) {
      const matches = packet.detectorFindings.filter((finding) =>
        finding.proposalKind === "add-cross-filter" &&
        (
          !tileId ||
          finding.tileId === tileId ||
          object(finding.target.ref).source === tileId
        )
      );
      if (matches.length === 1) {
        const canonical = object(matches[0].target.ref);
        source = exactTile(canonical.source, tileIds);
        targets = Array.isArray(canonical.targets)
          ? canonical.targets.map((item) => exactTile(item, tileIds)).filter((item): item is string => Boolean(item))
          : [];
        field = text(canonical.field);
      }
    }
    const shared = Boolean(
      source &&
      field &&
      specContainsField(packet.specMap[source], field) &&
      targets.length &&
      targets.every((target) => specContainsField(packet.specMap[target], field)),
    );
    if (!shared) kind = "manual";
    else Object.assign(ref, { source, targets: [...new Set(targets)], field });
  }
  if (kind === "add-tooltip") {
    // add-tooltip is executable only when the primary tile has a field to surface
    // on hover. Fields are counted DEEP (encodedFieldsDeep), because a real tile is
    // often a composed spec — a KPI sparkline built from vconcat/layer units — whose
    // encoding lives in the leaf units, not at the top level; applyTooltip tooltips
    // those units. A tile with no field anywhere (a literal-value text/number KPI)
    // would no-op at apply time, so — like edit-spec/add-kpis/edit-layout below —
    // degrade it to guidance rather than present an executable that throws
    // APPLY_NO_CHANGE on accept or (as a consolidation representative) lists a tile
    // it cannot fix.
    if (!tile || encodedFieldsDeep(packet.specMap[tile]).length === 0) {
      kind = "manual";
    } else if (Array.isArray(rawRef.tiles)) {
      // Cross-tile consolidation (model-obeys path): add-tooltip is tile-portable
      // — apply derives each tile's tooltip from its own encoded fields — so when
      // the model names several tiles for the SAME hover fix, keep the primary
      // plus every named sibling that actually has fields to surface (deep, so a
      // composed sibling is not wrongly excluded). A merged card must never claim a
      // tile it cannot fix. Degenerate sets (≤1 tile) omit ref.tiles so the critique
      // behaves as a normal single-tile one.
      const requested = rawRef.tiles
        .map((item) => exactTile(item, tileIds))
        .filter((item): item is string => Boolean(item));
      const consolidatedTiles = [...new Set([tile, ...requested])].filter(
        (candidate) => candidate === tile || encodedFieldsDeep(packet.specMap[candidate]).length > 0,
      );
      if (consolidatedTiles.length > 1) ref.tiles = consolidatedTiles;
    }
  }
  // edit-spec is the general executable route: it needs a real tile and at
  // least one edit that survives sanitization against that tile's own fields
  // (no fabricated data/fields, no engine-owned coordination). Sanitized edits
  // ride on the proposal so /apply re-applies exactly what was validated.
  let sanitizedEdits: ReturnType<typeof safeSpecEdits> = [];
  if (kind === "edit-spec") {
    const editTile = tile && tileIds.has(tile) ? tile : null;
    sanitizedEdits = editTile ? safeSpecEdits(packet.specMap[editTile], proposalRaw.edits) : [];
    if (!editTile || !sanitizedEdits.length) kind = "manual";
    else {
      ref.tile = editTile;
      // Cross-tile consolidation (model-obeys path): when the model names several
      // tiles for the SAME fix, keep those where the identical edits sanitize to
      // the same canonical result as the representative tile. This gate is safety
      // (no fabricated fields), not suitability — a field-free edit like labelAngle
      // sanitizes on any tile with that encoding; the model owns the judgment that
      // the fix belongs there, since it named the tiles. Degenerate sets (≤1 tile)
      // omit ref.tiles so the critique behaves as a normal single-tile one.
      const canonicalPrimary = canonicalJson(sanitizedEdits);
      const requested = Array.isArray(rawRef.tiles)
        ? rawRef.tiles.map((item) => exactTile(item, tileIds)).filter((item): item is string => Boolean(item))
        : [];
      const consolidatedTiles = [...new Set([editTile, ...requested])].filter((candidate) => {
        if (candidate === editTile) return true;
        const edits = safeSpecEdits(packet.specMap[candidate], proposalRaw.edits);
        return edits.length > 0 && canonicalJson(edits) === canonicalPrimary;
      });
      if (consolidatedTiles.length > 1) ref.tiles = consolidatedTiles;
    }
  }
  // edit-layout carries model-proposed new bounds for one or more REAL tiles.
  // Keep only well-formed, non-degenerate boxes for tiles that exist; if none
  // survive there is nothing to move, so it degrades to guidance.
  let sanitizedLayout: Array<{ tile: string; bounds: Bounds }> = [];
  let sanitizedComposition: Proposal["composition"];
  let sanitizedLayoutTiles: string[] = [];
  let sanitizedHeroTileId: string | undefined;
  if (kind === "edit-layout") {
    const boundsById = new Map(
      (packet.board?.tiles || []).map((tile) => [tile.id, finiteBounds(tile.bounds)]),
    );
    const rawLayout = Array.isArray(proposalRaw.layout) ? proposalRaw.layout : [];
    for (const entry of rawLayout) {
      const record = object(entry);
      const layoutTile = exactTile(record.tile, tileIds);
      const bounds = finiteBounds(record.bounds);
      if (!layoutTile || !bounds) continue;
      if (bounds.x < 0 || bounds.y < 0 || bounds.w < MIN_LAYOUT_SIZE || bounds.h < MIN_LAYOUT_SIZE) continue;
      if (bounds.x + bounds.w > MAX_LAYOUT_EXTENT || bounds.y + bounds.h > MAX_LAYOUT_EXTENT) continue;
      // A box that merely restates the tile's current position moves nothing.
      // applyLayout ignores identical boxes (apply/index.ts), so admitting one
      // here would present an "executable" fix that throws APPLY_NO_CHANGE on
      // Accept — the "accept has no effect" symptom. Drop no-op entries.
      const current = boundsById.get(layoutTile);
      if (!current) continue;
      if (current && current.x === bounds.x && current.y === bounds.y &&
        current.w === bounds.w && current.h === bounds.h) continue;
      sanitizedLayout.push({ tile: layoutTile, bounds });
    }
    if (sanitizedLayout.length) {
      const proposed = new Map(boundsById);
      for (const entry of sanitizedLayout) proposed.set(entry.tile, entry.bounds);
      const boxes = [...proposed.values()].filter((bounds): bounds is Bounds => Boolean(bounds));
      const overlaps = boxes.some((box, index) =>
        boxes.slice(index + 1).some((other) => intersects(box, other)));
      if (overlaps) sanitizedLayout = [];
    }
    if (typeof proposalRaw.composition === "string" &&
        LAYOUT_COMPOSITIONS.has(proposalRaw.composition)) {
      sanitizedComposition = proposalRaw.composition as Proposal["composition"];
      const requestedTiles = Array.isArray(proposalRaw.layoutTiles)
        ? proposalRaw.layoutTiles.map((item) => exactTile(item, tileIds)).filter((item): item is string => Boolean(item))
        : [];
      sanitizedLayoutTiles = [...new Set(requestedTiles.length ? requestedTiles : [...tileIds])];
      sanitizedHeroTileId = exactTile(proposalRaw.heroTileId, tileIds) || undefined;
      const boardTileIds = (packet.board.tiles || [])
        .filter((tile) => finiteBounds(tile.bounds))
        .map((tile) => tile.id);
      const coversWholeBoard = boardTileIds.length === sanitizedLayoutTiles.length &&
        boardTileIds.every((id) => sanitizedLayoutTiles.includes(id));
      // Named compositions intentionally reflow the whole board. Restricting
      // them to a subset can collide with untouched tiles; very large sets can
      // also produce cells below the 80px apply floor.
      if (!coversWholeBoard || sanitizedLayoutTiles.length < 2 || sanitizedLayoutTiles.length > 6) {
        sanitizedComposition = undefined;
        sanitizedLayoutTiles = [];
        sanitizedHeroTileId = undefined;
      }
    }
    if (!sanitizedLayout.length && !sanitizedComposition) kind = "manual";
  }
  // add-kpis carries model-authored KPI definitions. Keep those that name a real
  // field on a real tile (or a bare count). Never add another KPI band when the
  // board already exposes KPI chrome or KPI/metric/scorecard tiles.
  let sanitizedKpis: KpiDefinition[] = [];
  if (kind === "add-kpis" || kind === "recompose-kpis") {
    const rawKpis = Array.isArray(proposalRaw.kpis) ? proposalRaw.kpis : [];
    for (const entry of rawKpis) {
      if (sanitizedKpis.length >= MAX_KPIS) break;
      const record = object(entry);
      const label = text(record.label);
      if (!label) continue;
      const kpiTile = exactTile(record.tile, tileIds) || undefined;
      const agg = typeof record.agg === "string" && KPI_AGGREGATES.has(record.agg)
        ? record.agg as KpiDefinition["agg"]
        : undefined;
      const field = text(record.field) || undefined;
      const unit = text(record.unit) || undefined;
      const format = typeof record.format === "string" && KPI_FORMATS.has(record.format)
        ? record.format as KpiDefinition["format"]
        : undefined;
      const rawFilter = object(record.filter);
      const filterField = typeof rawFilter.field === "string" && rawFilter.field.trim()
        ? rawFilter.field.trim()
        : null;
      const filterValue = rawFilter.value;
      const filterValueIsScalar = typeof filterValue === "string" ||
        typeof filterValue === "number" || typeof filterValue === "boolean";
      const rawFilters = Array.isArray(record.filters) ? record.filters : [];
      const filters = rawFilters.flatMap((item) => {
        const raw = object(item);
        const filterField = typeof raw.field === "string" && raw.field.trim()
          ? raw.field.trim()
          : null;
        const filterValue = raw.value;
        const scalar = typeof filterValue === "string" ||
          typeof filterValue === "number" || typeof filterValue === "boolean";
        return filterField && scalar ? [{ field: filterField, value: filterValue }] : [];
      });
      const candidate: KpiDefinition = {
        label,
        ...(kpiTile ? { tile: kpiTile } : {}),
        ...(field ? { field } : {}),
        ...(agg ? { agg } : {}),
        ...(filterField && filterValueIsScalar
          ? { filter: { field: filterField, value: filterValue } }
          : {}),
        ...(filters.length ? { filters } : {}),
        ...(record.highlight === true ? { highlight: true } : {}),
        ...(unit ? { unit } : {}),
        ...(format ? { format } : {}),
      };
      // Gate on real computability, using the SAME engine that will render it, so
      // the sanitizer can never admit a KPI that resolves to "—" at apply time
      // (which would move the tiles into a band showing a dead placeholder — the
      // "accept has no effect" symptom). computeKpis returns computed:false for a
      // missing tile, a field absent from that tile, a bare count with no source,
      // or a tile whose transform reshapes its rows. Keep only computed ones.
      const [resolved] = computeKpis(packet.specMap, [candidate]);
      if (!resolved || resolved.computed === false) continue;
      sanitizedKpis.push(candidate);
    }
  }
  // An add-kpis that names no resolvable KPI has nothing real to compute: with
  // the real-KPI design its band would be empty, so "Accept" would move tiles
  // into dead space with no visible KPI — the "accept has no effect" symptom.
  // Degrade it to honest guidance rather than presenting a hollow executable.
  if (kind === "add-kpis" && !sanitizedKpis.length) kind = "manual";
  if (kind === "recompose-kpis" && (!packet.board.hasKpis || !packet.board.kpis?.length)) {
    kind = "manual";
  }
  let sanitizedFilterId: string | null = null;
  let sanitizedFilterPlacement: Proposal["filterPlacement"];
  let sanitizedFilterPosition: Proposal["filterPosition"];
  let sanitizedAnchorTileId: string | undefined;
  if (kind === "wire-filter-control") {
    const filterId = text(proposalRaw.filterId);
    const control = packet.board.filters?.find((item) => item.id === filterId);
    const validTargets = control?.targets.filter((id) =>
      Boolean(packet.specMap[id]) && specHasField(packet.specMap[id], control.field)
    ) || [];
    if (!control || control.wired || !validTargets.length) kind = "manual";
    else sanitizedFilterId = control.id;
  }
  if (kind === "edit-filter-control") {
    const filterId = text(proposalRaw.filterId);
    const control = packet.board.filters?.find((item) => item.id === filterId);
    const placement = typeof proposalRaw.filterPlacement === "string" &&
        FILTER_PLACEMENTS.has(proposalRaw.filterPlacement)
      ? proposalRaw.filterPlacement as Proposal["filterPlacement"]
      : undefined;
    if (!control || !placement) {
      kind = "manual";
    } else {
      sanitizedFilterId = control.id;
      sanitizedFilterPlacement = placement;
      if (placement === "chart-header") {
        sanitizedAnchorTileId = exactTile(proposalRaw.anchorTileId, tileIds) || undefined;
        if (!sanitizedAnchorTileId) kind = "manual";
      } else if (placement === "floating") {
        const rawPosition = object(proposalRaw.filterPosition);
        const x = Number(rawPosition.x);
        const y = Number(rawPosition.y);
        const w = rawPosition.w === undefined ? 240 : Number(rawPosition.w);
        const canvasWidth = Number(packet.board.canvasWidth) || 1100;
        const canvasHeight = Number(packet.board.canvasHeight) || 720;
        if (![x, y, w].every(Number.isFinite) || x < 0 || y < 0 || w < 120 ||
            x + w > canvasWidth || y + 52 > canvasHeight) {
          kind = "manual";
        } else {
          sanitizedFilterPosition = { x, y, w };
        }
      }
      const samePlacement = control.placement === placement;
      const sameAnchor = placement !== "chart-header" || control.anchorTile === sanitizedAnchorTileId;
      const samePosition = placement !== "floating" || canonicalJson(control.position) === canonicalJson(sanitizedFilterPosition);
      if (kind === "edit-filter-control" && samePlacement && sameAnchor && samePosition) kind = "manual";
    }
  }
  const sanitizedPalette = kind === "v2-palette" && Array.isArray(proposalRaw.palette)
    ? [...new Set(
      proposalRaw.palette.filter((color): color is string =>
        typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)),
    )].slice(0, 12)
    : [];
  const proposal: Proposal = { kind, mode: kind === "manual" ? "guidance_only" : "executable" };
  if (kind === "edit-spec") proposal.edits = sanitizedEdits;
  if (kind === "edit-layout") proposal.layout = sanitizedLayout;
  if (kind === "edit-layout" && sanitizedComposition) {
    proposal.composition = sanitizedComposition;
    proposal.layoutTiles = sanitizedLayoutTiles;
    if (sanitizedHeroTileId && sanitizedLayoutTiles.includes(sanitizedHeroTileId)) {
      proposal.heroTileId = sanitizedHeroTileId;
    }
  }
  if (kind === "wire-filter-control" && sanitizedFilterId) proposal.filterId = sanitizedFilterId;
  if (kind === "edit-filter-control" && sanitizedFilterId && sanitizedFilterPlacement) {
    proposal.filterId = sanitizedFilterId;
    proposal.filterPlacement = sanitizedFilterPlacement;
    if (sanitizedFilterPosition) proposal.filterPosition = sanitizedFilterPosition;
    if (sanitizedAnchorTileId) proposal.anchorTileId = sanitizedAnchorTileId;
    ref.filterId = sanitizedFilterId;
  }
  if ((kind === "add-kpis" || kind === "recompose-kpis") &&
      (sanitizedKpis.length || kind === "recompose-kpis")) {
    if (sanitizedKpis.length) proposal.kpis = sanitizedKpis;
    if (typeof proposalRaw.kpiStyle === "string" &&
        KPI_STYLES.has(proposalRaw.kpiStyle as KpiStyle)) {
      proposal.kpiStyle = proposalRaw.kpiStyle as KpiStyle;
    }
    if (typeof proposalRaw.kpiLayout === "string" &&
        KPI_LAYOUTS.has(proposalRaw.kpiLayout as KpiLayout)) {
      proposal.kpiLayout = proposalRaw.kpiLayout as KpiLayout;
    }
    if (typeof proposalRaw.kpiAlignment === "string" &&
        KPI_ALIGNMENTS.has(proposalRaw.kpiAlignment)) {
      proposal.kpiAlignment = proposalRaw.kpiAlignment as "start" | "center" | "end";
    }
    if (typeof proposalRaw.kpiDensity === "string" &&
        KPI_DENSITIES.has(proposalRaw.kpiDensity)) {
      proposal.kpiDensity = proposalRaw.kpiDensity as "airy" | "balanced" | "dense";
    }
    if (typeof proposalRaw.kpiChrome === "string" &&
        KPI_CHROME.has(proposalRaw.kpiChrome)) {
      proposal.kpiChrome = proposalRaw.kpiChrome as "plain" | "ruled" | "filled";
    }
  }
  if (proposal.kind === "recompose-kpis" && !proposal.kpis?.length) {
    const changesPresentation =
      Boolean(proposal.kpiLayout && proposal.kpiLayout !== packet.board.kpiLayout) ||
      Boolean(proposal.kpiStyle && proposal.kpiStyle !== packet.board.kpiStyle) ||
      Boolean(proposal.kpiAlignment && proposal.kpiAlignment !== packet.board.kpiAlignment) ||
      Boolean(proposal.kpiDensity && proposal.kpiDensity !== packet.board.kpiDensity) ||
      Boolean(proposal.kpiChrome && proposal.kpiChrome !== packet.board.kpiChrome);
    if (!changesPresentation) {
      proposal.kind = "manual";
      proposal.mode = "guidance_only";
    }
  }
  if (kind === "v2-palette" && sanitizedPalette.length >= 2) proposal.palette = sanitizedPalette;
  if (kind === "dashboard-title") {
    const label = text(proposalRaw.label);
    if (!label) {
      proposal.kind = "manual";
      proposal.mode = "guidance_only";
    } else proposal.label = label;
    const subtitle = text(proposalRaw.subtitle);
    if (subtitle) proposal.subtitle = subtitle;
  }
  // Env-gated, behavior-neutral diagnostics: record whether an executable intent
  // survived sanitization, and (via the payload shape) which validation gate it
  // hit if it was demoted to guidance. Only attached when RE_API_DIVERSITY_DEBUG
  // is set (the measurement harness), so production/test responses are unchanged.
  if (process.env.RE_API_DIVERSITY_DEBUG) {
    proposal.diag = {
      requested: requestedKind,
      final: proposal.kind,
      demoted: proposal.kind === "manual" && requestedKind !== "manual",
      reason: proposal.kind === "manual" && requestedKind !== "manual" ? "sanitize" : "none",
      payload: {
        hadEdits: Array.isArray(proposalRaw.edits) && proposalRaw.edits.length > 0,
        hadLayout: Array.isArray(proposalRaw.layout) && proposalRaw.layout.length > 0,
        hadComposition: typeof proposalRaw.composition === "string",
        hadKpis: Array.isArray(proposalRaw.kpis) && proposalRaw.kpis.length > 0,
        hadPalette: Array.isArray(proposalRaw.palette) && proposalRaw.palette.length > 0,
      },
    };
  }
  return { proposal, ref };
}

/** Detect filter-placement intent so it routes to edit-filter-control rather
 * than accidentally reflowing unrelated chart tiles through edit-layout. */
export function asksToRepositionControl(raw: JsonObject, refs: EvidenceRef[], packet: EvidencePacket): boolean {
  const prose = [raw.title, raw.issue, raw.rationale, raw.evidence, raw.suggestion]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const targetText = JSON.stringify(object(object(raw.target).ref));
  const filterNames = (packet.board.filters || [])
    .flatMap((filter) => [filter.id, filter.label])
    .filter(Boolean);
  const searchableText = `${prose} ${targetText}`.toLowerCase();
  const namesFilter = filterNames.some((name) => searchableText.includes(name.toLowerCase()));
  const citesFilters = refs.some((ref) => ref.path === "board.filters" || ref.path.startsWith("board.filters."));
  const mentionsControl = citesFilters || namesFilter ||
    /\b(slider|filter|control|dropdown|selector|checkbox|toggle)\b/i.test(searchableText);
  const requestsPlacement =
    /\b(move|relocate|place|position|align|group|cluster|together|float|floating|top|bottom|left|right|band|row|rail)\b/i
      .test(prose);
  return mentionsControl && requestsPlacement;
}

function requestedFilterId(
  raw: JsonObject,
  refs: EvidenceRef[],
  contract: ReviewRequestContract | undefined,
  packet: EvidencePacket,
): string | null {
  const controls = packet.board.filters || [];
  const known = new Set(controls.map((control) => control.id));
  const candidates = [
    ...(contract?.targetPaths || []).flatMap((path) => {
      const match = path.match(/^board\.filters\.([^\.]+)$/);
      return match ? [match[1]] : [];
    }),
    ...refs.flatMap((ref) => {
      const match = ref.path.match(/^board\.filters\.([^\.]+)$/);
      return match ? [match[1]] : [];
    }),
    text(object(object(raw.target).ref).filterId) || "",
  ].filter((id) => known.has(id));
  if (candidates.length) return candidates[0];
  const prose = [raw.title, raw.issue, raw.rationale, raw.evidence, raw.suggestion]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const named = controls.filter((control) =>
    prose.includes(control.id.toLowerCase()) || prose.includes(control.label.toLowerCase()));
  if (named.length === 1) return named[0].id;
  return controls.length === 1 ? controls[0].id : null;
}

/** A direct focused/local request already supplies a validated semantic target.
 * If the model still emits the legacy tile-layout payload (or prose-only manual
 * guidance), turn the explicit request into the smallest safe filter move. This
 * is intentionally limited to an explicit reposition action; open-ended review
 * remains model-authored. */
function directFilterMoveProposal(
  raw: JsonObject,
  refs: EvidenceRef[],
  contract: ReviewRequestContract | undefined,
  packet: EvidencePacket,
): { proposal: Proposal; ref: JsonObject } | null {
  if (!contract?.explicitChange || !contract.actions.includes("reposition")) return null;
  const filterId = requestedFilterId(raw, refs, contract, packet);
  const control = packet.board.filters?.find((item) => item.id === filterId);
  if (!control) return null;
  const request = contract.request.toLowerCase();
  let filterPlacement: Proposal["filterPlacement"];
  if (/\b(right|right-hand|right side)\b/i.test(request)) filterPlacement = "right-rail";
  else if (/\b(left|left-hand|left side)\b/i.test(request)) filterPlacement = "left-rail";
  else if (/\b(title|headline|header)\b/i.test(request)) filterPlacement = "title-inline";
  else if (/\b(top|above|upper)\b/i.test(request)) filterPlacement = "top-row";
  else {
    // A bare "move the filter" still needs a visible, reversible result. Move
    // rail/floating controls into the standard top band; move an already-top
    // control beside the title so the operation can never sanitize to a no-op.
    filterPlacement = control.placement === "top-row" ? "title-inline" : "top-row";
  }
  return validatedProposal({
    proposal: {
      kind: "edit-filter-control",
      mode: "executable",
      filterId: control.id,
      filterPlacement,
    },
    target: { ref: { filterId: control.id } },
  }, null, packet);
}

function defaultSurface(dimension: Dimension): Surface {
  if (dimension === "interaction") return "interaction";
  if (dimension === "text") return "text";
  if (dimension === "chart" || dimension === "color" || dimension === "data" || dimension === "visual design") {
    return "encoding";
  }
  return "structural";
}

/**
 * The recommendation catalog is a useful semantic prior, but an executable
 * operation is stronger evidence about what the author will actually change.
 * Keep Interactivity for behavior that responds to an action; moving the
 * control itself is Layout, even if the model reached for an interaction leaf
 * because the component happens to be a filter.
 */
export function semanticDimensionForProposal(
  catalogDimension: Dimension,
  proposalKind: string,
): Dimension {
  if (["add-cross-filter", "add-tooltip", "show-filter-state", "wire-filter-control"].includes(proposalKind)) {
    return "interaction";
  }
  if (["edit-filter-control", "edit-layout", "recompose-kpis"].includes(proposalKind)) {
    return "layout";
  }
  if (proposalKind === "add-kpis") return "data";
  if (["v2-palette", "preserve-brand-palette"].includes(proposalKind)) return "color";
  if (["dashboard-title", "chart-subtitles"].includes(proposalKind)) return "text";
  return catalogDimension;
}

function semanticSurfaceForProposal(
  declaredSurface: Surface,
  proposalKind: string,
  dimension: Dimension,
): Surface {
  if (["add-cross-filter", "add-tooltip", "show-filter-state", "wire-filter-control"].includes(proposalKind)) {
    return "interaction";
  }
  if (["dashboard-title", "chart-subtitles"].includes(proposalKind)) return "text";
  if (["edit-filter-control", "edit-layout", "add-kpis", "recompose-kpis"].includes(proposalKind)) {
    return "structural";
  }
  return declaredSurface || defaultSurface(dimension);
}

function proposalMatchesRequestContract(
  proposal: Proposal,
  tileId: string | null,
  ref: Record<string, unknown>,
  contract: ReviewRequestContract | undefined,
  packet: EvidencePacket,
): boolean {
  if (!contract?.explicitChange || !contract.targetPaths.length) return true;
  const targetPaths = contract.targetPaths;
  const targetsTitle = targetPaths.includes("board.title");
  const targetsSubtitle = targetPaths.includes("board.subtitle");
  if (targetsTitle || targetsSubtitle) {
    if (proposal.kind !== "dashboard-title") return false;
    if (targetsTitle && typeof proposal.label !== "string") return false;
    if (targetsSubtitle && typeof proposal.subtitle !== "string") return false;
    if (targetsTitle && contract.actions.includes("shorten")) {
      const before = String(packet.board.title || "").replace(/\s+/g, " ").trim();
      const after = String(proposal.label || "").replace(/\s+/g, " ").trim();
      if (!before || !after || after.length > Math.floor(before.length * 0.85)) return false;
    }
    return true;
  }
  const requestedFilters = new Set(targetPaths.flatMap((path) => {
    const match = path.match(/^board\.filters\.([^\.]+)$/);
    return match ? [match[1]] : [];
  }));
  if (requestedFilters.size) {
    return proposal.kind === "edit-filter-control" &&
      typeof proposal.filterId === "string" && requestedFilters.has(proposal.filterId);
  }
  const requestedTiles = new Set(contractTileIds(contract));
  if (!requestedTiles.size) return true;
  const proposalTiles = new Set([
    ...(tileId ? [tileId] : []),
    ...(typeof ref.tile === "string" ? [ref.tile] : []),
    ...(typeof ref.source === "string" ? [ref.source] : []),
    ...(Array.isArray(ref.tiles) ? ref.tiles.filter((id): id is string => typeof id === "string") : []),
    ...(Array.isArray(ref.targets) ? ref.targets.filter((id): id is string => typeof id === "string") : []),
    ...(Array.isArray(proposal.layoutTiles)
      ? proposal.layoutTiles.filter((id): id is string => typeof id === "string")
      : []),
  ]);
  return [...requestedTiles].some((id) => proposalTiles.has(id));
}

function validateCritique(
  value: unknown,
  index: number,
  diagnosisByKey: Map<string, Diagnosis>,
  packet: EvidencePacket,
  snapshot: ContextSnapshot,
  reviewScope: ReviewScope,
  authorRequest?: string,
  requestContract?: ReviewRequestContract,
  focusPurpose?: FocusedReviewRequest["purpose"],
): { critique: Critique; finding: Finding } | null {
  const raw = object(value);
  if (!isObjectCode(raw.object)) return null;
  const objectCode = raw.object as string;
  const problemCode = isProblemCode(raw.problem) ? raw.problem as string : undefined;
  const recommendationId = typeof raw.recommendation === "string" ? raw.recommendation : "";
  // Catalog membership is an empirical grouping/routing signal, not an
  // admission or execution gate. A matched leaf supplies its branch; an
  // uncatalogued fix is admitted on the same evidence/grounding merits, tagged
  // "other", and may still execute when its proposal passes normal safety gates.
  // The rate of "other" remains a coverage signal for future catalog updates.
  const leaf = RECOMMENDATION_LEAF_BY_ID.get(recommendationId);
  let dimension: Dimension = leaf
    ? leaf.branch
    : uncataloguedDimension(objectCode, recommendationId, snapshot);

  // A matching diagnosis is optional grounding backfill, never an admission gate.
  const diagnosis = diagnosisByKey.get(comboKey(objectCode, problemCode)) ||
    diagnosisByKey.get(comboKey(objectCode));

  let tentative = false;
  const issue = text(raw.issue);
  // Never turn an empirical leaf label into canned author-facing copy. When the
  // model omits a title, the dashboard-specific issue is a more honest fallback.
  const title = text(raw.title) || issue?.slice(0, 120) || "Recommendation";
  const rationale = text(raw.rationale) || (diagnosis ? text(diagnosis.rationale) : null);
  const evidence = text(raw.evidence) ||
    text((diagnosis?.evidenceRefs || []).map((ref) => ref.detail).join(" "));
  const suggestion = text(raw.suggestion);
  const answer = text(raw.answer);
  if (!issue || !rationale || !evidence || !suggestion) return null;
  if (!text(raw.title) || !text(raw.rationale) || !text(raw.evidence)) tentative = true;

  let priority = PRIORITIES.has(raw.priority as Priority) ? raw.priority as Priority : "medium";
  if (!PRIORITIES.has(raw.priority as Priority)) tentative = true;
  let surface = SURFACES.has(raw.surface as Surface) ? raw.surface as Surface : defaultSurface(dimension);
  if (!SURFACES.has(raw.surface as Surface)) tentative = true;

  const tileIds = new Set(Object.keys(packet.specMap));
  const tileId = raw.tileId === null || raw.tileId === undefined ? null : exactTile(raw.tileId, tileIds);
  if (raw.tileId !== null && raw.tileId !== undefined && !tileId) return null;
  const declaredTargetRef = object(object(raw.target).ref);
  if (declaredTargetRef.tile !== undefined && declaredTargetRef.tile !== null &&
      !exactTile(declaredTargetRef.tile, tileIds)) {
    return null;
  }

  const declaredRefs = Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs : [];
  let validatedRefs = declaredRefs.length
    ? validateRefs(declaredRefs, packet, snapshot)
    : (diagnosis?.evidenceRefs || []);
  if (declaredRefs.length && !validatedRefs.length) {
    const diagnosisRefs = diagnosis?.evidenceRefs || [];
    const sameTileRefs = tileId
      ? diagnosisRefs.filter((ref) =>
        ref.tileId === tileId ||
        ref.path === `tile.${tileId}` ||
        ref.path.startsWith(`tile.${tileId}.`)
      )
      : diagnosisRefs;
    validatedRefs = sameTileRefs;
    tentative = true;
  }
  // A workflow/process ("design process") or uncatalogued ("other") critique
  // often has no resolvable evidenceRef: there is no design-process detector,
  // and context goal/audience/constraints is frequently absent. It points at the
  // process rather than a specific mark, so it may rest on "general design
  // principle" (which needs no ref). Admit these advisory-branch critiques with
  // empty refs as tentative guidance; every other branch still requires a
  // resolvable ref, so component fixes can never turn lazy.
  const advisoryWithoutRefs = !validatedRefs.length && NO_REF_GUIDANCE_BRANCHES.has(dimension);
  if (!validatedRefs.length && !advisoryWithoutRefs) return null;
  if (advisoryWithoutRefs) tentative = true;
  if (declaredRefs.length && validatedRefs.length < declaredRefs.length) tentative = true;

  // Numeric half of the grounding gate: reject a critique whose prose asserts a
  // specific currency amount or data-bound count that reconciles with no real
  // value or aggregate of its own tile(s). This is the fabrication a resolvable
  // evidence PATH does not catch (it proves the path exists, not that the STATED
  // figure is right). Checked against the critique's own tile plus any tile its
  // validated refs cite; percentages/years/small counts are exempt (see helper).
  const groundingTileIds = [
    ...(tileId ? [tileId] : []),
    ...validatedRefs.map((r) => r.tileId).filter((id): id is string => Boolean(id)),
  ];
  if (!proseFiguresAreGrounded([issue, rationale, evidence, suggestion].join(" "), groundingTileIds, packet.specMap)) {
    return null;
  }

  const declaredBases = judgmentBases(raw.judgmentBasis);
  let candidateBases = declaredBases.length ? declaredBases : (diagnosis?.judgmentBasis || []);
  // An advisory critique admitted with no resolvable ref can only be grounded on
  // a general design principle (the always-available basis). Ensure it is a
  // candidate so the grounding gate below still authorizes the claim.
  if (advisoryWithoutRefs && !candidateBases.includes("general design principle")) {
    candidateBases = [...candidateBases, "general design principle"];
  }
  let bases = supportedJudgmentBases(candidateBases, validatedRefs, snapshot);
  if (!bases.length && diagnosis?.judgmentBasis.length) {
    candidateBases = diagnosis.judgmentBasis;
    bases = supportedJudgmentBases(candidateBases, validatedRefs, snapshot);
    tentative = true;
  }
  if (!bases.length) return null; // uniform grounding gate

  const requiredContext = [...new Set(dependenciesForBases(bases))];
  const contextStatus = contextStatusForDependencies(requiredContext, snapshot).contextStatus;

  const usesInferredContext = contextStatus === "inferred" &&
    bases.some((basis) => basis === "analytical task" || basis === "audience");
  const critiqueText = [issue, rationale, suggestion, answer].join(" ");
  if (
    usesInferredContext &&
    !/\b(if|assuming|under the inferred|given the likely|for the likely|may|might|could)\b/i.test(critiqueText)
  ) tentative = true;

  const requestedProposalKind = text(object(raw.proposal).kind);
  if (requestedProposalKind === "add-kpis" &&
      (packet.board.hasKpis || hasEmbeddedKpis(packet.specMap, packet.board))) {
    return null;
  }
  let { proposal, ref } = validatedProposal(raw, tileId, packet);
  const materialityReason = tileId
    ? [lowMaterialityTextAlignmentReason, lowMaterialityTextRewriteReason]
      .map((check) => check({
          proposal,
          spec: packet.specMap[tileId],
          dashboardType: snapshot.values.dashboardType,
          explicitAuthorChange: Boolean(
            requestContract?.explicitChange && focusPurpose !== "stale-refresh"
          ),
        }))
      .find(Boolean) || null
    : null;
  if (materialityReason) return null;
  const priorDiag = proposal.diag;
  if (asksToRepositionControl(raw, validatedRefs, packet) && proposal.kind !== "edit-filter-control") {
    const directMove = directFilterMoveProposal(raw, validatedRefs, requestContract, packet);
    if (directMove?.proposal.mode === "executable") {
      proposal = directMove.proposal;
      ref = directMove.ref;
    } else if (proposal.kind === "edit-layout") {
      // A full/open-ended review must never move unrelated tiles as a surrogate
      // for moving a filter. Directed asks get the deterministic filter operation
      // above; otherwise keep the recommendation as honest guidance.
      proposal = { kind: "manual", mode: "guidance_only" };
      if (process.env.RE_API_DIVERSITY_DEBUG) {
        proposal.diag = {
          ...(priorDiag as object),
          final: "manual",
          demoted: true,
          reason: "control-placement-needs-edit-filter-control",
        };
      }
      ref = {};
    }
  }
  // Canonicalize the display/review category from the concrete operation after
  // all proposal repair and directed-request conversion has finished. This is
  // the deterministic guard against a filter-placement fix appearing under
  // Interactivity just because its component is a filter.
  dimension = semanticDimensionForProposal(dimension, proposal.kind);
  surface = semanticSurfaceForProposal(surface, proposal.kind, dimension);
  // A tentative DIAGNOSIS (inferred / weaker grounding) no longer forces its FIX
  // to guidance. Executability is orthogonal to diagnostic confidence: the
  // proposal already passed the same real-field, sanitize, compile, and rollback
  // gates as any fix, and applying it is reversible. The critique still carries
  // supportStatus "tentative" (and grounded:false), which the UI renders as a
  // "Tentative" chip on an applyable card — so the author gets a real, undoable
  // before/after instead of prose. Forcing these to guidance was a large,
  // avoidable source of "too much guidance, too little applyable".
  if (process.env.RE_API_DIVERSITY_DEBUG && tentative && proposal.mode === "executable" && proposal.diag) {
    (proposal.diag as Record<string, unknown>).tentativeKept = true;
  }
  // Process advice changes how the author works, not the artifact, so it always
  // remains guidance. An uncatalogued component fix is different: when its real
  // refs and proposal passed the same sanitization/compile gates as a catalogued
  // fix, keep it executable — the empirical catalog is a scaffold, not a veto.
  if (PROCESS_ONLY_BRANCHES.has(dimension) && proposal.mode === "executable") {
    proposal = { kind: "manual", mode: "guidance_only" };
    if (process.env.RE_API_DIVERSITY_DEBUG) {
      proposal.diag = { ...(priorDiag as object), final: "manual", demoted: true, reason: "process" };
    }
    ref = tileId ? { tile: tileId } : {};
  }

  if (!proposalMatchesRequestContract(proposal, tileId, ref, requestContract, packet)) {
    return null;
  }

  const interactionKind = INTERACTIONS.has(raw.interactionKind as InteractionKind) ? raw.interactionKind as InteractionKind : undefined;
  const crosscutting = parseCrosscutting(raw.crosscutting);
  const kind = slug(text(raw.kind) || title) || `finding-${index + 1}`;
  const id = `llm-${index + 1}-${kind}`;
  const target = { granularity: text(object(raw.target).granularity) || (tileId ? "chart" : "dashboard"), ref };
  const priorWeight = diagnosis?.priorWeight ?? priorWeightFor(objectCode, problemCode);
  const finding: Finding = {
    id: `finding-${id}`,
    kind,
    dimension,
    ...(crosscutting.length ? { crosscutting } : {}),
    proposalKind: proposal.kind,
    surface,
    interactionKind,
    severity: priority,
    evidence: { detail: evidence, tile: tileId || undefined },
    target,
    tileId,
  };
  const critique: Critique = {
    id: `c-${id}`,
    tileId,
    dimension,
    ...(crosscutting.length ? { crosscutting } : {}),
    priority,
    status: "pending",
    source: "ai",
    title,
    issue,
    rationale,
    evidence,
    suggestion,
    target,
    proposal,
    surface,
    interactionKind,
    findingId: finding.id,
    grounded: !tentative,
    phrasingSource: "llm",
    reviewScope,
    object: objectCode,
    ...(problemCode ? { problem: problemCode } : {}),
    // Keep the empirical leaf only when its branch still agrees with the
    // operation-derived category. A mismatched leaf is a model routing error,
    // not useful provenance for the author-facing card.
    ...(leaf?.branch === dimension ? { recommendation: leaf.id } : {}),
    diagnosisOutcome: "evaluated_issue",
    priorWeight,
    judgmentBasis: bases,
    requiredContext,
    contextStatus,
    evidenceRefs: validatedRefs,
    supportStatus: tentative ? "tentative" : "validated",
    registryVersion: CRITERION_REGISTRY_VERSION,
    promptVersion: REVIEW_PROMPT_VERSION,
    engineVersion: REVIEW_ENGINE_VERSION,
    model: process.env.RE_API_MODEL?.trim() || "configured-model",
    contextSnapshotId: snapshot.id,
    ...(answer ? { answer } : {}),
    ...(authorRequest && answer
      ? {
          requestRelevance: "direct" as const,
          reviewRequest: authorRequest,
          ...(requestContract ? { requestContract } : {}),
        }
      : {}),
  };
  return { critique, finding };
}

function detectorFallbackCandidate(
  finding: Finding,
  snapshot: ContextSnapshot,
  reviewScope: ReviewScope,
): { critique: Critique; finding: Finding; diagnosis: Diagnosis } | null {
  const mapping = DETECTOR_DIAGNOSIS[finding.kind];
  if (!mapping) return null;
  const leaf = RECOMMENDATION_LEAF_BY_ID.get(mapping.recommendation);
  if (!leaf) return null;
  const dimension = leaf.branch;

  const executable = FALLBACK_EXECUTABLE_PROPOSALS.has(finding.proposalKind);
  const proposal: Proposal = {
    kind: executable ? finding.proposalKind : "manual",
    mode: executable ? "executable" : "guidance_only",
  };
  if (proposal.kind === "wire-filter-control" && typeof finding.evidence.filterId === "string") {
    proposal.filterId = finding.evidence.filterId;
  }
  const fallbackFinding: Finding = { ...finding, dimension, proposalKind: proposal.kind };
  const phrasing = templateText(finding);
  const refs = [evidenceRefForFinding(finding)];
  // Detector findings are dashboard evidence; a general design principle always
  // warrants the recommendation. Neither needs author context.
  const candidateBases: JudgmentBasis[] = ["dashboard evidence", "general design principle"];
  const bases = supportedJudgmentBases(candidateBases, refs, snapshot);
  if (!refs.length || !bases.length) return null;

  const priority = finding.severity;
  const priorWeight = priorWeightFor(mapping.object, mapping.problem);
  const critique: Critique = {
    id: `c-fallback-${finding.id}`,
    tileId: finding.tileId,
    dimension,
    priority,
    status: "pending",
    source: "ai",
    ...phrasing,
    target: finding.target,
    proposal,
    surface: finding.surface,
    interactionKind: finding.interactionKind,
    findingId: finding.id,
    grounded: true,
    phrasingSource: "template",
    reviewScope,
    object: mapping.object,
    ...(mapping.problem ? { problem: mapping.problem } : {}),
    recommendation: leaf.id,
    diagnosisOutcome: "evaluated_issue",
    priorWeight,
    judgmentBasis: bases,
    requiredContext: [],
    contextStatus: "not_applicable",
    evidenceRefs: refs,
    supportStatus: "validated",
    registryVersion: CRITERION_REGISTRY_VERSION,
    promptVersion: REVIEW_PROMPT_VERSION,
    engineVersion: REVIEW_ENGINE_VERSION,
    model: "deterministic-evidence-fallback",
    contextSnapshotId: snapshot.id,
  };
  const diagnosis: Diagnosis = {
    object: mapping.object,
    ...(mapping.problem ? { problem: mapping.problem } : {}),
    outcome: "evaluated_issue",
    judgmentBasis: bases,
    priorWeight,
    requiredContext: [],
    contextStatus: "not_applicable",
    evidenceRefs: refs,
    rationale: `Deterministic evidence helper ${finding.id} identified this issue.`,
  };
  return { critique, finding: fallbackFinding, diagnosis };
}

/** A focused or selected-region request must always produce a critique card.
 * When the model's direct critique is filtered out, preserve its answer as
 * explicit, tentative guidance tied to the actual requested scope. Full review
 * generation never uses this fallback. */
function requestGuidanceFallback(
  packet: EvidencePacket,
  snapshot: ContextSnapshot,
  reviewScope: ReviewScope,
  authorRequest: string,
  region?: LocalCritiqueRegion,
  requestContract?: ReviewRequestContract,
  answer?: string,
): { critique: Critique; finding: Finding } {
  const tileId = Object.keys(packet.specMap)[0] || null;
  const hintedDimension = region?.dimension;
  const dimension: Dimension = hintedDimension && BRANCHES.has(hintedDimension)
    ? hintedDimension
    : "other";
  const surface: Surface = dimension === "text"
    ? "text"
    : dimension === "interaction"
      ? "interaction"
      : dimension === "layout"
        ? "structural"
        : "encoding";
  const resolvedAnswer = answer || (requestContract?.explicitChange
    ? "VIZier could not produce an executable change that satisfied this request's target and acceptance checks."
    : "No material issue was validated for this request; keep the current treatment unless author testing shows a specific problem.");
  const evidenceDetail = tileId
    ? `The request was evaluated against ${tileId}${region ? " inside the selected region" : ""}.`
    : `The request was evaluated against the current dashboard${packet.board.title ? ` “${packet.board.title}”` : ""}.`;
  const evidenceRef: EvidenceRef = tileId
    ? { source: "dashboard", path: `tile.${tileId}`, tileId, detail: evidenceDetail }
    : { source: "dashboard", path: "board.title", detail: evidenceDetail };
  const key = slug(authorRequest) || "focused-request";
  const findingId = `finding-request-guidance-${key}`;
  const target = region
    ? {
        granularity: "region",
        ref: { ...(tileId ? { tile: tileId } : {}), bounds: region.bounds },
      }
    : {
        granularity: tileId ? "chart" : "dashboard",
        ref: tileId ? { tile: tileId } : {},
      };
  const finding: Finding = {
    id: findingId,
    kind: "request-guidance",
    dimension,
    proposalKind: "manual",
    surface,
    severity: "medium",
    evidence: { detail: evidenceDetail, tile: tileId || undefined },
    target,
    tileId,
    ...(region ? { bounds: region.bounds } : {}),
  };
  const critique: Critique = {
    id: `c-request-guidance-${key}`,
    tileId,
    dimension,
    priority: "medium",
    status: "pending",
    source: "ai",
    title: "Guidance for this review request",
    issue: resolvedAnswer,
    rationale: "The direct response is useful, but it did not survive the executable recommendation gates as a validated transformation.",
    evidence: evidenceDetail,
    suggestion: answer
      ? `Use this as author guidance: ${answer}`
      : "Keep the current treatment for now, then revisit it if a concrete comparison or usability check reveals a problem.",
    target,
    proposal: { kind: "manual", mode: "guidance_only" },
    surface,
    bounds: region?.bounds,
    findingId,
    grounded: false,
    phrasingSource: "mixed",
    reviewScope,
    object: tileId ? "component" : "dashboard",
    problem: "unclear | ambiguous",
    diagnosisOutcome: "unsupported",
    priorWeight: "medium",
    judgmentBasis: ["dashboard evidence", "general design principle"],
    requiredContext: [],
    contextStatus: "not_applicable",
    evidenceRefs: [evidenceRef],
    supportStatus: "tentative",
    registryVersion: CRITERION_REGISTRY_VERSION,
    promptVersion: REVIEW_PROMPT_VERSION,
    engineVersion: REVIEW_ENGINE_VERSION,
    model: process.env.RE_API_MODEL?.trim() || "configured-model",
    contextSnapshotId: snapshot.id,
    answer: resolvedAnswer,
    requestRelevance: "direct",
    reviewRequest: authorRequest,
    ...(requestContract ? { requestContract } : {}),
  };
  return { critique, finding };
}

function priorityWeight(priority: Priority): number {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function supportWeight(critique: Critique): number {
  return critique.supportStatus === "validated" ? 2 :
    critique.supportStatus === "tentative" ? 1 : 0;
}

/** Select a small detector safety net by severity and detector kind, rather
 * than registration order. This keeps one repeated tooltip detector from
 * consuming every slot and silencing board-level empirical checks. */
function detectorSafetyNet<T extends { critique: Critique; finding: Finding }>(
  values: T[],
  limit: number,
): T[] {
  const ranked = [...values].sort((a, b) =>
    priorityWeight(b.critique.priority) - priorityWeight(a.critique.priority));
  const selected: T[] = [];
  const kinds = new Set<string>();
  for (const value of ranked) {
    if (selected.length >= limit) break;
    if (kinds.has(value.finding.kind)) continue;
    selected.push(value);
    kinds.add(value.finding.kind);
  }
  if (selected.length < limit) {
    for (const value of ranked) {
      if (selected.length >= limit) break;
      if (!selected.includes(value)) selected.push(value);
    }
  }
  return selected;
}

function critiqueSlotKey(value: { critique: Critique; finding: Finding }): string {
  const leaf = value.critique.proposal.kind === "manual"
    ? value.finding.kind
    : value.critique.proposal.kind;
  // Payload-aware for edit-spec. Two genuinely DIFFERENT edit sets on the same
  // (object, problem, tile) are distinct fixes — e.g. a sort fix and an
  // axis-format fix on one chart, both of which commonly omit a problem code and
  // would otherwise collide on object|""|tile|edit-spec and lose one silently,
  // before the limit cut ever runs. The downstream consolidation stage already
  // keys on the sanitized edit payload (consolidationSignature); mirror it here
  // so the two stages agree on edit identity. Genuinely identical edits still
  // hash the same and collapse to one slot, so true duplicates are unaffected.
  const payload = value.critique.proposal.kind === "edit-spec"
    ? `|${canonicalJson(value.critique.proposal.edits)}`
    : "";
  return `${value.critique.object}|${value.critique.problem ?? ""}|${value.critique.tileId || "dashboard"}|${leaf}${payload}`;
}

/** Solution refinement is intentionally a set of alternatives for the SAME
 * diagnosis and target. The ordinary slot key above collapses those siblings —
 * correct for a review, wrong for a chooser. Key refinement candidates by their
 * sanitized executable payload instead, so genuinely different implementations
 * survive while duplicate proposals still collapse deterministically. */
function refinementAlternativeSlotKey(value: { critique: Critique; finding: Finding }): string {
  return [
    value.critique.object,
    value.critique.problem ?? "",
    value.critique.dimension,
    value.critique.tileId || "dashboard",
    canonicalJson(value.critique.target),
    canonicalJson(value.critique.proposal),
  ].join("|");
}

function critiqueLocationKey(value: { critique: Critique }): string {
  const location = value.critique.tileId ||
    text(object(value.critique.target?.ref).source) ||
    text(object(value.critique.target?.ref).tile) ||
    "dashboard";
  return `${value.critique.object}|${value.critique.problem ?? ""}|${location}`;
}

/** A detector and the model can describe the same executable remedy with
 * different taxonomy labels (for example `interaction/limited affordance`
 * versus `tooltip/missing`).  The author should still see one fix, not two.
 * Keep this key deliberately narrow: only identical executable proposal kinds
 * on the same resolved location suppress a detector fallback. */
function executableRemedyLocationKey(value: { critique: Critique }): string {
  if (value.critique.proposal.mode !== "executable") return "";
  const location = value.critique.tileId ||
    text(object(value.critique.target?.ref).source) ||
    text(object(value.critique.target?.ref).tile) ||
    "dashboard";
  return `${value.critique.proposal.kind}|${location}`;
}

// Kinds whose fix is tile-PORTABLE — the identical operation applies to any tile
// because it derives its payload from that tile at apply time (add-tooltip reads
// the tile's own encoded fields). Such N-per-tile duplicates can collapse into
// ONE multi-tile card. edit-spec is also consolidatable but carries a per-tile
// edit payload, so it uses that payload as its consolidation signature and its
// own no-fabrication guard; the payload-free kinds here contribute an empty
// payload, so their identity is object|problem|kind. Dashboard-scoped and
// data/geometry-specific kinds (palette, cross-filter, kpis, layout, title,
// subtitles) are never per-tile duplicates and are deliberately excluded.
const PORTABLE_CONSOLIDATION_KINDS = new Set<string>(["add-tooltip"]);

/** Whether a proposal kind can be consolidated across tiles at all. */
function isConsolidatableKind(kind: string): boolean {
  return kind === "edit-spec" || PORTABLE_CONSOLIDATION_KINDS.has(kind);
}

/** The tile-AGNOSTIC signature two critiques must share to collapse into one
 * multi-tile card: object | problem | kind | portable-payload. edit-spec hashes
 * its sanitized edits (so genuinely different edits never merge); payload-free
 * portable kinds contribute an empty payload, so identity is object|problem|kind. */
function consolidationSignature(critique: Critique): string {
  const payload = critique.proposal.kind === "edit-spec"
    ? canonicalJson(critique.proposal.edits)
    : critique.proposal.kind === "edit-filter-control"
      ? canonicalJson({
          filterId: critique.proposal.filterId,
          placement: critique.proposal.filterPlacement,
          position: critique.proposal.filterPosition,
          anchor: critique.proposal.anchorTileId,
        })
    : "";
  return `${critique.object}|${critique.problem ?? ""}|${critique.proposal.kind}|${payload}`;
}

export function iterationProposalSignature(critique: Critique): string {
  const signatureText = (value: unknown): string => typeof value === "string" ? value : "";
  const ref = object(critique.target?.ref);
  const tileIds = [
    critique.tileId,
    signatureText(ref.tile),
    signatureText(ref.source),
    ...(Array.isArray(ref.tiles) ? ref.tiles.map(signatureText) : []),
    ...(Array.isArray(critique.proposal.layout)
      ? critique.proposal.layout.map((item) => signatureText(object(item).tile))
      : []),
  ].filter((value): value is string => Boolean(value)).sort();
  const payload = JSON.stringify({
    edits: critique.proposal.edits || [],
    palette: critique.proposal.palette || [],
    layout: critique.proposal.layout || [],
    kpis: critique.proposal.kpis || [],
    label: signatureText(critique.proposal.label),
    subtitle: signatureText(critique.proposal.subtitle),
    ...(critique.proposal.kind === "edit-filter-control"
      ? { filterPosition: critique.proposal.filterPosition || null }
      : {}),
  });
  const structure = [
    signatureText(critique.proposal.kpiLayout),
    signatureText(critique.proposal.kpiStyle),
    signatureText(critique.proposal.composition),
    signatureText(critique.proposal.filterId),
    signatureText(critique.proposal.filterPlacement),
    signatureText(critique.proposal.anchorTileId),
  ].filter(Boolean).join(",");
  const manualRemedy = critique.proposal.kind === "manual"
    ? critique.recommendation || critique.suggestion
    : "";
  return [
    critique.proposal.kind || "manual",
    critique.object || "",
    critique.problem || "",
    tileIds.join(","),
    payload,
    structure,
    manualRemedy,
  ].join("|").slice(0, 800);
}

function proposalChangeMagnitude(critique: Critique, round = 1): number {
  const kind = critique.proposal.kind;
  const base = kind === "edit-layout" ? 6
    : kind === "recompose-kpis" || kind === "add-kpis" ? 5
    : kind === "edit-spec" ? Math.min(5, 2 + Math.ceil((critique.proposal.edits?.length || 0) / 3))
    : kind === "dashboard-title" || kind === "v2-palette" ? 3
    : kind === "chart-subtitles" || kind === "add-cross-filter" ? 2
    : 1;
  // Magnitude is only a final tiebreaker. A later review round must not
  // systematically promote structural/visual proposals over equally grounded
  // data, task, context, interaction, or workflow observations.
  void round;
  return base;
}

/** Safety gate for the backstop: would folding `tileId` into this critique's
 * multi-tile card actually apply there? Payload-free portable kinds (add-tooltip)
 * require the tile to have encodable fields (counted DEEP, so a composed KPI
 * sparkline whose fields live in its units is not wrongly excluded), so
 * applyTooltip produces a real tooltip rather than a silent no-op. edit-spec is
 * already gated by its identical-edit signature (both members validated on their
 * own tile) and apply re-sanitizes per tile, so no extra filter is applied here —
 * preserving the existing edit-spec backstop behavior byte-for-byte. */
function portableToTile(critique: Critique, tileId: string, specMap: SpecMap): boolean {
  if (PORTABLE_CONSOLIDATION_KINDS.has(critique.proposal.kind)) {
    return encodedFieldsDeep(specMap[tileId]).length > 0;
  }
  return true;
}

function mergeAndRank(
  values: Array<{ critique: Critique; finding: Finding }>,
  context: DashboardContext,
  limit: number,
  specMap: SpecMap,
  iterationContext?: IterationContext,
  preserveSolutionAlternatives = false,
): Array<{ critique: Critique; finding: Finding }> {
  const selected = new Map<string, { critique: Critique; finding: Finding }>();
  const scope = new Set(context.scope || []);
  for (const value of values) {
    const key = preserveSolutionAlternatives
      ? refinementAlternativeSlotKey(value)
      : critiqueSlotKey(value);
    const previous = selected.get(key);
    const valueIsDirect = value.critique.requestRelevance === "direct";
    const previousIsDirect = previous?.critique.requestRelevance === "direct";
    if (
      !previous ||
      (valueIsDirect && !previousIsDirect) ||
      (valueIsDirect === previousIsDirect &&
        supportWeight(value.critique) > supportWeight(previous.critique)) ||
      (valueIsDirect === previousIsDirect &&
        supportWeight(value.critique) === supportWeight(previous.critique) &&
        priorityWeight(value.critique.priority) > priorityWeight(previous.critique.priority))
    ) selected.set(key, value);
  }
  const deduped = [...selected.values()];
  const palette = deduped.filter((item) => item.critique.proposal.kind === "v2-palette" || item.critique.proposal.kind === "preserve-brand-palette");
  if (!preserveSolutionAlternatives && palette.length > 1) {
    const hasBrandConstraint = /brand/i.test(context.constraints || "");
    const preferred = palette.find((item) => item.critique.proposal.kind === (hasBrandConstraint ? "preserve-brand-palette" : "v2-palette")) || palette[0];
    for (const item of palette) {
      if (item !== preferred) {
        selected.delete(`${item.critique.object}|${item.critique.problem ?? ""}|${item.critique.tileId || "dashboard"}|${item.critique.proposal.kind}`);
      }
    }
  }
  // Severity-first ranking, aligned with the frontend scopeRank so the two
  // layers agree: direct answer → severity → grounding confidence → in-scope →
  // evidence count. This also governs which critiques survive the limit cut, so
  // severe findings are retained ahead of minor in-scope ones.
  // Genre emphasis is a LATE tiebreaker (after severity, grounding confidence,
  // and in-scope): among similarly ranked findings it retains
  // genre-relevant dimensions ahead of genre-peripheral ones when the review is
  // trimmed to `limit`. It never lets a low-severity finding outrank a severe
  // one, so it emphasizes without gating.
  const dashboardType = context.dashboardType;
  const ranked = [...selected.values()]
    .sort((a, b) =>
      Number(Boolean(b.critique.requestRelevance)) - Number(Boolean(a.critique.requestRelevance)) ||
      priorityWeight(b.critique.priority) - priorityWeight(a.critique.priority) ||
      supportWeight(b.critique) - supportWeight(a.critique) ||
      Number(scope.has(b.critique.dimension)) - Number(scope.has(a.critique.dimension)) ||
      dimensionEmphasis(dashboardType, b.critique.dimension) -
        dimensionEmphasis(dashboardType, a.critique.dimension) ||
      (b.critique.evidenceRefs?.length || 0) - (a.critique.evidenceRefs?.length || 0) ||
      proposalChangeMagnitude(b.critique, iterationContext?.round) -
        proposalChangeMagnitude(a.critique, iterationContext?.round));

  // Cross-tile consolidation backstop (deterministic): the SAME fix emitted once
  // per tile — because the model ignored the prompt's consolidation nudge —
  // collapses into ONE representative critique carrying every affected tile in
  // target.ref.tiles, so the author sees a single card that applies everywhere.
  // Generalized beyond edit-spec via isConsolidatableKind: any tile-portable
  // kind is eligible (add-tooltip today; edit-spec keeps its exact prior
  // behavior). Keyed on a tile-AGNOSTIC signature: object|problem|kind|payload,
  // where the payload is the sanitized edits for edit-spec (so genuinely
  // different edits never merge) and empty for payload-free portable kinds (so
  // their identity is object|problem|kind). Only executable critiques on a real
  // tile are eligible. Before a member's tile is folded in, portableToTile
  // confirms the fix truly applies there (e.g. add-tooltip needs encodable
  // fields), so a consolidated card never lists a tile the fix would no-op.
  // A direct answer to an author request is never folded away as a
  // non-representative member (it must survive to carry the answer). The
  // representative is the highest-ranked member (ranked is already
  // severity-sorted), so its prose/priority win. This runs before the limit cut
  // below, so collapsing N→1 frees slots for other critiques. Advisory and
  // non-consolidatable critiques are never touched, so the reserve/cap math
  // below is unaffected. canonicalJson (not JSON.stringify) makes the edit-spec
  // signature order-insensitive for each edit's value payload.
  const consolidationGroups = new Map<string, { critique: Critique; finding: Finding }>();
  const consolidatedAway = new Set<{ critique: Critique; finding: Finding }>();
  for (const item of ranked) {
    const proposal = item.critique.proposal;
    if (!isConsolidatableKind(proposal.kind) || proposal.mode !== "executable" || !item.critique.tileId) continue;
    const signature = consolidationSignature(item.critique);
    const representative = consolidationGroups.get(signature);
    if (!representative) {
      // A direct answer MAY seed a group and become the representative — its prose
      // and answer are then what the single card carries, and an identical
      // non-direct duplicate folds into it (exactly the pre-generalization path,
      // since ranking already sorts direct critiques first). It must only never be
      // folded AWAY as a non-representative member, which the fold guard below
      // enforces.
      consolidationGroups.set(signature, item);
      continue;
    }
    // A direct answer must never be dropped as a consolidated member — leave it
    // standalone so its author-requested answer survives (mirrors the dedup
    // protection above and the conflict-filter exemption below). It can still be a
    // representative via the seed branch above.
    if (item.critique.requestRelevance === "direct") continue;
    // Only fold this tile in if the fix truly applies there; otherwise leave the
    // duplicate as its own card rather than claim a tile the fix would no-op.
    if (!portableToTile(item.critique, item.critique.tileId, specMap)) continue;
    const repRef = representative.critique.target.ref as Record<string, unknown>;
    const itemRef = item.critique.target.ref as Record<string, unknown>;
    // The folded member may itself already be a multi-tile card (the model-obeys
    // path names several tiles for one fix). Merge in ALL of its tiles, not just
    // its representative tileId, so a sibling it already validated is never
    // silently dropped when it folds into another group's representative. Each of
    // its extra tiles is re-checked with portableToTile so the merged card still
    // never lists a tile the fix would no-op on (edit-spec always passes, having
    // already validated identical edits per tile at generation).
    const itemTiles = [
      ...(Array.isArray(itemRef.tiles) ? itemRef.tiles as string[] : []),
      ...(item.critique.tileId ? [item.critique.tileId] : []),
    ].filter((candidate) => portableToTile(item.critique, candidate, specMap));
    const tiles = new Set<string>([
      ...(Array.isArray(repRef.tiles) ? repRef.tiles as string[] : []),
      ...(representative.critique.tileId ? [representative.critique.tileId] : []),
      ...itemTiles,
    ]);
    if (tiles.size > 1) {
      repRef.tiles = [...tiles];
      (representative.finding.target.ref as Record<string, unknown>).tiles = [...tiles];
    }
    consolidatedAway.add(item);
  }
  const consolidated = consolidatedAway.size
    ? ranked.filter((item) => !consolidatedAway.has(item))
    : ranked;

  // Cap advisory workflow/other guidance, then allocate full-review slots across
  // critique families. This is a RETENTION rule over already validated evidence:
  // it cannot create a missing data/task/context/process issue. It prevents a
  // long run of executable chart/text/layout candidates from crowding out the
  // broader-lens candidates the model did ground. Focused/region reviews (limit
  // <= 4) remain strict relevance-ranked and do not use this breadth reserve.
  const advisory = consolidated
    .filter((item) => isAdvisoryCritique(item.critique))
    .slice(0, GUIDANCE_RESERVE);
  const permittedAdvisory = new Set(advisory);
  const eligible = consolidated.filter((item) =>
    !isAdvisoryCritique(item.critique) || permittedAdvisory.has(item)
  );
  if (limit <= 4) return eligible.slice(0, limit);

  const analytical = eligible.filter((item) => ANALYTICAL_BRANCHES.has(substantiveLens(item.critique)));
  const otherBroader = eligible.filter((item) =>
    !PRESENTATION_BRANCHES.has(substantiveLens(item.critique)) &&
    !ANALYTICAL_BRANCHES.has(substantiveLens(item.critique)) &&
    !isAdvisoryCritique(item.critique)
  );
  const reserved: typeof eligible = [];
  // Start with distinct analytical dimensions so three near-identical data
  // notes do not masquerade as breadth, then include one real Guidance item.
  const seenDimensions = new Set<Dimension>();
  for (const item of analytical) {
    if (reserved.length >= 3) break;
    const lens = substantiveLens(item.critique);
    if (seenDimensions.has(lens)) continue;
    seenDimensions.add(lens);
    reserved.push(item);
  }
  if (advisory.length && reserved.length < BROADER_LENS_RESERVE) reserved.push(advisory[0]);
  for (const item of [...analytical, ...otherBroader, ...advisory]) {
    if (reserved.length >= BROADER_LENS_RESERVE) break;
    if (!reserved.includes(item)) reserved.push(item);
  }

  const kept = new Set(reserved);
  for (const item of eligible) {
    if (kept.size >= limit) break;
    kept.add(item);
  }
  // Emit in the original ranked order so display ordering still reflects severity.
  return eligible.filter((item) => kept.has(item)).slice(0, limit);
}

export interface CriteriaReviewResult {
  findings: Finding[];
  critiques: Critique[];
  diagnoses: Diagnosis[];
  /** Standout positive observations, grounded and produced independently of
   * critiques (so they can exist for a scope with zero critiques). */
  strengths: Strength[];
  contextSnapshotId: string;
  reviewScope: ReviewScope;
  evidencePacket: EvidencePacket;
  fallbackReason?: string;
  /** Plain-language direct answer to a focused/selected-region request. Present
   * whenever the model answered the author's question, even if no standard
   * critique survived validation. */
  answer?: string;
  /** Critiques the conflict filter removed because they conflict with an
   * uploaded design document's hard constraints. For dev observability only —
   * the author-facing `critiques` array already omits them. */
  droppedByConstraint?: ConflictDrop[];
  /** Evaluation-only stage counts. Emitted through the trace when explicitly
   * enabled, and never included in the author-facing CritiqueResponse. */
  pipelineDiagnostics?: Record<string, unknown>;
}

export async function discoverDashboardCritiques(
  specMap: SpecMap,
  context: DashboardContext,
  board: BoardMeta | undefined,
  client: LLMClient | undefined,
  onToken?: (token: string) => void,
  region?: LocalCritiqueRegion,
  focus?: FocusedReviewRequest,
  interactionState?: Record<string, unknown>,
  /** Model sampling temperature for the review draft. The engine clamps the
   * author-set request value before passing it here; moderate exploration helps
   * the model synthesize beyond repeated catalog defaults. */
  temperature: number = 0.4,
  savedRationales: SavedCritiqueRationale[] = [],
  /** Hard constraints from an uploaded design document. When present, ranked
   * critiques that conflict with them are silently dropped before the response.
   * Omitted → no filtering, so every existing caller is unchanged. */
  constraintSet?: ConstraintSet,
  iterationContext?: IterationContext,
  designDocumentText?: string,
): Promise<CriteriaReviewResult> {
  if (!client?.available()) throw new Error("LLM_REQUIRED: the unified review engine requires a configured model");
  if (region && focus) throw new Error("REVIEW_SCOPE_CONFLICT: use either a canvas region or a full-dashboard focused request");
  const scoped = scopeLocalReviewInput(specMap, board, region);
  const normalizedFocus = normalizeFocusedReview(focus, specMap, board);
  const reviewScope: ReviewScope = scoped.region ? "selected-region" : normalizedFocus ? "focused" : "full";
  const snapshot = buildContextSnapshot(context);
  const packet = buildEvidencePacket(scoped.specMap, scoped.board, interactionState);
  const grounding = determineGroundingAvailability(snapshot);

  let response: JsonObject;
  let fallbackReason: string | undefined;
  try {
    response = await client.completeJson<JsonObject>(
      dashboardReviewUser(
        snapshot,
        packet,
        grounding,
        scoped.region,
        normalizedFocus,
        savedRationales,
        iterationContext,
        constraintSet,
        designDocumentText,
      ),
      { system: dashboardReviewSystem(reviewScope), temperature, maxTokens: 9000, onToken },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (reviewScope !== "full" || !packet.detectorFindings.length) {
      throw new Error(`LLM_CALL_FAILED: ${message}`);
    }
    fallbackReason = message;
    response = { diagnoses: [], critiques: [] };
  }

  const rawDiagnoses = Array.isArray(response.diagnoses) ? response.diagnoses : [];
  const rawCritiques = Array.isArray(response.critiques) ? response.critiques.slice(0, 24) : null;
  if (!rawCritiques) throw new Error("LLM_GUARDRAIL_FAILED: response did not contain a critiques array");
  const boardAlreadyHasKpis = packet.board.hasKpis || hasEmbeddedKpis(packet.specMap, packet.board);
  const reviewableRawCritiques = rawCritiques.filter((item) =>
    !(boardAlreadyHasKpis && text(object(object(item).proposal).kind) === "add-kpis")
  );

  let diagnoses = rawDiagnoses
    .map((raw) => parseDiagnosis(raw, packet, snapshot, reviewableRawCritiques))
    .filter((diagnosis): diagnosis is Diagnosis => Boolean(diagnosis));
  const diagnosisByKey = new Map<string, Diagnosis>();
  for (const diagnosis of diagnoses) {
    const key = comboKey(diagnosis.object, diagnosis.problem);
    const previous = diagnosisByKey.get(key);
    if (!previous || (diagnosis.outcome === "evaluated_issue" && previous.outcome !== "evaluated_issue")) {
      diagnosisByKey.set(key, diagnosis);
    }
  }

  // Standout positive observations. Parsed and grounded independently of the
  // critique pipeline, so a scope that produces zero critiques can still return
  // strengths rendered as inline positive cards in their dimension groups.
  // Ungrounded praise is dropped by the gate.
  const rawStrengths = Array.isArray(response.strengths) ? response.strengths.slice(0, 12) : [];
  const narrowedScope = reviewScope === "full" ? narrowedFeedbackScope(context) : null;
  const strengths = rawStrengths
    .map((raw, index) => validateStrength(raw, index, packet, snapshot, reviewScope))
    .filter((item): item is Strength => Boolean(item))
    .filter((item) => !narrowedScope || narrowedScope.has(item.dimension));

  // The UI renders strengths beside critiques. Cap ordinary full-review
  // critiques at eleven so two grounded strengths keep the visible review near
  // the study target of 12–13 cards without hiding lower-priority items later.
  const solutionRefinement = normalizedFocus?.purpose === "solution-refinement";
  const resultLimit = reviewScope === "full" ? 11 : solutionRefinement ? 3 : 4;
  const authorRequest = scoped.region?.request || normalizedFocus?.request;
  const requestContract = scoped.region?.requestContract || normalizedFocus?.requestContract;
  const focusPurpose = normalizedFocus?.purpose;
  const validated = reviewableRawCritiques
    .map((item, index) =>
      validateCritique(
        item,
        index,
        diagnosisByKey,
        packet,
        snapshot,
        reviewScope,
        authorRequest,
        requestContract,
        focusPurpose,
      )
    )
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const firstPassValidatedCount = validated.length;
  let secondPassRawCount = 0;
  let secondPassValidatedCount = 0;
  let secondPassStrengthCount = 0;
  let coveragePassCalls = 0;
  // ── Lever I: adaptive discovery recovery (full reviews only) ──────────────
  // The first pass reliably surfaces the most salient handful of issues, then
  // can stop short of the 8–12 a rich multi-view board supports — the ceiling
  // is GENERATION, not the executable gate (which now clears ~0.9 of critiques).
  // One additional call — and, only while the result remains sparse, at most one
  // final recovery call — uses the SAME evidence and grounding/sanitize/compile
  // gates to ask for genuinely distinct issues the earlier passes left on the
  // table. Every recovery call is told what is already covered. It is
  // best-effort: a failure here never sinks the run (pass one already produced a
  // valid review), and mergeAndRank dedupes any overlap by slot + payload. It is
  // gated on an explicit coverage experiment OR adaptively when the production
  // server sees too few validated candidates OR a one-family review with little
  // analytical/contextual/workflow coverage or no grounded strength. Adaptive
  // calls are bounded to the small number of missing count/breadth slots and
  // keep every normal quality/safety gate; library/test callers remain
  // single-pass by default.
  // Judge + executable preflight can legitimately remove several grounded
  // drafts or a document constraint can remove a supported candidate. Target
  // eleven pre-constraint candidates so the visible mix can stay near 12–13
  // cards once two grounded strengths are included.
  const adaptiveCoverage = process.env.RE_API_ADAPTIVE_COVERAGE === "1" &&
    reviewCoverageNeedsRecovery(validated.map((item) => item.critique), strengths);
  if (
    reviewScope === "full" &&
    !normalizedFocus &&
    !scoped.region &&
    (process.env.RE_API_SECOND_PASS === "1" || adaptiveCoverage)
  ) {
    // A normal rich board gets one recovery call. A second call costs another
    // full model latency and is reserved for a genuinely sparse first pass (<5),
    // where one bounded recovery cannot plausibly reach a useful review. This
    // keeps the usual 12–13 visible-card target (critiques + strengths) without
    // making every balanced review wait through three model rounds.
    const maxCoveragePasses = adaptiveCoverage && validated.length < 5 ? 2 : 1;
    for (let coveragePass = 1; coveragePass <= maxCoveragePasses; coveragePass += 1) {
      if (
        coveragePass > 1 &&
        !reviewCoverageNeedsRecovery(validated.map((item) => item.critique), strengths)
      ) break;
      const covered = validated.map((item) => ({
        object: item.critique.object || "component",
        tileId: item.critique.tileId ?? null,
        dimension: item.critique.dimension,
        lens: substantiveLens(item.critique),
        title: item.critique.title,
      }));
      const coveredStrengths = strengths.map((item) => ({
        object: item.object,
        tileId: item.tileId ?? null,
        dimension: item.dimension,
        lens: substantiveLens(item),
        title: item.title,
      }));
      try {
        coveragePassCalls += 1;
        const recoveryLimit = coverageRecoveryLimit(validated.map((item) => item.critique));
        const secondResponse = await client.completeJson<JsonObject>(
          `${dashboardReviewUser(snapshot, packet, grounding, undefined, undefined, savedRationales, iterationContext, constraintSet, designDocumentText)}\n\n${secondPassDirective(covered, recoveryLimit, coveredStrengths)}`,
          { system: DASHBOARD_REVIEW_SYSTEM, temperature, maxTokens: 4500, onToken },
        );
        const secondRawDiagnoses = Array.isArray(secondResponse.diagnoses) ? secondResponse.diagnoses : [];
        const secondRawCritiques = Array.isArray(secondResponse.critiques) ? secondResponse.critiques.slice(0, 24) : [];
        const secondRawStrengths = Array.isArray(secondResponse.strengths) ? secondResponse.strengths.slice(0, 6) : [];
        secondPassRawCount += secondRawCritiques.length;
        // Merge recovery diagnoses so their critiques get the same OPTIONAL
        // grounding backfill pass-one critiques do. A missing diagnosis is
        // backfill only, never an admission gate, so this can only help.
        for (const raw of secondRawDiagnoses) {
          const parsed = parseDiagnosis(raw, packet, snapshot, secondRawCritiques);
          if (!parsed) continue;
          const key = comboKey(parsed.object, parsed.problem);
          const previous = diagnosisByKey.get(key);
          if (!previous || (parsed.outcome === "evaluated_issue" && previous.outcome !== "evaluated_issue")) {
            diagnosisByKey.set(key, parsed);
          }
        }
        const secondReviewable = secondRawCritiques.filter((item) =>
          !(boardAlreadyHasKpis && text(object(object(item).proposal).kind) === "add-kpis")
        );
        // Offset ids by recovery pass so they never collide with pass one or
        // another recovery call.
        const secondValidated = secondReviewable
          .map((item, i) =>
            validateCritique(
              item,
              coveragePass * 1000 + i,
              diagnosisByKey,
              packet,
              snapshot,
              reviewScope,
              authorRequest,
              requestContract,
              focusPurpose,
            ))
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
        secondPassValidatedCount += secondValidated.length;
        validated.push(...secondValidated);
        const knownStrengths = new Set(strengths.map(strengthSignature));
        let addedStrengths = 0;
        for (let i = 0; i < secondRawStrengths.length; i += 1) {
          const parsed = validateStrength(
            secondRawStrengths[i],
            coveragePass * 1000 + i,
            packet,
            snapshot,
            reviewScope,
          );
          if (!parsed || (narrowedScope && !narrowedScope.has(parsed.dimension))) continue;
          const signature = strengthSignature(parsed);
          if (knownStrengths.has(signature)) continue;
          knownStrengths.add(signature);
          strengths.push(parsed);
          addedStrengths += 1;
        }
        secondPassStrengthCount += addedStrengths;
        if (!secondValidated.length && !addedStrengths) break;
      } catch {
        // Coverage recovery is best-effort; its failure never sinks pass one.
        break;
      }
    }
  }
  // A focused/selected-region ask carries an explicit author question. The
  // plain-language `answer` is a response to that question, not a grounded
  // critique, so salvage it from the raw model output even when the critique
  // that carried it fails the grounding gates. This lets a narrow ask always
  // give the author a direct answer (with visual feedback) instead of failing
  // the whole run when no standard critique survives.
  const rawAnswer: string | undefined = authorRequest
    ? rawCritiques
      .map((raw) => text(object(raw).answer))
      .find((value): value is string => Boolean(value)) || undefined
    : undefined;
  if (reviewableRawCritiques.length && !validated.length && !rawAnswer && !authorRequest) {
    throw new Error("LLM_GUARDRAIL_FAILED: no critique passed object, evidence, context, and grounding validation");
  }

  // Genre lens: some deterministic detector defaults are irrelevant for the
  // dashboard's genre (e.g. an analytical dashboard has no takeaway obligation,
  // so the takeaway/subtitle detectors should not manufacture a default). This
  // gates only the reliability-net template, not the codebook mapping — the LLM
  // may still raise the issue when the evidence genuinely supports it.
  const suppressedDetectors = suppressedDetectorsFor(snapshot.values.dashboardType);
  const deterministic = reviewScope === "full"
    ? packet.detectorFindings
      .map((finding) => {
        if (suppressedDetectors.has(finding.kind)) return null;
        const mapping = DETECTOR_DIAGNOSIS[finding.kind];
        if (!mapping) return null;
        const modelDiagnosis = diagnosisByKey.get(comboKey(mapping.object, mapping.problem)) ||
          diagnosisByKey.get(comboKey(mapping.object));
        if (rawDiagnoses.length && modelDiagnosis?.outcome !== "evaluated_issue") return null;
        return detectorFallbackCandidate(finding, snapshot, reviewScope);
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];
  const coveredLocations = new Set(
    validated
      .filter((item) => item.critique.supportStatus === "validated")
      .map(critiqueLocationKey)
  );
  const coveredExecutableRemedies = new Set(
    validated
      .filter((item) => item.critique.supportStatus === "validated")
      .map(executableRemedyLocationKey)
      .filter(Boolean)
  );
  const uncoveredFallback = deterministic.filter((item) =>
    !coveredLocations.has(critiqueLocationKey(item)) &&
    !coveredExecutableRemedies.has(executableRemedyLocationKey(item))
  );
  const scopedFallback = uncoveredFallback.filter((item) =>
    !narrowedScope || narrowedScope.has(item.critique.dimension)
  );
  const fallback = fallbackReason || reviewableRawCritiques.length === 0
    ? scopedFallback
    : detectorSafetyNet(scopedFallback, DETECTOR_SAFETY_NET_LIMIT);
  if (fallback.length && !rawDiagnoses.length) {
    diagnoses = [...diagnoses, ...fallback.map((item) => item.diagnosis)];
  }
  const fallbackLocations = new Set(fallback.map(critiqueLocationKey));
  const modelCandidates = validated.filter((item) =>
    item.critique.supportStatus !== "tentative" ||
    !fallbackLocations.has(critiqueLocationKey(item))
  );
  // The model prompt asks for only the selected branches, but enforce that
  // contract here as well. Deterministic fallbacks and model output both pass
  // through this gate, so unchecked dimensions cannot reappear.
  const priorSignatures = new Set([
    ...(iterationContext?.applied || []).map((item) => item.signature),
    ...(iterationContext?.rejectedSignatures || []),
  ].filter(Boolean));
  const candidates = [...modelCandidates, ...fallback]
    .filter((item) => !narrowedScope || narrowedScope.has(item.critique.dimension));
  if (
    narrowedScope &&
    !candidates.length &&
    !strengths.length &&
    (!iterationContext || iterationContext.round <= 1)
  ) {
    throw new Error(
      "LLM_GUARDRAIL_FAILED: response contained no grounded critique or strength for the selected Feedback Scope",
    );
  }
  // A surviving direct critique is preferred, but a focused/region request is
  // never allowed to disappear: the post-filter guidance fallback below
  // supplies an honest card and answer when validation removed every candidate.
  // The primary review is asked to encode every component-level fix as a real
  // proposal, but the model still sometimes leaves a grounded, component-level
  // fix as prose. One focused follow-up call asks it to encode those own
  // suggestions as edit-spec edits; the engine sanitizes + compile-checks them
  // and promotes only survivors — so a component fix runs the full pipeline
  // (diagnose -> present -> implement) rather than stalling as guidance.
  await repairGuidanceToExecutable(candidates, packet, client);
  const fallbackCandidates = new Set<object>(fallback);
  const novelCandidates = candidates.filter((item) =>
    fallbackCandidates.has(item) ||
    item.critique.requestRelevance === "direct" ||
    !priorSignatures.has(iterationProposalSignature(item.critique))
  );
  const ranked = mergeAndRank(
    novelCandidates,
    context,
    resultLimit,
    packet.specMap,
    iterationContext,
    solutionRefinement,
  );

  // A compact judge checks the part deterministic validators cannot: whether a
  // safe executable proposal actually resolves its critique with a visible,
  // dashboard-specific change. The running server opts into this quality gate;
  // library callers keep an exact single-model-call contract unless they opt in.
  const qualityDecisions = process.env.RE_API_SOLUTION_JUDGE === "1"
    ? await judgeSolutionQuality(ranked, packet, context, reviewScope, requestContract, client)
    : new Map();
  const qualityVerdicts = { pass: 0, rewrite: 0, drop: 0, missing: 0 };
  for (const item of ranked) {
    const decision = qualityDecisions.get(item.critique.id);
    if (!decision) qualityVerdicts.missing += 1;
    else qualityVerdicts[decision.verdict] += 1;
  }
  const qualityChecked: typeof ranked = [];
  for (const item of ranked) {
    const decision = qualityDecisions.get(item.critique.id);
    if (!decision || decision.verdict === "pass") {
      qualityChecked.push(item);
      continue;
    }
    if (decision.verdict === "drop" || !decision.proposal || !decision.target) continue;

    const rewritten = validatedProposal(
      { proposal: decision.proposal, target: decision.target },
      item.critique.tileId,
      packet,
    );
    if (rewritten.proposal.mode !== "executable") continue;
    const targetRaw = object(decision.target);
    const replacement: Critique = {
      ...item.critique,
      suggestion: decision.suggestion || item.critique.suggestion,
      proposal: rewritten.proposal,
      target: {
        granularity: text(targetRaw.granularity) || item.critique.target.granularity,
        ref: rewritten.ref,
      },
    };
    if (SPEC_PREFLIGHT_PROPOSALS.has(replacement.proposal.kind)) {
      try {
        const outcome = await applyProposals(packet.specMap, [replacement], [replacement.id]);
        if (outcome.rollback.rolledBack || !outcome.changedTargets.length) continue;
      } catch {
        continue;
      }
    }
    item.critique = replacement;
    item.finding.proposalKind = replacement.proposal.kind;
    qualityChecked.push(item);
  }

  // Exercise the final, merged candidates through the real apply/compile path.
  // Running this after merge matters: a consolidated multi-tile fix is judged
  // as the one transaction the author will actually preview and apply.
  const preflighted: typeof ranked = [];
  for (const item of qualityChecked) {
    if (
      process.env.RE_API_PROPOSAL_PREFLIGHT !== "1" ||
      item.critique.proposal.mode !== "executable" ||
      !SPEC_PREFLIGHT_PROPOSALS.has(item.critique.proposal.kind)
    ) {
      preflighted.push(item);
      continue;
    }
    try {
      const outcome = await applyProposals(packet.specMap, [item.critique], [item.critique.id]);
      if (!outcome.rollback.rolledBack && outcome.changedTargets.length) {
        preflighted.push(item);
      } else if (outcome.rollback.rolledBack) {
        // The diagnosis can remain grounded even when its proposed JSON fails
        // the real compile/runtime-render gate. Keep the useful observation as
        // honest Guidance, but remove Accept Change so the UI can never call a
        // blank or invalid canvas "Applied". A pure no-op is still dropped below
        // because it indicates no visible change is needed.
        item.critique.proposal = {
          kind: "manual",
          mode: "guidance_only",
          diag: {
            final: "manual",
            demoted: true,
            reason: "proposal-runtime-validation",
            detail: outcome.rollback.reason,
          },
        };
        item.finding.proposalKind = "manual";
        preflighted.push(item);
      }
    } catch {
      // An unexpected preflight exception cannot authorize an Apply button.
      // Preserve the grounded diagnosis as Guidance rather than losing review
      // breadth because the implementation payload failed.
      item.critique.proposal = {
        kind: "manual",
        mode: "guidance_only",
        diag: { final: "manual", demoted: true, reason: "proposal-preflight-error" },
      };
      item.finding.proposalKind = "manual";
      preflighted.push(item);
    }
  }
  // Silently drop critiques that conflict with an uploaded design document's
  // hard constraints (e.g. a recolor when the brand palette is locked). A
  // critique that directly answers a focused/region ask is exempt. When no
  // constraintSet is supplied this returns `ranked` unchanged (byte-identical),
  // and a filter failure keeps every critique — it never fails the review.
  const { kept: filtered, dropped } = await filterConflictingCritiques(preflighted, constraintSet, client);
  // Prefer the answer already attached to a surviving direct critique so the
  // response-level answer stays consistent with what the card shows; otherwise
  // fall back to the salvaged raw answer.
  const directAnswer = filtered.find((item) => item.critique.requestRelevance === "direct")?.critique.answer;
  let answer = directAnswer || rawAnswer;
  const requestFallback = authorRequest &&
      !filtered.some((item) => item.critique.requestRelevance === "direct")
    ? requestGuidanceFallback(packet, snapshot, reviewScope, authorRequest, scoped.region, requestContract, answer)
    : null;
  if (requestFallback) answer = requestFallback.critique.answer;
  const finalCritiques = [
    ...filtered.map((item) => item.critique),
    ...(requestFallback ? [requestFallback.critique] : []),
  ];
  const finalStrengths = solutionRefinement
    ? []
    : selectStrengths(strengths, reviewScope === "full" ? 2 : 4);
  // Production prompts no longer ask the model to repeat every issue in a
  // separate diagnoses array. Preserve the research/trace contract by deriving
  // one diagnosis from each critique that actually survived grounding,
  // executable preflight, quality judging, and constraint filtering. This also
  // prevents rejected draft candidates from appearing as study provenance.
  if (!rawDiagnoses.length) {
    const finalByDiagnosis = new Map<string, Diagnosis>();
    for (const critique of finalCritiques) {
      if (!critique.object || !isObjectCode(critique.object)) continue;
      const problem = critique.problem && isProblemCode(critique.problem)
        ? critique.problem
        : undefined;
      const key = comboKey(critique.object, problem);
      if (finalByDiagnosis.has(key)) continue;
      finalByDiagnosis.set(key, {
        object: critique.object,
        ...(problem ? { problem } : {}),
        outcome: critique.diagnosisOutcome || "evaluated_issue",
        judgmentBasis: critique.judgmentBasis || [],
        priorWeight: critique.priorWeight || priorWeightFor(critique.object, problem),
        requiredContext: critique.requiredContext || [],
        contextStatus: critique.contextStatus || "not_applicable",
        evidenceRefs: critique.evidenceRefs || [],
        rationale: critique.rationale,
      });
    }
    diagnoses = [...finalByDiagnosis.values()];
  }
  return {
    findings: [
      ...filtered.map((item) => item.finding),
      ...(requestFallback ? [requestFallback.finding] : []),
    ],
    critiques: finalCritiques,
    diagnoses,
    strengths: finalStrengths,
    contextSnapshotId: snapshot.id,
    reviewScope,
    evidencePacket: packet,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(answer ? { answer } : {}),
    ...(dropped.length ? { droppedByConstraint: dropped } : {}),
    ...(process.env.RE_API_PIPELINE_DIAGNOSTICS === "1"
      ? {
          pipelineDiagnostics: {
            firstPassRaw: reviewableRawCritiques.length,
            firstPassValidated: firstPassValidatedCount,
            secondPassRaw: secondPassRawCount,
            secondPassValidated: secondPassValidatedCount,
            secondPassStrengths: secondPassStrengthCount,
            coveragePassCalls,
            deterministicFallback: fallback.length,
            candidatesBeforeRank: novelCandidates.length,
            ranked: ranked.length,
            qualityVerdicts,
            afterQualityJudge: qualityChecked.length,
            afterProposalPreflight: preflighted.length,
            droppedByConstraint: dropped.length,
            final: finalCritiques.length,
            finalStrengths: finalStrengths.length,
          },
        }
      : {}),
  };
}
