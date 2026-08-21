/**
 * measure-diversity.ts — empirical probe for the "cross-dashboard homogenization"
 * question.
 *
 * The complaint: different dashboards (different data, chart mixes, goals,
 * audiences, visual languages) come back with near-identical reviews — the same
 * handful of fix types (add-kpi, add-tooltip, unify-color, subtitle...) applied
 * over and over, too much guidance-only prose, too few Applyable fixes with a
 * visible before/after. A healthy multi-view review should yield ~10 EXECUTABLE
 * critiques whose fixes are structurally distinct and specific to THAT board.
 *
 * This harness runs the live review engine over the sample dashboards and
 * measures, per review and across reviews:
 *   - executableCount / executableRatio  (target: ~10 executable per review)
 *   - proposal.kind distribution + entropy + top-1 share  (fix-type diversity)
 *   - distinct kinds per review           (how many different fixes per board)
 *   - cross-dashboard cosine similarity of the kind & dimension vectors
 *       -> THE homogenization index: 1.0 means every board gets the same mix.
 *
 * A critique is EXECUTABLE iff proposal.mode !== "guidance_only" (equivalently
 * kind !== "manual"); that is exactly the gate /apply enforces
 * (apply/index.ts:381), so this count is what the author can actually apply.
 *
 * Usage:
 *   node scripts/measure-diversity.ts                 # all dashboards x REPS(=2)
 *   ONLY=ocean REPS=1 node scripts/measure-diversity.ts   # smoke test
 *   TAG=baseline node scripts/measure-diversity.ts    # names the output file
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoardMeta, Critique, CritiqueRequest, SpecMap } from "../src/contracts.ts";
import { runCritique } from "../src/engine.ts";
import { GatewayClient } from "../src/llm/client.ts";
import { model, provider } from "../src/llm/gateway.ts";
import { Tracer } from "../src/trace.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH_DIR = resolve(HERE, "..", "..", "public", "dashboards", "v2");
const REPS = Math.max(1, Number(process.env.REPS || 2));
const ONLY = (process.env.ONLY || "").toLowerCase();
const TAG = process.env.TAG || "";

interface Raw {
  dashboard?: { title?: string; subtitle?: string; hasKpis?: boolean };
  tiles?: Array<{ id: string; label?: string; subtitle?: string; bounds?: { x: number; y: number; w: number; h: number }; spec: unknown }>;
}

function buildRequest(raw: Raw): CritiqueRequest {
  const tiles = raw.tiles ?? [];
  const specMap: SpecMap = {};
  for (const t of tiles) specMap[t.id] = t.spec as SpecMap[string];
  let canvasWidth = 1100;
  let canvasHeight = 720;
  for (const t of tiles) {
    if (t.bounds) {
      canvasWidth = Math.max(canvasWidth, t.bounds.x + t.bounds.w);
      canvasHeight = Math.max(canvasHeight, t.bounds.y + t.bounds.h);
    }
  }
  const board: BoardMeta = {
    title: raw.dashboard?.title,
    subtitle: raw.dashboard?.subtitle || "",
    hasKpis: Boolean(raw.dashboard?.hasKpis),
    canvasWidth,
    canvasHeight,
    tiles: tiles.map((t) => ({
      id: t.id,
      title: t.label,
      hasSubtitle: Boolean(t.subtitle),
      bounds: t.bounds,
    })),
  };
  return { version: 1, context: {}, specMap, board, reviewScope: "full" };
}

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** Shannon entropy (bits) of a count distribution, plus a 0..1 normalized form. */
function entropy(map: Map<string, number>): { bits: number; normalized: number; distinct: number } {
  const counts = [...map.values()].filter((n) => n > 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0 || counts.length <= 1) return { bits: 0, normalized: 0, distinct: counts.length };
  let bits = 0;
  for (const n of counts) {
    const p = n / total;
    bits -= p * Math.log2(p);
  }
  return { bits, normalized: bits / Math.log2(counts.length), distinct: counts.length };
}

