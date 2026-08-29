/**
 * Constraint intake: design source → reviewed candidate ConstraintSet.
 *
 * The public entry point for the input-processing module. It is deliberately
 * source-agnostic: it delegates extraction to a per-source adapter (sources.ts),
 * runs ONE shared LLM call (prompt 07), and normalizes the result. Supporting a
 * new source type (url / image / …) is a change to sources.ts alone.
 *
 * This module is fully independent of the generation path — nothing here reads
 * or mutates the review pipeline. Its output is carried on CritiqueRequest and
 * consumed only by the conflict filter.
 */
import type { ConstraintSet, ConstraintSource } from "../contracts.ts";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LLMClient } from "../llm/client.ts";
import { adapterFor, type ExtractedMaterial } from "./sources.ts";
import { INTAKE_PROMPT_VERSION, INTAKE_SYSTEM, intakeUser } from "./prompt.ts";
import { emptyConstraintSet, normalizeConstraintSet } from "./normalize.ts";

export { IntakeUnsupportedError } from "./sources.ts";
export { INTAKE_PROMPT_VERSION } from "./prompt.ts";

/** Medium reasoning consumes part of max_output_tokens before the structured
 * answer is emitted. Leave enough room for both reasoning and up to 40
 * normalized constraints from a substantial design document. */
export const INTAKE_MAX_OUTPUT_TOKENS = 8000;

export interface BuildConstraintSetOptions {
  /** When true, throw if no model is configured instead of returning an empty
   * set. The onboarding UI sets this so a missing gateway fails visibly. */
  requireLLM?: boolean;
  /** Optional local, content-addressed cache used by the API server so stable
   * extraction survives a dev-server restart. Tests and library callers omit it. */
  cacheFile?: string;
  /** Provider/model/reasoning identity. A changed model must not silently reuse
   * an extraction generated under different semantics. */
  cacheNamespace?: string;
}

export interface BuildConstraintSetResult {
  constraintSet: ConstraintSet;
  /** "llm" when a model parsed the source, "cache" when identical normalized
   * material reused that result, and "empty" when there was nothing to parse. */
  source: "llm" | "cache" | "empty";
}

/** Content-addressed session cache. GPT-5.4 with reasoning enabled cannot use a
 * sampling temperature, so repeated identical calls can otherwise return a
 * different number/order of rules. The prompt version participates in the key:
 * changing extraction semantics automatically invalidates old entries. Keeping
 * the in-flight Promise also coalesces duplicate requests from the two UI entry
 * points instead of charging twice for the same document. */
const MAX_INTAKE_CACHE_ENTRIES = 64;
const intakeCache = new Map<string, Promise<ConstraintSet>>();
let persistentWriteQueue: Promise<void> = Promise.resolve();

function canonicalMaterialKey(
  sourceKind: ConstraintSource["kind"],
  material: ExtractedMaterial,
  namespace = "default",
): string {
  const canonical = {
    promptVersion: INTAKE_PROMPT_VERSION,
    namespace,
    sourceKind,
    provenance: material.provenance.replace(/\s+/g, " ").trim(),
    note: String(material.note || "").replace(/\s+/g, " ").trim(),
    // PDF.js occasionally varies line/word whitespace while preserving content.
    // Collapse it so that harmless extraction differences share one result.
    blocks: material.blocks.map((block) => String(block).replace(/\s+/g, " ").trim()),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function storedConstraintSet(value: unknown): ConstraintSet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as ConstraintSet;
  if (typeof candidate.id !== "string" || typeof candidate.provenance !== "string" ||
      typeof candidate.sourceKind !== "string" || !Array.isArray(candidate.constraints)) return null;
  return candidate;
}

async function readPersistentEntry(cacheFile: string, key: string): Promise<ConstraintSet | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, "utf8")) as { entries?: Record<string, unknown> };
    const set = storedConstraintSet(parsed.entries?.[key]);
    return set ? structuredClone(set) : null;
  } catch {
    return null;
  }
}

