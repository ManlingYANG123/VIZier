/**
 * The "engine computes" half of the trust invariant.
 *
 * Given a selected value on the shared field, produce the REAL per-value data
 * slice for a target tile (never fabricated by the model), plus a pinned y-axis
 * domain so a filtered line visibly drops instead of auto-rescaling to full
 * height (mirrors withDeptData in prototype/v2/src/app.js). Fully general: it
 * reads the field/measures from the spec, with no hard-coded categories.
 */
import type { VegaLiteSpec } from "../contracts.ts";
import { markType, dataColumns } from "../detect/specUtil.ts";

function clone<T>(v: T): T {
  return structuredClone(v);
}

function rowsOf(spec: VegaLiteSpec): Record<string, unknown>[] {
  const values = (spec.data as Record<string, unknown> | undefined)?.values;
  return Array.isArray(values) ? (values as Record<string, unknown>[]) : [];
}

/** Distinct values of `field` present in the tile's data (for demo/report). */
export function distinctValues(spec: VegaLiteSpec, field: string): string[] {
  const seen = new Set<string>();
  for (const r of rowsOf(spec)) {
    const v = r[field];
    if (v !== undefined && v !== null) seen.add(String(v));
  }
  return [...seen];
}

/** Raw quantitative columns that back the y channel (directly or via `fold`). */
export function measureFields(spec: VegaLiteSpec): string[] {
  const raw = dataColumns(spec);
  const enc = spec.encoding as Record<string, unknown> | undefined;
  const yDef = enc?.y as Record<string, unknown> | undefined;
  const yField = typeof yDef?.field === "string" ? yDef.field : undefined;
  if (yField && raw.has(yField)) return [yField];

  const out: string[] = [];
  const transforms = Array.isArray(spec.transform) ? spec.transform : [];
  for (const t of transforms) {
    const fold = (t as Record<string, unknown>).fold;
    if (Array.isArray(fold)) {
      for (const f of fold) if (typeof f === "string" && raw.has(f)) out.push(f);
    }
  }
  return [...new Set(out)];
}

/** Max, over the FULL data, of the per-x-group sum of the measure fields. */
export function pinnedDomainMax(spec: VegaLiteSpec): number | null {
  const rows = rowsOf(spec);
  const measures = measureFields(spec);
  if (rows.length === 0 || measures.length === 0) return null;
  const enc = spec.encoding as Record<string, unknown> | undefined;
  const xDef = enc?.x as Record<string, unknown> | undefined;
  const xField = typeof xDef?.field === "string" ? xDef.field : null;

  let max = 0;
  for (const measure of measures) {
    if (xField) {
      const byGroup = new Map<string, number>();
      for (const r of rows) {
        const key = String(r[xField]);
        const n = Number(r[measure]);
        if (!Number.isFinite(n)) continue;
        byGroup.set(key, (byGroup.get(key) ?? 0) + n);
      }
      for (const total of byGroup.values()) max = Math.max(max, total);
    } else {
      for (const r of rows) {
        const n = Number(r[measure]);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
    }
  }
  return max > 0 ? max : null;
}

export interface CrossFilterSlice {
  spec: VegaLiteSpec;
  field: string;
  value: string;
  rowsBefore: number;
  rowsAfter: number;
  pinnedMax: number | null;
}

/** Compute a target tile filtered to one value of the shared field. */
export function computeCrossFilterSlice(
  spec: VegaLiteSpec,
  field: string,
  value: string,
): CrossFilterSlice {
  const next = clone(spec);
  const rows = rowsOf(next);
  const filtered = rows.filter((r) => String(r[field]) === String(value));
  next.data = { ...(next.data as Record<string, unknown>), values: filtered };

  let pinnedMax: number | null = null;
  const mark = markType(spec);
  if (mark === "line" || mark === "area" || mark === "trail") {
    pinnedMax = pinnedDomainMax(spec);
    if (pinnedMax !== null) {
      const enc = (next.encoding = { ...(next.encoding as Record<string, unknown>) });
      const yDef = { ...(enc.y as Record<string, unknown>) };
      yDef.scale = { ...(yDef.scale as Record<string, unknown>), domain: [0, Math.ceil(pinnedMax * 1.05)] };
      enc.y = yDef;
    }
  }

  return {
    spec: next,
    field,
    value,
    rowsBefore: rows.length,
    rowsAfter: filtered.length,
    pinnedMax,
  };
}
