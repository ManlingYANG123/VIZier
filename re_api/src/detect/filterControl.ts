import type { BoardMeta, Finding, SpecMap } from "../contracts.ts";
import { encodedFieldsDeep } from "./specUtil.ts";

function controlBounds(
  control: NonNullable<BoardMeta["filters"]>[number],
  board: BoardMeta,
): { x: number; y: number; w: number; h: number } {
  const canvasWidth = Number(board.canvasWidth) || 1100;
  const position = control.position;
  if (control.placement === "floating" && position) {
    return { x: position.x, y: position.y, w: position.w || 240, h: 52 };
  }
  if (control.placement === "chart-header" && control.anchorTile) {
    const anchor = board.tiles?.find((tile) => tile.id === control.anchorTile)?.bounds;
    if (anchor) return { x: anchor.x + 14, y: anchor.y + 54, w: Math.min(340, anchor.w - 28), h: 54 };
  }
  if (control.placement === "title-inline") return { x: Math.max(28, canvasWidth - 500), y: 24, w: 466, h: 54 };
  if (control.placement === "left-rail") return { x: 28, y: 148, w: 184, h: 96 };
  if (control.placement === "right-rail") return { x: Math.max(28, canvasWidth - 212), y: 148, w: 184, h: 96 };
  return { x: 34, y: 90, w: Math.min(560, canvasWidth - 68), h: 48 };
}

export function specHasField(spec: Record<string, unknown>, field: string): boolean {
  if (encodedFieldsDeep(spec).some((encoded) => encoded.field === field)) return true;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const node = value as Record<string, unknown>;
    const data = node.data as Record<string, unknown> | undefined;
    if (Array.isArray(data?.values) && data.values.some((row) =>
      row && typeof row === "object" && Object.prototype.hasOwnProperty.call(row, field))) return true;
    return ["layer", "hconcat", "vconcat", "concat"].some((key) =>
      Array.isArray(node[key]) && (node[key] as unknown[]).some(visit)) || visit(node.spec);
  };
  return visit(spec);
}

export function detectIneffectiveFilterControls(specMap: SpecMap, board?: BoardMeta): Finding[] {
  if (!board) return [];
  return (board.filters || []).flatMap((control) => {
    const validTargets = control.targets.filter((id) =>
      Boolean(specMap[id]) && specHasField(specMap[id], control.field)
    );
    if (control.wired && validTargets.length === control.targets.length && validTargets.length > 0) return [];
    const repairable = validTargets.length > 0;
    return [{
      id: `finding-filter-${control.id}`,
      kind: "ineffective-filter-control",
      dimension: "interaction",
      proposalKind: repairable ? "wire-filter-control" : "manual",
      surface: "interaction",
      severity: "high",
      evidence: {
        detail: repairable
          ? `${control.label} is visible but not connected to ${validTargets.length} compatible target view(s).`
          : `${control.label} is visible but none of its targets expose the field ${control.field}.`,
        filterId: control.id,
        controlLabel: control.label,
        field: control.field,
        targets: control.targets,
        validTargets,
      },
      target: { granularity: "dashboard-section", ref: { component: "filter-bar", filterId: control.id } },
      tileId: null,
      bounds: controlBounds(control, board),
    } satisfies Finding];
  });
}
