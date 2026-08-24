import embed from "vega-embed";
import "./styles.css";
import {
  buildApplicationPlan,
  enrichRecommendations,
  relationshipSummary,
  retainRecommendationFreshness,
} from "./recommendation-engine.js";
import {
  extractConstraints,
  inferContext,
  listDashboardLibrary,
  loadDashboardFromLibrary,
  streamCritique,
  streamApply,
  structureBrief,
  tracePanel,
} from "./api-client.js";
import {
  ACCEPTED_DESIGN_DOC,
  buildConstraintSource,
  extractDesignDocText,
  isSupportedDesignDoc,
} from "./intake-client.js";
import {
  buildRevisionCheckpoint,
  createCritiqueContextSnapshot,
  createCritiqueRationale,
  createJournalEvent,
  createWorkingDraft,
  isStrongInteractionEvent,
  mergePendingContextSuggestions,
  mergeSuggestionIntoContext,
  recordWorkingDraftApplication,
  strongInteractionEventCount,
  upsertCritiqueRationale,
} from "./interaction-journal.js";
import {
  RESEARCHER_ANNOTATION_KINDS,
  STUDY_APP_VERSION,
  STUDY_PHASES,
  STUDY_STORAGE_KEY,
  bindStudyContext,
  buildStudyBundle,
  buildStudyDashboardArtifacts,
  discardStudySession,
  endStudySession,
  exportStudyBackupZip,
  isStudyActive,
  bumpStudyContextVersion,
  newStudyId,
  recordResearcherAnnotation,
  recordStudyAction,
  recordStudyEvent,
  restoreStudySession,
  saveStudySessionToServer,
  setStudyPhase,
  startStudySession,
  stashStudyTaskCapture,
  stripVersionMedia,
  studyEventLog,
  studySessionInfo,
  takeStudyRequestLink,
} from "./study-session.js";
import {
  CATEGORY_COLORS as COLORS,
  CATEGORY_ORDER,
  CATEGORY_PRESENTATIONS,
  CLUSTER_ORDER,
  SCOPE_CLUSTERS,
  categoryPresentation,
  clusterForDimension,
  clusterPresentation,
  customScopeKey,
  customScopePresentation,
  feedbackScopeFiltersDimension,
  scopeMatchesDimension,
} from "./category-color-system.js";
import {
  checkpointSelectionForClick,
  revisionDisplayLabel,
} from "./revision-preview.js";
import {
  applySourceSelectionState,
  applyTargetFilterState,
  applyDashboardFilterState,
  buildInteractionScenario,
  dashboardDocumentFromSnapshot,
  normalizeDashboardDocument,
} from "./vega-dashboard-adapter.js";
import {
  PANEL_LAYOUT_STORAGE_KEY,
  PANEL_RESIZE_STEP,
  REVISION_DOCK_HEIGHT_STORAGE_KEY,
  REVISION_DOCK_RESIZE_STEP,
  clampPanelWidth,
  clampRevisionDockHeight,
  panelWidthBounds,
  panelWidthFromKey,
  panelWidthFromPointer,
  revisionDockHeightBounds,
  revisionDockHeightFromKey,
  revisionDockHeightFromPointer,
} from "./panel-resize.js";
import {
  CONTEXT_EXTRACTION_HINTS,
  CONTEXT_WORKFLOW_STATUS,
  contextFingerprint,
  contextIsConfirmed,
  contextWorkflowPresentation,
  createContextWorkflow,
} from "./context-workflow.js";
import {
  DECIDED_STATUSES,
  critiqueRefreshRequest,
  groupCritiquesByAsk,
  isDecidedCritique,
  mergeAskResults,
  pickCritiqueRefreshReplacement,
} from "./critique-merge.js";
import {
  CONTEXT_BOX_FIELDS,
  CONTEXT_BOX_PLACEHOLDER,
  parseContextBox,
  serializeContextBox,
} from "./context-box.js";

const DEFAULT_FEEDBACK_SCOPE = [...CATEGORY_ORDER];

// Clear any stale localStorage/sessionStorage on load to prevent state conflicts
try {
  // Keep the backend connection and user-controlled panel layout.
  const reApiBase = localStorage.getItem("reApiBase");
  const panelLayout = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
  const revisionDockHeight = localStorage.getItem(REVISION_DOCK_HEIGHT_STORAGE_KEY);
  // Preserve the in-progress study log across the reset so a refresh/crash mid
  // session does not lose research data (see study-session.js).
  const studySession = localStorage.getItem(STUDY_STORAGE_KEY);
  // Group study routes keep their phase, annotation, and questionnaire state
  // in a separate record. Preserve every group key when the VIZier workspace
  // boots for Training/Task, otherwise a refresh would return to the welcome.
  const studyRunnerEntries = Object.keys(localStorage)
    .filter((key) => key.startsWith("vizierStudyRunner:"))
    .map((key) => [key, localStorage.getItem(key)]);
  localStorage.clear();
  sessionStorage.clear();
  if (reApiBase) localStorage.setItem("reApiBase", reApiBase);
  if (panelLayout) localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, panelLayout);
  if (revisionDockHeight) {
    localStorage.setItem(REVISION_DOCK_HEIGHT_STORAGE_KEY, revisionDockHeight);
  }
  if (studySession) localStorage.setItem(STUDY_STORAGE_KEY, studySession);
  studyRunnerEntries.forEach(([key, value]) => {
    if (value != null) localStorage.setItem(key, value);
  });
  console.log("[app] Cleared stale browser storage on load");
} catch (e) {
  console.warn("[app] Could not clear storage:", e);
}

// One system-wide symbol for actions that ask the model to generate or rewrite
// content. The surrounding tooltip names the specific operation.
const AI_ACTION_ICON = `<svg class="ai-action-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 10-10"/><path d="m11.5 6.5 3 3"/><path d="M18 2v4M16 4h4M19 11v3M17.5 12.5h3"/></svg>`;
const CRITIQUE_AI_ICON = `<svg class="ai-action-glyph critique-ai-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c.65 4.85 3.15 7.35 8 8-4.85.65-7.35 3.15-8 8-.65-4.85-3.15-7.35-8-8 4.85-.65 7.35-3.15 8-8Z"/><path d="M19 3.5c.2 1.4.9 2.1 2.3 2.3-1.4.2-2.1.9-2.3 2.3-.2-1.4-.9-2.1-2.3-2.3 1.4-.2 2.1-.9 2.3-2.3Z"/></svg>`;
// Bouncing-dots indicator shown in place of the sparkle glyph while a review is
// generating. Self-contained SMIL animation; inherits the button's text color.
const MESSAGE_LOADING_ICON = `<svg class="ai-loading-glyph" width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="4" cy="12" r="2" fill="currentColor"><animate id="spinner_qFRN" begin="0;spinner_OcgL.end+0.25s" attributeName="cy" calcMode="spline" dur="0.6s" values="12;6;12" keySplines=".33,.66,.66,1;.33,0,.66,.33"/></circle><circle cx="12" cy="12" r="2" fill="currentColor"><animate begin="spinner_qFRN.begin+0.1s" attributeName="cy" calcMode="spline" dur="0.6s" values="12;6;12" keySplines=".33,.66,.66,1;.33,0,.66,.33"/></circle><circle cx="20" cy="12" r="2" fill="currentColor"><animate id="spinner_OcgL" begin="spinner_qFRN.begin+0.2s" attributeName="cy" calcMode="spline" dur="0.6s" values="12;6;12" keySplines=".33,.66,.66,1;.33,0,.66,.33"/></circle></svg>`;



const commonConfig = {
  background: null,
  autosize: { type: "fit", contains: "padding", resize: false },
  config: {
    view: { stroke: null },
    axis: {
      domain: false,
      tickSize: 0,
      labelColor: "#8b9ab2",
      labelFont: "ui-monospace",
      labelFontSize: 11,
      title: null,
      gridColor: "#edf0f5",
    },
    legend: { labelColor: "#526078", labelFontSize: 11, title: null, symbolSize: 70 },
  },
};

// ---------------------------------------------------------------------------
// Shared, department-keyed dataset. Velocity and Project Status carry a
// `department` dimension so a selection on "Tasks by Department" can genuinely
// cross-filter them. Builders return either the aggregated ("all") view or a
// single-department slice — the engine computes exact values (grounded), the
// LLM only proposes the interaction (kind: "add-cross-filter").
// ---------------------------------------------------------------------------
const DEPARTMENTS = ["Design", "Eng", "Research", "QA", "Ops"];
const DEPT_SHARE = { Design: 0.18, Eng: 0.34, Research: 0.14, QA: 0.18, Ops: 0.16 };
const STATUS_ORDER = ["On Track", "At Risk", "Blocked", "Completed"];
const STATUS_RANGE = ["#2e7356", "#dc7900", "#f14242", "#95a5bd"];

const VELOCITY_MONTHS = [
  { month: "Jan", completed: 14, target: 18 }, { month: "Feb", completed: 19, target: 18 },
  { month: "Mar", completed: 16, target: 20 }, { month: "Apr", completed: 23, target: 20 },
  { month: "May", completed: 28, target: 22 }, { month: "Jun", completed: 31, target: 25 },
  { month: "Jul", completed: 27, target: 25 },
];

const velocityByDept = [];
for (const dept of DEPARTMENTS) {
  for (const m of VELOCITY_MONTHS) {
    velocityByDept.push({
      department: dept,
      month: m.month,
      completed: Math.max(1, Math.round(m.completed * DEPT_SHARE[dept])),
      target: Math.max(1, Math.round(m.target * DEPT_SHARE[dept])),
    });
  }
}

const statusByDept = [
  { department: "Design", status: "On Track", value: 2 }, { department: "Design", status: "At Risk", value: 1 }, { department: "Design", status: "Completed", value: 1 },
  { department: "Eng", status: "On Track", value: 5 }, { department: "Eng", status: "At Risk", value: 2 }, { department: "Eng", status: "Blocked", value: 1 }, { department: "Eng", status: "Completed", value: 2 },
  { department: "Research", status: "On Track", value: 2 }, { department: "Research", status: "At Risk", value: 1 },
  { department: "QA", status: "On Track", value: 1 }, { department: "QA", status: "At Risk", value: 1 }, { department: "QA", status: "Blocked", value: 1 },
  { department: "Ops", status: "On Track", value: 1 }, { department: "Ops", status: "Blocked", value: 1 },
];

const departmentTasks = [
  { department: "Design", tasks: 34 }, { department: "Eng", tasks: 58 },
  { department: "Research", tasks: 21 }, { department: "QA", tasks: 17 }, { department: "Ops", tasks: 12 },
];

function velocityDataAll() {
  return VELOCITY_MONTHS.map((m) => {
    const rows = velocityByDept.filter((r) => r.month === m.month);
    return {
      month: m.month,
      completed: rows.reduce((a, r) => a + r.completed, 0),
      target: rows.reduce((a, r) => a + r.target, 0),
    };
  });
}
function velocityDataDept(dept) {
  return VELOCITY_MONTHS.map((m) => {
    const r = velocityByDept.find((x) => x.department === dept && x.month === m.month);
    return { month: m.month, completed: r ? r.completed : 0, target: r ? r.target : 0 };
  });
}
function statusDataAll() {
  return STATUS_ORDER
    .map((s) => ({ status: s, value: statusByDept.filter((r) => r.status === s).reduce((a, r) => a + r.value, 0) }))
    .filter((d) => d.value > 0);
}
function statusDataDept(dept) {
  return STATUS_ORDER
    .map((s) => {
      const r = statusByDept.find((x) => x.department === dept && x.status === s);
      return { status: s, value: r ? r.value : 0 };
    })
    .filter((d) => d.value > 0);
}

const tileDefinitions = [
  {
    id: "task-velocity",
    label: "Task Velocity — Completed vs. Target",
    v2Label: "Task Velocity",
    subtitle: "Monthly completed tasks vs. team target — team is trending above target since April.",
    bounds: { x: 28, y: 96, w: 508, h: 258 },
    renderer: "vega-lite",
    spec: {
      ...commonConfig,
      data: { values: velocityDataAll() },
      transform: [{ fold: ["completed", "target"], as: ["series", "value"] }],
      mark: { type: "line", point: false, strokeWidth: 2 },
      encoding: {
        x: { field: "month", type: "ordinal", sort: null },
        y: { field: "value", type: "quantitative" },
        color: { field: "series", type: "nominal", scale: { range: ["#1f3b64", "#aeb9ca"] }, legend: { orient: "top-right" } },
        strokeDash: { field: "series", scale: { domain: ["completed", "target"], range: [[1, 0], [5, 4]] }, legend: null },
      },
    },
  },
  {
    id: "department-tasks",
    label: "Tasks by Department",
    v2Label: "Tasks by Department",
    subtitle: "Engineering carries the largest share; Ops and QA are under-resourced relative to open work.",
    bounds: { x: 564, y: 96, w: 508, h: 258 },
    renderer: "vega-lite",
    spec: {
      ...commonConfig,
      data: { values: departmentTasks },
      mark: { type: "bar", cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4, color: "#23446f" },
      encoding: {
        x: { field: "department", type: "nominal", sort: null },
        y: { field: "tasks", type: "quantitative" },
        tooltip: [{ field: "department" }, { field: "tasks" }],
      },
    },
  },
  {
    id: "sprint-burndown",
    label: "Sprint Burndown — Remaining Tasks",
    v2Label: "Sprint Burndown",
    subtitle: "Remaining open tasks across the current 7-week sprint — on pace for full clearance by W8.",
    bounds: { x: 28, y: 400, w: 508, h: 272 },
    renderer: "vega-lite",
    spec: {
      ...commonConfig,
      data: { values: [
        { week: "W1", remaining: 142 }, { week: "W2", remaining: 118 },
        { week: "W3", remaining: 97 }, { week: "W4", remaining: 81 },
        { week: "W5", remaining: 60 }, { week: "W6", remaining: 44 },
        { week: "W7", remaining: 31 },
      ] },
      mark: { type: "line", point: { filled: true, size: 55 }, strokeWidth: 2.4, color: "#cc5f17" },
      encoding: {
        x: { field: "week", type: "ordinal", sort: null },
        y: { field: "remaining", type: "quantitative" },
        tooltip: [{ field: "week" }, { field: "remaining" }],
      },
    },
  },
  {
    id: "project-status",
    label: "Project Status Distribution",
    v2Label: "Project Status Distribution",
    subtitle: "Half of all projects are on track; two need immediate attention before month-end deadlines.",
    bounds: { x: 564, y: 400, w: 508, h: 272 },
    renderer: "vega-lite",
    spec: {
      ...commonConfig,
      data: { values: statusDataAll() },
      mark: { type: "arc", innerRadius: 48, outerRadius: 82, padAngle: 0.025, cornerRadius: 2 },
      encoding: {
        theta: { field: "value", type: "quantitative" },
        color: { field: "status", type: "nominal", scale: { domain: STATUS_ORDER, range: STATUS_RANGE }, legend: { orient: "right" } },
        tooltip: [{ field: "status" }, { field: "value" }],
      },
    },
  },
];

const state = {
  artifact: {
    id: null,
    source: null,
    imageUrl: null,
    hasExecutableSpecs: false,
    initial: null,
  },
  tiles: [],
  critiques: [],
  selectedCritiqueId: null,
  selectedTileId: null,
  version: 1,
  dashboardTitle: "Workspace Overview",
  dashboardSubtitle: "",
  showKpis: false,
  hasEmbeddedKpis: false,
  // Real, engine-computed KPI band (ResolvedKpi[]) — never fabricated. Empty
  // until an add-kpis proposal computes values from the dashboard's own data.
  boardKpis: [],
  boardKpiStyle: null,
  boardKpiPresentation: {
    layout: "inline-summary",
    alignment: "start",
    density: "balanced",
    chrome: "plain",
    reservedHeight: 0,
    reservedWidth: 0,
  },
  dashboardFilters: [],
  showChartSubtitles: false,
  canvasSize: { width: 1100, height: 720 },
  view: { x: 0, y: 0, scale: 0.7 },
  panning: null,
  mode: "review",
  // v2: one spatial workspace with controls placed by scope.
  // The mode only shifts emphasis and default-open drawers; it never hides the
  // canvas or critique panel, so the user can jump anywhere at any time.
  drawers: { versions: false, history: false },
  sidebarPopover: null,
  pinnedSidebarComponent: null,
  // v2: context is a living brief used throughout. First upload uses the split
  // onboarding screen; afterwards it is summoned via the left Context stage icon.
  context: {
    goal: "",
    audience: "",
    constraints: "",
    scope: [...DEFAULT_FEEDBACK_SCOPE],
    customTypes: [],
    notes: [],
    fieldStatus: { goal: "missing", audience: "missing", constraints: "missing" },
    snapshotId: null,
  },
  // Last AI-written context draft, kept so context_saved can compare generated
  // vs submitted text. Null when the author wrote context without inference.
  studyContextGenerated: null,
  contextWorkflow: createContextWorkflow(),
  // Hard design constraints parsed from an uploaded design document (brand /
  // design-guidelines PDF). Kept OUTSIDE context so it never perturbs the
  // goal/audience context snapshot; sent alongside /critique, where the engine
  // silently drops critiques that would violate these rules. null = none loaded.
  constraintSet: null,
  // Ids of the extracted rules the author kept active, curated in the design-rules
  // review popup (default: all). null = all active. The effective set sent to the
  // engine is constraintSet.constraints filtered by this (effectiveConstraintSet).
  constraintSelection: null,
  // Transient UI state for the design-doc upload control (shared by the
  // onboarding form and the persistent workspace context panel). `note` is the
  // optional author instruction that steers extraction ("use the palette here").
  designDoc: { status: "idle", filename: "", error: "", note: "", text: "" },
  lastReviewContextFingerprint: null,
  // A review request selects what the next run should answer. It intentionally
  // stays outside context so a one-off question does not become durable memory.
  reviewRequest: "",
  focusedReviewRunning: false,
  reviewInFlight: false,
  // The most recent direct answer to a focused/region ask. Surfaced in its own
  // panel so a narrow question always gets a visible response, even when the
  // engine produced no standard (grounded) critique card.
  askAnswer: null,
  contextTargetId: null,
  filters: { status: "all", source: "all", category: "all" },
  search: "",
  expandedCritiqueGroups: {},
  localReviewDraft: null,
  nextLocalReviewId: 1,
  nextAskId: 1,
  studyContextVersion: 0,
  localReviewSubmitting: false,
  versions: [{
    id: 1,
    kind: "initial",
    label: "Checkpoint 1 · Original Dashboard",
    note: "Starting Point",
  }],
  selectedVersionId: 1,
  checkpointComparison: { before: 1, after: 1 },
  workingDraft: createWorkingDraft(1),
  critiqueInspect: { critiqueId: null, openedAtMs: 0 },
  rationales: [],
  nextRationaleId: 1,
  rationaleEditId: null,
  interactionJournal: [],
  nextInteractionEventId: 1,
  preferenceAgent: {
    status: "idle",
    suggestions: [],
    resolved: [],
    error: null,
    lastAnalyzedEventCount: 0,
  },
  criterionEvaluations: [],
  // Grounded positive observations from the latest review, produced independently
  // of critiques. Rendered inline as positive cards within their dimension/topic
  // group (via strengthCardMarkup/groupCritiquesWithStrengths); empty when the
  // review surfaced nothing that genuinely stands out (never padded with filler).
  strengths: [],
  views: {},
  crossFilterEnabled: false,
  crossFilterSelection: null,
  activeFilterState: false,
  demoPlaying: false,
  // True while the post-apply "demo-then-settle" auto-play is running: an
  // interaction fix briefly demonstrates a representative filtered after-state,
  // then settles back to the honest static resting state. Guards re-render and
  // click handling during the short animation.
  settleDemoPlaying: false,
  interactionObservations: new Map(),
  previewCache: new Map(),
  // A dashboard preview is intentionally ephemeral. It renders the engine
  // result on the canvas without changing the authoritative dashboard state.
  canvasPreview: null,
  // Batch (multi-select) apply. When batchMode is on, selectable cards carry a
  // checkbox and clicking toggles selection instead of opening focus. The canvas
  // shows the combined after-state of every selected recommendation applied
  // together (via canvasPreview), so the author previews the merged result — not
  // one fix at a time. Selection resolves conflicts by deselection: a plan with
  // an unresolved conflict blocks Apply until one of the pair is unchecked.
  batchMode: false,
  batchSelection: new Set(),
  // Monotonic token guarding the async combined preview against out-of-order
  // resolution when the selection changes faster than the engine responds.
  batchPreviewToken: 0,
  reviewScope: "full",
  // Author-set model temperature for the next review, on the model's 0–1 scale
  // (0 = focused sanity check, higher = more divergent exploration). The slider
  // shows this number directly and sends it verbatim; the engine clamps it. 0.4
  // is the engine default, so an untouched control changes nothing.
  reviewTemperature: 0.4,
  // After a single-critique refresh finds the issue gone: keep the focus card
  // open with a confirmation, then return to the main list on Back to Critiques.
  critiqueRefreshNotice: null,
};

let preferenceAgentTimer = null;
let contextHintTimer = null;
let contextHintIndex = 0;

bindStudyContext(() => ({
  dashboardId: state.artifact?.id || null,
  dashboardVersion: state.version,
}));

document.querySelector("#app").innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-mark">▦</div>
      <div class="brand-title">VIZier</div>
      <div class="working-draft-status clean" id="workingDraftStatus" aria-live="polite">
        <span class="working-draft-dot" aria-hidden="true"></span>
        <span>Working Draft saved</span>
      </div>
      <div class="topbar-spacer"></div>
      <div class="top-actions">
        <button class="icon-button" id="studySessionButton" data-study-session type="button" aria-label="Study session" title="Study session">◉</button>
        <button class="icon-button" id="resetButton" aria-label="Reset demo" title="Reset demo">↺</button>
        <button class="tool-icon-button top-tool-button" data-sidebar-popover="rubric" data-tooltip="Criterion coverage" type="button" aria-label="Open criterion coverage" aria-expanded="false" aria-controls="sidebarPopoverRubric">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="m8 9 1.5 1.5L12 8M14 9h2M8 15h8"/></svg>
        </button>
        <div class="sidebar-popover global-tool-popover" id="sidebarPopoverRubric" data-popover-name="rubric" hidden>
          <div class="sidebar-popover-head"><strong>Criterion Coverage</strong><div class="sidebar-popover-actions"><button class="pin-component-button" type="button" data-pin-sidebar-component="rubric" aria-label="Pin Criterion Coverage" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 4 6 6M14 3l7 7-4 1-4 4-1 4-7-7 4-1 4-4 1-4ZM5 19l4-4"/></svg></button><button type="button" data-close-sidebar-popover aria-label="Close Criterion Coverage">×</button></div></div>
          <div class="rubric-list" id="rubricList"><div class="empty-state small">Run AI Assist to evaluate the criteria that available evidence and context support.</div></div>
        </div>
      </div>
    </header>
    <div class="workspace">
      <aside class="left-panel context-panel-fixed" id="contextPanelFixed">
        <div class="panel-header">
          <div class="panel-title-with-help">
            <h3>Context</h3>
            <button
              class="inline-help"
              type="button"
              data-help="Context changes which criteria can be evaluated. The same review engine also works when some context is missing."
              aria-label="About Context: Context changes which criteria can be evaluated; it does not select a different review mode."
            >i</button>
          </div>
        </div>
        <div class="context-panel-content" id="contextPanelContent">
          <section class="context-workflow-status" id="contextWorkflowStatus" role="status" aria-live="polite"></section>
          <div id="contextPanelBody"><div class="empty-state small">Loading context…</div></div>
        </div>
        <div class="context-confirm-footer" id="contextConfirmFooter">
          <button type="button" class="btn-save-context" id="saveContextBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span id="contextConfirmLabel">Confirm</span>
          </button>
        </div>
        <p class="visually-hidden" id="contextMemoryAnnouncement" aria-live="polite"></p>
      </aside>
      <div
        class="panel-resizer panel-resizer-left"
        id="leftPanelResizer"
        data-panel-resizer="left"
        role="separator"
        aria-label="Resize Context panel"
        aria-controls="contextPanelFixed"
        aria-orientation="vertical"
        aria-valuemin="208"
        aria-valuemax="520"
        aria-valuenow="280"
        tabindex="0"
        title="Drag or use the arrow keys to resize. Press Enter or double-click to reset."
      ></div>
      <main class="canvas-viewport" id="canvasViewport">
        <div class="canvas-action-strip" role="group" aria-label="Canvas review tools">
          <button class="local-review-button" id="localReviewButton" type="button" aria-label="Confirm context before starting a local critique" data-tooltip="Confirm context first to review an area" aria-pressed="false" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4"/><path d="m8 16 8-8M13 7l4 4"/></svg>
            <span>Select an Area</span>
          </button>
          <div class="canvas-preview-control" id="canvasPreviewControl" hidden>
            <span class="canvas-tool-divider" aria-hidden="true"></span>
            <button class="canvas-compare-toggle showing-proposed" id="canvasPreviewToggle" type="button" role="switch" aria-checked="true" aria-label="Canvas preview: proposed">
              <span class="canvas-compare-label" data-canvas-label="before">Original</span>
              <span class="canvas-compare-track" aria-hidden="true"><span class="canvas-compare-thumb"></span></span>
              <span class="canvas-compare-label active" data-canvas-label="after">Proposed</span>
            </button>
          </div>
        </div>
        <div class="annotate-hint" id="annotateHint" hidden>
          <span>Drag over the dashboard to select a review area</span>
          <button id="cancelAnnotateButton" type="button" aria-label="Cancel area selection">×</button>
        </div>
        <div class="canvas-world" id="canvasWorld">
          <div class="dashboard-artboard" id="dashboardArtboard">
            <div class="dashboard-heading"><div class="heading-line"><h1 id="dashboardTitle">Workspace Overview</h1><span>Q3 · July 2026</span></div><p id="dashboardSubtitle"></p></div>
            <div id="dashboardFilterBar" aria-label="Dashboard filters" hidden></div>
            <div class="kpi-row" id="kpiRow"></div>
            <div id="tilesLayer"></div>
            <div id="markersLayer"></div>
          </div>
        </div>
        <div class="zoom-controls">
          <button id="zoomOut" aria-label="Zoom out">−</button>
          <div class="zoom-level" id="zoomLevel">70%</div>
          <button id="zoomIn" aria-label="Zoom in">+</button>
          <button id="zoomFit" aria-label="Fit canvas">↗</button>
        </div>
        <section class="version-history revision-dock" id="revisionDock" aria-label="Saved Checkpoints">
          <div
            class="revision-dock-resizer"
            id="revisionDockResizer"
            role="separator"
            aria-label="Resize Saved Checkpoints Panel"
            aria-controls="revisionDockBody"
            aria-orientation="horizontal"
            aria-valuemin="240"
            aria-valuemax="640"
            aria-valuenow="430"
            tabindex="0"
            title="Drag vertically or use the Up and Down arrow keys to resize. Press Enter or double-click to reset."
          ></div>
          <div class="revision-dock-bar">
            <button class="revision-dock-toggle" id="revisionDockToggle" type="button" aria-expanded="false" aria-controls="revisionDockBody" title="Compare checkpoints saved at meaningful moments.">
              <span class="revision-dock-title">
                <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.8v3.5l2.4 1.4"/></svg>
                Saved Checkpoints
              </span>
              <span class="revision-dock-summary" id="revisionDockSummary">Checkpoint 1 · Original Dashboard</span>
              <span class="revision-dock-count" id="revisionDockCount">1</span>
              <svg class="revision-dock-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>
            </button>
            <div class="revision-dock-actions">
              <button class="save-checkpoint-button" id="saveCheckpointButton" type="button" disabled>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h8l2 2v9H3z"/><path d="M5 2.5v4h5v-4M5.5 10.5h5"/></svg>
                <span>Save Checkpoint</span>
              </button>
            </div>
          </div>
          <div class="revision-dock-body" id="revisionDockBody" hidden>
            <div class="version-list" id="versionList" role="group" aria-label="Revision List"></div>
            <div class="revision-detail" id="revisionDetail"></div>
          </div>
        </section>
      </main>
      <div
        class="panel-resizer panel-resizer-right"
        id="rightPanelResizer"
        data-panel-resizer="right"
        role="separator"
        aria-label="Resize Critiques panel"
        aria-controls="critiquesPanelFixed"
        aria-orientation="vertical"
        aria-valuemin="300"
        aria-valuemax="640"
        aria-valuenow="420"
        tabindex="0"
        title="Drag or use the arrow keys to resize. Press Enter or double-click to reset."
      ></div>
      <aside class="right-panel critiques-panel-fixed" id="critiquesPanelFixed">
        <div class="panel-header">
          <button class="focus-back-button" id="focusBackButton" type="button" hidden aria-label="Back to critiques">←</button>
          <div class="panel-title-with-help">
            <h3 id="critiquePanelTitle">Critiques</h3>
            <button
              class="inline-help"
              type="button"
              data-help="Run the criteria-aware review. Missing context is reported explicitly instead of switching engines."
              aria-label="About Critiques: Run the criteria-aware review over the current dashboard and confirmed context."
            >i</button>
          </div>
          <div class="critique-heading-actions" role="group" aria-label="Recommendation List Tools">
            <button class="tool-icon-button" data-sidebar-popover="search" data-tooltip="Search" type="button" aria-label="Search recommendations" aria-expanded="false" aria-controls="sidebarPopoverSearch">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
            </button>
            <button class="critique-history-button" id="critiqueHistoryToggle" data-sidebar-popover="history" type="button" aria-label="Critique History: every recommendation ever generated, grouped by the review that produced it" aria-expanded="false" aria-controls="sidebarPopoverHistory" hidden>
              <span class="critique-history-button-label">History</span>
              <span class="critique-history-count" id="critiqueHistoryCount">0</span>
            </button>
          </div>
        </div>
        <div class="critique-list-view" id="critiqueListView">
        <div class="sidebar-popover sidebar-list-popover" id="sidebarPopoverSearch" data-popover-name="search" hidden>
          <div class="sidebar-popover-head"><strong>Search</strong><div class="sidebar-popover-actions"><button type="button" data-close-sidebar-popover aria-label="Close search">×</button></div></div>
          <div class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input id="searchInput" aria-label="Search recommendations" placeholder="Search recommendations…" /></div>
        </div>
        <div class="sidebar-popover sidebar-list-popover critique-history-popover" id="sidebarPopoverHistory" data-popover-name="history" hidden>
          <div class="sidebar-popover-head"><strong>Critique History</strong><div class="sidebar-popover-actions"><button type="button" data-close-sidebar-popover aria-label="Close critique history">×</button></div></div>
          <p class="critique-history-caption">Every recommendation ever generated, grouped by the review that produced it.</p>
          <div class="critique-history-list" id="critiqueHistoryList" role="group" aria-label="Critique History List"></div>
        </div>
        <div class="generate-row">
          <div class="temp-slider" id="reviewTempControl">
            <div class="temp-slider-head">
              <span class="temp-slider-label" id="reviewTemperatureLabel">Exploration</span>
              <output class="temp-slider-value" id="reviewTemperatureValue" for="reviewTemperature">0.4</output>
              <button
                class="inline-help"
                type="button"
                data-help="How widely the model explores when drafting the next review. Lower keeps it focused and conservative, giving steadier, more repeatable results that stay on the most obvious issues. Higher lets it range further and surface less obvious possibilities. Different design stages want different settings."
                aria-label="About exploration. Lower keeps the review focused and conservative. Higher lets it range further and surface less obvious possibilities."
              >i</button>
            </div>
            <input
              class="temp-slider-input"
              id="reviewTemperature"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value="0.4"
              aria-label="Exploration (0 = focused, 1 = divergent)"
              aria-describedby="reviewTemperatureLabel"
            />
          </div>
          <button class="panel-ai-action critique-generate-button" id="aiAssistButton" type="button" aria-label="Confirm context before generating critiques" disabled>
            <span class="ai-action-title">Confirm Context First</span>
            ${CRITIQUE_AI_ICON}
            ${MESSAGE_LOADING_ICON}
          </button>
        </div>
        <!-- Engine activity streams here while a review runs, directly below the
             exploration control and generate button, then clears itself. During
             the single-critique Apply flow the list view is hidden, so the
             module falls back to the panel top (see traceHost() in api-client). -->
        <div class="engine-trace-host" id="reApiTraceHost"></div>
        <p class="critique-readiness-note" id="critiqueReadinessNote" role="status" aria-live="polite">Confirm the context in the left panel to begin.</p>
        <section class="ask-answer" id="askAnswer" aria-live="polite" hidden></section>
        <section class="critique-distribution" id="critiqueDistribution" aria-label="Critique Category Distribution" style="margin-top:8px" hidden></section>
        <div class="critique-list" id="critiqueList">
          <div class="empty-state">No critiques yet.</div>
        </div>
        <div class="batch-apply-bar" id="batchApplyBar" role="group" aria-label="Apply selected recommendations" hidden>
          <button class="batch-enter-button" id="batchSelectToggle" type="button" aria-label="Select multiple recommendations to apply together">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="m14.5 17 2 2 4-4.5"/></svg>
            <span>Select multiple</span>
          </button>
          <div class="batch-apply-active">
            <div class="batch-apply-head">
              <strong id="batchApplyCount">0 selected</strong>
              <button class="button ghost small" id="batchExitButton" type="button" aria-label="Done selecting">Done</button>
            </div>
            <span id="batchApplyNote"></span>
            <span class="batch-preview-status" id="batchPreviewStatus" aria-live="polite" hidden>
              <span class="batch-preview-spinner" aria-hidden="true"></span>Building combined preview…
            </span>
            <div class="batch-apply-actions">
              <button class="button ghost small" id="batchSelectAllButton" type="button">Select all</button>
              <button class="button ghost small" id="batchClearButton" type="button">Clear all</button>
              <button class="button primary small" id="batchApplyButton" type="button" disabled>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>
                <span>Apply selected</span>
              </button>
            </div>
          </div>
        </div>
        </div>
        <div class="critique-focus-view" id="critiqueFocusView" hidden></div>
      </aside>
    </div>
    <footer class="status-bar" id="statusBar"></footer>
    <div class="local-review-popover" id="localReviewPopover" hidden>
      <form id="localReviewForm" role="dialog" aria-modal="false" aria-labelledby="localReviewTitle">
        <div class="local-review-head">
          <div>
            <span class="local-review-region" id="localReviewRegion">Selected Area</span>
            <h2 id="localReviewTitle">Request a Local Critique</h2>
          </div>
          <button type="button" id="closeLocalReview" aria-label="Close local critique request">×</button>
        </div>
        <p class="local-review-hint">The review engine will analyze only this area and its overlapping charts.</p>
        <label for="localReviewRequest">What should the review focus on?</label>
        <textarea id="localReviewRequest" rows="3" maxlength="600" required placeholder="For example: Is this trend easy to interpret at a glance?"></textarea>
        <label for="localReviewDimension">Critique Category</label>
        <select id="localReviewDimension">
          <option value="">Best Match</option>
          <option value="chart">Charts</option>
          <option value="color">Color</option>
          <option value="layout">Layout</option>
          <option value="data">Data</option>
          <option value="text">Text</option>
          <option value="visual design">Visual design</option>
          <option value="cognition">Cognition</option>
          <option value="context">Context</option>
          <option value="interaction">Interactivity</option>
          <option value="task">Task</option>
          <option value="design process">Design process</option>
        </select>
        <p class="local-review-error" id="localReviewError" role="alert" hidden></p>
        <div class="modal-actions">
          <button type="button" class="button ghost small" id="cancelLocalReview">Cancel</button>
          <button class="button primary small local-review-submit" id="submitLocalReview" type="submit">${AI_ACTION_ICON}<span>Request Critique</span></button>
        </div>
      </form>
    </div>
    <div class="context-modal" id="contextModal" role="dialog" aria-labelledby="rationalePrompt" hidden>
      <form id="contextInjectForm">
        <div class="rationale-popover-head">
          <label class="rationale-prompt" id="rationalePrompt" for="contextInput">What should VIZier keep in mind here?</label>
          <button type="button" id="closeContextModal" aria-label="Close rationale popover">×</button>
        </div>
        <textarea id="contextInput" rows="2" maxlength="600" required placeholder="e.g. Keep labels readable from across the room."></textarea>
        <div class="modal-actions"><button class="button primary small rationale-submit" id="saveRationaleButton" type="submit">Keep this in mind</button></div>
      </form>
    </div>
  </div>
`;

const els = Object.fromEntries([
  "tilesLayer", "markersLayer", "critiqueList", "canvasViewport", "canvasWorld",
  "zoomLevel", "aiAssistButton",
  "dashboardTitle", "dashboardSubtitle", "dashboardFilterBar", "kpiRow", "dashboardArtboard",
  "searchInput", "versionList", "statusBar", "annotateHint", "localReviewButton",
  "localReviewPopover", "localReviewRequest", "localReviewDimension",
  "localReviewError", "submitLocalReview", "leftPanelResizer", "rightPanelResizer",
].map((id) => [id, document.getElementById(id)]));

bindStudyContext(() => ({
  dashboardId: state.artifact?.id || state.artifact?.libraryId || null,
  dashboardVersion: Number(state.version) || 1,
}));

function clone(value) { return structuredClone(value); }
function tileById(id) { return state.tiles.find((tile) => tile.id === id); }
function critiqueById(id) { return state.critiques.find((item) => item.id === id); }
function designDocumentForEngine() {
  const set = effectiveConstraintSet();
  if (!set) return {};
  const text = String(state.designDoc?.text || "").trim().slice(0, 40000);
  return {
    constraintSet: set,
    ...(text ? { designDocumentText: text } : {}),
  };
}

function reviewContextForEngine() {
  const scope = state.context.scope || [];
  const rationaleNotes = state.rationales.map((rationale) =>
    `Saved design rationale: ${rationale.text}`);
  return {
    ...state.context,
    notes: [...(state.context.notes || []), ...rationaleNotes],
    customTypes: (state.context.customTypes || []).filter((label) =>
      scope.includes(customScopeKey(label))),
  };
}

function feedbackScopeIsNarrowed() {
  const selectedStandardScopes = new Set(
    (state.context.scope || []).filter((scope) => CATEGORY_ORDER.includes(scope)),
  );
  return selectedStandardScopes.size < CATEGORY_ORDER.length;
}

function itemMatchesFeedbackScope(dimension, reviewScope = "full") {
  if (reviewScope !== "full") return true;
  return feedbackScopeFiltersDimension(
    state.context.scope || [],
    dimension,
    state.context.customTypes || [],
  );
}

function syncFeedbackScopeStatus() {
  const status = document.getElementById("scopeSelectionStatus");
  if (!status) return;
  const count = (state.context.scope || []).length;
  const empty = count === 0;
  status.classList.toggle("context-describe-error", empty);
  status.textContent = empty
    ? "Choose at least one area for the next review."
    : feedbackScopeIsNarrowed()
      ? `${count} selected · The next review is limited to these areas.`
      : "All areas selected · The next review covers the full dashboard.";
}

function savedRationalesForEngine() {
  return state.rationales.map((rationale) => {
    const critiqueContext = rationale.critiqueContext || createCritiqueContextSnapshot({
      id: rationale.critiqueId,
      title: rationale.critiqueTitle,
      dimension: rationale.dimension,
    });
    return {
      id: rationale.id,
      userRationale: rationale.text,
      critique: critiqueContext,
      dashboardVersion: rationale.dashboardVersion || 1,
      sourceCritiqueId: rationale.originCritiqueId || critiqueContext.id || rationale.critiqueId,
      currentCritiqueId: rationale.critiqueId,
    };
  });
}

function critiqueProposalSignature(critique) {
  const proposal = critique?.proposal || {};
  const tileIds = [
    critique?.tileId,
    critique?.target?.ref?.tile,
    critique?.target?.ref?.source,
    ...(Array.isArray(critique?.target?.ref?.tiles) ? critique.target.ref.tiles : []),
    ...(Array.isArray(proposal.layout) ? proposal.layout.map((item) => item?.tile) : []),
  ].filter(Boolean).sort();
  const payload = JSON.stringify({
    edits: proposal.edits || [],
    palette: proposal.palette || [],
    layout: proposal.layout || [],
    kpis: proposal.kpis || [],
    label: proposal.label || "",
    subtitle: proposal.subtitle || "",
  });
  const structure = [
    proposal.kpiLayout,
    proposal.kpiStyle,
    proposal.composition,
    proposal.filterId,
  ].filter(Boolean).join(",");
  const manualRemedy = proposal.kind === "manual"
    ? critique?.recommendation || critique?.suggestion || ""
    : "";
  return [
    proposal.kind || "manual",
    critique?.object || "",
    critique?.problem || "",
    tileIds.join(","),
    payload,
    structure,
    manualRemedy,
  ].join("|").slice(0, 800);
}

function iterationContextForEngine() {
  const byId = new Map([
    ...(state.critiques || []),
    ...(state.workingDraft?.appliedCritiques || []),
  ].map((critique) => [critique.id, critique]));
  const acceptedIds = new Set(
    (state.interactionJournal || [])
      .filter((event) => event.kind === "recommendation_accepted" && event.critiqueId)
      .map((event) => event.critiqueId),
  );
  const applied = [...acceptedIds].map((id) => byId.get(id)).filter(Boolean).map((critique) => ({
    signature: critiqueProposalSignature(critique),
    kind: String(critique.proposal?.kind || "manual"),
    tileIds: [
      critique.tileId,
      critique.target?.ref?.tile,
      critique.target?.ref?.source,
      ...(Array.isArray(critique.target?.ref?.tiles) ? critique.target.ref.tiles : []),
    ].filter(Boolean),
    ...(critique.object ? { object: critique.object } : {}),
    ...(critique.problem ? { problem: critique.problem } : {}),
    ...(critique.recommendation ? { recommendation: critique.recommendation } : {}),
    version: Number(critique.lastEvaluatedVersion || state.version),
  }));
  const rejectedSignatures = (state.critiques || [])
    .filter((critique) => critique.status === "rejected")
    .map(critiqueProposalSignature);
  const changedTargets = [
    ...(state.versions || []).flatMap((version) => version.changedTargets || []),
    ...(state.workingDraft?.changedTargets || []),
  ];
  return {
    round: Math.max(1, Number(state.version) || 1),
    dashboardVersion: Math.max(1, Number(state.version) || 1),
    applied: applied.slice(-40),
    rejectedSignatures: [...new Set(rejectedSignatures)].slice(-40),
    changedTargets: [...new Set(changedTargets)].slice(-80),
  };
}

function contextReadyForReview() {
  return (state.context.scope || []).length > 0 &&
    contextIsConfirmed(state.contextWorkflow, state.context);
}

function reviewResultsMatchContext() {
  return !state.critiques.length ||
    state.lastReviewContextFingerprint === contextFingerprint(state.context);
}

function setContextWorkflow(status, overrides = {}) {
  state.contextWorkflow = {
    ...state.contextWorkflow,
    status,
    detail: "",
    error: "",
    reason: null,
    confirmedFingerprint: status === CONTEXT_WORKFLOW_STATUS.CONFIRMED
      ? contextFingerprint(state.context)
      : null,
    ...overrides,
  };
}

function markContextNeedsReview(detail = "", reason = "edited") {
  if (state.contextWorkflow.status === CONTEXT_WORKFLOW_STATUS.GENERATING) return;
  setContextWorkflow(CONTEXT_WORKFLOW_STATUS.NEEDS_REVIEW, { detail, reason });
  updateContextWorkflowControls();
}

function syncReviewReadiness() {
  // A design document still being read blocks the review: its constraints
  // silently filter the results, so starting before extraction settles would
  // review against an incomplete rule set. This holds even when context was
  // already confirmed before the upload.
  const docProcessing = designDocIsProcessing();
  const ready = contextReadyForReview() && !docProcessing;
  const staleResults = ready && !reviewResultsMatchContext();
  // One review at a time: full, focused, and selected-region share the engine
  // and the critique list, so a second ask would race the first (and drop its
  // critiques_displayed event).
  const running = Boolean(
    state.reviewInFlight
    || state.focusedReviewRunning
    || state.localReviewSubmitting
    || els.aiAssistButton.classList.contains("ai-running"),
  );
  const actionTitle = els.aiAssistButton.querySelector(".ai-action-title");
  const note = document.getElementById("critiqueReadinessNote");
  els.aiAssistButton.disabled = !ready || running;
  const focusedSend = document.getElementById("runFocusedReviewBtn");
  const focusedInput = document.getElementById("focusedReviewInput");
  if (focusedSend && !state.focusedReviewRunning) {
    const request = (focusedInput?.value || "").replace(/\s+/g, " ").trim();
    focusedSend.disabled = running || request.length < 3 || !ready;
  }
  // Lock the exploration slider while a review is generating — the temperature
  // is read at request time, so changing it mid-run would misrepresent what the
  // in-flight critiques were drafted with.
  const tempControl = document.getElementById("reviewTempControl");
  const tempInput = document.getElementById("reviewTemperature");
  if (tempInput) tempInput.disabled = running;
  if (tempControl) tempControl.classList.toggle("locked", running);
  if (!ready && !running) actionTitle.textContent = docProcessing ? "Reading Document…" : "Confirm Context First";
  if (ready && !running) {
    actionTitle.textContent = state.critiques.length ? "Regenerate Critiques" : "Generate Critiques";
  }
  if (note) {
    note.hidden = ready && !staleResults;
    if (staleResults) {
      note.textContent = "These critiques use the previous context. Regenerate them before previewing or applying changes.";
    } else if (!ready) {
      note.textContent = docProcessing
        ? "Reading the design document — the review starts once it finishes."
        : state.contextWorkflow.status === CONTEXT_WORKFLOW_STATUS.GENERATING
          ? "Context is being generated in the left panel."
          : state.contextWorkflow.status === CONTEXT_WORKFLOW_STATUS.ERROR
            ? "Resolve context setup in the left panel before generating critiques."
            : "Review and confirm context in the left panel before generating critiques.";
    }
  }
  els.aiAssistButton.setAttribute("aria-label", ready
    ? actionTitle.textContent
    : "Confirm context before generating critiques");
  els.localReviewButton.disabled = !ready || running;
  els.localReviewButton.setAttribute("aria-label", ready
    ? "Select an area for local critique"
    : "Confirm context before starting a local critique");
  els.localReviewButton.setAttribute("data-tooltip", ready
    ? "Drag a box on the dashboard to review just that area"
    : "Confirm context first to review an area");
}

// The review-temperature slider runs on the model's own 0–1 scale. The author
// sets the number directly (the readout shows it); the engine only clamps it.
// One decimal keeps the value in lockstep with the slider's 0.1 step.
const REVIEW_TEMPERATURE_MIN = 0;
const REVIEW_TEMPERATURE_MAX = 1;

function formatReviewTemperature(value) {
  return value.toFixed(1);
}

function renderReviewTemperature() {
  const input = document.getElementById("reviewTemperature");
  if (!input) return;
  const value = state.reviewTemperature;
  input.value = String(value);
  // Drive the filled portion of the track from the current value so the native
  // range input reads as a shadcn-style slider with a colored range.
  const fraction = (value - REVIEW_TEMPERATURE_MIN) / (REVIEW_TEMPERATURE_MAX - REVIEW_TEMPERATURE_MIN);
  input.style.setProperty("--temp-fill", `${Math.round(fraction * 100)}%`);
  input.setAttribute("aria-valuetext", formatReviewTemperature(value));
  const readout = document.getElementById("reviewTemperatureValue");
  if (readout) readout.textContent = formatReviewTemperature(value);
}

function wireReviewTemperature() {
  const input = document.getElementById("reviewTemperature");
  if (!input) return;
  input.addEventListener("input", () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) return;
    state.reviewTemperature = Math.round(
      Math.min(REVIEW_TEMPERATURE_MAX, Math.max(REVIEW_TEMPERATURE_MIN, parsed)) * 10,
    ) / 10;
    renderReviewTemperature();
  });
  renderReviewTemperature();
}

function workingDraftChangeCount() {
  return (state.workingDraft.applicationOrder || []).length;
}

function renderWorkingDraftStatus() {
  const status = document.getElementById("workingDraftStatus");
  const saveButton = document.getElementById("saveCheckpointButton");
  const dirty = Boolean(state.workingDraft.dirty);
  const count = workingDraftChangeCount();
  if (status) {
    status.classList.toggle("dirty", dirty);
    status.classList.toggle("clean", !dirty);
    status.querySelector("span:last-child").textContent = dirty
      ? `Working Draft · ${count} unsaved ${count === 1 ? "change" : "changes"}`
      : "Working Draft saved";
  }
  if (saveButton) {
    saveButton.disabled = !dirty;
    saveButton.title = dirty
      ? `Save ${count} ${count === 1 ? "change" : "changes"} as a checkpoint`
      : "No unsaved changes";
  }
}
function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function canvasVisibleArea() {
  const rect = els.canvasViewport.getBoundingClientRect();
  const dock = document.getElementById("revisionDock");
  const expandedHeight = dock
    ? Number.parseFloat(getComputedStyle(dock).getPropertyValue("--revision-expanded-height")) || 236
    : 0;
  const reservedBottom = dock
    ? (state.drawers.versions ? expandedHeight : dock.offsetHeight)
    : 0;
  return {
    width: rect.width,
    height: Math.max(1, rect.height - reservedBottom),
  };
}

function clampView() {
  const rect = canvasVisibleArea();
  if (!rect.width || !rect.height) return;
  const padding = 32;
  const worldWidth = state.canvasSize.width * state.view.scale;
  const worldHeight = state.canvasSize.height * state.view.scale;
  state.view.x = worldWidth <= rect.width - padding * 2
    ? (rect.width - worldWidth) / 2
    : Math.min(padding, Math.max(rect.width - worldWidth - padding, state.view.x));
  state.view.y = worldHeight <= rect.height - padding * 2
    ? (rect.height - worldHeight) / 2
    : Math.min(padding, Math.max(rect.height - worldHeight - padding, state.view.y));
}

function applyViewTransform() {
  clampView();
  const { x, y, scale } = state.view;
  els.canvasWorld.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  els.zoomLevel.textContent = `${Math.round(scale * 100)}%`;
}

function fitCanvas() {
  const rect = canvasVisibleArea();
  if (!rect.width || !rect.height) return;
  const scale = Math.min(
    (rect.width - 56) / state.canvasSize.width,
    (rect.height - 56) / state.canvasSize.height,
    1,
  );
  state.view.scale = Math.max(0.18, scale);
  state.view.x = (rect.width - state.canvasSize.width * state.view.scale) / 2;
  state.view.y = (rect.height - state.canvasSize.height * state.view.scale) / 2;
  applyViewTransform();
}

const workspace = document.querySelector(".workspace");
const panelElements = {
  left: document.getElementById("contextPanelFixed"),
  right: document.getElementById("critiquesPanelFixed"),
};
const panelResizers = {
  left: els.leftPanelResizer,
  right: els.rightPanelResizer,
};
let activePanelResize = null;
let panelResizeFrame = null;

function readStoredPanelLayout() {
  try {
    const value = JSON.parse(localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeStoredPanelLayout(layout) {
  try {
    if (Object.keys(layout).length) {
      localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } else {
      localStorage.removeItem(PANEL_LAYOUT_STORAGE_KEY);
    }
  } catch {
    // Resizing still works when storage is unavailable.
  }
}

function scheduleCanvasRefit() {
  if (panelResizeFrame) return;
  panelResizeFrame = requestAnimationFrame(() => {
    panelResizeFrame = null;
    fitCanvas();
  });
}

function currentPanelWidth(side) {
  return panelElements[side].getBoundingClientRect().width;
}

function currentPanelBounds(side) {
  const rect = workspace.getBoundingClientRect();
  const oppositeSide = side === "left" ? "right" : "left";
  const handleSpace = panelResizers.left.offsetWidth + panelResizers.right.offsetWidth;
  const minCanvasWidth = Math.min(520, Math.max(340, rect.width * 0.34));
  return panelWidthBounds({
    side,
    workspaceWidth: rect.width,
    oppositeWidth: currentPanelWidth(oppositeSide),
    handleSpace,
    minCanvasWidth,
  });
}

function syncPanelResizerValue(side) {
  const handle = panelResizers[side];
  const bounds = currentPanelBounds(side);
  const width = Math.round(currentPanelWidth(side));
  const panelName = side === "left" ? "Context" : "Critiques";
  handle.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
  handle.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
  handle.setAttribute("aria-valuenow", String(width));
  handle.setAttribute("aria-valuetext", `${panelName} panel width: ${width} pixels`);
}

function persistCurrentPanelWidths() {
  writeStoredPanelLayout({
    left: Math.round(currentPanelWidth("left")),
    right: Math.round(currentPanelWidth("right")),
  });
}

function setPanelWidth(side, width, { persist = false } = {}) {
  const nextWidth = clampPanelWidth(width, currentPanelBounds(side));
  workspace.style.setProperty(`--${side}-panel-width`, `${nextWidth}px`);
  syncPanelResizerValue(side);
  syncPanelResizerValue(side === "left" ? "right" : "left");
  scheduleCanvasRefit();
  if (persist) persistCurrentPanelWidths();
}

function resetPanelWidth(side) {
  workspace.style.removeProperty(`--${side}-panel-width`);
  const stored = readStoredPanelLayout();
  delete stored[side];
  writeStoredPanelLayout(stored);
  requestAnimationFrame(() => {
    syncPanelResizerValue(side);
    syncPanelResizerValue(side === "left" ? "right" : "left");
    fitCanvas();
  });
}

function handlePanelPointerMove(event) {
  if (!activePanelResize || event.pointerId !== activePanelResize.pointerId) return;
  const rect = workspace.getBoundingClientRect();
  const width = panelWidthFromPointer({
    side: activePanelResize.side,
    pointerX: event.clientX,
    workspaceLeft: rect.left,
    workspaceRight: rect.right,
  });
  setPanelWidth(activePanelResize.side, width);
}

function finishPanelResize(event) {
  if (!activePanelResize || event.pointerId !== activePanelResize.pointerId) return;
  activePanelResize.handle.classList.remove("is-active");
  document.body.classList.remove("panel-resizing");
  activePanelResize = null;
  persistCurrentPanelWidths();
  scheduleCanvasRefit();
}

function initializePanelResizing() {
  Object.entries(panelResizers).forEach(([side, handle]) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      activePanelResize = { side, pointerId: event.pointerId, handle };
      handle.classList.add("is-active");
      document.body.classList.add("panel-resizing");
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        resetPanelWidth(side);
        return;
      }
      const bounds = currentPanelBounds(side);
      const width = panelWidthFromKey({
        side,
        key: event.key,
        currentWidth: currentPanelWidth(side),
        bounds,
        step: event.shiftKey ? PANEL_RESIZE_STEP * 3 : PANEL_RESIZE_STEP,
      });
      if (width === null) return;
      event.preventDefault();
      setPanelWidth(side, width, { persist: true });
    });
    handle.addEventListener("dblclick", () => resetPanelWidth(side));
  });

  window.addEventListener("pointermove", handlePanelPointerMove);
  window.addEventListener("pointerup", finishPanelResize);
  window.addEventListener("pointercancel", finishPanelResize);

  const stored = readStoredPanelLayout();
  requestAnimationFrame(() => {
    if (Number.isFinite(Number(stored.left))) setPanelWidth("left", Number(stored.left));
    if (Number.isFinite(Number(stored.right))) setPanelWidth("right", Number(stored.right));
    syncPanelResizerValue("left");
    syncPanelResizerValue("right");
    fitCanvas();
  });
}

const revisionDock = document.getElementById("revisionDock");
const revisionDockResizer = document.getElementById("revisionDockResizer");
let activeRevisionDockResize = null;

function readStoredRevisionDockHeight() {
  try {
    const value = Number(localStorage.getItem(REVISION_DOCK_HEIGHT_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStoredRevisionDockHeight(height) {
  try {
    if (Number.isFinite(height)) {
      localStorage.setItem(REVISION_DOCK_HEIGHT_STORAGE_KEY, String(Math.round(height)));
    } else {
      localStorage.removeItem(REVISION_DOCK_HEIGHT_STORAGE_KEY);
    }
  } catch {
    // Resizing still works when storage is unavailable.
  }
}

function currentRevisionDockHeight() {
  const value = Number.parseFloat(
    getComputedStyle(revisionDock).getPropertyValue("--revision-expanded-height"),
  );
  return Number.isFinite(value) ? value : 430;
}

function currentRevisionDockBounds() {
  return revisionDockHeightBounds({
    viewportHeight: els.canvasViewport.getBoundingClientRect().height,
    minCanvasHeight: 180,
  });
}

function syncRevisionDockResizerValue() {
  const bounds = currentRevisionDockBounds();
  const height = clampRevisionDockHeight(currentRevisionDockHeight(), bounds);
  revisionDockResizer.setAttribute("aria-valuemin", String(bounds.min));
  revisionDockResizer.setAttribute("aria-valuemax", String(bounds.max));
  revisionDockResizer.setAttribute("aria-valuenow", String(height));
  revisionDockResizer.setAttribute(
    "aria-valuetext",
    `Saved checkpoints panel height: ${height} pixels`,
  );
}

function setRevisionDockHeight(height, { persist = false } = {}) {
  const nextHeight = clampRevisionDockHeight(height, currentRevisionDockBounds());
  els.canvasViewport.style.setProperty("--revision-dock-height", `${nextHeight}px`);
  syncRevisionDockResizerValue();
  scheduleCanvasRefit();
  if (persist) writeStoredRevisionDockHeight(nextHeight);
}

function resetRevisionDockHeight() {
  els.canvasViewport.style.removeProperty("--revision-dock-height");
  writeStoredRevisionDockHeight(null);
  requestAnimationFrame(() => {
    syncRevisionDockResizerValue();
    fitCanvas();
  });
}

function ensureRevisionDockExpanded() {
  if (state.drawers.versions) return;
  state.drawers.versions = true;
  applyDrawers();
}

function handleRevisionDockPointerMove(event) {
  if (
    !activeRevisionDockResize
    || event.pointerId !== activeRevisionDockResize.pointerId
  ) return;
  const rect = els.canvasViewport.getBoundingClientRect();
  const height = revisionDockHeightFromPointer({
    pointerY: event.clientY,
    viewportBottom: rect.bottom,
  });
  setRevisionDockHeight(height);
}

function finishRevisionDockResize(event) {
  if (
    !activeRevisionDockResize
    || event.pointerId !== activeRevisionDockResize.pointerId
  ) return;
  revisionDockResizer.classList.remove("is-active");
  document.body.classList.remove("revision-dock-resizing");
  activeRevisionDockResize = null;
  writeStoredRevisionDockHeight(currentRevisionDockHeight());
  scheduleCanvasRefit();
}

function initializeRevisionDockResizing() {
  revisionDockResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    ensureRevisionDockExpanded();
    activeRevisionDockResize = { pointerId: event.pointerId };
    revisionDockResizer.classList.add("is-active");
    document.body.classList.add("revision-dock-resizing");
  });
  revisionDockResizer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      resetRevisionDockHeight();
      return;
    }
    const height = revisionDockHeightFromKey({
      key: event.key,
      currentHeight: currentRevisionDockHeight(),
      bounds: currentRevisionDockBounds(),
      step: event.shiftKey
        ? REVISION_DOCK_RESIZE_STEP * 3
        : REVISION_DOCK_RESIZE_STEP,
    });
    if (height === null) return;
    event.preventDefault();
    ensureRevisionDockExpanded();
    setRevisionDockHeight(height, { persist: true });
  });
  revisionDockResizer.addEventListener("dblclick", resetRevisionDockHeight);
  window.addEventListener("pointermove", handleRevisionDockPointerMove);
  window.addEventListener("pointerup", finishRevisionDockResize);
  window.addEventListener("pointercancel", finishRevisionDockResize);
  window.addEventListener("resize", () => {
    const storedHeight = readStoredRevisionDockHeight();
    requestAnimationFrame(() => {
      if (storedHeight !== null) setRevisionDockHeight(storedHeight);
      else syncRevisionDockResizerValue();
    });
  });

  const storedHeight = readStoredRevisionDockHeight();
  requestAnimationFrame(() => {
    if (storedHeight !== null) setRevisionDockHeight(storedHeight);
    else syncRevisionDockResizerValue();
  });
}

function setScale(nextScale, anchor) {
  const rect = els.canvasViewport.getBoundingClientRect();
  const point = anchor || { x: rect.width / 2, y: rect.height / 2 };
  const old = state.view.scale;
  const next = Math.min(2.4, Math.max(0.18, nextScale));
  const worldX = (point.x - state.view.x) / old;
  const worldY = (point.y - state.view.y) / old;
  state.view.scale = next;
  state.view.x = point.x - worldX * next;
  state.view.y = point.y - worldY * next;
  applyViewTransform();
}

// Scroll/pan the canvas so a region (canvas-space px bounds) is centered in the
// visible viewport, then flash a highlight box over it so the author can recall
// exactly where their Review Area selection was. The highlight lives in
// #markersLayer (canvas-space px, same as .marker) so it tracks the view
// transform; it removes itself after the flash.
function revealRegionOnCanvas(bounds) {
  if (!bounds || !els.canvasViewport) return;
  const rect = canvasVisibleArea();
  const scale = state.view.scale;
  const centerX = (bounds.x + bounds.w / 2) * scale;
  const centerY = (bounds.y + bounds.h / 2) * scale;
  state.view.x = rect.width / 2 - centerX;
  state.view.y = rect.height / 2 - centerY;
  applyViewTransform();

  els.markersLayer.querySelector(".region-flash")?.remove();
  const flash = document.createElement("div");
  flash.className = "region-flash";
  Object.assign(flash.style, {
    left: `${bounds.x}px`,
    top: `${bounds.y}px`,
    width: `${bounds.w}px`,
    height: `${bounds.h}px`,
  });
  els.markersLayer.appendChild(flash);
  // Remove after the CSS flash animation so it never lingers or stacks.
  setTimeout(() => flash.remove(), 2400);
}

function activeCanvasPreviewResult() {
  return state.canvasPreview?.phase === "after" ? state.canvasPreview.result : null;
}

function canvasBoardState() {
  const previewBoard = activeCanvasPreviewResult()?.board;
  return {
    title: previewBoard?.title ?? state.dashboardTitle,
    subtitle: previewBoard?.subtitle ?? state.dashboardSubtitle,
    // KPIs render for every dashboard (uploaded included) — the band is driven by
    // real, engine-computed values, so it appears only when those values exist.
    showKpis: previewBoard ? Boolean(previewBoard.hasKpis) : Boolean(state.showKpis),
    // ResolvedKpi[] the engine computed from the dashboard's own data; preview
    // wins while a proposal is staged, otherwise the committed board KPIs.
    kpis: (previewBoard ? previewBoard.kpis : state.boardKpis) || [],
    kpiStyle: previewBoard ? previewBoard.kpiStyle : state.boardKpiStyle,
    kpiLayout: previewBoard?.kpiLayout || state.boardKpiPresentation.layout,
    kpiAlignment: previewBoard?.kpiAlignment || state.boardKpiPresentation.alignment,
    kpiDensity: previewBoard?.kpiDensity || state.boardKpiPresentation.density,
    kpiChrome: previewBoard?.kpiChrome || state.boardKpiPresentation.chrome,
    kpiReservedHeight: previewBoard?.kpiReservedHeight ?? state.boardKpiPresentation.reservedHeight,
    kpiReservedWidth: previewBoard?.kpiReservedWidth ?? state.boardKpiPresentation.reservedWidth,
    filters: (previewBoard ? previewBoard.filters : state.dashboardFilters) || [],
    showChartSubtitles: previewBoard?.tiles?.length
      ? previewBoard.tiles.every((tile) => tile.hasSubtitle)
      : Boolean(state.showChartSubtitles),
    tiles: previewBoard?.tiles || [],
    // The preview inherits the immutable uploaded canvas dimensions.
    canvasWidth: previewBoard?.canvasWidth || state.canvasSize.width,
    canvasHeight: previewBoard?.canvasHeight || state.canvasSize.height,
  };
}

function canvasPreviewAffectsTile(tileId) {
  const targets = activeCanvasPreviewResult()?.changedTargets || [];
  return targets.some((target) =>
    target === tileId ||
    target === `tile:${tileId}` ||
    target.startsWith(`${tileId}.`) ||
    target.startsWith(`tile:${tileId}.`));
}

function renderedTileBounds(tile) {
  // Board bounds are the single layout truth for demo and uploaded dashboards.
  // KPI composition changes are committed by the engine as ordinary bounds,
  // so the renderer must not snap them back to a hidden two-row demo template.
  return { ...tile.bounds };
}

// The canvas-space box a critique highlights, in the SAME coordinates the tiles
// actually render at. A region/local-review critique carries the author's real
// dragged bounds (canvas-space already), so those win. A tile-anchored critique
// must track renderedTileBounds (which shifts y/h when the demo KPI band is
// shown), otherwise the marker sits ~100px off the tile it names. Falls back to
// stored bounds, then the whole artboard.
function critiqueRenderBounds(critique) {
  const isRegion = critique?.reviewScope === "selected-region"
    || critique?.origin === "local-review";
  if (isRegion) {
    return critique.bounds
      || critique.localReview?.bounds
      || critique.target?.ref?.selectedBounds
      || fullArtboardBounds();
  }
  const tileId =
    critique?.tileId ||
    critique?.target?.ref?.source ||
    critique?.target?.ref?.tile ||
    null;
  const tile = tileId ? tileById(tileId) : null;
  if (tile) return renderedTileBounds(tile);
  if (critique?.bounds) return critique.bounds;
  return fullArtboardBounds();
}

// Every canvas box a critique highlights. A consolidated multi-tile critique
// (target.ref.tiles: one identical fix merged across several charts) highlights
// EACH affected tile, so the canvas matches its "Applies to N charts" label
// instead of boxing only the representative tile. Region/local-review critiques
// and single-tile critiques resolve to the one box critiqueRenderBounds computes.
function critiqueRenderBoundsList(critique) {
  const isRegion = critique?.reviewScope === "selected-region"
    || critique?.origin === "local-review";
  const tiles = critique?.target?.ref?.tiles;
  if (!isRegion && Array.isArray(tiles) && tiles.length > 1) {
    const boxes = tiles
      .map((id) => tileById(id))
      .filter(Boolean)
      .map((tile) => renderedTileBounds(tile));
    if (boxes.length) return boxes;
  }
  return [critiqueRenderBounds(critique)];
}

// The whole dashboard artboard in canvas-space px, sized to the live canvas so
// the "no specific tile" fallback and minimaps stay correct for uploaded
// dashboards larger than the demo's 1100×720.
function fullArtboardBounds() {
  return { x: 0, y: 0, w: state.canvasSize.width, h: state.canvasSize.height };
}

async function renderTile(tile, host, spec = tile.spec) {
  host.innerHTML = "";
  const sizedSpec = clone(spec);
  sizedSpec.width = Math.max(96, Math.round(host.clientWidth - 8));
  sizedSpec.height = Math.max(80, Math.round(host.clientHeight - 8));
  sizedSpec.autosize = { type: "fit", contains: "padding", resize: false };
  // Absolute-positioned narrative text does not reflow when the responsive
  // renderer replaces a spec's authored width. Keep every text line's Vega
  // limit inside the real host so rewritten recommendations cannot disappear
  // behind `.vega-host { overflow:hidden }`.
  const clampTextLimits = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(clampTextLimits);
      return;
    }
    const mark = node.mark;
    if (mark && typeof mark === "object" && mark.type === "text") {
      const x = Number(mark.x);
      const limit = Number(mark.limit);
      if (Number.isFinite(x) && Number.isFinite(limit)) {
        mark.limit = Math.min(limit, Math.max(24, sizedSpec.width - x - 4));
      }
    }
    Object.values(node).forEach(clampTextLimits);
  };
  clampTextLimits(sizedSpec);
  const result = await embed(host, sizedSpec, { actions: false, renderer: "svg", mode: "vega-lite" });
  return result.view;
}

// The spec actually rendered for a tile, given cross-filter state. Base
// tile.spec stays authoritative (so encoding v2 like the palette change still
// works); cross-filter data/highlight is layered on top at render time.
function specForTile(tile) {
  const baseSpec = activeCanvasPreviewResult()?.specMap?.[tile.id] || tile.spec;
  const dashboardFilteredSpec = applyDashboardFilterState(
    baseSpec,
    canvasBoardState().filters,
    tile.id,
  );
  // While previewing an interaction critique's "Proposed" state, layer a
  // representative coordinated selection so the behavior is visible on the
  // static canvas — otherwise Proposed looks identical to Original because a
  // cross-filter param / tooltip encoding only manifests on click/hover.
  const interactionPreview = state.canvasPreview?.phase === "after"
    ? state.canvasPreview.interactionPreview
    : null;
  if (interactionPreview?.kind === "cross-filter") {
    const selection = { field: interactionPreview.field, value: interactionPreview.value };
    if (tile.id === interactionPreview.sourceTile) return applySourceSelectionState(dashboardFilteredSpec, selection);
    if (interactionPreview.targetTiles.includes(tile.id)) return applyTargetFilterState(dashboardFilteredSpec, selection);
  }
  if (!state.crossFilterEnabled) return dashboardFilteredSpec;
  const coordination = dashboardFilteredSpec?.usermeta?.crossFilter;
  if (coordination?.role === "source") return withSourceState(dashboardFilteredSpec, coordination.field);
  if (coordination?.role === "target") return withFilterData(dashboardFilteredSpec, coordination.field);
  return dashboardFilteredSpec;
}

async function renderTiles() {
  // Destroy all existing Vega views first
  for (const viewId in state.views) {
    try {
      if (state.views[viewId]?.finalize) {
        state.views[viewId].finalize();
      }
    } catch (e) {
      console.warn(`[renderTiles] Failed to finalize view ${viewId}:`, e);
    }
  }
  state.views = {};

  // Completely clear the layer to force fresh render
  els.tilesLayer.innerHTML = "";

  const canvasBoard = canvasBoardState();
  const previewTileMeta = new Map(canvasBoard.tiles.map((tile) => [tile.id, tile]));
  els.tilesLayer.innerHTML = state.tiles.map((tile) => {
    const meta = previewTileMeta.get(tile.id);
    // A staged layout/KPI proposal moves or resizes tiles: the preview board
    // carries the engine's new per-tile box, which must win over the committed
    // one so the canvas actually shows the tiles relocating in "Proposed".
    const bounds = meta?.bounds ? { ...meta.bounds } : renderedTileBounds(tile, canvasBoard.showKpis);
    const hasSubtitle = activeCanvasPreviewResult()
      ? Boolean(meta?.hasSubtitle)
      : canvasBoard.showChartSubtitles;
    const title = activeCanvasPreviewResult()
      ? (meta?.title || tile.v2Label || tile.label)
      : (hasSubtitle ? tile.v2Label : tile.label);
    return `
      <article class="tile ${state.selectedTileId === tile.id ? "selected" : ""} ${canvasPreviewAffectsTile(tile.id) ? "canvas-preview-affected" : ""}" data-tile-id="${tile.id}"
        style="left:${bounds.x}px;top:${bounds.y}px;width:${bounds.w}px;height:${bounds.h}px">
        <div class="tile-label">${escapeHTML(title)}</div>
        ${hasSubtitle ? `<div class="tile-subtitle">${escapeHTML(tile.subtitle)}</div>` : ""}
        <div class="vega-host" id="vega-${tile.id}"></div>
      </article>`;
  }).join("");

  for (const tile of state.tiles) {
    const host = document.getElementById(`vega-${tile.id}`);
    if (!host) {
      console.error(`[renderTiles] Host not found for tile: ${tile.id}`);
      continue;
    }
    let view = null;
    try {
      const spec = specForTile(tile);
      view = await renderTile(tile, host, spec);
      state.views[tile.id] = view;
    } catch (error) {
      console.error(`[renderTiles] ✗ Failed to render tile ${tile.id}:`, error);
    }
    if (
      state.crossFilterEnabled &&
      specForTile(tile)?.usermeta?.crossFilter?.role === "source" &&
      view
    ) {
      view.addEventListener("click", onCrossFilterClick);
    }
  }

  // Clicking a tile's content deliberately does NOT select a tile or jump to a
  // critique: one location can carry several critiques, so guessing one is
  // misleading. Critiques are opened from the list, history, or answer links,
  // which also highlight the relevant tile. Cross-filter (Vega view listener)
  // and region drafting (annotate pointerdown) keep their own tile handlers.
}

// Source tile (department bars) with pointer affordance + selection highlight
// derived from state (not a live Vega selection), so a full re-render keeps it.
function withSourceState(spec, field) {
  const selection = state.crossFilterSelection?.field === field
    ? state.crossFilterSelection
    : { field, value: null };
  return applySourceSelectionState(spec, selection);
}

// Apply the engine-declared field/value filter to any target spec. This uses
// the uploaded spec's own data and transforms; it contains no sample tile ids.
function withFilterData(spec, field) {
  const selection = state.crossFilterSelection?.field === field
    ? state.crossFilterSelection
    : { field, value: null };
  return applyTargetFilterState(spec, selection);
}

async function onCrossFilterClick(event, item) {
  if (!state.crossFilterEnabled || state.settleDemoPlaying) return;
  const source = state.tiles.find((tile) =>
    specForTile(tile)?.usermeta?.crossFilter?.role === "source");
  const coordination = source ? specForTile(source)?.usermeta?.crossFilter : null;
  const field = coordination?.field;
  const value = field && item?.datum?.[field];
  if (value === undefined || value === null) return;
  state.crossFilterSelection =
    state.crossFilterSelection?.field === field && state.crossFilterSelection?.value === value
      ? null
      : {
          field,
          value,
          source: coordination.source || source.id,
          targets: Array.isArray(coordination.targets) ? coordination.targets : [],
        };
  await renderTiles();
}

function renderDashboardFilterBar(filters = [], board = {}) {
  const controls = Array.isArray(filters) ? filters : [];
  const previewing = Boolean(activeCanvasPreviewResult());
  const disabled = previewing ? " disabled title=\"Finish the recommendation preview before changing dashboard filters\"" : "";
  els.dashboardFilterBar.hidden = controls.length === 0;
  if (!controls.length) {
    els.dashboardFilterBar.innerHTML = "";
    els.dashboardFilterBar.style.cssText = "";
    return;
  }
  els.dashboardFilterBar.style.cssText = "position:absolute;z-index:5;inset:0;display:block;pointer-events:none;color:inherit;font:inherit";
  const placementCounts = new Map();
  const renderedTiles = board.tiles?.length
    ? board.tiles
    : state.tiles.map((tile) => ({ ...tile, bounds: renderedTileBounds(tile) }));
  const tileById = new Map(renderedTiles.map((tile) => [tile.id, tile]));
  els.dashboardFilterBar.innerHTML = controls.map((filter) => {
    const placement = filter.placement || "top-row";
    const slot = placementCounts.get(placement) || 0;
    placementCounts.set(placement, slot + 1);
    const accent = /^#[0-9a-f]{6}$/i.test(filter.accent || "") ? filter.accent : "#334155";
    const tone = filter.tone || "neutral";
    const container = filter.container || "plain";
    const anchored = filter.anchorTile ? tileById.get(filter.anchorTile)?.bounds : null;
    const explicit = filter.position && Number.isFinite(Number(filter.position.x)) && Number.isFinite(Number(filter.position.y))
      ? {
          x: Number(filter.position.x),
          y: Number(filter.position.y),
          ...(Number.isFinite(Number(filter.position.w)) ? { w: Number(filter.position.w) } : {}),
        }
      : null;
    let position = `top:94px;left:${34 + slot * 310}px;max-width:560px`;
    if (placement === "title-inline") position = `top:${28 + slot * 52}px;right:34px;max-width:520px`;
    if (placement === "left-rail") position = `top:${148 + slot * 112}px;left:28px;width:184px`;
    if (placement === "right-rail") position = `top:${148 + slot * 112}px;right:28px;width:184px`;
    if (placement === "chart-header") {
      position = anchored
        ? `top:${anchored.y + 54}px;left:${anchored.x + 14}px;width:${Math.max(160, Math.min(Number(explicit?.w) || 340, anchored.w - 28))}px`
        : `top:${148 + slot * 112}px;right:28px;width:220px`;
    }
    if (placement === "floating" && explicit) {
      position = `top:${explicit.y}px;left:${explicit.x}px;${explicit.w ? `width:${explicit.w}px` : "max-width:520px"}`;
    }
    const background = container === "plain" || container === "ruled"
      ? "transparent"
      : tone === "contrast"
        ? accent
        : `color-mix(in srgb,${accent} 9%,white)`;
    const foreground = tone === "contrast" ? "#ffffff" : accent;
    const border = container === "panel" || container === "pill"
      ? `1px solid color-mix(in srgb,${accent} 32%,transparent)`
      : container === "ruled"
        ? `0 solid ${accent};border-bottom-width:1px`
        : "0";
    const radius = container === "pill" ? "999px" : container === "panel" ? "8px" : "0";
    const padding = container === "plain" ? "0" : container === "ruled" ? "5px 0 7px" : "8px 11px";
    const status = filter.wired
      ? ""
      : `<span title="This control is visible but not connected to its target views" style="color:${tone === "contrast" ? "#fff4c2" : "#92400e"};font-size:10px">Not connected</span>`;
    const options = Array.isArray(filter.options) ? filter.options : [];
    const selected = Array.isArray(filter.value) ? filter.value.map(String) : [String(filter.value ?? "")];
    const optionButton = (option, label = String(option)) => {
      const value = String(option);
      const active = selected.includes(value);
      return `<button type="button" data-dashboard-filter-option="${escapeHTML(filter.id)}" data-filter-value="${escapeHTML(value)}" aria-pressed="${active}"${disabled} style="border:${active ? `1px solid ${accent}` : "1px solid color-mix(in srgb,currentColor 24%,transparent)"};background:${active ? accent : "transparent"};color:${active ? "#fff" : "inherit"};border-radius:${filter.variant === "chips" ? "999px" : "4px"};padding:4px 8px;font:600 10.5px inherit;cursor:pointer">${escapeHTML(label)}</button>`;
    };
    let content;
    if (filter.kind === "range") {
      const min = Number.isFinite(Number(filter.min)) ? Number(filter.min) : 0;
      const max = Number.isFinite(Number(filter.max)) ? Number(filter.max) : 100;
      const step = Number.isFinite(Number(filter.step)) ? Number(filter.step) : 1;
      const value = Number.isFinite(Number(filter.value)) ? Number(filter.value) : max;
      content = `<label style="display:grid;grid-template-columns:1fr auto;align-items:center;gap:5px 10px"><strong style="font-size:11px;font-weight:700">${escapeHTML(filter.label)}</strong><output data-filter-output="${escapeHTML(filter.id)}" style="font-size:10.5px;font-variant-numeric:tabular-nums">≤ ${value}</output><input type="range" data-dashboard-filter-range="${escapeHTML(filter.id)}" min="${min}" max="${max}" step="${step}" value="${value}"${disabled} style="grid-column:1/-1;width:100%;accent-color:${accent}">${status}</label>`;
    } else if (filter.variant === "segmented" || filter.variant === "chips") {
      content = `<div role="group" aria-label="${escapeHTML(filter.label)}" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><strong style="margin-right:2px;font-size:11px;font-weight:700">${escapeHTML(filter.label)}</strong>${optionButton("", "All")}${options.map((option) => optionButton(option)).join("")}${status}</div>`;
    } else if (filter.variant === "checkboxes") {
      content = `<fieldset style="display:grid;gap:5px;margin:0;padding:0;border:0"><legend style="margin-bottom:2px;font-size:11px;font-weight:700">${escapeHTML(filter.label)}</legend>${options.map((option) => {
        const value = String(option);
        return `<label style="display:flex;align-items:center;gap:6px;font-size:10.5px"><input type="checkbox" data-dashboard-filter-check="${escapeHTML(filter.id)}" value="${escapeHTML(value)}"${selected.includes(value) ? " checked" : ""}${disabled} style="accent-color:${accent}">${escapeHTML(value)}</label>`;
      }).join("")}${status}</fieldset>`;
    } else {
      content = `<label style="display:flex;align-items:center;gap:8px"><strong style="font-size:11px;font-weight:700">${escapeHTML(filter.label)}</strong><select data-dashboard-filter-select="${escapeHTML(filter.id)}"${disabled} style="min-width:116px;padding:5px 26px 5px 8px;border:1px solid color-mix(in srgb,${accent} 34%,transparent);border-radius:4px;background:${tone === "contrast" ? accent : "#fff"};color:inherit;font:600 10.5px inherit"><option value="">All</option>${options.map((option) => `<option value="${escapeHTML(String(option))}"${String(filter.value ?? "") === String(option) ? " selected" : ""}>${escapeHTML(String(option))}</option>`).join("")}</select>${status}</label>`;
    }
    return `<div class="dashboard-filter-control filter-${escapeHTML(filter.variant || (filter.kind === "range" ? "slider" : "select"))} filter-placement-${escapeHTML(placement)} filter-container-${escapeHTML(container)}" style="position:absolute;${position};pointer-events:auto;box-sizing:border-box;padding:${padding};border:${border};border-radius:${radius};background:${background};color:${foreground};box-shadow:${container === "panel" ? "0 6px 18px rgba(15,23,42,.12)" : "none"}">${content}</div>`;
  }).join("");
  els.dashboardFilterBar.querySelectorAll("[data-dashboard-filter-select]").forEach((control) => {
    control.addEventListener("change", async () => {
      const filter = state.dashboardFilters.find((item) => item.id === control.dataset.dashboardFilterSelect);
      if (!filter) return;
      filter.value = control.value === "" ? null : control.value;
      await renderTiles();
    });
  });
  els.dashboardFilterBar.querySelectorAll("[data-dashboard-filter-range]").forEach((control) => {
    const update = async () => {
      const filter = state.dashboardFilters.find((item) => item.id === control.dataset.dashboardFilterRange);
      if (!filter) return;
      filter.value = Number(control.value);
      const output = els.dashboardFilterBar.querySelector(`[data-filter-output="${CSS.escape(filter.id)}"]`);
      if (output) output.textContent = `≤ ${filter.value}`;
      await renderTiles();
    };
    control.addEventListener("input", update);
  });
  els.dashboardFilterBar.querySelectorAll("[data-dashboard-filter-option]").forEach((control) => {
    control.addEventListener("click", async () => {
      const filter = state.dashboardFilters.find((item) => item.id === control.dataset.dashboardFilterOption);
      if (!filter) return;
      filter.value = control.dataset.filterValue || null;
      renderDashboardFilterBar(state.dashboardFilters, canvasBoardState());
      await renderTiles();
    });
  });
  els.dashboardFilterBar.querySelectorAll("[data-dashboard-filter-check]").forEach((control) => {
    control.addEventListener("change", async () => {
      const filter = state.dashboardFilters.find((item) => item.id === control.dataset.dashboardFilterCheck);
      if (!filter) return;
      const checked = [...els.dashboardFilterBar.querySelectorAll(
        `[data-dashboard-filter-check="${CSS.escape(filter.id)}"]:checked`,
      )].map((input) => input.value);
      filter.value = checked.length ? checked : null;
      await renderTiles();
    });
  });
}

function renderDashboardChrome({ renderContext = true } = {}) {
  const board = canvasBoardState();
  const previewResult = activeCanvasPreviewResult();
  const targets = previewResult?.changedTargets || [];
  els.dashboardArtboard.className = [
    "dashboard-artboard",
    `dashboard-theme-${state.artifact.id || "default"}`,
    previewResult ? "canvas-proposed" : "",
    previewResult && !state.canvasPreview?.hasExecutableProposal ? "canvas-guidance-only" : "",
    targets.includes("dashboard.title") ? "canvas-preview-title-change" : "",
    targets.includes("dashboard.subtitle") ? "canvas-preview-subtitle-change" : "",
    targets.includes("dashboard.kpis") ? "canvas-preview-kpi-change" : "",
  ].filter(Boolean).join(" ");
  els.dashboardArtboard.style.setProperty(
    "--preview-accent",
    state.canvasPreview?.accent || COLORS.visual,
  );
  // Recommendations may rearrange content inside the dashboard, but the
  // uploaded canvas is immutable. The engine quality gate rejects any preview
  // that would need a larger artboard.
  const canvasWidth = state.canvasSize.width;
  const canvasHeight = state.canvasSize.height;
  els.canvasWorld.style.width = `${canvasWidth}px`;
  els.canvasWorld.style.height = `${canvasHeight}px`;
  els.dashboardArtboard.style.width = `${canvasWidth}px`;
  els.dashboardArtboard.style.height = `${canvasHeight}px`;
  els.dashboardTitle.textContent = board.title;
  els.dashboardSubtitle.textContent = board.subtitle;
  els.dashboardSubtitle.hidden = !board.subtitle;
  renderDashboardFilterBar(board.filters, board);
  // Render the engine's real, computed KPIs — never a hardcoded band. Each value
  // is a ResolvedKpi; an uncomputed one honestly shows "—" (computed:false).
  const kpis = Array.isArray(board.kpis) ? board.kpis : [];
  const showKpiBand = board.showKpis && kpis.length > 0;
  const kpiStyles = new Set(["editorial", "product", "compact", "technical"]);
  const hasAuthoredKpiStyle = kpiStyles.has(board.kpiStyle);
  const kpiStyle = hasAuthoredKpiStyle ? board.kpiStyle : "product";
  const kpiLayouts = new Set(["hero-support", "card-grid", "side-rail", "inline-summary"]);
  const kpiLayout = kpiLayouts.has(board.kpiLayout) ? board.kpiLayout : "inline-summary";
  const kpiAlignment = ["start", "center", "end"].includes(board.kpiAlignment)
    ? board.kpiAlignment
    : "start";
  const kpiDensity = ["airy", "balanced", "dense"].includes(board.kpiDensity)
    ? board.kpiDensity
    : "balanced";
  const kpiChrome = ["plain", "ruled", "filled"].includes(board.kpiChrome)
    ? board.kpiChrome
    : "plain";
  const kpiTypography = {
    editorial: {
      rowGap: "24px",
      itemGap: "5px",
      value: "font-family:Georgia,serif;font-size:27px;font-weight:700;letter-spacing:normal",
      label: "font-family:ui-monospace,monospace;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase",
    },
    product: {
      rowGap: "24px",
      itemGap: "5px",
      value: "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:-.025em",
      label: "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:500;letter-spacing:.01em;text-transform:none",
    },
    compact: {
      rowGap: "14px",
      itemGap: "3px",
      value: "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;font-size:23px;font-weight:700;letter-spacing:-.015em",
      label: "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.045em;text-transform:uppercase",
    },
    technical: {
      rowGap: "20px",
      itemGap: "5px",
      value: "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:25px;font-weight:600;letter-spacing:-.04em",
      label: "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;font-size:10px;font-weight:500;letter-spacing:.025em;text-transform:none",
    },
  }[kpiStyle];
  const densityGap = { airy: "22px", balanced: "14px", dense: "8px" }[kpiDensity];
  const filterReservesTopBand = Array.isArray(board.filters) && board.filters.some((filter) =>
    filter.placement === "top-row"
    || (filter.placement === "floating" && Number(filter.position?.y) >= 76 && Number(filter.position?.y) < 138));
  const layoutCss = {
    "hero-support": {
      top: filterReservesTopBand ? "144px" : "100px",
      left: "34px",
      right: "34px",
      width: "auto",
      height: "92px",
      columns: `minmax(220px,2fr) repeat(${Math.max(1, kpis.length - 1)},minmax(90px,1fr))`,
      rows: "1fr",
    },
    "card-grid": {
      top: filterReservesTopBand ? "144px" : "96px",
      left: "34px",
      right: "34px",
      width: "auto",
      height: "96px",
      columns: `repeat(${Math.max(1, Math.min(kpis.length, 6))},minmax(110px,1fr))`,
      rows: "1fr",
    },
    "side-rail": {
      top: filterReservesTopBand ? "144px" : "100px",
      left: "28px",
      right: "auto",
      width: "184px",
      height: `${Math.max(300, canvasHeight - (filterReservesTopBand ? 172 : 128))}px`,
      columns: "1fr",
      rows: `repeat(${Math.max(1, kpis.length)},minmax(58px,auto))`,
    },
    "inline-summary": {
      top: filterReservesTopBand ? "144px" : "100px",
      left: "34px",
      right: "34px",
      width: "auto",
      height: "52px",
      columns: `repeat(${Math.max(1, Math.min(kpis.length, 6))},max-content)`,
      rows: "1fr",
    },
  }[kpiLayout];
  els.kpiRow.className = `kpi-row kpi-layout-${kpiLayout} kpi-style-${kpiStyle}`;
  Object.assign(els.kpiRow.style, {
    display: "grid",
    top: layoutCss.top,
    left: layoutCss.left,
    right: layoutCss.right,
    width: layoutCss.width,
    height: layoutCss.height,
    gridTemplateColumns: layoutCss.columns,
    gridTemplateRows: layoutCss.rows,
    alignItems: kpiAlignment,
    justifyContent: kpiLayout === "inline-summary" ? kpiAlignment : "stretch",
    gap: kpiLayout === "inline-summary" ? densityGap : (hasAuthoredKpiStyle ? kpiTypography.rowGap : densityGap),
    padding: kpiChrome === "filled" ? (kpiDensity === "dense" ? "8px 10px" : "12px 14px") : "0",
    background: kpiChrome === "filled" ? "color-mix(in srgb,currentColor 7%,transparent)" : "transparent",
    borderTop: kpiChrome === "ruled" ? "1px solid currentColor" : "0",
    borderBottom: kpiChrome === "ruled" ? "1px solid currentColor" : "0",
    borderRadius: kpiChrome === "filled" ? "8px" : "0",
  });
  els.kpiRow.innerHTML = showKpiBand
    ? kpis.map((kpi, index) => {
      const isHero = kpiLayout === "hero-support" && index === 0;
      const itemChrome = kpiLayout === "card-grid"
        ? "padding:12px 14px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:7px"
        : kpiLayout === "side-rail"
          ? "padding:10px 0;border-bottom:1px solid color-mix(in srgb,currentColor 18%,transparent)"
          : "padding:0";
      const valueStyle = `${kpiTypography.value};${isHero ? "font-size:42px;font-weight:750" : ""}`;
      return `<div class="kpi${isHero ? " kpi-hero" : ""}${kpi.computed === false ? " kpi-uncomputed" : ""}" style="gap:${kpiTypography.itemGap};${itemChrome};text-align:${kpiAlignment}"><strong class="${kpi.highlight ? "highlight" : ""}" style="${valueStyle}">${escapeHTML(String(kpi.value ?? "—"))}</strong><span style="${kpiTypography.label}">${escapeHTML(String(kpi.label ?? ""))}</span></div>`;
    }).join("")
    : "";
  els.kpiRow.hidden = !showKpiBand;

  if (renderContext) renderFixedContextPanel();
}

function copyComputedLayout(source, target) {
  if (!source || !target || source.nodeType !== 1 || target.nodeType !== 1) return;
  const computed = getComputedStyle(source);
  const props = [
    "position", "display", "flex-direction", "flex-wrap", "align-items", "justify-content",
    "align-content", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows",
    "top", "left", "right", "bottom", "width", "height", "min-width", "min-height",
    "max-width", "max-height", "margin", "padding", "box-sizing",
    "font", "font-family", "font-size", "font-weight", "letter-spacing", "line-height",
    "color", "background", "background-color", "border", "border-radius", "border-bottom",
    "box-shadow", "overflow", "text-transform", "white-space", "visibility", "opacity",
    "z-index", "text-align", "align-self", "justify-self", "transform", "transform-origin",
  ];
  for (const prop of props) {
    const value = computed.getPropertyValue(prop);
    if (value) target.style.setProperty(prop, value);
  }
  const srcKids = source.children;
  const dstKids = target.children;
  const n = Math.min(srcKids.length, dstKids.length);
  for (let i = 0; i < n; i += 1) copyComputedLayout(srcKids[i], dstKids[i]);
}

function copyLiveControlState(source, target) {
  if (!source || !target) return;
  const sourceControls = source.querySelectorAll("input, select, textarea, output, details");
  const targetControls = target.querySelectorAll("input, select, textarea, output, details");
  const count = Math.min(sourceControls.length, targetControls.length);
  for (let index = 0; index < count; index += 1) {
    const live = sourceControls[index];
    const cloneControl = targetControls[index];
    if (live instanceof HTMLInputElement && cloneControl instanceof HTMLInputElement) {
      cloneControl.value = live.value;
      cloneControl.setAttribute("value", live.value);
      if (live.type === "checkbox" || live.type === "radio") {
        cloneControl.checked = live.checked;
        cloneControl.toggleAttribute("checked", live.checked);
      }
    } else if (live instanceof HTMLSelectElement && cloneControl instanceof HTMLSelectElement) {
      cloneControl.value = live.value;
      [...cloneControl.options].forEach((option) => {
        option.toggleAttribute("selected", option.value === live.value);
      });
    } else if (live instanceof HTMLTextAreaElement && cloneControl instanceof HTMLTextAreaElement) {
      cloneControl.value = live.value;
      cloneControl.textContent = live.value;
    } else if (live instanceof HTMLOutputElement && cloneControl instanceof HTMLOutputElement) {
      cloneControl.value = live.value;
      cloneControl.textContent = live.textContent;
    } else if (live instanceof HTMLDetailsElement && cloneControl instanceof HTMLDetailsElement) {
      cloneControl.open = live.open;
      cloneControl.toggleAttribute("open", live.open);
    }
  }
}

async function rasterizeDashboardArtboard() {
  const source = els.dashboardArtboard;
  if (!source) return null;
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const snapshot = source.cloneNode(true);
  copyComputedLayout(source, snapshot);
  copyLiveControlState(source, snapshot);
  snapshot.querySelector("#markersLayer")?.replaceChildren();
  snapshot.querySelectorAll(".selected, .canvas-preview-affected").forEach((node) => {
    node.classList.remove("selected", "canvas-preview-affected");
  });
  snapshot.classList.remove("canvas-proposed");
  snapshot.style.position = "relative";
  snapshot.style.inset = "auto";
  const snapshotWidth = state.canvasSize.width;
  const snapshotHeight = state.canvasSize.height;
  snapshot.style.width = `${snapshotWidth}px`;
  snapshot.style.height = `${snapshotHeight}px`;
  snapshot.style.transform = "none";
  snapshot.style.margin = "0";
  snapshot.style.boxShadow = "none";
  snapshot.style.overflow = "hidden";

  const serialized = new XMLSerializer().serializeToString(snapshot);
  // Do not dump the full page stylesheet into this SVG. Rules like
  // `html, body { overflow: hidden; height: 100% }` clip absolutely
  // positioned heading/KPI chrome when the clone is rasterized as an image.
  const css = "*{box-sizing:border-box;}";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${snapshotWidth}" height="${snapshotHeight}" viewBox="0 0 ${snapshotWidth} ${snapshotHeight}"><foreignObject x="0" y="0" width="${snapshotWidth}" height="${snapshotHeight}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${snapshotWidth}px;height:${snapshotHeight}px;margin:0;padding:0;"><style>${css}</style>${serialized}</div></foreignObject></svg>`;
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const objectURL = URL.createObjectURL(svgBlob);
  return { svg, objectURL, snapshotWidth, snapshotHeight };
}

function fillCanvas(canvas, image, width, height) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fbfbfd";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return context;
}

function loadExportImage(src, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => {
      image.onload = image.onerror = null;
      reject(new Error("image load timed out"));
    }, timeoutMs);
    image.decoding = "async";
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    image.src = src;
  });
}

function canvasPngDataUrl(canvas) {
  try {
    const png = canvas.toDataURL("image/png");
    return typeof png === "string" && png.startsWith("data:image/png") ? png : null;
  } catch (error) {
    console.warn("[revision-screenshot] canvas PNG export failed", error);
    return null;
  }
}

function exportPairFromCanvas(hi, snapshotWidth, snapshotHeight) {
  const png = canvasPngDataUrl(hi);
  if (!png) return null;
  const thumb = document.createElement("canvas");
  const thumbWidth = 770;
  fillCanvas(
    thumb,
    hi,
    thumbWidth,
    Math.max(1, Math.round(thumbWidth * snapshotHeight / snapshotWidth)),
  );
  let screenshot = png;
  try {
    screenshot = thumb.toDataURL("image/webp", .84) || png;
  } catch {
    screenshot = png;
  }
  return { screenshot, png };
}

function vegaViewForExport(view) {
  if (!view) return null;
  if (typeof view.toCanvas === "function" || typeof view.toImageURL === "function") return view;
  if (view.view && (typeof view.view.toCanvas === "function" || typeof view.view.toImageURL === "function")) {
    return view.view;
  }
  return null;
}

async function captureDashboardDisplaySvg() {
  // Keep the exact live Vega SVG and the exact cloned dashboard DOM together.
  // Replacing charts with separately sized canvases introduced a second layout
  // pass and was the main source of export drift.
  const raster = await rasterizeDashboardArtboard();
  if (!raster) return null;
  URL.revokeObjectURL(raster.objectURL);
  return raster.svg;
}

async function captureDashboardPngFromSvg(svg, width, height, scale = 2) {
  if (!svg) return null;
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const objectURL = URL.createObjectURL(blob);
  try {
    const image = await loadExportImage(objectURL);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvasPngDataUrl(canvas);
  } finally {
    URL.revokeObjectURL(objectURL);
  }
}

async function settleDashboardForCapture() {
  const views = Object.values(state.views || {}).map(vegaViewForExport).filter(Boolean);
  await Promise.all(views.map(async (view) => {
    if (typeof view.runAsync === "function") await view.runAsync();
  }));
  if (document.fonts?.ready) {
    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function captureDashboardExport() {
  const width = Math.max(1, Number(state.canvasSize?.width) || 1100);
  const height = Math.max(1, Number(state.canvasSize?.height) || 720);
  await settleDashboardForCapture();
  const snapshot = buildDashboardCaptureSnapshot();
  let svg = null;
  try {
    // This is the visual source used by checkpoint previews. It keeps the live
    // DOM layout and embeds lossless Vega renders, so the saved view matches the
    // dashboard instead of depending on the approximate canvas chrome painter.
    svg = await captureDashboardDisplaySvg();
  } catch (error) {
    console.warn("[revision-screenshot] Faithful SVG capture failed.", error);
  }
  let png = null;
  try {
    png = await captureDashboardPngFromSvg(svg, width, height);
  } catch (error) {
    console.warn("[revision-screenshot] Faithful SVG-to-PNG capture failed.", error);
  }
  if (!png) return { screenshot: null, png: null, svg, snapshot };
  try {
    const image = await loadExportImage(png);
    const hi = document.createElement("canvas");
    fillCanvas(hi, image, image.naturalWidth || width * 2, image.naturalHeight || height * 2);
    const pair = exportPairFromCanvas(hi, width, height);
    return { screenshot: pair?.screenshot || png, png: pair?.png || png, svg, snapshot };
  } catch (error) {
    console.warn("[revision-screenshot] PNG encode failed.", error);
    return { screenshot: png, png, svg, snapshot };
  }
}

async function captureDashboardScreenshot() {
  const captured = await captureDashboardExport();
  return captured.screenshot;
}

async function rememberDashboardExport(target) {
  if (!target) return null;
  try {
    const captured = await captureDashboardExport();
    target.afterSnapshot = captured.snapshot || target.afterSnapshot || null;
    target.afterScreenshot = captured.screenshot || target.afterScreenshot || null;
    target.afterPng = captured.png || target.afterPng || null;
    target.afterSvg = captured.svg || target.afterSvg || null;
    return captured;
  } catch (error) {
    console.warn("[revision-screenshot] rememberDashboardExport failed", error);
    return null;
  }
}

// A checkpoint's applied recommendation is summarized in the rail by the chart
// it changed (its lead label segment), not the full critique title — the title
// stays available on hover and the full detail one click away.
function revisionAppliedTarget(item) {
  const tileId = item?.target && item.target !== "dashboard" ? item.target : null;
  const tile = tileId ? tileById(tileId) : null;
  if (tile?.label) {
    // Keep the lead segment before a separator dash (em/en dash, or a spaced
    // hyphen) so "Task Velocity — Completed vs. Target" reads as "Task
    // Velocity" while a hyphenated name like "Year-over-Year" stays intact.
    return tile.label.split(/\s*[—–]\s*|\s+-\s+/)[0].trim() || tile.label;
  }
  return "Dashboard";
}

function closeRevisionLightbox() {
  els.canvasViewport.querySelector(".revision-lightbox")?.remove();
}

const revisionMediaObjectUrls = new Set();

function releaseRevisionMediaObjectUrls() {
  revisionMediaObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  revisionMediaObjectUrls.clear();
}

function revisionSvgObjectUrl(svg) {
  if (typeof svg !== "string" || !svg.trim().startsWith("<svg")) return null;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  revisionMediaObjectUrls.add(url);
  return url;
}

function revisionVersionMedia(version) {
  if (!version) return { thumbnail: null, full: null, aspectRatio: "1100 / 720" };
  const thumbnail = version.afterScreenshot || version.screenshot || null;
  const full = version.afterPng || thumbnail;
  const faithful = revisionSvgObjectUrl(version.afterSvg);
  const svgSize = typeof version.afterSvg === "string"
    ? version.afterSvg.match(/<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/i)
    : null;
  const width = Math.max(1, Number(svgSize?.[1] || version.afterSnapshot?.board?.canvasWidth) || 1100);
  const height = Math.max(1, Number(svgSize?.[2] || version.afterSnapshot?.board?.canvasHeight) || 720);
  return {
    // Keep a compact image in the checkpoint rail, but render it from the same
    // faithful source as the enlarged view whenever that source is available.
    thumbnail: faithful || thumbnail,
    full: faithful || full,
    aspectRatio: `${width} / ${height}`,
  };
}

// Enlarge a checkpoint screenshot directly over the canvas (clipped to it), with
// a scrim, an explicit close control, backdrop dismissal, and Escape handling.
function openRevisionLightbox(screenshot, label) {
  if (!screenshot) return;
  closeRevisionLightbox();
  const overlay = document.createElement("div");
  overlay.className = "revision-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", `${label} dashboard, enlarged`);
  overlay.innerHTML = `
    <div class="revision-lightbox-scrim" data-lightbox-dismiss></div>
    <figure class="revision-lightbox-figure">
      <figcaption class="revision-lightbox-caption">
        <span>${escapeHTML(label)}</span>
        <button type="button" class="revision-lightbox-close" data-lightbox-dismiss aria-label="Close enlarged view">×</button>
      </figcaption>
      <img src="${screenshot}" alt="${escapeHTML(label)} dashboard, enlarged" draggable="false" />
    </figure>`;
  overlay.querySelectorAll("[data-lightbox-dismiss]").forEach((node) => {
    node.addEventListener("click", closeRevisionLightbox);
  });
  els.canvasViewport.appendChild(overlay);
  overlay.querySelector(".revision-lightbox-close")?.focus();
}

function revisionSnapshotMarkup(media, phase, versionLabel, zoomIndex) {
  const phaseLabel = phase === "baseline"
    ? "Baseline"
    : phase === "before"
      ? "Before"
      : phase === "selected"
        ? "Selected"
        : "After";
  const frame = media?.thumbnail
    ? `<button type="button" class="revision-screenshot-frame" data-revision-zoom="${zoomIndex}" aria-label="Enlarge ${phaseLabel} dashboard" style="aspect-ratio:${media.aspectRatio}">
        <img class="revision-screenshot" src="${media.thumbnail}" alt="${phaseLabel} Dashboard Screenshot" draggable="false" decoding="async" />
        <span class="revision-screenshot-zoom" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M6.5 2h-3a1.5 1.5 0 0 0-1.5 1.5v3M9.5 2h3a1.5 1.5 0 0 1 1.5 1.5v3M6.5 14h-3a1.5 1.5 0 0 1-1.5-1.5v-3M9.5 14h3a1.5 1.5 0 0 0 1.5-1.5v-3"/></svg></span>
      </button>`
    : `<div class="revision-screenshot-frame"><div class="revision-preview-unavailable">Screenshot Unavailable</div></div>`;
  return `
    <article class="revision-snapshot-pane revision-snapshot-${phase}" aria-label="${phaseLabel} Dashboard">
      <header>
        <strong>${phaseLabel}</strong>
        <span>${escapeHTML(versionLabel)}</span>
      </header>
      ${frame}
    </article>`;
}

function renderRevisionSnapshotComparison(beforeVersion, afterVersion) {
  const host = document.getElementById("revisionVisualComparison");
  if (!host) return;
  closeRevisionLightbox();
  releaseRevisionMediaObjectUrls();

  let panes;
  if (!beforeVersion || !afterVersion || beforeVersion.id === afterVersion.id) {
    const version = afterVersion || beforeVersion;
    host.classList.add("single");
    panes = [{
      media: revisionVersionMedia(version),
      phase: version?.kind === "initial" ? "baseline" : "selected",
      label: version ? `Checkpoint ${version.id}` : "Saved checkpoint",
    }];
  } else {
    host.classList.remove("single");
    panes = [
      {
        media: revisionVersionMedia(beforeVersion),
        phase: "before",
        label: `Checkpoint ${beforeVersion.id}`,
      },
      {
        media: revisionVersionMedia(afterVersion),
        phase: "after",
        label: `Checkpoint ${afterVersion.id}`,
      },
    ];
  }

  host.innerHTML = panes
    .map((pane, index) => revisionSnapshotMarkup(pane.media, pane.phase, pane.label, index))
    .join("");

  host.querySelectorAll("[data-revision-zoom]").forEach((frame) => {
    const pane = panes[Number(frame.dataset.revisionZoom)];
    if (!pane?.media?.full) return;
    frame.addEventListener("click", () => openRevisionLightbox(pane.media.full, pane.label));
  });
}

function renderVersions() {
  const latest = state.versions.at(-1);
  const selected = state.versions.find((version) => version.id === state.selectedVersionId) || latest;
  if (!selected) return;
  state.selectedVersionId = selected.id;

  const availableIds = new Set(state.versions.map((version) => version.id));
  if (!availableIds.has(state.checkpointComparison.before)) {
    state.checkpointComparison.before = state.versions[0].id;
  }
  if (!availableIds.has(state.checkpointComparison.after)) {
    state.checkpointComparison.after = latest.id;
  }
  const beforeVersion = state.versions.find(
    (version) => version.id === state.checkpointComparison.before,
  ) || state.versions[0];
  const afterVersion = state.versions.find(
    (version) => version.id === state.checkpointComparison.after,
  ) || latest;
  const hasTwoCheckpoints = state.versions.length > 1;
  const hasComparison = beforeVersion.id !== afterVersion.id;

  const summary = document.getElementById("revisionDockSummary");
  const count = document.getElementById("revisionDockCount");
  if (summary) {
    const changes = workingDraftChangeCount();
    summary.textContent = state.workingDraft.dirty
      ? `Working Draft · ${changes} unsaved ${changes === 1 ? "change" : "changes"}`
      : revisionDisplayLabel(latest, { includeApplied: true });
  }
  if (count) count.textContent = String(state.versions.length);

  els.versionList.innerHTML = state.versions.map((version) => {
    const isBefore = hasComparison && version.id === beforeVersion.id;
    const isAfter = hasComparison && version.id === afterVersion.id;
    const isSingleSelection = hasTwoCheckpoints
      && !hasComparison
      && version.id === afterVersion.id;
    const active = isBefore || isAfter || isSingleSelection;
    const validated = Boolean(version.evaluationReport?.compiled && !version.evaluationReport?.compileError);
    const changeCount = version.appliedRecommendations?.length || version.applicationOrder?.length || 0;
    const timelineMeta = version.kind === "revision"
      ? `${changeCount} ${changeCount === 1 ? "change" : "changes"}`
      : "Original dashboard";
    const originLabel = isBefore
      ? "Before"
      : isAfter
        ? "After"
        : isSingleSelection
          ? "Selected"
          : version.kind === "revision"
            ? (validated ? "Validated" : "Review")
            : "Baseline";
    return `
      <button class="version-card ${active ? "active" : ""} ${isBefore ? "compare-before" : ""} ${isAfter ? "compare-after" : ""} ${isSingleSelection ? "compare-single" : ""}" type="button"
        data-version-id="${version.id}" aria-pressed="${active}">
        <span class="version-node" aria-hidden="true"></span>
        <span class="version-copy">
          <strong>Checkpoint ${version.id}</strong>
          <small>${escapeHTML(timelineMeta)}</small>
        </span>
        <span class="version-origin ${validated ? "valid" : ""} ${active ? "comparison-role" : ""}">${originLabel}</span>
      </button>`;
  }).join("");

  const detail = document.getElementById("revisionDetail");
  if (detail) {
    const report = afterVersion.evaluationReport;
    const validated = afterVersion.kind !== "revision"
      || Boolean(report?.compiled && !report?.compileError);
    const comparisonTitle = hasComparison
      ? `<span class="checkpoint-route"><span>Checkpoint ${beforeVersion.id}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/></svg><span>Checkpoint ${afterVersion.id}</span></span>`
      : hasTwoCheckpoints
        ? `Checkpoint ${afterVersion.id} selected`
        : "Original dashboard";
    const comparisonInstruction = hasComparison
      ? "The two selected timeline nodes define this comparison."
      : hasTwoCheckpoints
        ? "Select one more checkpoint from the timeline to compare."
        : "Save the Working Draft when you reach a meaningful moment.";
    detail.innerHTML = `
      <div class="revision-detail-head comparison">
        <div>
          <h3>${comparisonTitle}</h3>
          <p>${comparisonInstruction}</p>
        </div>
        ${validated ? "" : `<span class="revision-validation warning">Review Needed</span>`}
        ${afterVersion.afterSnapshot ? `<button type="button" class="save-checkpoint-button" id="restoreCheckpointButton">Restore this checkpoint</button>` : ""}
      </div>
      <div class="revision-visual-comparison" id="revisionVisualComparison"></div>
      ${afterVersion.kind === "revision" ? `
        <div class="revision-applied-list">
          <span class="revision-applied-label">In Checkpoint ${afterVersion.id}</span>
          ${(afterVersion.appliedRecommendations || []).map((item) => `
            <button type="button" class="revision-applied-item" data-revision-critique-id="${escapeHTML(item.id)}" title="${escapeHTML(item.title)}" aria-label="${escapeHTML(item.title)}" style="--revision-accent:${critiqueGroupPresentation(item.dimension).color}">
              <span class="revision-applied-dot" aria-hidden="true"></span>
              <span>${escapeHTML(revisionAppliedTarget(item))}</span>
            </button>`).join("")}
        </div>` : ""}`;
    renderRevisionSnapshotComparison(beforeVersion, afterVersion);
    detail.querySelector("#restoreCheckpointButton")?.addEventListener("click", () => {
      void restoreDashboardCheckpoint(afterVersion);
    });
  }

  els.versionList.querySelectorAll("[data-version-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = Number(button.dataset.versionId);
      state.checkpointComparison = checkpointSelectionForClick({
        comparison: state.checkpointComparison,
        clickedId: id,
        orderedIds: state.versions.map((version) => version.id),
        lastSelectedId: state.selectedVersionId,
      });
      state.selectedVersionId = id;
      renderVersions();
    });
  });
  detail?.querySelectorAll("[data-revision-critique-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const critique = critiqueById(button.dataset.revisionCritiqueId);
      if (!critique) return;
      state.selectedCritiqueId = critique.id;
      state.selectedTileId = critique.tileId || null;
      renderMarkers();
      renderCritiques();
      await renderInspector();
    });
  });
  renderWorkingDraftStatus();
}

function setMode(mode) {
  state.mode = mode;
  const annotating = mode === "annotate";
  els.annotateHint.hidden = !annotating;
  els.canvasViewport.classList.toggle("annotating", annotating);
  els.localReviewButton.classList.toggle("active", annotating);
  els.localReviewButton.setAttribute("aria-pressed", String(annotating));
}

function cancelLocalReviewSelection() {
  state.localReviewDraft = null;
  document.querySelector(".draft-marker")?.remove();
  setMode("review");
}

function setLocalReviewSubmitting(submitting) {
  state.localReviewSubmitting = submitting;
  // The selection box stays put on the canvas while its critique generates and
  // lights up with the same Gemini-style edge ring as the context box.
  document.querySelector(".draft-marker")?.classList.toggle("is-generating", submitting);
  els.localReviewRequest.disabled = submitting;
  els.localReviewDimension.disabled = submitting;
  els.submitLocalReview.disabled = submitting;
  els.submitLocalReview.querySelector("span").textContent = submitting
    ? "Reviewing selected area…"
    : "Request Critique";
  // Region review also generates critiques — reflect it in the shared review
  // readiness so the exploration slider locks for this path too.
  syncReviewReadiness();
}

function showLocalReviewError(error) {
  const message = error instanceof Error ? error.message : String(error);
  let recovery = message;
  if (/cannot reach engine|Failed to fetch/i.test(message)) {
    recovery = "The critique engine is unavailable. Reconnect the active API provider, then try again. Your selection and request are still here.";
  } else if (/LLM_REQUIRED/i.test(message)) {
    recovery = "The active API provider is not configured. Configure its token, then try again.";
  } else if (/LLM_CALL_FAILED/i.test(message)) {
    recovery = "The active API provider could not complete this review. Check the connection and try again.";
  } else if (/LLM_GUARDRAIL_FAILED/i.test(message)) {
    recovery = "The response could not be grounded to this selected area. Refine the request and try again.";
  }
  els.localReviewError.textContent = recovery;
  els.localReviewError.hidden = false;
}

function openLocalReviewPopover(bounds) {
  state.localReviewDraft = bounds;
  els.localReviewError.hidden = true;
  els.localReviewError.textContent = "";
  els.localReviewPopover.hidden = false;
  document.getElementById("localReviewRegion").textContent =
    `${Math.round(bounds.w)} × ${Math.round(bounds.h)} px selected`;
  setMode("review");

  requestAnimationFrame(() => {
    const frame = els.dashboardArtboard.getBoundingClientRect();
    const popover = els.localReviewPopover.getBoundingClientRect();
    const gap = 12;
    const selectedLeft = frame.left + bounds.x * state.view.scale;
    const selectedRight = frame.left + (bounds.x + bounds.w) * state.view.scale;
    const selectedTop = frame.top + bounds.y * state.view.scale;
    let left = selectedRight + gap;
    if (left + popover.width > window.innerWidth - 12) {
      left = selectedLeft - popover.width - gap;
    }
    left = Math.max(12, Math.min(window.innerWidth - popover.width - 12, left));
    const top = Math.max(60, Math.min(window.innerHeight - popover.height - 18, selectedTop));
    Object.assign(els.localReviewPopover.style, { left: `${left}px`, top: `${top}px` });
    els.localReviewRequest.focus();
  });
}

function closeLocalReviewPopover() {
  els.localReviewPopover.hidden = true;
  document.getElementById("localReviewForm").reset();
  els.localReviewError.hidden = true;
  els.localReviewError.textContent = "";
  setLocalReviewSubmitting(false);
  state.localReviewDraft = null;
  document.querySelector(".draft-marker")?.remove();
}

// Reflect state.context into the fixed panel fields.
function syncBriefFields() {
  const box = document.getElementById("briefContextBox");
  if (!box) return;
  if (document.activeElement !== box) box.value = serializeContextBox(state.context);
  const reviewRequest = document.getElementById("focusedReviewInput");
  if (reviewRequest) reviewRequest.value = state.reviewRequest || "";
  document.querySelectorAll('#briefScope input[name="briefScope"]').forEach((c) => {
    c.checked = (state.context.scope || []).includes(c.value);
  });
}

function renderContextNotes() {
  const host = document.getElementById("contextNotes");
  if (!host) return;
  const notes = state.context.notes || [];
  host.innerHTML = notes.map((n, i) => `
    <div class="context-note"><span>${n}</span><button type="button" data-note-i="${i}" title="Remove">×</button></div>`).join("");
  host.querySelectorAll("[data-note-i]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.context.notes.splice(Number(btn.dataset.noteI), 1);
      renderContextNotes();
      renderContextToolState();
    }));
}

function rationalePlaceholderFor(critique) {
  return {
    interaction: "e.g. Comparing teams should stay one click away.",
    narrative: "e.g. Keep the delivery-risk story prominent.",
    visual: "e.g. Keep labels readable from across the room.",
    data: "e.g. Use completed tasks, not all assigned tasks.",
    accessibility: "e.g. This must work without relying on color.",
    performance: "e.g. This view is presented on a laptop.",
  }[critique?.dimension] || "e.g. This choice is intentional.";
}

function renderRationaleMemory() {
  const host = document.getElementById("rationaleList");
  const count = document.getElementById("rationaleCount");
  if (!host || !count) return;
  // Keep the section itself out of the panel until the author has saved a
  // rationale, matching the render-time gate (a rationale added or removed
  // here without a full panel re-render must still hide/show the section).
  const section = host.closest(".rationale-memory");
  if (section) section.hidden = state.rationales.length === 0;
  count.textContent = state.rationales.length ? String(state.rationales.length) : "";
  count.hidden = !state.rationales.length;
  count.setAttribute(
    "aria-label",
    `${state.rationales.length} saved ${state.rationales.length === 1 ? "rationale" : "rationales"}`,
  );
  if (!state.rationales.length) {
    host.innerHTML = `
      <div class="rationale-empty">
        Intent you save from a critique appears here.
      </div>`;
    return;
  }
  host.innerHTML = state.rationales.map((rationale) => {
    const presentation = critiqueGroupPresentation(rationale.dimension);
    return `
      <article class="rationale-memory-item" style="--rationale-accent:${presentation.color}">
        <button class="rationale-source" type="button" data-rationale-open="${escapeHTML(rationale.id)}">
          <span>${escapeHTML(presentation.label)}</span>
          <strong>${escapeHTML(rationale.critiqueTitle)}</strong>
        </button>
        <p>${escapeHTML(rationale.text)}</p>
        <div class="rationale-item-actions">
          <button type="button" data-rationale-edit="${escapeHTML(rationale.id)}">Edit</button>
          <button type="button" data-rationale-remove="${escapeHTML(rationale.id)}">Remove</button>
        </div>
      </article>`;
  }).join("");
  host.querySelectorAll("[data-rationale-open]").forEach((button) => {
    button.addEventListener("click", async () => {
      const rationale = state.rationales.find((item) => item.id === button.dataset.rationaleOpen);
      const critique = rationale && critiqueById(rationale.critiqueId);
      if (!critique) return;
      state.selectedCritiqueId = critique.id;
      state.selectedTileId = critique.tileId || null;
      renderCritiques();
      renderMarkers();
      await renderInspector();
    });
  });
  host.querySelectorAll("[data-rationale-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const rationale = state.rationales.find((item) => item.id === button.dataset.rationaleEdit);
      if (rationale) openRationaleModal(critiqueById(rationale.critiqueId), rationale, button);
    });
  });
  host.querySelectorAll("[data-rationale-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const rationale = state.rationales.find((item) => item.id === button.dataset.rationaleRemove);
      state.rationales = state.rationales.filter((item) => item.id !== button.dataset.rationaleRemove);
      appendInteractionEvent({
        kind: "critique_rationale_removed",
        summary: `Removed design rationale: ${rationale?.critiqueTitle || "critique"}`,
        critiqueId: rationale?.critiqueId,
        dimension: rationale?.dimension,
      }, { synthesize: false });
      renderRationaleMemory();
      if (state.selectedCritiqueId) renderInspector();
    });
  });
}

function appendInteractionEvent(input, { synthesize = true } = {}) {
  const event = createJournalEvent({
    ...input,
    id: `event-${state.nextInteractionEventId++}`,
    version: state.version,
  });
  // Mirror every event into the uncapped, refresh-surviving study log (no-op
  // unless a study session is active). Must run before the 100-event cap below.
  recordStudyEvent(event);
  state.interactionJournal.push(event);
  state.interactionJournal = state.interactionJournal.slice(-100);
  if (synthesize && isStrongInteractionEvent(event)) schedulePreferenceSynthesis();
  return event;
}

function resetInteractionMemory() {
  clearTimeout(preferenceAgentTimer);
  preferenceAgentTimer = null;
  state.selectedVersionId = 1;
  state.interactionJournal = [];
  state.nextInteractionEventId = 1;
  state.preferenceAgent = {
    status: "idle",
    suggestions: [],
    resolved: [],
    error: null,
    lastAnalyzedEventCount: 0,
  };
}

function schedulePreferenceSynthesis() {
  if (strongInteractionEventCount(state.interactionJournal) < 2) {
    renderPreferenceMemory();
    return;
  }
  clearTimeout(preferenceAgentTimer);
  preferenceAgentTimer = setTimeout(runPreferenceAgent, 700);
}

function pendingPreferenceSuggestionDrafts() {
  return new Map(
    [...document.querySelectorAll(".context-suggestion[data-suggestion-id]")].map((card) => [
      card.dataset.suggestionId,
      card.querySelector(".context-suggestion-text")?.value.trim() || "",
    ]),
  );
}

function applyPreferenceSuggestionDrafts(suggestions, drafts) {
  return suggestions.map((suggestion) => drafts.has(suggestion.id)
    ? { ...suggestion, text: drafts.get(suggestion.id) }
    : suggestion);
}

async function runPreferenceAgent() {
  if (state.preferenceAgent.status === "analyzing") return;
  const events = state.interactionJournal.slice(-60);
  if (
    strongInteractionEventCount(events) < 2 ||
    events.length === state.preferenceAgent.lastAnalyzedEventCount
  ) {
    renderPreferenceMemory();
    return;
  }

  state.preferenceAgent.status = "analyzing";
  state.preferenceAgent.error = null;
  renderPreferenceMemory();
  try {
    const result = await inferContext({
      dashboardId: state.artifact.id || "current-dashboard",
      // Saved rationales arrive through the semantic journal below. Keep
      // CURRENT EXPLICIT CONTEXT limited to context the author confirmed in the
      // Context panel so the synthesizer does not suppress rationale-derived
      // suggestions as already saved.
      context: state.context,
      events,
      resolvedSuggestionTexts: state.preferenceAgent.resolved.map((item) => item.text),
    });
    const drafts = pendingPreferenceSuggestionDrafts();
    const mergedSuggestions = mergePendingContextSuggestions(
      state.preferenceAgent.suggestions,
      result.suggestions || [],
      state.preferenceAgent.resolved,
      state.context,
    ).map((item) => (
      item.generatedText != null ? item : { ...item, generatedText: item.text }
    ));
    state.preferenceAgent.suggestions = applyPreferenceSuggestionDrafts(mergedSuggestions, drafts);
    state.preferenceAgent.lastAnalyzedEventCount = result.analyzedEventCount ?? events.length;
    state.preferenceAgent.status = state.preferenceAgent.suggestions.length ? "ready" : "idle";
  } catch (error) {
    state.preferenceAgent.suggestions = applyPreferenceSuggestionDrafts(
      state.preferenceAgent.suggestions,
      pendingPreferenceSuggestionDrafts(),
    );
    state.preferenceAgent.status = "unavailable";
    state.preferenceAgent.error = error instanceof Error ? error.message : String(error);
  }
  renderPreferenceMemory();
  if (strongInteractionEventCount(state.interactionJournal) > strongInteractionEventCount(events)) {
    schedulePreferenceSynthesis();
  }
}

function resolvePreferenceSuggestion(suggestion, status, text) {
  state.preferenceAgent.resolved.push({
    id: suggestion.id,
    field: suggestion.field,
    text,
    status,
  });
  state.preferenceAgent.suggestions = state.preferenceAgent.suggestions
    .filter((item) => item.id !== suggestion.id);
  state.preferenceAgent.status = state.preferenceAgent.suggestions.length ? "ready" : "idle";
}

function contextFieldLabel(field) {
  return {
    goal: "Goal",
    audience: "Audience",
    constraints: "Constraints",
    notes: "Dashboard Notes",
  }[field] || "Dashboard Context";
}

function renderPreferenceMemory() {
  const host = document.getElementById("contextSuggestionList");
  const status = document.getElementById("contextMemoryStatus");
  if (!host || !status) return;
  // The preference agent can produce suggestions after the panel first rendered
  // (its updates re-render only this list, not the whole panel). Reveal the
  // Learned Context section here when it gains anything to show; the render-time
  // gate still owns the "hide until context inferred" first-run case, so this
  // only ever un-hides — it never re-hides a section the panel chose to show.
  const section = host.closest(".context-memory");
  if (section && section.hidden &&
    ((state.preferenceAgent.suggestions || []).length > 0 ||
      (state.preferenceAgent.resolved || []).some((item) => item.status === "accepted") ||
      state.preferenceAgent.status === "analyzing" ||
      state.preferenceAgent.status === "unavailable")) {
    section.hidden = false;
  }
  const setStatus = (label = "", stateName = "") => {
    status.textContent = label;
    status.hidden = !label;
    status.dataset.state = stateName;
  };

  const strongCount = strongInteractionEventCount(state.interactionJournal);
  const suggestions = state.preferenceAgent.suggestions || [];
  const savedSuggestions = (state.preferenceAgent.resolved || [])
    .filter((item) => item.status === "accepted")
    .slice(-4)
    .reverse();
  const savedMarkup = savedSuggestions.length
    ? `<div class="context-saved-list" id="contextSavedList">
        ${savedSuggestions.map((item) => `
          <div class="context-saved-item">
            <span>
              <svg class="context-saved-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>
              Saved to ${escapeHTML(contextFieldLabel(item.field))}
            </span>
            <p title="${escapeHTML(item.text)}">${escapeHTML(item.text)}</p>
          </div>`).join("")}
      </div>`
    : '<div class="context-saved-list" id="contextSavedList" hidden></div>';
  let memoryNotice = "";

  if (state.preferenceAgent.status === "analyzing") {
    setStatus("Checking", "running");
    if (!suggestions.length) {
      host.innerHTML = `<div class="context-memory-state"><span>Checking recent decisions…</span></div>${savedMarkup}`;
      return;
    }
    if (host.querySelector(".context-suggestion")) return;
  }
  if (state.preferenceAgent.status === "unavailable") {
    setStatus("Paused", "error");
    memoryNotice = `
      <div class="context-memory-state warning">
        <span>Context memory is temporarily unavailable. Your recorded decisions are preserved.</span>
        <button type="button" id="retryContextMemory">Retry</button>
      </div>`;
    if (!suggestions.length) {
      host.innerHTML = memoryNotice + savedMarkup;
      document.getElementById("retryContextMemory")?.addEventListener("click", () => {
        state.preferenceAgent.lastAnalyzedEventCount = 0;
        runPreferenceAgent();
      });
      return;
    }
  }

  if (state.preferenceAgent.status !== "analyzing") {
    const labels = [
      suggestions.length ? `${suggestions.length} new` : "",
      savedSuggestions.length ? `${savedSuggestions.length} saved` : "",
    ].filter(Boolean);
    setStatus(labels.join(" · "), suggestions.length ? "count" : savedSuggestions.length ? "success" : "");
  }
  if (!suggestions.length) {
    host.innerHTML = `
      <div class="context-memory-state">
        <span>${strongCount < 2
          ? "Suggestions appear after repeated accept or reject decisions."
          : "No new reusable context found."}</span>
      </div>
      ${savedMarkup}`;
    return;
  }

  // Surface the strongest-signal suggestions first and cap what needs an explicit
  // confirm decision to two; any remainder stays available but collapsed behind a
  // small "More" disclosure so the panel never grows an unbounded confirm queue.
  // Backend already ranks + caps per call; re-sort here because suggestions
  // accumulate across calls in state.preferenceAgent.suggestions.
  const ranked = [...suggestions].sort((a, b) =>
    (b.signalStrength || 0) - (a.signalStrength || 0));
  const visibleSuggestions = ranked.slice(0, 2);
  const overflowSuggestions = ranked.slice(2);
  const suggestionCard = (suggestion) => {
    const confidenceLabel = suggestion.confidence === "supported" ? "Supported" : "Tentative";
    return `
      <article
        class="context-suggestion"
        data-suggestion-id="${escapeHTML(suggestion.id)}"
        aria-label="${confidenceLabel} suggested ${escapeHTML(suggestion.field)} context"
      >
        <span class="context-suggestion-field">${escapeHTML(contextFieldLabel(suggestion.field))}</span>
        <textarea class="context-suggestion-text" rows="1" maxlength="320" aria-label="Edit suggested ${escapeHTML(suggestion.field)} context">${escapeHTML(suggestion.text)}</textarea>
        <div class="context-suggestion-actions">
          <button type="button" class="dismiss-context-suggestion">Dismiss</button>
          <button type="button" class="accept-context-suggestion">Add as Context</button>
        </div>
      </article>`;
  };
  const overflowMarkup = overflowSuggestions.length
    ? `<details class="context-suggestion-more">
        <summary aria-label="Show ${overflowSuggestions.length} more ${overflowSuggestions.length === 1 ? "suggestion" : "suggestions"}" title="More suggestions">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>
          <span>More</span>
          <b>${overflowSuggestions.length}</b>
        </summary>
        <div class="context-suggestion-more-list">${overflowSuggestions.map(suggestionCard).join("")}</div>
      </details>`
    : "";
  host.innerHTML = memoryNotice
    + visibleSuggestions.map(suggestionCard).join("")
    + overflowMarkup
    + savedMarkup;
  document.getElementById("retryContextMemory")?.addEventListener("click", () => {
    state.preferenceAgent.lastAnalyzedEventCount = 0;
    runPreferenceAgent();
  });

  // Grow the suggestion field to fit its content instead of reserving a fixed
  // two-row block — a short one-line inference then occupies a single line.
  const autoSizeSuggestion = (textarea) => {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };
  host.querySelectorAll(".context-suggestion").forEach((card) => {
    const suggestion = suggestions.find((item) => item.id === card.dataset.suggestionId);
    if (!suggestion) return;
    const textarea = card.querySelector(".context-suggestion-text");
    autoSizeSuggestion(textarea);
    textarea.addEventListener("input", (event) => {
      suggestion.text = event.currentTarget.value;
      autoSizeSuggestion(event.currentTarget);
    });
    card.querySelector(".accept-context-suggestion").addEventListener("click", () => {
      const text = card.querySelector(".context-suggestion-text").value.trim();
      if (!text) return;
      const contextWasConfirmed = contextReadyForReview();
      state.context = mergeSuggestionIntoContext(state.context, suggestion, text);
      if (["goal", "audience", "constraints"].includes(suggestion.field)) {
        // Workspace context is one description: fold whatever field the
        // suggestion touched back into a single `goal` paragraph so the
        // confirmed fingerprint stays in sync with the context box (which only
        // round-trips `goal`). Without this, accepting an audience/constraints
        // suggestion while confirmed dead-ends the next focused review.
        state.context.goal = serializeContextBox(state.context);
        state.context.audience = "";
        state.context.constraints = "";
        state.context.fieldStatus = {
          ...state.context.fieldStatus,
          goal: state.context.goal ? "confirmed" : "missing",
          audience: "missing",
          constraints: "missing",
        };
      }
      state.context.snapshotId = null;
      if (contextWasConfirmed) {
        setContextWorkflow(CONTEXT_WORKFLOW_STATUS.CONFIRMED);
      } else {
        setContextWorkflow(CONTEXT_WORKFLOW_STATUS.NEEDS_REVIEW, {
          detail: "Suggestion saved. Confirm any other context changes before review.",
          reason: "edited",
        });
      }
      resolvePreferenceSuggestion(suggestion, "accepted", text);
      const generatedText = String(suggestion.generatedText ?? "").trim();
      appendInteractionEvent({
        kind: "inferred_context_accepted",
        summary: `Added inferred ${suggestion.field} context`,
        detail: text,
        data: {
          suggestionId: suggestion.id,
          evidenceEventIds: suggestion.evidenceEventIds,
          generatedText: generatedText || null,
          submittedText: text,
          edited: Boolean(generatedText) && generatedText !== text,
        },
      }, { synthesize: false });
      renderFixedContextPanel();
      renderContextToolState();
      const savedDestination = contextFieldLabel(suggestion.field);
      const announcement = document.getElementById("contextMemoryAnnouncement");
      if (announcement) announcement.textContent = `Saved to ${savedDestination}.`;
      document.getElementById("contextMemoryTitle")?.focus();
    });
    card.querySelector(".dismiss-context-suggestion").addEventListener("click", () => {
      const text = card.querySelector(".context-suggestion-text").value.trim() || suggestion.text;
      resolvePreferenceSuggestion(suggestion, "dismissed", text);
      appendInteractionEvent({
        kind: "inferred_context_dismissed",
        summary: `Dismissed inferred ${suggestion.field} context`,
        detail: text,
        data: { suggestionId: suggestion.id, evidenceEventIds: suggestion.evidenceEventIds },
      }, { synthesize: false });
      renderPreferenceMemory();
    });
  });
  // Overflow cards live inside a collapsed <details>, where scrollHeight reads 0
  // until it opens — re-size their fields once the disclosure expands.
  host.querySelector(".context-suggestion-more")?.addEventListener("toggle", (event) => {
    if (!event.currentTarget.open) return;
    event.currentTarget
      .querySelectorAll(".context-suggestion-text")
      .forEach(autoSizeSuggestion);
  });
}

function syncSidebarComponents() {
  const componentLabels = { search: "Search", history: "Critique History", rubric: "Criterion Coverage" };
  document.querySelectorAll("[data-popover-name]").forEach((panel) => {
    const name = panel.dataset.popoverName;
    const pinned = state.pinnedSidebarComponent === name;
    const open = state.sidebarPopover === name;
    panel.hidden = !pinned && !open;
    panel.classList.toggle("pinned", pinned);
  });
  document.querySelectorAll("[data-sidebar-popover]").forEach((button) => {
    const visible = [state.sidebarPopover, state.pinnedSidebarComponent].includes(button.dataset.sidebarPopover);
    button.classList.toggle("active", visible);
    button.setAttribute("aria-expanded", String(visible));
  });
  document.querySelectorAll("[data-pin-sidebar-component]").forEach((button) => {
    const pinned = state.pinnedSidebarComponent === button.dataset.pinSidebarComponent;
    button.classList.toggle("active", pinned);
    button.setAttribute("aria-pressed", String(pinned));
    button.setAttribute("aria-label", `${pinned ? "Unpin" : "Pin"} ${componentLabels[button.dataset.pinSidebarComponent]}`);
  });
}

function closeSidebarPopovers({ restoreFocus = true } = {}) {
  const currentName = state.sidebarPopover;
  const currentPanel = currentName
    ? document.querySelector(`[data-popover-name="${currentName}"]`)
    : null;
  const focusWasInside = currentPanel?.contains(document.activeElement);
  state.sidebarPopover = null;
  syncSidebarComponents();
  if (restoreFocus && focusWasInside) {
    document.querySelector(`[data-sidebar-popover="${currentName}"]`)?.focus();
  }
}

function openSidebarPopover(name, { focus = true, toggle = true } = {}) {
  const panel = document.querySelector(`[data-popover-name="${name}"]`);
  const button = document.querySelector(`[data-sidebar-popover="${name}"]`);
  if (!panel || !button) return;
  if (state.pinnedSidebarComponent === name) {
    if (focus) {
      const focusTarget = name === "search"
        ? document.getElementById("searchInput")
        : panel.querySelector("[data-pin-sidebar-component], [data-close-sidebar-popover]");
      focusTarget?.focus();
    }
    return;
  }
  if (state.sidebarPopover === name) {
    if (toggle) closeSidebarPopovers();
    return;
  }
  closeSidebarPopovers({ restoreFocus: false });
  state.sidebarPopover = name;
  syncSidebarComponents();
  if (focus) {
    const focusTarget = name === "search"
      ? document.getElementById("searchInput")
      : panel.querySelector("[data-pin-sidebar-component]");
    focusTarget?.focus();
  }
}

function closeSidebarComponent(name) {
  if (state.sidebarPopover === name) state.sidebarPopover = null;
  if (state.pinnedSidebarComponent === name) state.pinnedSidebarComponent = null;
  syncSidebarComponents();
  document.querySelector(`[data-sidebar-popover="${name}"]`)?.focus();
}

function togglePinnedSidebarComponent(name) {
  if (state.pinnedSidebarComponent === name) {
    state.pinnedSidebarComponent = null;
    state.sidebarPopover = name;
  } else {
    state.pinnedSidebarComponent = name;
    state.sidebarPopover = null;
  }
  syncSidebarComponents();
  document.querySelector(`[data-pin-sidebar-component="${name}"]`)?.focus();
}

// Revision checkpoints remain attached to the canvas and expand in place.
function applyDrawers() {
  const vh = document.querySelector(".version-history");
  const body = document.getElementById("revisionDockBody");
  const toggle = document.getElementById("revisionDockToggle");
  if (!vh || !body || !toggle) return;
  vh.classList.toggle("expanded", state.drawers.versions);
  body.hidden = !state.drawers.versions;
  toggle.setAttribute("aria-expanded", String(state.drawers.versions));
  els.canvasViewport.classList.add("revision-reflowing");
  requestAnimationFrame(() => {
    fitCanvas();
    window.setTimeout(() => {
      els.canvasViewport.classList.remove("revision-reflowing");
    }, 240);
  });
}

const CRITERION_OUTCOME_LABEL = {
  evaluated_issue: "ISSUE",
  evaluated_no_issue: "NO ISSUE",
  not_evaluated_missing_context: "NEEDS CONTEXT",
  out_of_scope: "OUT OF SCOPE",
  unsupported: "UNSUPPORTED",
};

function criterionDisplayName(id) {
  return String(id || "criterion")
    .split(".")
    .pop()
    .replaceAll("-", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// Coverage console: explicit outcomes replace the old detector pass/fail list.
function renderRubrics() {
  const host = document.getElementById("rubricList");
  if (!host) return;
  if (!state.criterionEvaluations.length) {
    host.innerHTML = `<div class="empty-state small">Run AI Assist to evaluate the criteria supported by available evidence and context.</div>`;
    return;
  }
  host.innerHTML = state.criterionEvaluations.map((evaluation) => `
    <div class="rubric-item ${escapeHTML(evaluation.outcome)}">
      <span class="rubric-dot"></span>
      <span class="rubric-label" title="${escapeHTML(evaluation.rationale || "")}">${escapeHTML(criterionDisplayName(evaluation.criterionId))}</span>
      <b>${escapeHTML(CRITERION_OUTCOME_LABEL[evaluation.outcome] || evaluation.outcome)}</b>
    </div>`).join("");
}

// Human phrasing for the inferred dashboard genre, appended to the generated
// context paragraph so the author sees which genre lens the review is using.
// The discrete state.context.dashboardType (not this prose) is what actually
// drives review strictness; this sentence is display only.
const DASHBOARD_TYPE_DESCRIPTIONS = {
  analytical: "an analytical dashboard for open exploration and pattern-finding",
  operational: "an operational dashboard for at-a-glance status monitoring",
  infographic: "an infographic that tells one story with an explicit takeaway",
  executive: "an executive summary highlighting the so-what for decision-makers",
};

// Fold the scaffold's inferred goal + audience into one natural-language
// description — the box holds a single paragraph covering both, with no
// "Goal:" / "Audience:" labels — then note the inferred genre at the end.
function inferredContextDescription(context = {}) {
  const base = serializeContextBox({ goal: context.goal, audience: context.audience });
  const genre = DASHBOARD_TYPE_DESCRIPTIONS[context.dashboardType];
  if (!genre) return base;
  const genreSentence = `VIZier read this as ${genre}.`;
  return base ? `${base} ${genreSentence}` : genreSentence;
}

function rememberGeneratedStudyContext(input = {}) {
  const goal = String(input.goal ?? "").trim();
  const audience = String(input.audience ?? "").trim();
  const constraints = String(input.constraints ?? "").trim();
  const text = String(input.text ?? serializeContextBox({ goal, audience, constraints })).trim();
  state.studyContextGenerated = {
    source: input.source || "ai",
    text,
    goal: goal || null,
    audience: audience || null,
    constraints: constraints || null,
  };
}

function contextSavedStudyData(extra = {}) {
  const submittedText = String(extra.submittedText ?? state.context.goal ?? "").trim();
  const generatedText = String(state.studyContextGenerated?.text ?? "").trim();
  const edited = Boolean(generatedText) && generatedText !== submittedText;
  let origin = "none";
  if (submittedText && generatedText) origin = edited ? "ai-edited" : "ai-unchanged";
  else if (submittedText) origin = "user-written";
  else if (generatedText) origin = "ai-cleared";
  const data = {
    scope: [...(state.context.scope || [])],
    hasContext: Boolean(submittedText),
    generatedText: generatedText || null,
    submittedText: submittedText || null,
    edited,
    origin,
    generatedSource: state.studyContextGenerated?.source || null,
  };
  if (extra.generatedFields) data.generatedFields = extra.generatedFields;
  if (extra.submittedFields) data.submittedFields = extra.submittedFields;
  return data;
}

function nextStudyContextVersion() {
  state.studyContextVersion = (Number(state.studyContextVersion) || 0) + 1;
  return state.studyContextVersion;
}

function contextSaveOutcome(saveData) {
  return saveData?.hasContext ? "confirmed" : "continued_without_context";
}

function contextSaveSource(saveData) {
  const origin = saveData?.origin;
  if (origin === "user-written") return "manual";
  if (origin === "ai-unchanged" || origin === "ai-edited") return "generated";
  if (saveData?.generatedSource) return "inferred";
  return "manual";
}

function withContextSaveStudyFields(saveData) {
  return {
    ...saveData,
    outcome: contextSaveOutcome(saveData),
    contextVersion: bumpStudyContextVersion() || nextStudyContextVersion(),
    source: contextSaveSource(saveData),
  };
}

async function withContextGenerationTelemetry(source, work) {
  const generationId = newStudyId();
  const startedAt = Date.now();
  recordStudyAction("context_generation_requested", "Asked VIZier to describe the dashboard context", {
    source,
    generationId,
  });
  try {
    const result = await work();
    recordStudyAction("context_generation_completed", "Dashboard context generation finished", {
      source,
      generationId,
      latencyMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordStudyAction("context_generation_failed", "Dashboard context generation failed", {
      source,
      generationId,
      latencyMs: Date.now() - startedAt,
      reason: message,
    });
    throw error;
  }
}

function critiqueRequestMode({ focusedRequest, trigger, hadPrior, local } = {}) {
  if (local) return "local";
  if (trigger === "stale-dashboard-recovery" || trigger === "stale-context-recovery") {
    return "stale_recovery";
  }
  if (focusedRequest) return "focused_ask";
  return hadPrior ? "regenerate_all" : "generate";
}

function critiqueRequestStudyData({
  requestId,
  requestMode,
  scope,
  askId = null,
  queryText = null,
  bounds = null,
  trigger = null,
  critiqueId = null,
  parentRequestId = null,
} = {}) {
  const link = takeStudyRequestLink(requestId);
  return {
    requestId: link.requestId,
    requestMode,
    askId,
    dashboardId: state.artifact?.id || state.artifact?.libraryId || null,
    dashboardVersion: Number(state.version) || 1,
    scope,
    bounds: bounds || null,
    queryText: queryText || null,
    requestText: queryText || null,
    parentRequestId: parentRequestId || link.parentRequestId,
    trigger: trigger || null,
    critiqueId: critiqueId || null,
    hadPriorCritiques: state.critiques.length > 0,
    priorCritiqueCount: state.critiques.length,
    activeScopes: [...(state.context.scope || [])],
  };
}

function classifyDashboardOperation(changedTargets = [], critiques = []) {
  const kinds = new Set((critiques || []).map((critique) => critique?.proposal?.kind).filter(Boolean));
  const targets = (changedTargets || []).map((target) => String(target).toLowerCase());
  if ([...kinds].some((kind) => /cross-filter|filter|interaction/.test(kind))
    || targets.some((target) => /filter|interaction/.test(target))) {
    return "interaction";
  }
  if ([...kinds].some((kind) => /encod/.test(kind)) || targets.some((target) => /encod/.test(target))) {
    return "encoding";
  }
  if (targets.some((target) => /title|subtitle|text|label/.test(target))) return "text";
  if (targets.some((target) => /style|color|theme|kpi/.test(target))) return "style";
  if (targets.some((target) => /bound|layout|position/.test(target))) return "layout";
  if (targets.some((target) => /filter/.test(target))) return "filter";
  return "other";
}

function recordDashboardChanged({
  changeId = null,
  source,
  operation,
  targetIds = [],
  beforeVersion,
  afterVersion,
  relatedCritiqueIds = [],
  relatedApplyId = null,
  diffSummary = null,
} = {}) {
  const id = changeId || newStudyId();
  recordStudyAction("dashboard_changed", `Dashboard changed via ${source}`, {
    changeId: id,
    source,
    operation: operation || "other",
    targetIds,
    beforeVersion,
    afterVersion,
    relatedCritiqueIds,
    relatedApplyId,
    diffSummary: diffSummary || {},
  });
  return id;
}

function latestRationaleText(critiqueId) {
  const items = (state.rationales || []).filter((item) => item.critiqueId === critiqueId);
  return items.at(-1)?.text || null;
}

function markCritiqueInspected(critiqueId) {
  state.critiqueInspect = {
    critiqueId: critiqueId || null,
    openedAtMs: Date.now(),
  };
}

function critiqueInspectDwellMs(critiqueId = null) {
  const current = state.critiqueInspect;
  if (!current?.openedAtMs) return null;
  if (critiqueId && current.critiqueId !== critiqueId) return null;
  return Math.max(0, Date.now() - current.openedAtMs);
}

function protocolRequestScope(requestMode) {
  if (requestMode === "local") return "region";
  if (requestMode === "stale_recovery") return "critique";
  return "dashboard";
}

// Task 6: light up the context field's edge while VIZier is generating. The
// manual regenerate runs without a re-render, so the class is toggled directly;
// the auto-on-upload path re-renders and adds the class from the GENERATING
// workflow status instead (see renderFixedContextPanel).
function setContextInferring(active) {
  document
    .querySelector('.context-merged[data-context-scope="workspace"] .context-box-field')
    ?.classList.toggle("is-generating", active);
}

function setFocusedReviewGenerating(active) {
  const wrap = document.querySelector(".focused-review-input-wrap");
  const input = document.getElementById("focusedReviewInput");
  wrap?.classList.toggle("is-generating", active);
  if (wrap) wrap.setAttribute("aria-busy", String(active));
  if (input) input.disabled = active;
}

// Context is read live into state and reflected by the left-rail status dot.
function readBriefIntoState({ confirmEditedFields = true } = {}) {
  const box = document.getElementById("briefContextBox");
  if (!box) return;
  const parsed = parseContextBox(box.value);
  state.context.goal = parsed.goal;
  state.context.audience = parsed.audience;
  state.context.constraints = parsed.constraints;
  if (confirmEditedFields) {
    // Editing the one box is a deliberate author edit: every field that has
    // text reads as confirmed; empty ones are missing.
    state.context.fieldStatus = Object.fromEntries(
      ["goal", "audience", "constraints"].map((field) =>
        [field, state.context[field] ? "confirmed" : "missing"]),
    );
    state.context.snapshotId = null;
    syncContextFieldStatusBadges();
  }
  state.context.scope = [...document.querySelectorAll('#briefScope input[name="briefScope"]:checked')].map((c) => c.value);
  renderContextToolState();
}

// A compact status line beside the box header summarizes the fields' state
// (inferred / confirmed / missing) now that per-field badges are gone.
function syncContextFieldStatusBadges() {
  const el = document.getElementById("contextBoxStatus");
  if (!el) return;
  const status = state.context.fieldStatus || {};
  const present = CONTEXT_BOX_FIELDS.filter((f) => (state.context[f.key] || "").trim());
  if (!present.length) {
    el.hidden = true;
    return;
  }
  const allConfirmed = present.every((f) => status[f.key] === "confirmed");
  const anyInferred = present.some((f) => status[f.key] === "inferred");
  el.hidden = false;
  el.dataset.state = allConfirmed ? "confirmed" : anyInferred ? "inferred" : "edited";
  el.textContent = allConfirmed ? "Confirmed" : anyInferred ? "Inferred · review" : "Edited";
}

function renderContextToolState() {
  const button = document.getElementById("contextToolButton");
  if (!button) return;
  const summary = String(state.context.goal || "").trim();
  const configured = Boolean(
    summary ||
    state.context.notes?.length ||
    state.reviewRequest,
  );
  button.classList.toggle("configured", configured);
  button.setAttribute("aria-label", configured
    ? `Workspace context. Current context: ${summary || state.reviewRequest || "Additional context added"}`
    : "Workspace context. No context added yet");
}

// Hover definition for each Feedback Scope chip, adapted (lightly reworded) from
// the object codebook (slack_codebook/object_groups.csv), so a reader can recall
// what a scope covers without leaving the panel. Carried on the chip as a
// data-scope-tip attribute and rendered by a floating tooltip portaled to the
// body (see initScopeTooltip) — a fixed-position bubble escapes the panel's
// scroll overflow, which would clip a CSS ::after bubble, and shows instantly
// instead of the browser's slow, unstyled native title.
const SCOPE_DEFINITIONS = {
  chart: "A data-encoding view — how values are drawn as bars, lines, maps, and so on.",
  color: "Color choices and how they're used to encode or emphasize.",
  layout: "Spatial arrangement and organization of the views.",
  data: "The data shown — its scope, granularity, and relationships.",
  text: "Text elements: labels, annotations, titles, and formatting.",
  "visual design": "High-level design — visual polish, look, and feel.",
  cognition: "Cognitive load — how much a viewer must process at once.",
  context: "Interpretive context — data source, assumptions, and metric meaning.",
  interaction: "Interaction affordances — filters, hovers, and controls.",
  task: "How well the dashboard supports the viewer's analytical goals.",
  "design process": "Authoring practices and strategy behind the dashboard.",
};

// One chip per recommendation branch, unchanged in value/behavior, but visually
// gathered under its object cluster (SCOPE_CLUSTERS). The clustering is display
// only — each chip still toggles its own branch into state.context.scope, so
// scopeRank and the #briefScope collect/sync selectors are unaffected.
function scopeChipMarkup(key, selected) {
  const presentation = categoryPresentation(key);
  const definition = SCOPE_DEFINITIONS[key];
  const tipAttr = definition ? ` data-scope-tip="${escapeHTML(definition)}"` : "";
  return `
      <label class="scope-chip" style="--scope-color:${presentation.color};--scope-soft:${presentation.soft}"${tipAttr}>
        <input type="checkbox" name="briefScope" value="${escapeHTML(key)}" ${selected.has(key) ? "checked" : ""} />
        <span>${escapeHTML(presentation.label)}</span>
      </label>`;
}

// Floating definition tooltip for Feedback Scope chips. The chips live inside
// .context-panel-content, whose scroll overflow clips a CSS ::after bubble, so
// the tooltip is a single fixed-position element portaled to <body> and placed
// against the hovered/focused chip's rect — that escapes the clip entirely.
// Handlers are delegated on document and bound once (initScopeTooltip), so the
// frequent panel re-renders never need to rebind them.
let scopeTooltipEl = null;
let scopeTooltipAnchor = null;

function ensureScopeTooltipEl() {
  if (scopeTooltipEl && document.body.contains(scopeTooltipEl)) return scopeTooltipEl;
  scopeTooltipEl = document.createElement("div");
  scopeTooltipEl.id = "scopeTooltip";
  scopeTooltipEl.className = "scope-tooltip";
  scopeTooltipEl.setAttribute("role", "tooltip");
  document.body.appendChild(scopeTooltipEl);
  return scopeTooltipEl;
}

function positionScopeTooltip(tip, anchor) {
  const rect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const margin = 8;
  const gap = 8;
  // Context-section help icons ("i") sit in the narrow left panel and open to
  // the RIGHT of the icon (matching Focused Review's inline help, but portaled
  // so the panel's scroll overflow can't clip them). Everything else — the
  // Feedback Scope chips — opens above the anchor.
  if (anchor.classList.contains("context-help")) {
    let left = rect.right + gap;
    // Flip to the left of the icon when the bubble would overrun the viewport.
    if (left + tipRect.width > window.innerWidth - margin) {
      left = rect.left - gap - tipRect.width;
    }
    left = Math.max(margin, left);
    let top = rect.top + (rect.height - tipRect.height) / 2;
    top = Math.max(margin, Math.min(top, window.innerHeight - tipRect.height - margin));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.dataset.placement = "right";
    return;
  }
  let left = rect.left + (rect.width - tipRect.width) / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
  // Prefer opening above the chip (keeps the row of chips below uncovered);
  // flip below when there isn't room near the top of the viewport.
  let top = rect.top - tipRect.height - gap;
  let placement = "top";
  if (top < margin) {
    top = rect.bottom + gap;
    placement = "bottom";
  }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.dataset.placement = placement;
}

function showScopeTooltip(anchor, { describe = false } = {}) {
  const text = anchor.getAttribute("data-scope-tip") ?? anchor.getAttribute("data-help");
  if (!text) return;
  const tip = ensureScopeTooltipEl();
  scopeTooltipAnchor = anchor;
  tip.textContent = text;
  // Measure while still transparent (visibility handled by the class), then
  // position, then reveal — so it never flashes at a stale location.
  positionScopeTooltip(tip, anchor);
  tip.classList.add("is-visible");
  // Announce to assistive tech for keyboard users; the visible label already
  // names the chip, so this is only wired on focus, not on every hover.
  if (describe) anchor.querySelector("input")?.setAttribute("aria-describedby", "scopeTooltip");
}

function hideScopeTooltip(anchor) {
  if (anchor && anchor !== scopeTooltipAnchor) return;
  if (scopeTooltipAnchor) {
    scopeTooltipAnchor.querySelector("input")?.removeAttribute("aria-describedby");
  }
  scopeTooltipAnchor = null;
  if (scopeTooltipEl) scopeTooltipEl.classList.remove("is-visible");
}

function initScopeTooltip() {
  // Two anchor kinds share the one portaled bubble: Feedback Scope chips (open
  // above) and context-section help icons (.context-help, open right). Both live
  // inside .context-panel-content, whose scroll overflow would clip a CSS bubble.
  const chipFrom = (event) =>
    event.target?.closest?.(".scope-chip[data-scope-tip], .context-help[data-help]");
  document.addEventListener("mouseover", (event) => {
    const chip = chipFrom(event);
    if (chip) showScopeTooltip(chip);
  });
  document.addEventListener("mouseout", (event) => {
    const chip = chipFrom(event);
    if (chip && !chip.contains(event.relatedTarget)) hideScopeTooltip(chip);
  });
  document.addEventListener("focusin", (event) => {
    const chip = chipFrom(event);
    if (chip) showScopeTooltip(chip, { describe: true });
  });
  document.addEventListener("focusout", (event) => {
    const chip = chipFrom(event);
    if (chip) hideScopeTooltip(chip);
  });
  // A fixed tooltip would visually detach if the panel scrolls or the window
  // resizes while it is open, so dismiss it and let the next hover re-place it.
  document.addEventListener("scroll", () => hideScopeTooltip(scopeTooltipAnchor), true);
  window.addEventListener("resize", () => hideScopeTooltip(scopeTooltipAnchor));
}

function feedbackScopeMarkup() {
  const selected = new Set(state.context.scope || []);
  const clustered = SCOPE_CLUSTERS.map((cluster) => {
    const chips = cluster.branches.map((key) => scopeChipMarkup(key, selected)).join("");
    if (!chips) return "";
    return `
      <div class="scope-cluster" role="group" aria-label="${escapeHTML(cluster.label)}">
        <span class="scope-cluster-label">${escapeHTML(cluster.label)}</span>
        <div class="scope-cluster-chips">${chips}</div>
      </div>`;
  }).join("");
  const customChips = (state.context.customTypes || []).map((label) => {
    const key = customScopeKey(label);
    const presentation = customScopePresentation(label);
    return `
      <span class="custom-scope-chip" style="--scope-color:${presentation.color};--scope-soft:${presentation.soft}">
        <label class="scope-chip" data-scope-tip="Custom feedback scope you added.">
          <input type="checkbox" name="briefScope" value="${escapeHTML(key)}" ${selected.has(key) ? "checked" : ""} />
          <span>${escapeHTML(label)}</span>
        </label>
        <button type="button" class="remove-custom-scope" data-remove-custom-scope="${escapeHTML(label)}" aria-label="Remove ${escapeHTML(label)} scope">×</button>
      </span>`;
  }).join("");
  const custom = customChips
    ? `
      <div class="scope-cluster scope-cluster-custom" role="group" aria-label="custom">
        <span class="scope-cluster-label">custom</span>
        <div class="scope-cluster-chips">${customChips}</div>
      </div>`
    : "";
  return clustered + custom;
}

function rerankForUpdatedScope() {
  if (state.critiques.length) state.critiques = scopeRank(state.critiques);
  const selected = critiqueById(state.selectedCritiqueId);
  const selectedWasHidden = selected && !critiqueMatchesFilters(selected);
  if (selectedWasHidden) {
    state.selectedCritiqueId = null;
    state.selectedTileId = null;
  }
  renderCritiques();
  renderMarkers();
  if (selectedWasHidden) void renderInspector();
}

function addCustomFeedbackScope() {
  const input = document.getElementById("customScopeInput");
  const error = document.getElementById("customScopeError");
  const label = input?.value.replace(/\s+/g, " ").trim();
  if (!input || !error || !label) {
    input?.focus();
    return;
  }
  const standardLabels = Object.entries(CATEGORY_PRESENTATIONS)
    .flatMap(([key, item]) => [key.toLowerCase(), item.label.toLowerCase()]);
  const customTypes = state.context.customTypes || [];
  const duplicate = standardLabels.includes(label.toLowerCase()) ||
    customTypes.some((item) =>
      item.toLowerCase() === label.toLowerCase() ||
      customScopeKey(item) === customScopeKey(label));
  if (duplicate) {
    error.textContent = "That scope already exists.";
    error.hidden = false;
    input.focus();
    return;
  }
  state.context.customTypes = [...customTypes, label];
  state.context.scope = [...new Set([...(state.context.scope || []), customScopeKey(label)])];
  markContextNeedsReview("Your feedback scope changed. Confirm which criteria the next review should cover.", "scope");
  renderFixedContextPanel();
  rerankForUpdatedScope();
  updateContextSaveState();
}

function stopContextExtractionHints() {
  clearInterval(contextHintTimer);
  contextHintTimer = null;
  contextHintIndex = 0;
}

function startContextExtractionHints() {
  stopContextExtractionHints();
  contextHintTimer = setInterval(() => {
    const hintEl = document.getElementById("contextExtractHint");
    if (!hintEl) { stopContextExtractionHints(); return; }
    contextHintIndex = (contextHintIndex + 1) % CONTEXT_EXTRACTION_HINTS.length;
    hintEl.classList.add("swap");
    setTimeout(() => {
      const stillMounted = document.getElementById("contextExtractHint");
      if (!stillMounted) return;
      stillMounted.textContent = CONTEXT_EXTRACTION_HINTS[contextHintIndex];
      stillMounted.classList.remove("swap");
    }, 220);
  }, 2200);
}

// The header sits in a narrow panel, so the confirm action wears a compact
// label. The full-length intent is preserved on the button's aria-label/title.
function shortConfirmLabel(actionLabel) {
  if (/without context/i.test(actionLabel)) return "Continue";
  if (/confirm/i.test(actionLabel)) return "Confirm";
  return actionLabel;
}

// A design document is still being read/parsed into hard constraints. Context
// must not be confirmed mid-extraction, because the constraint set that will
// silently filter the review is not settled yet.
function designDocIsProcessing() {
  return state.designDoc?.status === "loading";
}

function updateContextWorkflowControls() {
  const presentation = contextWorkflowPresentation(state.contextWorkflow, state.context);
  const status = document.getElementById("contextWorkflowStatus");
  if (status) {
    const generating = presentation.tone === "generating";
    const alreadyGenerating = generating && status.dataset.state === "generating";
    status.className = `context-workflow-status ${presentation.tone}`;
    status.setAttribute("data-state", presentation.tone);
    if (!alreadyGenerating) {
      status.innerHTML = `
        <span class="context-workflow-icon" aria-hidden="true">${presentation.tone === "confirmed"
            ? "✓"
            : presentation.tone === "error"
              ? "!"
              : "✦"}</span>
        <div class="context-workflow-copy">
          <strong>${escapeHTML(presentation.title)}</strong>
          ${presentation.description ? `<p>${escapeHTML(presentation.description)}</p>` : ""}
          ${generating ? `
            <p class="context-extract-steps" role="status" aria-live="off">
              <span class="context-extract-hint" id="contextExtractHint">${escapeHTML(CONTEXT_EXTRACTION_HINTS[0])}</span>
              <span class="context-extract-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            </p>` : ""}
          ${presentation.tone === "error" ? '<button type="button" class="context-retry-button" id="retryContextInferenceBtn">Retry inference</button>' : ""}
        </div>`;
      document.getElementById("retryContextInferenceBtn")?.addEventListener("click", () => {
        void inferContextOnUpload();
      });
      if (generating) startContextExtractionHints();
      else stopContextExtractionHints();
    }
  }
  // The Confirm action now lives in a persistent footer at the bottom of the
  // panel (not regenerated with the status header), so bind it once — the guard
  // in bindContextConfirmationButton() makes repeat calls a no-op.
  bindContextConfirmationButton();

  const generating = state.contextWorkflow.status === CONTEXT_WORKFLOW_STATUS.GENERATING;
  document.querySelectorAll([
    "#briefContextBox",
    '#briefScope input[name="briefScope"]',
    "#contextInferBtn",
    "#scopeAddTrigger",
    "#scopeAddConfirm",
  ].join(",")).forEach((control) => { control.disabled = generating; });

  const confirmButton = document.getElementById("saveContextBtn");
  const confirmLabel = document.getElementById("contextConfirmLabel");
  // Block confirmation while a design document is still being read, so the
  // constraint set that filters the review is settled before context is locked.
  const docProcessing = designDocIsProcessing();
  const hasScope = (state.context.scope || []).length > 0;
  if (confirmButton) {
    // The action lives in the panel's bottom footer and only shows when there
    // is an action to take — hidden (and the footer collapses) while extracting,
    // confirmed, or idle.
    confirmButton.hidden = presentation.actionDisabled;
    confirmButton.disabled = presentation.actionDisabled || docProcessing || !hasScope;
    confirmButton.classList.toggle("confirmed", presentation.tone === "confirmed");
    confirmButton.setAttribute("aria-label", presentation.actionPrompt || presentation.actionLabel);
    confirmButton.title = !hasScope
      ? "Choose at least one Feedback Scope before confirming."
      : docProcessing
      ? "Reading the design document — confirm once it finishes."
      : presentation.actionHint || "";
  }
  // Short inline label — the full intent lives in the button's aria-label/title.
  if (confirmLabel) confirmLabel.textContent = docProcessing ? "Reading…" : shortConfirmLabel(presentation.actionLabel);
  syncFeedbackScopeStatus();
  syncReviewReadiness();
}

// Render context in the fixed left panel
function renderFixedContextPanel() {
  const content = document.getElementById("contextPanelBody");
  if (!content) return;
  // Re-rendering replaces the scope chips, so drop any open tooltip rather than
  // leave it pointing at a chip that no longer exists.
  hideScopeTooltip();

  // The two memory sections stay out of the panel until they are earned, so a
  // first run is not fronted by two empty coaching boxes. Saved Rationale
  // appears once the author saves their first rationale. Learned Context waits
  // until the preference agent actually has something — it produced a
  // suggestion, the author saved one, or it is mid-analysis — so the section
  // only appears once the author's interactions have given the backend
  // something to reason about, never merely because context was inferred or
  // confirmed on a fresh dashboard.
  const showSavedRationale = state.rationales.length > 0;
  const showLearnedContext =
    (state.preferenceAgent.suggestions || []).length > 0 ||
    (state.preferenceAgent.resolved || []).some((item) => item.status === "accepted") ||
    state.preferenceAgent.status === "analyzing" ||
    state.preferenceAgent.status === "unavailable";

  content.innerHTML = `
    <div class="context-merged" data-context-scope="workspace">
      <div class="context-merged-head">
        <div class="context-memory-title">
          <span class="context-merged-title">Dashboard Context</span>
          <button type="button" class="context-help" aria-label="About Dashboard Context" data-help="What this dashboard is for and who reads it. VIZier uses this context to ground every review and suggestion.">i</button>
        </div>
        <span class="context-box-status" id="contextBoxStatus" hidden></span>
        <button type="button" class="ai-trigger-icon context-infer-btn" id="contextInferBtn" data-tooltip="Describe this dashboard's context from the dashboard" aria-label="Describe this dashboard's context">${AI_ACTION_ICON}</button>
      </div>
      <div class="context-merged-body">
        <div class="brief-field context-box-field ai-assisted-field${state.contextWorkflow.status === CONTEXT_WORKFLOW_STATUS.GENERATING ? " is-generating" : ""}">
          <textarea id="briefContextBox" class="context-box-input" rows="6" aria-label="Dashboard context — what the dashboard is for and who uses it" placeholder="${escapeHTML(CONTEXT_BOX_PLACEHOLDER)}"></textarea>
        </div>
      </div>
      <p class="context-describe-error" id="contextInferError" role="alert" hidden></p>
    </div>

    ${designDocControlMarkup("workspace")}

    <div class="brief-field brief-scope-field">
      <div class="context-section-heading"><div class="context-memory-title"><strong>Feedback Scope</strong><button type="button" class="context-help" aria-label="About Feedback Scope" data-help="The areas VIZier reviews. Turn scopes on or off to focus the feedback, or add your own.">i</button></div></div>
      <div class="brief-scope" id="briefScope">
        ${feedbackScopeMarkup()}
      </div>
      <p class="context-merged-status scope-selection-status" id="scopeSelectionStatus" role="status" aria-live="polite"></p>
      <div class="scope-add-control">
        <button type="button" class="scope-add-trigger" id="scopeAddTrigger">
          <span aria-hidden="true">＋</span> Add Scope
        </button>
        <div class="scope-add-editor" id="scopeAddEditor" hidden>
          <input id="customScopeInput" maxlength="32" placeholder="e.g., Brand consistency" aria-label="Custom feedback scope" />
          <button type="button" class="scope-add-confirm" id="scopeAddConfirm">Add</button>
          <button type="button" class="scope-add-cancel" id="scopeAddCancel" aria-label="Cancel adding scope">×</button>
        </div>
        <p class="scope-add-error" id="customScopeError" role="alert" hidden></p>
      </div>
    </div>

    <section class="rationale-memory" aria-labelledby="rationaleMemoryTitle" ${showSavedRationale ? "" : "hidden"}>
      <div class="rationale-memory-head context-section-heading">
        <strong id="rationaleMemoryTitle">Saved Rationale</strong>
        <span class="context-section-count" id="rationaleCount" ${state.rationales.length ? "" : "hidden"}>${state.rationales.length || ""}</span>
      </div>
      <div class="rationale-list" id="rationaleList"></div>
    </section>

    <section class="context-memory" aria-labelledby="contextMemoryTitle" ${showLearnedContext ? "" : "hidden"}>
      <div class="context-memory-head context-section-heading">
        <div class="context-memory-title">
          <strong id="contextMemoryTitle" tabindex="-1">Learned Context</strong>
          <button
            class="inline-help"
            type="button"
            data-help="From repeated decisions, VIZier infers reusable context — a goal, audience, priority, preference, or recurring concern. You confirm every suggestion."
            aria-label="About Learned Context: from repeated decisions, VIZier infers reusable context — a goal, audience, priority, preference, or recurring concern. You confirm every suggestion."
          >i</button>
        </div>
        <span class="context-section-status" id="contextMemoryStatus" hidden></span>
      </div>
      <div class="context-suggestion-list" id="contextSuggestionList"></div>
    </section>

    <section class="focused-review-composer" aria-labelledby="focusedReviewTitle">
      <div class="focused-review-heading context-section-heading">
        <div class="context-memory-title">
          <strong id="focusedReviewTitle">Focused Review</strong>
          <button
            class="inline-help"
            type="button"
            data-help="Ask one question about the current dashboard and get a single focused answer, grounded in the confirmed context — separate from the full criteria review."
            aria-label="About Focused Review: ask one question about the current dashboard and get a single focused answer, grounded in the confirmed context — separate from the full criteria review."
          >i</button>
        </div>
        <span class="optional-label">Optional</span>
        <span class="context-section-status" id="focusedReviewState" hidden></span>
      </div>
      <div class="focused-review-input-wrap${state.focusedReviewRunning ? " is-generating" : ""}"${state.focusedReviewRunning ? ` aria-busy="true"` : ""}>
        <textarea
          id="focusedReviewInput"
          rows="3"
          maxlength="600"
          placeholder="e.g., Does this chart make department differences easy to compare?"
          ${state.focusedReviewRunning ? "disabled" : ""}
        >${escapeHTML(state.reviewRequest)}</textarea>
        <button type="button" class="focused-review-send" id="runFocusedReviewBtn" aria-label="Ask VIZier" title="Ask VIZier" ${state.reviewRequest.trim().length >= 3 && !state.focusedReviewRunning ? "" : "disabled"}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M9 4.5 12.5 8 9 11.5"/></svg>
        </button>
      </div>
      <p class="focused-review-error" id="focusedReviewError" role="alert" hidden></p>
    </section>

  `;

  // Sync with current context state
  document.getElementById("briefContextBox").value = serializeContextBox(state.context);
  syncContextFieldStatusBadges();
  document.querySelectorAll('#briefScope input[name="briefScope"]').forEach((c) => {
    c.checked = (state.context.scope || []).includes(c.value);
  });

  renderRationaleMemory();
  renderPreferenceMemory();

  // Re-attach event listeners. The Confirm action lives in the persistent
  // footer (#contextConfirmFooter) and is bound once by
  // bindContextConfirmationButton(); updateContextWorkflowControls() only
  // toggles its hidden/disabled/label state.
  attachContextPanelEventListeners();
  refreshDesignDocControls();

  updateContextWorkflowControls();
}

function updateContextSaveState() {
  updateContextWorkflowControls();
}

function attachContextPanelEventListeners() {
  // Input changes — the one context box parses into goal/audience/constraints.
  document.getElementById("briefContextBox")?.addEventListener("input", () => {
    readBriefIntoState({ confirmEditedFields: true });
    markContextNeedsReview("Your edits are ready. Confirm them before starting the next review.", "edited");
    updateContextSaveState();
  });

  document.querySelectorAll('#briefScope input[name="briefScope"]').forEach(c =>
    c.addEventListener("change", () => {
      readBriefIntoState({ confirmEditedFields: false });
      markContextNeedsReview("Your feedback scope changed. Confirm which criteria the next review should cover.", "scope");
      rerankForUpdatedScope();
    }));

  document.getElementById("scopeAddTrigger")?.addEventListener("click", () => {
    document.getElementById("scopeAddTrigger").hidden = true;
    document.getElementById("scopeAddEditor").hidden = false;
    document.getElementById("customScopeInput").focus();
  });
  document.getElementById("scopeAddConfirm")?.addEventListener("click", addCustomFeedbackScope);
  document.getElementById("scopeAddCancel")?.addEventListener("click", () => {
    document.getElementById("scopeAddEditor").hidden = true;
    document.getElementById("scopeAddTrigger").hidden = false;
    document.getElementById("customScopeError").hidden = true;
  });
  document.getElementById("customScopeInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addCustomFeedbackScope();
    }
    if (event.key === "Escape") {
      document.getElementById("scopeAddCancel").click();
    }
  });
  document.querySelectorAll("[data-remove-custom-scope]").forEach((button) => {
    button.addEventListener("click", () => {
      const label = button.dataset.removeCustomScope;
      state.context.customTypes = (state.context.customTypes || []).filter((item) => item !== label);
      state.context.scope = (state.context.scope || []).filter((item) => item !== customScopeKey(label));
      markContextNeedsReview("Your feedback scope changed. Confirm which criteria the next review should cover.", "scope");
      renderFixedContextPanel();
      rerankForUpdatedScope();
    });
  });

  // The regenerate icon reads the dashboard evidence and rewrites the context
  // box with one fresh natural-language description (goal + audience combined,
  // no field labels). Regenerate always overwrites: clicking it replaces the
  // current description every time, even if the author had typed something.
  const inferButton = document.getElementById("contextInferBtn");
  const inferError = document.getElementById("contextInferError");
  inferButton?.addEventListener("click", async () => {
    if (inferError) inferError.hidden = true;
    inferButton.classList.add("running");
    inferButton.disabled = true;
    // Task 6: the field edge lights up while VIZier is generating.
    setContextInferring(true);
    try {
      const result = await withContextGenerationTelemetry("workspace", () =>
        requestScaffold("", "dashboard-draft"));
      const description = inferredContextDescription(result?.context || {});
      rememberGeneratedStudyContext({
        source: "workspace-regenerate",
        text: description,
        goal: result?.context?.goal,
        audience: result?.context?.audience,
      });
      const box = document.getElementById("briefContextBox");
      if (box) box.value = description;
      readBriefIntoState({ confirmEditedFields: false });
      // dashboardType is a discrete genre lens, not part of the free-text box,
      // so capture it straight into state where reviewContextForEngine() will
      // forward it to the engine.
      if (result?.context?.dashboardType) state.context.dashboardType = result.context.dashboardType;
      state.context.fieldStatus = {
        goal: description ? "inferred" : "missing",
        audience: "missing",
        constraints: "missing",
      };
      state.context.snapshotId = null;
      syncContextFieldStatusBadges();
      markContextNeedsReview("VIZier described your context. Review it, then confirm.", "edited");
      updateContextSaveState();
    } catch (error) {
      if (inferError) {
        const message = error instanceof Error ? error.message : String(error);
        inferError.textContent = message.includes("LLM_REQUIRED")
          ? "A model connection is required to infer context. Configure the provider and restart the backend."
          : `Could not infer context: ${message.replace(/^LLM_CALL_FAILED:\s*/, "")}`;
        inferError.hidden = false;
      }
    } finally {
      inferButton.classList.remove("running");
      inferButton.disabled = false;
      setContextInferring(false);
    }
  });

  const focusedInput = document.getElementById("focusedReviewInput");
  const focusedButton = document.getElementById("runFocusedReviewBtn");
  const focusedState = document.getElementById("focusedReviewState");
  const focusedError = document.getElementById("focusedReviewError");
  const syncFocusedReview = () => {
    if (state.focusedReviewRunning) return;
    const request = focusedInput?.value.replace(/\s+/g, " ").trim() || "";
    state.reviewRequest = request;
    if (focusedButton) focusedButton.disabled = request.length < 3 || !contextReadyForReview();
    if (focusedState) {
      focusedState.textContent = "";
      focusedState.hidden = true;
      focusedState.dataset.state = "";
    }
    if (focusedError) focusedError.hidden = true;
    renderContextToolState();
  };
  focusedInput?.addEventListener("input", syncFocusedReview);
  focusedInput?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !focusedButton?.disabled) {
      event.preventDefault();
      focusedButton.click();
    }
  });
  focusedButton?.addEventListener("click", async () => {
    const request = focusedInput?.value.replace(/\s+/g, " ").trim() || "";
    if (request.length < 3 || !contextReadyForReview()) return;
    if (state.reviewInFlight || state.localReviewSubmitting) return;
    state.reviewRequest = request;
    readBriefIntoState({ confirmEditedFields: false });
    // The send control is icon-only now, so progress is carried by the running
    // animation, the rainbow edge, and the state chip rather than a button label.
    state.focusedReviewRunning = true;
    setFocusedReviewGenerating(true);
    focusedButton.disabled = true;
    focusedButton.classList.add("running");
    focusedButton.setAttribute("aria-label", "Asking VIZier…");
    if (focusedState) {
      focusedState.textContent = "Reviewing";
      focusedState.hidden = false;
      focusedState.dataset.state = "running";
    }
    if (focusedError) focusedError.hidden = true;
    let succeeded = false;
    try {
      succeeded = await runAIAssist({ focusedRequest: request });
    } finally {
      state.focusedReviewRunning = false;
      setFocusedReviewGenerating(false);
      focusedButton.classList.remove("running");
    }
    if (succeeded) {
      if (focusedInput) focusedInput.value = "";
      state.reviewRequest = "";
      focusedButton.disabled = true;
      focusedButton.setAttribute("aria-label", "Ask VIZier");
    } else {
      focusedButton.disabled = false;
      focusedButton.setAttribute("aria-label", "Ask VIZier");
    }
    if (focusedState) {
      focusedState.textContent = succeeded ? "Answer Ready" : "Needs Retry";
      focusedState.hidden = false;
      focusedState.dataset.state = succeeded ? "success" : "error";
    }
    if (!succeeded && focusedError) {
      focusedError.textContent = "The request could not be reviewed. Check the engine connection and try again.";
      focusedError.hidden = false;
    }
  });

}

function bindContextConfirmationButton() {
  const button = document.getElementById("saveContextBtn");
  if (!button || button.dataset.bound === "true") return;
  button.dataset.bound = "true";
  // Context is not used for critique generation until the author explicitly
  // confirms the generated or edited values.
  button.addEventListener("click", () => {
    readBriefIntoState({ confirmEditedFields: false });
    state.context.fieldStatus = {
      goal: state.context.goal ? "confirmed" : "missing",
      audience: "missing",
      constraints: "missing",
    };
    state.context.snapshotId = null;
    setContextWorkflow(CONTEXT_WORKFLOW_STATUS.CONFIRMED);
    const saveData = withContextSaveStudyFields(contextSavedStudyData());
    appendInteractionEvent({
      kind: "context_saved",
      summary: saveData.origin === "ai-edited"
        ? "Confirmed dashboard context after editing the AI draft"
        : saveData.origin === "ai-unchanged"
          ? "Confirmed the AI-generated dashboard context unchanged"
          : saveData.hasContext
            ? "Confirmed dashboard context"
            : "Confirmed an artifact-only review without additional context",
      detail: saveData.submittedText
        ? `Context: ${saveData.submittedText}`
        : "Confirmed an artifact-only review without additional context",
      // generatedText vs submittedText is the comparison the study needs:
      // what VIZier drafted, and what the author actually confirmed.
      data: saveData,
    });
    renderFixedContextPanel();
    renderContextToolState();
  });
}

// v2 — re-rank critiques severity-first, so the most important thing to fix
// leads. Key order: direct answer → severity → grounding confidence → in-scope.
// Severity is the effective primary key for a full review (where direct-answer
// is empty for every item); for a focused/region ask the direct answer still
// pins to the top. In-scope is demoted to a tie-breaker so a minor in-scope
// issue no longer outranks a severe out-of-scope one. Executability is
// deliberately NOT a sort key: order reflects importance, not auto-applicability.
function scopeRank(critiques) {
  const scope = state.context.scope || [];
  const customTypes = state.context.customTypes || [];
  const prio = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
  const support = (c) => c.supportStatus === "validated" ? 0
    : c.supportStatus === "tentative" ? 1 : 2;
  return [...critiques].sort((a, b) => {
    const aDirect = a.requestRelevance === "direct" ? 0 : 1;
    const bDirect = b.requestRelevance === "direct" ? 0 : 1;
    if (aDirect !== bDirect) return aDirect - bDirect;           // 1 direct answer
    const aPrio = prio[a.priority] ?? 5;
    const bPrio = prio[b.priority] ?? 5;
    if (aPrio !== bPrio) return aPrio - bPrio;                    // 2 severity (dominant)
    const aSup = support(a), bSup = support(b);
    if (aSup !== bSup) return aSup - bSup;                        // 3 grounding confidence
    const aIn = scopeMatchesDimension(scope, a.dimension, customTypes) ? 0 : 1;
    const bIn = scopeMatchesDimension(scope, b.dimension, customTypes) ? 0 : 1;
    return aIn - bIn;                                             // 4 in-scope (tie-breaker)
  });
}

// Critique-level rationale captures author intent at the point of reflection.
// It remains linked to the feedback unit and is also available as confirmed
// memory for later critique generation.
let rationaleAnchorElement = null;

function positionRationalePopover(anchor = rationaleAnchorElement) {
  const modal = document.getElementById("contextModal");
  if (!modal || modal.hidden) return;
  const anchorRect = anchor?.getBoundingClientRect();
  const popoverRect = modal.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  let left = window.innerWidth - popoverRect.width - margin;
  let top = Math.max(60, window.innerHeight - popoverRect.height - 48);

  if (anchorRect) {
    left = anchorRect.right - popoverRect.width;
    top = anchorRect.top - popoverRect.height - gap;
    if (top < 60) top = anchorRect.bottom + gap;
  }

  left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, left));
  top = Math.max(60, Math.min(window.innerHeight - popoverRect.height - margin, top));
  Object.assign(modal.style, { left: `${left}px`, top: `${top}px` });
}

function openRationaleModal(critique, rationale = null, anchor = null) {
  if (!critique && !rationale) return;
  state.contextTargetId = critique?.id || rationale.critiqueId;
  state.rationaleEditId = rationale?.id || null;
  rationaleAnchorElement = anchor;
  const modal = document.getElementById("contextModal");
  const title = critique?.title || rationale.critiqueTitle;
  const rationaleContext = critique || rationale;
  modal.setAttribute("aria-label", `${rationale ? "Edit" : "Add"} rationale for ${title}`);
  document.getElementById("saveRationaleButton").textContent = rationale
    ? "Save thought"
    : "Keep this in mind";
  const ta = document.getElementById("contextInput");
  ta.value = rationale?.text || "";
  ta.placeholder = rationalePlaceholderFor(rationaleContext);
  modal.hidden = false;
  requestAnimationFrame(() => {
    positionRationalePopover(anchor);
    ta.focus();
  });
}

function closeContextModal() {
  const modal = document.getElementById("contextModal");
  modal.hidden = true;
  modal.style.removeProperty("left");
  modal.style.removeProperty("top");
  modal.removeAttribute("aria-label");
  document.getElementById("contextInjectForm").reset();
  state.contextTargetId = null;
  state.rationaleEditId = null;
  rationaleAnchorElement = null;
}

function renderRevisions(critique) {
  if (!critique.revisions || !critique.revisions.length) return "";
  return `
    <p class="section-kicker">Your Rationale &amp; Refined Feedback</p>
    <div class="revisions">${critique.revisions.map((r) => `
      <div class="revision">
        <div class="rev-context"><span class="rev-badge">rationale</span>${escapeHTML(r.rationale || r.context)}</div>
        <div class="rev-suggestion"><span class="rev-badge revised">refined</span>${escapeHTML(r.suggestion)}</div>
      </div>`).join("")}</div>`;
}

function closestRevisedCritique(previous) {
  const score = (candidate) => [
    candidate.proposal?.kind === previous.proposal?.kind ? 8 : 0,
    candidate.tileId === previous.tileId ? 4 : 0,
    candidate.dimension === previous.dimension ? 2 : 0,
    candidate.surface === previous.surface ? 1 : 0,
  ].reduce((total, value) => total + value, 0);
  return [...state.critiques]
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .sort((a, b) => b.score - a.score)[0]?.candidate || null;
}

function renderMarkers() {
  const visible = filteredCritiques().filter((critique) =>
    ["pending", "updated"].includes(critique.status));
  // The bounded canvas contains the artifact and one location overlay only.
  // While a canvas preview is active, the location overlay belongs to the
  // "after" state (Proposed / Affected area) so the Original/Proposed toggle
  // produces a real visible difference — Original is the clean dashboard,
  // Proposed adds the highlight. This matches the tile highlight, which
  // activeCanvasPreviewResult() already gates on phase === "after".
  const suppressedForOriginalPhase =
    state.canvasPreview != null && state.canvasPreview.phase !== "after";
  const shown = state.selectedCritiqueId && !suppressedForOriginalPhase
    ? visible.filter((critique) => critique.id === state.selectedCritiqueId)
    : [];
  els.markersLayer.innerHTML = shown.flatMap((critique) => {
    const color = critiqueGroupPresentation(critique.dimension).color;
    const cls = critique.id === state.selectedCritiqueId ? "marker selected" : "marker";
    return critiqueRenderBoundsList(critique).map((bounds) =>
      `<div class="${cls}" aria-hidden="true" style="--accent:${color};left:${bounds.x}px;top:${bounds.y}px;width:${bounds.w}px;height:${bounds.h}px"></div>`);
  }).join("");
}

// Shared predicate for the active critique list AND the Category Mix bar, so the
// two never drift. `ignoreCategory` lets the bar summarize every cluster in the
// current working set (status + source + search) even while one cluster is
// isolated — the bar is what drives that isolation, so it must not filter itself
// down to a single segment.
function critiqueMatchesFilters(critique, { ignoreCategory = false } = {}) {
  const query = state.search.trim().toLowerCase();
  if (
    critique.requestRelevance !== "direct" &&
    !itemMatchesFeedbackScope(critique.dimension, critique.askScope || "full")
  ) return false;
  // Default "all" view keeps only what still needs a decision; decided
  // critiques (accepted/resolved/rejected/superseded) drop out of the active
  // list but remain reachable via the status pills and the history drawer
  // (proposals §2). Gate on the single isDecidedCritique definition shared
  // with §1's merge so "active vs decided" never drifts.
  if (state.filters.status === "all" && isDecidedCritique(critique)) return false;
  if (
    state.filters.status === "pending" &&
    !["pending", "updated"].includes(critique.status)
  ) return false;
  if (
    !["all", "pending"].includes(state.filters.status) &&
    critique.status !== state.filters.status
  ) return false;
  if (state.filters.source !== "all" && critique.source !== state.filters.source) return false;
  // Category Mix bar click isolates one cluster; a second click on the same
  // segment clears it back to "all". Direct-answer critiques ignore the
  // dimension grouping, so they are exempt (they always answer the request).
  if (
    !ignoreCategory &&
    state.filters.category !== "all" &&
    critique.requestRelevance !== "direct" &&
    (clusterForDimension(critique.dimension)?.key || "other") !== state.filters.category
  ) return false;
  if (query && ![critique.title, critique.issue].join(" ").toLowerCase().includes(query)) return false;
  return true;
}

function filteredCritiques() {
  return state.critiques.filter((critique) => critiqueMatchesFilters(critique));
}

function critiquePriorityLabel(critique) {
  const priority = critique.priority || "normal";
  return `${priority.charAt(0).toUpperCase()}${priority.slice(1)} Priority`;
}

// Compact severity word for the dense list chip ("High", "Critical"). The long
// form above is kept for the focus card and screen-reader text.
function critiquePriorityShort(critique) {
  const priority = critique.priority || "normal";
  return `${priority.charAt(0).toUpperCase()}${priority.slice(1)}`;
}

// Whether scope carries information beyond "the whole dashboard". Dashboard-wide
// critiques (no tile) return false, so the "Applies to Dashboard" constant — a
// label that distinguishes nothing — is never rendered as a visible chip.
function critiqueHasScopeInfo(critique) {
  if (critique.origin === "local-review" || critique.target?.granularity === "selected-region") return true;
  return critiqueTileCount(critique) >= 1;
}

// Number of distinct tiles a consolidated critique applies to (one identical
// fix merged across charts); 1 (or 0) for an ordinary single-tile critique.
function critiqueTileCount(critique) {
  const tiles = critique.target?.ref?.tiles;
  return Array.isArray(tiles) ? new Set(tiles).size : (critique.tileId ? 1 : 0);
}

function critiqueTargetLabel(critique) {
  if (critique.origin === "local-review" || critique.target?.granularity === "selected-region") {
    return "Applies to selected area";
  }
  const tileCount = critiqueTileCount(critique);
  if (tileCount > 1) return `Applies to ${tileCount} charts`;
  const target = critique.tileId ? (tileById(critique.tileId)?.label || "Chart") : "Dashboard";
  return `Applies to ${target}`;
}

function critiqueCardAffordance(critique) {
  if (critique.status === "accepted") {
    return `<span class="card-affordance completed"><span>Considered</span><b aria-hidden="true">✓</b></span>`;
  }
  if (critique.status === "resolved") {
    return `<span class="card-affordance completed"><span>Applied</span><b aria-hidden="true">✓</b></span>`;
  }
  if (critique.status === "rejected") {
    return `<span class="card-affordance dismissed"><span>Dismissed</span><b aria-hidden="true">×</b></span>`;
  }
  if (critique.status === "superseded") {
    return `<span class="card-affordance replaced"><span>Replaced</span><b aria-hidden="true">−</b></span>`;
  }
  return `<span class="card-affordance open" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg></span>`;
}

// Whether a critique carries a fix the engine can apply on the canvas, versus
// advice the author acts on themselves. Intrinsic to the proposal (mode/kind),
// so it is stable regardless of the critique's decision status. After the repair
// pass, every component-level fix is executable; only advisory branches (design
// process / other) and un-encodable notes remain guidance-only.
function critiqueIsExecutable(critique) {
  return critique.proposal?.mode === "executable" && critique.proposal?.kind !== "manual";
}

// Whether a critique can join a batch (multi-select) apply. Batch composes
// engine transforms, so only still-open, executable fixes qualify — guidance and
// already-decided cards are excluded, matching the single-critique Apply gate.
function critiqueBatchEligible(critique) {
  return ["pending", "updated"].includes(critique.status)
    && critiqueIsExecutable(critique)
    && (!Number.isFinite(Number(critique.lastEvaluatedVersion))
      || Number(critique.lastEvaluatedVersion) === state.version)
    && state.artifact.hasExecutableSpecs;
}

// A Focused Question wants a clear verdict up front. When the answer opens with
// a Yes/No-style token, lift that word into an emphasized lead so the direct
// response reads at a glance; the rest of the answer follows as supporting text.
const ANSWER_VERDICT_RE = /^(likely yes|likely no|not quite|it depends|partially|mostly|yes|no)\b/i;

function focusedAnswerMarkup(answer) {
  const text = String(answer || "").trim();
  const verdict = text.match(ANSWER_VERDICT_RE);
  if (!verdict) {
    return `<p class="focus-answer-body">${escapeHTML(text)}</p>`;
  }
  const lead = verdict[0];
  const rest = text.slice(lead.length).replace(/^[\s,.:;—-]+/, "").trim();
  const tone = /^(no|likely no|not quite)\b/i.test(lead) ? "negative"
    : /^(yes|likely yes|mostly)\b/i.test(lead) ? "positive"
    : "neutral";
  return `
    <p class="focus-answer-lead ${tone}">${escapeHTML(lead)}</p>
    ${rest ? `<p class="focus-answer-body">${escapeHTML(rest)}</p>` : ""}`;
}

// The dragged region for a Review Area critique. A minimap with the selection
// box overlaid lets the author recall where the region is at a glance; clicking
// it scrolls the canvas to the region and flashes a highlight box there (the
// bounds live in canvas-space px, the same space miniBoard and the canvas use,
// so no conversion is needed). Returns "" when the critique has no bounds.
function regionRecallMarkup(critique) {
  const bounds = critique.bounds || critique.localReview?.bounds || critique.target?.ref?.selectedBounds;
  if (!bounds) return "";
  return `
    <button type="button" class="region-recall" data-region-recall="${escapeHTML(critique.id)}"
      aria-label="Show the selected review area on the canvas">
      <span class="region-recall-map">${miniBoard({ box: bounds })}</span>
      <span class="region-recall-copy">
        <strong>Your selected area</strong>
        <span>${Math.round(bounds.w)} × ${Math.round(bounds.h)} px · click to locate on canvas</span>
      </span>
    </button>`;
}

// Icon + text label distinguishing an executable fix from guidance. Shown on the
// list card and in the focus detail so the two are visually separable everywhere
// a critique appears.
function critiqueFixBadgeMarkup(critique) {
  const executable = critiqueIsExecutable(critique);
  const icon = executable
    ? '<path d="M9 1.5 3.5 9h4l-1 5.5L12 6.5H8z"/>'
    : '<path d="M8 1.8a4.3 4.3 0 0 0-2.6 7.7c.5.4.7.8.7 1.3v.4h3.8v-.4c0-.5.2-.9.7-1.3A4.3 4.3 0 0 0 8 1.8Z"/><path d="M6.4 13.3h3.2M6.9 14.8h2.2"/>';
  return `<span class="fix-kind-badge ${executable ? "executable" : "guidance"}" title="${executable
    ? "Fixable — the engine can apply this change on the canvas"
    : "Guidance — a direction you apply yourself"}">
    <svg viewBox="0 0 16 16" aria-hidden="true">${icon}</svg>
    <span>${executable ? "Fixable" : "Guidance"}</span>
  </span>`;
}

// Keyed by recommendation branch (critique.dimension). One entry per branch in
// CATEGORY_PRESENTATIONS; each adds a monochrome glyph drawn in the branch hue.
const CRITIQUE_GROUPS = {
  chart: {
    ...CATEGORY_PRESENTATIONS.chart,
    icon: '<path d="M4 20V4M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>',
  },
  color: {
    ...CATEGORY_PRESENTATIONS.color,
    icon: '<path d="M12 3.5c-4.7 0-8.5 3.4-8.5 7.7 0 3 2.4 5.3 5.3 5.3h1.4a1.6 1.6 0 0 1 1.6 1.6c0 1.6 1.3 2.4 2.5 2.4 3.2 0 6.2-3.3 6.2-8.5 0-4.9-3.8-8-8.5-8Z"/><circle cx="8" cy="9" r=".9"/><circle cx="12" cy="6.8" r=".9"/><circle cx="16" cy="9" r=".9"/>',
  },
  layout: {
    ...CATEGORY_PRESENTATIONS.layout,
    icon: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 10h16M11 10v10"/>',
  },
  data: {
    ...CATEGORY_PRESENTATIONS.data,
    icon: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  },
  text: {
    ...CATEGORY_PRESENTATIONS.text,
    icon: '<path d="M6 3.5h9l3 3V20.5H6z"/><path d="M14.5 3.5v4h3.5M9 11h6M9 15h5"/>',
  },
  "visual design": {
    ...CATEGORY_PRESENTATIONS["visual design"],
    icon: '<path d="M4 15.5 9.5 10l3 3 3.5-3.5 4 4"/><rect x="3.5" y="4" width="17" height="16" rx="1.5"/><circle cx="8.5" cy="8" r="1.2"/>',
  },
  cognition: {
    ...CATEGORY_PRESENTATIONS.cognition,
    icon: '<path d="M9 20.5v-2M15 20.5v-2M9 18.5h6"/><path d="M12 3.5a6 6 0 0 0-3.6 10.8c.4.3.6.8.6 1.2v.5h6v-.5c0-.4.2-.9.6-1.2A6 6 0 0 0 12 3.5Z"/>',
  },
  context: {
    ...CATEGORY_PRESENTATIONS.context,
    icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="1"/>',
  },
  interaction: {
    ...CATEGORY_PRESENTATIONS.interaction,
    icon: '<circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/><path d="M9 8.5 15 15.5M17 7v5M12 7h5"/>',
  },
  task: {
    ...CATEGORY_PRESENTATIONS.task,
    icon: '<rect x="4.5" y="4" width="15" height="16" rx="1.5"/><path d="m8 10 2 2 3.5-3.5M8 16h7"/>',
  },
  "design process": {
    ...CATEGORY_PRESENTATIONS["design process"],
    icon: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9 18 18M18 6l-2.1 2.1M8.1 15.9 6 18"/>',
  },
};

const DIMENSION_GROUP_ORDER = CATEGORY_ORDER;

function critiqueGroupPresentation(group) {
  return CRITIQUE_GROUPS[group] || {
    ...categoryPresentation(group, state.context.customTypes),
    icon: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  };
}

function critiqueGroupIcon(group) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${critiqueGroupPresentation(group).icon}</svg>`;
}

// The Category Mix bar reads in the 5 top-level clusters (not the 11
// dimensions): a critique's dimension maps to its cluster, and the bar shows one
// segment per cluster in cluster order. `bar` is the vivid fill; anything
// outside the clusters falls into a neutral "Other" bucket.
function categoryMixPresentation(key) {
  return clusterPresentation(key) || { label: "Other", color: "#8a8f98", soft: "#f0f1f3", bar: "#b8bcc4" };
}

function renderCritiqueDistribution() {
  const host = document.getElementById("critiqueDistribution");
  if (!host) return;
  // Summarize the current working set, not every critique ever generated: as the
  // author accepts/rejects/resolves critiques they leave the active view, so the
  // bar rebalances and shrinks live. Ignore only the category isolation (the bar
  // drives it) so every cluster stays visible while one is isolated.
  const distributionCritiques = state.critiques.filter((critique) =>
    critiqueMatchesFilters(critique, { ignoreCategory: true }));
  const total = distributionCritiques.length;
  if (!total) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  const counts = new Map();
  distributionCritiques.forEach((critique) => {
    const cluster = clusterForDimension(critique.dimension);
    const key = cluster ? cluster.key : "other";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  // Self-heal a stale isolation: if the isolated cluster no longer has any
  // critique (its items were all decided away), fall back to showing all so the
  // list can never be stranded empty with no visible way to clear the filter.
  if (state.filters.category !== "all" && !counts.has(state.filters.category)) {
    state.filters.category = "all";
  }
  const categories = [...counts.entries()].sort(([a], [b]) => {
    const aIndex = CLUSTER_ORDER.indexOf(a);
    const bIndex = CLUSTER_ORDER.indexOf(b);
    return (aIndex < 0 ? CLUSTER_ORDER.length : aIndex)
      - (bIndex < 0 ? CLUSTER_ORDER.length : bIndex);
  });
  const roundedPercentages = categories.map(([group, count], index) => {
    const exact = (count / total) * 100;
    return { group, index, percentage: Math.floor(exact), remainder: exact % 1 };
  });
  let percentagePoints = 100 - roundedPercentages.reduce((sum, item) => sum + item.percentage, 0);
  [...roundedPercentages]
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((item) => {
      if (percentagePoints > 0) {
        item.percentage += 1;
        percentagePoints -= 1;
      }
    });
  const percentageByGroup = new Map(roundedPercentages.map((item) => [item.group, item.percentage]));
  const summary = categories.map(([group, count]) => {
    const presentation = categoryMixPresentation(group);
    const percentage = percentageByGroup.get(group);
    return `${presentation.label}: ${count} ${count === 1 ? "critique" : "critiques"}, ${percentage}%`;
  }).join("; ");
  // Clicking a bar segment isolates that category in the list; the label + count
  // + share now live in a hover/focus tooltip on the bar rather than a standing
  // legend below it. state.filters.category holds the active isolation ("all"
  // when nothing is isolated).
  const activeCategory = state.filters.category;
  const isFiltering = activeCategory !== "all" && counts.has(activeCategory);
  const activeLabel = isFiltering ? categoryMixPresentation(activeCategory).label : "";
  host.hidden = false;
  host.innerHTML = `
    <div class="distribution-heading">
      <strong>Category Mix</strong>
      ${isFiltering
        ? `<button type="button" class="distribution-clear" data-distribution-clear>
            <span>${escapeHTML(activeLabel)} only</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>
          </button>`
        : `<span>${total} ${total === 1 ? "critique" : "critiques"}</span>`}
    </div>
    <div class="distribution-bar${isFiltering ? " filtering" : ""}" role="group" aria-label="Category Mix — ${escapeHTML(summary)}">
      ${categories.map(([group, count]) => {
        const presentation = categoryMixPresentation(group);
        const width = (count / total) * 100;
        const percentage = percentageByGroup.get(group);
        const active = group === activeCategory;
        const noun = count === 1 ? "critique" : "critiques";
        return `<button
          type="button"
          class="distribution-segment${active ? " active" : ""}"
          data-distribution-category="${escapeHTML(group)}"
          style="--segment-color:${presentation.bar};width:${width.toFixed(4)}%"
          aria-pressed="${active ? "true" : "false"}"
          aria-label="${escapeHTML(`${presentation.label}: ${count} ${noun}, ${percentage}%. ${active ? "Showing this category — activate to show all." : "Activate to show only this category."}`)}">
          <span class="distribution-tip" role="tooltip">
            <b>${escapeHTML(presentation.label)}</b>
            <span>${count} ${noun} · ${percentage}%</span>
          </span>
        </button>`;
      }).join("")}
    </div>`;

  const applyCategoryFilter = (group) => {
    state.filters.category = state.filters.category === group ? "all" : group;
    renderCritiques();
  };
  host.querySelectorAll("[data-distribution-category]").forEach((node) => {
    node.addEventListener("click", () => applyCategoryFilter(node.dataset.distributionCategory));
  });
  host.querySelector("[data-distribution-clear]")?.addEventListener("click", () => {
    state.filters.category = "all";
    renderCritiques();
  });
}

// UI copy for an ask's review scope, matching the labels renderStatusBar and
// renderAskAnswer already use so the history drawer reads consistently.
function askScopeLabel(scope) {
  if (scope === "selected-region") return "Review Area";
  if (scope === "focused") return "Focused Question";
  return "Full Review";
}

// The critique history drawer: every critique ever generated, grouped by the ask
// that produced it (proposals §3). This is the read side of the provenance §1's
// merge stamps onto each critique (askId / askScope / resurfacedByAskId) — it is
// the only place a decided critique that has dropped out of the active list
// (§2) can still be browsed. Renders over state.critiques directly, so it stays
// in sync with the active list without a second store.
function renderCritiqueHistory() {
  const toggle = document.getElementById("critiqueHistoryToggle");
  const list = document.getElementById("critiqueHistoryList");
  const count = document.getElementById("critiqueHistoryCount");
  if (!toggle || !list || !count) return;

  const total = state.critiques.length;
  if (!total) {
    // Nothing generated yet: hide the History entry entirely, and if its popover
    // was left open, close it so no stale list lingers.
    toggle.hidden = true;
    if (state.sidebarPopover === "history") closeSidebarPopovers({ restoreFocus: false });
    list.replaceChildren();
    return;
  }
  toggle.hidden = false;
  count.textContent = total;

  // The list is cheap (bounded by the critique count) and its panel is hidden
  // until opened, so rebuild it on every render to keep the popover fresh the
  // instant the author opens it — no separate open hook needed.
  const groups = groupCritiquesByAsk(state.critiques);
  list.innerHTML = groups.map((group) => {
    const label = group.askId === null ? "Earlier" : `Ask ${group.askId}`;
    const scope = askScopeLabel(group.askScope);
    const items = group.items.map((critique) => {
      const presentation = critiqueGroupPresentation(critique.dimension);
      const selected = critique.id === state.selectedCritiqueId ? " selected" : "";
      const resurfaced = typeof critique.resurfacedByAskId === "number"
        ? `<span class="critique-history-resurfaced">re-surfaced in Ask ${critique.resurfacedByAskId}</span>`
        : "";
      return `<button class="critique-history-item${selected}" type="button" data-history-critique-id="${escapeHTML(critique.id)}" style="--accent:${presentation.color}">
        <span class="critique-history-dot" aria-hidden="true"></span>
        <span class="critique-history-item-copy">
          <span class="critique-history-item-title">${escapeHTML(critique.title || "Untitled critique")}</span>
          ${resurfaced}
        </span>
        ${critiqueCardAffordance(critique)}
      </button>`;
    }).join("");
    return `<section class="critique-history-group">
      <header class="critique-history-group-header">
        <strong>${escapeHTML(scope)}</strong>
        <span class="critique-history-group-ask">${escapeHTML(label)}</span>
        <b>${group.items.length}</b>
      </header>
      <div class="critique-history-group-items">${items}</div>
    </section>`;
  }).join("");

  list.querySelectorAll(".critique-history-item").forEach((node) => {
    node.addEventListener("click", async () => {
      const critique = critiqueById(node.dataset.historyCritiqueId);
      if (!critique) return;
      state.selectedCritiqueId = critique.id;
      state.selectedTileId = critique.tileId || null;
      appendInteractionEvent({
        kind: "critique_opened",
        summary: `Opened critique from history: ${critique.title}`,
        critiqueId: critique.id,
        dimension: critique.dimension,
        proposalKind: critique.proposal?.kind,
      });
      markCritiqueInspected(critique.id);
      await renderTiles();
      renderCritiques();
      renderMarkers();
      await renderInspector();
    });
  });
}

// The direct answer to a focused/region ask. Rendered in its own panel so a
// narrow question always gets a visible response — including when the engine
// returned an answer but no standard critique card (e.g. "this looks fine", or
// the only grounded critique fell outside the selection).
function renderAskAnswer() {
  const host = document.getElementById("askAnswer");
  if (!host) return;
  const answer = state.askAnswer;
  if (!answer || !answer.text) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  const scopeLabel = answer.reviewScope === "selected-region"
    ? "Review Area"
    : "Focused Question";
  const linkedCritique = answer.critiqueId ? critiqueById(answer.critiqueId) : null;
  host.hidden = false;
  host.classList.toggle("ask-answer-error", Boolean(answer.isError));
  host.innerHTML = `
    <div class="ask-answer-head">
      <span class="ask-answer-icon" aria-hidden="true">
        <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="6.5"/><circle cx="9" cy="9" r="2"/><path d="M9 1.5v2M16.5 9h-2"/></svg>
      </span>
      <div class="ask-answer-copy">
        <strong>${answer.isError ? "Could not answer" : "Answer"} · ${escapeHTML(scopeLabel)}</strong>
        ${answer.request ? `<span class="ask-answer-request">${escapeHTML(answer.request)}</span>` : ""}
      </div>
      <button type="button" class="ask-answer-dismiss" id="askAnswerDismiss" aria-label="Dismiss answer">×</button>
    </div>
    <p class="ask-answer-body">${escapeHTML(answer.text)}</p>
    ${linkedCritique
      ? `<button type="button" class="ask-answer-link" id="askAnswerLink" data-critique-id="${escapeHTML(linkedCritique.id)}">See the related recommendation →</button>`
      : answer.noCritiques
        ? `<p class="ask-answer-note">No standard recommendation was generated for this request — the answer above is the direct response.</p>`
        : ""}`;
  document.getElementById("askAnswerDismiss")?.addEventListener("click", () => {
    state.askAnswer = null;
    renderAskAnswer();
  });
  document.getElementById("askAnswerLink")?.addEventListener("click", async () => {
    const critique = critiqueById(answer.critiqueId);
    if (!critique) return;
    state.selectedCritiqueId = critique.id;
    state.selectedTileId = critique.tileId || null;
    await renderTiles();
    renderCritiques();
    renderMarkers();
    await renderInspector();
  });
}

// A positive "critique card": praise-only, and non-interactive by design (an
// <article>, never a .critique-card <button>, so it carries no action, opens no
// focus view, and is never batch-eligible). It keeps the critique-card footprint
// and title scale, but leads with a warm-GOLD award medal in the left gutter —
// the one deliberate spot of color in the otherwise black/white/gray critique
// list, marking the card at a glance as recognition (a colored positive icon the
// user asked for here). Only the medal is colored; the card surface and dividers
// stay neutral. Where a critique card lays out its Fixable/Guidance/severity
// chips, this lays out one concise line of concrete artifact evidence. It renders
// INSIDE its dimension's topic group alongside that topic's problems — or, when a
// scope found nothing wrong in a dimension, it is the group's only card.
function strengthCardMarkup(strength) {
  return `
    <article class="strength-card" data-strength-id="${escapeHTML(strength.id)}">
      <span class="strength-medal" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M9 2.75 11.4 8.2"/>
          <path d="M15 2.75 12.6 8.2"/>
          <circle cx="12" cy="15" r="6.25"/>
          <path d="m9.4 15 1.9 1.9 3.4-3.8"/>
        </svg>
      </span>
      <span class="diagnostic-body">
        <span class="visually-hidden">Done well: </span>
        <span class="strength-title">${escapeHTML(strength.title)}</span>
        ${strength.detail ? `<span class="strength-evidence">${escapeHTML(strength.detail)}</span>` : ""}
      </span>
    </article>`;
}

// Positive praise is wholesale-replaced per review and stamped with the draft
// version it was evaluated against, so an apply (which bumps the version without
// re-reviewing) suppresses now-stale praise until the next review. Praise also
// follows the same category-isolation and search filters as critiques, and — like
// the problems list — is confined to the active ("all"/"pending") status views,
// since a strength has no lifecycle state to isolate. Never padded: an empty
// result simply contributes no cards, so a scope with 0 problems + 0 strengths
// still falls through to the neutral empty state with no fabricated praise.
function filteredStrengths() {
  if (state.batchMode) return []; // batch mode is for selecting fixes; praise is inert
  const query = state.search.trim().toLowerCase();
  return (state.strengths || []).filter((strength) => {
    if (strength.reviewVersion !== undefined && strength.reviewVersion !== state.version) return false;
    if (!itemMatchesFeedbackScope(strength.dimension, strength.reviewScope || "full")) return false;
    if (!["all", "pending"].includes(state.filters.status)) return false;
    if (state.filters.source !== "all") return false;
    if (state.filters.category !== "all" && (clusterForDimension(strength.dimension)?.key || "other") !== state.filters.category) return false;
    if (query && ![strength.title, strength.detail].join(" ").toLowerCase().includes(query)) return false;
    return true;
  });
}

// Group critiques AND positive strength cards under one dimension key each, so a
// topic section (e.g. "Color") holds both its problems and its praise — or, when
// a scope found nothing wrong in a dimension, holds praise alone. Ordered by
// DIMENSION_GROUP_ORDER like the critique-only grouping it replaces. Each entry
// is [dimension, { critiques, strengths }].
function groupCritiquesWithStrengths(critiqueItems, strengthItems) {
  const groups = new Map();
  const bucket = (key) => {
    if (!groups.has(key)) groups.set(key, { critiques: [], strengths: [] });
    return groups.get(key);
  };
  critiqueItems.forEach((item) => bucket(item.dimension).critiques.push(item));
  strengthItems.forEach((item) => bucket(item.dimension || "other").strengths.push(item));
  return [...groups.entries()].sort(([a], [b]) => {
    const aIndex = DIMENSION_GROUP_ORDER.indexOf(a);
    const bIndex = DIMENSION_GROUP_ORDER.indexOf(b);
    return (aIndex < 0 ? DIMENSION_GROUP_ORDER.length : aIndex)
      - (bIndex < 0 ? DIMENSION_GROUP_ORDER.length : bIndex);
  });
}

function critiqueCardMarkup(critique, directAnswer = false) {
  const batchEligible = state.batchMode && critiqueBatchEligible(critique);
  const batchChecked = state.batchMode && state.batchSelection.has(critique.id);
  const batchClass = state.batchMode
    ? ` batch-mode${batchEligible ? "" : " batch-ineligible"}${batchChecked ? " batch-checked" : ""}`
    : "";
  const checkboxMarkup = state.batchMode
    ? `<span class="critique-checkbox" aria-hidden="true">${batchEligible
        ? `<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>`
        : ""}</span>`
    : "";
  // Guidance-only cards still read as a distinct kind — a warm surface and a
  // lighter title — but the fix/guidance distinction is now named explicitly by a
  // capsule chip (icon + "Fixable"/"Guidance") on both kinds, rather than a
  // gutter lamp on guidance alone.
  const guidance = !critiqueIsExecutable(critique);
  // Distilled summary row: the fix/guidance capsule, the direct-answer cue, and
  // an escalated-severity signal earn a visible chip. Scope and non-escalated
  // priority live in the screen-reader line below and the focus detail. Compute
  // here so the wrapper is omitted entirely when empty — no stray gap.
  const summaryChips = [
    critiqueFixBadgeMarkup(critique),
    directAnswer ? `<span class="request-match-label">Direct Answer</span>` : "",
    ["critical", "high"].includes(critique.priority)
      ? `<span class="priority-label priority-${escapeHTML(critique.priority)}">${escapeHTML(critiquePriorityShort(critique))}</span>`
      : "",
  ].join("");
  return `
    <button class="critique-card priority-${escapeHTML(critique.priority || "normal")} ${directAnswer ? "direct-answer-card" : ""} ${guidance ? "guidance" : ""} ${state.selectedCritiqueId === critique.id ? "selected" : ""} ${critique.status}${batchClass}" data-critique-id="${escapeHTML(critique.id)}"${state.batchMode ? ` role="checkbox" aria-checked="${batchChecked}"${batchEligible ? "" : " aria-disabled=\"true\""}` : ""}>
      ${checkboxMarkup}
      <span class="diagnostic-body">
        <span class="critique-title">${escapeHTML(critique.title)}</span>
        ${summaryChips ? `<span class="critique-summary">${summaryChips}</span>` : ""}
        <span class="visually-hidden">${["critical", "high", "medium", "low"].includes(critique.priority)
          ? escapeHTML(critiquePriorityLabel(critique)) + ". " : ""}${escapeHTML(critiqueTargetLabel(critique))}. ${escapeHTML(critique.status)}. Open critique details.</span>
      </span>
      ${critiqueCardAffordance(critique)}
    </button>`;
}

function renderCritiques() {
  const actionable = state.critiques.filter((item) =>
    ["pending", "updated"].includes(item.status));
  // Drop any batch selection that a regenerate/apply made ineligible (resolved,
  // superseded, or gone) so the count and plan never reference dead critiques.
  if (state.batchMode && state.batchSelection.size) {
    for (const id of [...state.batchSelection]) {
      const critique = critiqueById(id);
      if (
        !critique ||
        !critiqueBatchEligible(critique) ||
        !critiqueMatchesFilters(critique)
      ) state.batchSelection.delete(id);
    }
  }
  renderAskAnswer();
  renderCritiqueDistribution();
  let visible = filteredCritiques();
  const visibleStrengths = filteredStrengths();

  // Sort: active items first, then decided items at the end.
  visible = visible.sort((a, b) => {
    const aResolved = ["accepted", "resolved", "rejected"].includes(a.status);
    const bResolved = ["accepted", "resolved", "rejected"].includes(b.status);
    if (aResolved && !bResolved) return 1;
    if (!aResolved && bResolved) return -1;
    return 0;
  });

  if (!visible.length && !visibleStrengths.length) {
    // With decided critiques now hidden from the default "all" view (§2), a board
    // where every critique has been decided yields an empty active list even
    // though nothing is lost — point the user at the history drawer rather than
    // implying there is nothing to see. Positive praise (visibleStrengths) also
    // keeps the list non-empty, so a zero-problem scope that still found something
    // done well renders its praise groups rather than this neutral empty state.
    const allDecided = state.filters.status === "all"
      && !actionable.length
      && state.critiques.some(isDecidedCritique);
    els.critiqueList.innerHTML = state.version > 1 && !actionable.length
      ? `<div class="completion-state"><strong>Nicely done — this draft is looking strong.</strong><span>No open recommendations remain. Want to push it further? Run another review round to surface finer refinements.</span></div>`
      : allDecided
        ? `<div class="empty-state">All recommendations decided — open Critique History to review them.</div>`
        : `<div class="empty-state">${state.critiques.length
          ? "No critiques match the current filters."
          : "No critiques yet."}</div>`;
    renderBatchApplyBar();
    renderCritiqueHistory();
    renderStatusBar();
    return;
  }
  const directAnswers = visible.filter((item) => item.requestRelevance === "direct");
  const categorized = visible.filter((item) => item.requestRelevance !== "direct");
  const request = directAnswers[0]?.reviewRequest || state.reviewRequest;
  const focusedMarkup = directAnswers.length ? `
    <section class="focused-request-group" aria-labelledby="focusedRequestResultsTitle">
      <header class="focused-request-group-header">
        <span class="focused-request-icon" aria-hidden="true">
          <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="6.5"/><circle cx="9" cy="9" r="2"/><path d="M9 1.5v2M16.5 9h-2"/></svg>
        </span>
        <span class="focused-request-copy">
          <strong id="focusedRequestResultsTitle">Answers Your Request</strong>
          <span>${escapeHTML(request)}</span>
        </span>
        <b>${directAnswers.length}</b>
      </header>
      <div class="group-items">${directAnswers.map((critique) =>
        critiqueCardMarkup(critique, true)).join("")}</div>
    </section>` : "";
  const categoryMarkup = groupCritiquesWithStrengths(categorized, visibleStrengths).map(([group, { critiques, strengths }]) => {
    const groupKey = `dimension:${group}`;
    if (state.expandedCritiqueGroups[groupKey] === undefined) {
      state.expandedCritiqueGroups[groupKey] = true;
    }
    const expanded = state.expandedCritiqueGroups[groupKey];
    const presentation = critiqueGroupPresentation(group);
    const contentId = `critique-group-dimension-${group}`;
    // Problems first, then the topic's praise cards — the actionable items lead,
    // the affirming notes close the section. The count badge covers both.
    const itemsMarkup = critiques.map((critique) => critiqueCardMarkup(critique)).join("")
      + strengths.map((strength) => strengthCardMarkup(strength)).join("");
    return `
    <section class="critique-group ${expanded ? "expanded" : "collapsed"}" style="--group-color:${presentation.color};--group-soft:${presentation.soft}">
      <button class="group-header" type="button" data-group-key="${escapeHTML(groupKey)}" aria-expanded="${expanded}" aria-controls="${escapeHTML(contentId)}">
        <span class="group-icon">${critiqueGroupIcon(group)}</span>
        <span class="group-heading-copy">
          <strong>${escapeHTML(presentation.label)}</strong>
        </span>
        <b>${critiques.length + strengths.length}</b>
        <span class="group-toggle" aria-hidden="true"><span class="group-plus">＋</span><span class="group-minus">−</span></span>
      </button>
      <div class="group-items" id="${escapeHTML(contentId)}" ${expanded ? "" : "hidden"}>${itemsMarkup}</div>
    </section>`;
  }).join("");
  els.critiqueList.innerHTML = focusedMarkup + categoryMarkup;
  document.querySelectorAll(".group-header").forEach((node) => {
    node.addEventListener("click", () => {
      const groupKey = node.dataset.groupKey;
      state.expandedCritiqueGroups[groupKey] = !state.expandedCritiqueGroups[groupKey];
      renderCritiques();
    });
  });
  document.querySelectorAll(".critique-card").forEach((node) => {
    node.addEventListener("click", async () => {
      const critique = critiqueById(node.dataset.critiqueId);
      if (!critique) return;
      // In batch mode a card click toggles selection rather than opening focus.
      // Ineligible cards (guidance / already decided) are inert.
      if (state.batchMode) {
        if (!critiqueBatchEligible(critique)) return;
        if (state.batchSelection.has(critique.id)) state.batchSelection.delete(critique.id);
        else state.batchSelection.add(critique.id);
        renderCritiques();
        await refreshBatchPreview();
        return;
      }
      state.selectedCritiqueId = critique.id;
      state.selectedTileId = critique.tileId || null;
      appendInteractionEvent({
        kind: "critique_opened",
        summary: `Opened critique: ${critique.title}`,
        critiqueId: critique.id,
        dimension: critique.dimension,
        proposalKind: critique.proposal?.kind,
        data: { dwellFromMs: Date.now() },
      });
      markCritiqueInspected(critique.id);
      await renderTiles();
      renderCritiques();
      renderMarkers();
      await renderInspector();
    });
  });
  renderBatchApplyBar();
  renderCritiqueHistory();
  renderStatusBar();
}

function renderStatusBar() {
  els.statusBar.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Batch (multi-select) apply. The engine already composes a set of fixes into
// one transaction (buildApplicationPlan orders dependencies + resolves
// conflicts, streamApply applies them together); batch mode is the UI that lets
// the author pick that set. The canvas previews the COMBINED after-state of the
// whole selection, so the author sees the merged result before applying — not
// one fix at a time.
// ---------------------------------------------------------------------------
// Sync the header toggle's pressed state to state.batchMode.
// Repaint the bottom bar to reflect state.batchMode. Named for the historical
// header toggle it once synced; it now just delegates to renderBatchApplyBar,
// which owns the bar's visibility and idle/active face.
function syncBatchToggle() {
  renderBatchApplyBar();
}

// Reset ALL batch state to off — the single source of truth for leaving batch
// mode. Synchronous and render-free: it drops the selection, invalidates any
// in-flight preview via the token, discards a batch combined preview, and syncs
// the toggle. Callers that reset or rebuild the app (resetDemo, loadJsonDashboard,
// runAIAssist regenerate) call this before their own renders; setBatchMode(false)
// uses it and then repaints the canvas.
function resetBatchState() {
  state.batchMode = false;
  state.batchSelection = new Set();
  state.batchPreviewToken += 1; // invalidate any in-flight preview
  if (state.canvasPreview?.batch) state.canvasPreview = null;
  setBatchPreviewPending(false);
  syncBatchToggle();
}

// A plan can be structurally appliable (canApply) yet still be refused by
// applyRecommendationSelection because one of its ORDERED members is
// guidance-only — buildApplicationPlan auto-includes dependency prerequisites,
// and a prerequisite can be guidance-only even when every card the author
// checked is executable. Mirror that exact gate here so the Apply button's
// enabled state and the previewed combined result never diverge from what an
// apply will actually do.
function batchPlanGuidanceBlock(plan) {
  return plan.order
    .map((id) => critiqueById(id))
    .some((critique) => critique?.proposal?.mode === "guidance_only");
}

async function setBatchMode(on) {
  if (state.batchMode === on) return;
  if (on) {
    state.batchMode = true;
    state.batchSelection = new Set();
    state.batchPreviewToken += 1; // invalidate any in-flight preview
    syncBatchToggle();
    renderCritiques();
    await refreshBatchPreview();
    return;
  }
  // Leaving batch mode: drop state + the ephemeral combined preview, then return
  // the canvas to the committed dashboard.
  const hadBatchPreview = Boolean(state.canvasPreview?.batch);
  resetBatchState();
  renderCritiques();
  if (hadBatchPreview) {
    renderCanvasPreviewControl();
    renderDashboardChrome({ renderContext: false });
    await renderTiles();
    renderMarkers();
  }
}

// Recompute the combined canvas preview for the current selection. Guarded by a
// monotonic token so a slow engine response for a stale selection can never
// overwrite a newer one. An empty or unappliable selection clears the preview.
// Show/hide the "building combined preview" affordance on the batch bar. The
// canvas only repaints once the engine returns the merged result, so a Select
// all (or a toggle that adds many fixes) can sit silent for a beat — this makes
// the wait legible. Idempotent; safe to call on every preview entry/exit.
function setBatchPreviewPending(pending) {
  const el = document.getElementById("batchPreviewStatus");
  if (el) el.hidden = !pending;
}

async function refreshBatchPreview() {
  const token = ++state.batchPreviewToken;
  const selectedIds = [...state.batchSelection];
  if (!selectedIds.length || !reviewResultsMatchContext() || !state.artifact.hasExecutableSpecs) {
    setBatchPreviewPending(false);
    await clearBatchPreview();
    renderBatchApplyBar();
    return;
  }
  const plan = buildApplicationPlan(selectedIds, state.critiques);
  renderBatchApplyBar(plan);
  // No previewable combined result when the plan can't apply (conflict/cycle) or
  // a prerequisite is guidance-only — the same two gates the bar enforces. Clear
  // any prior batch preview so the canvas doesn't show a merged result that no
  // longer matches the selection; the bar carries the blocker message.
  if (!plan.canApply || batchPlanGuidanceBlock(plan)) {
    setBatchPreviewPending(false);
    await clearBatchPreview();
    return;
  }
  setBatchPreviewPending(true);
  let result = null;
  try {
    result = await streamApply({
      version: state.version,
      context: reviewContextForEngine(),
      specMap: buildEngineSpecMap(),
      board: buildEngineBoardMeta(),
      critiques: state.critiques,
      selectedRecommendationIds: plan.order,
    });
  } catch (error) {
    console.warn("[batch preview]", error);
    if (token === state.batchPreviewToken) {
      setBatchPreviewPending(false);
      await failBatchPreview();
    }
    return;
  }
  if (token !== state.batchPreviewToken) return; // superseded by a newer selection
  setBatchPreviewPending(false);
  if (!result || result.rollback?.rolledBack) {
    await failBatchPreview();
    return;
  }
  state.canvasPreview = {
    batch: true,
    critiqueId: null,
    critiqueTitle: `${plan.order.length} combined ${plan.order.length === 1 ? "fix" : "fixes"}`,
    phase: "after",
    result,
    hasExecutableProposal: true,
    interactionPreview: null,
    accent: COLORS.visual,
  };
  renderCanvasPreviewControl();
  renderDashboardChrome({ renderContext: false });
  await renderTiles();
  renderMarkers();
}

// Drop a batch combined preview from the canvas and repaint to the committed
// dashboard. No-op when nothing batch-related is showing.
async function clearBatchPreview() {
  if (!state.canvasPreview?.batch) return;
  state.canvasPreview = null;
  renderCanvasPreviewControl();
  renderDashboardChrome({ renderContext: false });
  await renderTiles();
  renderMarkers();
}

// The combined preview couldn't be built for the current selection (engine threw
// or rolled back). Clear the stale preview and correct the bar note so it never
// claims the canvas shows a merged result it doesn't. Apply stays enabled — the
// apply path runs its own transaction and reports its own outcome honestly.
async function failBatchPreview() {
  await clearBatchPreview();
  const noteEl = document.getElementById("batchApplyNote");
  if (noteEl) noteEl.textContent = "Couldn't build the combined preview — you can still apply the selection.";
}

// Bottom apply bar: count, combined-result note, and the Apply button. The plan
// (when supplied) drives the conflict/dependency/guidance blocker and enablement,
// mirroring the single-critique Apply gate in applyRecommendationSelection.
function renderBatchApplyBar(plan = null) {
  const bar = document.getElementById("batchApplyBar");
  if (!bar) return;
  // Show the bar when the list offers something to batch (the idle "Select
  // multiple" entry) OR we are already in batch mode. The second clause matters:
  // the only exit control (Done) lives in the active face, so once in batch mode
  // the bar must stay even if a regenerate leaves zero eligible critiques —
  // otherwise the author is trapped in batch mode with no way out. batchMode
  // switches which FACE shows: idle entry vs. the active apply controls.
  const eligible = filteredCritiques().some(critiqueBatchEligible);
  bar.hidden = !(eligible || state.batchMode);
  bar.classList.toggle("active", state.batchMode);
  if (!state.batchMode) return;
  const count = state.batchSelection.size;
  const countEl = document.getElementById("batchApplyCount");
  const noteEl = document.getElementById("batchApplyNote");
  const applyButton = document.getElementById("batchApplyButton");
  const clearButton = document.getElementById("batchClearButton");
  const selectAllButton = document.getElementById("batchSelectAllButton");
  if (countEl) countEl.textContent = `${count} selected`;
  if (clearButton) clearButton.disabled = count === 0;
  // "Select all" adds every batch-eligible critique; disable it once nothing new
  // remains to add (no eligible critiques, or all of them are already selected).
  if (selectAllButton) {
    const eligibleIds = filteredCritiques().filter(critiqueBatchEligible).map((c) => c.id);
    selectAllButton.disabled = !eligibleIds.length || eligibleIds.every((id) => state.batchSelection.has(id));
  }
  const resolvedPlan = plan || (count ? buildApplicationPlan([...state.batchSelection], state.critiques) : null);
  const autoIncluded = resolvedPlan ? resolvedPlan.order.length - resolvedPlan.requested.length : 0;
  let note = "Choose fixes to apply together.";
  if (count === 0) note = "";
  let canApply = false;
  if (count) {
    if (!reviewResultsMatchContext()) {
      // Staleness keeps the button disabled; no note — the reason is transient
      // and the "regenerate first" copy read as noise (and misfires for
      // local-review sessions, per the interaction-logic audit).
      note = "";
    } else if (resolvedPlan?.unresolvedConflicts.length) {
      note = `Deselect ${resolvedPlan.unresolvedConflicts.length === 1 ? "a conflicting pair" : `${resolvedPlan.unresolvedConflicts.length} conflicting pairs`} to apply.`;
    } else if (resolvedPlan?.cyclic) {
      note = "These fixes depend on each other — narrow the selection.";
    } else if (resolvedPlan && batchPlanGuidanceBlock(resolvedPlan)) {
      note = "A prerequisite is guidance-only — apply it first.";
    } else if (resolvedPlan?.canApply) {
      note = autoIncluded > 0
        ? `Applies ${resolvedPlan.order.length} fixes (+${autoIncluded} prerequisite).`
        : `Applies ${resolvedPlan.order.length} ${resolvedPlan.order.length === 1 ? "fix" : "fixes"}.`;
      canApply = true;
    }
  }
  if (noteEl) noteEl.textContent = note;
  if (applyButton) applyButton.disabled = !canApply;
  bar.classList.toggle("ready", canApply);
}

function proposedSpecFor(critique, preview = null) {
  if (!critique.tileId) return null;
  const tile = tileById(critique.tileId);
  if (preview?.specMap?.[critique.tileId]) return clone(preview.specMap[critique.tileId]);
  const spec = clone(tile.spec);
  return spec;
}

async function enginePreviewFor(critique) {
  const matchesDashboard = !Number.isFinite(Number(critique?.lastEvaluatedVersion))
    || Number(critique.lastEvaluatedVersion) === state.version;
  if (!critique || !reviewResultsMatchContext() || !matchesDashboard || critique.proposal?.mode === "guidance_only" || critique.proposal?.kind === "manual" || !state.artifact.hasExecutableSpecs) return null;
  const key = `${state.artifact.id}:${state.version}:${critique.id}`;
  if (state.previewCache.has(key)) return state.previewCache.get(key);
  const plan = buildApplicationPlan([critique.id], state.critiques);
  if (!plan.canApply) return null;
  try {
    const result = await streamApply({
      version: state.version,
      context: reviewContextForEngine(),
      specMap: buildEngineSpecMap(),
      board: buildEngineBoardMeta(),
      critiques: state.critiques,
      selectedRecommendationIds: plan.order,
    });
    state.previewCache.set(key, result);
    return result;
  } catch (error) {
    console.warn("[engine preview]", error);
    return null;
  }
}

// Replay the coordinated before/after for whatever cross-filter the dashboard
// currently ships. A committed cross-filter only *enables* the behavior (a
// selection param; a show-filter-state usermeta flag) — nothing moves until the
// author clicks — so this briefly auto-plays a representative filtered
// after-state to make the coordination visibly real. Immediately after Apply,
// that representative selection stays visible until the author interacts.
// It runs automatically right after an add-cross-filter is accepted.
// The source/field/targets are read from the live usermeta, so the argument is
// unused and the call is safe with none.
async function playApplySettleDemo(appliedCritiques) {
  const source = state.tiles.find((tile) =>
    tile.spec?.usermeta?.crossFilter?.role === "source");
  const coordination = source?.spec?.usermeta?.crossFilter;
  if (!state.crossFilterEnabled || !source || !coordination?.field) return;
  const field = coordination.field;
  const scenario = buildInteractionScenario(
    { interactionKind: "cross-filter", proposal: { kind: "add-cross-filter" }, target: { ref: { source: source.id, field, targets: coordination.targets } } },
    buildEngineSpecMap(),
  );
  const value = scenario?.value;
  if (value === undefined || value === null) return;
  const keepAppliedState = Array.isArray(appliedCritiques) && appliedCritiques.length > 0;

  state.settleDemoPlaying = true;
  try {
    // Phase 1 — demonstrate the coordinated filtered state.
    state.crossFilterSelection = {
      field,
      value,
      source: coordination.source || source.id,
      targets: Array.isArray(coordination.targets) ? coordination.targets : [],
    };
    await renderTiles();
    await sleep(1500);
    if (!keepAppliedState) {
      // On-demand tests return to the neutral dashboard after demonstrating.
      state.crossFilterSelection = null;
      await renderTiles();
    }
  } finally {
    state.settleDemoPlaying = false;
  }
}

function applyLiveSnapshot(snapshot) {
  if (!snapshot) return;
  const specMap = snapshot.specMap || {};
  const board = snapshot.board || {};
  for (const tile of state.tiles) {
    if (specMap[tile.id]) tile.spec = clone(specMap[tile.id]);
  }
  if (board && typeof board === "object") {
    state.dashboardTitle = board.title ?? state.dashboardTitle;
    state.dashboardSubtitle = board.subtitle ?? state.dashboardSubtitle;
    if ("hasKpis" in board) state.showKpis = Boolean(board.hasKpis);
    if (Array.isArray(board.kpis)) state.boardKpis = clone(board.kpis);
    if (board.kpiStyle) state.boardKpiStyle = board.kpiStyle;
    state.boardKpiPresentation = {
      layout: board.kpiLayout || state.boardKpiPresentation.layout,
      alignment: board.kpiAlignment || state.boardKpiPresentation.alignment,
      density: board.kpiDensity || state.boardKpiPresentation.density,
      chrome: board.kpiChrome || state.boardKpiPresentation.chrome,
      reservedHeight: Number(board.kpiReservedHeight) || state.boardKpiPresentation.reservedHeight,
      reservedWidth: Number(board.kpiReservedWidth) || state.boardKpiPresentation.reservedWidth,
    };
    if (Array.isArray(board.filters)) state.dashboardFilters = clone(board.filters);
    if (Array.isArray(board.tiles)) {
      const boundsById = new Map(
        board.tiles
          .filter((tile) => tile && tile.bounds)
          .map((tile) => [tile.id, tile.bounds]),
      );
      for (const tile of state.tiles) {
        const bounds = boundsById.get(tile.id);
        if (bounds) tile.bounds = { ...bounds };
      }
      state.showChartSubtitles = board.tiles.every((tile) => tile.hasSubtitle);
    }
  }
  state.crossFilterEnabled = state.tiles.some((tile) => tile.spec?.usermeta?.crossFilter?.role === "source");
  state.activeFilterState = state.tiles.some((tile) => tile.spec?.usermeta?.activeFilterState);
  state.previewCache.clear();
  state.canvasPreview = null;
}

async function refreshAfterDashboardMutation() {
  renderCanvasPreviewControl();
  renderDashboardChrome();
  await renderTiles();
  renderMarkers();
  renderCritiques();
  renderVersions();
  renderWorkingDraftStatus();
  await renderInspector();
}

async function restoreDashboardCheckpoint(checkpoint) {
  if (!checkpoint?.afterSnapshot) return;
  const beforeVersion = Number(state.version) || 1;
  if (state.workingDraft.dirty && !window.confirm(
    "Restore this checkpoint? Unsaved Working Draft changes will be discarded.",
  )) return;
  applyLiveSnapshot(checkpoint.afterSnapshot);
  const afterVersion = beforeVersion + 1;
  state.version = afterVersion;
  state.workingDraft = createWorkingDraft(checkpoint.id);
  recordStudyAction("dashboard_state_restored", `Restored Checkpoint ${checkpoint.id}`, {
    source: "checkpoint",
    checkpointId: checkpoint.id,
    beforeVersion,
    afterVersion,
  });
  await refreshAfterDashboardMutation();
}

async function applyRecommendationSelection(selectedIds, conflictChoices = {}, { via, applyId: existingApplyId, skipRequest = false } = {}) {
  const requestedCritiqueIds = [...selectedIds];
  const applyVia = via || (requestedCritiqueIds.length > 1 ? "batch" : "single");
  const applyId = existingApplyId || newStudyId();
  const beforeVersion = Number(state.version) || 1;
  if (!skipRequest) {
    recordStudyAction("recommendation_apply_requested", `Requested apply of ${requestedCritiqueIds.length} recommendation${requestedCritiqueIds.length === 1 ? "" : "s"}`, {
      applyId,
      via: applyVia,
      requestedCritiqueIds,
      dashboardVersion: beforeVersion,
    });
  }
  const failApply = (reason, extra = {}) => {
    recordStudyAction("recommendation_apply_failed", `Apply failed (${applyVia})`, {
      applyId,
      via: applyVia,
      requestedCritiqueIds,
      committedCritiqueIds: extra.committedCritiqueIds || [],
      failedCritiqueIds: extra.failedCritiqueIds || requestedCritiqueIds,
      failureStage: extra.failureStage || "precondition",
      failureCode: extra.failureCode || extra.failureStage || "precondition",
      reason: reason || null,
      rollback: extra.rollback || false,
      beforeVersion,
      afterVersion: Number(state.version) || beforeVersion,
      critiqueId: requestedCritiqueIds.length === 1 ? requestedCritiqueIds[0] : null,
    });
    return { ok: false, plan: extra.plan || null, reason, applyId, ...extra };
  };
  if (!reviewResultsMatchContext()) {
    return failApply("Regenerate critiques for the confirmed context before applying changes.", {
      failureStage: "context_mismatch",
    });
  }
  const plan = buildApplicationPlan(selectedIds, state.critiques, conflictChoices);
  if (!plan.canApply) {
    return failApply("Resolve recommendation conflicts before applying.", {
      plan,
      failureStage: "conflicts",
    });
  }
  const staleForDashboard = plan.order
    .map((id) => critiqueById(id))
    .filter((critique) => critique
      && Number.isFinite(Number(critique.lastEvaluatedVersion))
      && Number(critique.lastEvaluatedVersion) !== state.version);
  if (staleForDashboard.length) {
    return failApply(
      "This recommendation was generated for an earlier dashboard version. Regenerate critiques before applying it.",
      {
        plan,
        failureStage: "stale_dashboard",
        failedCritiqueIds: staleForDashboard.map((critique) => critique.id),
      },
    );
  }
  const guidanceOnly = plan.order.map((id) => critiqueById(id)).filter((critique) => critique?.proposal?.mode === "guidance_only");
  if (guidanceOnly.length) {
    return failApply("Guidance-only recommendations must be implemented manually.", {
      plan,
      failureStage: "guidance_only",
      failedCritiqueIds: guidanceOnly.map((critique) => critique.id),
    });
  }
  if (!state.artifact.hasExecutableSpecs) {
    return failApply("This artifact has no executable JSON specs.", {
      plan,
      failureStage: "no_executable_specs",
    });
  }
  const appliedCritiques = plan.order
    .map((id) => critiqueById(id))
    .filter(Boolean)
    .map((critique) => clone(critique));
  const beforeSpecMap = buildEngineSpecMap();
  const beforeBoard = buildEngineBoardMeta();
  const beforeScreenshot = await captureDashboardScreenshot();

  let result;
  try {
    tracePanel.start("Apply — engine transaction");
    result = await streamApply(
      {
        version: state.version,
        context: reviewContextForEngine(),
        specMap: beforeSpecMap,
        board: beforeBoard,
        critiques: state.critiques,
        selectedRecommendationIds: plan.order,
        conflictChoices,
      },
      (event) => tracePanel.event(event),
    );
    if (!result) throw new Error("Engine returned no apply result.");
    if (result.rollback?.rolledBack) throw new Error(result.rollback.reason || "Engine rolled back the change.");
    tracePanel.done();
  } catch (err) {
    tracePanel.fail(`engine apply failed — ${err.message || err}`);
    return failApply(err.message || String(err), {
      plan,
      failureStage: result?.rollback?.rolledBack ? "rollback" : "engine",
      rollback: Boolean(result?.rollback?.rolledBack),
    });
  }

  // Some selected fixes changed the same part of a tile and the engine could not
  // auto-merge them. Do not commit a partial result — return the conflicts so the
  // author picks one and we re-apply with a conflictChoices resolution.
  if (result.unresolvedConflicts?.length) {
    return {
      ok: false,
      plan,
      needsConflictChoice: true,
      unresolvedConflicts: result.unresolvedConflicts,
      applyId,
    };
  }

  const byId = new Map(state.critiques.map((critique) => [critique.id, critique]));
  for (const id of result.applicationOrder || []) {
    const critique = byId.get(id);
    if (critique) critique.status = "resolved";
  }
  for (const id of result.recommendationDelta?.removed || []) {
    const critique = byId.get(id);
    if (critique) critique.status = "superseded";
  }
  // Honest per-critique outcomes from the engine: a fix the author dropped in a
  // conflict choice is superseded even though the deterministic delta (which only
  // knows kind-level conflicts) does not list it.
  for (const entry of result.critiqueStatuses || []) {
    const critique = byId.get(entry.id);
    if (critique && entry.status === "superseded") critique.status = "superseded";
  }
  const additions = (result.addedCritiques || []).filter((critique) => !byId.has(critique.id));
  const nextVersion = state.version + 1;
  const committedIds = Array.isArray(result.applicationOrder)
    ? result.applicationOrder.filter(Boolean)
    : appliedCritiques.map((critique) => critique.id);
  const committedCritiques = appliedCritiques.filter((critique) => committedIds.includes(critique.id));
  const appliedIds = [
    ...committedIds,
    ...committedCritiques.map((critique) => critique.id),
  ];
  state.critiques = scopeRank(retainRecommendationFreshness(
    enrichRecommendations([...state.critiques, ...additions], nextVersion),
    {
      appliedIds,
      changedTargets: result.changedTargets || [],
      nextVersion,
    },
  ));
  for (const tile of state.tiles) {
    if (result.specMap?.[tile.id]) tile.spec = clone(result.specMap[tile.id]);
  }
  if (result.board) {
    state.dashboardTitle = result.board.title ?? state.dashboardTitle;
    state.dashboardSubtitle = result.board.subtitle ?? state.dashboardSubtitle;
    state.showKpis = Boolean(result.board.hasKpis);
    // Commit the engine's real, computed KPIs (ResolvedKpi[]) so the band renders
    // actual values, not the old hardcoded placeholders.
    state.boardKpis = Array.isArray(result.board.kpis) ? result.board.kpis : state.boardKpis;
    state.boardKpiStyle = result.board.kpiStyle || state.boardKpiStyle;
    state.boardKpiPresentation = {
      layout: result.board.kpiLayout || state.boardKpiPresentation.layout,
      alignment: result.board.kpiAlignment || state.boardKpiPresentation.alignment,
      density: result.board.kpiDensity || state.boardKpiPresentation.density,
      chrome: result.board.kpiChrome || state.boardKpiPresentation.chrome,
      reservedHeight: Number(result.board.kpiReservedHeight) || 0,
      reservedWidth: Number(result.board.kpiReservedWidth) || 0,
    };
    state.dashboardFilters = Array.isArray(result.board.filters) ? clone(result.board.filters) : state.dashboardFilters;
    state.showChartSubtitles = Boolean(result.board.tiles?.length) && result.board.tiles.every((tile) => tile.hasSubtitle);
    // A board-layout / KPI-band change may relocate or resize tiles, but never
    // changes the uploaded canvas dimensions.
    if (Array.isArray(result.board.tiles)) {
      const boundsById = new Map(
        result.board.tiles
          .filter((tile) => tile && tile.bounds)
          .map((tile) => [tile.id, tile.bounds]),
      );
      for (const tile of state.tiles) {
        const bounds = boundsById.get(tile.id);
        if (bounds) tile.bounds = { ...bounds };
      }
    }
  }
  state.crossFilterEnabled = state.tiles.some((tile) => tile.spec?.usermeta?.crossFilter?.role === "source");
  state.activeFilterState = state.tiles.some((tile) => tile.spec?.usermeta?.activeFilterState);
  state.version = nextVersion;
  state.previewCache.clear();
  state.canvasPreview = null;
  const decisionEvents = committedCritiques.map((critique) => appendInteractionEvent({
    kind: "recommendation_accepted",
    summary: `Accepted recommendation: ${critique.title}`,
    detail: critique.suggestion,
    critiqueId: critique.id,
    dimension: critique.dimension,
    proposalKind: critique.proposal?.kind,
    data: {
      target: critique.tileId || "dashboard",
      decision: "apply",
      applyId,
      critiqueRevisionId: critique.revision || null,
      dashboardVersion: nextVersion,
    },
  }));
  const appliedEvent = appendInteractionEvent({
    kind: "changes_applied",
    summary: `Applied ${committedIds.length} ${committedIds.length === 1 ? "change" : "changes"} to the Working Draft`,
    data: {
      applyId,
      via: applyVia,
      recommendationIds: [...committedIds],
      requestedCritiqueIds,
      committedCritiqueIds: [...committedIds],
      failedCritiqueIds: requestedCritiqueIds.filter((id) => !committedIds.includes(id)),
      changedTargets: [...(result.changedTargets || [])],
      beforeVersion,
      afterVersion: nextVersion,
      rollback: false,
    },
  }, { synthesize: false });
  const changeId = recordDashboardChanged({
    source: "vizier_apply",
    operation: classifyDashboardOperation(result.changedTargets || [], committedCritiques),
    targetIds: [...(result.changedTargets || [])],
    beforeVersion,
    afterVersion: nextVersion,
    relatedCritiqueIds: [...committedIds],
    relatedApplyId: applyId,
    diffSummary: {
      changedTargets: [...(result.changedTargets || [])],
      remainingFindings: result.evaluationReport?.remainingFindings ?? null,
    },
  });
  const evaluationEvent = appendInteractionEvent({
    kind: "working_draft_reevaluated",
    summary: `Re-evaluated the Working Draft: ${result.evaluationReport?.remainingFindings ?? 0} findings remain`,
    data: {
      compiled: Boolean(result.evaluationReport?.compiled),
      remainingFindings: result.evaluationReport?.remainingFindings ?? 0,
    },
  }, { synthesize: false });
  state.workingDraft = recordWorkingDraftApplication(state.workingDraft, {
    appliedCritiques: committedCritiques,
    result,
    beforeSnapshot: {
      specMap: beforeSpecMap,
      board: beforeBoard,
    },
    afterSnapshot: {
      specMap: result.specMap || beforeSpecMap,
      board: result.board || beforeBoard,
    },
    beforeScreenshot,
    createdFromEventIds: [
      ...decisionEvents.map((event) => event.id),
      appliedEvent.id,
      evaluationEvent.id,
    ],
  });
  state.selectedCritiqueId = null;
  state.selectedTileId = null;
  state.canvasPreview = null;

  renderCanvasPreviewControl();
  renderDashboardChrome();
  await renderTiles();
  renderMarkers();
  renderCritiques();
  renderVersions();
  renderWorkingDraftStatus();
  renderInspector();
  // When an interaction fix was just enabled, run the demo-then-settle so its
  // effect is visibly real before the canvas returns to rest. Awaited so callers
  // (and tests) observe the settled state; failures never block the apply result.
  const enabledInteraction = committedCritiques.some((critique) =>
    critique.proposal?.kind === "add-cross-filter" || critique.proposal?.kind === "show-filter-state");
  if (enabledInteraction) {
    try {
      await playApplySettleDemo(committedCritiques);
    } catch (error) {
      console.warn("[apply settle demo]", error);
      state.settleDemoPlaying = false;
    }
  }
  return { ok: true, plan, delta: result.recommendationDelta, applyId };
}

// Modal: for each same-tile conflict the engine could not auto-merge, let the
// author keep exactly one fix. Resolves to a { groupKey: chosenCritiqueId } map,
// or null when the author cancels. Built dynamically so it carries no static
// markup and cleans itself up on close.
function promptConflictChoices(conflicts) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "conflict-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Resolve conflicting fixes");
    const groupsHtml = conflicts.map((group, groupIndex) => {
      const tileLabel = tileById(group.tileId)?.title || group.tileId;
      const options = group.critiqueIds.map((id, optionIndex) => {
        const critique = critiqueById(id);
        const title = critique?.title || id;
        const detail = critique?.suggestion || "";
        return `<label class="conflict-option">
          <input type="radio" name="conflict-${groupIndex}" value="${escapeHTML(id)}" ${optionIndex === 0 ? "checked" : ""} />
          <span class="conflict-option-body">
            <span class="conflict-option-title">${escapeHTML(title)}</span>
            ${detail ? `<span class="conflict-option-detail">${escapeHTML(detail)}</span>` : ""}
          </span>
        </label>`;
      }).join("");
      return `<section class="conflict-group">
        <p class="conflict-group-head">These fixes change the same part of <strong>${escapeHTML(tileLabel)}</strong> — keep one:</p>
        ${options}
      </section>`;
    }).join("");
    overlay.innerHTML = `
      <div class="conflict-modal">
        <h2 class="conflict-title">Resolve conflicting fixes</h2>
        <p class="conflict-subtitle">VIZier couldn't automatically combine these overlapping fixes. Choose which one to apply for each.</p>
        ${groupsHtml}
        <div class="modal-actions">
          <button type="button" class="button ghost small" data-action="cancel">Cancel</button>
          <button type="button" class="button primary small" data-action="apply">Apply chosen fixes</button>
        </div>
      </div>`;
    const close = (value) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => { if (event.key === "Escape") close(null); };
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(null); });
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(null));
    overlay.querySelector('[data-action="apply"]').addEventListener("click", () => {
      const choices = {};
      conflicts.forEach((group, groupIndex) => {
        const picked = overlay.querySelector(`input[name="conflict-${groupIndex}"]:checked`);
        if (picked) choices[group.key] = picked.value;
      });
      close(choices);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector("input[type=radio]")?.focus();
  });
}

// Apply a batch selection, resolving any engine-reported same-tile conflicts by
// prompting the author to pick one fix per group and re-applying. The guard caps
// the round-trips so a stubborn conflict can never loop forever.
async function applySelectionResolvingConflicts(selectedIds) {
  let conflictChoices = {};
  let applyId = null;
  const via = selectedIds.length > 1 ? "batch" : "single";
  for (let round = 0; round < 8; round += 1) {
    const applied = await applyRecommendationSelection(selectedIds, conflictChoices, {
      via,
      applyId,
      skipRequest: Boolean(applyId),
    });
    applyId = applied.applyId || applyId;
    if (!applied.needsConflictChoice) return applied;
    const choices = await promptConflictChoices(applied.unresolvedConflicts);
    if (!choices) {
      recordStudyAction("recommendation_apply_failed", `Apply failed (${via})`, {
        applyId,
        via,
        requestedCritiqueIds: [...selectedIds],
        committedCritiqueIds: [],
        failedCritiqueIds: [...selectedIds],
        failureStage: "conflict_cancelled",
        failureCode: "conflict_cancelled",
        reason: "Conflict resolution cancelled — nothing was applied.",
        rollback: false,
        dashboardVersion: Number(state.version) || 1,
      });
      return { ok: false, plan: applied.plan, reason: "Conflict resolution cancelled — nothing was applied.", applyId };
    }
    conflictChoices = { ...conflictChoices, ...choices };
  }
  return { ok: false, reason: "Could not resolve the conflicting fixes.", applyId };
}

function showFocusApplyFailure(reason) {
  const footer = document.querySelector("#critiqueFocusView .focus-actions");
  if (!footer) return;
  let notice = document.getElementById("focusApplyFailure");
  if (!notice) {
    notice = document.createElement("section");
    notice.id = "focusApplyFailure";
    notice.className = "focus-decision-notice";
    notice.setAttribute("role", "alert");
    footer.before(notice);
  }
  notice.innerHTML = `<span aria-hidden="true">!</span><div><strong>Change not applied</strong><p>${escapeHTML(reason)}</p></div>`;
  notice.scrollIntoView({ block: "nearest" });
}

async function saveWorkingDraftCheckpoint() {
  if (!state.workingDraft.dirty) return;
  const button = document.getElementById("saveCheckpointButton");
  const buttonLabel = button?.querySelector("span");
  if (button) button.disabled = true;
  if (buttonLabel) buttonLabel.textContent = "Saving…";

  try {
    const checkpointId = Math.max(...state.versions.map((version) => version.id)) + 1;
    const recommendationIds = [...(state.workingDraft.applicationOrder || [])];
    const checkpointEvent = appendInteractionEvent({
      kind: "checkpoint_saved",
      summary: `Saved Checkpoint ${checkpointId} with ${recommendationIds.length} ${recommendationIds.length === 1 ? "change" : "changes"}`,
      data: {
        baseCheckpointId: state.workingDraft.baseCheckpointId,
        recommendationIds,
      },
    }, { synthesize: false });
    const checkpoint = buildRevisionCheckpoint({
      version: checkpointId,
      appliedCritiques: state.workingDraft.appliedCritiques,
      result: {
        applicationOrder: state.workingDraft.applicationOrder,
        changedTargets: state.workingDraft.changedTargets,
        recommendationDelta: state.workingDraft.recommendationDelta,
        evaluationReport: state.workingDraft.evaluationReport,
      },
      beforeSnapshot: state.workingDraft.beforeSnapshot,
      afterSnapshot: state.workingDraft.afterSnapshot || {
        specMap: buildEngineSpecMap(),
        board: buildEngineBoardMeta(),
      },
      beforeScreenshot: state.workingDraft.beforeScreenshot
        || state.versions.at(-1)?.afterScreenshot
        || null,
      afterScreenshot: null,
      createdFromEventIds: [
        ...state.workingDraft.createdFromEventIds,
        checkpointEvent.id,
      ],
    });
    const captured = await captureDashboardExport().catch((error) => {
      console.warn("[revision-screenshot] checkpoint PNG capture failed", error);
      return { screenshot: null, png: null, svg: null, snapshot: null };
    });
    checkpoint.afterSnapshot = captured.snapshot || checkpoint.afterSnapshot;
    checkpoint.afterScreenshot = captured.screenshot;
    checkpoint.afterPng = captured.png;
    checkpoint.afterSvg = captured.svg || null;
    state.versions.push(checkpoint);
    state.selectedVersionId = checkpointId;
    state.checkpointComparison = {
      before: state.workingDraft.baseCheckpointId,
      after: checkpointId,
    };
    state.workingDraft = createWorkingDraft(checkpointId);
    state.drawers.versions = true;
    renderVersions();
    renderWorkingDraftStatus();
    applyDrawers();
  } finally {
    if (buttonLabel) buttonLabel.textContent = "Save Checkpoint";
    renderWorkingDraftStatus();
  }
}

// Schematic thumbnail of the dashboard, used for structural / region change
// previews where the change is about a whole area rather than one chart or
// a piece of text. `highlight` accents the affected region on the "after" board.
function miniBoard({ kpis = false, subtitles = false, highlight = null, box = null } = {}) {
  const tiles = Array.from({ length: 4 }).map(() => `
    <div class="mb-tile">
      <span class="mb-tl${highlight === "labels" ? " hl" : ""}"></span>
      ${subtitles ? `<span class="mb-ts"></span>` : ""}
      <span class="mb-chart"></span>
    </div>`).join("");
  const kpiBand = kpis
    ? `<div class="mb-kpis${highlight === "kpi" ? " hl" : ""}">${Array.from({ length: 5 }).map(() => "<span></span>").join("")}</div>`
    : "";
  // Position the overlay box as a fraction of the LIVE canvas, not a fixed
  // 1100×720 — uploaded dashboards can be larger, and hardcoded denominators
  // would push the box off the mini canvas proportionally to the excess.
  const canvasW = state.canvasSize?.width || 1100;
  const canvasH = state.canvasSize?.height || 720;
  const boxEl = box
    ? `<div class="mb-box" style="left:${(box.x / canvasW) * 100}%;top:${(box.y / canvasH) * 100}%;width:${(box.w / canvasW) * 100}%;height:${(box.h / canvasH) * 100}%"></div>`
    : "";
  return `<div class="mb">
    <div class="mb-title"></div>
    ${kpiBand}
    <div class="mb-grid">${tiles}</div>
    ${boxEl}
  </div>`;
}

// ---------------------------------------------------------------------------
// Interaction runtime — actions are derived from the focused critique and the
// currently loaded Vega-Lite artifact, dispatched to live Vega views, and
// compared as observed Before/After evidence on the real canvas.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let demoCursorEl = null;
let demoPrev = null;
let demoPhase = "before";

// Cute rounded pointer — solid black with a white outline.
const CURSOR_SVG = `
<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M7.2 4.1c-1-.5-2.2.4-1.9 1.5l3.4 16.6c.25 1.2 1.9 1.45 2.5.35l2.4-4.6 5.2-.8c1.25-.2 1.65-1.8.6-2.55L7.2 4.1z"
        fill="#141414" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>
</svg>`;

function setDemoBanner(step, text) {
  const banner = document.getElementById("demoBanner");
  if (banner) banner.querySelector(".demo-banner-text").innerHTML = `<b>${step}</b>${text}`;
}

let runtimeScenario = null;
let runtimeCritiqueId = null;
let runtimeObservationInFlight = false;

// Phase switching during a runtime test is driven by the canvas' own
// Original/Proposed toggle (top-left of the canvas), so disable that control
// while an observation is dispatching to avoid overlapping runs.
function setRuntimeToggleDisabled(disabled) {
  const toggle = document.getElementById("canvasPreviewToggle");
  if (toggle) toggle.disabled = disabled;
}

function runtimeMarkElements(tileId) {
  const host = document.getElementById(`vega-${tileId}`);
  if (!host) return [];
  const selector = [
    ".mark-symbol path",
    ".mark-rect path",
    ".mark-line path",
    ".mark-area path",
    ".mark-arc path",
    "svg [role='graphics-symbol']",
  ].join(",");
  const primary = [...host.querySelectorAll(selector)].filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (primary.length) return primary;
  return [...host.querySelectorAll("svg path, svg rect, svg circle")].filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function runtimePoint(element) {
  if (!element) return null;
  const viewport = els.canvasViewport.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - viewport.left,
    y: rect.top + Math.min(rect.height / 2, 10) - viewport.top,
  };
}

function runtimeMoveCursor(point) {
  if (!demoCursorEl || !point) return;
  demoCursorEl.style.left = `${point.x}px`;
  demoCursorEl.style.top = `${point.y}px`;
}

function runtimePulse(point) {
  if (!point) return;
  demoCursorEl?.classList.add("clicking");
  setTimeout(() => demoCursorEl?.classList.remove("clicking"), 260);
  const burst = document.createElement("div");
  burst.className = "demo-burst";
  burst.style.left = `${point.x}px`;
  burst.style.top = `${point.y}px`;
  burst.innerHTML =
    `<span class="demo-burst-ring"></span><span class="demo-burst-ring d2"></span>` +
    Array.from({ length: 6 }).map((_, index) =>
      `<span class="demo-burst-spark" style="--a:${index * 60}deg"></span>`).join("");
  els.canvasViewport.appendChild(burst);
  setTimeout(() => burst.remove(), 720);
}

function runtimeFingerprint(tileId) {
  const host = document.getElementById(`vega-${tileId}`);
  if (!host) return "missing";
  const marks = host.querySelectorAll(
    ".mark-symbol path,.mark-rect path,.mark-line path,.mark-area path,.mark-arc path",
  );
  const geometry = [...marks].map((mark) =>
    `${mark.getAttribute("d") || ""}|${mark.getAttribute("opacity") || ""}`).join(";");
  return `${host.textContent?.replace(/\s+/g, " ").trim()}|${marks.length}|${geometry}`;
}

function runtimeTooltipText() {
  const tooltip = [...document.querySelectorAll(
    ".vg-tooltip, #vg-tooltip-element",
  )]
    .find((node) =>
      !node.classList.contains("hidden") &&
      getComputedStyle(node).display !== "none" &&
      node.getBoundingClientRect().width > 0);
  return tooltip?.textContent?.replace(/\s+/g, " ").trim() || null;
}

function runtimeActionText(scenario) {
  const title = tileById(scenario.sourceTile)?.label || scenario.sourceTile;
  if (scenario.kind === "cross-filter") {
    return `Click ${scenario.field} = ${scenario.value} in ${title}`;
  }
  const value = scenario.values?.[0];
  return `Hover ${value ? `${value.field} = ${value.value}` : "a data mark"} in ${title}`;
}

function runtimeEvent(element, scenario) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(new MouseEvent(
    scenario.action === "click" ? "click" : "mouseover",
    {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    },
  ));
}

async function dispatchRuntimeScenario(scenario) {
  const view = state.views[scenario.sourceTile];
  const elements = runtimeMarkElements(scenario.sourceTile);
  if (!view || !elements.length) return { executed: false, point: null, datum: null };
  const eventType = scenario.action === "click" ? "click" : "mouseover";
  let observedItem = null;
  let currentElement = null;
  const listener = (_event, item) => {
    observedItem = item;
  };
  view.addEventListener(eventType, listener);
  try {
    for (const element of elements) {
      observedItem = null;
      currentElement = element;
      runtimeEvent(element, scenario);
      await sleep(0);
      const datum = observedItem?.datum;
      if (!datum) continue;
      if (scenario.kind === "cross-filter" && datum[scenario.field] === undefined) continue;
      if (
        scenario.kind === "hover-tooltip" &&
        scenario.fields?.length &&
        !scenario.fields.some((field) => datum[field] !== undefined)
      ) continue;
      return { executed: true, point: runtimePoint(element), datum: clone(datum) };
    }
  } finally {
    view.removeEventListener(eventType, listener);
  }
  return {
    executed: Boolean(currentElement),
    point: runtimePoint(currentElement),
    datum: null,
  };
}

async function runRuntimeObservation(scenario, phase) {
  runtimeObservationInFlight = true;
  setRuntimeToggleDisabled(true);
  try {
    const targets = scenario.targetTiles.length ? scenario.targetTiles : [scenario.sourceTile];
    const before = Object.fromEntries(targets.map((id) => [id, runtimeFingerprint(id)]));
    const action = await dispatchRuntimeScenario(scenario);
    runtimeMoveCursor(action.point);
    runtimePulse(action.point);
    await sleep(scenario.kind === "cross-filter" ? 700 : 220);
    const tooltip = runtimeTooltipText();
    const after = Object.fromEntries(targets.map((id) => [id, runtimeFingerprint(id)]));
    return {
      phase,
      executed: action.executed,
      datum: action.datum,
      changedTargets: targets.filter((id) => before[id] !== after[id]),
      tooltip,
    };
  } finally {
    runtimeObservationInFlight = false;
    setRuntimeToggleDisabled(false);
  }
}

async function setInteractionRuntimePhase(phase) {
  if (!state.demoPlaying || !runtimeScenario) return;
  demoPhase = phase;
  if (state.canvasPreview) state.canvasPreview.phase = phase;
  state.crossFilterEnabled = phase === "after" && runtimeScenario.kind === "cross-filter";
  state.crossFilterSelection = null;
  renderCanvasPreviewControl();
  renderDashboardChrome({ renderContext: false });
  await renderTiles();
  setDemoBanner(
    phase === "after" ? "Proposed" : "Original",
    `${runtimeActionText(runtimeScenario)}. VIZier will observe the live Vega result.`,
  );
}

async function transitionInteractionRuntimePhase(phase) {
  runtimeObservationInFlight = true;
  setRuntimeToggleDisabled(true);
  try {
    await setInteractionRuntimePhase(phase);
  } finally {
    runtimeObservationInFlight = false;
    setRuntimeToggleDisabled(false);
  }
}

// The canvas Original/Proposed toggle drives runtime phase switching manually:
// switch the phase, then observe the live Vega result for exactly that phase.
async function switchInteractionRuntimePhase(phase) {
  if (runtimeObservationInFlight || demoPhase === phase) return;
  await transitionInteractionRuntimePhase(phase);
  await observeInteractionPhase();
}

// Run exactly one observation for the current phase and report it. Phase
// switching is manual (driven by the canvas Original/Proposed toggle), so this
// no longer loops or auto-flips — each phase is observed only when the author
// selects it.
async function observeInteractionPhase() {
  if (!state.demoPlaying || !runtimeScenario) return;
  const phase = demoPhase;
  setDemoBanner(phase === "after" ? "Proposed" : "Original", runtimeActionText(runtimeScenario));
  const observation = await runRuntimeObservation(runtimeScenario, phase);
  if (!state.demoPlaying) return;
  state.interactionObservations.set(runtimeCritiqueId, {
    ...(state.interactionObservations.get(runtimeCritiqueId) || {}),
    scenario: clone(runtimeScenario),
    [phase]: observation,
  });
  if (!observation.executed) {
    setDemoBanner("Not Executed", "No rendered data mark was available for this interaction.");
  } else if (runtimeScenario.kind === "hover-tooltip") {
    setDemoBanner(
      phase === "after" ? "Proposed · Observed" : "Original · Observed",
      observation.tooltip
        ? `The live Vega tooltip surfaced: ${observation.tooltip}`
        : "The pointer event executed, but the Vega view surfaced no tooltip.",
    );
  } else {
    setDemoBanner(
      phase === "after" ? "Proposed · Observed" : "Original · Observed",
      observation.changedTargets.length
        ? `${observation.changedTargets.length} related ${observation.changedTargets.length === 1 ? "view changed" : "views changed"} after the click.`
        : "The click executed, but no related view changed.",
    );
  }
}

async function exitInteractionRuntime() {
  if (!state.demoPlaying) return;
  state.demoPlaying = false;
  if (demoPrev) {
    state.crossFilterEnabled = demoPrev.crossFilterEnabled;
    state.crossFilterSelection = demoPrev.crossFilterSelection;
    if (state.canvasPreview && demoPrev.canvasPreviewPhase) {
      state.canvasPreview.phase = demoPrev.canvasPreviewPhase;
    }
  }
  document.querySelector(".app-shell")?.classList.remove("demo-playing");
  document.getElementById("demoToolbar")?.remove();
  document.getElementById("demoBanner")?.remove();
  document.getElementById("demoCursor")?.remove();
  demoCursorEl = null;
  renderCanvasPreviewControl();
  renderDashboardChrome({ renderContext: false });
  await renderTiles();
  await renderInspector();
}

async function playInteractionRuntime(critique) {
  if (state.demoPlaying) return;
  const scenario = buildInteractionScenario(critique, buildEngineSpecMap());
  if (!scenario) {
    // The button is only shown when a scenario resolves, so this is a defensive
    // guard rather than a user-facing dead end.
    console.warn("[interaction runtime] no executable scenario for", critique.id);
    return;
  }
  // The engine preview stamps the coordination usermeta the runtime uses to show
  // the "after" phase. When it can't be produced (e.g. the cross-filter is
  // already applied, as with the show-filter-state follow-up), fall back to the
  // current live specs so the runtime still drives the real Vega marks.
  const preview = (await enginePreviewFor(critique)) || {
    specMap: buildEngineSpecMap(),
    board: buildEngineBoardMeta(),
    changedTargets: [scenario.sourceTile, ...scenario.targetTiles],
  };
  runtimeScenario = scenario;
  runtimeCritiqueId = critique.id;
  demoPrev = {
    crossFilterEnabled: state.crossFilterEnabled,
    crossFilterSelection: clone(state.crossFilterSelection),
    canvasPreviewPhase: state.canvasPreview?.phase || null,
  };
  state.canvasPreview = {
    critiqueId: critique.id,
    critiqueTitle: critique.title,
    phase: "before",
    result: preview,
    hasExecutableProposal: true,
    accent: critiqueGroupPresentation(critique.dimension).color,
  };
  state.demoPlaying = true;
  demoPhase = "before";
  document.querySelector(".app-shell")?.classList.add("demo-playing");
  // A focused critique already carries an Original/Proposed toggle in its detail
  // card (the persistent #canvasPreviewControl is reparented into #focusCompareSlot,
  // directly above the Run interaction test button), so the runtime toolbar only
  // needs an Exit control — phase switching is manual and routed through that same
  // toggle, wherever it currently lives.
  els.canvasViewport.insertAdjacentHTML("beforeend", `
    <div class="demo-toolbar" id="demoToolbar">
      <button class="demo-stop" id="demoStop" type="button">✕ Exit</button>
    </div>
    <div class="demo-banner" id="demoBanner"><span class="demo-banner-text"></span></div>
    <div class="demo-cursor" id="demoCursor" aria-hidden="true">
      <div class="demo-cursor-inner">${CURSOR_SVG}</div>
    </div>`);
  demoCursorEl = document.getElementById("demoCursor");
  document.getElementById("demoStop").addEventListener("click", exitInteractionRuntime);
  await transitionInteractionRuntimePhase("before");
  const firstPoint = runtimePoint(runtimeMarkElements(scenario.sourceTile)[0]);
  if (firstPoint) runtimeMoveCursor({ x: firstPoint.x - 60, y: firstPoint.y + 70 });
  await sleep(600);
  // Observe the initial ("before") phase once; the author switches to
  // "proposed" via the detail-card toggle to observe the after phase.
  await observeInteractionPhase();
}

const FOCUS_FIELD_LABELS = {
  issue: "Diagnosis",
  evidence: "Evidence",
  rationale: "Why it matters",
  suggestion: "Recommended Change",
};

function critiqueFieldEntries(critique) {
  const standard = Object.entries(critique)
    .filter(([key, value]) => FOCUS_FIELD_LABELS[key] && typeof value === "string" && value.trim())
    .map(([key, value]) => ({ key, label: FOCUS_FIELD_LABELS[key], value }));
  const extensions = Object.entries(critique.details || {})
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => ({
      key,
      label: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase()),
      value,
    }));
  return [...standard, ...extensions];
}

// Concrete, grounded evidence rendered beneath the general "Evidence" sentence.
// Each ref was validated in the engine (its path resolves to a real spec/context
// value), so this surfaces the specifics — the tile it concerns, the field/channel,
// and the observed value — instead of leaving only the model's one-line paraphrase.
// Renders nothing when there are no refs, so the general sentence still stands
// alone; the list is de-duplicated by detail and capped to keep the card compact.
const FOCUS_EVIDENCE_REF_CAP = 5;
const FOCUS_EVIDENCE_SOURCE_LABELS = {
  dashboard: "Dashboard",
  context: "Context",
  interaction: "Interaction",
  detector: "Detector",
};
function focusEvidenceRefsMarkup(critique) {
  const refs = Array.isArray(critique.evidenceRefs) ? critique.evidenceRefs : [];
  const seen = new Set();
  const items = [];
  for (const ref of refs) {
    const detail = typeof ref?.detail === "string" ? ref.detail.trim() : "";
    if (!detail || seen.has(detail)) continue;
    seen.add(detail);
    const tileLabel = ref.tileId ? tileById(ref.tileId)?.label : null;
    const location = tileLabel
      || FOCUS_EVIDENCE_SOURCE_LABELS[ref.source]
      || "Dashboard";
    const tags = [ref.field, ref.channel ? `${ref.channel} channel` : null].filter(Boolean);
    items.push({ location, tags, detail });
  }
  if (!items.length) return "";
  const shown = items.slice(0, FOCUS_EVIDENCE_REF_CAP);
  const overflow = items.length - shown.length;
  return `
    <ul class="focus-evidence-refs">
      ${shown.map((item) => `
        <li>
          <span class="focus-evidence-loc">${escapeHTML(item.location)}</span>
          ${item.tags.map((tag) => `<span class="focus-evidence-tag">${escapeHTML(tag)}</span>`).join("")}
          <span class="focus-evidence-detail">${escapeHTML(item.detail)}</span>
        </li>`).join("")}
      ${overflow > 0 ? `<li class="focus-evidence-more">+${overflow} more grounded reference${overflow === 1 ? "" : "s"}</li>` : ""}
    </ul>`;
}

function revisionCheckpointForCritique(critiqueId) {
  return [...state.versions]
    .reverse()
    .find((version) => version.appliedRecommendationIds?.includes(critiqueId)) || null;
}

function previewChangeSummary(critique) {
  if (critique.proposal?.kind === "manual") {
    return critique.tileId
      ? (tileById(critique.tileId)?.label || "Affected chart")
      : "Affected dashboard area";
  }
  return {
    "dashboard-title": "Dashboard title and purpose",
    "add-kpis": "Summary KPI row",
    "recompose-kpis": "KPI composition and dashboard hierarchy",
    "chart-subtitles": "Chart takeaway subtitles",
    "add-tooltip": "Tooltip details on hover",
    "add-cross-filter": "Cross-view filtering behavior",
    "wire-filter-control": "Dashboard filter connection",
    "v2-palette": "Chart color encoding",
    "preserve-brand-palette": "Chart color encoding",
    "edit-spec": critiqueTileCount(critique) > 1
      ? `Chart specification on ${critiqueTileCount(critique)} charts`
      : (critique.tileId ? (tileById(critique.tileId)?.label || "Chart specification") : "Chart specification"),
    "edit-layout": "Dashboard tile layout",
  }[critique.proposal?.kind] || critiqueTargetLabel(critique);
}

// Honest, per-kind guidance for the Original/Proposed switch. Cross-filter now
// renders a representative coordinated selection in "Proposed"; hover tooltips
// only appear on hover (so they point to the runtime test); guidance-only and
// tooltip proposals have no static difference and say so instead of implying one.
function canvasComparisonHint(descriptor) {
  if (descriptor.renderer !== "interaction") return "";
  if (descriptor.interactionKind === "hover-tooltip") {
    return `<small>Tooltips appear on hover — "Proposed" shows the affected chart; run the interaction test below to see the live tooltip.</small>`;
  }
  if (descriptor.scenario?.kind === "cross-filter" && descriptor.scenario.targetTiles?.length) {
    return `<small>"Proposed" previews the coordinated selection (${escapeHTML(String(descriptor.scenario.field))} = ${escapeHTML(String(descriptor.scenario.value))}); run the interaction test below to click through it live.</small>`;
  }
  return "";
}

async function focusPreviewDescriptor(critique) {
  const actionable = ["pending", "updated"].includes(critique.status);
  const checkpoint = revisionCheckpointForCritique(critique.id);
  const livePreview = actionable ? await enginePreviewFor(critique) : null;
  const previewFailure = livePreview?.rollback?.rolledBack
    ? (livePreview.rollback.reason || "This recommendation did not pass the apply quality checks.")
    : null;
  const executable = actionable && !previewFailure &&
    critique.proposal?.mode !== "guidance_only" &&
    critique.proposal?.kind !== "manual" &&
    state.artifact.hasExecutableSpecs;
  const beforeSnapshot = checkpoint?.beforeSnapshot || null;
  const afterSnapshot = checkpoint?.afterSnapshot || null;
  const preview = (!previewFailure && livePreview) || (afterSnapshot
    ? { specMap: afterSnapshot.specMap, board: afterSnapshot.board }
    : null);
  const beforeBoard = beforeSnapshot?.board || buildEngineBoardMeta();
  const afterBoard = preview?.board || beforeBoard;
  const tile = critique.tileId ? tileById(critique.tileId) : null;
  const kind = critique.proposal?.kind || "manual";
  // Interaction proposals must route to the interaction branch even when the
  // model omitted surface — otherwise a cross-filter falls through to a static
  // "encoding"/"region" descriptor and its Proposed preview is indistinguishable
  // from Original (the presenting stage reads as fake). Board-level proposals
  // route by their own kind below, so only infer surface for the interaction
  // and structural cases the surface field would otherwise miss.
  const interactionKinds = ["add-cross-filter", "show-filter-state", "add-tooltip", "wire-filter-control"];
  const structuralKinds = ["add-kpis", "recompose-kpis", "chart-subtitles"];
  // An edit-spec proposal's honest before/after IS the tile-spec diff, so route
  // it to the spec-diff ("encoding") renderer whatever branch it was grouped
  // under — otherwise a layout/color edit-spec would fall to a static
  // structural/region card and read as a fake no-op. Kind wins over the model's
  // surface hint for the operations whose renderer is determined by the op.
  const surface = (kind === "edit-spec" && tile) ? "encoding"
    : interactionKinds.includes(kind) ? "interaction"
    : structuralKinds.includes(kind) ? "structural"
    // A board-layout change is dashboard-level (no single tile); its honest
    // before/after is the tile arrangement itself, so route it to the layout
    // schematic renderer whatever branch it was grouped under. Kind wins over the
    // surface hint so a layout fix never falls to a static region no-op.
    : kind === "edit-layout" ? "layout"
    : kind === "dashboard-title" ? "text"
    : critique.surface
    || (tile ? "encoding" : "region");
  const common = {
    livePreview,
    previewFailure,
    checkpoint,
    executable,
    isApplied: Boolean(checkpoint),
    changeSummary: previewChangeSummary(critique),
  };

  if (surface === "encoding" && tile) {
    const before = beforeSnapshot?.specMap?.[tile.id] || tile.spec;
    const after = proposedSpecFor(critique, preview) || tile.spec;
    return {
      ...common,
      renderer: "encoding",
      tile,
      before,
      after,
      // Only claim a visible change when the engine actually produced a distinct
      // after-spec for this tile — a fabricated identical diff is exactly the
      // "fake proposed" the inspector must avoid.
      showComparison: Boolean(preview?.specMap?.[tile.id]) && !specsMatch(before, after),
    };
  }
  if (surface === "text") {
    // A dashboard-title edit has a concrete before/after: the current heading vs
    // the proposed one, so the comparison shows real content.
    if (kind === "dashboard-title") {
      const change = {
        before: { title: beforeBoard.title, subtitle: beforeBoard.subtitle },
        after: {
          title: afterBoard.title || critique.proposal?.label || critique.suggestion,
          subtitle: afterBoard.subtitle,
        },
      };
      const textChanged = change.after.title !== change.before.title
        || change.after.subtitle !== change.before.subtitle;
      return { ...common, renderer: "text", ...change, showComparison: textChanged };
    }
    // Any other text recommendation (e.g. "use one naming pattern across the
    // dashboard") spans multiple labels/footnotes with no single before/after
    // string to compare — a fabricated "Current dashboard text" / "Revised
    // dashboard text" panel is an empty template. The honest content is already
    // shown in "Recommended Change" above, so skip the comparison entirely.
    return { ...common, renderer: "text", showComparison: false };
  }
  if (surface === "structural") {
    const structural = {
      "add-kpis": {
        before: { kpis: Boolean(beforeBoard.hasKpis) },
        after: { kpis: Boolean(afterBoard.hasKpis), highlight: "kpi" },
      },
      "recompose-kpis": {
        before: {
          kpis: Boolean(beforeBoard.hasKpis),
          layout: beforeBoard.kpiLayout,
          style: beforeBoard.kpiStyle,
          alignment: beforeBoard.kpiAlignment,
          density: beforeBoard.kpiDensity,
          chrome: beforeBoard.kpiChrome,
        },
        after: {
          kpis: Boolean(afterBoard.hasKpis),
          layout: afterBoard.kpiLayout,
          style: afterBoard.kpiStyle,
          alignment: afterBoard.kpiAlignment,
          density: afterBoard.kpiDensity,
          chrome: afterBoard.kpiChrome,
          highlight: "kpi",
        },
      },
      "chart-subtitles": {
        before: {
          subtitles: Boolean(beforeBoard.tiles?.length) &&
            beforeBoard.tiles.every((item) => item.hasSubtitle),
        },
        after: {
          subtitles: Boolean(afterBoard.tiles?.length) &&
            afterBoard.tiles.every((item) => item.hasSubtitle),
          highlight: "labels",
        },
      },
    }[kind] || { before: {}, after: {} };
    const structuralChanged = structural.before.kpis !== structural.after?.kpis
      || structural.before.subtitles !== structural.after?.subtitles
      || structural.before.layout !== structural.after?.layout
      || structural.before.style !== structural.after?.style
      || structural.before.alignment !== structural.after?.alignment
      || structural.before.density !== structural.after?.density
      || structural.before.chrome !== structural.after?.chrome;
    return { ...common, renderer: "structural", ...structural, showComparison: structuralChanged };
  }
  if (surface === "layout") {
    // A board-layout change moves/resizes whole tiles. The honest before/after is
    // the arrangement itself: draw both as scaled schematics from the real tile
    // boxes (current board vs the engine's proposed board). Only claim a change
    // when the engine actually produced a distinct box for at least one tile.
    const beforeTiles = (beforeBoard.tiles || []).filter((t) => t && t.bounds);
    const afterTiles = (afterBoard.tiles || []).filter((t) => t && t.bounds);
    const beforeById = new Map(beforeTiles.map((t) => [t.id, t.bounds]));
    const layoutChanged = Boolean(preview?.board) && afterTiles.some((t) => {
      const was = beforeById.get(t.id);
      return was && (was.x !== t.bounds.x || was.y !== t.bounds.y || was.w !== t.bounds.w || was.h !== t.bounds.h);
    });
    return {
      ...common,
      renderer: "layout",
      before: {
        tiles: beforeTiles,
        canvasWidth: beforeBoard.canvasWidth || state.canvasSize.width,
        canvasHeight: beforeBoard.canvasHeight || state.canvasSize.height,
      },
      after: {
        tiles: afterTiles,
        canvasWidth: afterBoard.canvasWidth || state.canvasSize.width,
        canvasHeight: afterBoard.canvasHeight || state.canvasSize.height,
        highlight: "layout",
      },
      showComparison: layoutChanged,
    };
  }
  if (surface === "interaction") {
    // interactionKind is inferred from proposal.kind when the model omitted it,
    // so the tooltip vs cross-filter copy and the scenario stay consistent.
    const isFilterWiring = kind === "wire-filter-control";
    const interactionKind = critique.interactionKind
      || (kind === "add-tooltip" ? "hover-tooltip" : isFilterWiring ? "filter-control" : "cross-filter");
    const isHoverTooltip = interactionKind === "hover-tooltip";
    // Build the same executable scenario the canvas runtime uses so the focus
    // panel can show a real before/after chart instead of static copy. The
    // scenario resolves source/field/targets from the critique ref (or, for the
    // show-filter-state follow-up, from the applied cross-filter usermeta).
    const scenario = buildInteractionScenario(critique, buildEngineSpecMap());
    let previewTile = null;
    let beforeSpec = null;
    let afterSpec = null;
    if (scenario) {
      if (scenario.kind === "cross-filter") {
        const selection = { field: scenario.field, value: scenario.value };
        const targetId = scenario.targetTiles.find((id) => tileById(id)) || scenario.sourceTile;
        previewTile = tileById(targetId) || tileById(scenario.sourceTile) || null;
        if (previewTile) {
          beforeSpec = previewTile.spec;
          afterSpec = previewTile.id === scenario.sourceTile
            ? applySourceSelectionState(previewTile.spec, selection)
            : applyTargetFilterState(previewTile.spec, selection);
        }
      } else {
        previewTile = tileById(scenario.sourceTile) || null;
        if (previewTile) {
          beforeSpec = previewTile.spec;
          afterSpec = preview?.specMap?.[previewTile.id]
            || proposedSpecFor(critique, preview)
            || previewTile.spec;
        }
      }
    }
    const liveChart = Boolean(previewTile && beforeSpec && afterSpec && !specsMatch(beforeSpec, afterSpec));
    return {
      ...common,
      renderer: "interaction",
      interactionKind,
      scenario,
      tile: previewTile,
      liveChart,
      beforeSpec,
      afterSpec,
      before: {
        label: isHoverTooltip ? "No hover details" : isFilterWiring ? "Visible but inactive" : "Disconnected views",
        text: critique.issue,
      },
      after: {
        label: isHoverTooltip ? "Values on hover" : isFilterWiring ? "Connected to target views" : "Coordinated views",
        text: critique.suggestion,
      },
      // A live before/after chart is a genuine visible change; the descriptive
      // fallback card is not (it only restates issue/suggestion), so it stays out
      // of the comparison to avoid implying a difference the canvas can't show.
      showComparison: liveChart || isFilterWiring,
    };
  }
  return {
    ...common,
    renderer: "region",
    before: { box: critique.bounds },
    after: { box: critique.bounds, highlight: "region" },
    showComparison: false,
  };
}

// Structural equality is enough here: the specs are JSON produced by clone/embed,
// so a stable stringify catches "the after is identical to the before" — the tell
// of a fabricated proposal we refuse to present as a real change.
function specsMatch(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}


// The Original/Proposed toggle is a single persistent node reparented between two
// homes: a focused single critique hosts it inside its detail card (#focusCompareSlot),
// while batch multi-select preview and the idle state keep it in the canvas action
// strip. Moving a live node preserves its click listener, so no rebinding is needed.
// Before the focus view's innerHTML is wiped, the control is rescued back to the
// canvas home (see rescueCanvasPreviewControl) so the re-render never destroys it.
function canvasPreviewControlHome() {
  const singleFocus = Boolean(
    state.canvasPreview && !state.canvasPreview.batch && state.selectedCritiqueId);
  const focusSlot = document.getElementById("focusCompareSlot");
  if (singleFocus) return focusSlot; // null until the detail card is painted
  return document.querySelector(".canvas-action-strip");
}

function rescueCanvasPreviewControl() {
  const control = document.getElementById("canvasPreviewControl");
  const home = document.querySelector(".canvas-action-strip");
  if (control && home && control.parentElement !== home) home.appendChild(control);
}

function renderCanvasPreviewControl() {
  const control = document.getElementById("canvasPreviewControl");
  if (!control) return;
  const desiredHost = canvasPreviewControlHome();
  if (desiredHost && control.parentElement !== desiredHost) desiredHost.appendChild(control);
  // While a single critique is focused but its detail card (and slot) has not been
  // painted yet, keep the control hidden rather than flashing it on the canvas.
  const awaitingFocusSlot = Boolean(
    state.canvasPreview && !state.canvasPreview.batch && state.selectedCritiqueId)
    && !document.getElementById("focusCompareSlot");
  control.hidden = !state.canvasPreview || awaitingFocusSlot;
  control.style.setProperty("--preview-accent", state.canvasPreview?.accent || COLORS.visual);
  const phase = state.canvasPreview?.phase || "before";
  const toggle = document.getElementById("canvasPreviewToggle");
  if (toggle) {
    const showingProposed = phase === "after";
    const executable = Boolean(state.canvasPreview?.hasExecutableProposal);
    const afterLabel = executable ? "Proposed" : "Affected area";
    toggle.classList.toggle("showing-proposed", showingProposed);
    toggle.setAttribute("aria-checked", String(showingProposed));
    toggle.setAttribute(
      "aria-label",
      `Canvas preview: ${showingProposed ? afterLabel.toLowerCase() : "original"}`,
    );
    const after = toggle.querySelector('[data-canvas-label="after"]');
    if (after) after.textContent = afterLabel;
    toggle.querySelector('[data-canvas-label="before"]')?.classList.toggle("active", !showingProposed);
    after?.classList.toggle("active", showingProposed);
  }
}

function fallbackCanvasTarget(critique) {
  if (critique.tileId) return critique.tileId;
  if (critique.target?.ref?.source) return critique.target.ref.source;
  if (critique.criterionId === "narrative.dashboard-purpose") return "dashboard.title";
  if (critique.criterionId === "visual.summary-scannability") return "dashboard.kpis";
  return "dashboard";
}

function configureCanvasPreview(critique, descriptor) {
  const actionable = ["pending", "updated"].includes(critique.status);
  const usableLivePreview = descriptor.previewFailure ? null : descriptor.livePreview;
  const fallbackResult = actionable && !usableLivePreview
    ? {
        specMap: buildEngineSpecMap(),
        board: buildEngineBoardMeta(),
        changedTargets: [fallbackCanvasTarget(critique)],
      }
    : null;
  // A cross-filter proposal is invisible in a static "after" spec (it only adds
  // a selection param). Carry a representative coordinated selection so the
  // canvas can demonstrate the behavior when showing "Proposed".
  const interactionPreview = descriptor.renderer === "interaction"
    && descriptor.scenario?.kind === "cross-filter"
    && descriptor.scenario.targetTiles?.length
    ? {
        kind: "cross-filter",
        field: descriptor.scenario.field,
        value: descriptor.scenario.value,
        sourceTile: descriptor.scenario.sourceTile,
        targetTiles: descriptor.scenario.targetTiles,
      }
    : null;
  state.canvasPreview = actionable
    ? {
        critiqueId: critique.id,
        critiqueTitle: critique.title,
        phase: "after",
        result: usableLivePreview || fallbackResult,
        hasExecutableProposal: Boolean(usableLivePreview),
        interactionPreview,
        accent: critiqueGroupPresentation(critique.dimension).color,
      }
    : null;
  renderCanvasPreviewControl();
  renderDashboardChrome({ renderContext: false });
}

async function setCanvasPreviewPhase(phase) {
  if (!state.canvasPreview || !["before", "after"].includes(phase)) return;
  if (state.canvasPreview.phase === phase) return;
  state.canvasPreview.phase = phase;
  appendInteractionEvent({
    kind: "preview_viewed",
    summary: `Viewed ${phase === "after" ? "proposed" : "current"} dashboard for: ${state.canvasPreview.critiqueTitle}`,
    critiqueId: state.canvasPreview.critiqueId,
  });
  renderCanvasPreviewControl();
  renderDashboardChrome({ renderContext: false });
  await renderTiles();
  renderMarkers();
}

async function closeCritiqueFocus() {
  state.selectedCritiqueId = null;
  state.selectedTileId = null;
  state.critiqueRefreshNotice = null;
  state.canvasPreview = null;
  renderCanvasPreviewControl();
  renderDashboardChrome({ renderContext: false });

  // Return to the list before repainting the dashboard. Rendering Vega views is
  // asynchronous and can be slow (or fail for a malformed preview); it must not
  // block this navigation control from doing its primary job.
  renderCritiques();
  await renderInspector();
  renderMarkers();

  try {
    await renderTiles();
  } catch (error) {
    console.warn("[critique focus] dashboard refresh after closing failed", error);
  } finally {
    renderMarkers();
  }
}

async function renderInspector() {
  const critique = critiqueById(state.selectedCritiqueId);
  const listView = document.getElementById("critiqueListView");
  const focusView = document.getElementById("critiqueFocusView");
  const backButton = document.getElementById("focusBackButton");
  const panelTitle = document.getElementById("critiquePanelTitle");
  const panelTools = document.querySelector(".critiques-panel-fixed .critique-heading-actions");
  if (!listView || !focusView || !backButton || !panelTitle) return;

  // Rescue the persistent Original/Proposed control back to the canvas home before
  // any focusView.innerHTML wipe below — if it currently lives in the previous
  // render's #focusCompareSlot, the wipe would otherwise destroy it. It is
  // reparented into the fresh slot again at the end of this function.
  rescueCanvasPreviewControl();

  listView.hidden = Boolean(critique);
  focusView.hidden = !critique;
  backButton.hidden = !critique;
  if (panelTools) panelTools.hidden = Boolean(critique);
  panelTitle.textContent = critique ? "Focused Critique" : "Critiques";
  if (!critique) {
    // A batch (multi-select) preview is owned by batch mode, not the inspector —
    // leave it on the canvas while the author keeps building the selection.
    if (state.canvasPreview && !state.canvasPreview.batch) {
      state.canvasPreview = null;
      renderCanvasPreviewControl();
      renderDashboardChrome({ renderContext: false });
      await renderTiles();
      renderMarkers();
    }
    focusView.innerHTML = "";
    return;
  }
  if (state.canvasPreview && state.canvasPreview.critiqueId !== critique.id) {
    const wasShowingProposed = state.canvasPreview.phase === "after";
    state.canvasPreview = null;
    renderCanvasPreviewControl();
    renderDashboardChrome({ renderContext: false });
    if (wasShowingProposed) {
      await renderTiles();
      renderMarkers();
    }
  }

  const refreshRetired = state.critiqueRefreshNotice?.critiqueId === critique.id
    && state.critiqueRefreshNotice?.kind === "retired";
  const actionable = ["pending", "updated"].includes(critique.status);
  const relationships = relationshipSummary(critique, state.critiques);
  const fields = critiqueFieldEntries(critique);
  const problemField = fields.find((field) => field.key === "issue");
  const changeField = fields.find((field) => field.key === "suggestion");
  const supportingFields = fields.filter((field) =>
    !["issue", "suggestion"].includes(field.key));
  // "Why & Evidence" is split into explicit sub-sections so the rationale and the
  // evidence read as distinct rather than one blurred list. The general evidence
  // sentence is followed by the concrete, grounded evidenceRefs (see
  // focusEvidenceRefsMarkup). Any model "details" extensions trail after both.
  const rationaleField = fields.find((field) => field.key === "rationale");
  const evidenceField = fields.find((field) => field.key === "evidence");
  const extensionFields = supportingFields.filter(
    (field) => !["rationale", "evidence"].includes(field.key));
  const evidenceRefsMarkup = focusEvidenceRefsMarkup(critique);
  const hasEvidenceBlock = Boolean(evidenceField || evidenceRefsMarkup);
  const supportingCount = (rationaleField ? 1 : 0) + (hasEvidenceBlock ? 1 : 0) + extensionFields.length;
  const isRegionCritique = critique.reviewScope === "selected-region"
    || critique.origin === "local-review";
  const isFocusedQuestion = !isRegionCritique && critique.requestRelevance === "direct";
  const sourceLabel = isRegionCritique
    ? "Review Area"
    : isFocusedQuestion
      ? "Focused Question"
      : "Criteria-aware Review";

  // Show the critique itself before requesting an executable canvas preview.
  // Preview generation can involve the engine and must never leave navigation
  // in an empty intermediate state.
  focusView.innerHTML = `
    <article class="focus-card focus-card-loading" style="--accent:${critiqueGroupPresentation(critique.dimension).color}" aria-busy="true">
      <header class="focus-card-header">
        <div class="focus-chip-row">
          <span class="dimension-tag">${escapeHTML(critique.dimension)}</span>
          <span class="focus-source-chip">${sourceLabel}</span>
          ${critiqueFixBadgeMarkup(critique)}
          ${critique.supportStatus === "tentative" ? '<span class="focus-source-chip tentative">Tentative</span>' : ""}
          ${["critical", "high", "medium", "low"].includes(critique.priority) ? `<span class="prio-chip ${escapeHTML(critique.priority)}">${escapeHTML(critiquePriorityLabel(critique))}</span>` : ""}
        </div>
        <h2>${escapeHTML(critique.title)}</h2>
        ${critiqueHasScopeInfo(critique) ? `<p class="focus-target">${escapeHTML(critiqueTargetLabel(critique))}</p>` : ""}
      </header>
      <div class="focus-decision-summary">
        ${problemField ? `<section class="focus-problem"><h3 class="visually-hidden">What Needs Attention</h3><p>${escapeHTML(problemField.value)}</p></section>` : ""}
        ${changeField ? `<section class="focus-recommendation"><h3 class="visually-hidden">Recommended Change</h3><p>${escapeHTML(changeField.value)}</p></section>` : ""}
      </div>
      <div class="focus-preview-loading" role="status">
        <span class="focus-preview-spinner" aria-hidden="true"></span>
        <div><strong>Preparing canvas comparison</strong><p>The critique details are ready while VIZier prepares the proposed view.</p></div>
      </div>
    </article>`;
  const descriptor = await focusPreviewDescriptor(critique);
  // focusPreviewDescriptor can suspend on a real engine round-trip (uncached
  // executable preview). If the author navigated away (Back/Escape → selection
  // cleared) or switched critiques while it was in flight, this continuation is
  // stale: proceeding would re-set state.canvasPreview for an unselected critique
  // and strand the relocated Original/Proposed toggle visible on the canvas. Bail
  // out — the newer selection (or closeCritiqueFocus) already owns the render.
  if (state.selectedCritiqueId !== critique.id) return;
  const applicationPlan = buildApplicationPlan([critique.id], state.critiques);
  // The critiques were built for a specific confirmed context. If the author
  // edited and re-confirmed the context afterward, these results are stale and
  // must not be applied — regeneration comes first. Gating the Accept button on
  // freshness here is what keeps the stale-context alert dead-end unreachable.
  const resultsMatchContext = reviewResultsMatchContext();
  const recommendationMatchesDashboard = !Number.isFinite(Number(critique.lastEvaluatedVersion))
    || Number(critique.lastEvaluatedVersion) === state.version;
  const canApplyIndividually = descriptor.executable
    && applicationPlan.canApply
    && resultsMatchContext
    && recommendationMatchesDashboard;
  const canAcceptGuidance = actionable
    && (critique.proposal?.mode === "guidance_only" || critique.proposal?.kind === "manual");
  const canAcceptIndividually = canApplyIndividually || canAcceptGuidance;
  const canvasWasShowingProposal = Boolean(activeCanvasPreviewResult());
  configureCanvasPreview(critique, descriptor);
  const runtimeReport = state.interactionObservations.get(critique.id);
  const runtimeEvidence = runtimeReport
    ? critique.interactionKind === "hover-tooltip"
      ? [
          runtimeReport.before
            ? `Original: ${runtimeReport.before.tooltip ? "tooltip surfaced" : "no tooltip surfaced"}`
            : null,
          runtimeReport.after
            ? `Proposed: ${runtimeReport.after.tooltip ? "live tooltip surfaced" : "no tooltip surfaced"}`
            : null,
        ].filter(Boolean).join(" · ")
      : [
          runtimeReport.before
            ? `Original: ${runtimeReport.before.changedTargets.length} related views changed`
            : null,
          runtimeReport.after
            ? `Proposed: ${runtimeReport.after.changedTargets.length} related views changed`
            : null,
        ].filter(Boolean).join(" · ")
    : "";
  const critiqueRationales = state.rationales.filter((item) => item.critiqueId === critique.id);
  const rejected = critique.status === "rejected";
  const guidanceAccepted = critique.status === "accepted";

  focusView.innerHTML = `
    <article class="focus-card" style="--accent:${critiqueGroupPresentation(critique.dimension).color}">
      <header class="focus-card-header">
        <div class="focus-chip-row">
          <span class="dimension-tag">${escapeHTML(critique.dimension)}</span>
          <span class="focus-source-chip">${sourceLabel}</span>
          ${critiqueFixBadgeMarkup(critique)}
          ${critique.supportStatus === "tentative" ? '<span class="focus-source-chip tentative">Tentative</span>' : ""}
          ${["critical", "high", "medium", "low"].includes(critique.priority) ? `<span class="prio-chip ${escapeHTML(critique.priority)}">${escapeHTML(critiquePriorityLabel(critique))}</span>` : ""}
        </div>
        ${critique.requestRelevance === "direct" && critique.reviewRequest ? `
          <div class="focus-request-context">
            <span>${isFocusedQuestion ? "Your Question" : "Your Review Request"}</span>
            <p>${escapeHTML(critique.reviewRequest)}</p>
          </div>` : ""}
        ${isRegionCritique ? regionRecallMarkup(critique) : ""}
        <h2>${escapeHTML(critique.title)}</h2>
        ${critiqueHasScopeInfo(critique) ? `<p class="focus-target">${escapeHTML(critiqueTargetLabel(critique))}</p>` : ""}
      </header>
      <div class="focus-decision-summary">
        ${critique.answer ? `
          <section class="focus-direct-answer${isFocusedQuestion ? " focused-question" : ""}">
            <h3>${isFocusedQuestion ? "Direct Answer" : "Answer"}</h3>
            ${focusedAnswerMarkup(critique.answer)}
          </section>` : ""}
        ${problemField ? `
          <section class="focus-problem">
            <h3 class="visually-hidden">What Needs Attention</h3>
            <p>${escapeHTML(problemField.value)}</p>
          </section>` : ""}
        ${changeField ? `
          <section class="focus-recommendation">
            <h3 class="visually-hidden">Recommended Change</h3>
            <p>${escapeHTML(changeField.value)}</p>
          </section>` : ""}
      </div>
      ${supportingCount ? `
        <details class="focus-supporting-details">
          <summary>
            <span>Why &amp; Evidence</span>
            <span class="focus-supporting-meta">
              ${supportingCount} ${supportingCount === 1 ? "detail" : "details"}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>
            </span>
          </summary>
          <div class="focus-supporting-content">
            ${rationaleField ? `
              <section class="focus-supporting-item">
                <h4>${escapeHTML(rationaleField.label)}</h4>
                <p>${escapeHTML(rationaleField.value)}</p>
              </section>` : ""}
            ${hasEvidenceBlock ? `
              <section class="focus-supporting-item focus-evidence-item">
                <h4>${escapeHTML(evidenceField ? evidenceField.label : "Evidence")}</h4>
                ${evidenceField ? `<p>${escapeHTML(evidenceField.value)}</p>` : ""}
                ${evidenceRefsMarkup}
              </section>` : ""}
            ${extensionFields.map((field) => `
              <section class="focus-supporting-item">
                <h4>${escapeHTML(field.label)}</h4>
                <p>${escapeHTML(field.value)}</p>
              </section>`).join("")}
          </div>
        </details>` : ""}
      ${actionable ? `<section class="focus-canvas-evidence">
        <h3>Compare on the Canvas</h3>
        <div class="focus-compare-slot" id="focusCompareSlot"></div>
        ${critiqueTileCount(critique) > 1 ? `<small>The preview shows one representative chart; the same fix applies to all ${critiqueTileCount(critique)} charts on Accept.</small>` : ""}
        ${canvasComparisonHint(descriptor)}
        ${runtimeEvidence ? `<small class="runtime-evidence">Last runtime observation · ${escapeHTML(runtimeEvidence)}</small>` : ""}
        ${descriptor.previewFailure
          ? `<small class="runtime-evidence">Apply check · ${escapeHTML(descriptor.previewFailure)}</small>`
          : !descriptor.livePreview && resultsMatchContext && recommendationMatchesDashboard
            ? `<small>This recommendation has no executable transformation yet; the canvas identifies the affected scope.</small>`
            : ""}
      </section>` : descriptor.isApplied ? `
        <section class="focus-canvas-evidence saved">
          <h3>Saved Change</h3>
          <p>This change is available in ${escapeHTML(revisionDisplayLabel(descriptor.checkpoint))}.</p>
        </section>` : ""}
      ${actionable && descriptor.renderer === "interaction" && descriptor.executable && descriptor.scenario
        ? `<button class="focus-demo-button" id="focusDemoButton" type="button">Run interaction test on the canvas</button>`
        : ""}
      ${critiqueRationales.length ? `
        <section class="focus-rationale-summary">
          <div class="focus-rationale-heading">
            <h3>Your Rationale</h3>
            <button type="button" id="focusEditRationale">Edit</button>
          </div>
          ${critiqueRationales.map((item) => `<p>${escapeHTML(item.text)}</p>`).join("")}
          <small>Saved to Design Rationale and available to future critique generation.</small>
        </section>` : ""}
      ${rejected ? `
        <section class="focus-decision-notice" role="status">
          <span aria-hidden="true">×</span>
          <div><strong>Critique Rejected</strong><p>You can leave a reason to improve later feedback, or return to the list.</p></div>
        </section>` : ""}
      ${guidanceAccepted ? `
        <section class="focus-decision-notice" id="guidanceAcceptedNotice" role="status" tabindex="-1">
          <span aria-hidden="true">✓</span>
          <div><strong>Marked as considered</strong><p>This direction is saved as your decision. Nothing was applied to the dashboard — you carry it out yourself.</p></div>
        </section>` : critique.proposal?.mode === "guidance_only" ? `
        <section class="focus-decision-notice" role="status">
          <span aria-hidden="true">i</span>
          <div><strong>Guidance-only recommendation</strong><p>A direction you carry out yourself — the engine cannot apply it on the canvas. Mark it as considered to log your decision.</p></div>
        </section>` : ""}
      ${actionable && descriptor.executable && !resultsMatchContext ? `
        <section class="focus-decision-notice needs-regenerate" role="status">
          <span aria-hidden="true">↻</span>
          <div>
            <strong>Regenerate to apply this change</strong>
            <p>These critiques were built for the previous context. Regenerate them, then apply.</p>
            <button type="button" id="focusRegenerate" class="focus-notice-action">Regenerate Critiques</button>
          </div>
        </section>` : ""}
      ${actionable && descriptor.previewFailure ? `
        <section class="focus-decision-notice" role="alert">
          <span aria-hidden="true">!</span>
          <div><strong>Cannot safely apply this recommendation</strong><p>${escapeHTML(descriptor.previewFailure)}</p></div>
        </section>` : ""}
      ${actionable && descriptor.executable && resultsMatchContext && !recommendationMatchesDashboard ? `
        <section class="focus-decision-notice needs-regenerate" role="status">
          <span aria-hidden="true">↻</span>
          <div>
            <strong>Regenerate for the current dashboard</strong>
            <p>This recommendation overlaps a change you already applied, so its transformation may no longer be safe to reuse.</p>
            <button type="button" id="focusRegenerateOne" class="focus-notice-action">Regenerate this critique</button>
          </div>
        </section>` : ""}
      ${refreshRetired ? `
        <section class="focus-decision-notice needs-regenerate" role="status">
          <span aria-hidden="true">i</span>
          <div>
            <strong>This critique no longer applies</strong>
            <p>${escapeHTML(state.critiqueRefreshNotice.message || "This issue is no longer present on the current dashboard.")}</p>
            <button type="button" id="focusRefreshDone" class="focus-notice-action">Back to Critiques</button>
          </div>
        </section>` : ""}
      ${actionable && descriptor.executable && resultsMatchContext && recommendationMatchesDashboard && !canApplyIndividually ? `
        <section class="focus-decision-notice" role="status">
          <span aria-hidden="true">i</span>
          <div><strong>Cannot apply this change yet</strong><p>Resolve its recommendation conflicts, then try again.</p></div>
        </section>` : ""}
      ${relationships.dependencies.length || relationships.conflicts.length ? `
        <section class="focus-relationships">
          <h3>Relationships</h3>
          ${relationships.dependencies.length
            ? `<p><span class="rec-badge related">Related</span> Apply after ${escapeHTML(relationships.dependencies.map((item) => item.title).join(", "))}.</p>`
            : ""}
          ${relationships.conflicts.length
            ? `<p><span class="rec-badge conflict">Conflict</span> Supersedes ${escapeHTML(relationships.conflicts.map((item) => item.title).join(", "))}.</p>`
            : ""}
        </section>` : ""}
      ${renderRevisions(critique)}
      <footer class="focus-actions">
        <button class="focus-action ${canAcceptGuidance ? "consider" : "accept"}" id="focusAccept" type="button" ${canAcceptIndividually ? "" : "disabled"}>
          ${canAcceptGuidance
            ? `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4a3.8 3.8 0 0 0-2.3 6.8c.4.3.6.7.6 1.1v.4h3.4v-.4c0-.4.2-.8.6-1.1A3.8 3.8 0 0 0 8 2.4Z"/><path d="M6.6 12.4h2.8M7 13.7h2"/></svg>`
            : `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>`}
          <span>${canAcceptGuidance ? "Mark as Considered" : "Accept Change"}</span>
        </button>
        <button class="focus-action defer" id="focusDefer" type="button" ${actionable ? "" : "disabled"}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></svg>
          <span>Defer</span>
        </button>
        <button class="focus-action reject" id="focusReject" type="button" ${actionable ? "" : "disabled"}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>
          <span>Reject</span>
        </button>
        <button class="focus-action secondary" id="focusAddContext" type="button">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v7H7l-3 2v-2H3z"/><path d="M8 5.5v3M6.5 7h3"/></svg>
          <span>${rejected ? "Add Rejection Reason" : critiqueRationales.length ? "Update Rationale" : "Add Rationale"}</span>
        </button>
      </footer>
    </article>`;

  // The detail card owns the Original/Proposed toggle for a focused critique: the
  // final innerHTML above created its #focusCompareSlot, so reparent the
  // persistent control into it now (batch preview keeps the toggle on the canvas).
  renderCanvasPreviewControl();
  document.querySelector("[data-region-recall]")?.addEventListener("click", () => {
    const bounds = critique.bounds || critique.localReview?.bounds || critique.target?.ref?.selectedBounds;
    revealRegionOnCanvas(bounds);
    // Study telemetry: a deliberate click to re-locate the critique's evidence on
    // the canvas.
    recordStudyAction("evidence_region_revealed", `Jumped to the evidence region for: ${critique.title}`, {
      critiqueId: critique.id,
      dimension: critique.dimension,
    });
  });
  // Study telemetry: expanding/collapsing "Why & Evidence" is a reliable, discrete
  // proxy for "the participant chose to look at the rationale/evidence" — the act
  // of opening the panel, NOT whether they read it (that stays a think-aloud signal).
  document.querySelector(".focus-supporting-details")?.addEventListener("toggle", (event) => {
    const open = event.currentTarget.open;
    recordStudyAction(
      open ? "critique_details_expanded" : "critique_details_collapsed",
      `${open ? "Expanded" : "Collapsed"} Why & Evidence for: ${critique.title}`,
      { critiqueId: critique.id, dimension: critique.dimension },
    );
  });
  // Stale-context recovery still regenerates the full set (every card was built
  // for the previous brief). Overlap-after-apply regenerates only this card.
  document.getElementById("focusRegenerate")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const targetId = critique.id;
    const regenerated = await runAIAssist({
      focusedRequest: "",
      trigger: "stale-context-recovery",
      keepCritiqueId: targetId,
    });
    if (!regenerated) {
      button.disabled = false;
      return;
    }
    const refreshed = critiqueById(targetId);
    if (refreshed && ["pending", "updated"].includes(refreshed.status)) {
      state.selectedCritiqueId = targetId;
      await renderInspector();
      return;
    }
    state.critiqueRefreshNotice = {
      critiqueId: targetId,
      kind: "retired",
      message: "This issue no longer appears in the regenerated review.",
    };
    if (refreshed) {
      state.selectedCritiqueId = targetId;
      await renderInspector();
    } else {
      await closeCritiqueFocus();
    }
  });
  document.getElementById("focusRegenerateOne")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Regenerating…";
    const outcome = await regenerateOneCritique(critique);
    if (outcome === "error") {
      button.disabled = false;
      button.textContent = "Regenerate this critique";
    }
  });
  document.getElementById("focusRefreshDone")?.addEventListener("click", () => {
    closeCritiqueFocus();
  });
  document.getElementById("focusDemoButton")?.addEventListener("click", () => {
    // Study telemetry: ran the before/after interaction replay on the canvas.
    recordStudyAction("interaction_replayed", `Ran the interaction test for: ${critique.title}`, {
      critiqueId: critique.id,
      dimension: critique.dimension,
    });
    playInteractionRuntime(critique);
  });
  document.getElementById("focusAccept").addEventListener("click", async () => {
    if (canApplyIndividually) {
      const applied = await applyRecommendationSelection([critique.id], {}, { via: "single" });
      if (!applied.ok) {
        showFocusApplyFailure(applied.reason);
      }
      return;
    }
    if (!canAcceptGuidance) return;
    critique.status = "accepted";
    critique.lifecycle = "guidance-accepted";
    critique.lastEvaluatedVersion = state.version;
    appendInteractionEvent({
      kind: "recommendation_accepted",
      summary: `Marked guidance as considered: ${critique.title}`,
      detail: critique.suggestion,
      critiqueId: critique.id,
      dimension: critique.dimension,
      proposalKind: critique.proposal?.kind,
      data: {
        target: critique.tileId || "dashboard",
        guidanceOnly: true,
        decision: "considered",
        applyId: null,
        critiqueRevisionId: critique.revision || null,
        dashboardVersion: Number(state.version) || 1,
        reason: latestRationaleText(critique.id),
      },
    });
    state.canvasPreview = null;
    renderCanvasPreviewControl();
    renderCritiques();
    renderMarkers();
    await renderInspector();
    document.getElementById("guidanceAcceptedNotice")?.focus();
  });
  document.getElementById("focusDefer")?.addEventListener("click", async () => {
    if (!actionable) return;
    critique.status = "deferred";
    critique.lifecycle = "deferred";
    critique.lastEvaluatedVersion = state.version;
    appendInteractionEvent({
      kind: "recommendation_deferred",
      summary: `Deferred recommendation: ${critique.title}`,
      detail: critique.suggestion,
      critiqueId: critique.id,
      dimension: critique.dimension,
      proposalKind: critique.proposal?.kind,
      data: {
        target: critique.tileId || "dashboard",
        decision: "defer",
        critiqueRevisionId: critique.revision || null,
        dashboardVersion: Number(state.version) || 1,
        reason: latestRationaleText(critique.id),
      },
    });
    renderCritiques();
    renderMarkers();
    await renderInspector();
  });
  document.getElementById("focusReject").addEventListener("click", async () => {
    critique.status = "rejected";
    critique.lifecycle = "rejected";
    critique.lastEvaluatedVersion = state.version;
    appendInteractionEvent({
      kind: "recommendation_rejected",
      summary: `Rejected recommendation: ${critique.title}`,
      detail: critique.suggestion,
      critiqueId: critique.id,
      dimension: critique.dimension,
      proposalKind: critique.proposal?.kind,
      data: {
        target: critique.tileId || "dashboard",
        decision: "reject",
        critiqueRevisionId: critique.revision || null,
        dashboardVersion: Number(state.version) || 1,
        reason: latestRationaleText(critique.id),
      },
    });
    // Refresh the list and Category Mix underneath (like accept does) so the
    // rejected critique leaves the active view and the bar rebalances at once.
    renderCritiques();
    renderMarkers();
    await renderInspector();
  });
  document.getElementById("focusAddContext").addEventListener("click", (event) =>
    openRationaleModal(critique, critiqueRationales.at(-1) || null, event.currentTarget));
  document.getElementById("focusEditRationale")?.addEventListener("click", (event) =>
    openRationaleModal(critique, critiqueRationales.at(-1), event.currentTarget));
  if (state.canvasPreview?.phase === "after" || canvasWasShowingProposal) {
    await renderTiles();
    renderMarkers();
  }
}

// Build the spec map sent to the engine. For tiles that include shared field data
// (like department or group), the specs already contain the full dataset in their
// data.values. For legacy hardcoded tiles, we inject the dept-keyed data.
function buildEngineSpecMap() {
  const specMap = {};
  state.tiles.forEach((tile) => {
    specMap[tile.id] = clone(tile.spec);
  });
  return specMap;
}

// Read the rendered board title/subtitle font sizes (in px) off the live DOM so
// the engine can ground size and hierarchy judgments. These sizes are set in CSS
// (not stored in state), so getComputedStyle is the truthful source. Returns
// rounded px plus their ratio; any missing element is simply omitted.
function readHeadingTypography() {
  const px = (el) => {
    if (!el) return undefined;
    const size = parseFloat(getComputedStyle(el).fontSize);
    return Number.isFinite(size) ? Math.round(size * 10) / 10 : undefined;
  };
  const family = (el) => {
    if (!el) return undefined;
    const value = getComputedStyle(el).fontFamily?.trim();
    return value || undefined;
  };
  const titlePx = px(els.dashboardTitle);
  const subtitlePx = px(els.dashboardSubtitle);
  const kpiValue = els.kpiRow?.querySelector(".kpi strong");
  const typography = {};
  if (titlePx !== undefined) typography.titleFontPx = titlePx;
  if (subtitlePx !== undefined) typography.subtitleFontPx = subtitlePx;
  if (family(els.dashboardTitle)) typography.titleFontFamily = family(els.dashboardTitle);
  if (family(els.dashboardSubtitle)) typography.subtitleFontFamily = family(els.dashboardSubtitle);
  if (family(kpiValue)) typography.kpiValueFontFamily = family(kpiValue);
  if (px(kpiValue) !== undefined) typography.kpiValueFontPx = px(kpiValue);
  if (titlePx && subtitlePx) {
    typography.titleToSubtitleRatio = Math.round((titlePx / subtitlePx) * 100) / 100;
  }
  return typography;
}

// Dashboard chrome the detectors need but that a Vega-Lite unit spec can't carry
// (heading text, KPI-row presence, per-tile subtitle presence). Grounds the
// visual/narrative detectors the same way buildEngineSpecMap grounds interaction.
function buildEngineBoardMeta() {
  return {
    id: state.artifact?.id || "dashboard",
    title: state.dashboardTitle,
    subtitle: state.dashboardSubtitle || "",
    // Rendered heading typography (px) read straight off the live DOM. The board
    // title/subtitle sizes live in CSS, not in any spec or state, so without this
    // the engine only ever sees the subtitle TEXT and cannot answer size/hierarchy
    // questions ("is the subtitle too small?") — it correctly refuses for lack of
    // evidence. Carrying the actual rendered sizes makes those questions groundable.
    typography: readHeadingTypography(),
    hasKpis: Boolean(state.showKpis),
    hasEmbeddedKpis: Boolean(state.hasEmbeddedKpis),
    // Carry the current KPI band and immutable canvas size so the engine can
    // recompute KPIs and keep add-kpis idempotent inside the original frame.
    kpis: Array.isArray(state.boardKpis) ? state.boardKpis : [],
    kpiStyle: state.boardKpiStyle || undefined,
    kpiLayout: state.boardKpiPresentation.layout,
    kpiAlignment: state.boardKpiPresentation.alignment,
    kpiDensity: state.boardKpiPresentation.density,
    kpiChrome: state.boardKpiPresentation.chrome,
    kpiReservedHeight: state.boardKpiPresentation.reservedHeight,
    kpiReservedWidth: state.boardKpiPresentation.reservedWidth,
    filters: Array.isArray(state.dashboardFilters) ? state.dashboardFilters : [],
    showChartSubtitles: Boolean(state.showChartSubtitles),
    canvasWidth: state.canvasSize.width,
    canvasHeight: state.canvasSize.height,
    tiles: state.tiles.map((tile) => ({
      id: tile.id,
      title: tile.v2Label || tile.label,
      subtitle: tile.subtitle || "",
      hasSubtitle: Boolean(state.showChartSubtitles),
      bounds: renderedTileBounds(tile, state.showKpis),
    })),
  };
}

function buildDashboardCaptureSnapshot() {
  const preview = activeCanvasPreviewResult();
  const board = canvasBoardState();
  const previewTiles = new Map((board.tiles || []).map((tile) => [tile.id, tile]));
  const tiles = state.tiles.map((tile) => {
    const previewTile = previewTiles.get(tile.id);
    const hasSubtitle = preview
      ? Boolean(previewTile?.hasSubtitle)
      : Boolean(board.showChartSubtitles);
    return {
      id: tile.id,
      title: preview
        ? (previewTile?.title || tile.v2Label || tile.label)
        : (hasSubtitle ? tile.v2Label : tile.label),
      subtitle: tile.subtitle || "",
      hasSubtitle,
      bounds: clone(previewTile?.bounds || renderedTileBounds(tile)),
    };
  });
  const boardMeta = {
    ...buildEngineBoardMeta(),
    ...(preview?.board ? clone(preview.board) : {}),
    id: state.artifact?.id || "dashboard",
    title: board.title,
    subtitle: board.subtitle || "",
    typography: readHeadingTypography(),
    hasKpis: Boolean(board.showKpis),
    kpis: clone(board.kpis || []),
    kpiStyle: board.kpiStyle || undefined,
    kpiLayout: board.kpiLayout,
    kpiAlignment: board.kpiAlignment,
    kpiDensity: board.kpiDensity,
    kpiChrome: board.kpiChrome,
    kpiReservedHeight: board.kpiReservedHeight,
    kpiReservedWidth: board.kpiReservedWidth,
    filters: clone(board.filters || []),
    showChartSubtitles: Boolean(board.showChartSubtitles),
    canvasWidth: board.canvasWidth,
    canvasHeight: board.canvasHeight,
    interactionState: {
      crossFilterEnabled: Boolean(state.crossFilterEnabled),
      activeFilterState: Boolean(state.activeFilterState),
      crossFilterSelection: clone(state.crossFilterSelection),
    },
    tiles,
  };
  return {
    specMap: clone(preview?.specMap || buildEngineSpecMap()),
    board: boardMeta,
  };
}

// Grounded positive observations are wholesale-replaced per review — they never
// accumulate across asks the way critiques do (proposals §7). Each is stamped
// with the review's scope and the draft version it was evaluated against, so
// filteredStrengths can suppress stale praise once an apply bumps the version.
// `...strength` carries `dimension` (grouping) plus the title/detail copy straight
// through, so the positive card has everything it needs to slot into its topic group.
function readReviewStrengths(resp, reviewScope) {
  return (resp?.strengths || []).map((strength) => ({
    ...strength,
    reviewScope: strength.reviewScope || reviewScope,
    reviewVersion: state.version,
  }));
}

async function regenerateOneCritique(critique) {
  if (!critique) return "error";
  const targetId = critique.id;
  const index = state.critiques.findIndex((item) => item.id === targetId);
  if (index < 0) return "error";
  const requestId = newStudyId();
  const requestStartedAt = Date.now();
  recordStudyAction(
    "critique_requested",
    `Regenerated one critique: ${critique.title}`,
    critiqueRequestStudyData({
      requestId,
      requestMode: "stale_recovery",
      scope: "critique",
      queryText: null,
      trigger: "stale-dashboard-recovery",
      critiqueId: targetId,
    }),
  );
  try {
    const { critiques: incoming, answer } = await generateCritiquesFromEngine(
      critiqueRefreshRequest(critique),
      {
        persistReviewMeta: false,
        traceTitle: "Refreshing this critique for the current dashboard",
      },
    );
    const replacement = pickCritiqueRefreshReplacement(critique, incoming, answer);
    if (replacement) {
      const refreshed = {
        ...replacement,
        id: targetId,
        status: "pending",
        askId: critique.askId,
        askScope: critique.askScope || "full",
        requestRelevance: critique.requestRelevance,
        reviewRequest: critique.reviewRequest,
        origin: critique.origin,
        localReview: critique.localReview,
        introducedInVersion: critique.introducedInVersion || state.version,
        lastEvaluatedVersion: state.version,
        revision: (Number(critique.revision) || 1) + 1,
      };
      const next = [...state.critiques];
      next[index] = refreshed;
      state.critiques = scopeRank(enrichRecommendations(next, state.version));
      state.previewCache.delete(targetId);
      state.interactionObservations.delete(targetId);
      state.critiqueRefreshNotice = null;
      state.selectedCritiqueId = targetId;
      recordStudyAction(
        "critique_regenerated",
        `Updated solution for: ${critique.title}`,
        {
          requestId,
          critiqueId: targetId,
          outcome: "updated",
          dimension: critique.dimension,
          latencyMs: Date.now() - requestStartedAt,
        },
      );
      recordCritiquesDisplayed("focused", critique.askId || null, {
        requestId,
        requestMode: "stale_recovery",
        latencyMs: Date.now() - requestStartedAt,
      });
      renderMarkers();
      renderCritiques();
      await renderInspector();
      return "updated";
    }
    const retired = {
      ...state.critiques[index],
      status: "superseded",
      lifecycle: "superseded",
      lastEvaluatedVersion: state.version,
    };
    const next = [...state.critiques];
    next[index] = retired;
    state.critiques = next;
    state.previewCache.delete(targetId);
    state.interactionObservations.delete(targetId);
    state.canvasPreview = null;
    state.selectedCritiqueId = targetId;
    state.critiqueRefreshNotice = {
      critiqueId: targetId,
      kind: "retired",
      message: answer || "This issue is no longer present on the current dashboard.",
    };
    recordStudyAction(
      "critique_regenerated",
      `Critique no longer applies: ${critique.title}`,
      {
        requestId,
        critiqueId: targetId,
        outcome: "retired",
        dimension: critique.dimension,
        latencyMs: Date.now() - requestStartedAt,
      },
    );
    renderCanvasPreviewControl();
    renderMarkers();
    renderCritiques();
    await renderInspector();
    return "retired";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracePanel.fail(`Could not refresh this critique — ${message}`);
    showFocusApplyFailure(message);
    recordStudyAction("critique_request_failed", "Stale-critique recovery failed", {
      requestId,
      requestMode: "stale_recovery",
      scope: "critique",
      critiqueId: targetId,
      latencyMs: Date.now() - requestStartedAt,
      reason: message,
    });
    return "error";
  }
}

// Every request uses the same criteria-aware engine. Context changes criterion
// applicability and wording; it never selects a different generation route.
async function generateCritiquesFromEngine(focusedRequest = "", options = {}) {
  const specMap = buildEngineSpecMap();
  const board = buildEngineBoardMeta();
  const normalizedRequest = focusedRequest.replace(/\s+/g, " ").trim();
  const reviewScope = normalizedRequest ? "focused" : "full";
  tracePanel.start(options.traceTitle
    || (normalizedRequest
      ? "Focused Review — answering your request"
      : "AI Assist — criteria-aware full review"));
  const resp = await streamCritique(
    {
      version: state.version,
      context: reviewContextForEngine(),
      specMap,
      board,
      iterationContext: iterationContextForEngine(),
      reviewScope,
      requireLLM: true,
      reviewTemperature: state.reviewTemperature,
      savedRationales: savedRationalesForEngine(),
      ...designDocumentForEngine(),
      ...(normalizedRequest
        ? { focus: { request: normalizedRequest } }
        : {}),
    },
    (event) => tracePanel.event(event),
  );
  tracePanel.done();
  if (!resp) throw new Error("The review engine returned no result.");
  if (options.persistReviewMeta !== false) {
    state.reviewScope = resp.reviewScope || reviewScope;
    state.criterionEvaluations = resp.criterionEvaluations || [];
    state.strengths = readReviewStrengths(resp, state.reviewScope);
  }
  // Store each critique's box in RENDERED canvas-space (same transform the tiles
  // use) so any consumer reading critique.bounds stays aligned; the dashboard
  // fallback is the live artboard, not a hardcoded demo rectangle.
  const boundsById = Object.fromEntries(
    state.tiles.map((t) => [t.id, renderedTileBounds(t)]),
  );
  const fullBoard = fullArtboardBounds();
  const critiques = (resp?.critiques || []).map((c) => ({
    ...c,
    bounds:
      c.bounds ||
      boundsById[c.tileId] ||
      boundsById[c.target?.ref?.source] ||
      boundsById[c.target?.ref?.tile] ||
      fullBoard,
  }));
  return { critiques, answer: resp.answer || null, reviewScope: state.reviewScope, reviewMeta: {
    model: resp?.model || critiques[0]?.model || null,
    promptVersion: resp?.promptVersion || critiques[0]?.promptVersion || null,
    systemVersion: resp?.engineVersion || critiques[0]?.engineVersion || null,
    registryVersion: resp?.registryVersion || critiques[0]?.registryVersion || null,
    fewShotSetId: resp?.fewShotSetId || null,
    fewShotVersion: resp?.fewShotVersion || null,
    fewShotIds: Array.isArray(resp?.fewShotIds) ? [...resp.fewShotIds] : [],
    fewShotContentHash: resp?.fewShotContentHash || null,
    runId: resp?.runId || null,
  } };
}

async function generateLocalCritiques({ bounds, request, dimension }) {
  if (!contextReadyForReview()) {
    throw new Error("Confirm the context before starting a local review.");
  }
  tracePanel.start("Local review — selected area");
  const resp = await streamCritique(
    {
      version: state.version,
      context: reviewContextForEngine(),
      specMap: buildEngineSpecMap(),
      board: buildEngineBoardMeta(),
      iterationContext: iterationContextForEngine(),
      reviewScope: "selected-region",
      requireLLM: true,
      reviewTemperature: state.reviewTemperature,
      savedRationales: savedRationalesForEngine(),
      ...designDocumentForEngine(),
      region: {
        bounds,
        request,
        ...(dimension ? { dimension } : {}),
      },
    },
    (event) => tracePanel.event(event),
  );
  tracePanel.done();
  const answer = resp?.answer || null;
  // A region ask can legitimately return just an answer (e.g. "no material
  // issue in this area") with no grounded critique. Only fail when there is
  // neither a critique nor an answer to show.
  if (!resp?.critiques?.length && !answer) {
    throw new Error("The review engine returned no grounded critiques for this area.");
  }
  const critiques = (resp?.critiques || []).map((critique) => ({
    ...critique,
    id: `local-${state.nextLocalReviewId++}-${critique.id}`,
    bounds: clone(bounds),
    origin: "local-review",
    localReview: { request, dimension: dimension || null, bounds: clone(bounds) },
    target: {
      ...(critique.target || {}),
      granularity: "selected-region",
      ref: {
        ...(critique.target?.ref || {}),
        selectedBounds: clone(bounds),
      },
    },
    reviewScope: resp.reviewScope || "selected-region",
  }));
  state.strengths = readReviewStrengths(resp, resp?.reviewScope || "selected-region");
  return {
    critiques,
    answer,
    reviewMeta: {
      model: resp?.model || critiques[0]?.model || null,
      promptVersion: resp?.promptVersion || critiques[0]?.promptVersion || null,
      systemVersion: resp?.engineVersion || critiques[0]?.engineVersion || null,
      registryVersion: resp?.registryVersion || critiques[0]?.registryVersion || null,
      fewShotSetId: resp?.fewShotSetId || null,
      fewShotVersion: resp?.fewShotVersion || null,
      fewShotIds: Array.isArray(resp?.fewShotIds) ? [...resp.fewShotIds] : [],
      fewShotContentHash: resp?.fewShotContentHash || null,
      runId: resp?.runId || null,
    },
  };
}

function recordCritiquesDisplayed(scope, askId, extra = {}) {
  const critiqueIds = state.critiques.map((critique) => critique.id);
  recordStudyAction(
    "critiques_displayed",
    `Displayed ${state.critiques.length} critique${state.critiques.length === 1 ? "" : "s"} after a ${scope} review`,
    {
      scope,
      askId,
      count: state.critiques.length,
      critiqueCount: state.critiques.length,
      critiqueIds,
      dashboardVersion: Number(state.version) || 1,
      promptVersion: extra.promptVersion || null,
      systemVersion: extra.systemVersion || STUDY_APP_VERSION,
      fewShotSetId: extra.fewShotSetId || null,
      fewShotVersion: extra.fewShotVersion || null,
      fewShotIds: Array.isArray(extra.fewShotIds) ? [...extra.fewShotIds] : [],
      fewShotContentHash: extra.fewShotContentHash || null,
      reviewTemperature: Number(state.reviewTemperature),
      model: extra.model || null,
      latencyMs: extra.latencyMs ?? null,
      requestId: extra.requestId || null,
      requestMode: extra.requestMode || null,
      critiques: state.critiques.map((critique) => ({
        id: critique.id,
        title: critique.title,
        dimension: critique.dimension,
        priority: critique.priority,
        status: critique.status,
        revision: critique.revision || null,
      })),
    },
  );
}

async function runAIAssist(options = {}) {
  if (!contextReadyForReview()) {
    updateContextWorkflowControls();
    document.getElementById("saveContextBtn")?.focus();
    return false;
  }
  if (state.reviewInFlight) return false;
  const focusedRequest = typeof options.focusedRequest === "string"
    ? options.focusedRequest.replace(/\s+/g, " ").trim()
    : state.reviewRequest.replace(/\s+/g, " ").trim();
  const attemptedScope = focusedRequest ? "focused" : "full";
  const actionTitle = els.aiAssistButton.querySelector(".ai-action-title");
  const actionDetail = els.aiAssistButton.querySelector(".ai-action-detail");
  state.reviewInFlight = true;
  els.aiAssistButton.disabled = true;
  els.aiAssistButton.classList.add("ai-running");
  actionTitle.textContent = "Generating Critiques…";
  if (actionDetail) actionDetail.textContent = "Building recommendations";
  els.aiAssistButton.setAttribute("aria-label", "Analyzing dashboard");
  syncReviewReadiness();

  let askId = null;
  const requestId = newStudyId();
  const requestStartedAt = Date.now();
  const hadPrior = state.critiques.length > 0;
  const requestMode = critiqueRequestMode({
    focusedRequest,
    trigger: options.trigger,
    hadPrior,
  });
  try {
    askId = state.nextAskId++;
    recordStudyAction(
      "critique_requested",
      focusedRequest ? `Requested a focused review: ${focusedRequest}` : "Requested a full review",
      critiqueRequestStudyData({
        requestId,
        requestMode,
        scope: protocolRequestScope(requestMode),
        askId,
        queryText: focusedRequest || null,
        trigger: options.trigger || (focusedRequest ? "focused-question" : "full-review"),
        critiqueId: options.keepCritiqueId || null,
      }),
    );
    const { critiques: baseCritiques, answer, reviewMeta } = await generateCritiquesFromEngine(focusedRequest);
    // Synchronize the active list with the dashboard the engine just reviewed:
    // refresh still-valid cards, add new findings, remove obsolete/duplicate
    // undecided cards, and preserve only explicit decisions as durable history.
    const merged = mergeAskResults(state.critiques, baseCritiques, {
      askId,
      reviewScope: state.reviewScope,
      dashboardVersion: state.version,
      synchronizeActive: state.reviewScope === "full",
    });
    // Re-rank by the author's feedback scope so requested dimensions surface first.
    state.critiques = scopeRank(enrichRecommendations(merged, state.version));
    // Stable card ids survive synchronization, but their proposals may not.
    // Invalidate id-keyed artifacts so Preview and runtime evidence can never
    // describe the previous payload while Apply executes the refreshed one.
    state.previewCache.clear();
    state.interactionObservations.clear();
    state.lastReviewContextFingerprint = contextFingerprint(state.context);
    const directAnswer = focusedRequest
      ? state.critiques.find((critique) =>
        critique.requestRelevance === "direct" && critique.askId === askId)
      : null;
    // A focused ask always gets a visible answer panel. Prefer the engine's
    // response-level answer (present even when no card survived), then the
    // direct-answer critique's own answer text.
    if (focusedRequest) {
      const answerText = answer || directAnswer?.answer || null;
      state.askAnswer = answerText
        ? {
            text: answerText,
            request: focusedRequest,
            reviewScope: "focused",
            critiqueId: directAnswer?.id || null,
            noCritiques: baseCritiques.length === 0,
          }
        : null;
    } else {
      state.askAnswer = null;
    }
    const keepId = typeof options.keepCritiqueId === "string" ? options.keepCritiqueId : null;
    const kept = keepId ? critiqueById(keepId) : null;
    const opened = (kept && ["pending", "updated"].includes(kept.status) ? kept : null)
      || directAnswer
      || (focusedRequest
        ? state.critiques.find((critique) => critique.askId === askId && !isDecidedCritique(critique))
        : null)
      || null;
    state.selectedCritiqueId = opened?.id || null;
    state.selectedTileId = opened?.tileId || null;
    if (opened?.id) markCritiqueInspected(opened.id);
    renderRubrics();
    await renderTiles();
    renderMarkers();
    renderCritiques();
    await renderInspector();
    // A regenerate rebuilt state.critiques: the batch combined preview on the
    // canvas was computed from the old selection/critiques and no longer matches
    // the (now pruned) selection. Recompute it — or clear it if the selection is
    // empty — so the canvas never shows a stale merged result.
    if (state.batchMode) await refreshBatchPreview();
    // Study telemetry: the set the participant was shown after this review. Paired
    // with critique_opened, this yields the reliable "displayed vs inspected" split
    // (which available critiques were never opened) without any gaze/scroll signal.
    recordCritiquesDisplayed(attemptedScope, askId, {
      requestId,
      requestMode,
      latencyMs: Date.now() - requestStartedAt,
      model: reviewMeta?.model || null,
      promptVersion: reviewMeta?.promptVersion || null,
      systemVersion: reviewMeta?.systemVersion || null,
      fewShotSetId: reviewMeta?.fewShotSetId || null,
      fewShotVersion: reviewMeta?.fewShotVersion || null,
      fewShotIds: reviewMeta?.fewShotIds || [],
      fewShotContentHash: reviewMeta?.fewShotContentHash || null,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const modeLabel = attemptedScope === "focused" ? "Focused review" : "Full review";
    tracePanel.fail(`${modeLabel} failed — ${message}`);
    recordStudyAction("critique_request_failed", `${modeLabel} failed`, {
      scope: protocolRequestScope(requestMode),
      askId,
      requestId,
      requestMode,
      requestText: focusedRequest || null,
      queryText: focusedRequest || null,
      dashboardVersion: Number(state.version) || 1,
      latencyMs: Date.now() - requestStartedAt,
      reason: message,
    });
    // A failed ask must not discard critiques accumulated by earlier asks. The
    // merge never ran (the engine threw before assignment), so state.critiques
    // is still intact — keep it and re-render. The review-run-scoped evaluations
    // and strengths, however, belong to the run that just failed, so clear them.
    state.criterionEvaluations = [];
    state.strengths = [];
    // Give the failed ask a visible, in-panel response instead of only a red dot
    // in the trace panel. For a focused ask this reads as a plain answer ("could
    // not answer that"); for a full ask it surfaces below.
    if (focusedRequest) {
      state.askAnswer = {
        text: `VIZier could not answer that this time — ${message}`,
        request: focusedRequest,
        reviewScope: "focused",
        critiqueId: null,
        noCritiques: state.critiques.length === 0,
        isError: true,
      };
    }
    renderRubrics();
    renderMarkers();
    await renderInspector();
    if (state.critiques.length) {
      renderCritiques();
    } else {
      renderCritiques();
      // Only overwrite the empty list message when there is no answer panel to
      // carry the failure (a full review has no answer panel).
      if (!focusedRequest) {
        els.critiqueList.replaceChildren();
        const error = document.createElement("div");
        error.className = "empty-state";
        error.setAttribute("role", "alert");
        error.textContent = `${modeLabel} failed: ${message}`;
        els.critiqueList.append(error);
      }
    }
    return false;
  } finally {
    state.reviewInFlight = false;
    els.aiAssistButton.classList.remove("ai-running");
    const hasCritiques = state.critiques.length > 0;
    actionTitle.textContent = hasCritiques ? "Regenerate Critiques" : "Generate Critiques";
    if (actionDetail) {
      actionDetail.textContent = focusedRequest && hasCritiques
        ? "Refresh the answer to your review request"
        : hasCritiques
        ? "Refresh recommendations for the Working Draft"
        : "Generate prioritized recommendations";
    }
    syncReviewReadiness();
  }
}

async function resetDemo() {
  if (state.workingDraft.dirty && !window.confirm(
    "Reset this dashboard? Unsaved Working Draft changes will be discarded.",
  )) return;
  state.demoPlaying = false;
  demoCursorEl = null;
  document.querySelector(".app-shell")?.classList.remove("demo-playing");
  document.getElementById("demoToolbar")?.remove();
  document.getElementById("demoBanner")?.remove();
  document.getElementById("demoCursor")?.remove();
  const initial = state.artifact.initial;
  if (!initial) return;
  const beforeVersion = Number(state.version) || 1;
  recordStudyAction("dashboard_state_restored", "Reset dashboard to the original checkpoint", {
    source: "reset_demo",
    beforeVersion,
    afterVersion: 1,
    relatedCritiqueIds: [],
  });
  state.tiles = initial.tiles.map((tile) => ({ ...clone(tile), renderer: "vega-lite", v2Label: tile.label || tile.id }));
  state.critiques = [];
  state.critiqueRefreshNotice = null;
  state.nextAskId = 1;
  state.askAnswer = null;
  state.selectedCritiqueId = null;
  state.selectedTileId = null;
  state.version = 1;
  state.dashboardTitle = initial.dashboard.title || "Dashboard";
  state.dashboardSubtitle = initial.dashboard.subtitle || "";
  state.showKpis = Boolean(initial.dashboard.hasKpis);
  state.hasEmbeddedKpis = Boolean(initial.dashboard.hasEmbeddedKpis);
  state.boardKpis = Array.isArray(initial.dashboard.kpis) ? initial.dashboard.kpis : [];
  state.boardKpiStyle = initial.dashboard.kpiStyle || null;
  state.boardKpiPresentation = {
    layout: initial.dashboard.kpiLayout || "inline-summary",
    alignment: initial.dashboard.kpiAlignment || "start",
    density: initial.dashboard.kpiDensity || "balanced",
    chrome: initial.dashboard.kpiChrome || "plain",
    reservedHeight: Number(initial.dashboard.kpiReservedHeight) || 0,
    reservedWidth: Number(initial.dashboard.kpiReservedWidth) || 0,
  };
  state.dashboardFilters = Array.isArray(initial.dashboard.filters) ? clone(initial.dashboard.filters) : [];
  state.showChartSubtitles = Boolean(initial.dashboard.showChartSubtitles);
  state.canvasSize = {
    width: Number(initial.dashboard.canvasWidth) || 1100,
    height: Number(initial.dashboard.canvasHeight) || 720,
  };
  const baselineSnapshot = {
    specMap: buildEngineSpecMap(),
    board: buildEngineBoardMeta(),
  };
  state.versions = [{
    id: 1,
    kind: "initial",
    label: "Checkpoint 1 · Original Dashboard",
    note: "Starting Point",
    afterSnapshot: clone(baselineSnapshot),
  }];
  state.checkpointComparison = { before: 1, after: 1 };
  state.workingDraft = createWorkingDraft(1);
  state.rationales = [];
  state.nextRationaleId = 1;
  state.rationaleEditId = null;
  resetInteractionMemory();
  state.previewCache.clear();
  state.canvasPreview = null;
  // Never carry batch mode across a reset — the fresh dashboard was never put
  // into it. Clears selection + toggle so the bottom bar and checkboxes vanish.
  resetBatchState();
  state.criterionEvaluations = [];
  state.strengths = [];
  state.lastReviewContextFingerprint = null;
  state.reviewScope = "full";
  state.reviewRequest = "";
  state.focusedReviewRunning = false;
  state.reviewInFlight = false;
  state.crossFilterEnabled = false;
  state.crossFilterSelection = null;
  state.interactionObservations.clear();
  state.context = {
    goal: "",
    audience: "",
    constraints: "",
    scope: [...DEFAULT_FEEDBACK_SCOPE],
    customTypes: [],
    notes: [],
    fieldStatus: { goal: "missing", audience: "missing", constraints: "missing" },
    snapshotId: null,
  };
  state.studyContextGenerated = null;
  state.contextWorkflow = createContextWorkflow(CONTEXT_WORKFLOW_STATUS.IDLE, {
    requestSerial: state.contextWorkflow.requestSerial,
  });
  state.drawers = { versions: false, history: false };
  state.sidebarPopover = null;
  state.pinnedSidebarComponent = null;
  state.search = "";
  state.expandedCritiqueGroups = {};
  state.localReviewDraft = null;
  state.localReviewSubmitting = false;
  els.searchInput.value = "";
  syncSidebarComponents();
  syncBriefFields();
  renderContextNotes();
  setMode("review");
  closeLocalReviewPopover();
  closeContextModal();
  renderContextToolState();
  renderRubrics();
  renderCanvasPreviewControl();
  renderDashboardChrome();
  await renderTiles();
  await rememberDashboardExport(state.versions[0]);
  renderMarkers();
  renderCritiques();
  renderInspector();
  renderVersions();
  renderWorkingDraftStatus();
  applyDrawers();
  void inferContextOnUpload();
  fitCanvas();
}

els.aiAssistButton.addEventListener("click", runAIAssist);
document.getElementById("resetButton").addEventListener("click", resetDemo);

// --- User-study data collection (telemetry) -------------------------------
// A study session starts with a participant id; every product interaction is
// mirrored into an uncapped, refresh-surviving log (see the hook in
// appendInteractionEvent). The bundle — events plus a snapshot of the
// before/after dashboards, critiques, decisions, rationales, and context — is
// written only on explicit Save now or End & save.
function escapeStudy(value) {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
  );
}

function collectStudySnapshot() {
  const clone = (value) => {
    try {
      return typeof structuredClone === "function"
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value ?? null));
    } catch {
      return null;
    }
  };
  return {
    artifactId: state.artifact?.id ?? null,
    artifactSource: state.artifact?.source ?? null,
    dashboardTitle: state.dashboardTitle ?? null,
    version: state.version,
    context: clone(state.context),
    constraintSet: clone(state.constraintSet),
    constraintSelection: clone(state.constraintSelection),
    critiques: clone(state.critiques) || [],
    versions: clone(stripVersionMedia(state.versions) || []),
    rationales: clone(state.rationales) || [],
    criterionEvaluations: clone(state.criterionEvaluations) || [],
    strengths: clone(state.strengths) || [],
  };
}

async function collectStudyDashboardArtifacts() {
  let captured = { png: null, svg: null, screenshot: null, snapshot: null };
  try {
    captured = await captureDashboardExport();
  } catch (error) {
    console.warn("[study] dashboard PNG capture failed", error);
  }
  return buildStudyDashboardArtifacts({
    versions: state.versions,
    finalDocument: dashboardDocumentFromSnapshot(
      captured.snapshot || buildDashboardCaptureSnapshot(),
      "final",
    ),
    finalPng: captured.png,
    finalSvg: captured.svg,
  });
}

function studyUnresolvedCritiqueIds() {
  const displayed = new Set();
  const decided = new Set();
  for (const event of studyEventLog()) {
    const kind = event.kind || event.eventName;
    const data = event.data || {};
    if (kind === "critiques_displayed") {
      for (const id of data.critiqueIds || []) displayed.add(id);
    }
    if (
      kind === "recommendation_accepted"
      || kind === "recommendation_rejected"
      || kind === "recommendation_deferred"
    ) {
      if (event.critiqueId) decided.add(event.critiqueId);
      if (data.critiqueId) decided.add(data.critiqueId);
    }
    if (kind === "changes_applied") {
      for (const id of data.committedCritiqueIds || data.recommendationIds || []) decided.add(id);
    }
  }
  return [...displayed].filter((id) => !decided.has(id));
}

async function saveStudyBundle(reason) {
  if (reason === "end" && isStudyActive()) {
    const unresolvedCritiqueIds = studyUnresolvedCritiqueIds();
    recordStudyAction("critiques_unresolved", "Critiques displayed without a later decision", {
      critiqueIds: unresolvedCritiqueIds,
      critiqueCount: unresolvedCritiqueIds.length,
    });
    recordStudyAction("final_state_captured", "Captured the final dashboard and critique state", {
      dashboardId: state.artifact?.id || state.artifact?.libraryId || null,
      dashboardVersion: Number(state.version) || 1,
      critiqueIds: state.critiques.map((critique) => critique.id),
      critiqueCount: state.critiques.length,
      critiqueStatuses: state.critiques.map((critique) => ({
        id: critique.id,
        status: critique.status || null,
        decision: critique.lifecycle || critique.status || null,
      })),
      checkpointCount: (state.versions || []).length,
      contextVersion: Number(studySessionInfo()?.contextVersion) || Number(state.studyContextVersion) || 0,
      unresolvedCritiqueIds,
    });
    endStudySession({ reason: "end" });
  }
  const artifacts = await collectStudyDashboardArtifacts();
  const bundle = buildStudyBundle(collectStudySnapshot(), reason);
  try {
    const result = await saveStudySessionToServer({ ...bundle, artifacts });
    return { bundle, result, artifacts };
  } catch (err) {
    console.warn("[study] server save failed:", err?.message || err);
    return { bundle, result: null, error: err, artifacts };
  }
}

function injectStudyStyles() {
  let style = document.getElementById("studyStyles");
  if (!style) {
    style = document.createElement("style");
    style.id = "studyStyles";
    document.head.appendChild(style);
  }
  style.textContent = `
    .study-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; align-items: center; justify-content: center; z-index: 9999; }
    .study-modal-overlay.open { display: flex; }
    .study-modal-overlay[hidden] { display: none !important; }
    .study-modal { background: #fff; color: #1c1c1e; width: min(480px, calc(100vw - 32px)); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.3); overflow: hidden; }
    .study-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #e5e5e7; }
    .study-modal-head strong { font-size: 15px; }
    .study-modal-body { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .study-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #3a3a3c; }
    .study-field input, .study-field textarea { font: inherit; padding: 8px 10px; border: 1px solid #d1d1d6; border-radius: 8px; color: #1c1c1e; background: #fff; }
    .study-line { display: flex; justify-content: space-between; gap: 12px; margin: 0; font-size: 13px; color: #3a3a3c; }
    .study-line code { font-size: 11px; color: #6e6e73; overflow-wrap: anywhere; }
    .study-status { min-height: 16px; margin: 4px 0 0; font-size: 12px; color: #6e6e73; }
    .study-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .study-actions .button { font: inherit; cursor: pointer; padding: 8px 12px; border-radius: 8px; border: 1px solid #d1d1d6; background: #f2f2f7; color: #1c1c1e; }
    .study-actions .button.primary { background: #1c1c1e; color: #fff; border-color: #1c1c1e; }
    .study-actions .button.danger { background: #fff; color: #b00020; border-color: #e5b4bb; }
    .study-annotate { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid #e5e5e7; }
    .study-annotate-row { display: flex; gap: 8px; align-items: stretch; }
    .study-annotate-row select, .study-annotate-row input, .study-field select { font: inherit; padding: 8px 10px; border: 1px solid #d1d1d6; border-radius: 8px; color: #1c1c1e; background: #fff; }
    .study-annotate-row input { flex: 1; min-width: 0; }
    [data-study-session].recording { color: #b00020; }
  `;
}

function mountStudyUI() {
  injectStudyStyles();
  document.getElementById("studyModalOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "studyModalOverlay";
  overlay.className = "study-modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="study-modal" role="dialog" aria-modal="true" aria-labelledby="studyModalTitle">
      <div class="study-modal-head">
        <strong id="studyModalTitle">Study session</strong>
        <button type="button" class="icon-button" id="studyModalClose" aria-label="Close">×</button>
      </div>
      <div class="study-modal-body" id="studyModalBody"></div>
    </div>`;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#studyModalBody");
  const studyTriggers = () => document.querySelectorAll("[data-study-session]");
  const close = () => {
    overlay.classList.remove("open");
    overlay.hidden = true;
  };
  const open = () => {
    renderBody();
    overlay.hidden = false;
    overlay.classList.add("open");
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector("#studyModalClose").addEventListener("click", close);

  function refreshButton() {
    const active = isStudyActive();
    const info = studySessionInfo();
    const title = active
      ? `Study session active — ${info.participantId} (${info.eventCount} events)`
      : "Study session";
    studyTriggers().forEach((button) => {
      button.classList.toggle("recording", active);
      button.title = title;
    });
  }

  function renderBody() {
    const info = studySessionInfo();
    if (isStudyActive() && info) {
      body.innerHTML = `
        <p class="study-line"><span>Participant</span><strong>${escapeStudy(info.participantId)}</strong></p>
        <p class="study-line"><span>Session</span><code>${escapeStudy(info.sessionId)}</code></p>
        <p class="study-line"><span>Events</span><strong id="studyEventCount">${info.eventCount}</strong></p>
        <label class="study-field"><span>Study phase</span>
          <select id="studyPhase">
            <option value="">Select phase…</option>
            ${STUDY_PHASES.map((phase) =>
              `<option value="${phase}"${info.studyPhase === phase ? " selected" : ""}>${phase.replaceAll("_", " ")}</option>`).join("")}
          </select>
        </label>
        <div class="study-annotate">
          <strong>Researcher annotation</strong>
          <div class="study-annotate-row">
            <select id="studyAnnotationKind">
              ${RESEARCHER_ANNOTATION_KINDS.map((kind) =>
                `<option value="${kind}">${kind.replaceAll("_", " ")}</option>`).join("")}
            </select>
            <input type="text" id="studyAnnotationNote" placeholder="Assistance, interruption, technical problem…">
          </div>
          <button type="button" class="button" id="studyAnnotate">Record annotation</button>
        </div>
        <p class="study-status" id="studyStatus" aria-live="polite"></p>
        <div class="study-actions">
          <button type="button" class="button" id="studySaveNow">Save now</button>
          <button type="button" class="button" id="studyDownload">Download backup</button>
          <button type="button" class="button" id="studyDiscard">Discard &amp; start over</button>
          <button type="button" class="button danger" id="studyEnd">End &amp; save</button>
        </div>`;
      const status = body.querySelector("#studyStatus");
      const say = (message) => {
        if (status) status.textContent = message;
      };
      body.querySelector("#studyPhase")?.addEventListener("change", (event) => {
        const phase = event.currentTarget.value;
        if (!phase) return;
        setStudyPhase(phase);
        say(`Phase: ${phase.replaceAll("_", " ")}.`);
      });
      body.querySelector("#studyAnnotate")?.addEventListener("click", () => {
        const kind = body.querySelector("#studyAnnotationKind")?.value;
        const note = body.querySelector("#studyAnnotationNote")?.value || "";
        const recorded = recordResearcherAnnotation(kind, note);
        if (recorded) {
          const noteInput = body.querySelector("#studyAnnotationNote");
          if (noteInput) noteInput.value = "";
          say(`Recorded ${kind.replaceAll("_", " ")}.`);
        }
      });
      body.querySelector("#studySaveNow").addEventListener("click", async () => {
        say("Saving…");
        const out = await saveStudyBundle("manual");
        const files = out?.result?.files?.length;
        say(out?.result
          ? `Saved (${out.result.stored}${files ? `, ${files} files` : ""}).`
          : "Saved locally; server upload failed.");
      });
      body.querySelector("#studyDownload").addEventListener("click", async () => {
        say("Preparing backup…");
        const artifacts = await collectStudyDashboardArtifacts();
        const bundle = buildStudyBundle(collectStudySnapshot(), "manual-download");
        exportStudyBackupZip(artifacts, bundle);
        say("Complete backup downloaded.");
      });
      body.querySelector("#studyDiscard").addEventListener("click", () => {
        if (!window.confirm("Discard this session without saving? This cannot be undone.")) return;
        discardStudySession();
        refreshButton();
        renderBody(); // session is gone -> re-renders as the fresh Start form
      });
      body.querySelector("#studyEnd").addEventListener("click", async () => {
        say("Saving dashboards and session…");
        const out = await saveStudyBundle("end");
        exportStudyBackupZip(out.artifacts, out.bundle);
        endStudySession({ recordEvent: false });
        refreshButton();
        renderBody();
        say(out?.result
          ? `Session ended and saved (${out.result.stored}).`
          : "Session ended; saved locally only.");
      });
    } else {
      body.innerHTML = `
        <label class="study-field"><span>Participant ID</span><input type="text" id="studyParticipant" placeholder="P01" autocomplete="off"></label>
        <label class="study-field"><span>Notes</span><textarea id="studyNotes" rows="2"></textarea></label>
        <div class="study-actions">
          <button type="button" class="button primary" id="studyStart">Start session</button>
        </div>`;
      const begin = () => {
        const participantId = body.querySelector("#studyParticipant").value.trim();
        if (!participantId) {
          body.querySelector("#studyParticipant").focus();
          return;
        }
        startStudySession({
          participantId,
          notes: body.querySelector("#studyNotes").value,
        });
        refreshButton();
        renderBody();
      };
      body.querySelector("#studyStart").addEventListener("click", begin);
      body.querySelector("#studyParticipant").focus();
    }
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-study-session]")) return;
    open();
  });

  // Keep the toolbar affordance and (if open) the live event count fresh.
  setInterval(() => {
    refreshButton();
    if (overlay.classList.contains("open") && isStudyActive()) {
      const counter = document.getElementById("studyEventCount");
      if (counter) counter.textContent = String(studySessionInfo().eventCount);
    }
  }, 2000);

  refreshButton();
}

restoreStudySession();
mountStudyUI();
document.getElementById("focusBackButton").addEventListener("click", () => {
  // Study telemetry: closing the detail bounds the viewing interval (open -> close),
  // giving a reliable time-on-critique without any attention/gaze tracking.
  recordStudyAction("critique_closed", "Returned to the critique list", {
    critiqueId: state.selectedCritiqueId || null,
    dwellMs: critiqueInspectDwellMs(state.selectedCritiqueId),
  });
  state.critiqueInspect = { critiqueId: null, openedAtMs: 0 };
  closeCritiqueFocus();
});
// Both mode triggers hide themselves on activation (the face swap sets the
// clicked button to display:none), which would drop keyboard/SR focus to
// <body>. Move focus to the counterpart control that becomes visible.
document.getElementById("batchSelectToggle").addEventListener("click", async () => {
  await setBatchMode(true);
  document.getElementById("batchExitButton")?.focus();
});
document.getElementById("batchExitButton").addEventListener("click", async () => {
  await setBatchMode(false);
  document.getElementById("batchSelectToggle")?.focus();
});
document.getElementById("batchSelectAllButton").addEventListener("click", async () => {
  state.batchSelection = new Set(filteredCritiques().filter(critiqueBatchEligible).map((c) => c.id));
  renderCritiques();
  await refreshBatchPreview();
});
document.getElementById("batchClearButton").addEventListener("click", async () => {
  state.batchSelection = new Set();
  renderCritiques();
  await refreshBatchPreview();
});
document.getElementById("batchApplyButton").addEventListener("click", async () => {
  const button = document.getElementById("batchApplyButton");
  if (button?.disabled) return;
  const selectedIds = [...state.batchSelection];
  if (!selectedIds.length) return;
  if (button) button.disabled = true;
  const applied = await applySelectionResolvingConflicts(selectedIds);
  if (!applied.ok) {
    renderBatchApplyBar();
    const note = document.getElementById("batchApplyNote");
    if (note) {
      note.textContent = `Changes not applied: ${applied.reason}`;
      note.setAttribute("role", "alert");
    }
    return;
  }
  // A successful apply commits a new version and clears pending selection; leave
  // batch mode so the author sees the settled Working Draft.
  await setBatchMode(false);
});
document.getElementById("canvasPreviewToggle").addEventListener("click", () => {
  const nextPhase = state.canvasPreview?.phase === "after" ? "before" : "after";
  // During an interaction runtime test the same toggle switches the live phase
  // and observes it, instead of the static preview swap.
  if (state.demoPlaying) {
    switchInteractionRuntimePhase(nextPhase);
    return;
  }
  setCanvasPreviewPhase(nextPhase);
});
document.getElementById("saveCheckpointButton").addEventListener("click", saveWorkingDraftCheckpoint);
els.localReviewButton.addEventListener("click", () => {
  if (!els.localReviewPopover.hidden) closeLocalReviewPopover();
  if (state.mode === "annotate") cancelLocalReviewSelection();
  else setMode("annotate");
});
document.getElementById("cancelAnnotateButton").addEventListener("click", cancelLocalReviewSelection);
document.getElementById("closeLocalReview").addEventListener("click", closeLocalReviewPopover);
document.getElementById("cancelLocalReview").addEventListener("click", closeLocalReviewPopover);
document.getElementById("localReviewForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.localReviewSubmitting) return;
  if (state.reviewInFlight) {
    showLocalReviewError("A review is already running. Wait for it to finish before selecting an area.");
    return;
  }
  const request = els.localReviewRequest.value.trim();
  const bounds = state.localReviewDraft && !("startX" in state.localReviewDraft)
    ? clone(state.localReviewDraft)
    : null;
  if (!bounds || !request) {
    showLocalReviewError("Select an area and describe what the review should focus on.");
    return;
  }

  setLocalReviewSubmitting(true);
  state.reviewInFlight = true;
  els.localReviewError.hidden = true;
  // Decouple the popover from the selection box: dismiss the popover right away
  // so the canvas — with the box and its generating ring — is visible while the
  // critique generates. The box has its own lifecycle and stays put until
  // generation finishes (retired on success, kept for retry on failure).
  els.localReviewPopover.hidden = true;
  let askId = null;
  const requestId = newStudyId();
  const requestStartedAt = Date.now();
  try {
    askId = state.nextAskId++;
    recordStudyAction(
      "critique_requested",
      `Requested a local review: ${request}`,
      critiqueRequestStudyData({
        requestId,
        requestMode: "local",
        scope: "region",
        askId,
        queryText: request,
        bounds,
        trigger: "local-review",
      }),
    );
    const { critiques: localCritiques, answer, reviewMeta } = await generateLocalCritiques({
      bounds,
      request,
      dimension: els.localReviewDimension.value,
    });
    // Region asks already accumulated; route through the same merge so decided
    // critiques are respected and every ask gets consistent history provenance.
    const merged = mergeAskResults(state.critiques, localCritiques, {
      askId,
      reviewScope: "selected-region",
      dashboardVersion: state.version,
    });
    state.critiques = scopeRank(enrichRecommendations(merged, state.version));
    state.previewCache.clear();
    state.interactionObservations.clear();
    state.lastReviewContextFingerprint = contextFingerprint(state.context);
    const directAnswer = state.critiques.find((critique) =>
      critique.askId === askId && critique.requestRelevance === "direct")
      || state.critiques.find((critique) => critique.askId === askId)
      || null;
    // Always surface a visible answer for the region ask — including when it
    // produced only an answer and no grounded critique card.
    const answerText = answer || directAnswer?.answer || null;
    state.askAnswer = answerText
      ? {
          text: answerText,
          request,
          reviewScope: "selected-region",
          critiqueId: directAnswer?.id || null,
          noCritiques: localCritiques.length === 0,
        }
      : null;
    state.selectedCritiqueId = directAnswer?.id || null;
    state.selectedTileId = directAnswer?.tileId || null;
    appendInteractionEvent({
      kind: "local_critique_requested",
      summary: localCritiques.length
        ? `Requested a local critique of ${localCritiques.length} ${localCritiques.length === 1 ? "finding" : "findings"}`
        : "Requested a local review (answer only, no grounded critique)",
      detail: request,
      dimension: els.localReviewDimension.value || localCritiques[0]?.dimension || "other",
      bounds,
      data: {
        requestId,
        requestMode: "local",
        critiqueIds: localCritiques.map((critique) => critique.id),
      },
    });
    closeLocalReviewPopover();
    renderCritiques();
    renderMarkers();
    await renderInspector();
    if (state.batchMode) await refreshBatchPreview();
    recordCritiquesDisplayed("selected-region", askId, {
      requestId,
      requestMode: "local",
      latencyMs: Date.now() - requestStartedAt,
      model: reviewMeta?.model || null,
      promptVersion: reviewMeta?.promptVersion || null,
      systemVersion: reviewMeta?.systemVersion || null,
      fewShotSetId: reviewMeta?.fewShotSetId || null,
      fewShotVersion: reviewMeta?.fewShotVersion || null,
      fewShotIds: reviewMeta?.fewShotIds || [],
      fewShotContentHash: reviewMeta?.fewShotContentHash || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tracePanel.fail(`Local review failed — ${message}`);
    recordStudyAction("critique_request_failed", "Local review failed", {
      scope: "selected-region",
      askId,
      requestId,
      requestMode: "local",
      requestText: request,
      queryText: request,
      dashboardVersion: Number(state.version) || 1,
      latencyMs: Date.now() - requestStartedAt,
      reason: message,
    });
    // Bring the popover back so the error is visible and the request can be
    // retried; the selection box and the typed request are still in place.
    els.localReviewPopover.hidden = false;
    showLocalReviewError(message);
  } finally {
    state.reviewInFlight = false;
    setLocalReviewSubmitting(false);
    syncReviewReadiness();
  }
});
els.searchInput.addEventListener("input", (event) => { state.search = event.target.value; renderCritiques(); renderMarkers(); });
document.getElementById("revisionDockToggle").addEventListener("click", () => {
  state.drawers.versions = !state.drawers.versions;
  applyDrawers();
});
// Critique History opens as a header popover via the generic [data-sidebar-popover]
// wiring below; its list is rebuilt by renderCritiqueHistory() whenever the
// popover is open, so no bespoke toggle handler is needed here.
document.getElementById("zoomIn").addEventListener("click", () => setScale(state.view.scale * 1.18));
document.getElementById("zoomOut").addEventListener("click", () => setScale(state.view.scale / 1.18));
document.getElementById("zoomFit").addEventListener("click", fitCanvas);
els.canvasViewport.addEventListener("wheel", (event) => {
  if (state.demoPlaying) { event.preventDefault(); return; }
  if (event.target.closest(".revision-dock")) return;
  event.preventDefault();
  const rect = els.canvasViewport.getBoundingClientRect();
  if (event.ctrlKey || event.metaKey) {
    setScale(state.view.scale * Math.exp(-event.deltaY * 0.003), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  } else {
    state.view.x -= event.deltaX;
    state.view.y -= event.deltaY;
    applyViewTransform();
  }
}, { passive: false });
els.canvasViewport.addEventListener("mousedown", (event) => {
  if (state.demoPlaying) return;
  if (state.mode === "annotate") return;
  if (event.target.closest(".tile, .zoom-controls, .canvas-action-strip, .canvas-tool-popover, .revision-dock")) return;
  state.panning = { startX: event.clientX, startY: event.clientY, x: state.view.x, y: state.view.y };
  els.canvasViewport.classList.add("panning");
});
window.addEventListener("mousemove", (event) => {
  if (!state.panning) return;
  state.view.x = state.panning.x + event.clientX - state.panning.startX;
  state.view.y = state.panning.y + event.clientY - state.panning.startY;
  applyViewTransform();
});
window.addEventListener("mouseup", () => { state.panning = null; els.canvasViewport.classList.remove("panning"); });
els.dashboardArtboard.addEventListener("pointerdown", (event) => {
  if (state.mode !== "annotate" || state.localReviewSubmitting || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = els.dashboardArtboard.getBoundingClientRect();
  const scaleX = rect.width / state.canvasSize.width;
  const scaleY = rect.height / state.canvasSize.height;
  const startX = Math.max(
    0,
    Math.min(state.canvasSize.width, (event.clientX - rect.left) / scaleX),
  );
  const startY = Math.max(
    0,
    Math.min(state.canvasSize.height, (event.clientY - rect.top) / scaleY),
  );
  state.localReviewDraft = {
    pointerId: event.pointerId,
    startX,
    startY,
    x: startX,
    y: startY,
    w: 0,
    h: 0,
  };
  document.querySelector(".draft-marker")?.remove();
  const marker = document.createElement("div");
  marker.className = "draft-marker";
  els.markersLayer.appendChild(marker);
});
window.addEventListener("pointermove", (event) => {
  const draft = state.localReviewDraft;
  if (
    state.mode !== "annotate" ||
    !draft ||
    !("startX" in draft) ||
    draft.pointerId !== event.pointerId
  ) return;
  const rect = els.dashboardArtboard.getBoundingClientRect();
  const scaleX = rect.width / state.canvasSize.width;
  const scaleY = rect.height / state.canvasSize.height;
  const currentX = Math.max(
    0,
    Math.min(state.canvasSize.width, (event.clientX - rect.left) / scaleX),
  );
  const currentY = Math.max(
    0,
    Math.min(state.canvasSize.height, (event.clientY - rect.top) / scaleY),
  );
  draft.x = Math.min(draft.startX, currentX);
  draft.y = Math.min(draft.startY, currentY);
  draft.w = Math.abs(currentX - draft.startX);
  draft.h = Math.abs(currentY - draft.startY);
  const marker = document.querySelector(".draft-marker");
  if (marker) {
    Object.assign(marker.style, {
      left: `${draft.x}px`,
      top: `${draft.y}px`,
      width: `${draft.w}px`,
      height: `${draft.h}px`,
    });
  }
});
function finishLocalReviewSelection(event) {
  const draft = state.localReviewDraft;
  if (
    state.mode !== "annotate" ||
    !draft ||
    !("startX" in draft) ||
    draft.pointerId !== event.pointerId
  ) return;
  const bounds = { x: draft.x, y: draft.y, w: draft.w, h: draft.h };
  if (bounds.w >= 16 && bounds.h >= 16) openLocalReviewPopover(bounds);
  else cancelLocalReviewSelection();
}
window.addEventListener("pointerup", finishLocalReviewSelection);
window.addEventListener("pointercancel", finishLocalReviewSelection);
window.addEventListener("resize", fitCanvas);
window.addEventListener("resize", () => {
  const stored = readStoredPanelLayout();
  requestAnimationFrame(() => {
    if (Number.isFinite(Number(stored.left))) setPanelWidth("left", Number(stored.left));
    else syncPanelResizerValue("left");
    if (Number.isFinite(Number(stored.right))) setPanelWidth("right", Number(stored.right));
    else syncPanelResizerValue("right");
  });
});
window.addEventListener("beforeunload", (event) => {
  if (!state.workingDraft.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

// User must upload dashboard from upload screen
// No default dashboard - keeps workspace clean until upload

initializePanelResizing();
initializeRevisionDockResizing();
initScopeTooltip();
renderContextToolState();
renderWorkingDraftStatus();
wireReviewTemperature();
requestAnimationFrame(fitCanvas);

// ---------------------------------------------------------------------------
// v2 wiring — scoped tools, global context, and on-demand components.
// ---------------------------------------------------------------------------
document.querySelectorAll("[data-sidebar-popover]").forEach((btn) =>
  btn.addEventListener("click", () => openSidebarPopover(btn.dataset.sidebarPopover)));
document.querySelectorAll("[data-close-sidebar-popover]").forEach((btn) =>
  btn.addEventListener("click", () => closeSidebarComponent(btn.closest("[data-popover-name]").dataset.popoverName)));
document.querySelectorAll("[data-pin-sidebar-component]").forEach((btn) =>
  btn.addEventListener("click", () => togglePinnedSidebarComponent(btn.dataset.pinSidebarComponent)));
document.addEventListener("pointerdown", (event) => {
  if (!state.sidebarPopover) return;
  if (event.target.closest("[data-popover-name], [data-sidebar-popover]")) return;
  closeSidebarPopovers();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (els.canvasViewport.querySelector(".revision-lightbox")) {
    closeRevisionLightbox();
    return;
  }
  const contextModal = document.getElementById("contextModal");
  if (contextModal && !contextModal.hidden) {
    closeContextModal();
    document.getElementById("focusAddContext")?.focus();
    return;
  }
  if (!els.localReviewPopover.hidden && !state.localReviewSubmitting) {
    closeLocalReviewPopover();
    return;
  }
  if (state.mode === "annotate") {
    cancelLocalReviewSelection();
    return;
  }
  if (state.selectedCritiqueId) {
    closeCritiqueFocus();
    return;
  }
  closeSidebarPopovers();
});

// Critique-level design rationale modal.
document.getElementById("closeContextModal").addEventListener("click", closeContextModal);
document.addEventListener("pointerdown", (event) => {
  const modal = document.getElementById("contextModal");
  if (!modal || modal.hidden || modal.contains(event.target)) return;
  if (event.target.closest("#focusAddContext, #focusEditRationale, [data-rationale-edit]")) return;
  closeContextModal();
});
window.addEventListener("resize", () => positionRationalePopover());
document.getElementById("contextInjectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const existingRationale = state.rationales.find((item) => item.id === state.rationaleEditId);
  const critique = critiqueById(state.contextTargetId);
  const text = document.getElementById("contextInput").value.trim();
  if ((!critique && !existingRationale) || !text) return;
  const critiqueReference = critique || {
    id: existingRationale.critiqueId,
    title: existingRationale.critiqueTitle,
    dimension: existingRationale.dimension,
  };
  const previous = critique ? clone(critique) : null;
  const previousCritiques = clone(state.critiques);
  const now = new Date().toISOString();
  const critiqueContext = existingRationale?.critiqueContext
    || createCritiqueContextSnapshot(critiqueReference);
  const rationale = existingRationale
    ? {
        ...existingRationale,
        text,
        critiqueContext,
        dashboardVersion: existingRationale.dashboardVersion || state.version,
        updatedAt: now,
      }
    : createCritiqueRationale({
        id: `rationale-${state.nextRationaleId++}`,
        critique: critiqueReference,
        dashboardVersion: state.version,
        text,
        createdAt: now,
      });
  state.rationales = upsertCritiqueRationale(state.rationales, rationale);
  appendInteractionEvent({
    kind: existingRationale ? "critique_rationale_updated" : "critique_rationale_added",
    summary: `${existingRationale ? "Updated" : "Added"} rationale for critique: ${critiqueReference.title}`,
    detail: text,
    critiqueId: critiqueReference.id,
    dimension: critiqueReference.dimension,
    proposalKind: critique?.proposal?.kind,
    data: {
      rationaleId: rationale.id,
      dashboardVersion: rationale.dashboardVersion,
      critique: rationale.critiqueContext,
      sourceCritiqueId: rationale.originCritiqueId || rationale.critiqueContext?.id || rationale.critiqueId,
      currentCritiqueId: rationale.critiqueId,
    },
  }, { synthesize: false });
  closeContextModal();
  renderFixedContextPanel();
  if (!critique) return;

  const succeeded = await runAIAssist();
  if (!succeeded) {
    state.critiques = previousCritiques;
    state.selectedCritiqueId = previous.id;
    state.selectedTileId = previous.tileId;
    renderCritiques();
    renderMarkers();
    await renderInspector();
    return;
  }
  const revised = closestRevisedCritique(previous);
  if (!revised) return;
  state.rationales = state.rationales.map((item) =>
    item.id === rationale.id
      ? {
          ...item,
          originCritiqueId: item.originCritiqueId || item.critiqueId,
          critiqueId: revised.id,
        }
      : item);
  revised.revisions = [
    ...(previous.revisions || []),
    { rationale: text, suggestion: revised.suggestion },
  ];
  state.selectedCritiqueId = revised.id;
  state.selectedTileId = revised.tileId;
  renderFixedContextPanel();
  renderCritiques();
  renderMarkers();
  await renderInspector();
});

applyDrawers();

// ---------------------------------------------------------------------------
// First-run onboarding — the split upload + context screen (kept from v1). It
// gathers the initial brief once; afterwards the context is edited on demand via
// the left Context stage icon (no longer a permanent form in the sidebar).
// ---------------------------------------------------------------------------
document.querySelector("#app").insertAdjacentHTML("beforeend", `
  <div class="upload-screen" id="uploadScreen">
    <header class="upload-brandbar">
      <div class="upload-brand">
        <span class="upload-brand-mark" aria-hidden="true">▦</span>
        <strong>VIZier</strong>
      </div>
      <button class="icon-button" data-study-session type="button" aria-label="Study session" title="Study session">◉</button>
    </header>

    <div class="upload-center" id="uploadCenter">
      <div class="upload-intro">
        <span class="upload-step-label">Study Setup</span>
        <h1>Choose a material</h1>
        <p>Select the assigned code.</p>
      </div>

      <div class="upload-picker upload-picker--bundles">
        <section class="upload-col" aria-label="Study materials">
          <div class="upload-col-head">
            <button
              class="dashboard-library-refresh upload-col-refresh"
              id="onboardingDashboardLibraryRefresh"
              type="button"
              aria-label="Refresh dashboard library"
            ><span aria-hidden="true">↻</span><span>Refresh</span></button>
          </div>
          <div class="upload-cards" id="onboardingDashboardCards">
            <p class="upload-cards-empty">Loading study materials…</p>
          </div>
          <p class="upload-col-status" id="onboardingDashboardLibraryStatus" role="status" aria-live="polite"></p>
        </section>
      </div>

      <div class="upload-start-row">
        <p class="upload-selection-summary" id="onboardingSelectionSummary" role="status" aria-live="polite">Select a material code to continue.</p>
        <button type="button" class="upload-start-btn" id="onboardingStartBtn" disabled>Select a material</button>
      </div>

      <div class="upload-preview-center" id="uploadPreviewCenter" hidden>
        <div class="upload-preview-actions">
          <button type="button" class="btn secondary" id="removeUploadBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            Remove
          </button>
          <button type="button" class="btn primary" id="confirmUploadBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            Confirm & Continue
          </button>
        </div>
      </div>
    </div>

    <div class="upload-split" id="uploadSplit" hidden>
      <div class="upload-split-left">
        <div class="upload-preview-label">Dashboard Preview</div>
      </div>
      <div class="upload-split-right">
        <div class="upload-form-container">
          <form class="context-form" id="contextForm">
            <div class="brief-builder-head">
              <div class="brief-builder-title">
                <h2>Review Context</h2>
                <span class="optional-label">Optional</span>
                <button type="button" class="onboarding-info" aria-label="About review context" data-tooltip="VIZier infers Goal and Audience when dashboard evidence is available. Review or edit them before continuing.">i</button>
              </div>
            </div>

            <div class="brief-error" id="briefError" role="alert" hidden></div>

            <section class="brief-guided-panel" id="briefGuidedPanel">
              <div class="context-merged" data-context-scope="onboarding">
                <div class="context-merged-head">
                  <span class="context-merged-title">Dashboard Context</span>
                  <button type="button" class="btn secondary small parse-brief-btn ai-text-action context-infer-btn" id="parseBriefBtn"><span>Infer</span>${AI_ACTION_ICON}</button>
                </div>
                <p class="context-merged-status" id="draftBriefStatus" hidden></p>
                <div class="context-merged-body">
                  <div class="brief-field context-line ai-assisted-field" data-field="goal">
                    <div class="field-label-row"><label for="dashboardGoal">Goal</label></div>
                    <textarea id="dashboardGoal" rows="2" placeholder="What decision should this dashboard support?"></textarea>
                  </div>
                  <div class="brief-field context-line ai-assisted-field" data-field="audience">
                    <div class="field-label-row"><label for="dashboardAudience">Audience</label></div>
                    <input type="text" id="dashboardAudience" placeholder="Who is the primary audience?" />
                  </div>
                  <div class="brief-field context-line ai-assisted-field" data-field="constraints">
                    <div class="field-label-row"><label for="dashboardConstraints">Constraints <span class="optional-label">Optional</span></label></div>
                    <textarea id="dashboardConstraints" rows="2" placeholder="What should the review preserve or avoid?"></textarea>
                  </div>
                </div>
                <div class="parse-progress" id="parseProgress" hidden><span class="parse-spinner"></span><span>Inferring goal, audience, and constraints…</span></div>
              </div>

              ${designDocControlMarkup("onboarding")}

              <div class="form-group">
                <div class="field-label-row"><label>Review scope</label></div>
                <div class="feedback-scope-selector">
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="chart" checked /><span class="scope-label"><span class="scope-title">Charts</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="color" checked /><span class="scope-label"><span class="scope-title">Color</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="layout" checked /><span class="scope-label"><span class="scope-title">Layout</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="data" checked /><span class="scope-label"><span class="scope-title">Data</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="text" checked /><span class="scope-label"><span class="scope-title">Text</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="visual design" checked /><span class="scope-label"><span class="scope-title">Visual design</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="cognition" checked /><span class="scope-label"><span class="scope-title">Cognition</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="context" checked /><span class="scope-label"><span class="scope-title">Context</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="interaction" checked /><span class="scope-label"><span class="scope-title">Interactivity</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="task" checked /><span class="scope-label"><span class="scope-title">Task</span></span></label>
                  <label class="scope-checkbox"><input type="checkbox" name="feedbackScope" value="design process" checked /><span class="scope-label"><span class="scope-title">Design process</span></span></label>
                </div>
                <div class="custom-feedback-types">
                  <input type="text" id="customFeedbackType" placeholder="+ Add custom type (e.g., Mobile, Branding)" class="custom-type-input" />
                  <button type="button" class="btn secondary small" id="addCustomTypeBtn">Add</button>
                </div>
                <div id="customTypesContainer" class="custom-types-list"></div>
              </div>
            </section>

            <div class="upload-form-actions">
              <button type="button" class="btn secondary" id="backToUploadBtn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                Back
              </button>
              <div class="upload-form-primary-actions">
                <button type="button" class="btn secondary" id="skipAIBtn">Continue Without Context</button>
                <button type="submit" class="btn primary" id="startReviewBtn">
                  Start Review
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
`);

// Both preview containers stay hidden until an upload supplies a real URL.
// Create their image nodes programmatically so the initial HTML does not declare
// a source-less image, while preserving the existing direct-child CSS sizing.
[
  ["uploadPreviewCenter", "previewImage", null],
  ["uploadSplit", "previewImageSplit", ".upload-split-left"],
].forEach(([rootId, imageId, targetSelector]) => {
  const image = document.createElement("img");
  image.id = imageId;
  image.alt = "Dashboard preview";
  const root = document.getElementById(rootId);
  const target = targetSelector ? root?.querySelector(targetSelector) : root;
  if (imageId === "previewImage") target?.prepend(image);
  else target?.appendChild(image);
});

const ob = {
  root: document.getElementById("uploadScreen"),
  center: document.getElementById("uploadCenter"),
  dropzone: document.getElementById("uploadDropzone"),
  browse: document.querySelector(".upload-browse-btn"),
  file: document.getElementById("fileInput"),
  preview: document.getElementById("uploadPreviewCenter"),
  previewImg: document.getElementById("previewImage"),
  remove: document.getElementById("removeUploadBtn"),
  confirm: document.getElementById("confirmUploadBtn"),
  split: document.getElementById("uploadSplit"),
  splitImg: document.getElementById("previewImageSplit"),
  form: document.getElementById("contextForm"),
  back: document.getElementById("backToUploadBtn"),
  skipAI: document.getElementById("skipAIBtn"),
  goal: document.getElementById("dashboardGoal"),
  audience: document.getElementById("dashboardAudience"),
  constraints: document.getElementById("dashboardConstraints"),
  guidedPanel: document.getElementById("briefGuidedPanel"),
  parseBrief: document.getElementById("parseBriefBtn"),
  parseProgress: document.getElementById("parseProgress"),
  draftBriefStatus: document.getElementById("draftBriefStatus"),
  error: document.getElementById("briefError"),
  customInput: document.getElementById("customFeedbackType"),
  addCustom: document.getElementById("addCustomTypeBtn"),
  customList: document.getElementById("customTypesContainer"),
};

let obImageURL = null;
const obCustomTypes = [];
let obFieldStatus = { goal: "missing", audience: "missing", constraints: "missing" };
let obContextSnapshotId = null;
let dashboardLibraryItems = [];
let dashboardLibraryRefreshSerial = 0;
let dashboardLibraryLoadSerial = 0;
let dashboardLibraryRefreshing = false;
let dashboardLibraryBusy = false;

// Study design documents are fixed assets. The PDF bytes ship beside the study
// dashboards and travel through the same extraction path as a manual upload.
const DESIGN_DOC_LIBRARY = [
  {
    id: "study-a",
    file: "A_bbc-gel-infographics.pdf",
    url: "/study-materials/pdfs/A_bbc-gel-infographics.pdf",
    label: "A · BBC GEL — Infographics",
  },
  {
    id: "study-b",
    file: "B_tableau-dashboard-best-practices.pdf",
    url: "/study-materials/pdfs/B_tableau-dashboard-best-practices.pdf",
    label: "B · Tableau — Dashboard Best Practices",
  },
];

// One source of truth for the four counterbalanced study materials. A and B
// carry fixed PDFs; assessment dashboards 1 and 2 intentionally carry none.
const STUDY_MATERIALS = [
  {
    code: "A",
    dashboardId: "garden-birds-new",
    dashboardUrl: "/study-materials/dashboards/A_garden-birds.json",
    docId: "study-a",
    documentLabel: "BBC GEL — Infographics",
  },
  {
    code: "B",
    dashboardId: "sales-command-center-new",
    dashboardUrl: "/study-materials/dashboards/B_retail-sales-command-center.json",
    docId: "study-b",
    documentLabel: "Tableau — Dashboard Best Practices",
  },
  {
    code: "1",
    dashboardId: "air-quality-new",
    dashboardUrl: "/study-materials/dashboards/1_air-quality.json",
    docId: "",
    documentLabel: "No PDF",
  },
  {
    code: "2",
    dashboardId: "ocean-life",
    dashboardUrl: "/study-materials/dashboards/2_ocean-biodiversity.json",
    docId: "",
    documentLabel: "No PDF",
  },
];

/** Route-level study runner entry. It uses the frozen public stimulus directly
 * so a participant never sees or depends on the moderator material picker. */
export async function openStudyMaterialForRunner(code) {
  const material = STUDY_MATERIALS.find((candidate) => candidate.code === code);
  if (!material) throw new Error(`Unknown study material: ${code}`);
  document.getElementById("uploadScreen")?.setAttribute("hidden", "");
  const response = await fetch(material.dashboardUrl);
  if (!response.ok) throw new Error(`Could not load material ${code}: ${response.status} ${response.statusText}`);
  const dashboard = await response.json();
  await loadJsonDashboard(dashboard, `${code}.json`);
  state.artifact.libraryId = material.dashboardId;
  if (material.docId) void loadDesignDocById(material.docId);
  else clearDesignDoc();
  recordStudyAction("study_material_opened", `Opened study material ${code}`, {
    materialCode: code,
    dashboardId: material.dashboardId,
    designDocId: material.docId || null,
  });
  return { ...material };
}

/** Capture the dashboard-task board so the phase save can write it immediately. */
export async function captureStudyRunnerTaskDashboard() {
  const artifacts = await collectStudyDashboardArtifacts();
  stashStudyTaskCapture(collectStudySnapshot(), artifacts);
}

const DASHBOARD_DESIGN_DOC_BINDINGS = {
  "garden-birds-new": "study-a",
  "sales-command-center-new": "study-b",
  "air-quality-new": "",
  "ocean-life": "",
};

// The study material selected but not yet committed with "Start Review".
let onboardingDashboardSelection = "";
let activeDesignDocId = "";
let designDocLibraryBusy = false;
let designDocLoadSerial = 0;

function dashboardLibrarySelects() {
  return [
    document.getElementById("dashboardLibrarySelect"),
    document.getElementById("onboardingDashboardLibrarySelect"),
  ].filter(Boolean);
}

function setDashboardLibraryStatus(message = "", error = false) {
  ["dashboardLibraryStatus", "onboardingDashboardLibraryStatus"].forEach((id) => {
    const status = document.getElementById(id);
    if (!status) return;
    status.textContent = message;
    status.dataset.state = error ? "error" : message ? "active" : "";
    status.setAttribute("aria-live", error ? "assertive" : "polite");
  });
}

function renderDashboardLibraryControls() {
  const selectedId = state.artifact.libraryId || "";
  const options = dashboardLibraryItems.map((item) => {
    const label = item.title === item.id ? item.title : `${item.title} — ${item.id}`;
    return `<option value="${escapeHTML(item.id)}">${escapeHTML(label)}</option>`;
  }).join("");
  dashboardLibrarySelects().forEach((select) => {
    const current = selectedId;
    select.innerHTML = `
      <option value="">${dashboardLibraryItems.length ? "Choose a dashboard…" : "No dashboards found"}</option>
      ${options}`;
    if (dashboardLibraryItems.some((item) => item.id === current)) select.value = current;
    select.disabled = dashboardLibraryBusy || !dashboardLibraryItems.length;
    select.setAttribute("aria-busy", String(dashboardLibraryBusy || dashboardLibraryRefreshing));
  });
  [
    document.getElementById("dashboardLibraryRefresh"),
    document.getElementById("onboardingDashboardLibraryRefresh"),
  ].filter(Boolean).forEach((button) => {
    button.disabled = dashboardLibraryBusy || dashboardLibraryRefreshing;
    button.classList.toggle("refreshing", dashboardLibraryRefreshing);
  });
  renderDashboardCards();
}

/** Resolve the four study codes against the live dashboard library while
 * preserving the protocol order A, B, 1, 2. */
function studyMaterialItems() {
  const byId = new Map(dashboardLibraryItems.map((item) => [item.id, item]));
  return STUDY_MATERIALS.map((material) => ({
    ...material,
    dashboard: byId.get(material.dashboardId) || null,
  }));
}

function selectedStudyMaterial() {
  return STUDY_MATERIALS.find((material) => material.dashboardId === onboardingDashboardSelection) || null;
}

/** Render one card per protocol material. Dashboard and design document are one
 * atomic choice: the card exposes the binding instead of asking the moderator to
 * assemble a pair correctly. */
function renderDashboardCards() {
  const container = document.getElementById("onboardingDashboardCards");
  if (!container) return;
  if (!dashboardLibraryItems.length) {
    const loading = dashboardLibraryBusy || dashboardLibraryRefreshing;
    container.innerHTML = `<p class="upload-cards-empty">${loading ? "Loading study materials…" : "Study dashboards are unavailable."}</p>`;
    updateOnboardingStart();
    return;
  }
  const renderMaterial = (material) => {
    const { dashboard } = material;
    const selected = material.dashboardId === onboardingDashboardSelection;
    const activeDocument = selected && material.docId && activeDesignDocId === material.docId;
    const docLoading = activeDocument && (designDocLibraryBusy || state.designDoc.status === "loading");
    const docError = activeDocument && state.designDoc.status === "error";
    const flag = docLoading
      ? "Preparing PDF"
      : docError
        ? "PDF error"
        : selected
          ? material.docId && state.designDoc.status === "loaded" ? "PDF ready" : "Selected"
          : "";
    return `
      <button type="button" class="upload-card upload-material-card${selected ? " is-selected" : ""}${docError ? " has-error" : ""}"
        data-dashboard-id="${escapeHTML(material.dashboardId)}" aria-pressed="${selected}"
        aria-busy="${Boolean(docLoading)}" ${dashboardLibraryBusy || !dashboard ? " disabled" : ""}>
        <span class="upload-card-code" aria-label="Material ${escapeHTML(material.code)}">${escapeHTML(material.code)}</span>
        <span class="upload-card-text">
          <span class="upload-card-title">${escapeHTML(dashboard?.title || "Material unavailable")}</span>
          <span class="upload-card-sub">
            ${dashboard
              ? `<span>Dashboard</span><span aria-hidden="true">·</span><span>${escapeHTML(material.docId ? material.documentLabel : "No PDF assigned")}</span>`
              : `<span>Missing dashboard: ${escapeHTML(material.dashboardId)}</span>`}
          </span>
        </span>
        ${flag ? `<span class="upload-card-flag">${flag}</span>` : ""}
      </button>`;
  };
  const materials = studyMaterialItems();
  const groups = [
    {
      id: "taskMaterials",
      title: "Task materials",
      detail: "Dashboard + reference PDF",
      items: materials.filter((material) => material.docId),
    },
    {
      id: "assessmentMaterials",
      title: "Assessment materials",
      detail: "Dashboard only",
      items: materials.filter((material) => !material.docId),
    },
  ];
  container.innerHTML = groups.map((group) => `
    <section class="upload-material-group" aria-labelledby="${group.id}">
      <div class="upload-material-group-head">
        <h3 id="${group.id}">${group.title}</h3>
        <span>${group.detail}</span>
      </div>
      <div class="upload-material-grid" role="group" aria-labelledby="${group.id}">
        ${group.items.map(renderMaterial).join("")}
      </div>
    </section>`).join("");
  updateOnboardingStart();
}

/** A material selection is enough to enter the workspace. The dashboard load
 * blocks duplicate submits, while its bound PDF continues processing in the
 * background and becomes available as soon as extraction finishes. */
function updateOnboardingStart() {
  const startBtn = document.getElementById("onboardingStartBtn");
  if (!startBtn) return;
  const material = selectedStudyMaterial();
  const summary = document.getElementById("onboardingSelectionSummary");
  startBtn.disabled = !material || dashboardLibraryBusy;
  startBtn.textContent = dashboardLibraryBusy
    ? `Opening ${material?.code || "material"}…`
    : material
      ? `Open Material ${material.code}`
      : "Select a material";
  if (!summary) return;
  if (!material) {
    summary.textContent = "Select a material code to continue.";
    summary.dataset.state = "idle";
    return;
  }
  const prefix = `Material ${material.code} selected.`;
  if (!material.docId) {
    summary.textContent = `${prefix} Dashboard only; no PDF is assigned.`;
    summary.dataset.state = "ready";
  } else if (state.designDoc.status === "error" && activeDesignDocId === material.docId) {
    summary.textContent = `${prefix} The dashboard can open; review the PDF error in the workspace.`;
    summary.dataset.state = "error";
  } else if (state.designDoc.status === "loaded" && activeDesignDocId === material.docId) {
    summary.textContent = `${prefix} Dashboard and PDF are ready.`;
    summary.dataset.state = "ready";
  } else {
    summary.textContent = `${prefix} The dashboard opens now; the PDF will finish in the workspace.`;
    summary.dataset.state = "loading";
  }
}

async function refreshDashboardLibrary({ announce = true } = {}) {
  const requestSerial = ++dashboardLibraryRefreshSerial;
  dashboardLibraryRefreshing = true;
  if (announce) setDashboardLibraryStatus("Refreshing shared dashboards…");
  renderDashboardLibraryControls();
  try {
    const dashboards = await listDashboardLibrary();
    if (requestSerial !== dashboardLibraryRefreshSerial) return;
    dashboardLibraryItems = dashboards;
    if (announce) {
      setDashboardLibraryStatus(
        dashboards.length
          ? `${dashboards.length} shared dashboard${dashboards.length === 1 ? "" : "s"} available.`
          : "No dashboard JSON files were found.",
      );
    }
  } catch (error) {
    if (requestSerial !== dashboardLibraryRefreshSerial) return;
    setDashboardLibraryStatus(`Could not refresh dashboards: ${error.message}`, true);
  } finally {
    if (requestSerial === dashboardLibraryRefreshSerial) {
      dashboardLibraryRefreshing = false;
      renderDashboardLibraryControls();
    }
  }
}

async function loadDashboardLibrarySelection(id, { applyBinding = true } = {}) {
  if (!id) return;
  const previousId = state.artifact.libraryId || "";
  if (state.artifact.source && !window.confirm(
    "Open another dashboard? The current critiques, context, design document, and Working Draft will be cleared.",
  )) {
    renderDashboardLibraryControls();
    return;
  }

  const requestSerial = ++dashboardLibraryLoadSerial;
  dashboardLibraryBusy = true;
  setDashboardLibraryStatus(`Opening ${id}…`);
  renderDashboardLibraryControls();
  try {
    const dashboard = await loadDashboardFromLibrary(id);
    if (requestSerial !== dashboardLibraryLoadSerial) return;
    await loadJsonDashboard(dashboard, `${id}.json`);
    state.artifact.libraryId = id;
    const item = dashboardLibraryItems.find((candidate) => candidate.id === id);
    setDashboardLibraryStatus(`Opened ${item?.title || id}.`);
    // Preset this dashboard's bound design-guideline doc (or clear, if unbound).
    // Skip the re-extract when the bound doc is already active. Study onboarding
    // opts out because its atomic material card has already established the
    // exact dashboard + PDF pair before the dashboard is opened.
    if (applyBinding) {
      const boundDocId = DASHBOARD_DESIGN_DOC_BINDINGS[id] || "";
      if (boundDocId !== activeDesignDocId) void loadDesignDocById(boundDocId);
    }
  } catch (error) {
    if (requestSerial !== dashboardLibraryLoadSerial) return;
    state.artifact.libraryId = previousId;
    setDashboardLibraryStatus(`Could not open ${id}: ${error.message}`, true);
  } finally {
    if (requestSerial === dashboardLibraryLoadSerial) {
      dashboardLibraryBusy = false;
      renderDashboardLibraryControls();
    }
  }
}

function markAIField(fieldName, label = "AI draft · review") {
  const field = ob.form.querySelector(`[data-field="${fieldName}"]`);
  if (!field) return;
  field.classList.add("ai-populated");
}

function fillDraftBrief(values, sourceLabel = "AI draft · review") {
  // Author edits win: only fill a field the author left empty.
  if (!ob.goal.value.trim() && values.goal) ob.goal.value = values.goal;
  if (!ob.audience.value.trim() && values.audience) ob.audience.value = values.audience;
  if (!ob.constraints.value.trim() && values.constraints) ob.constraints.value = values.constraints;
  ["goal", "audience", "constraints"].forEach((field) => markAIField(field, sourceLabel));
}

function applyScaffoldResult(result) {
  const context = result?.context || result;
  rememberGeneratedStudyContext({
    source: "onboarding",
    goal: context.goal,
    audience: context.audience,
    constraints: context.constraints,
  });
  fillDraftBrief(context, result?.source === "llm" ? "generated by LLM · review" : "offline fallback · review");
  obFieldStatus = result?.fieldStatus || {
    goal: context.goal ? "inferred" : "missing",
    audience: context.audience ? "inferred" : "missing",
    constraints: context.constraints ? "inferred" : "missing",
  };
  obContextSnapshotId = result?.contextSnapshotId || null;
}

async function requestScaffold(rawText, mode, requireLLM = true) {
  const payload = {
    rawText,
    mode,
    requireLLM,
    dashboard: {
      title: state.dashboardTitle,
      tileTitles: state.tiles.map((tile) => tile.label || tile.title),
      visibleMetrics: state.tiles.map((tile) => tile.label || tile.title),
    },
    specMap: buildEngineSpecMap(),
    board: buildEngineBoardMeta(),
  };

  console.log("=== Scaffold Request ===");
  console.log("Dashboard title:", payload.dashboard.title);
  console.log("Tile titles:", payload.dashboard.tileTitles);
  console.log("Board meta:", payload.board);
  console.log("Spec map keys:", Object.keys(payload.specMap));
  return structureBrief(payload);
}

function applyScaffoldToWorkspace(result) {
  // The workspace context is one description, so the scaffold's goal + audience
  // collapse into a single paragraph stored in `goal`; audience/constraints stay
  // empty (kept only so the engine contract keeps its field shape).
  const description = inferredContextDescription(result?.context || {});
  rememberGeneratedStudyContext({
    source: "upload",
    text: description,
    goal: result?.context?.goal,
    audience: result?.context?.audience,
  });
  state.context = {
    ...state.context,
    goal: description,
    audience: "",
    constraints: "",
    // dashboardType is a discrete genre lens (not part of the free-text
    // description); keep the inferred value so reviewContextForEngine() forwards
    // it to the engine.
    dashboardType: result?.context?.dashboardType || state.context.dashboardType,
    fieldStatus: {
      goal: description ? "inferred" : "missing",
      audience: "missing",
      constraints: "missing",
    },
    snapshotId: result?.contextSnapshotId || null,
  };
  renderFixedContextPanel();
  renderContextToolState();
}

async function inferContextOnUpload() {
  const requestSerial = (state.contextWorkflow.requestSerial || 0) + 1;
  setContextWorkflow(CONTEXT_WORKFLOW_STATUS.GENERATING, { requestSerial });
  renderFixedContextPanel();
  try {
    const result = await withContextGenerationTelemetry("upload", () =>
      requestScaffold("", "dashboard-draft", true));
    if (state.contextWorkflow.requestSerial !== requestSerial) return;
    setContextWorkflow(CONTEXT_WORKFLOW_STATUS.NEEDS_REVIEW, {
      requestSerial,
      detail: "Edit if needed, then confirm.",
    });
    applyScaffoldToWorkspace(result);
  } catch (error) {
    if (state.contextWorkflow.requestSerial !== requestSerial) return;
    // Review remains available: artifact-only criteria can still be evaluated.
    console.warn("[context inference] Goal/Audience unavailable; continuing with artifact-only review", error);
    const message = error instanceof Error ? error.message : String(error);
    setContextWorkflow(CONTEXT_WORKFLOW_STATUS.ERROR, {
      requestSerial,
      error: `Context inference failed: ${message.replace(/^LLM_CALL_FAILED:\s*/, "")}`,
    });
    renderFixedContextPanel();
  }
}

function showBriefError(error) {
  const message = error instanceof Error ? error.message : String(error);
  ob.error.textContent = message.includes("LLM_REQUIRED")
    ? "A model connection is required for this assistive action. Configure the active provider and restart the backend."
    : `Context generation failed: ${message.replace(/^LLM_CALL_FAILED:\s*/, "")}`;
  ob.error.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Design-document upload control (shared by onboarding + workspace).  */
/* The same markup + handlers render in the onboarding split-screen and*/
/* in the persistent workspace context panel, so the control is present*/
/* however a dashboard is opened. State lives on state.designDoc /      */
/* state.constraintSet; the last picked File is kept so an edited note  */
/* can be re-applied without re-choosing the file.                     */
/* ------------------------------------------------------------------ */

let lastDesignDocFile = null;
// The design-rules review popup traps Escape while open; this holds its handler
// so closeConstraintReview can detach it. null when the popup is closed.
let constraintReviewKeydown = null;

/** Markup for one design-doc control. `scope` ("onboarding" | "workspace")
 * distinguishes the two instances that may coexist while onboarding is mounted
 * over the workspace, so ids stay unique; behavior is class-driven. */
function designDocControlMarkup(scope) {
  const inputId = `designDocInput-${scope}`;
  const noteId = `designDocNote-${scope}`;
  // Upload and the optional steering note live in ONE bordered field: attach a
  // document on the left, then add a note beside it. The note stays disabled
  // until a document is loaded, so it reads as a post-upload add-on.
  return `
    <div class="form-group design-doc-control" data-doc-scope="${scope}">
      <div class="field-label-row">
        <div class="context-memory-title">
          <label for="${inputId}">Design Document</label>
          <button type="button" class="context-help" aria-label="About Design Document" data-help="Upload brand guidelines or a design best-practices document (PDF or text). VIZier extracts actionable rules for you to review, then hides suggestions that would break the rules you keep. Add a note to steer extraction — e.g. “find the dashboard checklist rules” or “use the color palette in here.”">i</button>
        </div>
        <span class="optional-label">Optional</span>
      </div>
      <div class="doc-uploader" data-state="idle">
        <input type="file" id="${inputId}" class="design-doc-input visually-hidden" accept="${ACCEPTED_DESIGN_DOC}" />
        <button type="button" class="doc-uploader-attach design-doc-browse" aria-label="Choose a design document">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8.5 12.4 17a3.5 3.5 0 0 1-5-5l8-8a2.3 2.3 0 0 1 3.3 3.3l-7.9 7.9a1.1 1.1 0 0 1-1.6-1.6l7.4-7.3"/></svg>
        </button>
        <div class="doc-uploader-main">
          <span class="doc-file-chip" hidden><span class="doc-file-name"></span></span>
          <input type="text" id="${noteId}" class="design-doc-note doc-note-input" disabled placeholder="Attach a document to add a note…" aria-label="Note to steer what VIZier treats as a hard rule" />
        </div>
        <button type="button" class="doc-note-apply design-doc-reapply" hidden>Apply</button>
        <button type="button" class="doc-uploader-clear design-doc-clear" hidden aria-label="Remove document">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="design-doc-status" role="status" aria-live="polite" hidden></div>
    </div>`;
}

/** Every design-doc control currently in the DOM (0–2 of them). */
function designDocControls() {
  return [...document.querySelectorAll(".design-doc-control")];
}

/** Reflect state.designDoc / state.constraintSet in every mounted control. */
function renderDesignDocStatus() {
  const { status, filename, error, note } = state.designDoc;
  const hasDoc = status === "loaded" || status === "loading" || status === "error";
  designDocControls().forEach((root) => {
    const uploader = root.querySelector(".doc-uploader");
    const statusEl = root.querySelector(".design-doc-status");
    const clearBtn = root.querySelector(".design-doc-clear");
    const applyBtn = root.querySelector(".design-doc-reapply");
    const browseBtn = root.querySelector(".design-doc-browse");
    const noteEl = root.querySelector(".design-doc-note");
    const chip = root.querySelector(".doc-file-chip");
    const chipName = root.querySelector(".doc-file-name");
    if (uploader) uploader.dataset.state = status;
    if (chip) chip.hidden = !hasDoc || !filename;
    if (chipName && filename) chipName.textContent = filename;
    if (noteEl) {
      if (document.activeElement !== noteEl && noteEl.value !== (note || "")) noteEl.value = note || "";
      // The note is a post-upload add-on: only editable once a document loads.
      noteEl.disabled = status !== "loaded";
      noteEl.placeholder = status === "loaded"
        ? "Steer extraction — e.g. find the dashboard checklist rules"
        : status === "loading"
          ? "Reading the document…"
          : "Attach a document to add a note…";
    }
    if (statusEl) {
      statusEl.dataset.state = status;
      if (status === "loading") {
        statusEl.textContent = `Reading ${filename || "document"}…`;
        statusEl.hidden = false;
      } else if (status === "error") {
        statusEl.textContent = error || "Could not read that document.";
        statusEl.hidden = false;
      } else if (status === "loaded") {
        statusEl.innerHTML = constraintStatusMarkup();
        statusEl.hidden = false;
      } else {
        statusEl.textContent = "";
        statusEl.hidden = true;
      }
    }
    if (clearBtn) clearBtn.hidden = !hasDoc;
    // "Apply" re-runs extraction with the edited note; only meaningful once
    // loaded. It grays out while the note matches what was last applied, so a
    // repeat click on unchanged input is a visible no-op rather than a silent one.
    if (applyBtn) {
      applyBtn.hidden = !(status === "loaded" && lastDesignDocFile);
      applyBtn.disabled = (note || "") === (state.designDoc.appliedNote || "");
    }
    if (browseBtn) browseBtn.disabled = status === "loading";
  });
  // Doc status gates context confirmation and review readiness (issue: confirm
  // must be blocked while the document is being read). The workspace controls
  // exist even during onboarding, so this is safe to call unconditionally.
  updateContextWorkflowControls();
  // The selected material card mirrors the PDF load state during onboarding.
  renderDashboardCards();
}

function clearDesignDoc() {
  lastDesignDocFile = null;
  activeDesignDocId = "";
  state.constraintSet = null;
  state.constraintSelection = null;
  closeConstraintReview();
  state.designDoc = { status: "idle", filename: "", error: "", note: "", text: "" };
  designDocControls().forEach((root) => {
    const input = root.querySelector(".design-doc-input");
    if (input) input.value = "";
  });
  renderDesignDocLibraryControl();
  renderDesignDocStatus();
}

/** Populate + sync the topbar design-doc dropdown from DESIGN_DOC_LIBRARY. */
function renderDesignDocLibraryControl() {
  const select = document.getElementById("designDocLibrarySelect");
  if (!select) return;
  const options = DESIGN_DOC_LIBRARY
    .map((doc) => `<option value="${escapeHTML(doc.id)}">${escapeHTML(doc.label)}</option>`)
    .join("");
  select.innerHTML = `<option value="">No design document</option>${options}`;
  // A manual upload isn't in the library, so it maps to "" (No design document).
  select.value = DESIGN_DOC_LIBRARY.some((doc) => doc.id === activeDesignDocId) ? activeDesignDocId : "";
  select.disabled = designDocLibraryBusy;
  select.setAttribute("aria-busy", String(designDocLibraryBusy));
}

/** Load a bundled design-guideline doc by library id and run it through the same
 * intake path as an upload. "" clears the design document. */
async function loadDesignDocById(docId) {
  const serial = ++designDocLoadSerial;
  if (!docId) {
    clearDesignDoc(); // resets activeDesignDocId + selects "No design document"
    return;
  }
  const doc = DESIGN_DOC_LIBRARY.find((candidate) => candidate.id === docId);
  if (!doc) return;
  activeDesignDocId = docId;
  designDocLibraryBusy = true;
  renderDesignDocLibraryControl();
  renderDashboardCards();
  try {
    const res = await fetch(doc.url || `/pdfs/${encodeURIComponent(doc.file)}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const blob = await res.blob();
    if (serial !== designDocLoadSerial) return; // a newer selection superseded this
    const file = new File([blob], doc.file, { type: "application/pdf" });
    await handleDesignDoc(file); // extracts text, calls /intake-constraints, sets state + chip
  } catch (error) {
    if (serial !== designDocLoadSerial) return;
    const message = error instanceof Error ? error.message : String(error);
    state.constraintSet = null;
    state.constraintSelection = null;
    state.designDoc = {
      status: "error",
      filename: doc.file,
      note: state.designDoc.note || "",
      text: "",
      error: `Could not load the bundled design document: ${message}`,
    };
    renderDesignDocStatus();
  } finally {
    if (serial === designDocLoadSerial) {
      designDocLibraryBusy = false;
      renderDesignDocLibraryControl();
      renderDashboardCards();
    }
  }
}

/** Record the author's steering note (shared across both controls). */
function setDesignDocNote(note) {
  state.designDoc = { ...state.designDoc, note: String(note ?? "") };
  // Enable Apply the moment the note diverges from the last-applied one (and
  // disable it again when the author types back to that value).
  const unapplied = state.designDoc.note !== (state.designDoc.appliedNote || "");
  // Mirror into the other control without a full re-render (keeps caret).
  designDocControls().forEach((root) => {
    const noteEl = root.querySelector(".design-doc-note");
    if (noteEl && document.activeElement !== noteEl && noteEl.value !== state.designDoc.note) {
      noteEl.value = state.designDoc.note;
    }
    const applyBtn = root.querySelector(".design-doc-reapply");
    if (applyBtn && state.designDoc.status === "loaded") applyBtn.disabled = !unapplied;
  });
}

/** Extract text from an uploaded design document, ask the backend to parse it
 * into hard constraints (steered by the optional note), and store the result.
 * Independent of the goal/audience scaffold path so it never perturbs the
 * context snapshot. */
async function handleDesignDoc(file) {
  if (!file) return;
  const note = state.designDoc.note || "";
  if (!isSupportedDesignDoc(file)) {
    lastDesignDocFile = null;
    state.designDoc = { status: "error", filename: file.name || "", error: "Upload a PDF or text document.", note };
    renderDesignDocStatus();
    return;
  }
  lastDesignDocFile = file;
  state.designDoc = { status: "loading", filename: file.name || "", error: "", note };
  renderDesignDocStatus();
  try {
    const extracted = await extractDesignDocText(file);
    const source = buildConstraintSource({
      text: extracted.text,
      filename: extracted.filename || file.name,
      pageCount: extracted.pageCount,
      kind: "pdf-text",
      note,
    });
    if (!source.text.trim()) {
      throw new Error("No readable text found in that document.");
    }
    const result = await extractConstraints({ source, requireLLM: true });
    state.constraintSet = result?.constraintSet || null;
    // Freshly extracted candidates remain inactive until the author confirms
    // them in the review popup. Cancel / Escape therefore never applies rules.
    state.constraintSelection = state.constraintSet ? [] : null;
    // Record the note this extraction ran with: Apply stays disabled until the
    // author changes the note (or uploads a new file), so a second identical
    // click can't re-run a no-op.
    state.designDoc = { status: "loaded", filename: file.name || "", error: "", note, appliedNote: note, text: String(extracted.text || "").slice(0, 40000) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.constraintSet = null;
    state.constraintSelection = null;
    state.designDoc = {
      status: "error",
      filename: file.name || "",
      note,
      text: "",
      error: message.includes("LLM_REQUIRED")
        ? "A model connection is required to read the design document. Configure the provider and restart the backend."
        : `Could not read the design document: ${message.replace(/^LLM_CALL_FAILED:\s*/, "")}`,
    };
  }
  renderDesignDocStatus();
  // Once rules load, surface the review popup so the author confirms (default all
  // checked) or drops any before they take effect as hard constraints. Suppressed
  // while the onboarding picker is still mounted — the popup would cover it; the
  // rules stay reviewable via the workspace control's "Review rules" link.
  if (
    state.designDoc.status === "loaded" &&
    state.constraintSet?.constraints?.length &&
    !document.getElementById("uploadScreen")
  ) {
    openConstraintReview({ selectAllByDefault: true });
  }
}

/** Wire a design-doc control's buttons/inputs. Safe to call repeatedly on a
 * freshly rendered root (the workspace panel re-renders often); a data flag
 * prevents double-binding the same node. */
function attachDesignDocListeners(root) {
  if (!root || root.dataset.docWired === "1") return;
  root.dataset.docWired = "1";
  const input = root.querySelector(".design-doc-input");
  const browse = root.querySelector(".design-doc-browse");
  const clear = root.querySelector(".design-doc-clear");
  const reapply = root.querySelector(".design-doc-reapply");
  const noteEl = root.querySelector(".design-doc-note");
  const status = root.querySelector(".design-doc-status");
  // The "Review rules" link is re-rendered inside the status on every state
  // change, so delegate from the stable status element that persists.
  if (status) status.addEventListener("click", (e) => {
    if (e.target.closest("[data-rules-review]")) openConstraintReview();
  });
  if (browse && input) browse.addEventListener("click", () => input.click());
  if (input) input.addEventListener("change", (e) => {
    // A manual upload isn't a library doc — deselect the preset dropdown.
    activeDesignDocId = "";
    renderDesignDocLibraryControl();
    void handleDesignDoc(e.target.files[0]);
  });
  if (clear) clear.addEventListener("click", clearDesignDoc);
  if (reapply) reapply.addEventListener("click", () => { if (lastDesignDocFile) void handleDesignDoc(lastDesignDocFile); });
  if (noteEl) {
    noteEl.addEventListener("input", (e) => setDesignDocNote(e.target.value));
    noteEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (lastDesignDocFile) void handleDesignDoc(lastDesignDocFile); }
    });
  }
}

/** Attach + refresh every mounted design-doc control. */
function refreshDesignDocControls() {
  designDocControls().forEach(attachDesignDocListeners);
  renderDesignDocStatus();
}

/* ------------------------------------------------------------------ *
 * Design-rules review popup
 *
 * Extracted hard constraints reach the critique's silent conflict filter
 * only through the rules the author keeps here. state.constraintSelection
 * holds the kept rule ids (null = all active, the default on a fresh load);
 * effectiveConstraintSet() is what the two critique call-sites actually send.
 * ------------------------------------------------------------------ */

/** The active subset of the loaded ConstraintSet, or null when nothing is
 * loaded or every rule was unchecked. Returns a fresh set narrowed to the kept
 * ids so the engine only filters suggestions against rules the author kept. */
function effectiveConstraintSet() {
  const set = state.constraintSet;
  if (!set || !Array.isArray(set.constraints) || !set.constraints.length) return null;
  // null selection = every rule active (the default until the author curates).
  if (state.constraintSelection === null) return set;
  const keep = new Set(state.constraintSelection);
  const constraints = set.constraints.filter((c) => keep.has(c.id));
  if (!constraints.length) return null;
  return { ...set, constraints };
}

/** How many loaded rules are currently active (kept). */
function effectiveConstraintCount() {
  const active = effectiveConstraintSet();
  return active ? active.constraints.length : 0;
}

/** Compact loaded-status text plus a link that reopens the review popup. */
function constraintStatusMarkup() {
  const set = state.constraintSet;
  const total = set && Array.isArray(set.constraints) ? set.constraints.length : 0;
  if (!total) {
    const where = set?.provenance ? ` in ${set.provenance}` : "";
    return escapeHTML(`No actionable rules found${where}. Add a specific note, then Apply to try again.`);
  }
  const active = effectiveConstraintCount();
  const label = active === total
    ? `${total} design rule${total === 1 ? "" : "s"} loaded.`
    : `${active} of ${total} design rules active.`;
  return `<span class="design-doc-status-label">${escapeHTML(label)}</span>`
    + `<button type="button" class="design-doc-review-link" data-rules-review>Review Rules</button>`;
}

/** One selectable rule row for the review popup. */
function constraintReviewRowMarkup(constraint, checked) {
  const rule = escapeHTML(constraint.rule || constraint.sourceText || "Untitled rule");
  const category = constraint.category ? escapeHTML(constraint.category) : "";
  const rawSource = typeof constraint.sourceText === "string" ? constraint.sourceText.trim() : "";
  // Show the original quote only when it adds something beyond the human phrasing.
  const source = rawSource && rawSource !== (constraint.rule || "").trim()
    ? (rawSource.length > 160 ? `${rawSource.slice(0, 159)}…` : rawSource)
    : "";
  return `
    <label class="constraint-row${checked ? "" : " is-off"}" data-cr-row>
      <input type="checkbox" class="constraint-check" data-cr-id="${escapeHTML(constraint.id)}" ${checked ? "checked" : ""} />
      <span class="constraint-row-body">
        <span class="constraint-row-head">
          <span class="constraint-rule">${rule}</span>
          ${category ? `<span class="constraint-cat">${category}</span>` : ""}
        </span>
        ${source ? `<span class="constraint-source">${escapeHTML(source)}</span>` : ""}
      </span>
    </label>`;
}

/** Open the design-rules review popup. Edits live on a DRAFT set and only
 * commit to state.constraintSelection on confirm, so Cancel / Escape / scrim
 * leave the active rules untouched. No-op when no rules are loaded. */
function openConstraintReview({ selectAllByDefault = false } = {}) {
  const set = state.constraintSet;
  if (!set || !Array.isArray(set.constraints) || !set.constraints.length) return;
  closeConstraintReview();
  const rules = set.constraints;
  const draft = new Set(
    selectAllByDefault || state.constraintSelection === null
      ? rules.map((c) => c.id)
      : state.constraintSelection,
  );
  const total = rules.length;

  const overlay = document.createElement("div");
  overlay.className = "constraint-review";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Review design rules");
  const provenance = set.provenance ? escapeHTML(set.provenance) : "your design document";
  overlay.innerHTML = `
    <div class="constraint-review-scrim" data-cr-dismiss></div>
    <div class="constraint-review-card" role="document">
      <header class="constraint-review-head">
        <div class="constraint-review-heading">
          <h2>Review design rules</h2>
          <p class="constraint-review-sub">Uncheck any rule you don't want enforced. Kept rules hide suggestions that would break them.</p>
          <p class="constraint-review-source">${total} rule${total === 1 ? "" : "s"} from ${provenance}</p>
        </div>
        <button type="button" class="constraint-review-close" data-cr-dismiss aria-label="Close without changing rules">×</button>
      </header>
      <div class="constraint-review-toolbar">
        <span class="constraint-review-count" data-cr-count></span>
        <span class="constraint-review-bulk">
          <button type="button" class="link-button" data-cr-all>Select all</button>
          <span class="constraint-review-bulk-sep" aria-hidden="true">·</span>
          <button type="button" class="link-button" data-cr-none>Clear all</button>
        </span>
      </div>
      <div class="constraint-review-list">
        ${rules.map((c) => constraintReviewRowMarkup(c, draft.has(c.id))).join("")}
      </div>
      <footer class="constraint-review-actions">
        <button type="button" class="button" data-cr-dismiss>Cancel</button>
        <button type="button" class="button primary" data-cr-confirm></button>
      </footer>
    </div>`;

  const countEl = overlay.querySelector("[data-cr-count]");
  const confirmBtn = overlay.querySelector("[data-cr-confirm]");
  const syncSummary = () => {
    const n = draft.size;
    if (countEl) countEl.textContent = `${n} of ${total} selected`;
    if (confirmBtn) {
      confirmBtn.textContent = n
        ? `Use ${n} rule${n === 1 ? "" : "s"} to filter suggestions`
        : "Continue without rules";
    }
  };
  syncSummary();

  overlay.querySelectorAll(".constraint-check").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) draft.add(box.dataset.crId);
      else draft.delete(box.dataset.crId);
      box.closest("[data-cr-row]")?.classList.toggle("is-off", !box.checked);
      syncSummary();
    });
  });
  const setAll = (on) => {
    overlay.querySelectorAll(".constraint-check").forEach((box) => {
      box.checked = on;
      if (on) draft.add(box.dataset.crId);
      else draft.delete(box.dataset.crId);
      box.closest("[data-cr-row]")?.classList.toggle("is-off", !on);
    });
    syncSummary();
  };
  overlay.querySelector("[data-cr-all]")?.addEventListener("click", () => setAll(true));
  overlay.querySelector("[data-cr-none]")?.addEventListener("click", () => setAll(false));
  overlay.querySelectorAll("[data-cr-dismiss]").forEach((node) => {
    node.addEventListener("click", closeConstraintReview);
  });
  confirmBtn?.addEventListener("click", () => {
    // Store null when every rule is kept (canonical "all active"); otherwise the
    // kept ids in original rule order.
    const kept = rules.map((c) => c.id).filter((id) => draft.has(id));
    state.constraintSelection = kept.length === total ? null : kept;
    closeConstraintReview();
    renderDesignDocStatus();
  });

  // During onboarding, mount inside the opaque upload screen so the dialog sits
  // above it instead of behind its higher page-level stacking context.
  const onboarding = document.getElementById("uploadScreen");
  (onboarding?.isConnected ? onboarding : document.body).appendChild(overlay);
  constraintReviewKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeConstraintReview();
    }
  };
  document.addEventListener("keydown", constraintReviewKeydown, true);
  confirmBtn?.focus();
}

/** Dismiss the review popup without committing (used by Cancel / scrim / Escape
 * and whenever the loaded document is cleared). */
function closeConstraintReview() {
  document.querySelector(".constraint-review")?.remove();
  if (constraintReviewKeydown) {
    document.removeEventListener("keydown", constraintReviewKeydown, true);
    constraintReviewKeydown = null;
  }
}

function clearBriefError() {
  ob.error.hidden = true;
  ob.error.textContent = "";
}

function inferBrief(rawText = "") {
  const raw = rawText.trim();
  const sentences = raw.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const audienceSentence = sentences.find((s) => /audience|for\s+(the\s+)?(pmo|executive|leader|manager|team|client|stakeholder|analyst)/i.test(s));
  const decisionSentence = sentences.find((s) => /need|decid|spot|identify|monitor|track|help|action|risk/i.test(s));
  const constraintSentences = sentences.filter((s) => /must|keep|constraint|brand|wall|mobile|weekly|export|accessib|deadline|avoid/i.test(s));
  return {
    goal: decisionSentence || "Help delivery leaders identify which teams and projects need intervention before the next planning cycle.",
    audience: audienceSentence || "PMO partners and engineering leads who review delivery health weekly.",
    constraints: constraintSentences.join(" ") || "Preserve the navy brand palette and support quick scanning during weekly reviews.",
  };
}

function obClearPreview() {
  if (obImageURL) URL.revokeObjectURL(obImageURL);
  obImageURL = null;
  ob.file.value = "";
  ob.preview.hidden = true;
  ob.dropzone.hidden = false;
}

async function loadJsonDashboard(data, fileName = "dashboard.json") {
  // True only when a dashboard was already open — i.e. this load is a SWITCH,
  // not the first-run load. Captured before state.artifact is overwritten below.
  // Guards the design-doc clear so a doc attached during onboarding survives the
  // initial dashboard load but is dropped when the author switches dashboards.
  const switchingDashboard = Boolean(state.artifact && state.artifact.source);
  const normalized = normalizeDashboardDocument(data, fileName);
  state.dashboardTitle = normalized.dashboard.title;
  state.dashboardSubtitle = normalized.dashboard.subtitle;
  state.showKpis = normalized.dashboard.hasKpis;
  state.hasEmbeddedKpis = Boolean(normalized.dashboard.hasEmbeddedKpis);
  // A freshly loaded dashboard has no engine-computed KPIs yet; an add-kpis
  // proposal populates this with real values from the dashboard's own data.
  state.boardKpis = Array.isArray(normalized.dashboard.kpis) ? normalized.dashboard.kpis : [];
  state.boardKpiStyle = normalized.dashboard.kpiStyle || null;
  state.boardKpiPresentation = {
    layout: normalized.dashboard.kpiLayout || "inline-summary",
    alignment: normalized.dashboard.kpiAlignment || "start",
    density: normalized.dashboard.kpiDensity || "balanced",
    chrome: normalized.dashboard.kpiChrome || "plain",
    reservedHeight: Number(normalized.dashboard.kpiReservedHeight) || 0,
    reservedWidth: Number(normalized.dashboard.kpiReservedWidth) || 0,
  };
  state.dashboardFilters = Array.isArray(normalized.dashboard.filters) ? clone(normalized.dashboard.filters) : [];
  state.showChartSubtitles = normalized.dashboard.showChartSubtitles;
  state.canvasSize = {
    width: normalized.dashboard.canvasWidth,
    height: normalized.dashboard.canvasHeight,
  };
  state.tiles = normalized.tiles;
  state.artifact = {
    id: normalized.dashboard.id,
    source: "uploaded-json",
    imageUrl: null,
    hasExecutableSpecs: true,
    initial: clone(normalized),
  };
  state.context = {
    goal: "",
    audience: "",
    constraints: "",
    scope: [...DEFAULT_FEEDBACK_SCOPE],
    customTypes: [],
    notes: [],
    fieldStatus: { goal: "missing", audience: "missing", constraints: "missing" },
    snapshotId: null,
  };
  state.studyContextGenerated = null;
  state.contextWorkflow = createContextWorkflow(CONTEXT_WORKFLOW_STATUS.IDLE, {
    requestSerial: state.contextWorkflow.requestSerial,
  });
  state.previewCache.clear();
  state.canvasPreview = null;
  // A newly loaded dashboard was never put into batch mode — clear it so the
  // bottom bar, checkboxes, and toggle state don't leak across the load.
  resetBatchState();
  state.critiques = [];
  state.critiqueRefreshNotice = null;
  state.strengths = [];
  state.nextAskId = 1;
  state.askAnswer = null;
  state.lastReviewContextFingerprint = null;
  state.selectedCritiqueId = null;
  state.selectedTileId = null;
  state.version = 1;
  const baselineSnapshot = {
    specMap: buildEngineSpecMap(),
    board: buildEngineBoardMeta(),
  };
  state.versions = [{
    id: 1,
    kind: "initial",
    label: "Checkpoint 1 · Original Dashboard",
    note: "Starting Point",
    afterSnapshot: clone(baselineSnapshot),
  }];
  state.checkpointComparison = { before: 1, after: 1 };
  state.workingDraft = createWorkingDraft(1);
  state.rationales = [];
  state.nextRationaleId = 1;
  state.rationaleEditId = null;
  // A loaded dashboard can ship with cross-filter already wired (a tile stamped
  // usermeta.crossFilter.role === "source"). Enable the runtime on load so the
  // baked-in "click a source mark → filter the related tiles" behavior is live
  // immediately — mirrors the post-apply enable in commitAppliedCritiques.
  const restoredInteraction = normalized.dashboard.interactionState || {};
  state.crossFilterEnabled = typeof restoredInteraction.crossFilterEnabled === "boolean"
    ? restoredInteraction.crossFilterEnabled
    : state.tiles.some((tile) => tile.spec?.usermeta?.crossFilter?.role === "source");
  state.activeFilterState = typeof restoredInteraction.activeFilterState === "boolean"
    ? restoredInteraction.activeFilterState
    : state.tiles.some((tile) => tile.spec?.usermeta?.activeFilterState);
  state.crossFilterSelection = restoredInteraction.crossFilterSelection
    ? clone(restoredInteraction.crossFilterSelection)
    : null;
  state.interactionObservations.clear();
  resetInteractionMemory();
  // Re-selecting a dashboard must fully refresh the workspace — no view state
  // from the previous dashboard may leak. Mirror resetDemo()'s working-state
  // clear so the search query, focused-review request, criterion coverage, and
  // transient panels all reset to the freshly opened dashboard.
  state.criterionEvaluations = [];
  state.reviewScope = "full";
  state.reviewRequest = "";
  state.focusedReviewRunning = false;
  state.reviewInFlight = false;
  state.search = "";
  state.expandedCritiqueGroups = {};
  state.localReviewDraft = null;
  state.localReviewSubmitting = false;
  state.drawers = { versions: false, history: false };
  state.sidebarPopover = null;
  state.pinnedSidebarComponent = null;

  ob.root.classList.add("leaving");
  setTimeout(() => ob.root.remove(), 220);
  renderCanvasPreviewControl();
  renderDashboardChrome();
  await renderTiles();
  // Reveal the standing cross-filter affordance for dashboards that ship with it.
  await rememberDashboardExport(state.versions[0]);
  renderMarkers();
  renderCritiques();
  renderInspector();
  renderVersions();
  renderWorkingDraftStatus();
  // Re-sync the surfaces resetDemo() also refreshes but the load path skipped:
  // the search box DOM, any open popover / modal / focus mode, sidebar
  // components, context notes + tool state, and criterion coverage.
  if (els.searchInput) els.searchInput.value = "";
  setMode("review");
  closeLocalReviewPopover();
  closeContextModal();
  syncSidebarComponents();
  renderContextNotes();
  renderContextToolState();
  renderRubrics();
  // A re-selected dashboard starts from zero — drop the previous dashboard's
  // design document and the hard constraints extracted from it, so old brand
  // rules never silently gate the new dashboard's review. Only on a switch: a
  // doc attached during first-run onboarding must survive the initial load.
  if (switchingDashboard) clearDesignDoc();
  void inferContextOnUpload();
  requestAnimationFrame(fitCanvas);
}

async function obHandleFile(fileObj) {
  if (!fileObj) return;

  // Handle JSON dashboard files
  if (fileObj.name.endsWith('.json') || fileObj.type === 'application/json') {
    try {
      const text = await fileObj.text();
      const data = JSON.parse(text);
      await loadJsonDashboard(data, fileObj.name);
      return;
    } catch (error) {
      alert(`Failed to load dashboard JSON: ${error.message}`);
      return;
    }
  }

  // Handle image files - skip scaffold, go to workspace
  if (obImageURL) URL.revokeObjectURL(obImageURL);
  obImageURL = fileObj.type.startsWith("image/") ? URL.createObjectURL(fileObj) : null;

  // Store the image for the workspace
  state.artifact.imageUrl = obImageURL;
  state.artifact.source = "uploaded-image";
  state.context = {
    goal: "",
    audience: "",
    constraints: "",
    scope: [...DEFAULT_FEEDBACK_SCOPE],
    customTypes: [],
    notes: [],
    fieldStatus: { goal: "missing", audience: "missing", constraints: "missing" },
    snapshotId: null,
  };
  state.studyContextGenerated = null;
  setContextWorkflow(CONTEXT_WORKFLOW_STATUS.NEEDS_REVIEW, {
    detail: "This image does not expose structured dashboard evidence for automatic context inference. Add what you know, or explicitly continue without context.",
  });
  renderFixedContextPanel();

  // Go directly to workspace
  ob.root.classList.add("leaving");
  setTimeout(() => ob.root.remove(), 220);
  requestAnimationFrame(fitCanvas);
}

function obRenderCustomTypes() {
  ob.customList.innerHTML = obCustomTypes.map((label, index) => {
    const presentation = customScopePresentation(label);
    return `
      <span class="custom-type-tag" style="--scope-color:${presentation.color};--scope-soft:${presentation.soft}">
        <input type="checkbox" name="customFeedbackScope" data-custom-scope-label="${escapeHTML(label)}" checked aria-label="Include ${escapeHTML(label)} scope" />
        <span>${escapeHTML(label)}</span>
        <button type="button" class="remove-custom-type" data-i="${index}" aria-label="Remove ${escapeHTML(label)} scope">×</button>
      </span>`;
  }).join("");
  ob.customList.querySelectorAll(".remove-custom-type").forEach((el) =>
    el.addEventListener("click", () => { obCustomTypes.splice(Number(el.dataset.i), 1); obRenderCustomTypes(); }));
}

// Finish onboarding: persist the brief into state, sync it into the on-demand
// context panel, then reveal the workspace (which is already rendered beneath).
function enterWorkspace() {
  // Defensive cleanup for keyboard/programmatic submission while the candidate
  // rule dialog is open; removes its capture-phase Escape listener with the UI.
  closeConstraintReview();
  // The onboarding form collects goal / audience / constraints separately, but
  // the workspace context is ONE description. Fold the three into a single
  // paragraph stored in `goal` (the field the workspace box round-trips) so the
  // confirmed fingerprint stays in sync with what the box parses back to —
  // otherwise the first focused review would silently collapse the box, change
  // the fingerprint, and dead-end the panel (confirmed yet not review-ready).
  const description = serializeContextBox({
    goal: ob.goal.value,
    audience: ob.audience.value,
    constraints: ob.constraints.value,
  });
  const selectedCustomScopes = [...ob.form.querySelectorAll('input[name="customFeedbackScope"]:checked')]
    .map((input) => customScopeKey(input.dataset.customScopeLabel));
  const selectedStandardScopes = [...ob.form.querySelectorAll('input[name="feedbackScope"]:checked')]
    .map((input) => input.value);
  if (selectedStandardScopes.length === 0 && selectedCustomScopes.length === 0) {
    ob.error.textContent = "Choose at least one review scope before continuing.";
    ob.error.hidden = false;
    ob.form.querySelector('input[name="feedbackScope"]')?.focus();
    return;
  }
  state.context.goal = description;
  state.context.audience = "";
  state.context.constraints = "";
  state.context.scope = [
    ...selectedStandardScopes,
    ...selectedCustomScopes,
  ];
  state.context.customTypes = [...obCustomTypes];
  state.context.fieldStatus = {
    goal: description ? "confirmed" : "missing",
    audience: "missing",
    constraints: "missing",
  };
  state.context.snapshotId = null;
  setContextWorkflow(CONTEXT_WORKFLOW_STATUS.CONFIRMED);
  const submittedFields = {
    goal: String(ob.goal.value || "").trim(),
    audience: String(ob.audience.value || "").trim(),
    constraints: String(ob.constraints.value || "").trim(),
  };
  const generated = state.studyContextGenerated;
  appendInteractionEvent({
    kind: "context_saved",
    summary: "Confirmed onboarding dashboard context",
    detail: description
      ? `Context: ${description}`
      : "Confirmed an artifact-only review without additional context",
    data: withContextSaveStudyFields(contextSavedStudyData({
      submittedText: description,
      submittedFields,
      generatedFields: generated
        ? { goal: generated.goal, audience: generated.audience, constraints: generated.constraints }
        : null,
    })),
  });
  renderFixedContextPanel();
  renderContextToolState();
  ob.root.classList.add("leaving");
  setTimeout(() => ob.root.remove(), 220);
  requestAnimationFrame(fitCanvas);
}

// Study cards are atomic dashboard + PDF bundles. Selecting one begins loading
// its bound design document immediately, but never blocks entry: Start Review
// opens the dashboard while PDF extraction continues in the workspace.
const onboardingDashboardCards = document.getElementById("onboardingDashboardCards");
if (onboardingDashboardCards) {
  onboardingDashboardCards.addEventListener("click", (e) => {
    const card = e.target.closest(".upload-card[data-dashboard-id]");
    if (!card || card.disabled) return;
    onboardingDashboardSelection = card.dataset.dashboardId || "";
    renderDashboardCards();
    const material = selectedStudyMaterial();
    if (!material) return;
    const documentAlreadyReady = material.docId
      && material.docId === activeDesignDocId
      && state.designDoc.status === "loaded";
    if (!documentAlreadyReady) void loadDesignDocById(material.docId);
  });
}
const onboardingStartBtn = document.getElementById("onboardingStartBtn");
if (onboardingStartBtn) {
  onboardingStartBtn.addEventListener("click", () => {
    if (!onboardingDashboardSelection) return;
    // The card already established the exact protocol binding.
    void loadDashboardLibrarySelection(onboardingDashboardSelection, { applyBinding: false });
  });
}
ob.confirm.addEventListener("click", () => {
  ob.center.hidden = true;
  ob.split.hidden = false;
  ob.root.classList.add("showing-context");
  if (obImageURL) { ob.splitImg.src = obImageURL; ob.splitImg.style.display = ""; }
  else ob.splitImg.style.display = "none";
});
ob.back.addEventListener("click", () => {
  ob.split.hidden = true;
  ob.center.hidden = false;
  ob.root.classList.remove("showing-context");
});
// One Infer button reads the dashboard evidence and fills all three context
// fields at once. Author edits win: a field already typed is left untouched.
ob.parseBrief.addEventListener("click", async () => {
  clearBriefError();
  ob.parseProgress.hidden = false;
  ob.parseBrief.disabled = true;
  ob.parseBrief.classList.add("running");
  let generated = false;
  try {
    const result = await withContextGenerationTelemetry("onboarding", () =>
      requestScaffold("", "dashboard-draft"));
    applyScaffoldResult(result);
    generated = true;
  } catch (error) {
    showBriefError(error);
  } finally {
    ob.parseProgress.hidden = true;
    ob.parseBrief.disabled = false;
    ob.parseBrief.classList.remove("running");
    if (generated) {
      ob.guidedPanel.classList.add("brief-arrived");
      setTimeout(() => ob.guidedPanel.classList.remove("brief-arrived"), 700);
    }
  }
});
[ob.goal, ob.audience, ob.constraints].forEach((input) => input.addEventListener("input", () => {
  const fieldName = input.closest("[data-field]").dataset.field;
  obFieldStatus[fieldName] = input.value.trim() ? "confirmed" : "missing";
  obContextSnapshotId = null;
}));
// Wire the onboarding design-doc control (the workspace copy is wired on each
// context-panel render via refreshDesignDocControls()).
refreshDesignDocControls();
ob.addCustom.addEventListener("click", () => {
  const v = ob.customInput.value.trim();
  if (v && !obCustomTypes.includes(v)) { obCustomTypes.push(v); ob.customInput.value = ""; obRenderCustomTypes(); }
});
ob.customInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ob.addCustom.click(); } });
ob.skipAI.addEventListener("click", () => enterWorkspace());
ob.form.addEventListener("submit", (e) => { e.preventDefault(); enterWorkspace(); });

dashboardLibrarySelects().forEach((select) => {
  select.addEventListener("change", () => {
    if (select.value) void loadDashboardLibrarySelection(select.value);
    else renderDashboardLibraryControls();
  });
});
const designDocLibrarySelect = document.getElementById("designDocLibrarySelect");
if (designDocLibrarySelect) {
  designDocLibrarySelect.addEventListener("change", () => { void loadDesignDocById(designDocLibrarySelect.value); });
}
renderDesignDocLibraryControl();
[
  document.getElementById("dashboardLibraryRefresh"),
  document.getElementById("onboardingDashboardLibraryRefresh"),
].forEach((button) => button?.addEventListener("click", () => {
  void refreshDashboardLibrary({ announce: true });
}));
window.addEventListener("focus", () => {
  if (!dashboardLibraryRefreshing && !dashboardLibraryBusy) {
    void refreshDashboardLibrary({ announce: false });
  }
});

// The query parameter accepts any current library id; no filename allowlist is
// needed because the API validates the id against the dashboard directory.
async function initializeDashboardLibrary() {
  await refreshDashboardLibrary({ announce: false });
  const previewDashboardId = new URLSearchParams(window.location.search).get("dashboard");
  if (previewDashboardId) await loadDashboardLibrarySelection(previewDashboardId);
}
void initializeDashboardLibrary();
