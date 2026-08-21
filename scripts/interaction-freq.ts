/**
 * TEMPORARY interaction-frequency probe (delete after the run).
 *
 * The main matrix (runtime-audit-data.json) retained only EXECUTABLE critiques
 * (the ones it applied). The interaction-sim surface (inline before/after) also
 * renders for GUIDANCE-mode interaction critiques, so to answer "does the sim
 * ever appear on sales / air-quality?" accurately we must count ALL critiques,
 * grouped by (dashboard, mode, proposalKind). Runs one temperature, N rounds,
 * fully sequential (one /critique in flight at a time).
 *
 * Run: node scripts/interaction-freq.ts
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeDashboardDocument } from "../src/vega-dashboard-adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(V2_ROOT, "../..");
const OUT_DIR = path.join(REPO_ROOT, "proposals", "0814");
const OUT_FILE = path.join(OUT_DIR, "interaction-freq-data.json");
const BASE = process.env.RE_API_BASE || "http://127.0.0.1:8091";
const TEMP = Number(process.env.FREQ_TEMP || "0.2");
const ROUNDS = Number(process.env.FREQ_ROUNDS || "2");
const INTERACTION_KINDS = new Set(["add-cross-filter", "show-filter-state", "add-tooltip"]);

const TARGETS = [
  { id: "garden-birds-new", pdf: "BBC GEL _ How to design infographics.pdf",
    context: { goal: "Show which garden birds are most common in Britain and how key species' populations have changed over time, in an engaging, accessible editorial infographic.", audience: "General public and nature enthusiasts reading a data-driven story." } },
  { id: "sales-command-center-new", pdf: "Best Practices for Effective Dashboards - Tableau.pdf",
    context: { goal: "Monitor retail sales performance across regions, product categories, and time to support fast operational decisions.", audience: "Sales managers and operations leads reviewing performance daily." } },
  { id: "air-quality-new", pdf: "Data visualizations _ U.S. Web Design System (USWDS).pdf",
    context: { goal: "Help local residents understand recent air-quality trends and know what to do on bad-air days.", audience: "General public and residents checking their local air quality." } },
];

async function streamSSE(route: string, body: unknown): Promise<any> {
  const res = await fetch(BASE + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "", result: any = null, error: any = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload: any; try { payload = JSON.parse(data); } catch { payload = data; }
      if (ev === "result") result = payload; else if (ev === "error") error = payload;
    }
  }
  if (error) throw new Error(error.message || error.error || JSON.stringify(error));
  return result;
}

async function extractPdfText(pdfPath: string): Promise<{ text: string; pageCount: number }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it: any) => (typeof it.str === "string" ? it.str : "")).join(" "));
  }
  return { text: pages.join("\n\n"), pageCount: doc.numPages };
}

async function loadDashboard(id: string): Promise<{ specMap: any; board: any; tiles: any[] }> {
  const raw = await (await fetch(`${BASE}/api/dashboards/${encodeURIComponent(id)}`)).json();
  const doc = normalizeDashboardDocument(raw, id);
  const tiles = doc.tiles || [];
  const specMap: any = {};
  for (const t of tiles) specMap[t.id] = structuredClone(t.spec);
  const showChartSubtitles = Boolean(doc.dashboard?.showChartSubtitles);
  const board = {
    title: doc.dashboard?.title || id, subtitle: doc.dashboard?.subtitle || "",
    hasKpis: Boolean(doc.dashboard?.hasKpis), kpis: [],
    canvasWidth: doc.dashboard?.canvasWidth || 1100, canvasHeight: doc.dashboard?.canvasHeight || 720,
    tiles: tiles.map((t: any) => ({ id: t.id, title: t.label || t.id, hasSubtitle: showChartSubtitles, bounds: t.bounds || { x: 0, y: 0, w: 400, h: 300 } })),
  };
  return { specMap, board, tiles };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const out: any = { base: BASE, temperature: TEMP, rounds: ROUNDS, perDashboard: {} };
  for (const target of TARGETS) {
    console.log(`\n=== ${target.id} ===`);
    const { specMap, board, tiles } = await loadDashboard(target.id);
    const hasCrossFilterSource = tiles.some((t: any) => t.spec?.usermeta?.crossFilter?.role === "source");
    let constraintSet: any = null;
    try {
      const { text, pageCount } = await extractPdfText(path.join(V2_ROOT, "public", "pdfs", target.pdf));
      const intake = await (await fetch(`${BASE}/intake-constraints`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: { kind: "pdf-text", text, filename: target.pdf, pageCount }, requireLLM: true }) })).json();
      constraintSet = intake?.constraintSet || null;
    } catch (err) { console.log(`  intake failed: ${(err as Error).message}`); }
    const context = { ...target.context, fieldStatus: { goal: "confirmed", audience: "confirmed", constraints: constraintSet ? "confirmed" : "missing" }, notes: [] };

    const rounds: any[] = [];
    for (let r = 1; r <= ROUNDS; r += 1) {
      console.log(`  round ${r} ...`);
      const resp = await streamSSE("/critique", {
        version: 1, context, specMap, board, reviewScope: "full", requireLLM: true,
        reviewTemperature: TEMP, savedRationales: [], ...(constraintSet ? { constraintSet } : {}),
      });
      const critiques = resp?.critiques || [];
      const rows = critiques.map((c: any) => ({
        id: c.id, dimension: c.dimension, mode: c.proposal?.mode || "(none)",
        proposalKind: c.proposal?.kind || "(none)", interactionKind: c.interactionKind || null,
        isInteraction: INTERACTION_KINDS.has(c.proposal?.kind) || c.dimension === "interaction",
      }));
      const interactionRows = rows.filter((x: any) => INTERACTION_KINDS.has(x.proposalKind));
      rounds.push({ round: r, total: rows.length, interactionKindCount: interactionRows.length, interaction: interactionRows, all: rows });
      console.log(`    ${rows.length} critiques, ${interactionRows.length} interaction-kind`);
    }
    out.perDashboard[target.id] = { hasCrossFilterSource, constraintCount: (constraintSet?.constraints || []).length, rounds };
    await writeFile(OUT_FILE, JSON.stringify(out, null, 2));
  }
  // Compact summary
  console.log("\n=== SUMMARY (interaction-kind proposals per dashboard) ===");
  for (const [id, d] of Object.entries<any>(out.perDashboard)) {
    const total = d.rounds.reduce((s: number, r: any) => s + r.total, 0);
    const inter = d.rounds.reduce((s: number, r: any) => s + r.interactionKindCount, 0);
    const kinds = d.rounds.flatMap((r: any) => r.interaction.map((x: any) => `${x.proposalKind}/${x.mode}`));
    console.log(`${id}: hasSource=${d.hasCrossFilterSource} totalCritiques=${total} interactionKind=${inter} [${kinds.join(", ")}]`);
  }
  console.log(`\nWrote ${OUT_FILE}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
