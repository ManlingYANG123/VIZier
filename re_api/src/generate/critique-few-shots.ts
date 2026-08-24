import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDashboardType } from "./dashboard-type.ts";
import { isRecommendationLeafId } from "./recommendations.ts";
import { isObjectCode, isProblemCode } from "./review-data.ts";

const CRITIQUE_FEW_SHOT_URL = new URL(
  "../../data/critique-few-shots-v1.json",
  import.meta.url,
);
const EXPECTED_EXAMPLE_COUNT = 6;
const MAX_EXAMPLE_PROMPT_CHARS = 14_000;
const DIAGNOSIS_OUTCOMES = new Set([
  "evaluated_issue",
  "evaluated_no_issue",
  "not_evaluated_missing_context",
  "out_of_scope",
  "unsupported",
]);

interface FewShotSource {
  dataset: string;
  threadId: string;
  replyId?: string;
  unitId?: string;
  adaptation: string;
}

export interface CritiqueFewShot {
  id: string;
  purpose: string;
  /** Maintainership provenance only. This field is deliberately excluded from
   * the serialized model prompt so Slack authors, links, and row metadata can
   * never leak into a generated critique. */
  sources: readonly FewShotSource[];
  input: Readonly<Record<string, unknown>>;
  expectedOutput: Readonly<Record<string, unknown>>;
}

