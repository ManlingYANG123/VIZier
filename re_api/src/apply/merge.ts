/**
 * Reactive same-tile conflict resolution for the batch apply path.
 *
 * Each critique is generated independently, so two selected edit-spec fixes can
 * address the same tile with edits whose JSON paths overlap (e.g. one rewrites
 * `["encoding","x"]` while another sets `["encoding","x","sort"]`). Applied in
 * sequence against a shared draft, the second silently clobbers part of the
 * first (last-write-wins) — both were reported "resolved" yet the canvas shows
 * only one, or a chart that renders empty.
 *
 * The fix is reactive: detect the path overlap first, and only then ask the
 * model to reconcile the overlapping fixes into ONE edit set that honors every
 * intent. A merge is adopted only if it survives the same sanitize + compile +
 * non-empty gate every other edit passes; otherwise the group is surfaced to the
 * author to choose one (never silently dropped). Non-overlapping fixes never
 * reach the model — they apply directly, so the common case pays no LLM cost.
 */
import type { Critique, SpecMap, VegaLiteSpec } from "../contracts.ts";
import type { LLMClient } from "../llm/client.ts";
import { applySpecEdits, safeSpecEdits, type SpecEdit } from "./editSpec.ts";
import { compileSpec } from "./compile.ts";
import { encodedFieldsDeep } from "../detect/specUtil.ts";

/** The tiles an edit-spec critique targets — the same union applyOne fans out
 * over (ref.tiles ∪ ref.tile ∪ critique.tileId). */
export function editSpecTiles(critique: Critique): string[] {
  const ref = (critique.target?.ref ?? {}) as Record<string, unknown>;
  return [...new Set([
    ...(Array.isArray(ref.tiles) ? ref.tiles.filter((t): t is string => typeof t === "string") : []),
    ...(typeof ref.tile === "string" ? [ref.tile] : []),
    ...(critique.tileId ? [critique.tileId] : []),
  ])];
}

function editPaths(critique: Critique): Array<Array<string | number>> {
  const edits = critique.proposal.edits;
  if (!Array.isArray(edits)) return [];
  return edits
    .map((edit) => edit?.path)
    .filter((path): path is Array<string | number> => Array.isArray(path) && path.length > 0);
}

/** Two paths overlap when one is a prefix of (or equal to) the other: they touch
 * the same node or a nested part of it, so last-write-wins can drop a change.
 * Sibling paths (["encoding","x"] vs ["encoding","y"]) do not overlap. */
export function pathsOverlap(a: Array<string | number>, b: Array<string | number>): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

function critiquesOverlapOnTile(a: Critique, b: Critique): boolean {
  const pathsA = editPaths(a);
  const pathsB = editPaths(b);
  return pathsA.some((pa) => pathsB.some((pb) => pathsOverlap(pa, pb)));
}

export interface EditSpecConflict {
  key: string;
  tileId: string;
  critiqueIds: string[];
}

/** Group identity is order-independent: its critique ids sorted, joined by "::".
 * The author echoes this back as a `conflictChoices` key. */
export function conflictGroupKey(critiqueIds: string[]): string {
  return [...critiqueIds].sort().join("::");
}

/**
 * Find groups of selected edit-spec critiques that overlap on the same tile.
 * Runs per tile: build the overlap graph over the tile's edit-spec critiques and
 * return each connected component of size >= 2. A critique that consolidates
 * several tiles can appear in more than one tile's group.
 */
