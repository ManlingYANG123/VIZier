/** Deterministic dashboard-level layout and visual-balance quality gate. */
import type { BoardMeta, BoardTileMeta, Bounds, SpecMap, VegaLiteSpec } from "../contracts.ts";
import { encodedFieldsDeep, markType, unitSpecs } from "../detect/specUtil.ts";

export interface AppliedDashboardValidation {
  ok: boolean;
  errors: string[];
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
    a.y < b.y + b.h && a.y + a.h > b.y;
}

function overlapArea(a: Bounds, b: Bounds): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function tileOverlapAreas(board: BoardMeta): Map<string, number> {
  const out = new Map<string, number>();
  const tiles = (board.tiles || []).filter(
    (tile): tile is BoardTileMeta & { bounds: Bounds } => Boolean(tile.bounds),
  );
  for (let i = 0; i < tiles.length; i += 1) {
    for (let j = i + 1; j < tiles.length; j += 1) {
      const area = overlapArea(tiles[i].bounds, tiles[j].bounds);
      if (!area) continue;
      out.set([tiles[i].id, tiles[j].id].sort().join("|"), area);
    }
  }
  return out;
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

function approximateTextWidth(text: string, fontPx: number): number {
  let units = 0;
  for (const char of Array.from(text)) {
    if (/\s/u.test(char)) units += 0.32;
    else if (/[^\u0000-\u024f]/u.test(char)) units += 1;
    else if (/[MW@#%&]/u.test(char)) units += 0.82;
    else if (/[A-Z]/u.test(char)) units += 0.68;
    else if (/[ilI1.,'’]/u.test(char)) units += 0.3;
    else units += 0.54;
  }
  return units * fontPx;
}

function estimatedHeadingBottom(board: BoardMeta): number {
  const canvasWidth = Number(board.canvasWidth) || 1100;
  const titleFont = Number(board.typography?.titleFontPx) || 30;
  const subtitleFont = Number(board.typography?.subtitleFontPx) || 13;
  // The live heading reserves 34px on each side and shares its first line with
  // the small date/version label. Keep a conservative 140px budget for that
  // metadata so long titles wrap here whenever they wrap on the real canvas.
  const titleWidth = Math.max(220, canvasWidth - 68 - 140);
  const bodyWidth = Math.max(220, canvasWidth - 68);
  const titleLines = Math.max(1, Math.ceil(
    approximateTextWidth(String(board.title || ""), titleFont) / titleWidth,
  ));
  const subtitle = String(board.subtitle || "").trim();
  const subtitleLines = subtitle
    ? Math.max(1, Math.ceil(approximateTextWidth(subtitle, subtitleFont) / bodyWidth))
    : 0;
  return 24
    + titleLines * titleFont * 1.2
    + (subtitleLines ? 7 + subtitleLines * subtitleFont * 1.35 : 0);
}

function kpiBandTop(board: BoardMeta): number {
  const topFilter = (board.filters || []).some((filter) =>
    filter.placement === "top-row" ||
    (filter.placement === "floating" && Number(filter.position?.y) >= 76 && Number(filter.position?.y) < 138)
  );
  if (topFilter) return 144;
  return board.kpiLayout === "card-grid" ? 96 : 100;
}

function estimatedHeadingBounds(board: BoardMeta): Bounds | null {
  const title = String(board.title || "").trim();
  const subtitle = String(board.subtitle || "").trim();
  if (!title && !subtitle) return null;
  const canvasWidth = Number(board.canvasWidth) || 1100;
  const titleFont = Number(board.typography?.titleFontPx) || 30;
  const subtitleFont = Number(board.typography?.subtitleFontPx) || 13;
  const titleLineWidth = Math.max(220, canvasWidth - 68 - 140);
  const bodyWidth = Math.max(220, canvasWidth - 68);
  const titleTextWidth = Math.min(titleLineWidth, approximateTextWidth(title, titleFont));
  const subtitleTextWidth = Math.min(bodyWidth, approximateTextWidth(subtitle, subtitleFont));
  // The live heading line also carries a small date/version label after the h1.
  // Reserve its 140px budget here so title-inline controls cannot cover it.
  const headingWidth = Math.min(bodyWidth, Math.max(
    titleTextWidth + (title ? 140 : 0),
    subtitleTextWidth,
  ));
  return {
    x: 34,
    y: 24,
    w: Math.max(1, headingWidth),
    h: Math.max(1, estimatedHeadingBottom(board) - 24),
  };
}

function estimatedKpiBounds(board: BoardMeta): Bounds | null {
  if (!board.hasKpis || !board.kpis?.length) return null;
  const canvasWidth = Number(board.canvasWidth) || 1100;
  const canvasHeight = Number(board.canvasHeight) || 720;
  const top = kpiBandTop(board);
  switch (board.kpiLayout) {
    case "side-rail":
      return { x: 28, y: top, w: 184, h: Math.max(300, canvasHeight - top - 28) };
    case "card-grid":
      return { x: 34, y: top, w: Math.max(1, canvasWidth - 68), h: 96 };
    case "hero-support":
      return { x: 34, y: top, w: Math.max(1, canvasWidth - 68), h: 92 };
    default:
      return { x: 34, y: top, w: Math.max(1, canvasWidth - 68), h: 52 };
  }
}

function estimatedFilterWidth(
  filter: NonNullable<BoardMeta["filters"]>[number],
  placement: NonNullable<NonNullable<BoardMeta["filters"]>[number]["placement"]>,
): number {
  if (placement === "left-rail" || placement === "right-rail") return 184;
  const labelWidth = approximateTextWidth(String(filter.label || ""), 11);
  if (filter.variant === "checkboxes") return Math.max(184, Math.min(300, labelWidth + 72));
  if (filter.variant === "segmented" || filter.variant === "chips") {
    const optionsWidth = (filter.options || []).reduce(
      (sum, option) => sum + approximateTextWidth(String(option), 10.5) + 28,
      42,
    );
    return Math.max(184, Math.min(520, labelWidth + optionsWidth + 24));
  }
  return Math.max(184, Math.min(320, labelWidth + 170));
}

function estimatedFilterHeight(
  filter: NonNullable<BoardMeta["filters"]>[number],
  width: number,
): number {
  if (filter.variant === "checkboxes") {
    return 28 + Math.max(1, filter.options?.length || 0) * 22;
  }
  if (filter.variant === "segmented" || filter.variant === "chips") {
    const contentWidth = (filter.options || []).reduce(
      (sum, option) => sum + approximateTextWidth(String(option), 10.5) + 34,
      approximateTextWidth(String(filter.label || ""), 11) + 54,
    );
    return Math.max(36, Math.ceil(contentWidth / Math.max(120, width)) * 32);
  }
  return filter.kind === "range" || filter.variant === "slider" ? 52 : 38;
}

interface FilterBox {
  id: string;
  placement: NonNullable<NonNullable<BoardMeta["filters"]>[number]["placement"]>;
  anchorTile?: string;
  bounds: Bounds;
}

/** Mirror the fixed placement rules in src/app.js closely enough for the
 * server to reject impossible chrome arrangements before the browser sees
 * them. The browser remains the final authority for font- and SVG-dependent
 * dimensions. */
function estimatedFilterBoxes(board: BoardMeta): FilterBox[] {
  const canvasWidth = Number(board.canvasWidth) || 1100;
  const canvasHeight = Number(board.canvasHeight) || 720;
  const tiles = new Map((board.tiles || []).map((tile) => [tile.id, tile]));
  const slots = new Map<string, number>();
  const boxes: FilterBox[] = [];
  for (const filter of board.filters || []) {
    const placement = filter.placement || "top-row";
    const slot = slots.get(placement) || 0;
    slots.set(placement, slot + 1);
    let width = estimatedFilterWidth(filter, placement);
    let height = estimatedFilterHeight(filter, width);
    let x = 34 + slot * 310;
    let y = 94;
    if (placement === "title-inline") {
      x = canvasWidth - 34 - width;
      y = 28 + slot * 52;
    } else if (placement === "left-rail") {
      x = 28;
      y = 148 + slot * 112;
    } else if (placement === "right-rail") {
      x = canvasWidth - 28 - width;
      y = 148 + slot * 112;
    } else if (placement === "chart-header") {
      const anchor = filter.anchorTile ? tiles.get(filter.anchorTile)?.bounds : null;
      if (anchor) {
        width = Math.max(160, Math.min(Number(filter.position?.w) || 340, anchor.w - 28));
        height = estimatedFilterHeight(filter, width);
        x = anchor.x + 14;
        y = anchor.y + 54;
      } else {
        width = 220;
        x = canvasWidth - 28 - width;
        y = 148 + slot * 112;
      }
    } else if (placement === "floating" && filter.position) {
      x = Number(filter.position.x);
      y = Number(filter.position.y);
      width = Number(filter.position.w) || 240;
      height = estimatedFilterHeight(filter, width);
    }
    boxes.push({
      id: filter.id,
      placement,
      ...(filter.anchorTile ? { anchorTile: filter.anchorTile } : {}),
      bounds: { x, y, w: width, h: height },
    });
  }
  return boxes.filter(({ bounds }) => [bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite));
}

function filterLayoutErrors(board: BoardMeta): string[] {
  const errors: string[] = [];
  const canvasWidth = Number(board.canvasWidth) || 1100;
  const canvasHeight = Number(board.canvasHeight) || 720;
  const heading = estimatedHeadingBounds(board);
  const kpis = estimatedKpiBounds(board);
  const tiles = (board.tiles || []).filter(
    (tile): tile is BoardTileMeta & { bounds: Bounds } => Boolean(tile.bounds),
  );
  const filters = estimatedFilterBoxes(board);
  for (const filter of filters) {
    const bounds = filter.bounds;
    if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.w > canvasWidth || bounds.y + bounds.h > canvasHeight) {
      errors.push(`filter ${filter.id} extends beyond the fixed canvas`);
    }
    if (heading && overlaps(bounds, heading)) {
      errors.push(`filter ${filter.id} overlaps the dashboard heading`);
    }
    if (kpis && overlaps(bounds, kpis)) {
      errors.push(`filter ${filter.id} overlaps the KPI summary`);
    }
    for (const tile of tiles) {
      if (filter.placement === "chart-header" && filter.anchorTile === tile.id) continue;
      if (overlaps(bounds, tile.bounds)) {
        errors.push(`filter ${filter.id} overlaps tile ${tile.id}`);
      }
    }
  }
  for (let i = 0; i < filters.length; i += 1) {
    for (let j = i + 1; j < filters.length; j += 1) {
      if (overlaps(filters[i].bounds, filters[j].bounds)) {
        errors.push(`filters ${filters[i].id} and ${filters[j].id} overlap`);
      }
    }
  }
  return errors;
}

function filterLayoutMagnitudes(board: BoardMeta): Map<string, number> {
  const out = new Map<string, number>();
  const heading = estimatedHeadingBounds(board);
  const kpis = estimatedKpiBounds(board);
  const tiles = (board.tiles || []).filter(
    (tile): tile is BoardTileMeta & { bounds: Bounds } => Boolean(tile.bounds),
  );
  const filters = estimatedFilterBoxes(board);
  for (const filter of filters) {
    if (heading) out.set(`filter:${filter.id}:heading`, overlapArea(filter.bounds, heading));
    if (kpis) out.set(`filter:${filter.id}:kpis`, overlapArea(filter.bounds, kpis));
    for (const tile of tiles) {
      if (filter.placement === "chart-header" && filter.anchorTile === tile.id) continue;
      out.set(`filter:${filter.id}:tile:${tile.id}`, overlapArea(filter.bounds, tile.bounds));
    }
  }
  for (let i = 0; i < filters.length; i += 1) {
    for (let j = i + 1; j < filters.length; j += 1) {
      const pair = [filters[i].id, filters[j].id].sort().join("|");
      out.set(`filters:${pair}`, overlapArea(filters[i].bounds, filters[j].bounds));
    }
  }
  return new Map([...out].filter(([, magnitude]) => magnitude > 0));
}

/** Dashboard chrome is outside board.tiles, so tile-only geometry cannot catch
 * a wrapped heading colliding with a newly added KPI band. Estimate the same
 * fixed chrome positions the frontend renders and reject only newly introduced
 * heading/KPI or heading/tile collisions. */
function chromeLayoutErrors(board: BoardMeta): string[] {
  const errors: string[] = [];
  const headingBottom = estimatedHeadingBottom(board);
  if (board.hasKpis && board.kpis?.length && headingBottom + 8 > kpiBandTop(board)) {
    errors.push("the wrapped dashboard heading overlaps the KPI band");
  }
  for (const tile of board.tiles || []) {
    if (tile.bounds && tile.bounds.y < headingBottom + 8) {
      errors.push(`tile ${tile.id} overlaps the dashboard heading`);
    }
  }
  return errors;
}

function isAnalyticalChart(spec: VegaLiteSpec | undefined): boolean {
  if (!spec) return false;
  return unitSpecs(spec).some(({ spec: unit }) => {
    const mark = markType(unit);
    return Boolean(mark && mark !== "text");
  });
}

function isLowInformationTile(spec: VegaLiteSpec | undefined): boolean {
  if (!spec) return false;
  const units = unitSpecs(spec);
  return units.length > 0 &&
    units.every(({ spec: unit }) => markType(unit) === "text") &&
    encodedFieldsDeep(spec).length === 0;
}

/** Evaluate information-to-space balance rather than limiting how far a layout
 * may move from its starting point. Analytical views may grow dramatically;
 * charts only need enough absolute room to remain legible, while a literal KPI
 * or text tile may not consume more space than its information content earns. */
function layoutBalanceErrors(board: BoardMeta, specs: SpecMap): string[] {
  const errors: string[] = [];
  const tiles = (board.tiles || []).filter(
    (tile): tile is BoardTileMeta & { bounds: Bounds } => Boolean(tile.bounds),
  );
  for (const tile of tiles) {
    if (isAnalyticalChart(specs[tile.id]) && (tile.bounds.w < 220 || tile.bounds.h < 140)) {
      errors.push(`chart tile ${tile.id} has insufficient absolute space for readable axes and marks`);
    }
  }
  const totalArea = tiles.reduce((sum, tile) => sum + tile.bounds.w * tile.bounds.h, 0);
  const chartAreas = tiles
    .filter((tile) => isAnalyticalChart(specs[tile.id]))
    .map((tile) => tile.bounds.w * tile.bounds.h);
  const largestChartArea = chartAreas.length ? Math.max(...chartAreas) : 0;
  if (tiles.length >= 3 && largestChartArea > 0 && totalArea > 0) {
    for (const tile of tiles.filter((candidate) => isLowInformationTile(specs[candidate.id]))) {
      const area = tile.bounds.w * tile.bounds.h;
      if (area / totalArea > 0.3 && area > largestChartArea * 1.5) {
        errors.push(`low-information tile ${tile.id} dominates the dashboard's analytical views`);
      }
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
  const baselineOverlapAreas = tileOverlapAreas(originalBoard);
  for (const [pair, nextArea] of tileOverlapAreas(nextBoard)) {
    const baselineArea = baselineOverlapAreas.get(pair) || 0;
    // A pre-existing overlap may remain while an unrelated fix is applied, but
    // the same pair cannot become materially worse and hide behind the old
    // string-valued defect exemption.
    if (baselineArea > 0 && nextArea > baselineArea * 1.03 + 16) {
      errors.push(`tiles ${pair.replace("|", " and ")} have a worsened overlap`);
    }
  }
  const baselineFilterLayout = new Set(filterLayoutErrors(originalBoard));
  errors.push(...filterLayoutErrors(nextBoard).filter((error) => !baselineFilterLayout.has(error)));
  const baselineFilterMagnitudes = filterLayoutMagnitudes(originalBoard);
  for (const [key, nextMagnitude] of filterLayoutMagnitudes(nextBoard)) {
    const baselineMagnitude = baselineFilterMagnitudes.get(key) || 0;
    if (baselineMagnitude > 0 && nextMagnitude > baselineMagnitude * 1.03 + 16) {
      errors.push(`dashboard chrome collision ${key} materially worsened`);
    }
  }
  const baselineBalance = new Set(layoutBalanceErrors(originalBoard, originalSpecs));
  errors.push(...layoutBalanceErrors(nextBoard, nextSpecs).filter((error) => !baselineBalance.has(error)));
  const baselineChrome = new Set(chromeLayoutErrors(originalBoard));
  errors.push(...chromeLayoutErrors(nextBoard).filter((error) => !baselineChrome.has(error)));
  const baselineType = typographySeverity(originalBoard, originalSpecs);
  const nextType = typographySeverity(nextBoard, nextSpecs);
  if (nextType > 1.05 && nextType > baselineType + 0.05) {
    errors.push("the recommendation introduces severely imbalanced font sizes");
  }
  return { ok: errors.length === 0, errors };
}
