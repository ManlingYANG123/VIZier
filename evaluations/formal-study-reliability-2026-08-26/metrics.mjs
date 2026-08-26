const LAYOUT_KINDS = new Set(["edit-layout", "add-kpis", "recompose-kpis"]);

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function summarize(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { n: 0, mean: null, min: null, max: null };
  return {
    n: finite.length,
    mean: mean(finite),
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

export function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / union.size;
}

function targetIds(critique) {
  return [
    critique?.tileId,
    critique?.target?.ref?.tile,
    critique?.target?.ref?.source,
    ...(Array.isArray(critique?.target?.ref?.tiles) ? critique.target.ref.tiles : []),
    ...(Array.isArray(critique?.target?.ref?.targets) ? critique.target.ref.targets : []),
    ...(Array.isArray(critique?.proposal?.layout)
      ? critique.proposal.layout.map((entry) => entry?.tile)
      : []),
  ].map(clean).filter(Boolean);
}

/**
 * Stable recommendation identity. Catalogued critiques use their exact leaf id.
 * Uncatalogued critiques fall back to the diagnosed object/problem/branch tuple,
 * so they are not silently dropped from the overlap denominator.
 */
export function recommendationKey(critique) {
  const recommendation = clean(critique?.recommendation);
  if (recommendation) return `leaf:${recommendation}`;
  const object = clean(critique?.object) || "unknown-object";
  const problem = clean(critique?.problem) || "no-problem";
  const dimension = clean(critique?.dimension) || "other";
  return `uncatalogued:${object}|${problem}|${dimension}`;
}

export function proposalKinds(run) {
  return (run?.response?.critiques || [])
    .map((critique) => clean(critique?.proposal?.kind) || "missing-kind");
}

export function recommendationKeys(run) {
  return (run?.response?.critiques || []).map(recommendationKey);
}

function pathString(path) {
  return (Array.isArray(path) ? path : [path])
    .map((segment) => String(segment))
    .join(".");
}

/**
 * Extract explicit JSON edit paths plus canonical target paths for deterministic
 * proposal kinds whose changes live outside proposal.edits (layout, title,
 * filters, interaction wiring, palette, KPI composition, and subtitles).
 */
export function critiqueEditPaths(critique) {
  const proposal = critique?.proposal || {};
  const kind = clean(proposal.kind) || "missing-kind";
  const targets = targetIds(critique);
  const primary = targets[0] || "dashboard";
  const paths = [];

  for (const edit of proposal.edits || []) {
    paths.push(`${primary}:spec.${pathString(edit?.path || [])}`);
  }
  for (const entry of proposal.layout || []) {
    if (!entry?.tile) continue;
    paths.push(`${clean(entry.tile)}:board.bounds`);
  }

  const canonical = {
    "dashboard-title": ["dashboard:board.title"],
    "chart-subtitles": targets.length
      ? targets.map((id) => `${id}:board.hasSubtitle`)
      : ["dashboard:board.tiles.hasSubtitle"],
    "edit-layout": targets.map((id) => `${id}:board.bounds`),
    "add-kpis": ["dashboard:board.kpis", "dashboard:board.kpiLayout"],
    "recompose-kpis": ["dashboard:board.kpiLayout"],
    "v2-palette": targets.length
      ? targets.map((id) => `${id}:spec.encoding.color.scale.range`)
      : ["dashboard:spec.encoding.color.scale.range"],
    "preserve-brand-palette": targets.length
      ? targets.map((id) => `${id}:spec.encoding.color.scale.range`)
      : ["dashboard:spec.encoding.color.scale.range"],
    "wire-filter-control": [`dashboard:board.filters.${clean(proposal.filterId) || "filter"}.wired`],
    "add-tooltip": [`${primary}:spec.encoding.tooltip`],
    "add-cross-filter": [
      `${primary}:spec.params.selection`,
      ...targets.slice(1).map((id) => `${id}:spec.transform.filter`),
    ],
    "show-filter-state": [`${primary}:spec.encoding.state`],
  }[kind] || [];
  paths.push(...canonical);

  // Every proposal still gets one target-sensitive address. This prevents two
  // same-kind fixes on unrelated charts from being counted as identical edits.
  if (!paths.length) paths.push(`${primary}:proposal.${kind}`);
  return [...new Set(paths.map(clean).filter(Boolean))];
}

export function editPaths(run) {
  return (run?.response?.critiques || []).flatMap(critiqueEditPaths);
}

export function isLayoutComposition(critique) {
  const proposal = critique?.proposal || {};
  const kind = clean(proposal.kind);
  return LAYOUT_KINDS.has(kind)
    || Boolean(proposal.composition)
    || Boolean(proposal.kpiLayout)
    || (Array.isArray(proposal.layout) && proposal.layout.length > 0)
    || (proposal.edits || []).some((edit) => /(?:^|\.)(?:width|height|spacing|facet|concat)(?:\.|$)/i.test(pathString(edit?.path || [])));
}

export function isExecutable(critique) {
  return critique?.proposal?.mode === "executable";
}

export function pairwise(runs, accessor) {
  const pairs = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      pairs.push({
        left: runs[i].runNumber,
        right: runs[j].runNumber,
        value: jaccard(accessor(runs[i]), accessor(runs[j])),
      });
    }
  }
  return pairs;
}

