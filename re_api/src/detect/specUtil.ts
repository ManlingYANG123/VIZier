/**
 * Structural helpers for reading Vega-Lite specs. Detectors operate on spec
 * *structure* only (no rendering, no LLM), which is what makes findings
 * deterministic and machine-checkable.
 */
import type { VegaLiteSpec } from "../contracts.ts";

export type FieldType = "nominal" | "ordinal" | "quantitative" | "temporal" | undefined;

export interface EncodedField {
  channel: string;
  field: string;
  type: FieldType;
}

export type SpecPath = Array<string | number>;

export interface UnitSpecEntry {
  spec: VegaLiteSpec;
  path: SpecPath;
}

/** Positional / color channels a cross-filter source would realistically use. */
const SOURCE_CHANNELS = new Set(["x", "y", "color", "theta", "column", "row"]);
const SELECTABLE_MARKS = new Set(["bar", "rect", "point", "circle", "square", "arc"]);
const COMPOSITION_KEYS = ["layer", "hconcat", "vconcat", "concat"] as const;

/**
 * Return every executable unit spec in a Vega-Lite tree and its address. A
 * simple unit spec is returned at path []; composed dashboards return their
 * nested marks (for example ["vconcat", 0, "layer", 1]).
 */
export function unitSpecs(spec: VegaLiteSpec): UnitSpecEntry[] {
  const out: UnitSpecEntry[] = [];

  function visit(node: unknown, path: SpecPath): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const candidate = node as VegaLiteSpec;
    if (candidate.mark !== undefined) out.push({ spec: candidate, path });
    for (const key of COMPOSITION_KEYS) {
      const children = candidate[key] as unknown;
      if (!Array.isArray(children)) continue;
      children.forEach((child, index) => visit(child, [...path, key, index]));
    }
    const nested = candidate.spec as unknown;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      visit(nested, [...path, "spec"]);
    }
  }

  visit(spec, []);
  return out;
}

/** Resolve a unit-spec path previously returned by unitSpecs. */
export function specAtPath(spec: VegaLiteSpec, path: SpecPath): VegaLiteSpec | null {
  let node: unknown = spec;
  for (const segment of path) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node && typeof node === "object" && !Array.isArray(node)
    ? node as VegaLiteSpec
    : null;
}

/** Return the mark type of a unit spec ("bar", "line", "arc", ...) or "". */
export function markType(spec: VegaLiteSpec): string {
  const m = spec.mark as unknown;
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && typeof (m as Record<string, unknown>).type === "string") {
    return (m as Record<string, string>).type;
  }
  return "";
}

/** True when a unit already carries a tooltip — via the encoding channel or a
 * truthy mark.tooltip. Shared by the missing-tooltip detector (to skip units
 * that already surface values) and applyTooltip (to add hover affordance without
 * clobbering an existing tooltip). */
export function hasTooltip(spec: VegaLiteSpec): boolean {
  const enc = spec.encoding as Record<string, unknown> | undefined;
  if (enc && enc.tooltip !== undefined && enc.tooltip !== null && enc.tooltip !== false) {
    return true;
  }
  const m = spec.mark as unknown;
  if (m && typeof m === "object") {
    const t = (m as Record<string, unknown>).tooltip;
    if (t !== undefined && t !== false && t !== null) return true;
  }
  return false;
}

/** True when the mark renders points (mark.point truthy or a filled object). */
export function markHasPoint(spec: VegaLiteSpec): boolean {
  const m = spec.mark as unknown;
  if (!m || typeof m !== "object") return false;
  const point = (m as Record<string, unknown>).point;
  if (point === true) return true;
  if (point && typeof point === "object") return true;
  return false;
}

/** Single-valued encoding channels with a `field` (skips arrays like tooltip). */
export function encodedFields(spec: VegaLiteSpec): EncodedField[] {
  const enc = spec.encoding as Record<string, unknown> | undefined;
  if (!enc || typeof enc !== "object") return [];
  const out: EncodedField[] = [];
  for (const [channel, defRaw] of Object.entries(enc)) {
    if (!defRaw || typeof defRaw !== "object" || Array.isArray(defRaw)) continue;
    const def = defRaw as Record<string, unknown>;
    if (typeof def.field === "string") {
      out.push({ channel, field: def.field, type: def.type as FieldType });
    }
  }
  return out;
}

/** Encoded fields across every unit spec in a composed Vega-Lite tree. */
export function encodedFieldsDeep(spec: VegaLiteSpec): EncodedField[] {
  const entries = unitSpecs(spec);
  const units = entries.length ? entries : [{ spec, path: [] }];
  return units.flatMap((entry) => encodedFields(entry.spec));
}

/** Column names present in inline `data.values`. */
export function dataColumns(spec: VegaLiteSpec): Set<string> {
  const data = spec.data as Record<string, unknown> | undefined;
  const values = data?.values as unknown;
  if (!Array.isArray(values) || values.length === 0) return new Set();
  const first = values[0];
  if (!first || typeof first !== "object") return new Set();
  return new Set(Object.keys(first as Record<string, unknown>));
}

/** Inline-data columns declared at any level of a composed spec. */
export function dataColumnsDeep(spec: VegaLiteSpec): Set<string> {
  const columns = new Set<string>();
  function visit(node: unknown): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const column of dataColumns(node as VegaLiteSpec)) columns.add(column);
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(spec);
  return columns;
}

