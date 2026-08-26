/**
 * Apply a proposal to the spec map (the "agent proposes -> engine applies"
 * step). Each transform is deterministic and structural; the applied spec is
 * then run through the compile gate (validate.ts) and rolled back if it fails.
 *
 * Cross-view coordination between separately-rendered tiles is a runtime
 * concern (the v2 driver / compute step), so applying `add-cross-filter` wires
 * the source selection param + affordance and records the coordination intent
 * in `usermeta.crossFilter`; the target numbers are produced by
 * compute/crossFilter.ts, never fabricated here.
 */
import type {
  ApplyConflictGroup,
  Bounds,
  BoardMeta,
  BoardTileMeta,
  Critique,
  CritiqueApplyResult,
  Proposal,
  SpecMap,
  VegaLiteSpec,
} from "../contracts.ts";
import type { LLMClient } from "../llm/client.ts";
import { detectEditSpecConflicts, mergeEditSpecConflict } from "./merge.ts";
import {
  encodedFields,
  encodesCategory,
  hasTooltip,
  markType,
  specAtPath,
  unitSpecs,
  type SpecPath,
} from "../detect/specUtil.ts";
import { compileSpecMap } from "./validate.ts";
import { applySpecEdits } from "./editSpec.ts";
import { computeKpis } from "../compute/kpis.ts";
import { hasEmbeddedKpis } from "../detect/kpi.ts";
import { specHasField } from "../detect/filterControl.ts";

function clone<T>(v: T): T {
  return structuredClone(v);
}

function asMarkObject(spec: VegaLiteSpec): Record<string, unknown> {
  const m = spec.mark;
  if (m && typeof m === "object") return m as Record<string, unknown>;
  return { type: typeof m === "string" ? m : "point" };
}

function paramName(field: string): string {
  return `${field}_select`.replace(/[^a-z0-9_]/gi, "_");
}

/** Wire a point selection on the source + record coordination intent. */
export function applyCrossFilter(
  specMap: SpecMap,
  ref: { source: string; targets: string[]; field: string },
): string[] {
  const { source, targets, field } = ref;
  const changed: string[] = [];
  const name = paramName(field);

  const src = specMap[source];
  if (src) {
    const params = Array.isArray(src.params) ? [...(src.params as unknown[])] : [];
    if (!params.some((p) => (p as Record<string, unknown>)?.name === name)) {
      params.push({ name, select: { type: "point", fields: [field] } });
    }
    src.params = params;
    const sourceUnits = unitSpecs(src).filter(({ spec }) => encodesCategory(spec, field));
    for (const { spec: unit } of sourceUnits) {
      unit.mark = { ...asMarkObject(unit), cursor: "pointer" };
      unit.encoding = {
        ...(unit.encoding as Record<string, unknown>),
        opacity: { condition: { param: name, value: 1 }, value: 0.35 },
      };
    }
    src.usermeta = {
      ...(src.usermeta as Record<string, unknown>),
      crossFilter: { role: "source", param: name, field, source, targets },
    };
    changed.push(source);
  }

  for (const t of targets) {
    const target = specMap[t];
    if (!target) continue;
    target.usermeta = {
      ...(target.usermeta as Record<string, unknown>),
      crossFilter: { role: "target", param: name, field, source },
    };
    changed.push(t);
  }
  return changed;
}

/** Add a tooltip (and hover points on lines) to a tile. */
export function applyTooltip(
  specMap: SpecMap,
  tileId: string,
  specPaths?: SpecPath[],
): string[] {
  const spec = specMap[tileId];
  if (!spec) return [];
  let targets: VegaLiteSpec[];
  if (specPaths?.length) {
    // Detector fallbacks name the exact units missing a tooltip.
    targets = specPaths.map((path) => specAtPath(spec, path)).filter(Boolean) as VegaLiteSpec[];
  } else if (encodedFields(spec).length > 0) {
    // A simple tile with top-level fields: tooltip the whole spec.
    targets = [spec];
  } else {
    // A composed tile (e.g. a KPI sparkline built from vconcat/layer units) has no
    // top-level encoding, so a whole-spec tooltip would surface nothing. Tooltip
    // the leaf units that carry fields instead — this is the path a model
    // add-tooltip takes, since (unlike a detector fallback) it carries no
    // specPaths. A tile with no field anywhere yields no targets and is honestly
    // reported as unchanged below.
    targets = unitSpecs(spec).map((entry) => entry.spec).filter((unit) => encodedFields(unit).length > 0);
  }
  let changed = false;
  for (const target of targets) {
    // Never overwrite a tooltip a unit already carries — add-tooltip only fills
    // in the MISSING hover affordance. This also keeps a consolidated card safe:
    // when a sibling tile's per-tile detector specPaths were dropped during
    // consolidation, applying the generic whole-tile fallback to that sibling
    // only tooltips the units still lacking one (exactly what its own detector
    // fallback would have done) instead of clobbering an already-correct tooltip
    // on one of its leaf units.
    if (hasTooltip(target)) continue;
    const fields = encodedFields(target);
    const seen = new Set<string>();
    const tooltip: Array<Record<string, unknown>> = [];
    for (const f of fields) {
      if (seen.has(f.field)) continue;
      seen.add(f.field);
      tooltip.push(f.type ? { field: f.field, type: f.type } : { field: f.field });
    }
    if (!tooltip.length) continue;
    target.encoding = { ...(target.encoding as Record<string, unknown>), tooltip };

    if (["line", "area", "trail"].includes(markType(target))) {
      target.mark = { ...asMarkObject(target), point: { filled: true, size: 50 } };
    } else {
      target.mark = { ...asMarkObject(target), tooltip: true };
    }
    changed = true;
  }
  // A tile with no encodable fields yields no tooltip — report it as unchanged
  // so changedTargets never claims a tile the fix actually no-oped on (this
  // matters for consolidated multi-tile cards and re-evaluation).
  return changed ? [tileId] : [];
}

