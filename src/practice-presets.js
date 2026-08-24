export const PRACTICE_PRESET_VERSION = "2026-08-24.1";

const clone = (value) => structuredClone(value);

function baseCritique({
  id,
  dimension,
  object,
  problem,
  title,
  issue,
  suggestion,
  rationale,
  evidence,
  priority = "medium",
  tileId = null,
  proposal,
  target,
  answer = null,
  requestRelevance = null,
}) {
  return {
    id,
    dimension,
    object,
    problem,
    recommendation: `${dimension}:support the dashboard task`,
    priority,
    surface: proposal.kind === "edit-layout" ? "layout" : tileId ? "encoding" : "dashboard",
    tileId,
    title,
    issue,
    suggestion,
    rationale,
    evidence,
    judgmentBasis: ["dashboard evidence", "confirmed task"],
    requiredContext: ["analytical_task"],
    contextStatus: "available",
    evidenceRefs: [{
      source: "dashboard",
      path: tileId ? `tile.${tileId}` : "board.title",
      ...(tileId ? { tileId } : {}),
      detail: evidence,
    }],
    proposal: { mode: "executable", ...proposal },
    target: target || (tileId
      ? { granularity: "chart", ref: { tile: tileId } }
      : { granularity: "dashboard", ref: {} }),
    ...(answer ? { answer } : {}),
    ...(requestRelevance ? { requestRelevance } : {}),
  };
}

const A_FULL = [
  baseCritique({
    id: "practice-a-axis-title",
    dimension: "text",
    object: "axis label",
    problem: "unclear | ambiguous",
    title: "Clarify the ranking measure",
    issue: "The ranking axis uses a short measure label that is easy to skim past during comparison.",
    suggestion: "Name the measure as average birds observed per garden.",
    rationale: "A more explicit label makes the basis of the bird ranking immediately legible.",
    evidence: "The birds-ranking x-axis is the primary quantitative comparison in the dashboard.",
    priority: "high",
    tileId: "birds-ranking",
    proposal: {
      kind: "edit-spec",
      edits: [{ op: "set", path: ["encoding", "x", "axis", "title"], value: "Average birds observed per garden" }],
    },
  }),
  baseCritique({
    id: "practice-a-trend-points",
    dimension: "chart",
    object: "chart",
    problem: "difficult to read precisely",
    title: "Make sampled years easier to inspect",
    issue: "The trend lines emphasize direction, but the sampled observation years are comparatively quiet.",
    suggestion: "Increase the point emphasis on the three bird trend lines.",
    rationale: "Visible points make the discrete observation years easier to compare without changing the chart form.",
    evidence: "The population-trend chart contains five sampled years per series.",
    tileId: "population-trend",
    proposal: {
      kind: "edit-spec",
      edits: [{ op: "set", path: ["mark", "point"], value: { filled: true, size: 82 } }],
    },
  }),
  baseCritique({
    id: "practice-a-fact-emphasis",
    dimension: "visual design",
    object: "annotation",
    problem: "dominates the hierarchy",
    title: "Reduce the fact callout’s visual weight",
    issue: "The −50% callout competes with the analytical charts for first attention.",
    suggestion: "Reduce the callout number slightly so it remains prominent without overpowering the trends.",
    rationale: "The supporting fact should reinforce the analysis rather than become the dashboard’s only focal point.",
    evidence: "The did-you-know tile uses a 74px display number beside much smaller analytical marks.",
    tileId: "did-you-know",
    proposal: {
      kind: "edit-spec",
      edits: [{ op: "set", path: ["layer", 0, "mark", "fontSize"], value: 62 }],
    },
  }),
];

const B_FULL = [
  baseCritique({
    id: "practice-b-trend-points",
    dimension: "chart",
    object: "chart",
    problem: "difficult to read precisely",
    title: "Expose each monthly observation",
    issue: "The monthly revenue line communicates direction but hides the six individual observation points.",
    suggestion: "Add compact points to the monthly revenue line.",
    rationale: "Points make month-by-month inspection easier while preserving the trend view.",
    evidence: "The revenue-trend mark currently disables points even though the x-axis contains six discrete months.",
    priority: "high",
    tileId: "revenue-trend",
    proposal: {
      kind: "edit-spec",
      edits: [{ op: "set", path: ["mark", "point"], value: { filled: true, size: 70 } }],
    },
  }),
  baseCritique({
    id: "practice-b-category-labels",
    dimension: "text",
    object: "axis label",
    problem: "crowded",
    title: "Give category labels more room",
    issue: "The compact category chart leaves little room for longer category names.",
    suggestion: "Angle the category labels slightly and increase their size.",
    rationale: "A modest angle preserves the chart footprint while making labels easier to scan.",
    evidence: "The category-mix chart is only 410px wide and places multiple category labels on the x-axis.",
    tileId: "category-mix",
    proposal: {
      kind: "edit-spec",
      edits: [
        { op: "set", path: ["encoding", "x", "axis", "labelAngle"], value: -18 },
        { op: "set", path: ["encoding", "x", "axis", "labelFontSize"], value: 12 },
      ],
    },
  }),
  baseCritique({
    id: "practice-b-region-color",
    dimension: "color",
    object: "color",
    problem: "overly saturated",
    title: "Quiet the regional ranking color",
    issue: "The regional bar chart uses a saturated blue that competes with the KPI band and controls.",
    suggestion: "Use a quieter blue for the regional bars.",
    rationale: "A restrained chart color keeps the command-center hierarchy focused on the values.",
    evidence: "The region-performance bars use the same strong accent family as interactive controls.",
    tileId: "region-performance",
    proposal: {
      kind: "edit-spec",
      edits: [{ op: "set", path: ["mark", "color"], value: "#315f91" }],
    },
  }),
];

