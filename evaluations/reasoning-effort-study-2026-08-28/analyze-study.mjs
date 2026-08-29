import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeDashboard,
  isExecutable,
  summarize,
} from "../formal-study-reliability-2026-08-26/metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, "raw");
const BASELINE_DIR = path.join(HERE, "../formal-study-reliability-2026-08-26/raw");
const DASHBOARDS = ["A", "B"];
const CONFIGURATIONS = [
  "none-temp04-baseline",
  "none-temp02",
  "low",
  "medium",
  "high",
  "low-nojudge",
  "low-coverage12",
  "low-recovery11-cap11",
];

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

function cardCounts(run) {
  const critiques = run.response?.critiques || [];
  const goodJob = run.response?.strengths?.length || 0;
  const fixable = critiques.filter(isExecutable).length;
  const guidance = critiques.length - fixable;
  return { fixable, guidance, goodJob, total: critiques.length + goodJob };
}

function aggregate(runs) {
  const successful = runs.filter((run) => run.success);
  const cards = successful.map(cardCounts);
  const durations = successful.map((run) => run.durationMs);
  const pipeline = successful
    .map((run) => (run.events || []).find((event) => event.event === "guardrail_done")?.payload?.data?.pipelineDiagnostics)
    .filter(Boolean);
  return {
    attemptedRuns: runs.length,
    successfulRuns: successful.length,
    successRate: runs.length ? successful.length / runs.length : null,
    durationMs: { ...summarize(durations), median: median(durations), p90: p90(durations) },
    fixable: summarize(cards.map((item) => item.fixable)),
    guidance: summarize(cards.map((item) => item.guidance)),
    goodJob: summarize(cards.map((item) => item.goodJob)),
    totalCards: summarize(cards.map((item) => item.total)),
    target12To13Runs: cards.filter((item) => item.total >= 12 && item.total <= 13).length,
    below12Runs: cards.filter((item) => item.total < 12).length,
    above13Runs: cards.filter((item) => item.total > 13).length,
    pipeline: pipeline.length ? {
      observedRuns: pipeline.length,
      firstPassValidated: summarize(pipeline.map((item) => item.firstPassValidated)),
      recoveryValidated: summarize(pipeline.map((item) => item.secondPassValidated)),
      coveragePassCalls: summarize(pipeline.map((item) => item.coveragePassCalls ?? 1)),
      afterPreflight: summarize(pipeline.map((item) => item.afterProposalPreflight)),
      droppedByConstraint: summarize(pipeline.map((item) => item.droppedByConstraint)),
    } : null,
  };
}

function parseCurrentName(name) {
  const match = /^(none|low|medium|high)-([AB])-run-(\d+)(?:-([a-zA-Z0-9_-]+))?\.json$/.exec(name);
  if (!match) return null;
  const [, effort, dashboard, runNumber, tag = ""] = match;
  let configuration = effort;
  if (effort === "none" && tag === "temp02") configuration = "none-temp02";
  else if (effort === "low" && tag === "nojudge") configuration = "low-nojudge";
  else if (effort === "low" && tag === "coverage12") configuration = "low-coverage12";
  else if (effort === "low" && tag === "recovery11") configuration = "low-recovery11-cap11";
  else if (tag) return null;
  return { configuration, dashboard, runNumber: Number(runNumber) };
}

async function loadRecords() {
  const records = [];
  for (const name of await readdir(RAW_DIR)) {
    const parsed = parseCurrentName(name);
    if (!parsed || !CONFIGURATIONS.includes(parsed.configuration)) continue;
    const record = JSON.parse(await readFile(path.join(RAW_DIR, name), "utf8"));
    // recovery11 was generated immediately before the deterministic full-review
    // cap changed from 14 to 11. Apply the exact production cap to the already
    // ranked array instead of spending on identical API reruns.
    const response = parsed.configuration === "low-recovery11-cap11" && record.response
      ? { ...record.response, critiques: (record.response.critiques || []).slice(0, 11) }
      : record.response;
    records.push({ ...record, response, configuration: parsed.configuration });
  }
  for (const name of await readdir(BASELINE_DIR)) {
    const match = /^([AB])-run-(\d+)\.json$/.exec(name);
    if (!match) continue;
    const record = JSON.parse(await readFile(path.join(BASELINE_DIR, name), "utf8"));
    records.push({ ...record, configuration: "none-temp04-baseline", dashboardCode: match[1], runNumber: Number(match[2]) });
  }
  return records.sort((a, b) =>
    CONFIGURATIONS.indexOf(a.configuration) - CONFIGURATIONS.indexOf(b.configuration) ||
    a.dashboardCode.localeCompare(b.dashboardCode) || a.runNumber - b.runNumber);
}