/**
 * Apply a set of model-proposed, engine-sanitized JSON edits to a tile spec.
 * This is the general executable route for catalog fixes that reduce to a spec
 * change (chart form, color, axes, sort, scale, labels/titles, legends,
 * spec-internal layout). The edits are re-sanitized in editSpec.ts and then
 * compile-gated by the caller.
 */
export function applyEditSpec(specMap: SpecMap, tileId: string, edits: unknown): string[] {
  const spec = specMap[tileId];
  if (!spec) return [];
  return applySpecEdits(spec, edits) ? [tileId] : [];
}

/** Record that the active filter state should be shown (follow-up proposal). */
export function applyShowFilterState(specMap: SpecMap, source: string): string[] {
  const spec = specMap[source];
  if (!spec) return [];
  spec.usermeta = {
    ...(spec.usermeta as Record<string, unknown>),
    activeFilterState: true,
  };
  return [source];
}

function colorEncoding(spec: VegaLiteSpec): Record<string, unknown> | null {
  const encoding = spec.encoding as Record<string, unknown> | undefined;
  const color = encoding?.color;
  return color && typeof color === "object" ? color as Record<string, unknown> : null;
}

/** Apply supported visual proposals without relying on sample tile ids. */
export function applyPalette(specMap: SpecMap, preserveBrand: boolean, critique: Critique): string[] {
  const ref = refOf(critique);
  const requested = [
    ...(Array.isArray(ref.tiles) ? ref.tiles as string[] : []),
    ...(typeof ref.tile === "string" ? [ref.tile] : []),
    ...(critique.tileId ? [critique.tileId] : []),
  ];
  const ids = requested.length ? [...new Set(requested)] : Object.keys(specMap);
  const authored = Array.isArray(critique.proposal.palette)
    ? critique.proposal.palette.filter((color): color is string =>
      typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)).slice(0, 12)
    : [];
  const range = !preserveBrand && authored.length >= 2
    ? authored
    : preserveBrand
      ? ["#1f3b64", "#8294ad", "#365b87", "#aeb9ca"]
      : ["#1e3a5f", "#d97706", "#2d6a4f", "#8b5cf6"];
  const changed: string[] = [];
  for (const id of ids) {
    const spec = specMap[id];
    if (!spec) continue;
    const color = colorEncoding(spec);
    if (color) {
      color.scale = { ...((color.scale as Record<string, unknown>) || {}), range };
    } else {
      spec.mark = { ...asMarkObject(spec), color: range[changed.length % range.length] };
    }
    changed.push(id);
  }
  return changed;
}

/** Canvas defaults used when the board did not carry explicit dimensions. */
const DEFAULT_CANVAS_WIDTH = 1100;
const DEFAULT_CANVAS_HEIGHT = 720;
/** Vertical space reserved at the top of the artboard for the KPI band (heading
 * + one KPI row), so applying add-kpis pushes the charts down instead of letting
 * the band overlap them. */
const KPI_LAYOUT_RESERVE = {
  "hero-support": { width: 0, height: 192 },
  "card-grid": { width: 0, height: 192 },
  "side-rail": { width: 220, height: 0 },
  "inline-summary": { width: 0, height: 152 },
} as const;
type ReservedKpiLayout = keyof typeof KPI_LAYOUT_RESERVE;

function kpiReserve(layout: ReservedKpiLayout, board: BoardMeta): { width: number; height: number } {
  const reserve = KPI_LAYOUT_RESERVE[layout];
  const topFilter = (board.filters || []).some((filter) =>
    filter.placement === "top-row" ||
    (filter.placement === "floating" && Number(filter.position?.y) >= 76 && Number(filter.position?.y) < 138)
  );
  if (!topFilter || reserve.height === 0) return reserve;
  const extra = layout === "card-grid" ? 48 : 44;
  return { ...reserve, height: reserve.height + extra };
}
/** A layout box below this size is a degenerate/unusable tile; reject it. */
const MIN_TILE_SIZE = 80;
/** Breathing room kept between the furthest tile edge and the canvas edge. */
const CANVAS_MARGIN = 28;

