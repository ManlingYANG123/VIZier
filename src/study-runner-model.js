export const STUDY_RUNNER_SCHEMA_VERSION = 1;
export const STUDY_RUNNER_STORAGE_PREFIX = "vizierStudyRunner";

export const STUDY_MATERIAL_MAP = Object.freeze({
  A: Object.freeze({
    code: "A",
    title: "Britain's Garden Birds",
    dashboardId: "garden-birds-new",
    dashboardUrl: "/study-materials/dashboards/A_garden-birds.json",
    docId: "study-a",
    pdfUrl: "/study-materials/pdfs/A_bbc-gel-infographics.pdf",
  }),
  B: Object.freeze({
    code: "B",
    title: "Workspace Overview",
    dashboardId: "workspace-overview",
    dashboardUrl: "/study-materials/dashboards/B_retail-sales-command-center.json",
    docId: "study-b",
    pdfUrl: "/study-materials/pdfs/B_tableau-dashboard-best-practices.pdf",
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
    training: "A",
    task: "B",
  }),
  "group-2": Object.freeze({
    id: "group-2",
    training: "B",
    task: "A",
  }),
});

export const STUDY_RUNNER_PHASES = Object.freeze([
  "training",
  "dashboard_task",
  "post_assessment",
  "complete",
]);

export const STUDY_RUNNER_SCREENS = Object.freeze([
  Object.freeze({ id: "training:intro", phase: "training", view: "intro" }),
  Object.freeze({ id: "training:workspace", phase: "training", view: "workspace" }),
  Object.freeze({ id: "dashboard_task:intro", phase: "dashboard_task", view: "intro" }),
  Object.freeze({ id: "dashboard_task:workspace", phase: "dashboard_task", view: "workspace" }),
  Object.freeze({ id: "post_assessment:intro", phase: "post_assessment", view: "intro" }),
  Object.freeze({ id: "post_assessment:questionnaire", phase: "post_assessment", view: "questionnaire" }),
  Object.freeze({ id: "complete", phase: "complete", view: "complete" }),
]);

const STUDY_RUNNER_SCREEN_BY_ID = new Map(
  STUDY_RUNNER_SCREENS.map((screen) => [screen.id, screen]),
);

/** Migrate older four-stage sessions into the current three-stage flow. */
export function normalizeStudyPhase(phase) {
  if (phase === "pre_assessment") return "training";
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
  training: Object.freeze({
    description: "Explore VIZier with guidance from the facilitator.",
    action: "Begin practice",
  }),
  dashboard_task: Object.freeze({
    description: "Use VIZier independently for the formal evaluation. The facilitator will tell you when to finish.",
    action: "Begin task",
  }),
  post_assessment: Object.freeze({
    description: "Complete the questionnaire, then discuss each interview prompt with the facilitator.",
    action: "Begin questionnaire",
  }),
});

const freezeScaleItems = (items) => Object.freeze(items.map((item) => Object.freeze(item)));

export const POST_EXPERIENCE_SCALE_ITEMS = freezeScaleItems([
  {
    id: "vizier_final_dashboard_confidence",
    statement: "I’m satisfied with the quality of the final dashboard design I arrived at with VIZier.",
    interviewQuestion: "What else would you still change given more time and capabilities?",
  },
  {
    id: "vizier_comfort",
    statement: "I felt confident and comfortable using VIZier.",
    interviewQuestion: "What were the best and worst parts of the experience? What should change?",
  },
  {
    id: "vizier_awareness",
    statement: "VIZier made me more aware of dashboard design considerations that I might otherwise overlook.",
    interviewQuestion: "Any examples? Please explain.",
  },
  {
    id: "vizier_understanding",
    statement: "VIZier nudged me to reflect more intentionally on the ‘why’ behind dashboard design choices, and what makes them more effective or ineffective.",
    interviewQuestion: "Any examples? Please explain.",
  },
  {
    id: "vizier_systematic_review",
    statement: "After using VIZier, I feel better equipped to systematically review a dashboard.",
    interviewQuestion: "Why or why not? If yes, what, and in what ways?",
  },
  {
    id: "vizier_feedback_request",
    statement: "After using VIZier, I feel better able to formulate dashboard feedback requests (from people and/or systems) in a useful manner.",
    interviewQuestion: "Please explain any changes to how you might ask another person or system for feedback.",
  },
  {
    id: "vizier_control",
    statement: "When using VIZier, I felt in control of dashboard design decisions and design process.",
    interviewQuestion: "Please explain what helped you feel more in control and what didn’t.",
  },
  {
    id: "vizier_future_use",
    statement: "I expect to apply something from this session to future dashboard design work.",
    interviewQuestion: "Provide examples. Also, how would you envision VIZier fitting into your existing workflows?",
  },
]);

/** Study 1 and Study 2 share these eight paired questionnaire/interview themes. */
export const POST_QUESTIONS = Object.freeze(
  POST_EXPERIENCE_SCALE_ITEMS.map((item) => item.interviewQuestion),
);