export interface CritiqueFewShotSet {
  setId: string;
  version: string;
  description: string;
  examples: readonly CritiqueFewShot[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function validateSources(value: unknown, exampleId: string): FewShotSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Few-shot ${exampleId} must cite at least one provenance source`);
  }
  return value.map((candidate, index) => {
    const source = record(candidate, `Few-shot ${exampleId} source ${index + 1}`);
    const parsed: FewShotSource = {
      dataset: nonEmptyString(source.dataset, `Few-shot ${exampleId} source dataset`),
      threadId: nonEmptyString(source.threadId, `Few-shot ${exampleId} source threadId`),
      adaptation: nonEmptyString(source.adaptation, `Few-shot ${exampleId} source adaptation`),
    };
    if (source.replyId !== undefined) {
      parsed.replyId = nonEmptyString(source.replyId, `Few-shot ${exampleId} source replyId`);
    }
    if (source.unitId !== undefined) {
      parsed.unitId = nonEmptyString(source.unitId, `Few-shot ${exampleId} source unitId`);
    }
    return parsed;
  });
}

function validateExpectedOutput(value: unknown, exampleId: string): Record<string, unknown> {
  const output = record(value, `Few-shot ${exampleId} expectedOutput`);
  for (const key of ["diagnoses", "critiques", "strengths"] as const) {
    if (!Array.isArray(output[key])) {
      throw new Error(`Few-shot ${exampleId} expectedOutput.${key} must be an array`);
    }
  }

  for (const [index, candidate] of (output.diagnoses as unknown[]).entries()) {
    const diagnosis = record(candidate, `Few-shot ${exampleId} diagnosis ${index + 1}`);
    const object = nonEmptyString(diagnosis.object, `Few-shot ${exampleId} diagnosis object`);
    if (!isObjectCode(object)) {
      throw new Error(`Few-shot ${exampleId} uses unknown diagnosis object: ${object}`);
    }
    if (diagnosis.problem !== undefined) {
      const problem = nonEmptyString(diagnosis.problem, `Few-shot ${exampleId} diagnosis problem`);
      if (!isProblemCode(problem)) {
        throw new Error(`Few-shot ${exampleId} uses unknown diagnosis problem: ${problem}`);
      }
    }
    const outcome = nonEmptyString(diagnosis.outcome, `Few-shot ${exampleId} diagnosis outcome`);
    if (!DIAGNOSIS_OUTCOMES.has(outcome)) {
      throw new Error(`Few-shot ${exampleId} uses unknown diagnosis outcome: ${outcome}`);
    }
    for (const key of ["judgmentBasis", "requiredContext", "evidenceRefs"] as const) {
      if (!Array.isArray(diagnosis[key])) {
        throw new Error(`Few-shot ${exampleId} diagnosis ${index + 1}.${key} must be an array`);
      }
    }
    nonEmptyString(diagnosis.contextStatus, `Few-shot ${exampleId} diagnosis contextStatus`);
    nonEmptyString(diagnosis.rationale, `Few-shot ${exampleId} diagnosis rationale`);
  }

  for (const [index, candidate] of (output.critiques as unknown[]).entries()) {
    const critique = record(candidate, `Few-shot ${exampleId} critique ${index + 1}`);
    const object = nonEmptyString(critique.object, `Few-shot ${exampleId} critique object`);
    if (!isObjectCode(object)) {
      throw new Error(`Few-shot ${exampleId} uses unknown critique object: ${object}`);
    }
    if (critique.problem !== undefined) {
      const problem = nonEmptyString(critique.problem, `Few-shot ${exampleId} critique problem`);
      if (!isProblemCode(problem)) {
        throw new Error(`Few-shot ${exampleId} uses unknown critique problem: ${problem}`);
      }
    }
    if (critique.recommendation !== undefined) {
      const recommendation = nonEmptyString(
        critique.recommendation,
        `Few-shot ${exampleId} critique recommendation`,
      );
      if (!isRecommendationLeafId(recommendation)) {
        throw new Error(`Few-shot ${exampleId} uses unknown recommendation: ${recommendation}`);
      }
    }
    for (const key of ["kind", "priority", "title", "issue", "rationale", "evidence", "suggestion", "contextStatus"] as const) {
      nonEmptyString(critique[key], `Few-shot ${exampleId} critique ${index + 1}.${key}`);
    }
    for (const key of ["judgmentBasis", "requiredContext", "evidenceRefs"] as const) {
      if (!Array.isArray(critique[key])) {
        throw new Error(`Few-shot ${exampleId} critique ${index + 1}.${key} must be an array`);
      }
    }
    const proposal = record(critique.proposal, `Few-shot ${exampleId} critique ${index + 1}.proposal`);
    nonEmptyString(proposal.kind, `Few-shot ${exampleId} critique ${index + 1} proposal.kind`);
    const target = record(critique.target, `Few-shot ${exampleId} critique ${index + 1}.target`);
    nonEmptyString(target.granularity, `Few-shot ${exampleId} critique ${index + 1} target.granularity`);
    record(target.ref, `Few-shot ${exampleId} critique ${index + 1} target.ref`);
  }
  return output;
}

/** Parse and validate the fixed end-to-end demonstration set. The JSON is the
 * only maintained source: examples can be revised without editing prompt code,
 * and invalid catalog codes fail fast when the API starts. */
export function parseCritiqueFewShotSet(jsonText: string): CritiqueFewShotSet {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Invalid critique few-shot JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(raw, "Critique few-shot set");
  const setId = nonEmptyString(root.setId, "Critique few-shot setId");
  const version = nonEmptyString(root.version, "Critique few-shot version");
  const description = nonEmptyString(root.description, "Critique few-shot description");
  if (!Array.isArray(root.examples) || root.examples.length !== EXPECTED_EXAMPLE_COUNT) {
    throw new Error(`Critique few-shot set must contain exactly ${EXPECTED_EXAMPLE_COUNT} examples`);
  }

  const ids = new Set<string>();
  const examples = root.examples.map((candidate, index): CritiqueFewShot => {
    const item = record(candidate, `Critique few-shot ${index + 1}`);
    const id = nonEmptyString(item.id, `Critique few-shot ${index + 1} id`);
    if (ids.has(id)) throw new Error(`Duplicate critique few-shot id: ${id}`);
    ids.add(id);
    const input = record(item.input, `Few-shot ${id} input`);
    if (!isDashboardType(input.dashboardGenre)) {
      throw new Error(`Few-shot ${id} uses unknown dashboardGenre: ${String(input.dashboardGenre)}`);
    }
    record(input.requestScope, `Few-shot ${id} input.requestScope`);
    record(input.context, `Few-shot ${id} input.context`);
    record(input.evidence, `Few-shot ${id} input.evidence`);
    const expectedOutput = validateExpectedOutput(item.expectedOutput, id);
    const promptChars = JSON.stringify({ input, expectedOutput }).length;
    if (promptChars > MAX_EXAMPLE_PROMPT_CHARS) {
      throw new Error(`Few-shot ${id} is too large for the prompt (${promptChars} chars)`);
    }
    return Object.freeze({
      id,
      purpose: nonEmptyString(item.purpose, `Few-shot ${id} purpose`),
      sources: Object.freeze(validateSources(item.sources, id)),
      input: Object.freeze(input),
      expectedOutput: Object.freeze(expectedOutput),
    });
  });

  return Object.freeze({
    setId,
    version,
    description,
    examples: Object.freeze(examples),
  });
}

const CRITIQUE_FEW_SHOT_SOURCE = readFileSync(CRITIQUE_FEW_SHOT_URL, "utf8");

export const CRITIQUE_FEW_SHOT_SET = parseCritiqueFewShotSet(CRITIQUE_FEW_SHOT_SOURCE);
export const CRITIQUE_FEW_SHOT_SET_ID = CRITIQUE_FEW_SHOT_SET.setId;
export const CRITIQUE_FEW_SHOT_VERSION = CRITIQUE_FEW_SHOT_SET.version;
export const CRITIQUE_FEW_SHOT_IDS: readonly string[] = Object.freeze(
  CRITIQUE_FEW_SHOT_SET.examples.map((example) => example.id),
);
/** Full content hash makes a run reproducible even if a maintainer accidentally
 * edits the JSON without bumping its human-readable version. */
export const CRITIQUE_FEW_SHOT_CONTENT_HASH = createHash("sha256")
  .update(CRITIQUE_FEW_SHOT_SOURCE)
  .digest("hex");

/** Complete input→output demonstrations for the actual critique task. Source
 * provenance is intentionally omitted; only the adapted, de-identified task
 * packet and gold output enter the model request. */
export function critiqueFewShotPrompt(): string {
  const lines = [
    "END-TO-END CRITIQUE DEMONSTRATIONS",
    `Fixed set: ${CRITIQUE_FEW_SHOT_SET_ID} · version ${CRITIQUE_FEW_SHOT_VERSION}`,
    "These are complete demonstrations of the same judgment task and output schema as the current request.",
    "Learn the evidence→diagnosis→critique mapping, target granularity, recommendation choice, and proposal boundary.",
    "Dashboard genre changes whether a general principle applies: analytical dashboards support exploration; infographics communicate a fixed narrative.",
    "Never treat demonstration content as evidence for the current dashboard. Never copy its tile ids, fields, values, palette, wording, or situational details unless the current packet independently contains them.",
  ];
  for (const example of CRITIQUE_FEW_SHOT_SET.examples) {
    lines.push(
      "",
      `DEMONSTRATION ${example.id} — ${example.purpose}`,
      `INPUT:\n${JSON.stringify(example.input, null, 2)}`,
      `EXPECTED OUTPUT:\n${JSON.stringify(example.expectedOutput, null, 2)}`,
      `END DEMONSTRATION ${example.id}`,
    );
  }
  return lines.join("\n");
}