/** Validate one model-proposed layout box: finite, on-canvas, non-degenerate,
 * within the dashboard's fixed canvas. Returns a rounded box, or null. */
function sanitizeLayoutBounds(value: unknown, board: BoardMeta): Bounds | null {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (x < 0 || y < 0 || w < MIN_TILE_SIZE || h < MIN_TILE_SIZE) return null;
  const canvasWidth = Number(board.canvasWidth) || DEFAULT_CANVAS_WIDTH;
  const canvasHeight = Number(board.canvasHeight) || DEFAULT_CANVAS_HEIGHT;
  if (x + w > canvasWidth || y + h > canvasHeight) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Move/resize tiles to the model's proposed boxes (a board-layout change). Tile
 * position lives on board.tiles[].bounds, not in any spec, so this is the only
 * executable route for it. The original canvas is an immutable boundary. */
function boxesOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
    a.y < b.y + b.h && a.y + a.h > b.y;
}

function compositionLayout(
  board: BoardMeta,
  composition: Proposal["composition"],
  requestedIds: unknown,
  heroTileId?: unknown,
): Array<{ tile: string; bounds: Bounds }> {
  const all = (board.tiles || []).filter((tile) => tile.bounds);
  const requested = new Set(Array.isArray(requestedIds)
    ? requestedIds.filter((id): id is string => typeof id === "string")
    : []);
  const tiles = (requested.size ? all.filter((tile) => requested.has(tile.id)) : all)
    .sort((a, b) => (a.bounds!.y - b.bounds!.y) || (a.bounds!.x - b.bounds!.x));
  if (typeof heroTileId === "string") {
    const heroIndex = tiles.findIndex((tile) => tile.id === heroTileId);
    if (heroIndex > 0) tiles.unshift(...tiles.splice(heroIndex, 1));
  }
  if (!composition || tiles.length < 2) return [];
  const gap = 24;
  const minX = Math.min(...tiles.map((tile) => tile.bounds!.x));
  const minY = Math.min(...tiles.map((tile) => tile.bounds!.y));
  const maxX = Math.max(...tiles.map((tile) => tile.bounds!.x + tile.bounds!.w));
  const maxY = Math.max(...tiles.map((tile) => tile.bounds!.y + tile.bounds!.h));
  const canvasWidth = Number(board.canvasWidth) || DEFAULT_CANVAS_WIDTH;
  const canvasHeight = Number(board.canvasHeight) || DEFAULT_CANVAS_HEIGHT;
  const availableWidth = canvasWidth - CANVAS_MARGIN - minX;
  const availableHeight = canvasHeight - CANVAS_MARGIN - minY;
  const width = Math.min(Math.max(800, maxX - minX), availableWidth);
  const height = Math.min(Math.max(500, maxY - minY), availableHeight);
  if (width < MIN_TILE_SIZE * 2 || height < MIN_TILE_SIZE) return [];
  const out: Array<{ tile: string; bounds: Bounds }> = [];
  const push = (tile: BoardTileMeta, x: number, y: number, w: number, h: number) => {
    out.push({ tile: tile.id, bounds: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } });
  };
  if (composition === "hero-left" || composition === "asymmetric-grid") {
    const heroRatio = composition === "asymmetric-grid" ? 0.64 : 0.58;
    const heroW = Math.max(MIN_TILE_SIZE, width * heroRatio - gap / 2);
    push(tiles[0], minX, minY, heroW, height);
    const sideX = minX + heroW + gap;
    const sideW = width - heroW - gap;
    const sideH = (height - gap * (tiles.length - 2)) / (tiles.length - 1);
    tiles.slice(1).forEach((tile, index) => push(tile, sideX, minY + index * (sideH + gap), sideW, sideH));
  } else if (composition === "hero-top") {
    const heroH = Math.max(MIN_TILE_SIZE, height * 0.56 - gap / 2);
    push(tiles[0], minX, minY, width, heroH);
    const restY = minY + heroH + gap;
    const cellW = (width - gap * (tiles.length - 2)) / (tiles.length - 1);
    tiles.slice(1).forEach((tile, index) => push(tile, minX + index * (cellW + gap), restY, cellW, height - heroH - gap));
  } else if (composition === "kpi-rail") {
    const railW = Math.max(180, width * 0.24);
    push(tiles[0], minX, minY, railW, height);
    const rest = tiles.slice(1);
    const columns = rest.length > 2 ? 2 : 1;
    const rows = Math.ceil(rest.length / columns);
    const gridX = minX + railW + gap;
    const gridW = width - railW - gap;
    const cellW = (gridW - gap * (columns - 1)) / columns;
    const cellH = (height - gap * (rows - 1)) / rows;
    rest.forEach((tile, index) => push(
      tile,
      gridX + (index % columns) * (cellW + gap),
      minY + Math.floor(index / columns) * (cellH + gap),
      cellW,
      cellH,
    ));
  } else {
    const columns = Math.ceil(Math.sqrt(tiles.length));
    const rows = Math.ceil(tiles.length / columns);
    const cellW = (width - gap * (columns - 1)) / columns;
    const cellH = (height - gap * (rows - 1)) / rows;
    tiles.forEach((tile, index) => push(
      tile,
      minX + (index % columns) * (cellW + gap),
      minY + Math.floor(index / columns) * (cellH + gap),
      cellW,
      cellH,
    ));
  }
  return out;
}

