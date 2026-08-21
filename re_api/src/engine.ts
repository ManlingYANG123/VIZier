/**
 * Orchestrator. Wires detect -> generate -> apply -> compute -> reevaluate and
 * emits a TraceEvent at every phase boundary. Both entry points take a Tracer
 * so the caller (SSE handler, tests, report) can observe the run live.
 */
import type {
  ApplyRequest,
  ApplyResponse,
  Critique,
  CritiqueRequest,
  CritiqueResponse,
  EvaluationReport,
  ReviewScope,
} from "./contracts.ts";
import type { LLMClient } from "./llm/client.ts";
import { Tracer } from "./trace.ts";
import { runDetectors } from "./detect/index.ts";
import { discoverDashboardCritiques } from "./generate/discover.ts";
import { applyBoardProposal, applyProposals } from "./apply/index.ts";
import { validateAppliedDashboard } from "./apply/validate.ts";
import { computeCrossFilterSlice, distinctValues } from "./compute/crossFilter.ts";
import { reevaluate } from "./reevaluate.ts";
import {
  CRITERION_REGISTRY_VERSION,
  REVIEW_ENGINE_VERSION,
  REVIEW_PROMPT_VERSION,
} from "./generate/review-data.ts";

export interface EngineDeps {
  client?: LLMClient;
}

export function resolveReviewScope(req: CritiqueRequest): ReviewScope {
  if (req.region && req.focus) {
    throw new Error("REVIEW_SCOPE_CONFLICT: use either a selected region or a focused full-dashboard request");
  }
  const derivedScope: ReviewScope = req.region ? "selected-region" : req.focus ? "focused" : "full";
  if (req.reviewScope && req.reviewScope !== derivedScope) {
    throw new Error(
      `REVIEW_SCOPE_MISMATCH: ${req.reviewScope} requires matching ${req.reviewScope === "focused" ? "focus" : req.reviewScope === "selected-region" ? "region" : "full-dashboard"} input`,
    );
  }
  return derivedScope;
}

/** Moderate exploration by default: enough room for dashboard-specific
 * synthesis while the evidence and apply gates keep proposals responsible. */
export const DEFAULT_REVIEW_TEMPERATURE = 0.6;
/** The review draft runs on the model's standard 0–1 temperature scale. */
export const MIN_REVIEW_TEMPERATURE = 0;
export const MAX_REVIEW_TEMPERATURE = 1;

/** Sanitize the author-set review temperature. The client owns the number now
 * (the slider shows it directly), so the engine only guards the boundary:
 * non-finite or omitted input falls back to the default, and in-range values
 * are clamped to [0, 1] and rounded to one decimal to match the slider's step. */
export function clampReviewTemperature(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_REVIEW_TEMPERATURE;
  }
  const bounded = Math.min(MAX_REVIEW_TEMPERATURE, Math.max(MIN_REVIEW_TEMPERATURE, value));
  return Math.round(bounded * 10) / 10;
}

export async function runCritique(
  req: CritiqueRequest,
  tracer: Tracer,
  deps: EngineDeps = {},
): Promise<CritiqueResponse> {
  const reviewScope = resolveReviewScope(req);
  tracer.emit("run_start", "criteria-aware critique", {
    version: req.version,
    reviewScope,
    legacyModeIgnored: req.mode,
    engineVersion: REVIEW_ENGINE_VERSION,
  });
  tracer.emit("evidence_start", "Normalizing dashboard, context, interaction, and detector evidence");
  tracer.emit("eligibility_start", "Determining which versioned criteria can be responsibly evaluated");
  tracer.emit("generate_start", "LLM is evaluating eligible criteria before drafting critiques", {
    llm: true,
    requireLLM: true,
    reviewScope,
    registryVersion: CRITERION_REGISTRY_VERSION,
    promptVersion: REVIEW_PROMPT_VERSION,
  });
  const result = await discoverDashboardCritiques(
    req.specMap,
    req.context,
    req.board,
    deps.client,
    (t) => tracer.emit("generate_token", undefined, { t }, false),
    req.region,
    req.focus,
    req.interactionState,
    clampReviewTemperature(req.reviewTemperature),
    req.savedRationales,
    req.constraintSet,
    req.iterationContext,
  );
  tracer.emit("evidence_done", `${result.evidencePacket.detectorEvidence.length} deterministic evidence helper(s)`, {
    findings: result.evidencePacket.detectorFindings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      detail: finding.evidence.detail,
    })),
  });
  tracer.emit("eligibility_done", `${result.diagnoses.length} diagnosis outcome(s)`, {
    outcomes: result.diagnoses.map((diagnosis) => ({
      object: diagnosis.object,
      problem: diagnosis.problem,
      outcome: diagnosis.outcome,
      contextStatus: diagnosis.contextStatus,
    })),
  });
  const fallbackCount = result.critiques.filter((critique) =>
    critique.phrasingSource === "template"
  ).length;
  tracer.emit(
    "guardrail_done",
    fallbackCount
      ? `${result.critiques.length} grounded critique(s) ready · ${fallbackCount} deterministic fallback`
      : `${result.critiques.length} critique(s) passed all validation gates`,
    {
      fallbackCount,
      ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
    },
  );
  tracer.emit("rank_done", `${result.critiques.length} non-overlapping critique(s) selected`);
  const droppedByConstraint = result.droppedByConstraint ?? [];
  if (req.constraintSet) {
    tracer.emit(
      "constraint_filter",
      droppedByConstraint.length
        ? `${droppedByConstraint.length} critique(s) dropped by your design document`
        : "no critiques conflicted with your design document",
      { dropped: droppedByConstraint, keptCount: result.critiques.length },
    );
  }
  tracer.emit("generate_done", `${result.critiques.length} critique(s)`, {
    critiques: result.critiques.map((critique) => ({ id: critique.id, title: critique.title, kind: critique.proposal.kind })),
  });
  tracer.emit("done", `${reviewScope} criteria-aware review complete`);
  return {
    runId: tracer.runId,
    reviewScope,
    findings: result.findings,
    critiques: result.critiques,
    diagnoses: result.diagnoses,
    strengths: result.strengths,
    registryVersion: CRITERION_REGISTRY_VERSION,
    promptVersion: REVIEW_PROMPT_VERSION,
    engineVersion: REVIEW_ENGINE_VERSION,
    contextSnapshotId: result.contextSnapshotId,
    ...(req.focus ? { focus: req.focus } : {}),
    ...(result.answer ? { answer: result.answer } : {}),
  };
}