export function crossPairs(leftRuns, rightRuns, accessor) {
  return leftRuns.flatMap((left) => rightRuns.map((right) => ({
    left: `${left.dashboardCode}-${left.runNumber}`,
    right: `${right.dashboardCode}-${right.runNumber}`,
    value: jaccard(accessor(left), accessor(right)),
  })));
}

export function frequency(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function analyzeDashboard(runs) {
  const critiques = runs.flatMap((run) => run.response?.critiques || []);
  const kindPairs = pairwise(runs, proposalKinds);
  const recommendationPairs = pairwise(runs, recommendationKeys);
  const editPairs = pairwise(runs, editPaths);
  const kindMean = mean(kindPairs.map((pair) => pair.value));
  const recommendationMean = mean(recommendationPairs.map((pair) => pair.value));
  const editMean = mean(editPairs.map((pair) => pair.value));
  const stabilityComponents = [recommendationMean, kindMean, editMean].filter(Number.isFinite);
  const executableCount = critiques.filter(isExecutable).length;
  const layoutCount = critiques.filter(isLayoutComposition).length;

  return {
    successfulRuns: runs.length,
    critiqueCount: summarize(runs.map((run) => run.response?.critiques?.length || 0)),
    executable: {
      count: executableCount,
      total: critiques.length,
      ratio: critiques.length ? executableCount / critiques.length : null,
      byRun: runs.map((run) => {
        const items = run.response?.critiques || [];
        const count = items.filter(isExecutable).length;
        return { run: run.runNumber, count, total: items.length, ratio: items.length ? count / items.length : null };
      }),
    },
    layoutComposition: {
      count: layoutCount,
      total: critiques.length,
      ratio: critiques.length ? layoutCount / critiques.length : null,
      byRun: runs.map((run) => {
        const items = run.response?.critiques || [];
        const count = items.filter(isLayoutComposition).length;
        return { run: run.runNumber, count, total: items.length, ratio: items.length ? count / items.length : null };
      }),
    },
    proposalKindFrequency: frequency(critiques.map((critique) => clean(critique?.proposal?.kind) || "missing-kind")),
    recommendationFrequency: frequency(critiques.map(recommendationKey)),
    withinDashboard: {
      proposalKindSimilarity: { ...summarize(kindPairs.map((pair) => pair.value)), pairs: kindPairs },
      recommendationOverlap: { ...summarize(recommendationPairs.map((pair) => pair.value)), pairs: recommendationPairs },
      editPathSimilarity: { ...summarize(editPairs.map((pair) => pair.value)), pairs: editPairs },
      stabilityIndex: stabilityComponents.length ? mean(stabilityComponents) : null,
      stabilityFormula: "mean(recommendation overlap, proposal-kind Jaccard, edit-path Jaccard)",
    },
  };
}

