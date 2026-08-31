import type {
  BoardMeta,
  Bounds,
  RegionSemanticTarget,
  RequestAction,
  ReviewRequestContract,
  SpecMap,
} from "../contracts.ts";

const ACTION_PATTERNS: Array<[RequestAction, RegExp]> = [
  ["shorten", /\b(shorten|shorter|condense|concise|trim|too\s+long)\b/i],
  ["lengthen", /\b(lengthen|longer|expand\s+the\s+(?:text|copy))\b/i],
  ["remove", /\b(remove|delete|drop|hide|omit)\b/i],
  ["rename", /\b(rename|retitle|rewrite|replace\s+the\s+(?:title|headline|label|copy))\b/i],
  ["reposition", /\b(move|relocate|reposition|place|align)\b/i],
  ["resize", /\b(resize|larger|bigger|smaller|wider|narrower|taller|shorter\s+height)\b/i],
  ["recolor", /\b(recolou?r|change\s+(?:the\s+)?colou?r|palette)\b/i],
  ["simplify", /\b(simplify|reduce\s+(?:clutter|complexity)|clean\s+up)\b/i],
  ["emphasize", /\b(emphasize|highlight|prioriti[sz]e|make\s+prominent)\b/i],
  ["deemphasize", /\b(deemphasize|de-emphasize|reduce\s+emphasis|make\s+subtle)\b/i],
  ["restructure", /\b(restructure|reorganize|recompose|redesign|change\s+(?:the\s+)?layout|rebalance)\b/i],
  ["fix", /\b(fix|correct|improve|tweak|adjust|change|make)\b/i],
];

const EVALUATE_PATTERN = /\b(is|are|does|do|should|could|review|evaluate|check|critique|what\s+is\s+wrong)\b/i;

function finiteBounds(value: unknown): Bounds | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function clamp01(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(1, number)) * 1000) / 1000;
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, limit);
  return normalized || undefined;
}

const SEMANTIC_KINDS = new Set<RegionSemanticTarget["kind"]>([
  "dashboard-title",
  "dashboard-subtitle",
  "filter-control",
  "tile",
  "tile-title",
  "tile-subtitle",
  "chart",
  "axis",
  "legend",
  "mark",
  "annotation",
]);

function pathIsAllowed(path: string, tileId: string | undefined, filterId: string | undefined): boolean {
  if (path === "board.title" || path === "board.subtitle") return true;
  if (filterId && path === `board.filters.${filterId}`) return true;
  if (!tileId) return false;
  return path === `tile.${tileId}` || path.startsWith(`tile.${tileId}.`) ||
    path === `board.tiles.${tileId}` || path.startsWith(`board.tiles.${tileId}.`);
}

/** Treat browser semantic hits as hints, then bind every id/path back to the
 * current engine packet so stale or fabricated targets cannot enter prompts. */
export function sanitizeRegionSemanticTargets(
  value: unknown,
  specMap: SpecMap,
  board: BoardMeta | undefined,
): RegionSemanticTarget[] {
  if (!Array.isArray(value)) return [];
  const tileIds = new Set(Object.keys(specMap));
  const filterIds = new Set((board?.filters || []).map((filter) => filter.id));
  const out: RegionSemanticTarget[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const kind = raw.kind as RegionSemanticTarget["kind"];
    if (!SEMANTIC_KINDS.has(kind)) continue;
    const tileId = text(raw.tileId, 160);
    const filterId = text(raw.filterId, 160);
    if (tileId && !tileIds.has(tileId)) continue;
    if (filterId && !filterIds.has(filterId)) continue;
    const path = text(raw.path, 260);
    const bounds = finiteBounds(raw.bounds);
    if (!path || !bounds || !pathIsAllowed(path, tileId, filterId)) continue;
    const key = `${kind}|${path}|${tileId || ""}|${filterId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      path,
      ...(tileId ? { tileId } : {}),
      ...(filterId ? { filterId } : {}),
      ...(text(raw.text, 180) ? { text: text(raw.text, 180) } : {}),
      bounds,
      overlapRatio: clamp01(raw.overlapRatio),
    });
  }
  return out.sort((a, b) => b.overlapRatio - a.overlapRatio).slice(0, 16);
}

function requestActions(request: string): RequestAction[] {
  const actions = ACTION_PATTERNS
    .filter(([, pattern]) => pattern.test(request))
    .map(([action]) => action);
  if (!actions.length && EVALUATE_PATTERN.test(request)) actions.push("evaluate");
  return [...new Set(actions)];
}

function preserveClauses(request: string): string[] {
  const matches = [
    ...request.matchAll(/(?:preserve|preserving|keep|keeping|maintain|maintaining|retain|retaining|without changing)\s+([^.;!?]+)/gi),
  ];
  return [...new Set(matches.map((match) => match[1].replace(/\s+/g, " ").trim()).filter(Boolean))]
    .slice(0, 4)
    .map((value) => value.slice(0, 180));
}

function inferredPaths(request: string): string[] {
  const paths: string[] = [];
  if (/\b(headline|dashboard\s+title|main\s+title)\b/i.test(request)) paths.push("board.title");
  if (/\b(subtitle|subheading)\b/i.test(request)) paths.push("board.subtitle");
  // Focused/refinement requests are whitespace-normalized before reaching this
  // helper, so "Target:" may no longer begin on its own line.
  const namedTarget = request.match(/\bTarget:\s*([a-z0-9][a-z0-9_-]{0,159})\b/i)?.[1];
  if (namedTarget && !/^dashboard$/i.test(namedTarget)) paths.push(`tile.${namedTarget}`);
  return paths;
}

export function buildReviewRequestContract(
  request: string,
  semanticTargets: RegionSemanticTarget[] = [],
): ReviewRequestContract {
  const normalized = request.replace(/\s+/g, " ").trim().slice(0, 600);
  const actions = requestActions(normalized);
  const semanticPaths = semanticTargets.map((target) => target.path);
  const explicitPaths = inferredPaths(normalized);
  const targetPaths = [...new Set(explicitPaths.length ? explicitPaths : semanticPaths)].slice(0, 12);
  const targetKinds = [...new Set(semanticTargets.map((target) => target.kind))].slice(0, 8);
  const explicitChange = actions.some((action) => action !== "evaluate");
  const successCriteria = explicitChange
    ? [
        "The proposed dashboard must visibly change at least one requested target.",
        "The executable proposal must implement the requested action rather than only describe it.",
        ...(actions.includes("shorten")
          ? ["The replacement text at the requested target must be materially shorter than the current text."]
          : []),
        ...(actions.includes("remove")
          ? ["The requested target or property must be absent from the proposed dashboard."]
          : []),
      ]
    : ["Answer the author's question using evidence from the requested target."];
  return {
    request: normalized,
    explicitChange,
    actions,
    targetPaths,
    targetKinds,
    mustPreserve: preserveClauses(normalized),
    successCriteria,
  };
}

export function contractTileIds(contract: ReviewRequestContract | undefined): string[] {
  if (!contract) return [];
  return [...new Set(contract.targetPaths.flatMap((path) => {
    const match = path.match(/^(?:tile|board\.tiles)\.([^\.]+)/);
    return match ? [match[1]] : [];
  }))];
}
