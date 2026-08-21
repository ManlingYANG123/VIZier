/**
 * Deterministic recommendation planning for the v2 interaction prototype.
 *
 * The browser uses the dependency-planning contracts below. Legacy pure
 * apply/re-evaluation helpers remain only as network-free test oracles; the
 * production UI commits results returned by re_api.
 * the same request/response shape with twbx2vegalite refine/evaluate/rollback.
 *
 * @typedef {Object} ApplyRecommendationsRequest
 * @property {number} version
 * @property {Object} context
 * @property {string[]} selectedRecommendationIds
 * @property {Record<string, string>} conflictChoices
 * @property {Object=} bundle
 * @property {Object=} specMap
 *
 * @typedef {Object} ApplyRecommendationsResponse
 * @property {Object} dashboardState
 * @property {string[]} applicationOrder
 * @property {string[]} changedTargets
 * @property {{kept:string[],updated:string[],removed:string[],added:string[]}} recommendationDelta
 * @property {Object=} evaluationReport
 * @property {{rolledBack:boolean,reason:string|null}} rollback
 */

const RELATIONSHIPS_BY_KIND = {
  "dashboard-title": {
    reads: ["context.goal", "context.audience"],
    writes: ["dashboard.title", "dashboard.subtitle"],
  },
  "add-kpis": {
    reads: ["dashboard.metrics"],
    writes: ["dashboard.layout", "dashboard.kpi-row"],
    invalidates: ["chart.bounds", "spatial-markers"],
  },
  "recompose-kpis": {
    reads: ["dashboard.kpi-row", "dashboard.layout"],
    writes: ["dashboard.layout", "dashboard.kpi-row"],
    invalidates: ["chart.bounds", "spatial-markers"],
  },
  "chart-subtitles": {
    reads: ["dashboard.layout", "context.goal"],
    writes: ["chart.labels", "chart.bounds"],
    dependsOnKinds: ["add-kpis"],
  },
  "v2-palette": {
    reads: ["context.constraints", "chart.encodings.color"],
    writes: ["chart.encodings.color"],
    conflictsWithKinds: ["preserve-brand-palette"],
  },
  "preserve-brand-palette": {
    reads: ["context.constraints", "chart.encodings.color"],
    writes: ["chart.encodings.color"],
    conflictsWithKinds: ["v2-palette"],
  },
  "add-cross-filter": {
    reads: ["tile.department-tasks.selection", "shared-field.department"],
    writes: ["dashboard.cross-filter", "tile.task-velocity.data", "tile.project-status.data"],
    invalidates: ["interaction.active-filter-state"],
  },
  "add-tooltip": {
    reads: ["tile.task-velocity.encoding"],
    writes: ["tile.task-velocity.encoding.tooltip", "tile.task-velocity.mark.point"],
  },
  "show-filter-state": {
    reads: ["dashboard.cross-filter"],
    writes: ["dashboard.active-filter-state"],
    dependsOnKinds: ["add-cross-filter"],
  },
  "wire-filter-control": {
    reads: ["dashboard.filters", "tile.spec"],
    writes: ["dashboard.filters"],
  },
  // General spec-edit primitive: reads and writes the target tile's own spec.
  // Concrete target ids come from the critique ref, so the base relation only
  // records the coarse tile.spec channel (no cross-tile conflicts by default).
  "edit-spec": {
    reads: ["tile.spec"],
    writes: ["tile.spec"],
  },
  // Board-layout primitive: moves/resizes whole tiles on the board (their bounds
  // live on the board, not in any spec). Writing dashboard.layout invalidates the
  // spatial markers that are positioned off those bounds.
  "edit-layout": {
    reads: ["dashboard.layout"],
    writes: ["dashboard.layout", "chart.bounds"],
    invalidates: ["spatial-markers"],
  },
};

const ACTIVE_STATUSES = new Set(["pending", "updated"]);

