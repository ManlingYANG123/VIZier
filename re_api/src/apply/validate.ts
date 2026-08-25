/**
 * The render gate: a candidate spec is only adopted if Vega-Lite can compile it
 * to a Vega spec. Native (no vl-convert needed) because the backend shares the
 * vega-lite library with the v2 frontend. Compile failure -> rollback.
 */
import { compile } from "vega-lite";
import type { BoardMeta, BoardTileMeta, Bounds, SpecMap, VegaLiteSpec } from "../contracts.ts";

export interface CompileResult {
  ok: boolean;
  errors: Record<string, string>;
}

export function compileSpec(spec: VegaLiteSpec): { ok: boolean; error: string | null } {
  try {
    // Cast: our VegaLiteSpec is intentionally loose; compile validates it.
    compile(spec as never);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function compileSpecMap(specMap: SpecMap): CompileResult {
  const errors: Record<string, string> = {};
  for (const [tileId, spec] of Object.entries(specMap)) {
    const { ok, error } = compileSpec(spec);
    if (!ok && error) errors[tileId] = error;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export interface AppliedDashboardValidation {
  ok: boolean;
  errors: string[];
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
    a.y < b.y + b.h && a.y + a.h > b.y;
}

function geometryErrors(board: BoardMeta): string[] {
  const errors: string[] = [];
  const width = Number(board.canvasWidth);
  const height = Number(board.canvasHeight);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return ["canvas dimensions are missing or invalid"];
  }
  const tiles = (board.tiles || []).filter(
    (tile): tile is BoardTileMeta & { bounds: Bounds } => Boolean(tile.bounds)
  );
  for (const tile of tiles) {
    const { x, y, w, h } = tile.bounds;
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0) {
      errors.push(`tile ${tile.id} has invalid bounds`);
    } else if (x + w > width || y + h > height) {
      errors.push(`tile ${tile.id} extends beyond the fixed canvas`);
    }
  }
  for (let i = 0; i < tiles.length; i += 1) {
    for (let j = i + 1; j < tiles.length; j += 1) {
      if (overlaps(tiles[i].bounds, tiles[j].bounds)) {
        errors.push(`tiles ${tiles[i].id} and ${tiles[j].id} overlap`);
      }
    }
  }
  const reserveWidth = Number(board.kpiReservedWidth) || 0;
  const reserveHeight = Number(board.kpiReservedHeight) || 0;
  if (board.hasKpis && (reserveWidth > 0 || reserveHeight > 0)) {
    for (const tile of tiles) {
      if (reserveWidth > 0 && tile.bounds.x < reserveWidth) {
        errors.push(`tile ${tile.id} overlaps the KPI side rail`);
      }
      if (reserveHeight > 0 && tile.bounds.y < reserveHeight) {
        errors.push(`tile ${tile.id} overlaps the KPI header band`);
      }
    }
  }
  return errors;
}

/** Reject a newly proposed hierarchy when it achieves emphasis by making
 * sibling charts unreadable or by turning one tile into a near-full-canvas
 * billboard. These are relative checks, so pre-existing compact dashboards and
 * ordinary hierarchy changes are not penalized. */
function layoutReadabilityErrors(originalBoard: BoardMeta, nextBoard: BoardMeta): string[] {
  const errors: string[] = [];
  const originals = new Map(
    (originalBoard.tiles || [])
      .filter((tile): tile is BoardTileMeta & { bounds: Bounds } => Boolean(tile.bounds))
      .map((tile) => [tile.id, tile.bounds]),
  );
  for (const tile of nextBoard.tiles || []) {
    const before = originals.get(tile.id);
    const after = tile.bounds;
    if (!before || !after || before.w <= 0 || before.h <= 0 || after.w <= 0 || after.h <= 0) continue;
    const unchanged = before.x === after.x && before.y === after.y && before.w === after.w && before.h === after.h;
    if (unchanged) continue;
    if (after.w < before.w * 0.5 || after.h < before.h * 0.5) {
      errors.push(`tile ${tile.id} is compressed below half its readable dimension`);
      continue;
    }
    const areaGrowth = (after.w * after.h) / (before.w * before.h);
    if (areaGrowth > 3) {
      errors.push(`tile ${tile.id} expands disproportionately relative to the original layout`);
      continue;
    }
    const beforeAspect = before.w / before.h;
    const afterAspect = after.w / after.h;
    const aspectChange = Math.max(beforeAspect / afterAspect, afterAspect / beforeAspect);
    if (aspectChange > 2.25) {
      errors.push(`tile ${tile.id} changes aspect ratio enough to compromise chart readability`);
    }
  }
  return errors;
}

function fontSizes(value: unknown, key = "", out: number[] = []): number[] {
  if (typeof value === "number" && /fontSize$/i.test(key) && Number.isFinite(value)) {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => fontSizes(item, key, out));
  } else if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) =>
      fontSizes(child, childKey, out));
  }
  return out;
}

function typographySeverity(board: BoardMeta, specs: SpecMap): number {
  const typography = board.typography || {};
  let severity = 1;
  for (const spec of Object.values(specs)) {
    const sizes = fontSizes(spec);
    if (!sizes.length) continue;
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    if (min < 8) severity = Math.max(severity, 8 / Math.max(min, 1));
    if (max > 96) severity = Math.max(severity, max / 96);
    if (max / Math.max(min, 1) > 5) severity = Math.max(severity, max / Math.max(min, 1) / 5);
  }
  const title = Number(typography.titleFontPx);
  const subtitle = Number(typography.subtitleFontPx);
  if (title > 0 && subtitle > 0) {
    const ratio = title / subtitle;
    if (ratio > 4) severity = Math.max(severity, ratio / 4);
    if (ratio < 0.75) severity = Math.max(severity, 0.75 / ratio);
  }
  const kpi = Number(typography.kpiValueFontPx);
  if (title > 0 && kpi / title > 3.5) severity = Math.max(severity, kpi / title / 3.5);
  return severity;
}

/** Post-apply quality gate. It rejects only newly introduced defects, so an
 * unrelated recommendation is not blocked by a pre-existing dashboard flaw. */
export function validateAppliedDashboard(
  originalBoard: BoardMeta,
  nextBoard: BoardMeta,
  originalSpecs: SpecMap,
  nextSpecs: SpecMap,
): AppliedDashboardValidation {
  const errors: string[] = [];
  if (
    nextBoard.canvasWidth !== originalBoard.canvasWidth ||
    nextBoard.canvasHeight !== originalBoard.canvasHeight
  ) {
    errors.push("recommendations cannot change the original canvas dimensions");
  }
  const baselineGeometry = new Set(geometryErrors(originalBoard));
  errors.push(...geometryErrors(nextBoard).filter((error) => !baselineGeometry.has(error)));
  errors.push(...layoutReadabilityErrors(originalBoard, nextBoard));
  const baselineType = typographySeverity(originalBoard, originalSpecs);
  const nextType = typographySeverity(nextBoard, nextSpecs);
  if (nextType > 1.05 && nextType > baselineType + 0.05) {
    errors.push("the recommendation introduces severely imbalanced font sizes");
  }
  return { ok: errors.length === 0, errors };
}