/** Refit every tile into the fixed canvas when dashboard chrome reserves a
 * different top band or side rail. The affine mapping preserves relative
 * hierarchy and gaps while preventing KPI recomposition from stretching the
 * artboard or pushing the last row beyond its edge. */
function reflowForReservedRegion(
  board: BoardMeta,
  previousReserve: { width: number; height: number },
  nextReserve: { width: number; height: number },
): BoardTileMeta[] | null {
  const tiles = board.tiles || [];
  const bounded = tiles.filter((tile): tile is BoardTileMeta & { bounds: Bounds } => Boolean(tile.bounds));
  if (!bounded.length) return tiles;
  const canvasWidth = Number(board.canvasWidth) || DEFAULT_CANVAS_WIDTH;
  const canvasHeight = Number(board.canvasHeight) || DEFAULT_CANVAS_HEIGHT;
  const minX = Math.min(...bounded.map((tile) => tile.bounds.x));
  const minY = Math.min(...bounded.map((tile) => tile.bounds.y));
  const maxX = Math.max(...bounded.map((tile) => tile.bounds.x + tile.bounds.w));
  const maxY = Math.max(...bounded.map((tile) => tile.bounds.y + tile.bounds.h));
  const topFilter = (board.filters || []).some((filter) =>
    filter.placement === "top-row" ||
    (filter.placement === "floating" && Number(filter.position?.y) >= 76 && Number(filter.position?.y) < 138)
  );
  const baseX = previousReserve.width > 0 ? CANVAS_MARGIN : Math.max(0, minX);
  const baseY = previousReserve.height > 0 ? (topFilter ? 144 : 96) : Math.max(0, minY);
  const targetMinX = Math.max(0, nextReserve.width > 0 ? nextReserve.width + 12 : baseX);
  const targetMinY = Math.max(0, nextReserve.height > 0 ? nextReserve.height + 12 : baseY);
  const targetMaxX = canvasWidth - CANVAS_MARGIN;
  const targetMaxY = canvasHeight - CANVAS_MARGIN;
  const sourceWidth = maxX - minX;
  const sourceHeight = maxY - minY;
  const targetWidth = targetMaxX - targetMinX;
  const targetHeight = targetMaxY - targetMinY;
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return null;
  const scaleX = Math.min(1, targetWidth / sourceWidth);
  const scaleY = Math.min(1, targetHeight / sourceHeight);
  const mapped = tiles.map((tile) => {
    if (!tile.bounds) return { ...tile };
    const bounds = {
      x: Math.round(targetMinX + (tile.bounds.x - minX) * scaleX),
      y: Math.round(targetMinY + (tile.bounds.y - minY) * scaleY),
      w: Math.round(tile.bounds.w * scaleX),
      h: Math.round(tile.bounds.h * scaleY),
    };
    return { ...tile, bounds };
  });
  if (mapped.some((tile) => tile.bounds && (tile.bounds.w < MIN_TILE_SIZE || tile.bounds.h < MIN_TILE_SIZE))) {
    return null;
  }
  return mapped;
}