export async function runApply(
  req: ApplyRequest,
  tracer: Tracer,
  deps: EngineDeps = {},
): Promise<ApplyResponse> {
  tracer.emit("run_start", "apply", { selected: req.selectedRecommendationIds });

  // Ensure a cross-filter is applied before its show-filter-state follow-up.
  const byId = new Map(req.critiques.map((c) => [c.id, c]));
  const guidanceOnly = req.selectedRecommendationIds
    .map((id) => byId.get(id))
    .filter((critique): critique is Critique => Boolean(critique?.proposal.mode === "guidance_only"));
  if (guidanceOnly.length) {
    throw new Error(
      `APPLY_NOT_EXECUTABLE: guidance-only critique(s) cannot be applied: ${guidanceOnly.map((critique) => critique.id).join(", ")}`,
    );
  }
  const order = [...req.selectedRecommendationIds].sort((a, b) => {
    const ka = byId.get(a)?.proposal.kind;
    const kb = byId.get(b)?.proposal.kind;
    if (ka === "add-cross-filter" && kb === "show-filter-state") return -1;
    if (kb === "add-cross-filter" && ka === "show-filter-state") return 1;
    // edit-layout runs before KPI composition. The KPI step then refits the
    // resulting arrangement into its reserved region inside the fixed canvas.
    if (ka === "edit-layout" && (kb === "add-kpis" || kb === "recompose-kpis")) return -1;
    if (kb === "edit-layout" && (ka === "add-kpis" || ka === "recompose-kpis")) return 1;
    return 0;
  });

  tracer.emit("apply", `Applying ${order.length} proposal(s)`, { order });
  const outcome = await applyProposals(req.specMap, req.critiques, order, {
    client: deps.client,
    conflictChoices: req.conflictChoices,
  });
  if (outcome.unresolvedConflicts.length) {
    tracer.emit(
      "apply",
      `${outcome.unresolvedConflicts.length} same-tile conflict(s) need an author choice`,
      { conflicts: outcome.unresolvedConflicts },
    );
  }
  const nextBoard = structuredClone(req.board || {});
  const boardChangedTargets = new Set<string>();
  const boardAppliedIds = new Set<string>();
  for (const id of order) {
    const critique = byId.get(id);
    // add-kpis computes its numbers from the applied (post-edit) tile data.
    if (!critique || !applyBoardProposal(nextBoard, critique, outcome.specMap)) continue;
    boardAppliedIds.add(id);
    if (critique.proposal.kind === "dashboard-title") boardChangedTargets.add("dashboard.title");
    if (critique.proposal.kind === "wire-filter-control") boardChangedTargets.add("dashboard.filters");
    if (critique.proposal.kind === "add-kpis" || critique.proposal.kind === "recompose-kpis") {
      boardChangedTargets.add("dashboard.kpis");
      boardChangedTargets.add("dashboard.layout");
    }
    if (critique.proposal.kind === "chart-subtitles") boardChangedTargets.add("dashboard.chart-subtitles");
    if (critique.proposal.kind === "edit-layout") boardChangedTargets.add("dashboard.layout");
  }
  const appliedOrder = order.filter((id) =>
    outcome.applicationOrder.includes(id) || boardAppliedIds.has(id)
  );
  const changedTargets = [...new Set([...outcome.changedTargets, ...boardChangedTargets])];

  tracer.emit("validate", outcome.rollback.rolledBack ? "compile FAILED -> rollback" : "compile ok", {
    rolledBack: outcome.rollback.rolledBack,
    reason: outcome.rollback.reason,
  });

  if (outcome.rollback.rolledBack) {
    tracer.emit("done", "apply rolled back");
    const report: EvaluationReport = {
      compiled: false,
      compileError: outcome.compileError,
      remainingFindings: runDetectors(req.specMap, req.board).length,
      computed: [],
    };
    return {
      runId: tracer.runId,
      specMap: req.specMap,
      board: req.board || {},
      applicationOrder: [],
      changedTargets: [],
      recommendationDelta: { kept: [], updated: [], removed: [], added: [], changedTargets: [] },
      addedCritiques: [],
      evaluationReport: report,
      rollback: outcome.rollback,
      critiqueStatuses: outcome.critiqueStatuses,
      unresolvedConflicts: outcome.unresolvedConflicts,
    };
  }
  const dashboardValidation = validateAppliedDashboard(
    req.board || {},
    nextBoard,
    req.specMap,
    outcome.specMap,
  );
  tracer.emit(
    "validate",
    dashboardValidation.ok ? "post-apply dashboard quality ok" : "post-apply dashboard quality FAILED -> rollback",
    { errors: dashboardValidation.errors },
  );
  if (!dashboardValidation.ok) {
    const reason = `dashboard quality gate failed: ${dashboardValidation.errors.join("; ")}`;
    tracer.emit("done", "apply rolled back");
    return {
      runId: tracer.runId,
      specMap: req.specMap,
      board: req.board || {},
      applicationOrder: [],
      changedTargets: [],
      recommendationDelta: { kept: [], updated: [], removed: [], added: [], changedTargets: [] },
      addedCritiques: [],
      evaluationReport: {
        compiled: true,
        compileError: null,
        remainingFindings: runDetectors(req.specMap, req.board).length,
        computed: [],
      },
      rollback: { rolledBack: true, reason },
      critiqueStatuses: outcome.critiqueStatuses,
      unresolvedConflicts: outcome.unresolvedConflicts,
    };
  }
  // Only a genuine no-op is an error. When the selection produced no change
  // solely because every fix is waiting on an author conflict choice, that is a
  // normal outcome the client resolves — surface it instead of throwing.
  if (req.selectedRecommendationIds.length && !changedTargets.length && !outcome.unresolvedConflicts.length) {
    throw new Error(
      "APPLY_NO_CHANGE: the selected recommendation did not produce a dashboard or specification change",
    );
  }

  // Engine computes the real post-interaction data for applied cross-filters.
  tracer.emit("compute", "Computing real post-interaction data slices");
  const computed: EvaluationReport["computed"] = [];
  for (const id of appliedOrder) {
    const c = byId.get(id);
    if (c?.proposal.kind !== "add-cross-filter") continue;
    const ref = c.target.ref as { field?: string; source?: string; targets?: string[] };
    const field = String(ref.field);
    const source = String(ref.source);
    const value = distinctValues(outcome.specMap[source] ?? {}, field)[0];
    for (const t of ref.targets ?? []) {
      const targetSpec = outcome.specMap[t];
      if (!targetSpec || value === undefined) continue;
      const slice = computeCrossFilterSlice(targetSpec, field, value);
      const note = `${t}: ${field}="${value}" -> ${slice.rowsAfter}/${slice.rowsBefore} rows${
        slice.pinnedMax !== null ? `, y pinned to ${Math.ceil(slice.pinnedMax * 1.05)}` : ""
      }`;
      computed.push({ tileId: t, note });
      tracer.emit("compute", note, { tileId: t, field, value, rowsAfter: slice.rowsAfter });
    }
  }

  const reeval = reevaluate(req.critiques, appliedOrder, outcome.specMap, changedTargets, nextBoard);
  tracer.emit("reevaluate_done", "recommendation delta computed", {
    delta: reeval.delta,
    remainingFindings: reeval.remainingFindings,
  });

  tracer.emit("done", "apply complete");
  const report: EvaluationReport = {
    compiled: true,
    compileError: null,
    remainingFindings: reeval.remainingFindings,
    computed,
  };
  const addedCritiques: Critique[] = reeval.added
    .map((aid) => reeval.critiques.find((c) => c.id === aid))
    .filter((c): c is Critique => Boolean(c));

  return {
    runId: tracer.runId,
    specMap: outcome.specMap,
    board: nextBoard,
    applicationOrder: appliedOrder,
    changedTargets,
    recommendationDelta: reeval.delta,
    addedCritiques,
    evaluationReport: report,
    rollback: outcome.rollback,
    critiqueStatuses: outcome.critiqueStatuses,
    unresolvedConflicts: outcome.unresolvedConflicts,
  };
}
