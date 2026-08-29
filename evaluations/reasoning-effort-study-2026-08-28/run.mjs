import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RAW_DIR = path.join(HERE, "raw");
const CONFIG_DIR = path.join(ROOT, "evaluations/formal-study-reliability-2026-08-26/raw");
const EFFORTS = ["low", "medium", "high"];
const SUPPORTED_EFFORTS = ["none", ...EFFORTS];
const BASES = {
  none: process.env.NONE_API_BASE || "http://127.0.0.1:8196",
  low: process.env.LOW_API_BASE || "http://127.0.0.1:8191",
  medium: process.env.MEDIUM_API_BASE || "http://127.0.0.1:8192",
  high: process.env.HIGH_API_BASE || "http://127.0.0.1:8193",
};

function parseArgs(argv) {
  const options = { runs: 5, only: ["A", "B"], efforts: [...EFFORTS], tag: "", temperature: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--runs") options.runs = Number(argv[++index]);
    else if (argv[index] === "--only") {
      options.only = String(argv[++index]).split(",").map((value) => value.trim().toUpperCase());
    } else if (argv[index] === "--efforts") {
      options.efforts = String(argv[++index]).split(",").map((value) => value.trim().toLowerCase());
    } else if (argv[index] === "--tag") {
      options.tag = String(argv[++index]).trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
    } else if (argv[index] === "--temperature") {
      options.temperature = Number(argv[++index]);
    } else if (argv[index] === "--help") {
      console.log("Usage: node run.mjs [--runs 5] [--only A,B] [--efforts none|low,medium,high] [--temperature 0.2] [--tag label]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error("--runs must be an integer from 1 to 10");
  }
  if (!options.only.length || options.only.some((code) => !["A", "B"].includes(code))) {
    throw new Error("--only must contain A, B, or A,B");
  }
  if (!options.efforts.length || options.efforts.some((effort) => !SUPPORTED_EFFORTS.includes(effort))) {
    throw new Error("--efforts must contain none, low, medium, high, or a comma-separated subset");
  }
  if (options.temperature !== null && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1)) {
    throw new Error("--temperature must be between 0 and 1");
  }
  return options;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function streamCritique(base, body, onEvent) {
  const response = await fetch(base + "/critique", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12 * 60 * 1000),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`/critique ${response.status} ${response.statusText} ${text.slice(0, 500)}`);
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
    let separator;
    while ((separator = buffer.indexOf("\n\n")) >= 0) {
      handle(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handle(buffer);
  if (streamError) throw new Error(streamError.message || streamError.error || JSON.stringify(streamError));
  if (!result) throw new Error("The critique stream ended without a result event.");
  return result;
}

async function verifyServers(efforts) {
  for (const effort of efforts) {
    const response = await fetch(BASES[effort] + "/health", { signal: AbortSignal.timeout(10000) });
    const health = await response.json().catch(() => ({}));
    if (!response.ok || !health.ok) throw new Error(`${effort} backend is unavailable at ${BASES[effort]}`);
    if (health.reasoningEffort !== effort) {
      throw new Error(`${effort} backend reports reasoningEffort=${health.reasoningEffort || "missing"}`);
    }
    if (health.model !== "gpt-5.4-2026-03-05") {
      throw new Error(`${effort} backend must pin gpt-5.4-2026-03-05; got ${health.model || "missing"}`);
    }
  }
}

async function runOne(effort, code, runNumber, requestedRuns, config, tag = "", temperature = null) {
  const suffix = tag ? `-${tag}` : "";
  const filename = `${effort}-${code}-run-${String(runNumber).padStart(2, "0")}${suffix}.json`;
  const output = path.join(RAW_DIR, filename);
  if (await exists(output)) {
    const prior = await readJson(output);
    if (prior.success) {
      console.log(`[${effort} ${code} ${runNumber}/${requestedRuns}] already complete; skipping.`);
      return prior;
    }
  }
  const request = structuredClone(config.requestBase);
  if (temperature !== null) request.reviewTemperature = temperature;
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const events = [];
    const startedAt = new Date();
    console.log(`[${effort} ${code} ${runNumber}/${requestedRuns}] started (attempt ${attempt})`);
    try {
      const response = await streamCritique(BASES[effort], request, (event) => events.push(event));
      const completedAt = new Date();
      const record = {
        schemaVersion: 1,
        reasoningEffort: effort,
        dashboardCode: code,
        runNumber,
        requestedRunsPerCell: requestedRuns,
        success: true,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt - startedAt,
        attempt,
        apiBase: BASES[effort],
        model: "gpt-5.4-2026-03-05",
        configRef: `../formal-study-reliability-2026-08-26/raw/${code}.config.json`,
        inputHash: hash(request),
        response,
        events,
        attempts,
      };
      await writeFile(output, JSON.stringify(record, null, 2) + "\n");
      console.log(`[${effort} ${code} ${runNumber}/${requestedRuns}] ${(record.durationMs / 1000).toFixed(1)}s, ${(response.critiques || []).length} critique(s)`);
      return record;
    } catch (error) {
      const completedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ attempt, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), error: message, events });
      console.error(`[${effort} ${code} ${runNumber}/${requestedRuns}] failed: ${message}`);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const failed = {
    schemaVersion: 1,
    reasoningEffort: effort,
    dashboardCode: code,
    runNumber,
    requestedRunsPerCell: requestedRuns,
    success: false,
    completedAt: new Date().toISOString(),
    model: "gpt-5.4-2026-03-05",
    configRef: `../formal-study-reliability-2026-08-26/raw/${code}.config.json`,
    inputHash: hash(request),
    error: attempts.at(-1)?.error || "Unknown failure",
    attempts,
  };
  await writeFile(output, JSON.stringify(failed, null, 2) + "\n");
  return failed;
}

function rotatedEfforts(efforts, runNumber, codeIndex) {
  const offset = (runNumber - 1 + codeIndex) % efforts.length;
  return [...efforts.slice(offset), ...efforts.slice(0, offset)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(RAW_DIR, { recursive: true });
  await verifyServers(options.efforts);
  const configs = {};
  for (const code of options.only) configs[code] = await readJson(path.join(CONFIG_DIR, `${code}.config.json`));
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    model: "gpt-5.4-2026-03-05",
    efforts: options.efforts,
    dashboards: options.only,
    runsPerCell: options.runs,
    totalPlannedRuns: options.efforts.length * options.only.length * options.runs,
    bases: BASES,
    configHashes: Object.fromEntries(options.only.map((code) => [code, configs[code].hashes.requestBaseSha256])),
    reviewTemperatureOverride: options.temperature,
    ordering: "Sequential, Latin-rotated effort order within each run and dashboard.",
  };
  await writeFile(path.join(HERE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
    for (let codeIndex = 0; codeIndex < options.only.length; codeIndex += 1) {
      const code = options.only[codeIndex];
      for (const effort of rotatedEfforts(options.efforts, runNumber, codeIndex)) {
        await runOne(effort, code, runNumber, options.runs, configs[code], options.tag, options.temperature);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
