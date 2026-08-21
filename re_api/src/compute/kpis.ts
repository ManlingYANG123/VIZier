/**
 * The "engine computes" half of the trust invariant, for KPIs.
 *
 * The model AUTHORS a KPI as a label + a real (tile, field, aggregate) triple;
 * the engine COMPUTES the number from that tile's inline data. Nothing is
 * fabricated: a KPI whose tile/field/data cannot be resolved is returned with
 * `computed: false` and a neutral placeholder, so the UI can show it honestly
 * as "needs data" rather than inventing a figure.
 */
import type { KpiAggregate, KpiDefinition, ResolvedKpi, SpecMap, VegaLiteSpec } from "../contracts.ts";

/** The aggregates the engine can compute. A field-based KPI must name one of
 * these explicitly (see computeValue): guessing one is a trust-invariant break. */
const KPI_AGGREGATES = new Set<KpiAggregate>(["count", "sum", "avg", "min", "max", "distinct"]);

/**
 * The compute+presentation identity of a KPI: everything that determines the
 * displayed figure (tile, field, aggregate, row filter) plus how it is shown
 * (format, unit). Two KPIs with the same signature necessarily render the SAME
 * string. Used to catch a set of same-signature KPIs that differ only by label —
 * e.g. "AVG AQI 2025" and "AVG AQI 2024" both authored without the year filter —
 * where showing one number under two names is a misleading claim (see computeKpis).
 */
function computationSignature(def: KpiDefinition): string {
  const filter = def.filter && typeof def.filter === "object"
    ? { field: def.filter.field, value: def.filter.value }
    : null;
  return JSON.stringify({
    tile: def.tile ?? null,
    field: def.field ?? null,
    agg: def.agg ?? null,
    filter,
    format: def.format ?? null,
    unit: typeof def.unit === "string" ? def.unit.trim() : null,
  });
}

function rowsOf(spec: VegaLiteSpec | undefined): Record<string, unknown>[] {
  const values = (spec?.data as Record<string, unknown> | undefined)?.values;
  return Array.isArray(values) ? (values as Record<string, unknown>[]) : [];
}

/** Whether a spec carries an inline data.values array at all (vs url-backed). */
function hasInlineValues(spec: VegaLiteSpec | undefined): boolean {
  return Array.isArray((spec?.data as Record<string, unknown> | undefined)?.values);
}

/** Vega-Lite transform steps that change which/how many rows (or derive the
 * measured column) before the chart draws. When a tile carries one of these, its
 * inline data.values is NOT what the viewer sees, so aggregating the raw rows can
 * disagree with the chart beside the KPI. */
const RESHAPING_TRANSFORMS = new Set([
  "aggregate", "filter", "fold", "bin", "pivot", "flatten",
  "sample", "window", "density", "loess", "regression", "quantile", "impute",
]);

/** True when the tile reshapes its rows before display (see above). A KPI over
 * such a tile cannot be faithfully computed from the raw inline rows, so the
 * engine reports it uncomputed ("—") instead of a number that could contradict
 * the tile's own chart — the honest side of the trust invariant. */
function reshapesRows(spec: VegaLiteSpec | undefined): boolean {
  const transforms = (spec as Record<string, unknown> | undefined)?.transform;
  if (!Array.isArray(transforms)) return false;
  return transforms.some((step) =>
    step && typeof step === "object" &&
    Object.keys(step as Record<string, unknown>).some((key) => RESHAPING_TRANSFORMS.has(key)));
}

/**
 * The rows a KPI must be computed over: ONLY the tile it names.
 *
 * A KPI is an attributed claim — "Total Tasks, from the Tasks-by-Department
 * tile" — so the engine must never silently fall back to some other tile's rows.
 * Doing so computes a real-looking number from data the KPI does not describe
 * (wrong source), the subtle cousin of fabrication the trust invariant forbids.
 * A KPI that names no tile, or names a tile with no inline data (e.g. url-backed),
 * has no honest source; `hasSource: false` lets the caller render "—" rather than
 * a borrowed figure. `hasSource` is true even for an empty inline array, so a
 * genuine 0-row tile counts as 0 while a missing source stays "—".
 */