function csv(records) {
  const rows = records.map((run) => {
    const cards = cardCounts(run);
    return [run.configuration, run.dashboardCode, run.runNumber, run.success, run.durationMs ?? "", cards.fixable, cards.guidance, cards.goodJob, cards.total];
  });
  return [
    "configuration,dashboard,run,success,durationMs,fixable,guidance,goodJob,totalCards",
    ...rows.map((row) => row.join(",")),
  ].join("\n") + "\n";
}

function report(summary) {
  const lines = [
    "# GPT-5.4 review-configuration study",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "Visible-card target: 12–13 total cards per review, counting fixable critiques, guidance critiques, and Good Job strengths.",
    "",
    "| Configuration | Runs | Median | Total cards mean (range) | Target hits | Fixable | Guidance | Good Job | Stability A/B |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const name of CONFIGURATIONS) {
    const item = summary.configurations[name];
    if (!item?.overall.attemptedRuns) continue;
    const overall = item.overall;
    const range = `${overall.totalCards.min}–${overall.totalCards.max}`;
    const stabilityA = item.dashboards.A?.withinDashboard?.stabilityIndex;
    const stabilityB = item.dashboards.B?.withinDashboard?.stabilityIndex;
    lines.push(`| ${name} | ${overall.successfulRuns}/${overall.attemptedRuns} | ${(overall.durationMs.median / 1000).toFixed(1)}s | ${overall.totalCards.mean.toFixed(2)} (${range}) | ${overall.target12To13Runs}/${overall.successfulRuns} | ${overall.fixable.mean.toFixed(2)} | ${overall.guidance.mean.toFixed(2)} | ${overall.goodJob.mean.toFixed(2)} | ${stabilityA?.toFixed(3) ?? "n/a"} / ${stabilityB?.toFixed(3) ?? "n/a"} |`);
  }
  lines.push(
    "",
    "## Recommendation",
    "",
    "Use GPT-5.4 low for full-review discovery, keep the LLM solution judge off, retain grounding + deterministic merge/rank + real apply/compile preflight + document constraints, allow at most two bounded recovery passes when coverage is sparse, and cap the visible critique list at 11. This configuration produced 12–13 total visible cards in 5/6 runs (the remaining run produced 11 after one preflight and one document-constraint rejection).",
    "",
    "Do not use global medium or high for this study workflow. They produced only 0–2 visible cards while taking roughly 3–4 minutes per review. Stage traces show that medium can return empty critique arrays in both discovery passes; deterministic fallbacks are then rewritten or rejected by the same reasoning-heavy judge, and document constraints can remove the final survivor.",
    "",
    "## Study guidance",
    "",
    "- Freeze the model snapshot, reasoning effort, judge setting, recovery policy, critique cap, prompt/few-shot hashes, and PDF constraint extraction before collecting participants.",
    "- Treat total visible cards as fixable + guidance + Good Job. Report the three components separately so a stable total cannot hide a collapse in actionable feedback.",
    "- Log first-pass candidates, recovery candidates, preflight drops, constraint drops, final card counts, and latency. An 11-card result after a real safety or constraint rejection is preferable to padding the review to a quota.",
    "- Use this recovery policy only for Overall Review. Focused and selected-region requests keep their four-critique cap and should not pay the extra discovery latency.",
    "- Expect about two minutes median latency for Overall Review; show phase-level progress or pre-generate the review before the participant reaches the feedback screen.",
  );
  return lines.join("\n") + "\n";
}

async function analyze() {
  const records = await loadRecords();
  const summary = { schemaVersion: 1, generatedAt: new Date().toISOString(), model: "gpt-5.4-2026-03-05", configurations: {} };
  for (const configuration of CONFIGURATIONS) {
    const configurationRuns = records.filter((run) => run.configuration === configuration);
    const dashboards = {};
    for (const code of DASHBOARDS) {
      const successful = configurationRuns.filter((run) => run.dashboardCode === code && run.success);
      dashboards[code] = successful.length ? analyzeDashboard(successful) : null;
    }
    summary.configurations[configuration] = { overall: aggregate(configurationRuns), dashboards };
  }
  const rounded = deepRound(summary);
  await writeFile(path.join(HERE, "study-summary.json"), JSON.stringify(rounded, null, 2) + "\n");
  await writeFile(path.join(HERE, "study-run-metrics.csv"), csv(records));
  await writeFile(path.join(HERE, "study-report.md"), report(rounded));
  return rounded;
}

analyze().then((summary) => console.log(JSON.stringify(summary, null, 2))).catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