/** True if the tile encodes `field` on a positional/color channel as a category. */
export function encodesCategory(spec: VegaLiteSpec, field: string): boolean {
  return encodedFieldsDeep(spec).some(
    (e) =>
      e.field === field &&
      SOURCE_CHANNELS.has(e.channel) &&
      (e.type === "nominal" || e.type === "ordinal"),
  );
}

/**
 * True when a categorical field is carried by a discrete mark that presents a
 * credible click target. A line encoding Month is not automatically a
 * cross-filter affordance; a bar/point/arc encoding Month is.
 */
export function encodesSelectableCategory(spec: VegaLiteSpec, field: string): boolean {
  return unitSpecs(spec).some(({ spec: unit }) =>
    SELECTABLE_MARKS.has(markType(unit)) &&
    !Object.values((unit.encoding as Record<string, unknown> | undefined) || {}).some((definition) => {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) return false;
      const range = ((definition as Record<string, unknown>).scale as
        Record<string, unknown> | undefined)?.range;
      return Array.isArray(range) && range.some((value) =>
        typeof value === "string" && value.toLowerCase() === "transparent");
    }) &&
    encodedFields(unit).some(
      (entry) =>
        entry.field === field &&
        SOURCE_CHANNELS.has(entry.channel) &&
        (entry.type === "nominal" || entry.type === "ordinal"),
    ));
}

/** Observable/domain values for a field, used to reject same-name mismatches. */
export function fieldDomainValues(spec: VegaLiteSpec, field: string): Set<unknown> {
  const values = new Set<unknown>();
  function visit(node: unknown): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    const rows = (record.data as Record<string, unknown> | undefined)?.values;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const value = (row as Record<string, unknown>)[field];
        if (value !== undefined && value !== null) values.add(value);
      }
    }
    const encoding = record.encoding as Record<string, unknown> | undefined;
    if (encoding) {
      for (const definition of Object.values(encoding)) {
        if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
        const encoded = definition as Record<string, unknown>;
        if (encoded.field !== field) continue;
        const domain = (encoded.scale as Record<string, unknown> | undefined)?.domain;
        if (Array.isArray(domain)) {
          for (const value of domain) values.add(value);
        }
      }
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(spec);
  return values;
}

/** True if `field` appears anywhere in the tile (encoded or as a data column). */
export function referencesField(spec: VegaLiteSpec, field: string): boolean {
  if (encodedFieldsDeep(spec).some((e) => e.field === field)) return true;
  return dataColumnsDeep(spec).has(field);
}

/**
 * The tile's primary/brand color as a hex string, or null when it is data-driven
 * by a multi-color categorical scheme (semantic colors, not a single brand hue).
 * Reads mark.color, then the first entry of a color scale range, then color.value.
 */
export function dominantHex(spec: VegaLiteSpec): string | null {
  const m = spec.mark as unknown;
  if (m && typeof m === "object") {
    const c = (m as Record<string, unknown>).color;
    if (typeof c === "string" && /^#/.test(c)) return c.toLowerCase();
  }
  const enc = spec.encoding as Record<string, unknown> | undefined;
  const color = enc?.color as Record<string, unknown> | undefined;
  if (color && typeof color === "object") {
    const value = color.value;
    if (typeof value === "string" && /^#/.test(value)) return value.toLowerCase();
    const scale = color.scale as Record<string, unknown> | undefined;
    const range = scale?.range as unknown;
    if (Array.isArray(range)) {
      const hexes = range.filter((r) => typeof r === "string" && /^#/.test(r)) as string[];
      // A 2-tone range (e.g. a single series shown light/dark) reads as one brand
      // hue; a 3+ semantic palette does not, so we don't treat it as a brand color.
      if (hexes.length > 0 && hexes.length <= 2) return hexes[0].toLowerCase();
    }
  }
  return null;
}

/** Coarse hue family for a hex color, used to spot charts sharing one brand hue. */
export function hueFamily(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 0.08) return "gray";
  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;
  if (hue < 20 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 170) return "green";
  if (hue < 200) return "teal";
  if (hue < 255) return "blue";
  if (hue < 290) return "purple";
  return "magenta";
}

/**
 * True if this tile defines a point/interval selection that could drive a
 * cross-filter on `field` — i.e. an existing coordination link.
 */
export function hasSelectionOnField(spec: VegaLiteSpec, field: string): boolean {
  const nodes = [spec, ...unitSpecs(spec).map((entry) => entry.spec)];
  for (const node of nodes) {
    const params = node.params as unknown;
    if (!Array.isArray(params)) continue;
    for (const p of params) {
      if (!p || typeof p !== "object") continue;
      const select = (p as Record<string, unknown>).select as unknown;
      if (!select) continue;
      const type =
        typeof select === "string"
          ? select
          : ((select as Record<string, unknown>).type as string | undefined);
      if (type !== "point" && type !== "interval") continue;

      // A field-less selection on a tile that encodes the field, or an explicit
      // fields/encodings reference, both count as a live link.
      if (typeof select === "object") {
        const fields = (select as Record<string, unknown>).fields as unknown;
        if (Array.isArray(fields) && fields.includes(field)) return true;
        const encodings = (select as Record<string, unknown>).encodings as unknown;
        if (Array.isArray(encodings) && encodesCategory(spec, field)) return true;
      }
      if (encodesCategory(spec, field)) return true;
    }
  }
  return false;
}
