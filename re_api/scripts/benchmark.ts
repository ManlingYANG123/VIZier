import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CritiqueRequest } from "../src/contracts.ts";
import { runCritique } from "../src/engine.ts";
import { GatewayClient } from "../src/llm/client.ts";
import { model } from "../src/llm/gateway.ts";
import { Tracer } from "../src/trace.ts";
import { dashboardBoard, dashboardSpecMap, tileBounds } from "../fixtures/specs.ts";
import {
  CRITERION_REGISTRY_VERSION,
  REVIEW_ENGINE_VERSION,
  REVIEW_PROMPT_VERSION,
} from "../src/generate/review-data.ts";

const repetitions = Math.max(2, Number(process.env.RE_API_BENCHMARK_RUNS || 5));
const board = dashboardBoard();
board.tiles = board.tiles?.map((tile) => ({ ...tile, bounds: tileBounds[tile.id] }));

const base = { version: 1, specMap: dashboardSpecMap(), board };
const conditions: Array<{ id: string; request: CritiqueRequest }> = [
  { id: "artifact-only", request: { ...base, context: {}, reviewScope: "full" } },
  {
    id: "inferred-brief",
    request: {
      ...base,
      context: {
        goal: "Compare delivery health across departments.",
        audience: "Operations leaders.",
        fieldStatus: { goal: "inferred", audience: "inferred" },
      },
      reviewScope: "full",
    },
  },
  {
    id: "confirmed-brief",
    request: {
      ...base,
      context: {
        goal: "Compare delivery health across departments before weekly planning.",
        audience: "PMO and engineering leads.",
        constraints: "Preserve the approved navy brand palette.",
        fieldStatus: { goal: "confirmed", audience: "confirmed", constraints: "confirmed" },
      },
      reviewScope: "full",
    },
  },
  {
    id: "focused",
    request: {
      ...base,
      context: {},
      reviewScope: "focused",
      focus: { request: "Does the dashboard clearly support department comparison?" },
    },
  },
  {
    id: "selected-region",
    request: {
      ...base,
      context: {},
      reviewScope: "selected-region",
      region: {
        bounds: tileBounds["task-velocity"],
        request: "Review the legibility and inspectability of this trend.",
      },
    },
  },
];

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  return [...a].filter((value) => b.has(value)).length / union.size;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const client = new GatewayClient();
if (!client.available()) throw new Error("LLM_REQUIRED: configure OPENAI_API_KEY before running the live benchmark");

const results = [];
for (const condition of conditions) {
  const runs = [];
  for (let index = 0; index < repetitions; index += 1) {
    const started = Date.now();
    const response = await runCritique(
      condition.request,
      new Tracer(`benchmark-${condition.id}-${index + 1}`, { logDir: null }),
      { client },
    );
    runs.push({
      run: index + 1,
      latencyMs: Date.now() - started,
      critiqueCount: response.critiques.length,
      issueFamilies: response.critiques.map((critique) => `${critique.object ?? "?"}|${critique.problem ?? ""}:${critique.proposal.kind}`),
      outcomes: response.diagnoses.map((diagnosis) => ({
        object: diagnosis.object,
        problem: diagnosis.problem,
        outcome: diagnosis.outcome,
      })),
    });
  }
  const overlaps = [];
  for (let left = 0; left < runs.length; left += 1) {
    for (let right = left + 1; right < runs.length; right += 1) {
      overlaps.push(jaccard(new Set(runs[left].issueFamilies), new Set(runs[right].issueFamilies)));
    }
  }
  results.push({
    condition: condition.id,
    medianSemanticOverlap: median(overlaps),
    medianLatencyMs: median(runs.map((run) => run.latencyMs)),
    runs,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  model: model(),
  repetitions,
  registryVersion: CRITERION_REGISTRY_VERSION,
  promptVersion: REVIEW_PROMPT_VERSION,
  engineVersion: REVIEW_ENGINE_VERSION,
  results,
};
const outputDirectory = resolve(process.cwd(), "runs", "benchmark");
mkdirSync(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, `benchmark-${Date.now()}.json`);
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(`Benchmark report written to ${outputPath}`);