function writePersistentEntry(cacheFile: string, key: string, set: ConstraintSet): Promise<void> {
  persistentWriteQueue = persistentWriteQueue.then(async () => {
    let entries: Record<string, ConstraintSet> = {};
    try {
      const parsed = JSON.parse(await readFile(cacheFile, "utf8")) as { entries?: Record<string, unknown> };
      entries = Object.fromEntries(Object.entries(parsed.entries || {}).flatMap(([entryKey, value]) => {
        const stored = storedConstraintSet(value);
        return stored ? [[entryKey, stored]] : [];
      }));
    } catch {
      // First write or a corrupt local cache: rebuild from the current result.
    }
    entries[key] = structuredClone(set);
    const recent = Object.entries(entries).slice(-MAX_INTAKE_CACHE_ENTRIES);
    const body = JSON.stringify({ version: 1, entries: Object.fromEntries(recent) });
    await mkdir(dirname(cacheFile), { recursive: true });
    const temporary = `${cacheFile}.tmp-${process.pid}`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, cacheFile);
  }).catch(() => {
    // Cache persistence is an optimization; a filesystem failure must not make
    // design-document intake fail after a successful model response.
  });
  return persistentWriteQueue;
}

function remember(key: string, value: Promise<ConstraintSet>): void {
  intakeCache.set(key, value);
  while (intakeCache.size > MAX_INTAKE_CACHE_ENTRIES) {
    const oldest = intakeCache.keys().next().value as string | undefined;
    if (!oldest) break;
    intakeCache.delete(oldest);
  }
}

/** Test seam; production never needs to clear stable session results. */
export function clearConstraintIntakeCache(): void {
  intakeCache.clear();
}

export async function buildConstraintSet(
  source: ConstraintSource,
  client: LLMClient | undefined,
  options: BuildConstraintSetOptions = {},
): Promise<BuildConstraintSetResult> {
  const material = await adapterFor(source.kind).extract(source as never);
  // Empty / garbage document → an empty set, no model call, no cost.
  if (!material.blocks.join("").trim()) {
    if (options.requireLLM && !client?.available()) {
      throw new Error("LLM_REQUIRED: constraint intake requires a configured model");
    }
    return { constraintSet: emptyConstraintSet(source.kind, material.provenance), source: "empty" };
  }
  if (!client?.available()) {
    if (options.requireLLM) throw new Error("LLM_REQUIRED: constraint intake requires a configured model");
    return { constraintSet: emptyConstraintSet(source.kind, material.provenance), source: "empty" };
  }
  const cacheKey = canonicalMaterialKey(source.kind, material, options.cacheNamespace);
  const cached = intakeCache.get(cacheKey);
  if (cached) {
    return { constraintSet: structuredClone(await cached), source: "cache" };
  }
  if (options.cacheFile) {
    const stored = await readPersistentEntry(options.cacheFile, cacheKey);
    if (stored) {
      remember(cacheKey, Promise.resolve(stored));
      return { constraintSet: structuredClone(stored), source: "cache" };
    }
  }
  const pending = client.completeJson<Record<string, unknown>>(
    intakeUser(material),
    { system: INTAKE_SYSTEM, temperature: 0, maxTokens: INTAKE_MAX_OUTPUT_TOKENS },
  ).then((raw) => normalizeConstraintSet(raw, source.kind, material.provenance));
  remember(cacheKey, pending);
  try {
    const constraintSet = await pending;
    if (options.cacheFile) await writePersistentEntry(options.cacheFile, cacheKey, constraintSet);
    return { constraintSet: structuredClone(constraintSet), source: "llm" };
  } catch (error) {
    // A transport/truncation error must not poison this document until restart.
    if (intakeCache.get(cacheKey) === pending) intakeCache.delete(cacheKey);
    throw error;
  }
}
