/**
 * The render gate: a candidate spec is only adopted if Vega-Lite can compile it
 * to a Vega spec AND Vega can parse the compiled runtime graph. `compile()`
 * alone is not enough: Vega-Lite can emit a Vega program with duplicate signal
 * names that the browser cannot run.
 */
import { compile } from "vega-lite";
import { parse } from "vega";
import type { SpecMap, VegaLiteSpec } from "../contracts.ts";

export interface CompileResult {
  ok: boolean;
  errors: Record<string, string>;
  warnings: Record<string, string[]>;
}

export interface SpecCompileResult {
  ok: boolean;
  error: string | null;
  warnings: string[];
  lossyWarnings: string[];
}

const LOSSY_WARNING_PATTERN = /\b(?:dropping|dropped|ignore[ds]?|ignoring|incompatible|conflicting|inappropriate)\b|cannot be used|will not work/iu;

function warningText(args: readonly unknown[]): string {
  return args.map((value) => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ").trim();
}

function compileWithWarnings(spec: VegaLiteSpec): { error: string | null; warnings: string[] } {
  const warnings: string[] = [];
  let logLevel = 0;
  const logger = {
    level(value?: number) {
      if (typeof value === "number") {
        logLevel = value;
        return this;
      }
      return logLevel;
    },
    warn(...args: readonly unknown[]) {
      const message = warningText(args);
      if (message) warnings.push(message);
      return this;
    },
    info() { return this; },
    debug() { return this; },
    error(...args: readonly unknown[]) {
      throw new Error(warningText(args) || "Vega-Lite compile error");
    },
  };
  try {
    const compiled = compile(spec as never, { logger: logger as never });
    parse(compiled.spec);
    return { error: null, warnings: [...new Set(warnings)] };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      warnings: [...new Set(warnings)],
    };
  }
}

function newlyLossyWarnings(warnings: string[], baselineWarnings: string[]): string[] {
  const allowed = new Set(baselineWarnings);
  return warnings.filter((warning) => LOSSY_WARNING_PATTERN.test(warning) && !allowed.has(warning));
}

export function compileSpec(spec: VegaLiteSpec, baseline?: VegaLiteSpec): SpecCompileResult {
  const compiled = compileWithWarnings(spec);
  const baselineWarnings = baseline ? compileWithWarnings(baseline).warnings : [];
  const lossyWarnings = newlyLossyWarnings(compiled.warnings, baselineWarnings);
  const warningError = lossyWarnings.length
    ? `Vega-Lite would discard or override part of the proposal: ${lossyWarnings.join(" | ")}`
    : null;
  const error = compiled.error || warningError;
  return {
    ok: error === null,
    error,
    warnings: compiled.warnings,
    lossyWarnings,
  };
}

export function compileSpecMap(specMap: SpecMap, baselineSpecMap?: SpecMap): CompileResult {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string[]> = {};
  for (const [tileId, spec] of Object.entries(specMap)) {
    const result = compileSpec(spec, baselineSpecMap?.[tileId]);
    if (result.warnings.length) warnings[tileId] = result.warnings;
    if (!result.ok && result.error) errors[tileId] = result.error;
  }
  return { ok: Object.keys(errors).length === 0, errors, warnings };
}
