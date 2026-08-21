/**
 * Validate + content-address the intake model output into a ConstraintSet. The
 * model is untrusted: every field is coerced to its contract type and unknown
 * categories collapse to "other". The id is a stable content hash so an
 * unchanged document yields an unchanged id (mirrors evidence.ts snapshotId).
 */
import { createHash } from "node:crypto";
import type {
  ConstraintCategory,
  ConstraintSet,
  ConstraintSource,
  HardConstraint,
} from "../contracts.ts";

const CATEGORIES: ReadonlySet<ConstraintCategory> = new Set([
  "palette",
  "typography",
  "iconography",
  "layout",
  "format",
  "other",
]);

function str(value: unknown, limit = 600): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function stringArray(value: unknown, limit = 24): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item, 120)).filter(Boolean).slice(0, limit);
}

function category(value: unknown): ConstraintCategory {
  return typeof value === "string" && CATEGORIES.has(value as ConstraintCategory)
    ? (value as ConstraintCategory)
    : "other";
}

function confidence(value: unknown): HardConstraint["confidence"] {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function constraintValue(raw: unknown): HardConstraint["value"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const out: NonNullable<HardConstraint["value"]> = {};
  const colors = stringArray(source.colors);
  if (colors.length) out.colors = colors;
  if (str(source.scheme)) out.scheme = str(source.scheme, 120);
  if (typeof source.locked === "boolean") out.locked = source.locked;
  const fontFamilies = stringArray(source.fontFamilies);
  if (fontFamilies.length) out.fontFamilies = fontFamilies;
  if (str(source.iconStyle)) out.iconStyle = str(source.iconStyle, 120);
  if (str(source.iconSet)) out.iconSet = str(source.iconSet, 120);
  if (str(source.aspectRatio)) out.aspectRatio = str(source.aspectRatio, 40);
  if (str(source.grid)) out.grid = str(source.grid, 120);
  if (typeof source.regionsFixed === "boolean") out.regionsFixed = source.regionsFixed;
  return Object.keys(out).length ? out : undefined;
}

function constraintId(constraint: Omit<HardConstraint, "id">, index: number): string {
  const hash = createHash("sha256")
    .update(`${constraint.category}|${constraint.rule}|${constraint.sourceText}`)
    .digest("hex")
    .slice(0, 8);
  return `hc-${index + 1}-${hash}`;
}

function setId(constraints: HardConstraint[], sourceKind: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ sourceKind, constraints }))
    .digest("hex")
    .slice(0, 12);
  return `ct-${digest}`;
}

/** An empty (no-constraint) set for a source with no extractable rules. */
export function emptyConstraintSet(
  sourceKind: ConstraintSource["kind"],
  provenance: string,
): ConstraintSet {
  return { id: setId([], sourceKind), sourceKind, provenance, constraints: [] };
}

export function normalizeConstraintSet(
  raw: Record<string, unknown>,
  sourceKind: ConstraintSource["kind"],
  provenance: string,
): ConstraintSet {
  const rawConstraints = Array.isArray(raw?.constraints) ? raw.constraints : [];
  const constraints: HardConstraint[] = rawConstraints
    .map((entry) => {
      const source = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const rule = str(source.rule);
      const sourceText = str(source.sourceText, 800) || rule;
      if (!rule && !sourceText) return null;
      const value = constraintValue(source.value);
      const base = { category: category(source.category), rule: rule || sourceText, sourceText, confidence: confidence(source.confidence), ...(value ? { value } : {}) };
      return base as Omit<HardConstraint, "id">;
    })
    .filter((entry): entry is Omit<HardConstraint, "id"> => Boolean(entry))
    .slice(0, 40)
    .map((entry, index) => ({ id: constraintId(entry, index), ...entry }));
  return { id: setId(constraints, sourceKind), sourceKind, provenance, constraints };
}