export function scaleSectionsForAssessment(key) {
  if (key !== "post") return [];
  return [{
    id: "vizier-experience",
    title: "Experience with VIZier",
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

/** A runner snapshot may be resumed only when it belongs to the material that
 * is currently assigned to the phase. This prevents a replaced study stimulus
 * from being overwritten by an older dashboard saved in localStorage. */
export function studyWorkspaceMatchesMaterial(snapshot, material) {
  if (!snapshot || !material) return false;
  const savedMaterialId = String(snapshot.workspace?.artifactLibraryId || "").trim();
  const savedDashboardId = String(snapshot.dashboard?.board?.id || "").trim();
  const expectedId = String(material.dashboardId || "").trim();
  if (!expectedId) return false;
  return savedMaterialId
    ? savedMaterialId === expectedId
    : savedDashboardId === expectedId;
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
    phase: "training",
    assessmentStep: "questionnaire",
    phaseIntros: {},
    phaseTimers: {},
    navigation: {
      currentScreenId: "training:intro",
      history: ["training:intro"],
      historyIndex: 0,
      reopenings: [],
    },
    workspaces: {},
    workspaceSubmissions: {},
    startedAt: now,
    updatedAt: now,
    assessments: {
      post: { annotations: [], answers: {}, scales: {}, submittedAt: null },
    },
  };
}

export function studyScreenDescriptor(screenId) {
  return STUDY_RUNNER_SCREEN_BY_ID.get(String(screenId || "")) || null;
}

export function studyScreenIdForState(state) {
  const phase = normalizeStudyPhase(state?.phase);
  if (phase === "complete") return "complete";
  const explicit = studyScreenDescriptor(state?.navigation?.currentScreenId);
  if (explicit && explicit.phase === phase) return explicit.id;
  if (!state?.phaseIntros?.[phase]?.completedAt) return `${phase}:intro`;
  if (studyPhaseUsesVizier(phase)) return `${phase}:workspace`;
  if (phase === "post_assessment") return "post_assessment:questionnaire";
  return `${phase}:intro`;
}

export function previousStudyScreenId(screenId) {
  const index = STUDY_RUNNER_SCREENS.findIndex((screen) => screen.id === screenId);
  return index > 0 ? STUDY_RUNNER_SCREENS[index - 1].id : null;
}

export function operationStudyScreenId(phase) {
  const normalized = normalizeStudyPhase(phase);
  if (studyPhaseUsesVizier(normalized)) return `${normalized}:workspace`;
  if (normalized === "post_assessment") return "post_assessment:questionnaire";
  return null;
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
  return index < 0 ? 1 : Math.min(3, index + 1);
}

export function studyPhaseLabel(phase) {
  return {
    training: "Practice",
    dashboard_task: "Formal use",
    timed_task: "Formal use",
    post_assessment: "Questionnaire & interview",
    complete: "Session complete",
  }[phase] || "Study session";
}

export function materialForPhase(groupId, phase) {
  const group = STUDY_GROUPS[groupId];
  if (!group) return null;
  const code = {
    training: group.training,
    dashboard_task: group.task,
    timed_task: group.task,
  }[phase];
  return code ? STUDY_MATERIAL_MAP[code] : null;
}

export function assessmentKeyForPhase(phase) {
  return phase === "post_assessment" ? "post" : null;
}

export function nextStudyPhase(phase) {
  return {
    training: "dashboard_task",
    dashboard_task: "post_assessment",
    timed_task: "post_assessment",
    post_assessment: "complete",
  }[phase] || "complete";
}

export function studyPhaseTimerElapsedMs(timer, now = Date.now()) {
  return studyPhaseTimerSegments(timer).reduce((total, segment) => {
    const startedAt = Date.parse(String(segment?.startedAt || ""));
    if (!Number.isFinite(startedAt)) return total;
    const completedAt = segment?.completedAt
      ? Date.parse(String(segment.completedAt))
      : Number(now);
    if (!Number.isFinite(completedAt)) return total;
    return total + Math.max(0, completedAt - startedAt);
  }, 0);
}

export function studyPhaseTimerSegments(timer) {
  if (Array.isArray(timer?.segments)) {
    return timer.segments.filter((segment) => segment && typeof segment === "object");
  }
  if (!timer?.startedAt) return [];
  return [{
    id: "segment-1",
    reason: "initial",
    source: "legacy",
    startedAt: timer.startedAt,
    completedAt: timer.completedAt || null,
    durationMs: Number.isFinite(Number(timer.durationMs)) ? Number(timer.durationMs) : null,
  }];
}

export function studyPhaseTimerIsRunning(timer) {
  const segments = studyPhaseTimerSegments(timer);
  return Boolean(segments.length && !segments[segments.length - 1].completedAt);
}

export function startStudyPhaseTimerSegment(timer, {
  startedAt = new Date().toISOString(),
  reason = "initial",
  source = "participant",
} = {}) {
  const segments = studyPhaseTimerSegments(timer).map((segment) => ({ ...segment }));
  if (segments.length && !segments[segments.length - 1].completedAt) {
    return timer;
  }
  segments.push({
    id: `segment-${segments.length + 1}`,
    reason: segments.length ? "reopened" : reason,
    source,
    startedAt,
    completedAt: null,
    durationMs: null,
  });
  return {
    schemaVersion: 2,
    startedAt: segments[0].startedAt,
    completedAt: null,
    durationMs: studyPhaseTimerElapsedMs({ segments }, Date.parse(startedAt)),
    totalDurationMs: studyPhaseTimerElapsedMs({ segments }, Date.parse(startedAt)),
    segments,
  };
}

export function stopStudyPhaseTimerSegment(timer, completedAt = new Date().toISOString()) {
  const segments = studyPhaseTimerSegments(timer).map((segment) => ({ ...segment }));
  const active = segments[segments.length - 1];
  if (!active || active.completedAt) return timer || null;
  const startedAtMs = Date.parse(String(active.startedAt || ""));
  const completedAtMs = Date.parse(String(completedAt || ""));
  active.completedAt = completedAt;
  active.durationMs = Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
    ? Math.max(0, completedAtMs - startedAtMs)
    : 0;
  const totalDurationMs = studyPhaseTimerElapsedMs({ segments }, completedAtMs);
  return {
    schemaVersion: 2,
    startedAt: segments[0]?.startedAt || null,
    completedAt,
    durationMs: totalDurationMs,
    totalDurationMs,
    segments,
  };
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
