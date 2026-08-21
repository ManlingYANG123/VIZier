import { createHash } from "node:crypto";
import type {
  BoardMeta,
  ContextField,
  ContextStatus,
  ContextValueStatus,
  DashboardContext,
  EvidenceRef,
  Finding,
  SpecMap,
} from "../contracts.ts";
import { runDetectors } from "../detect/index.ts";
import type { JudgmentBasis } from "../contracts.ts";
import {
  JUDGMENT_BASIS_LABELS,
  contextDependenciesForBasis,
} from "./review-data.ts";

export interface ContextSnapshot {
  id: string;
  values: DashboardContext;
  fieldStatus: Record<ContextField, ContextValueStatus>;
}

export interface EvidencePacket {
  specMap: SpecMap;
  board: BoardMeta;
  interactionState: Record<string, unknown>;
  detectorFindings: Finding[];
  detectorEvidence: EvidenceRef[];
}

/** Which grounding labels the current context could support, before evidence is
 * cited. "dashboard evidence" and "general design principle" need no context,
 * so they are always available; the context-dependent labels (analytical task,
 * audience, author constraint, personal preference) are available only when the
 * snapshot carries their required field. This replaces the former per-criterion
 * eligibility: grounding is the single uniform gate, so availability is computed
 * once per run rather than per criterion. */
export interface GroundingAvailability {
  /** Grounding labels whose required context is present (available or inferred). */
  available: JudgmentBasis[];
  /** Grounding labels blocked purely because their required context is missing. */
  missing: JudgmentBasis[];
  /** Registry dependency ids that are absent from the snapshot. */
  missingContext: string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function compact(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function snapshotId(context: DashboardContext): string {
  return `ctx-${createHash("sha256").update(compact(context)).digest("hex").slice(0, 12)}`;
}

function normalizedFieldStatus(
  field: ContextField,
  context: DashboardContext,
): ContextValueStatus {
  const value = context[field]?.trim();
  if (!value) return "missing";
  return context.fieldStatus?.[field] === "confirmed" ? "confirmed" : "inferred";
}

export function buildContextSnapshot(context: DashboardContext): ContextSnapshot {
  const fieldStatus: Record<ContextField, ContextValueStatus> = {
    goal: normalizedFieldStatus("goal", context),
    audience: normalizedFieldStatus("audience", context),
    constraints: normalizedFieldStatus("constraints", context),
  };
  const values: DashboardContext = {
    ...context,
    goal: context.goal?.trim() || undefined,
    audience: context.audience?.trim() || undefined,
    constraints: context.constraints?.trim() || undefined,
    notes: (context.notes || []).map((note) => note.trim()).filter(Boolean),
    customTypes: (context.customTypes || []).map((item) => item.trim()).filter(Boolean),
    fieldStatus,
  };
  return {
    id: context.snapshotId?.trim() || snapshotId(values),
    values,
    fieldStatus,
  };
}

export function evidenceRefForFinding(finding: Finding): EvidenceRef {
  return {
    source: "detector",
    path: `finding.${finding.id}`,
    detail: finding.evidence.detail,
    ...(finding.tileId ? { tileId: finding.tileId } : {}),
    ...(finding.evidence.sharedField ? { field: finding.evidence.sharedField } : {}),
    ...(finding.evidence.channel ? { channel: finding.evidence.channel } : {}),
    findingId: finding.id,
    findingKind: finding.kind,
  };
}

export function buildEvidencePacket(
  specMap: SpecMap,
  board: BoardMeta | undefined,
  interactionState: Record<string, unknown> | undefined,
): EvidencePacket {
  const detectorFindings = runDetectors(specMap, board);
  return {
    specMap,
    board: board || {},
    interactionState: interactionState || {},
    detectorFindings,
    detectorEvidence: detectorFindings.map(evidenceRefForFinding),
  };
}

function dependencyField(dependency: string): ContextField | null {
  if (dependency === "analytical_task") return "goal";
  if (dependency === "audience" || dependency === "use_setting") return "audience";
  if (dependency === "author_constraint" || dependency === "author_intent") return "constraints";
  return null;
}

function dependencyValueStatus(
  dependency: string,
  snapshot: ContextSnapshot,
): ContextValueStatus | null {
  if (
    dependency === "author_intent" &&
    snapshot.fieldStatus.constraints === "missing" &&
    (snapshot.values.notes || []).length
  ) return "confirmed";
  const field = dependencyField(dependency);
  return field ? snapshot.fieldStatus[field] : null;
}

export function contextStatusForDependencies(
  dependencies: string[],
  snapshot: ContextSnapshot,
): { contextStatus: ContextStatus; missingContext: string[] } {
  const missingContext = dependencies.filter((dependency) => {
    const status = dependencyValueStatus(dependency, snapshot);
    return status ? status === "missing" : true;
  });
  if (missingContext.length) return { contextStatus: "missing", missingContext };
  if (!dependencies.length) return { contextStatus: "not_applicable", missingContext: [] };
  const inferred = dependencies.some((dependency) => {
    return dependencyValueStatus(dependency, snapshot) === "inferred";
  });
  return { contextStatus: inferred ? "inferred" : "available", missingContext: [] };
}

/** Compute, once per run, which grounding labels the current context can
 * support. A label is available when the dependencies its registry entry
 * requires are present (available or inferred) in the snapshot. */
export function determineGroundingAvailability(
  snapshot: ContextSnapshot,
): GroundingAvailability {
  const available: JudgmentBasis[] = [];
  const missing: JudgmentBasis[] = [];
  const missingContext = new Set<string>();
  for (const label of JUDGMENT_BASIS_LABELS) {
    const dependencies = contextDependenciesForBasis(label);
    const status = contextStatusForDependencies(dependencies, snapshot);
    if (status.contextStatus === "missing") {
      missing.push(label);
      status.missingContext.forEach((dependency) => missingContext.add(dependency));
    } else {
      available.push(label);
    }
  }
  return { available, missing, missingContext: [...missingContext] };
}
