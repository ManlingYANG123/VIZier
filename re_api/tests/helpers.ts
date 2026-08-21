import assert from "node:assert/strict";
import type { Critique, Finding, SpecMap } from "../src/contracts.ts";
import type { LLMClient, CompleteOptions } from "../src/llm/client.ts";
import { runDetectors } from "../src/detect/index.ts";
import { generateCritiques } from "../src/generate/critique.ts";
import { dashboardBoard, dashboardSpecMap } from "../fixtures/specs.ts";

/** A deterministic, network-free LLM stub that returns a fixed JSON payload. */
export class StubClient implements LLMClient {
  private payload: Record<string, unknown>;
  private isAvailable: boolean;
  /** The most recent user text across all calls. */
  lastUserText = "";
  /** Every user text, in call order. The review call is [0]; a repair pass adds
   * a follow-up call, so assertions about the review prompt use firstUserText. */
  userTexts: string[] = [];
  /** Options for each call, in order — lets a test assert the temperature the
   * engine resolved (e.g. from the request's reviewTemperature) reached the client. */
  completeOptions: CompleteOptions[] = [];

  constructor(payload: Record<string, unknown>, isAvailable = true) {
    this.payload = payload;
    this.isAvailable = isAvailable;
  }
  /** The review prompt is always the first call; a repair follow-up is later. */
  get firstUserText(): string {
    return this.userTexts[0] ?? "";
  }
  private record(userText: string, opts: CompleteOptions): void {
    this.lastUserText = userText;
    this.userTexts.push(userText);
    this.completeOptions.push(opts);
  }
  available(): boolean {
    return this.isAvailable;
  }
  async complete(userText: string, opts: CompleteOptions = {}): Promise<string> {
    this.record(userText, opts);
    const text = JSON.stringify(this.payload);
    opts.onToken?.(text);
    return text;
  }
  async completeJson<T = Record<string, unknown>>(
    userText: string,
    opts: CompleteOptions = {},
  ): Promise<T> {
    this.record(userText, opts);
    opts.onToken?.(JSON.stringify(this.payload));
    return this.payload as T;
  }
}

/** A stub that answers each successive call with the next scripted payload,
 * repeating the last one once exhausted. Lets a test drive the review call and
 * the repair follow-up call independently. */
export class SequenceClient implements LLMClient {
  private payloads: Array<Record<string, unknown>>;
  private index = 0;
  private isAvailable: boolean;
  lastUserText = "";
  userTexts: string[] = [];

  constructor(payloads: Array<Record<string, unknown>>, isAvailable = true) {
    if (!payloads.length) throw new Error("SequenceClient needs at least one payload");
    this.payloads = payloads;
    this.isAvailable = isAvailable;
  }
  get firstUserText(): string {
    return this.userTexts[0] ?? "";
  }
  available(): boolean {
    return this.isAvailable;
  }
  private next(userText: string): Record<string, unknown> {
    this.lastUserText = userText;
    this.userTexts.push(userText);
    const payload = this.payloads[Math.min(this.index, this.payloads.length - 1)];
    this.index += 1;
    return payload;
  }
  async complete(userText: string, opts: CompleteOptions = {}): Promise<string> {
    const text = JSON.stringify(this.next(userText));
    opts.onToken?.(text);
    return text;
  }
  async completeJson<T = Record<string, unknown>>(
    userText: string,
    opts: CompleteOptions = {},
  ): Promise<T> {
    const payload = this.next(userText);
    opts.onToken?.(JSON.stringify(payload));
    return payload as T;
  }
}

/** Build the diagnosis-first response shape expected by the unified engine:
 * one DIAGNOSING entry per object×(optional problem) combo, plus the critiques.
 * Optional `strengths` are carried verbatim as the top-level positive-feedback
 * array — they are validated independently of critiques, so they need no
 * matching diagnosis. Mirrors the model contract in prompts.ts (a single
 * top-level JSON object). */
export function diagnosisPayload(
  critiques: Array<Record<string, unknown>>,
  strengths: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const byCombo = new Map<string, Record<string, unknown>>();
  for (const critique of critiques) {
    const objectCode = typeof critique.object === "string" ? critique.object : "";
    if (!objectCode) continue;
    const problemCode = typeof critique.problem === "string" ? critique.problem : undefined;
    const key = `${objectCode}|${problemCode ?? ""}`;
    if (byCombo.has(key)) continue;
    byCombo.set(key, {
      object: objectCode,
      ...(problemCode ? { problem: problemCode } : {}),
      outcome: "evaluated_issue",
      judgmentBasis: critique.judgmentBasis || ["dashboard evidence"],
      requiredContext: critique.requiredContext || [],
      contextStatus: critique.contextStatus || "not_applicable",
      evidenceRefs: critique.evidenceRefs || [],
      rationale: critique.rationale || "The supplied evidence supports a material issue.",
    });
  }
  return { diagnoses: [...byCombo.values()], critiques, ...(strengths.length ? { strengths } : {}) };
}

/** Interaction-only findings (keeps apply/compute/reevaluate tests scoped). */
export function findingsFixture(): Finding[] {
  return runDetectors(dashboardSpecMap()).filter((f) => f.dimension === "interaction");
}

/** Every finding across all dimensions, grounded in the board chrome. */
export function allFindingsFixture(): Finding[] {
  return runDetectors(dashboardSpecMap(), dashboardBoard());
}

export function crossFilterFinding(): Finding {
  const f = findingsFixture().find((x) => x.kind === "cross-filter-gap");
  if (!f) throw new Error("fixture missing cross-filter finding");
  return f;
}

export function tooltipFinding(): Finding {
  const f = findingsFixture().find((x) => x.kind === "missing-tooltip");
  if (!f) throw new Error("fixture missing tooltip finding");
  return f;
}

export async function critiquesFixture(specMap?: SpecMap): Promise<Critique[]> {
  const findings = specMap
    ? runDetectors(specMap).filter((finding) => finding.dimension === "interaction")
    : findingsFixture();
  return generateCritiques(findings, { goal: "track throughput" });
}

/** Assert `expected` appears as an ordered subsequence of `actual`. */
export function assertSubsequence(actual: string[], expected: string[]): void {
  let i = 0;
  for (const a of actual) {
    if (a === expected[i]) i++;
  }
  assert.equal(
    i,
    expected.length,
    `expected ordered subsequence ${expected.join(",")} within ${actual.join(",")}`,
  );
}