function applyLayout(
  board: BoardMeta,
  layout: unknown,
  composition?: Proposal["composition"],
  layoutTiles?: unknown,
  heroTileId?: unknown,
): boolean {
  const entries = composition
    ? compositionLayout(board, composition, layoutTiles, heroTileId)
    : (Array.isArray(layout) ? layout : []);
  const tiles = board.tiles;
  if (!entries.length || !Array.isArray(tiles) || !tiles.length) return false;
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const proposed = new Map(
    tiles
      .filter((tile) => tile.bounds)
      .map((tile) => [tile.id, { ...tile.bounds! }]),
  );
  let changed = false;
  for (const entry of entries) {
    const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const target = typeof record.tile === "string" ? byId.get(record.tile) : undefined;
    const box = sanitizeLayoutBounds(record.bounds, board);
    if (!target || !target.bounds || !box) return false;
    // A box identical to the current one is not a change; ignore it so a proposal
    // that only "confirms" existing positions doesn't read as an applied edit.
    if (target.bounds && target.bounds.x === box.x && target.bounds.y === box.y &&
      target.bounds.w === box.w && target.bounds.h === box.h) continue;
    proposed.set(target.id, box);
    changed = true;
  }
  if (!changed) return false;
  const baselineOverlaps = new Set<string>();
  const original = tiles.filter((tile): tile is BoardTileMeta & { bounds: Bounds } => Boolean(tile.bounds));
  for (let i = 0; i < original.length; i += 1) {
    for (let j = i + 1; j < original.length; j += 1) {
      if (boxesOverlap(original[i].bounds, original[j].bounds)) {
        baselineOverlaps.add([original[i].id, original[j].id].sort().join("|"));
      }
    }
  }
  const arranged = [...proposed.entries()];
  for (let i = 0; i < arranged.length; i += 1) {
    for (let j = i + 1; j < arranged.length; j += 1) {
      const pair = [arranged[i][0], arranged[j][0]].sort().join("|");
      if (boxesOverlap(arranged[i][1], arranged[j][1]) && !baselineOverlaps.has(pair)) return false;
    }
  }
  // Commit only after every box and the complete arrangement pass. A rejected
  // layout is therefore atomic and cannot leave half-moved/overlapping tiles.
  for (const [id, bounds] of proposed) {
    const tile = byId.get(id);
    if (tile) tile.bounds = bounds;
  }
  return true;
}

/** Dashboard chrome and layout are part of the same apply transaction as the
 * specs. `specMap` lets add-kpis compute real KPI values from the tile data. */
export function applyBoardProposal(board: BoardMeta, critique: Critique, specMap: SpecMap = {}): boolean {
  if (critique.proposal.mode === "guidance_only") return false;
  switch (critique.proposal.kind) {
    case "dashboard-title": {
      if (typeof critique.proposal.label !== "string" || !critique.proposal.label.trim()) return false;
      const nextTitle = critique.proposal.label.trim();
      const nextSubtitle = typeof critique.proposal.subtitle === "string" && critique.proposal.subtitle.trim()
        ? critique.proposal.subtitle.trim()
        : null;
      // Only a real change when the title (or a provided subtitle) actually
      // differs — a rename to the name the board already shows is a no-op.
      const titleChanged = board.title !== nextTitle;
      const subtitleChanged = nextSubtitle !== null && board.subtitle !== nextSubtitle;
      if (!titleChanged && !subtitleChanged) return false;
      board.title = nextTitle;
      if (nextSubtitle !== null) board.subtitle = nextSubtitle;
      return true;
    }
    case "wire-filter-control": {
      const filterId = critique.proposal.filterId;
      const index = board.filters?.findIndex((control) => control.id === filterId) ?? -1;
      if (index < 0 || !board.filters) return false;
      const control = board.filters[index];
      const validTargets = control.targets.filter((id) =>
        Boolean(specMap[id]) && specHasField(specMap[id], control.field)
      );
      if (!validTargets.length) return false;
      const targetsChanged = validTargets.length !== control.targets.length ||
        validTargets.some((id, targetIndex) => id !== control.targets[targetIndex]);
      if (control.wired && !targetsChanged) return false;
      board.filters = board.filters.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              targets: validTargets,
              wired: true,
              // Wiring is structural; preserve the neutral "All" state rather
              // than hiding most of the dashboard as a side effect of Apply.
              value: item.value ?? null,
            }
          : item
      );
      return true;
    }
    case "add-kpis":
    case "recompose-kpis": {
      const adding = critique.proposal.kind === "add-kpis";
      if (adding && (board.hasKpis || hasEmbeddedKpis(specMap, board))) return false;
      if (!adding && (!board.hasKpis || !board.kpis?.length)) return false;
      const resolved = critique.proposal.kpis?.length
        ? computeKpis(specMap, critique.proposal.kpis)
        : board.kpis || [];
      // With the real-KPI design a band only means something when it carries at
      // least one resolved KPI (a computed value, or an honest "—"). An add-kpis
      // that resolves nothing must NOT reserve an empty 100px strip, shift the
      // tiles into dead space, or report a change the canvas can't show — that is
      // the "accept has no effect" symptom. Honestly do nothing instead.
      if (!resolved.length) return false;
      const currentLayout = board.kpiLayout;
      const previousLayout: ReservedKpiLayout = currentLayout && currentLayout in KPI_LAYOUT_RESERVE
        ? currentLayout as ReservedKpiLayout
        : "inline-summary";
      const requestedLayout = critique.proposal.kpiLayout || (adding ? "hero-support" : previousLayout);
      const nextLayout: ReservedKpiLayout = requestedLayout in KPI_LAYOUT_RESERVE
        ? requestedLayout as ReservedKpiLayout
        : previousLayout;
      const previousReserve = adding
        ? { width: 0, height: 0 }
        : {
            width: board.kpiReservedWidth ?? kpiReserve(previousLayout, board).width,
            height: board.kpiReservedHeight ?? kpiReserve(previousLayout, board).height,
          };
      const nextReserve = kpiReserve(nextLayout, board);
      const presentationChanged =
        nextLayout !== previousLayout ||
        Boolean(critique.proposal.kpiStyle && critique.proposal.kpiStyle !== board.kpiStyle) ||
        Boolean(critique.proposal.kpiAlignment && critique.proposal.kpiAlignment !== board.kpiAlignment) ||
        Boolean(critique.proposal.kpiDensity && critique.proposal.kpiDensity !== board.kpiDensity) ||
        Boolean(critique.proposal.kpiChrome && critique.proposal.kpiChrome !== board.kpiChrome);
      if (!adding && !critique.proposal.kpis?.length && !presentationChanged) return false;
      const reflowed = Array.isArray(board.tiles) && board.tiles.length
        ? reflowForReservedRegion(board, previousReserve, nextReserve)
        : board.tiles;
      if (!reflowed) return false;
      board.hasKpis = true;
      board.kpis = resolved;
      if (critique.proposal.kpiStyle) board.kpiStyle = critique.proposal.kpiStyle;
      board.kpiLayout = nextLayout;
      board.kpiAlignment = critique.proposal.kpiAlignment || board.kpiAlignment || "start";
      board.kpiDensity = critique.proposal.kpiDensity || board.kpiDensity || "balanced";
      board.kpiChrome = critique.proposal.kpiChrome || board.kpiChrome || "plain";
      board.kpiReservedWidth = nextReserve.width;
      board.kpiReservedHeight = nextReserve.height;
      // Reflow from the previous composition's reserved region into the new
      // one. This supports real top-band ↔ side-rail iteration without stacking
      // offsets across rounds.
      if (reflowed) board.tiles = reflowed;
      return true;
    }
    case "chart-subtitles": {
      const tiles = board.tiles || [];
      // Only a real change when at least one tile is still missing its subtitle
      // band; when every tile already shows one this is an honest no-op.
      if (!tiles.some((tile) => !tile.hasSubtitle)) return false;
      board.tiles = tiles.map((tile) => {
        if (!tile.bounds) return { ...tile, hasSubtitle: true };
        return {
          ...tile,
          hasSubtitle: true,
          // Subtitle chrome consumes space inside the existing tile frame.
          // Keeping the box fixed prevents row growth and cross-tile occlusion.
          bounds: { ...tile.bounds },
        };
      });
      return true;
    }
    case "edit-layout":
      return applyLayout(
        board,
        critique.proposal.layout,
        critique.proposal.composition,
        critique.proposal.layoutTiles,
        critique.proposal.heroTileId,
      );
    default:
      return false;
  }
}

