import type {
  BoardMeta,
  Critique,
  ReviewRequestContract,
  SpecMap,
} from "../contracts.ts";
import { contractTileIds } from "../generate/request-contract.ts";

export interface RequestIntentValidation {
  ok: boolean;
  errors: string[];
  checkedCritiqueIds: string[];
}

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function tileMeta(board: BoardMeta, tileId: string) {
  return (board.tiles || []).find((tile) => tile.id === tileId);
}

function materiallyShorter(before: unknown, after: unknown): boolean {
  const previous = String(before || "").replace(/\s+/g, " ").trim();
  const next = String(after || "").replace(/\s+/g, " ").trim();
  return Boolean(previous && next && next.length <= Math.floor(previous.length * 0.85));
}

function contractChangedRequestedTarget(
  contract: ReviewRequestContract,
  originalBoard: BoardMeta,
  nextBoard: BoardMeta,
  originalSpecs: SpecMap,
  nextSpecs: SpecMap,
): boolean {
  for (const path of contract.targetPaths) {
    if (path === "board.title" && changed(originalBoard.title, nextBoard.title)) return true;
    if (path === "board.subtitle" && changed(originalBoard.subtitle, nextBoard.subtitle)) return true;
    if (path.startsWith("board.filters.") && changed(originalBoard.filters, nextBoard.filters)) return true;
    const boardTile = path.match(/^board\.tiles\.([^\.]+)/)?.[1];
    if (boardTile && changed(tileMeta(originalBoard, boardTile), tileMeta(nextBoard, boardTile))) return true;
    const specTile = path.match(/^tile\.([^\.]+)/)?.[1];
    if (specTile && changed(originalSpecs[specTile], nextSpecs[specTile])) return true;
  }
  return false;
}

function proposalTargetChanged(
  critique: Critique,
  originalBoard: BoardMeta,
  nextBoard: BoardMeta,
  originalSpecs: SpecMap,
  nextSpecs: SpecMap,
): boolean {
  const ref = critique.target?.ref || {};
  const tileIds = new Set([
    critique.tileId,
    typeof ref.tile === "string" ? ref.tile : null,
    typeof ref.source === "string" ? ref.source : null,
    ...(Array.isArray(ref.tiles) ? ref.tiles.filter((id): id is string => typeof id === "string") : []),
    ...(Array.isArray(ref.targets) ? ref.targets.filter((id): id is string => typeof id === "string") : []),
  ].filter((id): id is string => Boolean(id)));
  if ([...tileIds].some((tileId) =>
    changed(originalSpecs[tileId], nextSpecs[tileId]) ||
    changed(tileMeta(originalBoard, tileId), tileMeta(nextBoard, tileId)))) return true;
  return critique.target?.granularity === "dashboard" && changed(originalBoard, nextBoard);
}

function validateOne(
  critique: Critique,
  originalBoard: BoardMeta,
  nextBoard: BoardMeta,
  originalSpecs: SpecMap,
  nextSpecs: SpecMap,
): string[] {
  const contract = critique.requestContract;
  if (!contract?.explicitChange) return [];
  const errors: string[] = [];
  const changedRequestedTarget = contract.targetPaths.length
    ? contractChangedRequestedTarget(contract, originalBoard, nextBoard, originalSpecs, nextSpecs)
    : proposalTargetChanged(critique, originalBoard, nextBoard, originalSpecs, nextSpecs);
  if (!changedRequestedTarget) {
    errors.push(`${critique.id}: the proposal did not change any requested semantic target`);
  }
  if (contract.targetPaths.includes("board.title") && contract.actions.includes("shorten") &&
      !materiallyShorter(originalBoard.title, nextBoard.title)) {
    errors.push(`${critique.id}: the proposed dashboard title is not materially shorter`);
  }
  if (contract.targetPaths.includes("board.subtitle") && contract.actions.includes("shorten") &&
      !materiallyShorter(originalBoard.subtitle, nextBoard.subtitle)) {
    errors.push(`${critique.id}: the proposed dashboard subtitle is not materially shorter`);
  }
  const requestedTiles = contractTileIds(contract);
  if (requestedTiles.length && !requestedTiles.some((tileId) =>
    changed(originalSpecs[tileId], nextSpecs[tileId]) ||
    changed(tileMeta(originalBoard, tileId), tileMeta(nextBoard, tileId)))) {
    errors.push(`${critique.id}: no selected tile changed in the proposed dashboard`);
  }
  return errors;
}

/** Validate explicit author requests after the real proposal has been applied.
 * This complements compile/layout safety: a safe but irrelevant or invisible
 * proposal is rolled back instead of being presented as a successful fix. */
export function validateAppliedRequestIntent(
  critiques: Critique[],
  selectedIds: string[],
  originalBoard: BoardMeta,
  nextBoard: BoardMeta,
  originalSpecs: SpecMap,
  nextSpecs: SpecMap,
): RequestIntentValidation {
  const selected = new Set(selectedIds);
  const direct = critiques.filter((critique) =>
    selected.has(critique.id) && critique.requestContract?.explicitChange);
  const errors = direct.flatMap((critique) =>
    validateOne(critique, originalBoard, nextBoard, originalSpecs, nextSpecs));
  return {
    ok: errors.length === 0,
    errors,
    checkedCritiqueIds: direct.map((critique) => critique.id),
  };
}