const PRESETS = {
  A: {
    materialCode: "A",
    context: "Compare common garden-bird sightings and long-term population changes so a general audience can understand which species are thriving or declining.",
    editedContext: "Compare common garden-bird sightings with long-term population change, emphasizing which familiar species are thriving or declining.",
    audience: "A general audience interested in UK garden birds.",
    document: {
      filename: "A_bbc-gel-infographics.pdf",
      constraints: [
        { id: "practice-a-rule-1", category: "Hierarchy", rule: "Use a clear visual hierarchy that leads with the main comparison." },
        { id: "practice-a-rule-2", category: "Text", rule: "Keep explanatory text concise and readable at the displayed size." },
      ],
    },
    full: { critiques: A_FULL, answer: null },
    focused: {
      request: "Should I change the layout?",
      answer: "Yes. The current split gives the ranking most of the canvas while the two supporting views feel compressed. A more balanced two-column composition would make the ranking and trend easier to compare.",
      critiques: [baseCritique({
        id: "practice-a-layout",
        dimension: "layout",
        object: "layout",
        problem: "unbalanced",
        title: "Balance the ranking and trend columns",
        issue: "The ranking dominates the composition and the supporting trend is comparatively compressed.",
        suggestion: "Use a slightly wider right column and align both analytical regions to a consistent gutter.",
        rationale: "A more balanced composition supports comparison between current sightings and long-term change.",
        evidence: "The ranking occupies most of the analytical width while the trend and fact share a narrower column.",
        priority: "high",
        proposal: {
          kind: "edit-layout",
          composition: "balanced-two-column",
          layoutByTile: {
            "birds-ranking": { x: 228, y: 144, w: 396, h: 560 },
            "population-trend": { x: 648, y: 144, w: 424, h: 268 },
            "did-you-know": { x: 648, y: 436, w: 424, h: 268 },
          },
        },
        answer: "A more balanced two-column layout would improve comparison.",
        requestRelevance: "direct",
      })],
    },
    local: {
      request: "Is this title clear enough?",
      answer: "It identifies the subject, but it does not tell readers that the dashboard combines current sightings with long-term population trends. A more specific title would better set expectations.",
      title: "UK Garden Bird Sightings and Population Trends",
    },
    singleCritiqueId: "practice-a-axis-title",
    batchCritiqueIds: ["practice-a-trend-points", "practice-a-fact-emphasis"],
  },
  B: {
    materialCode: "B",
    context: "Help retail leaders compare revenue performance across regions, months, and product categories so they can identify where results differ and where to investigate.",
    editedContext: "Help retail leaders compare revenue across regions, months, and product categories, emphasizing where performance differs and needs follow-up.",
    audience: "Retail leaders monitoring regional and category performance.",
    document: {
      filename: "B_tableau-dashboard-best-practices.pdf",
      constraints: [
        { id: "practice-b-rule-1", category: "Layout", rule: "Keep related KPIs and charts aligned to a consistent dashboard grid." },
        { id: "practice-b-rule-2", category: "Interaction", rule: "Make filtering state visible and keep controls close to the views they affect." },
      ],
    },
    full: { critiques: B_FULL, answer: null },
    focused: {
      request: "Should I change the layout?",
      answer: "Yes. The regional chart is substantially larger than the two supporting charts, which makes the monthly and category comparisons feel secondary. A more balanced analytical area would improve scan order.",
      critiques: [baseCritique({
        id: "practice-b-layout",
        dimension: "layout",
        object: "layout",
        problem: "unbalanced",
        title: "Balance regional and temporal analysis",
        issue: "The regional ranking dominates the lower dashboard while the monthly and category views are narrow.",
        suggestion: "Reduce the regional chart width and give the two supporting charts more horizontal room.",
        rationale: "The three analytical views then read as one coordinated decision surface rather than a primary chart with two afterthoughts.",
        evidence: "The region-performance chart is 610px wide while each supporting chart is 410px wide.",
        priority: "high",
        proposal: {
          kind: "edit-layout",
          composition: "balanced-analysis-grid",
          layoutByTile: {
            "region-performance": { x: 28, y: 288, w: 520, h: 456 },
            "revenue-trend": { x: 572, y: 288, w: 500, h: 222 },
            "category-mix": { x: 572, y: 534, w: 500, h: 210 },
          },
        },
        answer: "A more balanced analytical grid would improve scan order.",
        requestRelevance: "direct",
      })],
    },
    local: {
      request: "Is this title clear enough?",
      answer: "It signals a monitoring dashboard, but it does not name the primary comparisons. A title that mentions region and time would orient readers more quickly.",
      title: "Retail Sales Performance by Region and Month",
    },
    singleCritiqueId: "practice-b-trend-points",
    batchCritiqueIds: ["practice-b-category-labels", "practice-b-region-color"],
  },
};