function rowsForKpi(
  specMap: SpecMap,
  def: KpiDefinition,
): { rows: Record<string, unknown>[]; hasSource: boolean } {
  const spec = def.tile ? specMap[def.tile] : undefined;
  // A reshaping transform means the inline rows are not what the chart shows, so
  // there is no source we can aggregate faithfully — treat it as no source ("—").
  if (spec && hasInlineValues(spec) && !reshapesRows(spec)) {
    const rows = rowsOf(spec);
    if (!def.filter) return { rows, hasSource: true };
    const { field, value } = def.filter;
    if (!field || !rows.some((row) => Object.prototype.hasOwnProperty.call(row, field))) {
      return { rows: [], hasSource: false };
    }
    const filtered = rows.filter((row) => row[field] === value);
    // An exact category filter that matches no real row is not a genuine
    // zero-valued KPI; it is an invalid model-authored category/value pair.
    return { rows: filtered, hasSource: filtered.length > 0 };
  }
  return { rows: [], hasSource: false };
}

/** Numeric values of a field across rows, EXCLUDING missing/blank/boolean cells.
 * Number(null)/Number("")/Number("  ")/Number(false) are all finite (0/1), so a
 * bare Number()+isFinite filter would silently count a JSON null or an empty
 * string as 0 — deflating an avg and dragging a min to 0. That is exactly the
 * "misleading real-looking number" the trust invariant forbids, so a value is
 * kept only when it is a real number or a non-empty string that parses as one. */
function numeric(rows: Record<string, unknown>[], field: string): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const raw = row[field];
    if (typeof raw === "number") {
      if (Number.isFinite(raw)) out.push(raw);
      continue;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const n = Number(trimmed);
      if (Number.isFinite(n)) out.push(n);
    }
    // null, undefined, boolean, object, array: not a numeric measurement — skip.
  }
  return out;
}

/** A percentage magnitude above this is treated as a format/scale mismatch, not
 * a real KPI. It catches the explosive direction of the percent vs
 * percent-fraction confusion — a 0–100 value mislabeled "percent-fraction"
 * renders "8700%", a summed quantity mislabeled "percent" renders "788,122%" —
 * with negligible false positives (a real KPI almost never displays >1000%).
 * The opposite direction (a 0–1 ratio mislabeled "percent" → "0.9%") is NOT
 * deterministically detectable, since a genuine 0–100 percent legitimately
 * includes sub-1 values; the authoring prompt guards that side. */
const PERCENT_SANITY_CEILING = 1000;

/** Whether a computed value is compatible with its declared percentage format's
 * scale. Only the impossible-magnitude case is judged (see the ceiling above);
 * every non-percentage format is unconstrained. */
function withinFormatScale(value: number, format: KpiDefinition["format"]): boolean {
  if (!Number.isFinite(value)) return true;
  const displayedPercent = format === "percent"
    ? value
    : format === "percent-fraction"
      ? value * 100
      : null;
  if (displayedPercent === null) return true;
  return Math.abs(displayedPercent) <= PERCENT_SANITY_CEILING;
}