function refOf(critique: Critique): Record<string, unknown> {
  return (critique.target?.ref ?? {}) as Record<string, unknown>;
}

/** Dispatch one critique's proposal onto the (already-cloned) spec map. */
export function applyOne(specMap: SpecMap, critique: Critique): string[] {
  if (critique.proposal.mode === "guidance_only") return [];
  const ref = refOf(critique);
  switch (critique.proposal.kind) {
    case "add-cross-filter":
      return applyCrossFilter(specMap, {
        source: String(ref.source),
        targets: Array.isArray(ref.targets) ? (ref.targets as string[]) : [],
        field: String(ref.field),
      });
    case "add-tooltip": {
      // A consolidated add-tooltip carries every affected tile in ref.tiles (the
      // same hover fix merged across sibling charts); apply it to each, mirroring
      // the edit-spec fan-out below. Each tile derives its own tooltip from its
      // encoded fields, and applyTooltip now reports [] for a tile with nothing to
      // surface, so the union reflects only tiles that actually changed. specPaths
      // (sub-view targeting) applies only to the primary tile; siblings take the
      // tooltip on their whole spec.
      const primary = String(ref.tile ?? critique.tileId);
      const specPaths = Array.isArray(ref.specPaths) ? ref.specPaths as SpecPath[] : undefined;
      const tooltipTiles = [...new Set([
        ...(Array.isArray(ref.tiles) ? ref.tiles as string[] : []),
        ...(typeof ref.tile === "string" ? [ref.tile] : []),
        ...(critique.tileId ? [critique.tileId] : []),
      ])];
      const changed: string[] = [];
      for (const tile of tooltipTiles) {
        for (const t of applyTooltip(specMap, tile, tile === primary ? specPaths : undefined)) changed.push(t);
      }
      return changed;
    }
    case "show-filter-state":
      return applyShowFilterState(specMap, String(ref.source ?? ref.tile ?? ""));
    case "edit-spec": {
      // A consolidated edit-spec carries every affected tile in ref.tiles (the
      // same fix on several charts merged into one card); apply it to each,
      // mirroring applyPalette's [...ref.tiles, ref.tile, tileId] shape. Each
      // tile re-sanitizes independently, so a tile the edit no-ops on is simply
      // skipped and the union reflects what actually changed.
      const editTiles = [...new Set([
        ...(Array.isArray(ref.tiles) ? ref.tiles as string[] : []),
        ...(typeof ref.tile === "string" ? [ref.tile] : []),
        ...(critique.tileId ? [critique.tileId] : []),
      ])];
      const changed: string[] = [];
      for (const editTile of editTiles) {
        for (const t of applyEditSpec(specMap, editTile, critique.proposal.edits)) changed.push(t);
      }
      return changed;
    }
    case "v2-palette":
      return applyPalette(specMap, false, critique);
    case "preserve-brand-palette":
      return applyPalette(specMap, true, critique);
    default:
      return [];
  }
}

