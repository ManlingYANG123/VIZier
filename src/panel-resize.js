export const PANEL_LAYOUT_STORAGE_KEY = "vizierPanelLayout";
export const REVISION_DOCK_HEIGHT_STORAGE_KEY = "vizierRevisionDockHeight";

export const PANEL_WIDTH_LIMITS = Object.freeze({
  left: Object.freeze({ min: 208, max: 520 }),
  right: Object.freeze({ min: 300, max: 640 }),
});

export const PANEL_RESIZE_STEP = 12;
export const REVISION_DOCK_RESIZE_STEP = 16;

export const REVISION_DOCK_HEIGHT_LIMITS = Object.freeze({
  min: 240,
  max: 640,
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function panelWidthBounds({
  side,
  workspaceWidth,
  oppositeWidth,
  handleSpace,
  minCanvasWidth,
}) {
  const limits = PANEL_WIDTH_LIMITS[side];
  if (!limits) throw new Error(`Unknown panel side: ${side}`);

  const available = finiteNumber(workspaceWidth)
    - finiteNumber(oppositeWidth)
    - finiteNumber(handleSpace)
    - finiteNumber(minCanvasWidth);
  const max = Math.max(limits.min, Math.min(limits.max, available));

  return { min: limits.min, max };
}

export function clampPanelWidth(width, bounds) {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, finiteNumber(width, bounds.min))));
}

export function panelWidthFromPointer({
  side,
  pointerX,
  workspaceLeft,
  workspaceRight,
}) {
  if (side === "left") return finiteNumber(pointerX) - finiteNumber(workspaceLeft);
  if (side === "right") return finiteNumber(workspaceRight) - finiteNumber(pointerX);
  throw new Error(`Unknown panel side: ${side}`);
}

export function panelWidthFromKey({
  side,
  key,
  currentWidth,
  bounds,
  step = PANEL_RESIZE_STEP,
}) {
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;

  const direction = side === "left"
    ? { ArrowLeft: -1, ArrowRight: 1 }
    : { ArrowLeft: 1, ArrowRight: -1 };
  if (!(key in direction)) return null;

  return clampPanelWidth(
    finiteNumber(currentWidth, bounds.min) + direction[key] * finiteNumber(step, PANEL_RESIZE_STEP),
    bounds,
  );
}

export function revisionDockHeightBounds({
  viewportHeight,
  minCanvasHeight = 180,
}) {
  const available = finiteNumber(viewportHeight) - finiteNumber(minCanvasHeight);
  const max = Math.max(
    REVISION_DOCK_HEIGHT_LIMITS.min,
    Math.min(REVISION_DOCK_HEIGHT_LIMITS.max, available),
  );
  return { min: REVISION_DOCK_HEIGHT_LIMITS.min, max };
}

export function clampRevisionDockHeight(height, bounds) {
  return Math.round(
    Math.min(bounds.max, Math.max(bounds.min, finiteNumber(height, bounds.min))),
  );
}

export function revisionDockHeightFromPointer({
  pointerY,
  viewportBottom,
}) {
  return finiteNumber(viewportBottom) - finiteNumber(pointerY);
}

export function revisionDockHeightFromKey({
  key,
  currentHeight,
  bounds,
  step = REVISION_DOCK_RESIZE_STEP,
}) {
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;

  const direction = { ArrowUp: 1, ArrowDown: -1 };
  if (!(key in direction)) return null;

  return clampRevisionDockHeight(
    finiteNumber(currentHeight, bounds.min)
      + direction[key] * finiteNumber(step, REVISION_DOCK_RESIZE_STEP),
    bounds,
  );
}
