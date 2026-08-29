import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeDashboard,
  isExecutable,
  recommendationKey,
  summarize,
} from "../formal-study-reliability-2026-08-26/metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, "raw");
const EFFORTS = ["low", "medium", "high"];
const DASHBOARDS = ["A", "B"];

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function deepRound(value) {
  if (Array.isArray(value)) return value.map(deepRound);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepRound(entry)]));
  }
  return typeof value === "number" ? round(value) : value;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function p90(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.9) - 1] : null;
}

function aggregate(runs) {
  const successful = runs.filter((run) => run.success);
  const critiques = successful.flatMap((run) => run.response?.critiques || []);
  const durations = successful.map((run) => run.durationMs);
  const counts = successful.map((run) => run.response?.critiques?.length || 0);
  const executable = critiques.filter(isExecutable).length;
  const uniqueRecommendations = new Set(critiques.map(recommendationKey)).size;
  return {
    attemptedRuns: runs.length,
    successfulRuns: successful.length,
    successRate: runs.length ? successful.length / runs.length : null,
    retryRuns: successful.filter((run) => run.attempt > 1).length,
    durationMs: {
      ...summarize(durations),
      median: median(durations),
      p90: p90(durations),
    },
    critiqueCount: summarize(counts),
    oneOrFewerRuns: counts.filter((count) => count <= 1).length,
    zeroCritiqueRuns: counts.filter((count) => count === 0).length,
    executableRatio: critiques.length ? executable / critiques.length : null,
    uniqueRecommendations,
    strengthsPerRun: summarize(successful.map((run) => run.response?.strengths?.length || 0)),
  };
}

function csv(records) {
  const rows = records.map((run) => {
    const critiques = run.response?.critiques || [];
    return [
      run.reasoningEffort,
      run.dashboardCode,
      run.runNumber,
      run.success,
      run.durationMs ?? "",
      critiques.length,
      critiques.filter(isExecutable).length,
      run.response?.strengths?.length || 0,
      run.attempt || "",
      run.error || "",
    ];
  });
  return [
    "effort,dashboard,run,success,durationMs,critiques,executable,strengths,attempt,error",
    ...rows.map((row) => row.map((value) => {
      const text = String(value ?? "");
      return /[\",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    }).join(",")),
  ].join("\n") + "\n";
}

function report(summary) {
  const lines = [
    "# GPT-5.4 reasoning-effort study",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    `Model: ${summary.model}`,
    "",
    "Identical frozen A/B formal-study requests; only reasoning effort changes. Five repeated runs per effort × dashboard cell were planned.",
    "",
    "| Effort | Success | Median latency | Mean critiques | <=1 critique | Executable | Stability A | Stability B |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const effort of EFFORTS) {
    const item = summary.efforts[effort];
    lines.push(`| ${effort} | ${item.overall.successfulRuns}/${item.overall.attemptedRuns} | ${(item.overall.durationMs.median / 1000).toFixed(1)}s | ${item.overall.critiqueCount.mean?.toFixed(2) ?? "n/a"} | ${item.overall.oneOrFewerRuns} | ${item.overall.executableRatio == null ? "n/a" : `${(item.overall.executableRatio * 100).toFixed(1)}%`} | ${item.dashboards.A?.withinDashboard?.stabilityIndex?.toFixed(3) ?? "n/a"} | ${item.dashboards.B?.withinDashboard?.stabilityIndex?.toFixed(3) ?? "n/a"} |`);
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

export async function analyze() {
  const names = (await readdir(RAW_DIR)).filter((name) => /^(low|medium|high)-[AB]-run-\d+\.json$/.test(name)).sort();
  const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(RAW_DIR, name), "utf8"))));
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: "gpt-5.4-2026-03-05",
    efforts: {},
  };
  for (const effort of EFFORTS) {
    const effortRuns = records.filter((run) => run.reasoningEffort === effort);
    const dashboards = {};
    for (const code of DASHBOARDS) {
      const successful = effortRuns.filter((run) => run.dashboardCode === code && run.success);
      dashboards[code] = successful.length ? analyzeDashboard(successful) : null;
    }
    summary.efforts[effort] = { overall: aggregate(effortRuns), dashboards };
  }
  const rounded = deepRound(summary);
  await writeFile(path.join(HERE, "summary.json"), JSON.stringify(rounded, null, 2) + "\n");
  await writeFile(path.join(HERE, "run-metrics.csv"), csv(records));
  await writeFile(path.join(HERE, "report.md"), report(rounded));
  return rounded;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  analyze().then((summary) => console.log(JSON.stringify(summary, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