export interface ApplyOutcome {
  specMap: SpecMap;
  changedTargets: string[];
  applicationOrder: string[];
  rollback: { rolledBack: boolean; reason: string | null };
  compileError: string | null;
  critiqueStatuses: CritiqueApplyResult[];
  unresolvedConflicts: ApplyConflictGroup[];
}

export interface ApplyDeps {
  /** When available, reconciles overlapping same-tile edit-spec fixes. */
  client?: LLMClient;
  /** Author's resolution for a conflict group: key -> chosen critique id. */
  conflictChoices?: Record<string, string>;
}

/** The tiles a spec-level proposal touches, used to attribute a compile failure
 * to the critiques responsible so unrelated fixes survive (per-tile isolation). */
function declaredTiles(critique: Critique, specMap: SpecMap): string[] {
  const ref = (critique.target?.ref ?? {}) as Record<string, unknown>;
  const union = (...ids: unknown[]) =>
    [...new Set(ids.flat().filter((id): id is string => typeof id === "string" && Boolean(specMap[id])))];
  switch (critique.proposal.kind) {
    case "add-cross-filter":
      return union(ref.source, Array.isArray(ref.targets) ? ref.targets : []);
    case "show-filter-state":
      return union(ref.source, ref.tile);
    case "add-tooltip":
    case "edit-spec":
      return union(Array.isArray(ref.tiles) ? ref.tiles : [], ref.tile, critique.tileId);
    case "v2-palette":
    case "preserve-brand-palette": {
      const requested = union(Array.isArray(ref.tiles) ? ref.tiles : [], ref.tile, critique.tileId);
      return requested.length ? requested : Object.keys(specMap);
    }
    default:
      return [];
  }
}

/** One thing to apply to the spec draft: a lone critique, or an engine-merged
 * edit set standing in for a whole conflict group. */
interface ApplyUnit {
  critiqueIds: string[];
  tiles: string[];
  apply: (draft: SpecMap) => string[];
  status: "applied" | "merged";
}

function attempt(specMap: SpecMap, units: ApplyUnit[]): {
  draft: SpecMap;
  changed: Set<string>;
  changedByUnit: Map<ApplyUnit, string[]>;
} {
  const draft = clone(specMap);
  const changed = new Set<string>();
  const changedByUnit = new Map<ApplyUnit, string[]>();
  for (const unit of units) {
    const tiles = unit.apply(draft);
    changedByUnit.set(unit, tiles);
    for (const t of tiles) changed.add(t);
  }
  return { draft, changed, changedByUnit };
}

/**
 * Apply a set of critiques (by id) to a clone, then gate on compile.
 *
 * Three properties make batch apply honest (see merge.ts):
 *  - Same-tile edit-spec fixes whose JSON paths overlap are detected and either
 *    merged by the model, resolved by the author's `conflictChoices`, or
 *    surfaced in `unresolvedConflicts` — never silently clobbered.
 *  - Per-tile isolation: if the combined draft fails to compile, only the
 *    critiques touching a failing tile are rolled back; unrelated fixes survive
 *    (a failure that can't be attributed to any tile still rolls back wholesale).
 *  - Per-critique `critiqueStatuses`, so the UI marks only real changes resolved.
 */
