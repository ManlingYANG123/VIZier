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
import type { LLMClient } from "../llm/client.ts";
import { adapterFor } from "./sources.ts";
import { INTAKE_SYSTEM, intakeUser } from "./prompt.ts";
import { emptyConstraintSet, normalizeConstraintSet } from "./normalize.ts";

export { IntakeUnsupportedError } from "./sources.ts";
export { INTAKE_PROMPT_VERSION } from "./prompt.ts";

export interface BuildConstraintSetOptions {
  /** When true, throw if no model is configured instead of returning an empty
   * set. The onboarding UI sets this so a missing gateway fails visibly. */
  requireLLM?: boolean;
}

export interface BuildConstraintSetResult {
  constraintSet: ConstraintSet;
  /** "llm" when a model actually parsed the source; "empty" when the source had
   * no extractable text or no model was configured (and requireLLM was off). */
  source: "llm" | "empty";
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
  const raw = await client.completeJson<Record<string, unknown>>(
    intakeUser(material),
    { system: INTAKE_SYSTEM, temperature: 0, maxTokens: 1500 },
  );
  return { constraintSet: normalizeConstraintSet(raw, source.kind, material.provenance), source: "llm" };
}