/** Cosine similarity of two count maps over the union of their keys. */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const va = a.get(k) ?? 0;
    const vb = b.get(k) ?? 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Mean pairwise cosine similarity across a set of per-dashboard vectors.
 * 1.0 => every dashboard gets an identical mix (fully homogenized). */
function meanPairwiseSimilarity(vectors: Map<string, number>[]): number {
  if (vectors.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      sum += cosine(vectors[i], vectors[j]);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : sum / pairs;
}

const isExecutable = (c: Critique): boolean => c.proposal?.mode !== "guidance_only";

/** A compact fingerprint of what a proposal would actually change — used to
 * judge "structurally distinct, visible before/after" beyond just the kind. */
function structuralShape(c: Critique): string {
  const p = c.proposal ?? ({} as Critique["proposal"]);
  const parts: string[] = [];
  if (Array.isArray(p.edits) && p.edits.length) parts.push(`edits:${p.edits.length}`);
  if (Array.isArray(p.layout) && p.layout.length) parts.push(`layout:${p.layout.length}`);
  if (p.composition) parts.push(`comp:${p.composition}`);
  if (Array.isArray(p.kpis) && p.kpis.length) parts.push(`kpis:${p.kpis.length}`);
  if (Array.isArray(p.palette) && p.palette.length) parts.push(`palette:${p.palette.length}`);
  return parts.join(",") || "(none)";
}

const client = new GatewayClient();
if (!client.available()) {
  throw new Error("LLM_REQUIRED: no token found (secrets/openai.txt, secrets/anthropic_token.txt, or env)");
}

const files = readdirSync(DASH_DIR)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !ONLY || f.toLowerCase().includes(ONLY));

console.log(`provider=${provider()} model=${model()} dashboards=${files.length} reps=${REPS}${TAG ? ` tag=${TAG}` : ""}`);

// overall aggregates
const kindAll = new Map<string, number>();
const dimAll = new Map<string, number>();
const objAll = new Map<string, number>();
const recoAll = new Map<string, number>();
const shapeAll = new Map<string, number>();
const modeAll = new Map<string, number>();
// demotion telemetry (only populated when RE_API_DIVERSITY_DEBUG is set)
const demotionByReason = new Map<string, number>();     // sanitize | tentative | process
const demotionByIntent = new Map<string, number>();      // "requested [payloadShape] -> reason"

const editPathAll = new Map<string, number>();          // top-2 path segments of every edit-spec edit
// per-dashboard vectors (summed over reps) for cross-dashboard similarity
const perDashKind = new Map<string, Map<string, number>>();
const perDashDim = new Map<string, Map<string, number>>();
const perDashEditPath = new Map<string, Map<string, number>>();

/** The part of a tile spec an edit touches, at coarse (top-2-segment) grain —
 * e.g. "mark", "encoding.x", "transform", "encoding.color". Kind alone is too
 * coarse once B/D route many fixes to edit-spec; this reveals whether the actual
 * spec changes are diverse across boards or all poke the same place. */
function editPathsOf(c: Critique): string[] {
  const edits = Array.isArray(c.proposal?.edits) ? c.proposal.edits : [];
  return edits.map((e) => (Array.isArray(e?.path) ? e.path.slice(0, 2).map(String).join(".") : "")).filter(Boolean);
}

const perRun: Array<Record<string, unknown>> = [];
const perCritique: Array<Record<string, unknown>> = [];

let totalCritiques = 0;
let totalExecutable = 0;

