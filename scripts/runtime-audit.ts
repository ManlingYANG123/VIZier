/**
 * TEMPORARY runtime-audit harness (delete after the run).
 *
 * Exercises the VIZier v2 critique -> apply -> interaction flow AT RUNTIME against
 * the live re_api server (default http://127.0.0.1:8091), across a matrix of
 * dashboards x review temperatures x rounds, and classifies every applied change
 * by its structural diff so the two reported defects ("Fixable but no visible
 * change" and "interaction simulation gone / inaccurate") are proven or disproven
 * with real data rather than asserted from a code read.
 *
 * It reuses the real code paths, it does not reimplement them:
 *  - the SSE drain mirrors src/api-client.js streamSSE (return ONLY the terminal
 *    `event: result` frame -> "wait until generation completes" by construction);
 *  - the interaction-sim accuracy check imports the frontend adapter
 *    (applyTargetFilterState) and the backend truth (computeCrossFilterSlice)
 *    and compares them on the same (field, value).
 *
 * Output: proposals/0814/runtime-audit-data.json (written incrementally).
 * Run:    node scripts/runtime-audit.ts   (Node >= 23 strips the .ts types)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Frontend adapter (pure ESM JS, no browser imports).
import {
  normalizeDashboardDocument,
  applyTargetFilterState,
  applySourceSelectionState,
  buildInteractionScenario,
} from "../src/vega-dashboard-adapter.js";
// Backend "truth" (TypeScript, imported directly — Node strips types).
import { computeCrossFilterSlice, distinctValues } from "../re_api/src/compute/crossFilter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(V2_ROOT, "../..");
const OUT_DIR = path.join(REPO_ROOT, "proposals", "0814");
const OUT_FILE = path.join(OUT_DIR, "runtime-audit-data.json");

const BASE = process.env.RE_API_BASE || "http://127.0.0.1:8091";
// Env overrides let a cheap single-cell smoke test run before the full matrix.
const TEMPS = process.env.AUDIT_TEMPS
  ? process.env.AUDIT_TEMPS.split(",").map(Number)
  : [0.0, 0.2, 0.7];
const ROUNDS = process.env.AUDIT_ROUNDS
  ? process.env.AUDIT_ROUNDS.split(",").map(Number)
  : [1, 2];
const ONLY = process.env.AUDIT_ONLY ? process.env.AUDIT_ONLY.split(",") : null;

// Each `-new` dashboard, its bound design PDF (DASHBOARD_DESIGN_DOC_BINDINGS in
// app.js), and a plausible confirmed context (goal/audience) a user would set.
const TARGETS = [
  {
    id: "garden-birds-new",
    pdf: "BBC GEL _ How to design infographics.pdf",
    context: {
      goal: "Show which garden birds are most common in Britain and how key species' populations have changed over time, in an engaging, accessible editorial infographic.",
      audience: "General public and nature enthusiasts reading a data-driven story.",
    },
  },
  {
    id: "sales-command-center-new",
    pdf: "Best Practices for Effective Dashboards - Tableau.pdf",
    context: {
      goal: "Monitor retail sales performance across regions, product categories, and time to support fast operational decisions.",
      audience: "Sales managers and operations leads reviewing performance daily.",
    },
  },
  {
    id: "air-quality-new",
    pdf: "Data visualizations _ U.S. Web Design System (USWDS).pdf",
    context: {
      goal: "Help local residents understand recent air-quality trends and know what to do on bad-air days.",
      audience: "General public and residents checking their local air quality.",
    },
  },
];

// ---------------------------------------------------------------------------
// SSE drain — byte-for-byte the contract of src/api-client.js streamSSE:
// read the whole stream, split on \n\n, and return ONLY the `result` payload.
// Phase events are ignored; an `error` event throws. This is the "wait until
// the whole generation completes before processing output" guarantee.
// ---------------------------------------------------------------------------
async function streamSSE(route: string, body: unknown): Promise<any> {
  const res = await fetch(BASE + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`${route} ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: any = null;
  let error: any = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload: any;
      try { payload = JSON.parse(data); } catch { payload = data; }
      if (event === "result") result = payload;
      else if (event === "error") error = payload;
      // phase events intentionally dropped
    }
  }
  if (error) {
    const msg = typeof error === "string" ? error : (error.message || error.error || JSON.stringify(error));
    throw new Error(msg);
  }
  return result;
}

// ---------------------------------------------------------------------------
// PDF -> text, mirroring src/intake-client.js extractDesignDocText (pdfjs
// legacy build, getTextContent per page joined by blank lines).
// ---------------------------------------------------------------------------
async function extractPdfText(pdfPath: string): Promise<{ text: string; pageCount: number }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((it: any) => (typeof it.str === "string" ? it.str : "")).join(" ");
    pages.push(strings);
  }
  return { text: pages.join("\n\n"), pageCount: doc.numPages };
}

// ---------------------------------------------------------------------------
// Structural diff + classification.
// ---------------------------------------------------------------------------
function collectDiffPaths(a: any, b: any, prefix: string, out: string[]): void {
  if (a === b) return;
  const aObj = a && typeof a === "object";
  const bObj = b && typeof b === "object";
  if (!aObj || !bObj) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(prefix || "(root)");
    return;
  }
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const np = prefix ? `${prefix}.${k}` : k;
    if (!(k in a)) { out.push(`${np} (+)`); continue; }
    if (!(k in b)) { out.push(`${np} (-)`); continue; }
    collectDiffPaths(a[k], b[k], np, out);
  }
}

const RENDER_KEYS = new Set(["width", "height", "autosize"]);
function isInteractionPath(p: string): boolean {
  return p.includes("usermeta") || /(^|\.)params\b/.test(p) || p.startsWith("params");
}
function isNonVisualPath(p: string): boolean {
  const l = p.toLowerCase();
  return l.includes("opacity") || l.includes("cursor") || l.includes("tooltip") || isInteractionPath(p);
}

function classifyDiff(before: any, after: any): { klass: string; rootKeys: string[]; paths: string[] } {
  const bs = JSON.stringify(before);
  const as = JSON.stringify(after);
  if (bs === as) return { klass: "empty-diff", rootKeys: [], paths: [] };
  const paths: string[] = [];
  collectDiffPaths(before, after, "", paths);
  const rootKeys = [...new Set(paths.map((p) => p.split(/[.[ ]/)[0]))];
  if (rootKeys.length && rootKeys.every((k) => RENDER_KEYS.has(k))) {
    return { klass: "width-height-only", rootKeys, paths: paths.slice(0, 20) };
  }
  const allTooltip = paths.every((p) => p.toLowerCase().includes("tooltip"));
  if (allTooltip) return { klass: "tooltip-only", rootKeys, paths: paths.slice(0, 20) };
  const hasVisible = paths.some((p) => !isNonVisualPath(p));
  const hasInteraction = paths.some(isInteractionPath);
  if (!hasVisible && hasInteraction) return { klass: "interaction-install", rootKeys, paths: paths.slice(0, 20) };
  if (!hasVisible) return { klass: "behavioral-only", rootKeys, paths: paths.slice(0, 20) };
  return { klass: "real-visible", rootKeys, paths: paths.slice(0, 20) };
}

// ---------------------------------------------------------------------------
// Load a dashboard from the library and build the /critique + /apply inputs the
// frontend would build (buildEngineSpecMap / buildEngineBoardMeta in app.js).
// ---------------------------------------------------------------------------
async function loadDashboard(id: string): Promise<{ specMap: Record<string, any>; board: any; tiles: any[]; doc: any }> {
  const res = await fetch(`${BASE}/api/dashboards/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET /api/dashboards/${id} -> ${res.status}`);
  const raw = await res.json();
  const doc = normalizeDashboardDocument(raw.dashboard ? raw : raw, id);
  const tiles = doc.tiles || [];
  const specMap: Record<string, any> = {};
  for (const t of tiles) specMap[t.id] = structuredClone(t.spec);
  // Mirror buildEngineBoardMeta (app.js): hasSubtitle is the GLOBAL
  // state.showChartSubtitles flag (default false), NOT a per-tile subtitle
  // field — sending per-tile true would make chart-subtitles a false no-op.
  const showChartSubtitles = Boolean(doc.dashboard?.showChartSubtitles);
  const board = {
    title: doc.dashboard?.title || doc.title || id,
    subtitle: doc.dashboard?.subtitle || "",
    hasKpis: Boolean(doc.dashboard?.hasKpis),
    kpis: [],
    canvasWidth: doc.dashboard?.canvasWidth || 1100,
    canvasHeight: doc.dashboard?.canvasHeight || 720,
    tiles: tiles.map((t: any) => ({
      id: t.id,
      title: t.label || t.v2Label || t.id,
      hasSubtitle: showChartSubtitles,
      bounds: t.bounds || { x: 0, y: 0, w: 400, h: 300 },
    })),
  };
  return { specMap, board, tiles, doc };
}

function isExecutable(critique: any): boolean {
  return critique?.proposal?.mode === "executable";
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const started = process.env.AUDIT_STAMP || "unstamped";
  const artifact: any = {
    meta: {
      base: BASE,
      temps: TEMPS,
      rounds: ROUNDS,
      startedStamp: started,
      note: "Structural classification is deterministic; LLM critique text varies run to run.",
    },
    dashboards: {},
    interactionAccuracy: null,
    cells: [],
  };

  const activeTargets = ONLY ? TARGETS.filter((t) => ONLY.includes(t.id)) : TARGETS;

  // Per-dashboard: load spec + extract constraints once (cached across temps/rounds).
  const perDash: Record<string, { specMap: any; board: any; tiles: any[]; constraintSet: any; context: any }> = {};
  for (const target of activeTargets) {
    console.log(`\n=== loading ${target.id} + constraints ===`);
    const { specMap, board, tiles } = await loadDashboard(target.id);
    let constraintSet: any = null;
    try {
      const { text, pageCount } = await extractPdfText(path.join(V2_ROOT, "public", "pdfs", target.pdf));
      const source = { kind: "pdf-text", text, filename: target.pdf, pageCount };
      const intake = await (await fetch(`${BASE}/intake-constraints`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, requireLLM: true }),
      }).then((r) => r.json()));
      constraintSet = intake?.constraintSet || null;
      console.log(`  constraints: ${(constraintSet?.constraints || []).length} rule(s) from ${target.pdf}`);
    } catch (err) {
      console.log(`  constraint intake FAILED: ${(err as Error).message}`);
    }
    const context = {
      ...target.context,
      constraints: constraintSet ? `${(constraintSet.constraints || []).length} design rules loaded` : "",
      fieldStatus: {
        goal: "confirmed",
        audience: "confirmed",
        constraints: constraintSet ? "confirmed" : "missing",
      },
      notes: [],
    };
    perDash[target.id] = { specMap, board, tiles, constraintSet, context };
    artifact.dashboards[target.id] = {
      tileIds: tiles.map((t: any) => t.id),
      hasCrossFilter: tiles.some((t: any) => t.spec?.usermeta?.crossFilter?.role === "source"),
      constraintCount: (constraintSet?.constraints || []).length,
      pdf: target.pdf,
    };
  }

  // Matrix — fully sequential so multi-LLM output can never interleave.
  for (const target of activeTargets) {
    const d = perDash[target.id];
    for (const temp of TEMPS) {
      for (const round of ROUNDS) {
        const cellLabel = `${target.id} T=${temp} R=${round}`;
        console.log(`\n--- critique: ${cellLabel} ---`);
        const cell: any = {
          dashboard: target.id,
          temperature: temp,
          round,
          critiqueError: null,
          critiqueCount: 0,
          executableCount: 0,
          strengths: 0,
          critiques: [],
        };
        let critiques: any[] = [];
        try {
          const resp = await streamSSE("/critique", {
            version: 1,
            context: d.context,
            specMap: d.specMap,
            board: d.board,
            reviewScope: "full",
            requireLLM: true,
            reviewTemperature: temp,
            savedRationales: [],
            ...(d.constraintSet ? { constraintSet: d.constraintSet } : {}),
          });
          critiques = resp?.critiques || [];
          cell.critiqueCount = critiques.length;
          cell.strengths = (resp?.strengths || []).length;
          cell.diagnoses = (resp?.diagnoses || resp?.findings || []).length;
          console.log(`    -> ${critiques.length} critiques, ${cell.strengths} strengths`);
        } catch (err) {
          cell.critiqueError = (err as Error).message;
          console.log(`    critique ERROR: ${cell.critiqueError}`);
          artifact.cells.push(cell);
          await writeFile(OUT_FILE, JSON.stringify(artifact, null, 2));
          continue;
        }

        const executables = critiques.filter(isExecutable);
        cell.executableCount = executables.length;

        // Apply each executable critique in isolation from the ORIGINAL specMap.
        for (const c of executables) {
          const rec: any = {
            id: c.id,
            dimension: c.dimension,
            title: c.title,
            mode: c.proposal?.mode,
            proposalKind: c.proposal?.kind,
            editPaths: (c.proposal?.edits || []).map((e: any) => `${e.op} ${e.path}`),
            interactionKind: c.interactionKind || null,
            apply: null,
          };
          try {
            const result = await streamSSE("/apply", {
              version: 1,
              context: d.context,
              specMap: d.specMap,
              board: d.board,
              critiques,
              selectedRecommendationIds: [c.id],
              conflictChoices: {},
            });
            if (!result) {
              rec.apply = { outcome: "no-result" };
            } else if (result.rollback?.rolledBack) {
              rec.apply = { outcome: "rollback", reason: result.rollback.reason || null };
            } else {
              const changed = result.changedTargets || [];
              // Board-level changes (add-kpis, edit-layout, dashboard-title,
              // chart-subtitles) land in result.board, not result.specMap — diff
              // the board once so those targets are classified, not dropped.
              const boardChanged = JSON.stringify(d.board) !== JSON.stringify(result.board || {});
              const boardPaths: string[] = [];
              if (boardChanged) collectDiffPaths(d.board, result.board || {}, "", boardPaths);
              const perTile: any[] = [];
              for (const tileId of changed) {
                const before = d.specMap[tileId];
                const after = result.specMap?.[tileId];
                if (before !== undefined && after !== undefined) {
                  perTile.push({ tileId, ...classifyDiff(before, after) });
                } else {
                  // Non-tile (board-level) target.
                  perTile.push({
                    tileId,
                    klass: boardChanged ? "board-visible" : "board-empty-diff",
                    rootKeys: [...new Set(boardPaths.map((p) => p.split(/[.[ ]/)[0]))],
                    paths: boardPaths.slice(0, 20),
                  });
                }
              }
              // A critique-level class = the most "visible" of its tiles, else the shared class.
              const classes = perTile.map((p) => p.klass);
              const overall = classes.includes("real-visible")
                ? "real-visible"
                : classes.includes("board-visible")
                  ? "board-visible"
                  : classes[0] || (changed.length === 0 ? "no-changed-targets" : "unknown");
              rec.apply = {
                outcome: "applied",
                changedTargets: changed,
                overallClass: overall,
                perTile,
                computedNotes: (result.evaluationReport?.computed || []).map((x: any) => x.note),
                recommendationDelta: result.recommendationDelta || null,
              };
            }
          } catch (err) {
            const msg = (err as Error).message || String(err);
            const code = msg.startsWith("APPLY_NOT_EXECUTABLE")
              ? "APPLY_NOT_EXECUTABLE"
              : msg.startsWith("APPLY_NO_CHANGE")
                ? "APPLY_NO_CHANGE"
                : "error";
            rec.apply = { outcome: code, reason: msg.slice(0, 300) };
          }
          cell.critiques.push(rec);
        }

        artifact.cells.push(cell);
        await writeFile(OUT_FILE, JSON.stringify(artifact, null, 2)); // incremental
        console.log(`    applied ${executables.length} executable critique(s)`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Part 2 — interaction-sim accuracy: frontend preview vs backend truth on the
  // one cross-filter dashboard. For each (field, value), compare the surviving
  // row set and the pinned y-domain the two code paths produce.
  // -------------------------------------------------------------------------
  console.log(`\n=== interaction-sim accuracy check (sales-command-center-new) ===`);
  try {
    const d = perDash["sales-command-center-new"];
    if (!d) throw new Error("sales-command-center-new not loaded in this run (AUDIT_ONLY filter)");
    const sourceTile = d.tiles.find((t: any) => t.spec?.usermeta?.crossFilter?.role === "source");
    const cf = sourceTile?.spec?.usermeta?.crossFilter;
    const field = cf?.field;
    const targets: string[] = Array.isArray(cf?.targets) ? cf.targets : [];
    const values = distinctValues(sourceTile.spec, field);
    const comparisons: any[] = [];
    for (const value of values) {
      for (const targetId of targets) {
        const targetSpec = d.specMap[targetId];
        if (!targetSpec) continue;
        // Frontend preview path.
        const feSpec = applyTargetFilterState(structuredClone(targetSpec), { field, value });
        const feFilterExpr = (feSpec.transform || []).find((t: any) => typeof t?.filter === "string")?.filter || null;
        const rows = Array.isArray(targetSpec.data?.values) ? targetSpec.data.values : [];
        // Frontend uses strict === (no coercion); backend uses String()===String().
        const feRowsStrict = rows.filter((r: any) => r[field] === value).length;
        const feYDomain = feSpec.encoding?.y?.scale?.domain || null;
        // Backend truth path.
        const slice = computeCrossFilterSlice(targetSpec, field, value);
        const beYDomain = slice.spec?.encoding?.y?.scale?.domain || null;
        comparisons.push({
          field,
          value,
          targetTile: targetId,
          frontend: { rowsStrictMatch: feRowsStrict, filterExpr: feFilterExpr, yDomain: feYDomain },
          backend: { rowsBefore: slice.rowsBefore, rowsAfter: slice.rowsAfter, pinnedMax: slice.pinnedMax, yDomain: beYDomain },
          rowCountMatches: feRowsStrict === slice.rowsAfter,
          yDomainMatches: JSON.stringify(feYDomain) === JSON.stringify(beYDomain),
        });
      }
    }
    // Source dimming uses opacity 0.3 (frontend) — record for the cosmetic gap.
    const dimmed = applySourceSelectionState(structuredClone(sourceTile.spec), { field, value: values[0] });
    const feOpacity = dimmed.encoding?.opacity?.value ?? null;
    artifact.interactionAccuracy = {
      dashboard: "sales-command-center-new",
      sourceTile: sourceTile.id,
      field,
      targets,
      distinctValues: values,
      frontendSourceDimOpacity: feOpacity,
      backendSourceDimOpacity: 0.35,
      comparisons,
      allRowCountsMatch: comparisons.every((c) => c.rowCountMatches),
      allYDomainsMatch: comparisons.every((c) => c.yDomainMatches),
    };
    console.log(`    ${comparisons.length} (value x target) comparisons; rowCounts match=${artifact.interactionAccuracy.allRowCountsMatch}, yDomains match=${artifact.interactionAccuracy.allYDomainsMatch}`);
  } catch (err) {
    artifact.interactionAccuracy = { error: (err as Error).message };
    console.log(`    accuracy check ERROR: ${(err as Error).message}`);
  }

  await writeFile(OUT_FILE, JSON.stringify(artifact, null, 2));
  console.log(`\n=== DONE. Wrote ${OUT_FILE} ===`);
  // Quick console summary.
  const classTally: Record<string, number> = {};
  for (const cell of artifact.cells) {
    for (const c of cell.critiques) {
      const k = c.apply?.overallClass || c.apply?.outcome || "unknown";
      classTally[k] = (classTally[k] || 0) + 1;
    }
  }
  console.log("class tally:", JSON.stringify(classTally, null, 2));
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
