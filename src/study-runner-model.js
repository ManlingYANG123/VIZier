export const STUDY_RUNNER_SCHEMA_VERSION = 1;
export const STUDY_RUNNER_STORAGE_PREFIX = "vizierStudyRunner";

export const STUDY_MATERIAL_MAP = Object.freeze({
  A: Object.freeze({
    code: "A",
    title: "Britain's Garden Birds",
    dashboardId: "garden-birds-new",
    dashboardUrl: "/study-materials/dashboards/A_garden-birds.json",
    docId: "study-a",
  }),
  B: Object.freeze({
    code: "B",
    title: "Retail Sales Command Center",
    dashboardId: "sales-command-center-new",
    dashboardUrl: "/study-materials/dashboards/B_retail-sales-command-center.json",
    docId: "study-b",
  }),
  1: Object.freeze({
    code: "1",
    title: "Air Quality Where You Live",
    dashboardId: "air-quality-new",
    dashboardUrl: "/study-materials/dashboards/1_air-quality.json",
    docId: "",
  }),
  2: Object.freeze({
    code: "2",
    title: "Ocean Biodiversity Atlas",
    dashboardId: "ocean-life",
    dashboardUrl: "/study-materials/dashboards/2_ocean-biodiversity.json",
    docId: "",
  }),
});

export const STUDY_GROUPS = Object.freeze({
  "group-1": Object.freeze({
    id: "group-1",
    pre: "1",
    training: "A",
    task: "B",
    post: "2",
  }),
  "group-2": Object.freeze({
    id: "group-2",
    pre: "2",
    training: "B",
    task: "A",
    post: "1",
  }),
});

export const STUDY_RUNNER_PHASES = Object.freeze([
  "pre_assessment",
  "training",
  "dashboard_task",
  "post_assessment",
  "complete",
]);

/** Older sessions stored this phase as `timed_task`; normalize it to the
 * current phase name before routing, timing, or persistence. */
export function normalizeStudyPhase(phase) {
  return phase === "timed_task" ? "dashboard_task" : phase;
}

export function studyPhaseUsesVizier(phase) {
  const normalizedPhase = normalizeStudyPhase(phase);
  return normalizedPhase === "training" || normalizedPhase === "dashboard_task";
}

export function isDashboardTaskPhase(phase) {
  return normalizeStudyPhase(phase) === "dashboard_task";
}

export const STUDY_PHASE_INTROS = Object.freeze({
  pre_assessment: Object.freeze({
    description: "Review a dashboard and share what you notice.",
    action: "Begin assessment",
  }),
  training: Object.freeze({
    description: "Explore VIZier with guidance from the facilitator.",
    action: "Begin guided practice",
  }),
  dashboard_task: Object.freeze({
    description: "Use VIZier to complete the dashboard task independently. The facilitator will tell you when to finish.",
    action: "Begin dashboard task",
  }),
  post_assessment: Object.freeze({
    description: "Review a second dashboard and complete the final questionnaire.",
    action: "Begin final assessment",
  }),
});

export const PRE_QUESTIONS = Object.freeze([
  "What dashboard-design principles or best practices guide your work? Please list as many as readily come to mind.",
  "When reviewing a dashboard, what do you typically look for when deciding whether it should be revised?",
  "How do you normally decide what kind of feedback to request about a dashboard?",
]);

export const POST_QUESTIONS = Object.freeze([
  "What dashboard-design principles or best practices guide your work? Please list as many as readily come to mind.",
  "Did working with VIZier change your awareness or understanding of any dashboard-design principles? If so, which ones, and how? If not, please explain.",
  "Did working with VIZier change how you would approach reviewing or revising a dashboard? If so, please describe what you might do differently.",
  "Did the experience change how you would ask another person or system for feedback about a dashboard? If so, how?",
  "Was anything presented by VIZier already familiar to you? Was anything new, surprising, questionable, or inconsistent with your existing practice?",
  "Do you expect to apply anything from this experience to a future dashboard-design task? Why or why not?",
  "How confident are you in the final dashboard, and what would you still change with more time?",
  "Where in your real workflow would VIZier be most useful and least useful?",
  "What were the best and worst parts of the experience? What should change?",
]);

const freezeScaleItems = (items) => Object.freeze(items.map((item) => Object.freeze(item)));

export const POST_EXPERIENCE_SCALE_ITEMS = freezeScaleItems([
  { id: "vizier_awareness", statement: "VIZier made me more aware of dashboard-design considerations that I might otherwise overlook." },
  { id: "vizier_understanding", statement: "VIZier helped me understand why particular dashboard-design choices may be effective or ineffective." },
  { id: "vizier_revision_ideas", statement: "VIZier gave me new ideas for how to revise a dashboard." },
  { id: "vizier_systematic_review", statement: "After using VIZier, I feel better able to systematically review a dashboard." },
  { id: "vizier_feedback_request", statement: "After using VIZier, I feel better able to formulate a useful request for dashboard-design feedback." },
  { id: "vizier_future_use", statement: "I expect to apply something from this session to future dashboard-design work." },
  { id: "vizier_guidance_familiarity", statement: "Most of the design guidance provided by VIZier was already familiar to me." },
]);