export function detectEditSpecConflicts(specMap: SpecMap, selected: Critique[]): EditSpecConflict[] {
  const editSpecs = selected.filter((c) => c.proposal.kind === "edit-spec" && Array.isArray(c.proposal.edits));
  const byTile = new Map<string, Critique[]>();
  for (const critique of editSpecs) {
    for (const tile of editSpecTiles(critique)) {
      if (!specMap[tile]) continue; // only real tiles can clobber each other
      const list = byTile.get(tile) ?? [];
      list.push(critique);
      byTile.set(tile, list);
    }
  }

  const conflicts: EditSpecConflict[] = [];
  for (const [tileId, critiques] of byTile) {
    if (critiques.length < 2) continue;
    // Connected components over the "overlaps on this tile" relation.
    const remaining = [...critiques];
    while (remaining.length) {
      const seed = remaining.shift()!;
      const component = [seed];
      let grew = true;
      while (grew) {
        grew = false;
        for (let i = remaining.length - 1; i >= 0; i -= 1) {
          if (component.some((member) => critiquesOverlapOnTile(member, remaining[i]))) {
            component.push(remaining.splice(i, 1)[0]);
            grew = true;
          }
        }
      }
      if (component.length >= 2) {
        const ids = component.map((c) => c.id);
        conflicts.push({ key: conflictGroupKey(ids), tileId, critiqueIds: ids });
      }
    }
  }
  return conflicts;
}

const MERGE_SYSTEM =
  "You reconcile several independently-authored edits to ONE Vega-Lite tile spec " +
  "into a single edit set that honors every author's intent without conflicting. " +
  "You are an editor, not a critic: do not invent new changes, and do not drop an " +
  "author's intent unless two intents are truly mutually exclusive (in which case " +
  "prefer the one that changes the chart's structure over one that only restyles). " +
  "You may only reference fields that already appear in the spec. Return STRICT " +
  'JSON: {"edits":[{"op":"set"|"remove","path":[...],"value":<any>}]} and nothing else.';

function buildMergePrompt(tileId: string, spec: VegaLiteSpec, critiques: Critique[]): string {
  const intents = critiques.map((critique, index) => {
    const edits = Array.isArray(critique.proposal.edits) ? critique.proposal.edits : [];
    return [
      `Fix ${index + 1}: ${critique.title}`,
      critique.suggestion ? `Intent: ${critique.suggestion}` : null,
      `Its edits: ${JSON.stringify(edits)}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  return [
    `Tile id: ${tileId}`,
    `Current tile spec:\n${JSON.stringify(spec)}`,
    "",
    `These ${critiques.length} fixes target overlapping paths in the spec above and would clobber each other if applied in sequence. Merge them into one edit set:`,
    "",
    intents,
    "",
    'Return only {"edits":[...]}.',
  ].join("\n");
}

/** A merged spec must still draw something: if the original tile encoded at least
 * one field, the merged result must too (an edit set that strips every encoding
 * compiles but renders empty — the exact failure merge exists to prevent). */
function stillRenders(before: VegaLiteSpec, after: VegaLiteSpec): boolean {
  return encodedFieldsDeep(before).length === 0 || encodedFieldsDeep(after).length > 0;
}

/**
 * Ask the model to reconcile the overlapping fixes, then adopt the result only
 * if it sanitizes, actually changes the spec, compiles, and still renders.
 * Returns the sanitized merged edits, or null when merge is unavailable/failed
 * (the caller then surfaces the group for an author choice).
 */
export async function mergeEditSpecConflict(
  client: LLMClient | undefined,
  tileId: string,
  spec: VegaLiteSpec,
  critiques: Critique[],
): Promise<SpecEdit[] | null> {
  if (!client?.available()) return null;
  let parsed: { edits?: unknown };
  try {
    parsed = await client.completeJson<{ edits?: unknown }>(
      buildMergePrompt(tileId, spec, critiques),
      { system: MERGE_SYSTEM, maxTokens: 2000, temperature: 0 },
    );
  } catch {
    return null;
  }
  const proposed = Array.isArray(parsed?.edits) ? parsed.edits : null;
  if (!proposed) return null;
  const trial = structuredClone(spec);
  const safe = safeSpecEdits(trial, proposed);
  if (!safe.length) return null;
  if (!applySpecEdits(trial, safe)) return null; // merge that changes nothing is no merge
  if (!compileSpec(trial, spec).ok) return null;
  if (!stillRenders(spec, trial)) return null;
  return safe;
}
