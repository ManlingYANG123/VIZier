const STRONG_EVENT_KINDS = new Set([
  "context_saved",
  "context_note_added",
  "local_critique_requested",
  "critique_rationale_added",
  "recommendation_accepted",
  "recommendation_rejected",
]);

function normalized(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function isStrongInteractionEvent(event) {
  return STRONG_EVENT_KINDS.has(event?.kind);
}

export function strongInteractionEventCount(events = []) {
  return events.filter(isStrongInteractionEvent).length;
}

export function createJournalEvent({
  id,
  version,
  kind,
  summary,
  detail,
  critiqueId,
  dimension,
  proposalKind,
  bounds,
  data,
}) {
  const event = {
    id: normalized(id),
    version: Number(version) || 1,
    kind: normalized(kind),
    summary: normalized(summary),
  };
  if (detail) event.detail = normalized(detail);
  if (critiqueId) event.critiqueId = normalized(critiqueId);
  if (dimension) event.dimension = normalized(dimension);
  if (proposalKind) event.proposalKind = normalized(proposalKind);
  if (bounds) event.bounds = structuredClone(bounds);
  if (data && Object.keys(data).length) event.data = structuredClone(data);
  return event;
}

export function buildRevisionCheckpoint({
  version,
  appliedCritiques = [],
  result,
  createdFromEventIds = [],
  beforeSnapshot = null,
  afterSnapshot = null,
  beforeScreenshot = null,
  afterScreenshot = null,
}) {
  const delta = structuredClone(result?.recommendationDelta || {
    kept: [],
    updated: [],
    removed: [],
    added: [],
    changedTargets: [],
  });
  const applicationOrder = [...(result?.applicationOrder || [])];
  const changedTargets = [...new Set([
    ...(result?.changedTargets || []),
    ...(delta.changedTargets || []),
  ])];
  const count = applicationOrder.length;

  return {
    id: Number(version),
    kind: "revision",
    label: `Checkpoint ${version} · ${count} ${count === 1 ? "Change" : "Changes"} Applied`,
    note: "Validated After Re-evaluation",
    appliedRecommendationIds: applicationOrder,
    appliedRecommendations: appliedCritiques.map((critique) => ({
      id: critique.id,
      title: critique.title,
      dimension: critique.dimension,
      suggestion: critique.suggestion,
      target: critique.tileId || "dashboard",
    })),
    applicationOrder,
    recommendationDelta: delta,
    changedTargets,
    evaluationReport: structuredClone(result?.evaluationReport || null),
    createdFromEventIds: [...createdFromEventIds],
    beforeSnapshot: beforeSnapshot ? structuredClone(beforeSnapshot) : null,
    afterSnapshot: afterSnapshot ? structuredClone(afterSnapshot) : null,
    beforeScreenshot: beforeScreenshot || null,
    afterScreenshot: afterScreenshot || null,
  };
}

export function createWorkingDraft(baseCheckpointId = 1) {
  return {
    baseCheckpointId: Number(baseCheckpointId) || 1,
    dirty: false,
    appliedCritiques: [],
    applicationOrder: [],
    changedTargets: [],
    createdFromEventIds: [],
    beforeSnapshot: null,
    afterSnapshot: null,
    beforeScreenshot: null,
    evaluationReport: null,
    recommendationDelta: {
      kept: [],
      updated: [],
      removed: [],
      added: [],
      changedTargets: [],
    },
  };
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export function recordWorkingDraftApplication(draft, {
  appliedCritiques = [],
  result,
  beforeSnapshot = null,
  afterSnapshot = null,
  beforeScreenshot = null,
  createdFromEventIds = [],
}) {
  const next = structuredClone(draft || createWorkingDraft());
  const existingCritiques = new Map(
    (next.appliedCritiques || []).map((critique) => [critique.id, critique]),
  );

  next.dirty = true;
  const committedIds = Array.isArray(result?.applicationOrder)
    ? unique(result.applicationOrder)
    : unique(appliedCritiques.map((critique) => critique.id));
  const committedCritiques = appliedCritiques.filter((critique) => committedIds.includes(critique.id));
  committedCritiques.forEach((critique) => existingCritiques.set(critique.id, structuredClone(critique)));

  next.appliedCritiques = [...existingCritiques.values()];
  next.applicationOrder = unique([
    ...(next.applicationOrder || []),
    ...committedIds,
  ]);
  next.changedTargets = unique([
    ...(next.changedTargets || []),
    ...(result?.changedTargets || []),
    ...(result?.recommendationDelta?.changedTargets || []),
  ]);
  next.createdFromEventIds = unique([
    ...(next.createdFromEventIds || []),
    ...createdFromEventIds,
  ]);
  next.beforeSnapshot = next.beforeSnapshot || (beforeSnapshot ? structuredClone(beforeSnapshot) : null);
  next.beforeScreenshot = next.beforeScreenshot || beforeScreenshot || null;
  next.afterSnapshot = afterSnapshot ? structuredClone(afterSnapshot) : next.afterSnapshot;
  next.evaluationReport = structuredClone(result?.evaluationReport || next.evaluationReport);
  next.recommendationDelta = structuredClone(result?.recommendationDelta || next.recommendationDelta);
  return next;
}

/** Preserve the critique semantics that gave an author's rationale meaning.
 * This is a point-in-time snapshot: later critique regeneration may replace the
 * live critique, but preference synthesis still needs to know what issue,
 * recommendation, and dashboard target the author was responding to. */
export function createCritiqueContextSnapshot(critique = {}) {
  const proposalKind = normalized(critique?.proposal?.kind);
  const snapshot = {
    id: normalized(critique?.id),
    title: normalized(critique?.title),
    issue: normalized(critique?.issue),
    rationale: normalized(critique?.rationale),
    suggestion: normalized(critique?.suggestion),
    dimension: normalized(critique?.dimension),
  };
  if (critique?.tileId) snapshot.targetTileId = normalized(critique.tileId);
  else if (critique?.tileId === null) snapshot.targetTileId = "dashboard";
  if (critique?.target) snapshot.target = structuredClone(critique.target);
  if (proposalKind) snapshot.proposalKind = proposalKind;
  if (critique?.object) snapshot.object = normalized(critique.object);
  if (critique?.problem) snapshot.problem = normalized(critique.problem);
  if (critique?.recommendation) snapshot.recommendation = normalized(critique.recommendation);
  if (critique?.evidence) snapshot.evidence = normalized(critique.evidence);
  if (Array.isArray(critique?.judgmentBasis)) {
    snapshot.judgmentBasis = critique.judgmentBasis.map(normalized).filter(Boolean);
  }
  if (critique?.reviewScope) snapshot.reviewScope = normalized(critique.reviewScope);
  if (critique?.reviewRequest) snapshot.reviewRequest = normalized(critique.reviewRequest);
  return snapshot;
}

export function createCritiqueRationale({
  id,
  critiqueId,
  critiqueTitle,
  dimension,
  critique,
  dashboardVersion,
  text,
  createdAt,
}) {
  const critiqueContext = createCritiqueContextSnapshot(critique || {
    id: critiqueId,
    title: critiqueTitle,
    dimension,
  });
  return {
    id: normalized(id),
    critiqueId: critiqueContext.id,
    critiqueTitle: critiqueContext.title,
    dimension: critiqueContext.dimension,
    text: normalized(text),
    critiqueContext,
    dashboardVersion: Number(dashboardVersion) || 1,
    createdAt: normalized(createdAt),
    updatedAt: normalized(createdAt),
  };
}

export function upsertCritiqueRationale(rationales = [], rationale) {
  const normalizedRationale = {
    ...structuredClone(rationale),
    text: normalized(rationale?.text),
  };
  const index = rationales.findIndex((item) => item.id === normalizedRationale.id);
  if (index < 0) return [...structuredClone(rationales), normalizedRationale];
  const next = structuredClone(rationales);
  next[index] = {
    ...next[index],
    ...normalizedRationale,
    updatedAt: normalizedRationale.updatedAt || next[index].updatedAt,
  };
  return next;
}

function includesText(current, suggestion) {
  return normalized(current).toLowerCase().includes(normalized(suggestion).toLowerCase());
}

function suggestionIsSaved(context, suggestion) {
  const text = normalized(suggestion?.text);
  if (!text) return true;
  if (suggestion?.field === "notes") {
    return (context?.notes || []).some((note) =>
      normalized(note).toLowerCase() === text.toLowerCase());
  }
  return includesText(context?.[suggestion?.field], text);
}

export function mergePendingContextSuggestions(
  previous = [],
  incoming = [],
  resolved = [],
  context = {},
) {
  const resolvedIds = new Set(resolved.map((item) => normalized(item?.id)).filter(Boolean));
  const resolvedTexts = new Set(
    resolved.map((item) => normalized(item?.text).toLowerCase()).filter(Boolean),
  );
  const keep = (suggestion) => {
    const text = normalized(suggestion?.text);
    return text &&
      !resolvedIds.has(normalized(suggestion?.id)) &&
      !resolvedTexts.has(text.toLowerCase()) &&
      !suggestionIsSaved(context, suggestion);
  };
  const merged = previous.filter(keep).map((item) => structuredClone(item));
  incoming.filter(keep).forEach((suggestion) => {
    const key = `${suggestion.field}:${normalized(suggestion.text).toLowerCase()}`;
    const index = merged.findIndex((item) =>
      (suggestion.id && item.id === suggestion.id) ||
      `${item.field}:${normalized(item.text).toLowerCase()}` === key);
    if (index >= 0) merged[index] = structuredClone(suggestion);
    else merged.push(structuredClone(suggestion));
  });
  return merged;
}

export function mergeSuggestionIntoContext(context, suggestion, editedText = suggestion?.text) {
  const next = structuredClone(context || {});
  const text = normalized(editedText);
  if (!text) return next;

  if (suggestion.field === "notes") {
    next.notes = Array.isArray(next.notes) ? [...next.notes] : [];
    if (!next.notes.some((note) => normalized(note).toLowerCase() === text.toLowerCase())) {
      next.notes.push(text);
    }
    return next;
  }

  const current = normalized(next[suggestion.field]);
  if (!current) {
    next[suggestion.field] = text;
  } else if (!includesText(current, text)) {
    const separator = suggestion.field === "audience" ? " · " : "\n";
    next[suggestion.field] = `${current}${separator}${text}`;
  }
  return next;
}