export function scaleSectionsForAssessment(key) {
  if (key !== "post") return [];
  return [{
    id: "vizier-experience",
    title: "After using VIZier",
    items: POST_EXPERIENCE_SCALE_ITEMS,
  }];
}

export function serializeQuestionResponses(questions, responseMap = {}) {
  return questions.map((question, index) => {
    const itemId = `q${index + 1}`;
    const response = String(responseMap[itemId] ?? "");
    return {
      itemId,
      question,
      response,
      answered: response.trim() !== "",
    };
  });
}

export function serializeScaleResponses(sections, responseMap = {}) {
  return sections.flatMap((section) => section.items.map((item) => {
    const rawValue = String(responseMap[item.id] ?? "");
    return {
      instrument: section.id,
      itemId: item.id,
      statement: item.statement,
      value: /^\d+$/.test(rawValue) ? Number(rawValue) : null,
      notApplicable: rawValue === "NA",
      answered: rawValue !== "",
    };
  }));
}

export function studyGroupIdFromPath(pathname = "") {
  const match = String(pathname).match(/^\/study\/(group-[12])\/?$/);
  return match && STUDY_GROUPS[match[1]] ? match[1] : null;
}

export function studyRunnerStorageKey(groupId) {
  if (!STUDY_GROUPS[groupId]) throw new Error(`Unknown study group: ${groupId}`);
  return `${STUDY_RUNNER_STORAGE_PREFIX}:${groupId}`;
}

export function createStudyRunnerState(groupId, participantId) {
  if (!STUDY_GROUPS[groupId]) throw new Error(`Unknown study group: ${groupId}`);
  const id = String(participantId || "").trim();
  if (!id) throw new Error("Participant ID is required");
  const now = new Date().toISOString();
  return {
    schemaVersion: STUDY_RUNNER_SCHEMA_VERSION,
    groupId,
    participantId: id,
    phase: "pre_assessment",
    assessmentStep: "review",
    phaseIntros: {},
    phaseTimers: {},
    startedAt: now,
    updatedAt: now,
    assessments: {
      pre: { annotations: [], answers: {}, scales: {}, submittedAt: null },
      post: { annotations: [], answers: {}, scales: {}, submittedAt: null },
    },
  };
}

export function isStudyRunnerState(value, groupId = null) {
  return Boolean(
    value
      && typeof value === "object"
      && value.schemaVersion === STUDY_RUNNER_SCHEMA_VERSION
      && STUDY_GROUPS[value.groupId]
      && (!groupId || value.groupId === groupId)
      && typeof value.participantId === "string"
      && value.participantId.trim()
      && STUDY_RUNNER_PHASES.includes(normalizeStudyPhase(value.phase)),
  );
}

export function studyPhaseNumber(phase) {
  const index = STUDY_RUNNER_PHASES.indexOf(normalizeStudyPhase(phase));
  return index < 0 ? 1 : Math.min(4, index + 1);
}

export function studyPhaseLabel(phase) {
  return {
    pre_assessment: "Initial assessment",
    training: "Guided practice",
    dashboard_task: "Dashboard task",
    timed_task: "Dashboard task",
    post_assessment: "Final assessment",
    complete: "Session complete",
  }[phase] || "Study session";
}

export function materialForPhase(groupId, phase) {
  const group = STUDY_GROUPS[groupId];
  if (!group) return null;
  const code = {
    pre_assessment: group.pre,
    training: group.training,
    dashboard_task: group.task,
    timed_task: group.task,
    post_assessment: group.post,
  }[phase];
  return code ? STUDY_MATERIAL_MAP[code] : null;
}

export function assessmentKeyForPhase(phase) {
  return phase === "pre_assessment" ? "pre" : phase === "post_assessment" ? "post" : null;
}

export function nextStudyPhase(phase) {
  return {
    pre_assessment: "training",
    training: "dashboard_task",
    dashboard_task: "post_assessment",
    timed_task: "post_assessment",
    post_assessment: "complete",
  }[phase] || "complete";
}

export function studyPhaseTimerElapsedMs(timer, now = Date.now()) {
  const startedAt = Date.parse(String(timer?.startedAt || ""));
  if (!Number.isFinite(startedAt)) return 0;
  const completedAt = timer?.completedAt ? Date.parse(String(timer.completedAt)) : Number(now);
  if (!Number.isFinite(completedAt)) return 0;
  return Math.max(0, completedAt - startedAt);
}

export function formatStudyPhaseTimer(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000) || 0);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const two = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

export function makeAnnotation({ id, text = "", region = null, createdAt = null } = {}) {
  const note = String(text || "").trim();
  if (!note) throw new Error("Annotation text is required");
  const normalizedRegion = region && ["x", "y", "w", "h"].every((key) => Number.isFinite(Number(region[key])))
    ? Object.fromEntries(["x", "y", "w", "h"].map((key) => [key, Math.max(0, Math.min(1, Number(region[key])))]))
    : null;
  return {
    id: String(id || `note-${Date.now().toString(36)}`),
    text: note,
    region: normalizedRegion,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function updateStudyRunnerTimestamp(state) {
  return { ...state, updatedAt: new Date().toISOString() };
}