for (const file of files) {
  const id = file.replace(/\.json$/, "");
  const raw = JSON.parse(readFileSync(resolve(DASH_DIR, file), "utf8")) as Raw;
  const request = buildRequest(raw);
  if (!perDashKind.has(id)) perDashKind.set(id, new Map());
  if (!perDashDim.has(id)) perDashDim.set(id, new Map());
  if (!perDashEditPath.has(id)) perDashEditPath.set(id, new Map());
  const dashKind = perDashKind.get(id)!;
  const dashDim = perDashDim.get(id)!;
  const dashEditPath = perDashEditPath.get(id)!;

  for (let rep = 1; rep <= REPS; rep += 1) {
    const tracer = new Tracer(`diversity-${id}-${rep}`, { logDir: null });
    const started = Date.now();
    const response = await runCritique(request, tracer, { client });
    const ms = Date.now() - started;

    const critiques = response.critiques;
    const executable = critiques.filter(isExecutable);
    totalCritiques += critiques.length;
    totalExecutable += executable.length;

    const runKinds = new Map<string, number>();
    for (const c of critiques) {
      const kind = c.proposal?.kind ?? "(none)";
      const mode = c.proposal?.mode ?? "executable";
      inc(kindAll, kind);
      inc(dimAll, c.dimension);
      inc(objAll, c.object ?? "(none)");
      inc(recoAll, c.recommendation ?? "(omitted -> other)");
      inc(modeAll, mode);
      inc(shapeAll, structuralShape(c));
      inc(dashKind, kind);
      inc(dashDim, c.dimension);
      inc(runKinds, kind);
      for (const p of editPathsOf(c)) {
        inc(editPathAll, p);
        inc(dashEditPath, p);
      }
      const diag = (c.proposal as Record<string, unknown>)?.diag as
        | { requested?: string; final?: string; demoted?: boolean; reason?: string; payload?: Record<string, boolean> }
        | undefined;
      if (diag?.demoted) {
        const reason = diag.reason ?? "sanitize";
        inc(demotionByReason, reason);
        const shape = diag.payload
          ? Object.entries(diag.payload).filter(([, v]) => v).map(([k]) => k.replace(/^had/, "")).join("+") || "no-payload"
          : "no-payload";
        inc(demotionByIntent, `${diag.requested ?? "?"} [${shape}] -> ${reason}`);
      }
      perCritique.push({
        dashboard: id,
        rep,
        kind,
        mode,
        executable: isExecutable(c),
        dimension: c.dimension,
        object: c.object ?? null,
        recommendation: c.recommendation ?? null,
        shape: structuralShape(c),
        title: c.title,
        ...(diag ? { diag } : {}),
      });
    }

    perRun.push({
      dashboard: id,
      rep,
      ms,
      critiques: critiques.length,
      executable: executable.length,
      guidanceOnly: critiques.length - executable.length,
      executableRatio: critiques.length ? executable.length / critiques.length : 0,
      distinctKinds: runKinds.size,
      distinctExecutableKinds: new Set(executable.map((c) => c.proposal?.kind)).size,
    });
    console.log(
      `  ${id} #${rep}: ${critiques.length} critiques, ${executable.length} executable, ${runKinds.size} distinct kinds, ${ms}ms`,
    );
  }
}

const dashIds = [...perDashKind.keys()];
const kindVectors = dashIds.map((id) => perDashKind.get(id)!);
const dimVectors = dashIds.map((id) => perDashDim.get(id)!);
const editPathVectors = dashIds.map((id) => perDashEditPath.get(id)!);

const kindEntropy = entropy(kindAll);
const dimEntropy = entropy(dimAll);
const executableRatioOverall = totalCritiques ? totalExecutable / totalCritiques : 0;
const kindTop = sortedEntries(kindAll)[0];
const meanExecPerReview = perRun.reduce((a, r) => a + (r.executable as number), 0) / (perRun.length || 1);
const meanDistinctKinds = perRun.reduce((a, r) => a + (r.distinctKinds as number), 0) / (perRun.length || 1);