function localCritique(preset, bounds) {
  return baseCritique({
    id: `practice-${preset.materialCode.toLowerCase()}-title`,
    dimension: "text",
    object: "dashboard title",
    problem: "unclear | ambiguous",
    title: "Make the dashboard title more specific",
    issue: "The current title names the topic but not the comparison the dashboard supports.",
    suggestion: `Use “${preset.local.title}”.`,
    rationale: "A task-specific title helps readers understand the dashboard before they inspect individual charts.",
    evidence: "The selected title region contains a broad dashboard name without the primary comparison.",
    priority: "high",
    proposal: { kind: "dashboard-title", label: preset.local.title },
    target: { granularity: "selected-region", ref: { selectedBounds: clone(bounds) } },
    answer: preset.local.answer,
    requestRelevance: "direct",
  });
}

export function practicePresetForMaterial(materialCode) {
  const preset = PRESETS[String(materialCode || "").toUpperCase()];
  return preset ? clone(preset) : null;
}

export function practiceReviewResponse(preset, { scope = "full", bounds = null } = {}) {
  if (!preset) throw new Error("Practice preset is unavailable for this material.");
  const source = scope === "focused" ? preset.focused : scope === "local"
    ? { critiques: [localCritique(preset, bounds || { x: 0, y: 0, w: 1, h: 1 })], answer: preset.local.answer }
    : preset.full;
  return {
    reviewScope: scope === "local" ? "selected-region" : scope,
    critiques: clone(source.critiques || []),
    strengths: [],
    answer: source.answer || null,
    model: "vizier-practice-preset",
    promptVersion: "practice-preset-v1",
    engineVersion: "practice-preset-runtime-v1",
    registryVersion: PRACTICE_PRESET_VERSION,
    fewShotSetId: "practice-tutorial",
    fewShotVersion: PRACTICE_PRESET_VERSION,
    fewShotIds: [`practice-${preset.materialCode.toLowerCase()}-${scope}`],
    runId: `preset-${preset.materialCode.toLowerCase()}-${scope}`,
  };
}

function setAtPath(root, path, value) {
  if (!root || !Array.isArray(path) || !path.length) return;
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path.at(-1)] = clone(value);
}

export function buildPracticeApplyResult({ critiques, selectedIds, specMap, board }) {
  const nextSpecMap = clone(specMap || {});
  const nextBoard = clone(board || {});
  const byId = new Map((critiques || []).map((critique) => [critique.id, critique]));
  const applicationOrder = selectedIds.filter((id) => byId.has(id));
  const changedTargets = new Set();

  applicationOrder.forEach((id) => {
    const critique = byId.get(id);
    const proposal = critique.proposal || {};
    if (proposal.kind === "edit-spec" && critique.tileId && nextSpecMap[critique.tileId]) {
      (proposal.edits || []).forEach((edit) => {
        if (edit.op === "set") setAtPath(nextSpecMap[critique.tileId], edit.path, edit.value);
      });
      changedTargets.add(critique.tileId);
      changedTargets.add(`tile:${critique.tileId}.spec`);
    } else if (proposal.kind === "edit-layout") {
      const layout = proposal.layoutByTile || {};
      if (Array.isArray(nextBoard.tiles)) {
        nextBoard.tiles = nextBoard.tiles.map((tile) => layout[tile.id]
          ? { ...tile, bounds: clone(layout[tile.id]) }
          : tile);
      }
      changedTargets.add("dashboard.layout");
    } else if (proposal.kind === "dashboard-title" && proposal.label) {
      nextBoard.title = proposal.label;
      changedTargets.add("dashboard.title");
    }
  });

  return {
    specMap: nextSpecMap,
    board: nextBoard,
    applicationOrder,
    changedTargets: [...changedTargets],
    recommendationDelta: { kept: [], updated: [], removed: [], added: [] },
    evaluationReport: {
      compiled: true,
      remainingFindings: Math.max(0, (critiques || []).length - applicationOrder.length),
    },
    critiqueStatuses: applicationOrder.map((id) => ({ id, status: "resolved" })),
    addedCritiques: [],
    unresolvedConflicts: [],
    rollback: { rolledBack: false, reason: null },
  };
}
