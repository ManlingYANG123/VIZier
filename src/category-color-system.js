// The 11 recommendation branches (RECOMMENDATION_BRANCHES in re_api's
// generate/recommendations.ts). A critique's `dimension` is the branch of its
// prescribed recommendation, so the display grouping, review scope, and chip
// color all key off these exact values. `accessibility` is no longer a branch;
// it travels as a crosscutting tag. Keep this order in lockstep with the engine.
export const CATEGORY_ORDER = [
  "chart",
  "color",
  "layout",
  "data",
  "text",
  "visual design",
  "cognition",
  "context",
  "interaction",
  "task",
  "design process",
];

// Five top-level clusters. The labels come from the object codebook
// (slack_codebook/object_groups.csv, mirrored in re_api review-data.ts
// OBJECTS[].category). The Feedback Scope chips are the 11 recommendation
// *branches* (critique.dimension), not object codes, so each branch is placed in
// the cluster its subject-matter belongs to — a DISPLAY grouping only: every
// chip keeps its own branch value, so scope semantics and ranking (scopeRank)
// are unchanged. The one judgment call is `context` (not an object code): its
// leaves are metadata-like, so it sits in Data.
//
// COLOR: each cluster carries ONE hue, applied everywhere its member dimensions
// appear — Feedback Scope chips, the Category Mix bar, and every critique
// card/group/accent — so the whole critique UI reads in five color families
// rather than eleven. `color` is the readable text/border/accent value (AA on
// white); `soft` is the chip fill; `bar` is a brighter fill for the thin
// Category Mix bar so it reads vivid rather than muddy. Hues are spread across
// the wheel (blue / emerald / rose / violet / amber); the human label stays the
// primary cue.
export const CLUSTERS = [
  { key: "visuals", label: "Visuals", color: "#2f6bd8", soft: "#eef3fd", bar: "#3b82f6",
    branches: ["chart", "color", "layout", "text", "visual design"] },
  { key: "data", label: "Data", color: "#0e7c5a", soft: "#e7f6f0", bar: "#10b981",
    branches: ["data", "context"] },
  { key: "interact", label: "Interact", color: "#c02d70", soft: "#fce7f0", bar: "#ec4899",
    branches: ["interaction"] },
  { key: "clarity", label: "Clarity", color: "#6d43cf", soft: "#f1ecfd", bar: "#8b5cf6",
    branches: ["cognition"] },
  { key: "purpose", label: "Purpose", color: "#a55a0a", soft: "#fbf0df", bar: "#f59e0b",
    branches: ["task", "design process"] },
];

export const CLUSTER_ORDER = CLUSTERS.map((cluster) => cluster.key);

// The Feedback Scope panel reads label + branches (and ignores the color fields).
// Short single-word labels so each cluster renders as one inline-label row.
export const SCOPE_CLUSTERS = CLUSTERS;

const DIMENSION_TO_CLUSTER = Object.fromEntries(
  CLUSTERS.flatMap((cluster) => cluster.branches.map((branch) => [branch, cluster])),
);

/** The cluster object a recommendation branch belongs to, or null (custom/other). */
export function clusterForDimension(dimension) {
  return DIMENSION_TO_CLUSTER[dimension] || null;
}

/** A cluster's presentation by key, or null when the key is not a cluster. */
export function clusterPresentation(key) {
  return CLUSTERS.find((cluster) => cluster.key === key) || null;
}

// Human labels per branch — the label still distinguishes dimensions that now
// share a cluster hue (e.g. Charts vs Layout, both Visuals blue).
const DIMENSION_LABELS = {
  chart: "Charts",
  color: "Color",
  layout: "Layout",
  data: "Data",
  text: "Text",
  "visual design": "Visual Design",
  cognition: "Cognition",
  context: "Context",
  interaction: "Interactivity",
  task: "Task",
  "design process": "Design Process",
};

// Every branch inherits its cluster's hue (color/soft/bar) and carries its own
// label + cluster key. Consumed via categoryPresentation() wherever a dimension
// is shown, so one hue per cluster flows through the entire critique UI.
export const CATEGORY_PRESENTATIONS = Object.fromEntries(
  CATEGORY_ORDER.map((dimension) => {
    const cluster = DIMENSION_TO_CLUSTER[dimension];
    return [dimension, {
      label: DIMENSION_LABELS[dimension],
      color: cluster.color,
      soft: cluster.soft,
      bar: cluster.bar,
      cluster: cluster.key,
    }];
  }),
);

export const CATEGORY_COLORS = Object.fromEntries(
  Object.entries(CATEGORY_PRESENTATIONS).map(([key, value]) => [key, value.color]),
);

const CUSTOM_SCOPE_PALETTE = [
  { color: "#8a4b31", soft: "#f9f0eb" },
  { color: "#2f6875", soft: "#edf5f7" },
  { color: "#7155a4", soft: "#f4f0fa" },
  { color: "#7a611f", soft: "#f7f3e8" },
  { color: "#984363", soft: "#faeef3" },
  { color: "#3f684e", soft: "#edf5f0" },
];

function normalizedLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stableHash(value) {
  return [...normalizedLabel(value).toLowerCase()]
    .reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 7);
}

export function customScopeKey(label) {
  const slug = normalizedLabel(label)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `custom:${slug || "scope"}`;
}

export function customScopePresentation(label) {
  const normalized = normalizedLabel(label) || "Custom scope";
  const palette = CUSTOM_SCOPE_PALETTE[stableHash(normalized) % CUSTOM_SCOPE_PALETTE.length];
  return { label: normalized, ...palette };
}

export function categoryPresentation(category, customTypes = []) {
  if (CATEGORY_PRESENTATIONS[category]) return CATEGORY_PRESENTATIONS[category];
  const normalizedCategory = normalizedLabel(category);
  const customLabel = customTypes.find((label) =>
    customScopeKey(label) === normalizedCategory ||
    normalizedLabel(label).toLowerCase() === normalizedCategory.toLowerCase());
  const label = customLabel || normalizedCategory.replace(/^custom:/, "").replace(/-/g, " ");
  return customScopePresentation(label);
}

export function scopeMatchesDimension(scope = [], dimension, customTypes = []) {
  const normalizedDimension = normalizedLabel(dimension).toLowerCase();
  return scope.includes(dimension) || customTypes.some((label) =>
    scope.includes(customScopeKey(label)) &&
    normalizedLabel(label).toLowerCase() === normalizedDimension);
}

/** Full selections do not filter existing results. A proper subset is strict;
 * custom concerns travel through the engine's uncatalogued "other" dimension. */
export function feedbackScopeFiltersDimension(scope = [], dimension, customTypes = []) {
  if (!scope.length) return true;
  const selectedStandard = new Set(scope.filter((item) => CATEGORY_ORDER.includes(item)));
  if (selectedStandard.size === CATEGORY_ORDER.length) return true;
  if (dimension === "other" && scope.some((item) => String(item).startsWith("custom:"))) return true;
  return scopeMatchesDimension(scope, dimension, customTypes);
}