function clone(value) {
  return structuredClone(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function relationFor(recommendation) {
  return RELATIONSHIPS_BY_KIND[recommendation.proposal?.kind] || {};
}

/**
 * Add semantic relationship metadata while preserving explicit overrides.
 */
export function enrichRecommendations(recommendations, version = 1) {
  const kindToIds = new Map();
  recommendations.forEach((recommendation) => {
    const kind = recommendation.proposal?.kind;
    if (!kindToIds.has(kind)) kindToIds.set(kind, []);
    kindToIds.get(kind).push(recommendation.id);
  });

  return recommendations.map((recommendation) => {
    const relation = relationFor(recommendation);
    const idsForKinds = (kinds = []) => kinds.flatMap((kind) => kindToIds.get(kind) || []);
    return {
      ...clone(recommendation),
      status: recommendation.status || "pending",
      reads: unique([...(recommendation.reads || []), ...(relation.reads || [])]),
      writes: unique([...(recommendation.writes || []), ...(relation.writes || [])]),
      invalidates: unique([...(recommendation.invalidates || []), ...(relation.invalidates || [])]),
      dependsOn: unique([
        ...(recommendation.dependsOn || []),
        ...idsForKinds(relation.dependsOnKinds),
      ]).filter((id) => id !== recommendation.id),
      conflictsWith: unique([
        ...(recommendation.conflictsWith || []),
        ...idsForKinds(relation.conflictsWithKinds),
      ]).filter((id) => id !== recommendation.id),
      revision: recommendation.revision || 1,
      introducedInVersion: recommendation.introducedInVersion || version,
      lastEvaluatedVersion: recommendation.lastEvaluatedVersion || version,
    };
  });
}

function activeRecommendation(recommendation) {
  return recommendation && ACTIVE_STATUSES.has(recommendation.status);
}

function conflictKey(a, b) {
  return [a, b].sort().join("::");
}

function includeDependencies(selected, byId) {
  const included = new Set(selected);
  const visit = (id) => {
    const recommendation = byId.get(id);
    if (!activeRecommendation(recommendation)) return;
    (recommendation.dependsOn || []).forEach((dependencyId) => {
      if (!activeRecommendation(byId.get(dependencyId))) return;
      if (!included.has(dependencyId)) included.add(dependencyId);
      visit(dependencyId);
    });
  };
  [...included].forEach(visit);
  return included;
}

function topologicalOrder(ids, byId) {
  const idSet = new Set(ids);
  const temporary = new Set();
  const permanent = new Set();
  const ordered = [];
  let cyclic = false;

  const visit = (id) => {
    if (permanent.has(id)) return;
    if (temporary.has(id)) {
      cyclic = true;
      return;
    }
    temporary.add(id);
    const recommendation = byId.get(id);
    (recommendation?.dependsOn || [])
      .filter((dependencyId) => idSet.has(dependencyId))
      .forEach(visit);
    temporary.delete(id);
    permanent.add(id);
    ordered.push(id);
  };

  ids.forEach(visit);
  return { ordered, cyclic };
}

/**
 * Build a non-mutating plan. Conflict choices use the stable "idA::idB" key.
 */
export function buildApplicationPlan(
  selectedIds,
  recommendations,
  conflictChoices = {},
) {
  const enriched = enrichRecommendations(recommendations);
  const byId = new Map(enriched.map((recommendation) => [recommendation.id, recommendation]));
  const requested = unique(selectedIds).filter((id) => activeRecommendation(byId.get(id)));
  const included = includeDependencies(requested, byId);

  const conflicts = [];
  [...included].forEach((id) => {
    const recommendation = byId.get(id);
    (recommendation.conflictsWith || []).forEach((otherId) => {
      if (!included.has(otherId) || id > otherId) return;
      const key = conflictKey(id, otherId);
      const choice = conflictChoices[key];
      conflicts.push({
        key,
        recommendationIds: [id, otherId],
        chosenId: [id, otherId].includes(choice) ? choice : null,
      });
    });
  });

  conflicts.forEach((conflict) => {
    if (!conflict.chosenId) return;
    conflict.recommendationIds
      .filter((id) => id !== conflict.chosenId)
      .forEach((id) => included.delete(id));
  });

  const missingDependencies = [...included].flatMap((id) => {
    const recommendation = byId.get(id);
    return (recommendation?.dependsOn || [])
      .filter((dependencyId) =>
        activeRecommendation(byId.get(dependencyId)) && !included.has(dependencyId))
      .map((dependencyId) => ({ recommendationId: id, dependencyId }));
  });
  const { ordered, cyclic } = topologicalOrder([...included], byId);
  const unresolvedConflicts = conflicts.filter((conflict) => !conflict.chosenId);
  const dependent = ordered.filter((id) =>
    (byId.get(id)?.dependsOn || []).some((dependencyId) => included.has(dependencyId)));
  const safe = ordered.filter((id) => !dependent.includes(id));
  const changedTargets = unique(ordered.flatMap((id) => [
    ...(byId.get(id)?.writes || []),
    ...(byId.get(id)?.invalidates || []),
  ]));

  return {
    requested,
    included: [...included],
    order: ordered,
    safe,
    dependent,
    conflicts,
    unresolvedConflicts,
    missingDependencies,
    changedTargets,
    canApply:
      !cyclic &&
      unresolvedConflicts.length === 0 &&
      missingDependencies.length === 0 &&
      ordered.length > 0,
    cyclic,
  };
}

/**
 * Apply a valid plan to a clone. The executor mutates only the cloned draft.
 */
export function applyPlan(plan, dashboardState, executor) {
  if (!plan.canApply) {
    return {
      ok: false,
      dashboardState,
      reason: plan.cyclic
        ? "Dependency cycle detected."
        : plan.missingDependencies?.length
          ? "A required dependency was excluded from the plan."
          : "Resolve conflicts before applying.",
    };
  }
  const draft = clone(dashboardState);
  for (const recommendationId of plan.order) {
    const result = executor(draft, recommendationId);
    if (result === false) {
      return {
        ok: false,
        dashboardState,
        reason: `Could not apply recommendation ${recommendationId}.`,
      };
    }
  }
  return { ok: true, dashboardState: draft, reason: null };
}

function activeFilterFollowUp(version) {
  return {
    id: `follow-up-filter-state-v${version}`,
    tileId: null,
    dimension: "interaction",
    priority: "medium",
    status: "pending",
    source: "ai",
    lifecycle: "new",
    title: "Active department filter is not visible",
    issue: "Cross-filtering now works, but the dashboard does not persistently show which department is active.",
    suggestion: "Add a compact active-filter chip with a clear action above the coordinated views.",
    rationale: "Visible system status helps readers understand why values changed and how to return to the full view.",
    evidence: "The new cross-filter changes two views while the selected department is only encoded in the source bar.",
    target: { granularity: "cross-view-interaction", ref: { component: "active-filter-state" } },
    proposal: { kind: "show-filter-state" },
    surface: "structural",
    bounds: { x: 320, y: 78, w: 460, h: 42 },
    introducedInVersion: version,
    lastEvaluatedVersion: version,
  };
}

/**
 * Simulate affected-target re-evaluation after application.
 */
export function reevaluateMock(
  previousRecommendations,
  appliedIds,
  changedTargets,
  newVersion,
) {
  const enriched = enrichRecommendations(previousRecommendations);
  const applied = new Set(appliedIds);
  const appliedKinds = new Set(
    enriched.filter((item) => applied.has(item.id)).map((item) => item.proposal?.kind),
  );
  const kept = [];
  const updated = [];
  const removed = [];

  let next = enriched.map((recommendation) => {
    const item = clone(recommendation);
    item.lastEvaluatedVersion = newVersion;

    if (applied.has(item.id)) {
      item.status = "resolved";
      item.lifecycle = "resolved";
      return item;
    }

    const supersededByApplied = (item.conflictsWith || []).some((id) => applied.has(id));
    if (supersededByApplied && activeRecommendation(item)) {
      item.status = "superseded";
      item.lifecycle = "removed";
      removed.push(item.id);
      return item;
    }

    if (
      appliedKinds.has("add-kpis") &&
      item.proposal?.kind === "chart-subtitles" &&
      activeRecommendation(item)
    ) {
      item.status = "updated";
      item.lifecycle = "updated";
      item.revision = (item.revision || 1) + 1;
      item.issue = "The new KPI row improves scanning, but chart subtitles still need to explain the detailed views in the revised layout.";
      item.evidence = "After the KPI row was added, the four charts moved down and remain descriptive rather than insight-led.";
      updated.push(item.id);
      return item;
    }

    if (activeRecommendation(item)) kept.push(item.id);
    return item;
  });

  const added = [];
  if (
    appliedKinds.has("add-cross-filter") &&
    !next.some((item) => item.proposal?.kind === "show-filter-state")
  ) {
    const followUp = activeFilterFollowUp(newVersion);
    next.push(followUp);
    added.push(followUp.id);
  }

  return {
    // Enrich as one set so newly introduced recommendations can resolve
    // dependencies against recommendations that already exist.
    recommendations: enrichRecommendations(next, newVersion),
    delta: {
      kept: unique(kept),
      updated: unique(updated),
      removed: unique(removed),
      added,
      changedTargets: unique(changedTargets),
    },
  };
}

export function relationshipSummary(recommendation, recommendations) {
  const byId = new Map(recommendations.map((item) => [item.id, item]));
  return {
    dependencies: (recommendation.dependsOn || []).map((id) => byId.get(id)).filter(Boolean),
    conflicts: (recommendation.conflictsWith || []).map((id) => byId.get(id)).filter(Boolean),
  };
}
