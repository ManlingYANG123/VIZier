import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeDashboard,
  crossPairs,
  isExecutable,
  isLayoutComposition,
  proposalKinds,
  summarize,
} from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, "raw");

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function decimal(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function deepRound(value) {
  if (Array.isArray(value)) return value.map(deepRound);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepRound(entry)]));
  }
  return typeof value === "number" ? round(value) : value;
}

async function loadRunFiles() {
  const names = (await readdir(RAW_DIR)).filter((name) => /^[AB]-run-\d+\.json$/.test(name)).sort();
  const records = await Promise.all(names.map(async (name) => {
    const record = JSON.parse(await readFile(path.join(RAW_DIR, name), "utf8"));
    return { ...record, file: `raw/${name}` };
  }));
  return records;
}

function runRows(runs) {
  return runs.map((run) => {
    const critiques = run.response?.critiques || [];
    const executable = critiques.filter(isExecutable).length;
    const layout = critiques.filter(isLayoutComposition).length;
    return {
      dashboard: run.dashboardCode,
      run: run.runNumber,
      success: Boolean(run.success),
      durationMs: run.durationMs ?? "",
      critiques: critiques.length,
      executable,
      executableRatio: critiques.length ? round(executable / critiques.length) : "",
      layoutComposition: layout,
      layoutCompositionRatio: critiques.length ? round(layout / critiques.length) : "",
      model: critiques[0]?.model || "",
      runId: run.response?.runId || "",
      error: run.error || "",
    };
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  const columns = [
    "dashboard", "run", "success", "durationMs", "critiques", "executable",
    "executableRatio", "layoutComposition", "layoutCompositionRatio", "model", "runId", "error",
  ];
  return [columns.join(","), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(","))].join("\n") + "\n";
}

function report(summary) {
  const a = summary.dashboards.A;
  const b = summary.dashboards.B;
  const cross = summary.crossDashboard.proposalKindSimilarity;
  const lines = [
    "# Formal-study Overall Review reliability report",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "## Configuration",
    "",
    `- Materials: A and B, the two counterbalanced VIZier task dashboards. Assessment dashboards 1 and 2 are excluded because they do not run Overall Review.`,
    `- Successful repetitions: A = ${a?.successfulRuns ?? 0}, B = ${b?.successfulRuns ?? 0}; requested = ${summary.requestedRunsPerDashboard} per dashboard.`,
    `- Review temperature: ${summary.reviewTemperature}.`,
    "- Context policy: infer once per dashboard with `/scaffold`, keep the generated description unchanged, and reuse it for every repetition.",
    "- Design-document policy: extract each bound PDF once, activate all extracted rules (the UI default), and reuse the same ConstraintSet and clipped PDF text for every repetition.",
    "- Dashboard version/iteration state: version 1, full review, no prior accepted or rejected critiques, no saved rationales.",
    "- Requests were executed sequentially to avoid provider contention. Raw SSE events and terminal responses are retained in `raw/`.",
    "",
    "## Results",
    "",
    "| Dashboard | Critiques/run (mean, range) | Executable ratio | Layout-composition frequency | Recommendation overlap | Edit-path similarity | Within-dashboard stability |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...[["A", a], ["B", b]].map(([code, item]) => {
      if (!item) return `| ${code} | n/a | n/a | n/a | n/a | n/a | n/a |`;
      return `| ${code} | ${decimal(item.critiqueCount.mean)} (${item.critiqueCount.min}–${item.critiqueCount.max}) | ${pct(item.executable.ratio)} | ${pct(item.layoutComposition.ratio)} | ${decimal(item.withinDashboard.recommendationOverlap.mean)} | ${decimal(item.withinDashboard.editPathSimilarity.mean)} | ${decimal(item.withinDashboard.stabilityIndex)} |`;
    }),
    "",
    `Cross-dashboard proposal-kind similarity (A × B): **${decimal(cross.mean)}** mean Jaccard (range ${decimal(cross.min)}–${decimal(cross.max)}, ${cross.n} pairs).`,
    "",
    "## Operational definitions",
    "",
    "1. **Cross-dashboard proposal-kind similarity:** Jaccard similarity between the unique `proposal.kind` sets from every A run and every B run. A high value may indicate reusable solution patterns, but an extremely high value can also indicate dashboard-insensitive generation.",
    "2. **Recommendation overlap:** within-dashboard pairwise Jaccard similarity over exact recommendation-leaf IDs. An uncatalogued recommendation uses its object/problem/dimension tuple so it remains in the denominator.",
    "3. **Edit-path similarity:** within-dashboard pairwise Jaccard similarity over explicit `proposal.edits` paths plus canonical board/interaction paths for proposal kinds whose changes are not represented by `proposal.edits`.",
    "4. **Layout-composition frequency:** share of critiques that change tile bounds/composition, KPI composition, or spec-internal width/height/spacing/facet/concat structure.",
    "5. **Executable ratio:** critiques with `proposal.mode === \"executable\"` divided by all returned critiques.",
    "6. **Within-dashboard run-to-run stability:** equal-weight mean of recommendation overlap, proposal-kind Jaccard, and edit-path Jaccard. Component values remain visible so the composite is not treated as a black box.",
    "",
    "All set comparisons use unique values within a run. Frequency tables in `summary.json` retain repeated counts.",
    "",
    "## Files",
    "",
    "- `summary.json`: machine-readable aggregate metrics and every pairwise score.",
    "- `run-metrics.csv`: one row per attempted run.",
    "- `raw/A.config.json`, `raw/B.config.json`: frozen formal inputs, scaffold output, and PDF intake output.",
    "- `raw/A-run-*.json`, `raw/B-run-*.json`: raw critique responses and trace events.",
  ];
  return lines.join("\n") + "\n";
}

