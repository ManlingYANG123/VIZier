/**
 * TEMPORARY controlled probe (delete after the run).
 *
 * The 18-cell matrix shows what the LLM *happens* to emit. This probe proves the
 * two latent apply-layer defects the user reported are real and reachable, by
 * hand-crafting executable critiques and POSTing them to the live /apply — no
 * LLM in the loop, fully deterministic.
 *
 *  Bug A  edit-spec set ["width"] — applied server-side (FORBIDDEN_ROOT_KEYS does
 *         not block width/height/autosize) yet invisible, because renderTile
 *         overwrites width/height/autosize on every render (app.js:1429-1437).
 *  Bug B1 edit-spec no-op set (identical value) — applySpecEdits does applied+=1
 *         unconditionally (editSpec.ts:138) -> changedTargets non-empty ->
 *         dodges the APPLY_NO_CHANGE guard -> spec byte-identical.
 *  Bug B2 edit-spec remove of a missing path — same unconditional applied+=1.
 *  Bug B3 chart-subtitles when subtitles are already shown — applyBoardProposal
 *         returns true unconditionally (apply/index.ts:299-301) even when every
 *         tile already had hasSubtitle:true -> board reported changed, no change.
 *
 * Run: node scripts/bug-probe.ts
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { normalizeDashboardDocument } from "../src/vega-dashboard-adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../..", "proposals", "0814");
const OUT_FILE = path.join(OUT_DIR, "bug-probe-data.json");
const BASE = process.env.RE_API_BASE || "http://127.0.0.1:8091";
const DASH = "garden-birds-new";
const TILE = "birds-ranking";

async function streamSSE(route: string, body: unknown): Promise<any> {
  const res = await fetch(BASE + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result: any = null;
  let error: any = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload: any;
      try { payload = JSON.parse(data); } catch { payload = data; }
      if (ev === "result") result = payload;
      else if (ev === "error") error = payload;
    }
  }
  if (error) throw new Error(error.message || error.error || JSON.stringify(error));
  return result;
}

function critique(id: string, kind: string, edits: any, extra: any = {}): any {
  return {
    id,
    title: id,
    summary: id,
    dimension: "visual design",
    severity: "medium",
    tileId: TILE,
    status: "pending",
    source: "ai",
    target: { granularity: "tile", ref: { tile: TILE } },
    proposal: { mode: "executable", kind, ...(edits ? { edits } : {}), ...extra },
  };
}

async function apply(specMap: any, board: any, context: any, c: any): Promise<any> {
  try {
    const result = await streamSSE("/apply", {
      version: 1, context, specMap, board, critiques: [c], selectedRecommendationIds: [c.id], conflictChoices: {},
    });
    if (!result) return { outcome: "no-result" };
    if (result.rollback?.rolledBack) return { outcome: "rollback", reason: result.rollback.reason };
    const changed = result.changedTargets || [];
    const tileBefore = JSON.stringify(specMap[TILE]);
    const tileAfter = JSON.stringify(result.specMap?.[TILE]);
    const boardChanged = JSON.stringify(board) !== JSON.stringify(result.board || {});
    return {
      outcome: "applied",
      changedTargets: changed,
      tileSpecByteIdentical: tileBefore === tileAfter,
      boardByteIdentical: !boardChanged,
      widthAfter: result.specMap?.[TILE]?.width,
    };
  } catch (err) {
    return { outcome: "error", reason: (err as Error).message };
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const raw = await (await fetch(`${BASE}/api/dashboards/${encodeURIComponent(DASH)}`)).json();
  const doc = normalizeDashboardDocument(raw, DASH);
  const specMap: any = {};
  for (const t of doc.tiles) specMap[t.id] = structuredClone(t.spec);
  const board = {
    title: doc.dashboard.title, subtitle: doc.dashboard.subtitle || "", hasKpis: false, kpis: [],
    canvasWidth: doc.dashboard.canvasWidth, canvasHeight: doc.dashboard.canvasHeight,
    tiles: doc.tiles.map((t: any) => ({ id: t.id, title: t.label, hasSubtitle: false, bounds: t.bounds })),
  };
  const context = { goal: "probe", audience: "probe", fieldStatus: { goal: "confirmed", audience: "confirmed" } };

  // Pick a real existing scalar leaf in the tile spec for the no-op set.
  const spec = specMap[TILE];
  const currentMark = typeof spec.mark === "string" ? spec.mark : spec.mark?.type;

  const results: any = { base: BASE, dashboard: DASH, tile: TILE, currentMark, probes: {} };

  // Bug A — set width (renderer overrides it -> invisible, but applied).
  results.probes.bugA_setWidth = await apply(specMap, board, context,
    critique("probe-A-setWidth", "edit-spec", [{ op: "set", path: ["width"], value: 999 }]));

  // Bug B1 — no-op set of the mark type to its identical current value.
  results.probes.bugB1_noopSet = await apply(specMap, board, context,
    critique("probe-B1-noopSet", "edit-spec", [{ op: "set", path: ["mark", "type"], value: currentMark }]));

  // Bug B2 — remove a path that does not exist.
  results.probes.bugB2_phantomRemove = await apply(specMap, board, context,
    critique("probe-B2-phantomRemove", "edit-spec", [{ op: "remove", path: ["encoding", "nonexistentChannel"] }]));

  // Bug B3 — chart-subtitles when subtitles are ALREADY on (board reports change, none happens).
  const boardSubsOn = { ...board, tiles: board.tiles.map((t: any) => ({ ...t, hasSubtitle: true })) };
  results.probes.bugB3_chartSubtitlesAlreadyOn = await apply(specMap, boardSubsOn, context,
    critique("probe-B3-subtitles", "chart-subtitles", null));

  // POSITIVE CONTROL — a genuine, visible edit (new root title) MUST still apply.
  // Guards against the honest-return fix over-suppressing real changes: expect
  // outcome "applied", changedTargets non-empty, tileSpecByteIdentical=false.
  results.probes.control_realTitleEdit = await apply(specMap, board, context,
    critique("probe-control-title", "edit-spec", [{ op: "set", path: ["title"], value: "PROBE_TITLE_CHANGE_v1" }]));

  await writeFile(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nWrote ${OUT_FILE}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
