/**
 * compare-diversity.ts — side-by-side of two measure-diversity.ts reports.
 *
 * Usage:
 *   node scripts/compare-diversity.ts runs/diversity/diversity-baseline-7x2.json runs/diversity/diversity-round1-7x2.json
 *
 * Prints the headline metrics as BEFORE -> AFTER (delta), the kind/mode/dimension
 * distribution shifts, and (when present) the demotion breakdown for the AFTER
 * run — the four things that decide whether a relaxation round helped.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("usage: node scripts/compare-diversity.ts <before.json> <after.json>");
  process.exit(1);
}

type Report = {
  tag?: string;
  totals: { critiques: number; executable: number; runs: number };
  headline: Record<string, number>;
  kindDistribution: Array<[string, number]>;
  modeDistribution: Array<[string, number]>;
  dimensionDistribution: Array<[string, number]>;
  editPathDistribution?: Array<[string, number]>;
  demotionByReason?: Array<[string, number]>;
  demotionByIntent?: Array<[string, number]>;
};

const a = JSON.parse(readFileSync(resolve(aPath), "utf8")) as Report;
const b = JSON.parse(readFileSync(resolve(bPath), "utf8")) as Report;

const label = (r: Report, p: string): string => `${r.tag || p}`;
console.log(`BEFORE = ${label(a, aPath)}   AFTER = ${label(b, bPath)}\n`);

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}
function arrow(before: number, after: number, higherIsBetter: boolean): string {
  const d = after - before;
  if (Math.abs(d) < 1e-9) return "=";
  const good = higherIsBetter ? d > 0 : d < 0;
  return `${d > 0 ? "+" : ""}${fmt(d)} ${good ? "✓" : "✗"}`;
}

// higher-is-better for each headline metric (similarity lower is better)
const HIGHER_BETTER: Record<string, boolean> = {
  meanExecutablePerReview: true,
  executableRatioOverall: true,
  crossDashboardKindSimilarity: false,
  crossDashboardDimSimilarity: false,
  crossDashboardEditPathSimilarity: false,
  kindEntropyNormalized: true,
  kindTop1Share: false,
  meanDistinctKindsPerReview: true,
};

console.log("-- headline (BEFORE -> AFTER, delta) --");
const keys = new Set([...Object.keys(a.headline), ...Object.keys(b.headline)]);
for (const k of keys) {
  const before = a.headline[k] ?? 0;
  const after = b.headline[k] ?? 0;
  const hib = HIGHER_BETTER[k] ?? true;
  console.log(`   ${k.padEnd(34)} ${fmt(before).padStart(7)} -> ${fmt(after).padStart(7)}   (${arrow(before, after, hib)})`);
}

console.log(`\n   totals: critiques ${a.totals.critiques} -> ${b.totals.critiques}, executable ${a.totals.executable} -> ${b.totals.executable}, runs ${a.totals.runs} -> ${b.totals.runs}`);

function diffDist(name: string, aDist: Array<[string, number]>, bDist: Array<[string, number]>): void {
  const am = new Map(aDist);
  const bm = new Map(bDist);
  const all = [...new Set([...am.keys(), ...bm.keys()])];
  console.log(`\n-- ${name} (before -> after) --`);
  all.sort((x, y) => (bm.get(y) ?? 0) - (bm.get(x) ?? 0));
  for (const k of all) {
    const bv = am.get(k) ?? 0;
    const av = bm.get(k) ?? 0;
    if (bv === av) console.log(`   ${String(av).padStart(3)}        ${k}`);
    else console.log(`   ${String(bv).padStart(3)} -> ${String(av).padStart(3)}  ${k}`);
  }
}

diffDist("kind", a.kindDistribution, b.kindDistribution);
diffDist("mode", a.modeDistribution, b.modeDistribution);
diffDist("dimension", a.dimensionDistribution, b.dimensionDistribution);
if (a.editPathDistribution || b.editPathDistribution) {
  diffDist("edit-spec paths", a.editPathDistribution ?? [], b.editPathDistribution ?? []);
}

if (b.demotionByReason?.length) {
  console.log("\n-- AFTER demotions by reason --");
  for (const [k, v] of b.demotionByReason) console.log(`   ${String(v).padStart(3)}  ${k}`);
  console.log("\n-- AFTER demotions by intent [payload] -> reason --");
  for (const [k, v] of (b.demotionByIntent ?? [])) console.log(`   ${String(v).padStart(3)}  ${k}`);
}
