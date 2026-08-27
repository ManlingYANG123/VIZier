export function revisionDisplayLabel(version, { includeApplied = false } = {}) {
  if (version.kind !== "revision") return `Checkpoint ${version.id} · Original Dashboard`;
  if (version.purpose === "round_complete") {
    return version.label || `Checkpoint ${version.id} · Previous Round Complete`;
  }
  const count = version.appliedRecommendations?.length || version.applicationOrder?.length || 0;
  const noun = count === 1 ? "Change" : "Changes";
  return `Checkpoint ${version.id} · ${count} ${noun}${includeApplied ? " Applied" : ""}`;
}

export function checkpointSelectionForClick({
  comparison,
  clickedId,
  orderedIds,
  lastSelectedId,
}) {
  const ids = [...new Set(orderedIds)].filter((id) => Number.isFinite(id));
  if (!ids.length) return { before: null, after: null };

  const fallbackBefore = ids.includes(comparison?.before) ? comparison.before : ids[0];
  const fallbackAfter = ids.includes(comparison?.after) ? comparison.after : fallbackBefore;
  if (!ids.includes(clickedId)) {
    return { before: fallbackBefore, after: fallbackAfter };
  }
  if (ids.length === 1) return { before: clickedId, after: clickedId };

  const hasPair = fallbackBefore !== fallbackAfter;
  if (hasPair && (clickedId === fallbackBefore || clickedId === fallbackAfter)) {
    return { before: clickedId, after: clickedId };
  }

  const anchor = hasPair && ids.includes(lastSelectedId) && lastSelectedId !== clickedId
    ? lastSelectedId
    : fallbackAfter;
  if (anchor === clickedId) return { before: clickedId, after: clickedId };

  const anchorIndex = ids.indexOf(anchor);
  const clickedIndex = ids.indexOf(clickedId);
  return anchorIndex <= clickedIndex
    ? { before: anchor, after: clickedId }
    : { before: clickedId, after: anchor };
}
