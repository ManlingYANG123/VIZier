import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDashboardDocument } from "../../src/vega-dashboard-adapter.js";
import { analyze } from "./analyze.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RAW_DIR = path.join(HERE, "raw");
const DEFAULT_BASE = process.env.RE_API_BASE || "http://127.0.0.1:8091";
const REVIEW_TEMPERATURE = 0.4;
const CATEGORY_ORDER = [
  "chart", "color", "layout", "data", "text", "visual design", "cognition",
  "context", "interaction", "task", "design process",
];
const DASHBOARD_TYPE_DESCRIPTIONS = {
  analytical: "an analytical dashboard for open exploration and pattern-finding",
  operational: "an operational dashboard for at-a-glance status monitoring",
  infographic: "an infographic that tells one story with an explicit takeaway",
  executive: "an executive summary highlighting the so-what for decision-makers",
};
const MATERIALS = {
  A: {
    dashboard: "public/study-materials/dashboards/A_garden-birds.json",
    pdf: "public/study-materials/pdfs/A_bbc-gel-infographics.pdf",
  },
  B: {
    dashboard: "public/study-materials/dashboards/B_retail-sales-command-center.json",
    pdf: "public/study-materials/pdfs/B_tableau-dashboard-best-practices.pdf",
  },
};

function parseArgs(argv) {
  const options = {
    runs: Number(process.env.RUNS_PER_DASHBOARD || 5),
    only: ["A", "B"],
    base: DEFAULT_BASE,
    refreshConfig: false,
    analyzeOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--runs") options.runs = Number(argv[++i]);
    else if (argv[i] === "--only") options.only = String(argv[++i]).split(",").map((value) => value.trim().toUpperCase());
    else if (argv[i] === "--base") options.base = String(argv[++i]);
    else if (argv[i] === "--refresh-config") options.refreshConfig = true;
    else if (argv[i] === "--analyze-only") options.analyzeOnly = true;
    else if (argv[i] === "--help") {
      console.log("Usage: node run.mjs [--runs 5] [--only A,B] [--base http://127.0.0.1:8091] [--refresh-config] [--analyze-only]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error("--runs must be an integer from 1 to 10");
  }
  if (!options.only.length || options.only.some((code) => !MATERIALS[code])) {
    throw new Error("--only must contain A, B, or A,B");
  }
  return options;
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function serializeContextBox(context = {}) {
  return [context.goal, context.audience, context.constraints]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function inferredContextDescription(context = {}) {
  const base = serializeContextBox({ goal: context.goal, audience: context.audience });
  const genre = DASHBOARD_TYPE_DESCRIPTIONS[context.dashboardType];
  if (!genre) return base;
  const genreSentence = `VIZier read this as ${genre}.`;
  return base ? `${base} ${genreSentence}` : genreSentence;
}

function buildSpecMap(normalized) {
  return Object.fromEntries(normalized.tiles.map((tile) => [tile.id, structuredClone(tile.spec)]));
}

/** Mirrors buildEngineBoardMeta for a freshly loaded formal-study JSON. */
function buildBoard(normalized) {
  const dashboard = normalized.dashboard;
  const showChartSubtitles = Boolean(dashboard.showChartSubtitles);
  const typography = dashboard.typography || {
    titleFontPx: 30,
    subtitleFontPx: 13,
    titleFontFamily: "Georgia",
    subtitleFontFamily: "system-ui",
    titleToSubtitleRatio: 2.31,
  };
  return {
    id: dashboard.id || "dashboard",
    title: dashboard.title,
    subtitle: dashboard.subtitle || "",
    typography,
    hasKpis: Boolean(dashboard.hasKpis),
    hasEmbeddedKpis: Boolean(dashboard.hasEmbeddedKpis),
    kpis: Array.isArray(dashboard.kpis) ? structuredClone(dashboard.kpis) : [],
    kpiStyle: dashboard.kpiStyle || undefined,
    kpiLayout: dashboard.kpiLayout || "inline-summary",
    kpiAlignment: dashboard.kpiAlignment || "start",
    kpiDensity: dashboard.kpiDensity || "balanced",
    kpiChrome: dashboard.kpiChrome || "plain",
    kpiReservedHeight: Number(dashboard.kpiReservedHeight) || 0,
    kpiReservedWidth: Number(dashboard.kpiReservedWidth) || 0,
    filters: Array.isArray(dashboard.filters) ? structuredClone(dashboard.filters) : [],
    showChartSubtitles,
    canvasWidth: dashboard.canvasWidth,
    canvasHeight: dashboard.canvasHeight,
    tiles: normalized.tiles.map((tile) => ({
      id: tile.id,
      title: tile.v2Label || tile.label,
      subtitle: tile.subtitle || "",
      hasSubtitle: showChartSubtitles,
      bounds: structuredClone(tile.bounds),
    })),
  };
}

async function extractPdfText(pdfPath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => typeof item.str === "string" ? item.str : "").join(" "));
  }
  return { text: pages.join("\n\n").trim(), pageCount: doc.numPages };
}

async function postJson(base, route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6 * 60 * 1000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${route} ${response.status} ${response.statusText}`);
  return payload;
}

async function streamCritique(base, body, onEvent) {
  const response = await fetch(base + "/critique", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8 * 60 * 1000),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`/critique ${response.status} ${response.statusText} ${text.slice(0, 300)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let streamError = null;
  const handle = (block) => {
    let event = "message";
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch { payload = data; }
    if (event === "result") result = payload;
    else if (event === "error") streamError = payload;
    else onEvent?.({ event, payload });
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      handle(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handle(buffer);
  if (streamError) throw new Error(streamError.message || streamError.error || JSON.stringify(streamError));
  if (!result) throw new Error("The critique stream ended without a result event.");
  return result;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function buildFrozenConfig(code, options) {
  const material = MATERIALS[code];
  const dashboardPath = path.join(ROOT, material.dashboard);
  const pdfPath = path.join(ROOT, material.pdf);
  const rawDashboard = JSON.parse(await readFile(dashboardPath, "utf8"));
  const normalized = normalizeDashboardDocument(rawDashboard, path.basename(dashboardPath));
  const specMap = buildSpecMap(normalized);
  const board = buildBoard(normalized);

  console.log(`[config ${code}] inferring dashboard context…`);
  const scaffoldRequest = {
    rawText: "",
    mode: "dashboard-draft",
    requireLLM: true,
    dashboard: {
      title: board.title,
      tileTitles: normalized.tiles.map((tile) => tile.label || tile.title),
      visibleMetrics: normalized.tiles.map((tile) => tile.label || tile.title),
    },
    specMap,
    board,
  };
  const scaffoldResponse = await postJson(options.base, "/scaffold", scaffoldRequest);
  const description = inferredContextDescription(scaffoldResponse?.context || {});
  const context = {
    goal: description,
    audience: "",
    constraints: "",
    scope: [...CATEGORY_ORDER],
    customTypes: [],
    notes: [],
    dashboardType: scaffoldResponse?.context?.dashboardType,
    fieldStatus: { goal: description ? "inferred" : "missing", audience: "missing", constraints: "missing" },
    snapshotId: scaffoldResponse?.contextSnapshotId || null,
  };

  console.log(`[config ${code}] extracting and confirming PDF rules…`);
  const extracted = await extractPdfText(pdfPath);
  const constraintSource = {
    kind: "pdf-text",
    text: extracted.text,
    filename: path.basename(pdfPath),
    pageCount: extracted.pageCount,
  };
  const intakeResponse = await postJson(options.base, "/intake-constraints", {
    source: constraintSource,
    requireLLM: true,
  });
  const constraintSet = intakeResponse?.constraintSet || null;
  const designDocumentText = extracted.text.slice(0, 40000);
  const requestBase = {
    version: 1,
    context,
    specMap,
    board,
    iterationContext: {
      round: 1,
      dashboardVersion: 1,
      applied: [],
      rejectedSignatures: [],
      changedTargets: [],
    },
    reviewScope: "full",
    requireLLM: true,
    reviewTemperature: REVIEW_TEMPERATURE,
    savedRationales: [],
    ...(constraintSet ? { constraintSet } : {}),
    ...(designDocumentText ? { designDocumentText } : {}),
  };
  const config = {
    schemaVersion: 1,
    dashboardCode: code,
    createdAt: new Date().toISOString(),
    requestedRunsPerDashboard: options.runs,
    apiBase: options.base,
    material,
    hashes: {
      dashboardSha256: hash(await readFile(dashboardPath)),
      pdfSha256: hash(await readFile(pdfPath)),
      requestBaseSha256: hash(requestBase),
    },
    policy: {
      context: "Generated once with /scaffold, accepted unchanged, then frozen across critique repetitions.",
      constraints: "Extracted once from the bound PDF; all extracted rules active, matching the UI default.",
      repetitions: "Identical version-1 full-review requests with no iteration history or saved rationale.",
    },
    scaffoldRequest,
    scaffoldResponse,
    intakeRequest: { source: constraintSource, requireLLM: true },
    intakeResponse,
    requestBase,
  };
  await writeFile(path.join(RAW_DIR, `${code}.config.json`), JSON.stringify(config, null, 2) + "\n");
  console.log(`[config ${code}] saved; ${(constraintSet?.constraints || []).length} active rule(s).`);
  return config;
}

async function loadOrBuildConfig(code, options) {
  const file = path.join(RAW_DIR, `${code}.config.json`);
  if (!options.refreshConfig && await exists(file)) {
    const config = await readJson(file);
    console.log(`[config ${code}] reusing frozen request ${config.hashes?.requestBaseSha256?.slice(0, 12) || ""}.`);
    return config;
  }
  return buildFrozenConfig(code, options);
}

async function runOne(code, runNumber, config, options) {
  const output = path.join(RAW_DIR, `${code}-run-${String(runNumber).padStart(2, "0")}.json`);
  if (await exists(output)) {
    const prior = await readJson(output);
    if (prior.success) {
      console.log(`[${code} run ${runNumber}/${options.runs}] already complete; skipping.`);
      return prior;
    }
  }

  const request = structuredClone(config.requestBase);
  const inputHash = hash(request);
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const events = [];
    const startedAt = new Date();
    console.log(`[${code} run ${runNumber}/${options.runs}] Overall Review started (attempt ${attempt})…`);
    try {
      const response = await streamCritique(options.base, request, (event) => events.push(event));
      const completedAt = new Date();
      const record = {
        schemaVersion: 1,
        dashboardCode: code,
        runNumber,
        requestedRunsPerDashboard: options.runs,
        success: true,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt - startedAt,
        attempt,
        configRef: `raw/${code}.config.json`,
        inputHash,
        response,
        events,
        attempts,
      };
      await writeFile(output, JSON.stringify(record, null, 2) + "\n");
      console.log(`[${code} run ${runNumber}/${options.runs}] complete: ${(response.critiques || []).length} critiques in ${(record.durationMs / 1000).toFixed(1)}s.`);
      return record;
    } catch (error) {
      const completedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ attempt, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), error: message, events });
      console.error(`[${code} run ${runNumber}/${options.runs}] attempt ${attempt} failed: ${message}`);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const failed = {
    schemaVersion: 1,
    dashboardCode: code,
    runNumber,
    requestedRunsPerDashboard: options.runs,
    success: false,
    completedAt: new Date().toISOString(),
    configRef: `raw/${code}.config.json`,
    inputHash,
    error: attempts.at(-1)?.error || "Unknown failure",
    attempts,
  };
  await writeFile(output, JSON.stringify(failed, null, 2) + "\n");
  return failed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.analyzeOnly) {
    await analyze();
    return;
  }
  const health = await fetch(options.base + "/health", { signal: AbortSignal.timeout(10000) });
  if (!health.ok) throw new Error(`Backend health check failed: ${health.status} ${health.statusText}`);
  console.log(`Formal-study evaluation: ${options.runs} run(s) each for ${options.only.join(", ")} at temperature ${REVIEW_TEMPERATURE}.`);
  const configs = {};
  for (const code of options.only) configs[code] = await loadOrBuildConfig(code, options);

  // Interleave A/B while keeping requests strictly sequential. This reduces the
  // chance that time-of-run provider drift is confounded with dashboard identity.
  for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
    for (const code of options.only) await runOne(code, runNumber, configs[code], options);
  }
  const summary = await analyze();
  console.log(`Done: ${summary.successfulRuns}/${summary.attemptedRuns} successful runs.`);
  console.log(`Report: ${path.join(HERE, "report.md")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

