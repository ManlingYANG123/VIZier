/**
 * measure-cognition.ts — empirical probe for the "cognition never surfaces" question.
 *
 * Runs the live review engine over the sample dashboards and records, per
 * critique, both the DIAGNOSING object (what the issue is about) and the
 * displayed dimension (the fix branch the UI groups by). The point is to
 * separate two hypotheses:
 *   (a) cognition is diagnosed but hidden — object=cognition critiques exist,
 *       yet their dimension is some other branch (or "other"), so the UI never
 *       shows a "cognition" group; or
 *   (b) cognition is barely diagnosed at all — the model rarely picks the
 *       cognition object in the first place.
 *
 * Usage:
 *   node scripts/measure-cognition.ts            # 4 dashboards x REPS(=3)
 *   ONLY=ocean REPS=1 node scripts/measure-cognition.ts   # smoke test
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoardMeta, CritiqueRequest, SpecMap } from "../src/contracts.ts";
import { runCritique } from "../src/engine.ts";
import { GatewayClient } from "../src/llm/client.ts";
import { model, provider } from "../src/llm/gateway.ts";
import { Tracer } from "../src/trace.ts";
import { OBJECTS } from "../src/generate/review-data.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH_DIR = resolve(HERE, "..", "..", "public", "dashboards", "v2");
const REPS = Math.max(1, Number(process.env.REPS || 3));
const ONLY = (process.env.ONLY || "").toLowerCase();

/** object code -> its cluster label (e.g. "clarity & insight"). */
const CLUSTER = new Map(OBJECTS.map((o) => [o.code, o.category]));
const COMPREHENSION = new Set(
  OBJECTS.filter((o) => o.category === "clarity & insight").map((o) => o.code),
);

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
  // Empty context => grounding limited to "dashboard evidence" + "general
  // design principle" (both always available). cognition can ground on the
  // latter, so an empty brief does NOT bias cognition out.
  return { version: 1, context: {}, specMap, board, reviewScope: "full" };
}

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

const client = new GatewayClient();
if (!client.available()) {
  throw new Error("LLM_REQUIRED: no token found (secrets/openai.txt, secrets/anthropic_token.txt, or env)");
}

const files = readdirSync(DASH_DIR)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !ONLY || f.toLowerCase().includes(ONLY));

console.log(`provider=${provider()} model=${model()} dashboards=${files.length} reps=${REPS}`);

// aggregates
const diagObjAll = new Map<string, number>();       // every diagnosis object
const diagObjIssue = new Map<string, number>();      // only evaluated_issue
const critObj = new Map<string, number>();           // critique.object
const critDim = new Map<string, number>();           // critique.dimension (what UI groups by)
const critReco = new Map<string, number>();          // critique.recommendation (or "(omitted->other)")
const objToDim = new Map<string, number>();          // "object => dimension" cross-tab
const comprehensionRouting = new Map<string, number>(); // where clarity&insight-object critiques land
const perRun: Array<Record<string, unknown>> = [];

let totalCritiques = 0;
let totalDiagnoses = 0;

for (const file of files) {
  const id = file.replace(/\.json$/, "");
  const raw = JSON.parse(readFileSync(resolve(DASH_DIR, file), "utf8")) as Raw;
  const request = buildRequest(raw);
  for (let rep = 1; rep <= REPS; rep += 1) {
    const tracer = new Tracer(`measure-${id}-${rep}`, { logDir: null });
    const started = Date.now();
    const response = await runCritique(request, tracer, { client });
    const ms = Date.now() - started;
    totalCritiques += response.critiques.length;
    totalDiagnoses += response.diagnoses.length;

    for (const d of response.diagnoses) {
      inc(diagObjAll, d.object);
      if (d.outcome === "evaluated_issue") inc(diagObjIssue, d.object);
    }
    for (const c of response.critiques) {
      const obj = c.object ?? "(none)";
      inc(critObj, obj);
      inc(critDim, c.dimension);
      inc(critReco, c.recommendation ?? "(omitted -> other)");
      inc(objToDim, `${obj}  =>  ${c.dimension}`);
      if (COMPREHENSION.has(obj)) {
        inc(comprehensionRouting, `${obj} [${c.problem ?? "-"}]  =>  dim:${c.dimension}  reco:${c.recommendation ?? "(omitted)"}`);
      }
    }
    perRun.push({
      dashboard: id,
      rep,
      ms,
      critiques: response.critiques.length,
      diagnoses: response.diagnoses.length,
      cognitionAsObject: response.critiques.filter((c) => c.object === "cognition").length,
      cognitionAsDimension: response.critiques.filter((c) => c.dimension === "cognition").length,
      strengthsCognitionDim: response.strengths.filter((s) => s.dimension === "cognition").length,
    });
    console.log(`  ${id} #${rep}: ${response.critiques.length} critiques, ${response.diagnoses.length} diagnoses, ${ms}ms`);
  }
}

const report = {
  provider: provider(),
  model: model(),
  reps: REPS,
  dashboards: files,
  totals: { critiques: totalCritiques, diagnoses: totalDiagnoses, runs: perRun.length },
  cognition: {
    diagnosedAsObject_all: diagObjAll.get("cognition") ?? 0,
    diagnosedAsObject_issue: diagObjIssue.get("cognition") ?? 0,
    critiqueObject: critObj.get("cognition") ?? 0,
    critiqueDimension_VISIBLE: critDim.get("cognition") ?? 0,
  },
  diagnosisObjectDistribution_all: sortedEntries(diagObjAll),
  diagnosisObjectDistribution_evaluatedIssue: sortedEntries(diagObjIssue),
  critiqueObjectDistribution: sortedEntries(critObj),
  critiqueDimensionDistribution: sortedEntries(critDim),
  objectToDimensionCrossTab: sortedEntries(objToDim),
  comprehensionFamilyRouting: sortedEntries(comprehensionRouting),
  perRun,
};

const outDir = resolve(process.cwd(), "runs", "cognition");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `cognition-${files.length}x${REPS}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log("\n================ COGNITION PROBE ================");
console.log(`runs=${perRun.length}  critiques=${totalCritiques}  diagnoses=${totalDiagnoses}`);
console.log(`cognition diagnosed as OBJECT (evaluated_issue): ${report.cognition.diagnosedAsObject_issue}`);
console.log(`cognition on a CRITIQUE's object:                ${report.cognition.critiqueObject}`);
console.log(`cognition as VISIBLE dimension (UI group):       ${report.cognition.critiqueDimension_VISIBLE}`);
console.log("\n-- critique DIMENSION distribution (what the UI shows) --");
for (const [k, v] of sortedEntries(critDim)) console.log(`   ${String(v).padStart(3)}  ${k}`);
console.log("\n-- critique OBJECT distribution (what issues are ABOUT) --");
for (const [k, v] of sortedEntries(critObj)) console.log(`   ${String(v).padStart(3)}  ${k}${CLUSTER.get(k) ? `  (${CLUSTER.get(k)})` : ""}`);
console.log("\n-- clarity & insight family: object => where it was routed --");
for (const [k, v] of sortedEntries(comprehensionRouting)) console.log(`   ${String(v).padStart(3)}  ${k}`);
console.log(`\nfull report: ${outPath}`);