/** Format a computed number compactly (no trailing ".00", thousands separated). */
function formatNumber(value: number, format: KpiDefinition["format"] = "auto"): string {
  if (!Number.isFinite(value)) return "—";
  if (format === "compact") {
    return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  }
  if (format === "currency") {
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
    });
  }
  if (format === "percent") {
    return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  }
  if (format === "percent-fraction") {
    return `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  }
  if (format === "integer") return Math.round(value).toLocaleString("en-US");
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return rounded.toLocaleString("en-US");
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Compute one KPI's display value from real data. A `count` needs no field; the
 * others need a field with numeric (or, for `distinct`, any) values present.
 * `hasSource` is false when the KPI resolved to no real tile data — then even a
 * `count` must return null ("—") rather than a fabricated "0". */
function computeValue(rows: Record<string, unknown>[], def: KpiDefinition, hasSource: boolean): string | null {
  if (!hasSource) return null;
  // A field-based KPI must declare an explicit, valid aggregate. Silently
  // guessing `sum` for a field the author left un-aggregated is exactly the
  // trust-invariant break that rendered an "AVG …" label as a column SUM: the
  // label promises one statistic while the engine computes another. Without an
  // explicit agg the KPI is under-specified, so it stays uncomputed ("—") rather
  // than showing a real-looking number the label may contradict. A KPI with no
  // field is an unambiguous row count.
  const agg: KpiAggregate | null = def.agg && KPI_AGGREGATES.has(def.agg)
    ? def.agg
    : (def.field ? null : "count");
  if (agg === null) return null;
  if (agg === "count") return formatNumber(rows.length, def.format);
  const field = def.field;
  if (!field) return null;
  if (agg === "distinct") {
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row[field];
      if (v === undefined || v === null) continue;
      // Tag by type so 1 and "1" (or true and "true") are not merged into one
      // bucket — otherwise a distinct count is silently under-reported.
      seen.add(`${typeof v}:${String(v)}`);
    }
    return seen.size ? formatNumber(seen.size, def.format) : null;
  }
  const nums = numeric(rows, field);
  if (!nums.length) return null;
  let value: number;
  switch (agg) {
    case "sum": value = nums.reduce((a, b) => a + b, 0); break;
    case "avg": value = nums.reduce((a, b) => a + b, 0) / nums.length; break;
    // reduce, not Math.min(...nums)/Math.max(...nums): spreading a very large
    // array into a call blows the argument/stack limit (RangeError), which would
    // abort the whole apply transaction instead of yielding a value.
    case "min": value = nums.reduce((a, b) => (b < a ? b : a), nums[0]); break;
    case "max": value = nums.reduce((a, b) => (b > a ? b : a), nums[0]); break;
    default: return null;
  }
  // A percentage format whose computed magnitude is impossible (see the ceiling)
  // is a scale mislabel, not a real figure — report it uncomputed rather than
  // rendering a nonsense "8700%".
  if (!withinFormatScale(value, def.format)) return null;
  return formatNumber(value, def.format);
}

/**
 * Resolve model-authored KPI definitions against the real spec-map data. Order
 * and labels are preserved; each value is computed or honestly marked
 * uncomputed. Returns [] for no definitions so callers can fall back.
 */
export function computeKpis(specMap: SpecMap, defs: KpiDefinition[] | undefined): ResolvedKpi[] {
  if (!Array.isArray(defs)) return [];
  // Distinct labels that share one compute+presentation signature render the
  // SAME number — the "AVG AQI 2025" / "AVG AQI 2024" collision that authored no
  // year filter, so both aggregated the whole column to an identical figure.
  // Presenting one value under two names is a misleading claim, so every member
  // of such a collision is reported uncomputed rather than a confident duplicate.
  const labelsBySignature = new Map<string, Set<string>>();
  for (const def of defs) {
    const label = typeof def.label === "string" ? def.label.trim() : "";
    if (!label) continue;
    const sig = computationSignature(def);
    if (!labelsBySignature.has(sig)) labelsBySignature.set(sig, new Set());
    labelsBySignature.get(sig)!.add(label);
  }
  const collidingSignatures = new Set<string>();
  for (const [sig, labels] of labelsBySignature) {
    if (labels.size > 1) collidingSignatures.add(sig);
  }
  const resolved: ResolvedKpi[] = [];
  for (const def of defs) {
    const label = typeof def.label === "string" ? def.label.trim() : "";
    if (!label) continue;
    const { rows, hasSource } = rowsForKpi(specMap, def);
    const raw = collidingSignatures.has(computationSignature(def))
      ? null
      : computeValue(rows, def, hasSource);
    const unit = ["percent", "percent-fraction", "currency"].includes(def.format || "")
      ? ""
      : (typeof def.unit === "string" ? def.unit.trim() : "");
    resolved.push({
      label,
      value: raw === null ? "—" : `${raw}${unit}`,
      ...(def.highlight ? { highlight: true } : {}),
      computed: raw !== null,
    });
  }
  return resolved;
}
