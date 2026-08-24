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
    title: "Retail Sales Command Center",
    dashboardId: "sales-command-center-new",
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

/** Migrate older four-stage sessions into the current three-stage flow. */
export function normalizeStudyPhase(phase) {
  if (phase === "pre_assessment") return "training";
  return phase === "timed_task" ? "dashboard_task" : phase;
}

export const STUDY_PHASE_INTROS = Object.freeze({
  training: Object.freeze({
    description: "Explore VIZier with guidance from the facilitator.",
    action: "Begin guided practice",
  }),
  dashboard_task: Object.freeze({
    description: "Use VIZier independently for the formal evaluation. The facilitator will tell you when to finish.",
    action: "Begin formal use",
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
    statement: "I’m confident in the final dashboard I arrived at with VIZier.",
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
    statement: "VIZier helped me understand why particular dashboard-design choices may be effective or ineffective.",
    interviewQuestion: "Please explain.",
  },
  {
    id: "vizier_systematic_review",
    statement: "After using VIZier, I feel better equipped to systematically review a dashboard.",
    interviewQuestion: "Why or why not? If yes, what, and in what ways?",
  },
  {
    id: "vizier_feedback_request",
    statement: "After using VIZier, I feel better able to formulate a useful request for dashboard-design feedback.",
    interviewQuestion: "Please explain any changes to how you might ask another person or system for feedback.",
  },
  {
    id: "vizier_control",
    statement: "I felt in control of the design decisions and process when using VIZier.",
    interviewQuestion: "Please explain what helped you feel more in control and what didn’t?",
  },
  {
    id: "vizier_future_use",
    statement: "I expect to apply something from this session to future dashboard-design work.",
    interviewQuestion: "How would you envision VIZier fitting into your existing workflows?",
  },
]);

/** The final interview follows the same eight themes as the scale. Keeping the
 * prompts on their scale items prevents the two study routes from drifting. */
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
    phase: "training",
    assessmentStep: "questionnaire",
    phaseIntros: {},
    startedAt: now,
    updatedAt: now,
    assessments: {
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