export async function applyProposals(
  specMap: SpecMap,
  critiques: Critique[],
  orderedIds: string[],
  deps: ApplyDeps = {},
): Promise<ApplyOutcome> {
  const byId = new Map(critiques.map((c) => [c.id, c]));
  const selected = orderedIds
    .map((id) => byId.get(id))
    .filter((c): c is Critique => Boolean(c) && c!.proposal.mode !== "guidance_only");
  const conflictChoices = deps.conflictChoices ?? {};
  const status = new Map<string, CritiqueApplyResult>();
  const setStatus = (id: string, s: CritiqueApplyResult["status"], tileId?: string) =>
    status.set(id, { id, status: s, ...(tileId ? { tileId } : {}) });

  // 1. Detect overlapping same-tile edit-spec fixes and resolve each group.
  const conflicts = detectEditSpecConflicts(specMap, selected);
  const excluded = new Set<string>(); // ids not applied individually (superseded / conflicting / merged)
  const mergedUnits: ApplyUnit[] = [];
  const unresolved: ApplyConflictGroup[] = [];
  for (const group of conflicts) {
    const members = group.critiqueIds.map((id) => byId.get(id)!).filter(Boolean);
    const choice = conflictChoices[group.key];
    if (choice && group.critiqueIds.includes(choice)) {
      for (const id of group.critiqueIds) {
        if (id === choice) continue; // the chosen fix applies normally below
        excluded.add(id);
        setStatus(id, "superseded", group.tileId);
      }
      continue;
    }
    const merged = await mergeEditSpecConflict(deps.client, group.tileId, specMap[group.tileId], members);
    if (merged) {
      for (const id of group.critiqueIds) {
        excluded.add(id);
        setStatus(id, "merged", group.tileId);
      }
      mergedUnits.push({
        critiqueIds: group.critiqueIds,
        tiles: [group.tileId],
        status: "merged",
        apply: (draft) => applyEditSpec(draft, group.tileId, merged),
      });
      continue;
    }
    for (const id of group.critiqueIds) {
      excluded.add(id);
      setStatus(id, "conflict", group.tileId);
    }
    unresolved.push({
      key: group.key,
      tileId: group.tileId,
      critiqueIds: group.critiqueIds,
      reason: deps.client?.available() ? "merge_failed" : "no_merge_model",
    });
  }

  // 2. Build the ordered unit list: non-excluded critiques individually, and the
  //    merged units in place of the first member of each group they cover.
  const emittedMerge = new Set<ApplyUnit>();
  const units: ApplyUnit[] = [];
  for (const critique of selected) {
    if (excluded.has(critique.id)) {
      const mergeUnit = mergedUnits.find((u) => u.critiqueIds.includes(critique.id));
      if (mergeUnit && !emittedMerge.has(mergeUnit)) {
        emittedMerge.add(mergeUnit);
        units.push(mergeUnit);
      }
      continue;
    }
    units.push({
      critiqueIds: [critique.id],
      tiles: declaredTiles(critique, specMap),
      status: "applied",
      apply: (draft) => applyOne(draft, critique),
    });
  }

  // 3. Apply with per-tile isolation: drop the critiques touching a failing tile
  //    and re-apply, so one bad fix cannot roll back the whole batch.
  const rolledBack = new Set<string>();
  let active = units;
  let run = attempt(specMap, active);
  let compiled = compileSpecMap(run.draft);
  let compileError: string | null = null;
  const wholeRollback = (): ApplyOutcome => {
    // Nothing survived compile — report a whole-batch rollback (original spec map
    // untouched) exactly as before, so the single-bad-fix and all-fixes-conflict
    // cases stay honest instead of silently reporting "no change".
    const [tile, msg] = Object.entries(compiled.errors)[0] ?? ["?", compileError ?? "compile failed"];
    for (const critique of selected) if (!excluded.has(critique.id)) setStatus(critique.id, "rolled_back");
    return {
      specMap,
      changedTargets: [],
      applicationOrder: [],
      rollback: { rolledBack: true, reason: `Spec for "${tile}" failed to compile: ${msg}` },
      compileError: msg,
      critiqueStatuses: [...status.values()],
      unresolvedConflicts: unresolved,
    };
  };
  while (!compiled.ok) {
    compileError = Object.values(compiled.errors)[0] ?? compileError;
    const failing = new Set(Object.keys(compiled.errors));
    const drop = active.filter((unit) => unit.tiles.some((t) => failing.has(t)));
    // A failure no applied unit's tile explains can't be isolated — roll back all.
    if (!drop.length) return wholeRollback();
    for (const unit of drop) for (const id of unit.critiqueIds) rolledBack.add(id);
    active = active.filter((unit) => !drop.includes(unit));
    // Every unit was dropped: the combined result is invalid end to end, which is
    // a whole rollback, not a silent no-op.
    if (!active.length) return wholeRollback();
    run = attempt(specMap, active);
    compiled = compileSpecMap(run.draft);
  }

  // 4. Honest per-critique statuses over the surviving units.
  const order: string[] = [];
  for (const unit of active) {
    const changedTiles = run.changedByUnit.get(unit) ?? [];
    if (changedTiles.length) {
      for (const id of unit.critiqueIds) {
        order.push(id);
        setStatus(id, unit.status, changedTiles[0]);
      }
    } else {
      for (const id of unit.critiqueIds) setStatus(id, "no_change");
    }
  }
  for (const id of rolledBack) setStatus(id, "rolled_back");
  // Any selected id we never classified applied cleanly but changed nothing.
  for (const critique of selected) if (!status.has(critique.id)) setStatus(critique.id, "no_change");

  return {
    specMap: run.draft,
    changedTargets: [...run.changed],
    applicationOrder: order,
    rollback: { rolledBack: false, reason: null },
    // The adopted survivors compiled cleanly; the isolated failure (if any) was
    // dropped, so the committed result carries no compile error.
    compileError: null,
    critiqueStatuses: [...status.values()],
    unresolvedConflicts: unresolved,
  };
}