const report = {
  provider: provider(),
  model: model(),
  reps: REPS,
  tag: TAG,
  dashboards: files,
  totals: { critiques: totalCritiques, executable: totalExecutable, runs: perRun.length },
  headline: {
    // The four numbers that decide "is homogenization fixed?"
    meanExecutablePerReview: Number(meanExecPerReview.toFixed(2)),          // target ~10
    executableRatioOverall: Number(executableRatioOverall.toFixed(3)),       // higher = more Applyable
    crossDashboardKindSimilarity: Number(meanPairwiseSimilarity(kindVectors).toFixed(3)), // lower = less homogeneous
    crossDashboardDimSimilarity: Number(meanPairwiseSimilarity(dimVectors).toFixed(3)),
    crossDashboardEditPathSimilarity: Number(meanPairwiseSimilarity(editPathVectors).toFixed(3)), // do the spec changes differ across boards?
    kindEntropyNormalized: Number(kindEntropy.normalized.toFixed(3)),        // higher = more fix-type variety
    kindTop1Share: kindTop && totalCritiques ? Number((kindTop[1] / totalCritiques).toFixed(3)) : 0,
    meanDistinctKindsPerReview: Number(meanDistinctKinds.toFixed(2)),
  },
  kindDistribution: sortedEntries(kindAll),
  modeDistribution: sortedEntries(modeAll),
  dimensionDistribution: sortedEntries(dimAll),
  objectDistribution: sortedEntries(objAll),
  recommendationDistribution: sortedEntries(recoAll),
  structuralShapeDistribution: sortedEntries(shapeAll),
  editPathDistribution: sortedEntries(editPathAll),
  demotionByReason: sortedEntries(demotionByReason),
  demotionByIntent: sortedEntries(demotionByIntent),
  kindEntropy,
  dimEntropy,
  perDashboardKind: dashIds.map((id) => ({ dashboard: id, kinds: sortedEntries(perDashKind.get(id)!) })),
  perRun,
  perCritique,
};

const outDir = resolve(process.cwd(), "runs", "diversity");
mkdirSync(outDir, { recursive: true });
const stamp = TAG ? `${TAG}-` : "";
const outPath = resolve(outDir, `diversity-${stamp}${files.length}x${REPS}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log("\n================ DIVERSITY / HOMOGENIZATION PROBE ================");
console.log(`runs=${perRun.length}  critiques=${totalCritiques}  executable=${totalExecutable}`);
console.log("\n-- headline --");
for (const [k, v] of Object.entries(report.headline)) console.log(`   ${String(v).padStart(6)}  ${k}`);
console.log("\n-- proposal KIND distribution (fix-type mix) --");
for (const [k, v] of sortedEntries(kindAll)) console.log(`   ${String(v).padStart(3)}  ${k}`);
console.log("\n-- mode (executable vs guidance-only) --");
for (const [k, v] of sortedEntries(modeAll)) console.log(`   ${String(v).padStart(3)}  ${k}`);
console.log("\n-- dimension distribution --");
for (const [k, v] of sortedEntries(dimAll)) console.log(`   ${String(v).padStart(3)}  ${k}`);
console.log("\n-- structural shape (what actually changes) --");
for (const [k, v] of sortedEntries(shapeAll)) console.log(`   ${String(v).padStart(3)}  ${k}`);
if (editPathAll.size) {
  console.log("\n-- edit-spec paths touched (are the spec changes diverse?) --");
  for (const [k, v] of sortedEntries(editPathAll)) console.log(`   ${String(v).padStart(3)}  ${k}`);
}
if (demotionByReason.size) {
  console.log("\n-- DEMOTIONS by reason (executable intent -> guidance) --");
  for (const [k, v] of sortedEntries(demotionByReason)) console.log(`   ${String(v).padStart(3)}  ${k}`);
  console.log("\n-- DEMOTIONS by intent [payload] -> reason --");
  for (const [k, v] of sortedEntries(demotionByIntent)) console.log(`   ${String(v).padStart(3)}  ${k}`);
}
console.log(`\nfull report: ${outPath}`);