export async function analyze() {
  const allRuns = await loadRunFiles();
  const successful = allRuns.filter((run) => run.success && Array.isArray(run.response?.critiques));
  const byCode = Object.fromEntries(["A", "B"].map((code) => [code, successful.filter((run) => run.dashboardCode === code)]));
  const configRecords = {};
  for (const code of ["A", "B"]) {
    try {
      configRecords[code] = JSON.parse(await readFile(path.join(RAW_DIR, `${code}.config.json`), "utf8"));
    } catch {
      configRecords[code] = null;
    }
  }
  const requestedRunsPerDashboard = Math.max(
    0,
    ...allRuns.map((run) => Number(run.requestedRunsPerDashboard) || 0),
    ...Object.values(configRecords).map((config) => Number(config?.requestedRunsPerDashboard) || 0),
  );
  const crossKindPairs = crossPairs(byCode.A, byCode.B, proposalKinds);
  const summary = deepRound({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    requestedRunsPerDashboard,
    reviewTemperature: 0.4,
    attemptedRuns: allRuns.length,
    successfulRuns: successful.length,
    failedRuns: allRuns.length - successful.length,
    dashboards: {
      A: analyzeDashboard(byCode.A),
      B: analyzeDashboard(byCode.B),
    },
    crossDashboard: {
      proposalKindSimilarity: {
        ...summarize(crossKindPairs.map((pair) => pair.value)),
        pairs: crossKindPairs,
      },
    },
    definitions: {
      recommendationOverlap: "Pairwise Jaccard over exact recommendation leaf IDs, with object/problem/dimension fallback for uncatalogued critiques.",
      editPathSimilarity: "Pairwise Jaccard over explicit proposal edit paths plus canonical paths for board, layout, KPI, palette, filter, and interaction proposals.",
      layoutCompositionFrequency: "Layout/composition critiques divided by all critiques.",
      executableRatio: "proposal.mode executable divided by all critiques.",
      withinDashboardStability: "Equal-weight mean of recommendation overlap, proposal-kind Jaccard, and edit-path Jaccard.",
      crossDashboardProposalKindSimilarity: "Jaccard over unique proposal.kind sets for all A×B run pairs.",
    },
  });

  await writeFile(path.join(HERE, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(path.join(HERE, "run-metrics.csv"), toCsv(runRows(allRuns)));
  await writeFile(path.join(HERE, "report.md"), report(summary));
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await analyze();
  console.log(`Analyzed ${summary.successfulRuns}/${summary.attemptedRuns} successful runs.`);
  console.log(`Report: ${path.join(HERE, "report.md")}`);
}

