/**
 * Chrome/encoding detectors (missing KPI row, uniform palette). Their findings
 * map to the `data` and `color` recommendation branches.
 *
 * These stay grounded the same way the interaction detectors do: every finding
 * is backed by a machine-checkable fact (a color hex shared across tiles, or the
 * absence of a KPI row in the board chrome). The LLM only phrases them.
 */
import type { BoardMeta, Finding, SpecMap } from "../contracts.ts";
import { dominantHex, hueFamily } from "./specUtil.ts";
import { hasEmbeddedKpis } from "./kpi.ts";

const PALETTE_BOUNDS = { x: 28, y: 178, w: 1044, h: 286 };

/**
 * Missing-KPI detector. Signal: the board renders chart tiles but exposes no
 * single-value KPI/indicator row, so headline numbers require scanning charts.
 * Grounded in board chrome (`board.hasKpis`), which the spec map cannot express.
 */
export function detectMissingKpis(specMap: SpecMap, board?: BoardMeta): Finding[] {
  const tileCount = Object.keys(specMap).length;
  if (tileCount === 0) return [];
  if (board?.hasKpis) return [];
  if (hasEmbeddedKpis(specMap, board)) return [];

  return [
    {
      id: "finding-missing-kpi",
      kind: "missing-kpi",
      dimension: "data",
      proposalKind: "add-kpis",
      surface: "structural",
      severity: "high",
      evidence: {
        detail:
          `The board renders ${tileCount} chart tile(s) but no single-value KPI/` +
          `indicator tile, so the current headline numbers require reading every chart.`,
        tileCount,
      },
      target: { granularity: "dashboard-section", ref: { component: "kpi-row" } },
      tileId: null,
      bounds: { x: 28, y: 82, w: 1044, h: 92 },
    },
  ];
}

/**
 * Uniform-palette detector. Signal: two or more chart tiles resolve to the same
 * brand hue family (from mark.color / a 1–2 tone color scale), so their roles are
 * visually undifferentiated. Emits BOTH the change proposal (v2-palette) and its
 * paired brand-preservation trade-off, mirroring the two color critiques the
 * board supports (they conflict by kind in the frontend).
 */
export function detectUniformPalette(specMap: SpecMap, _board?: BoardMeta): Finding[] {
  const tileIds = Object.keys(specMap);
  const byFamily = new Map<string, { tile: string; hex: string }[]>();
  for (const id of tileIds) {
    const hex = dominantHex(specMap[id]);
    if (!hex) continue;
    const fam = hueFamily(hex);
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam)!.push({ tile: id, hex });
  }

  // Largest family with >= 2 tiles is the strongest "undifferentiated" signal.
  let shared: { family: string; members: { tile: string; hex: string }[] } | null = null;
  for (const [family, members] of byFamily) {
    if (members.length >= 2 && (!shared || members.length > shared.members.length)) {
      shared = { family, members };
    }
  }
  if (!shared) return [];

  const tiles = shared.members.map((m) => m.tile);
  const colors = shared.members.map((m) => m.hex);
  const anchorTile = tiles[tiles.length - 1];
  const target = {
    granularity: "multi-chart-encoding",
    ref: { encoding: "color", tiles },
  };

  return [
    {
      id: "finding-uniform-palette",
      kind: "uniform-palette",
      dimension: "color",
      proposalKind: "v2-palette",
      surface: "encoding",
      severity: "high",
      evidence: {
        detail:
          `${tiles.join(" and ")} both use the ${shared.family} hue ` +
          `(${colors.join(", ")}) as their primary color, so their chart roles are ` +
          `visually undifferentiated.`,
        tiles,
        colors,
        colorFamily: shared.family,
      },
      target,
      tileId: anchorTile,
      bounds: PALETTE_BOUNDS,
    },
    {
      id: "finding-preserve-brand",
      kind: "preserve-brand",
      dimension: "color",
      proposalKind: "preserve-brand-palette",
      surface: "encoding",
      severity: "medium",
      evidence: {
        detail:
          `The ${shared.family} hue is used as the primary brand color across ` +
          `${tiles.length} tiles (${colors.join(", ")}); recoloring purely for ` +
          `differentiation would weaken that shared visual identity.`,
        tiles,
        colors,
        colorFamily: shared.family,
      },
      target,
      tileId: anchorTile,
      bounds: PALETTE_BOUNDS,
    },
  ];
}
