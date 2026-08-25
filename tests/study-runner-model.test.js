import test from "node:test";
import assert from "node:assert/strict";
import {
  STUDY_GROUPS,
  STUDY_PHASE_INTROS,
  POST_EXPERIENCE_SCALE_ITEMS,
  POST_QUESTIONS,
  createStudyRunnerState,
  formatStudyPhaseTimer,
  isDashboardTaskPhase,
  isStudyRunnerState,
  makeAnnotation,
  materialForPhase,
  nextStudyPhase,
  normalizeStudyPhase,
  scaleSectionsForAssessment,
  serializeQuestionResponses,
  serializeScaleResponses,
  studyGroupIdFromPath,
  studyPhaseNumber,
  studyPhaseTimerElapsedMs,
  studyPhaseUsesVizier,
} from "../src/study-runner-model.js";

test("only the two fixed group routes start the study runner", () => {
  assert.equal(studyGroupIdFromPath("/study/group-1"), "group-1");
  assert.equal(studyGroupIdFromPath("/study/group-2/"), "group-2");
  assert.equal(studyGroupIdFromPath("/study/sequence-1"), null);
  assert.equal(studyGroupIdFromPath("/study/group-3"), null);
});

test("group routes preserve the counterbalanced three-stage assignment", () => {
  assert.deepEqual(STUDY_GROUPS["group-1"], {
    id: "group-1", training: "A", task: "B",
  });
  assert.deepEqual(STUDY_GROUPS["group-2"], {
    id: "group-2", training: "B", task: "A",
  });
  assert.equal(materialForPhase("group-1", "training").code, "A");
  assert.equal(materialForPhase("group-1", "dashboard_task").code, "B");
  assert.equal(materialForPhase("group-1", "timed_task").code, "B");
  assert.equal(materialForPhase("group-1", "post_assessment"), null);
  assert.match(materialForPhase("group-1", "training").pdfUrl, /\.pdf$/);
});

test("a participant starts in practice and advances through three stages", () => {
  const state = createStudyRunnerState("group-2", "P014");
  assert.equal(isStudyRunnerState(state, "group-2"), true);
  assert.equal(state.phase, "training");
  assert.equal(state.navigation.currentScreenId, "training:intro");
  assert.deepEqual(state.phaseIntros, {});
  assert.deepEqual(state.phaseTimers, {});
  assert.equal(nextStudyPhase("training"), "dashboard_task");
  assert.equal(nextStudyPhase("dashboard_task"), "post_assessment");
  assert.equal(nextStudyPhase("timed_task"), "post_assessment");
  assert.equal(normalizeStudyPhase("timed_task"), "dashboard_task");
  assert.equal(normalizeStudyPhase("pre_assessment"), "training");
  assert.equal(nextStudyPhase("post_assessment"), "complete");
  assert.equal(studyPhaseNumber("post_assessment"), 3);
});

test("stage timers format and preserve elapsed time across refreshes", () => {
  assert.equal(formatStudyPhaseTimer(0), "00:00");
  assert.equal(formatStudyPhaseTimer(65_000), "01:05");
  assert.equal(formatStudyPhaseTimer(3_661_000), "1:01:01");
  assert.equal(studyPhaseTimerElapsedMs(
    { startedAt: "2026-08-24T10:00:00.000Z" },
    Date.parse("2026-08-24T10:02:03.000Z"),
  ), 123_000);
  assert.equal(studyPhaseTimerElapsedMs({
    startedAt: "2026-08-24T10:00:00.000Z",
    completedAt: "2026-08-24T10:04:00.000Z",
  }), 240_000);
  assert.equal(studyPhaseTimerElapsedMs({ startedAt: "invalid" }), 0);
});

test("only guided practice and the dashboard task use the full VIZier workspace", () => {
  assert.equal(studyPhaseUsesVizier("training"), true);
  assert.equal(studyPhaseUsesVizier("dashboard_task"), true);
  assert.equal(studyPhaseUsesVizier("timed_task"), true);
  assert.equal(studyPhaseUsesVizier("post_assessment"), false);
  assert.equal(isDashboardTaskPhase("training"), false);
  assert.equal(isDashboardTaskPhase("dashboard_task"), true);
  assert.equal(isDashboardTaskPhase("timed_task"), true);
});

test("every active study phase has one concise transition page", () => {
  assert.deepEqual(Object.keys(STUDY_PHASE_INTROS), [
    "training", "dashboard_task", "post_assessment",
  ]);
  Object.values(STUDY_PHASE_INTROS).forEach((intro) => {
    assert.ok(intro.description.length > 0);
    assert.ok(intro.action.startsWith("Begin"));
  });
});

test("annotations retain normalized optional regions", () => {
  const note = makeAnnotation({
    id: "n1",
    text: "  The chart title needs context.  ",
    region: { x: .2, y: .3, w: .4, h: .2 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(note.text, "The chart title needs context.");
  assert.deepEqual(note.region, { x: .2, y: .3, w: .4, h: .2 });
  assert.throws(() => makeAnnotation({ text: "   " }), /required/);
});

test("questionnaire content follows the study protocol exactly", () => {
  const post = scaleSectionsForAssessment("post");
  assert.equal(POST_QUESTIONS.length, 8);
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].items, POST_EXPERIENCE_SCALE_ITEMS);
  assert.equal(post[0].items.length, 8);
  assert.deepEqual(POST_QUESTIONS, post[0].items.map((item) => item.interviewQuestion));
  assert.deepEqual(post[0].items.map((item) => [item.statement, item.interviewQuestion]), [
    [
      "I’m satisfied with the quality of the final dashboard design I arrived at with VIZier.",
      "What else would you still change given more time and capabilities?",
    ],
    [
      "I felt confident and comfortable using VIZier.",
      "What were the best and worst parts of the experience? What should change?",
    ],
    [
      "VIZier made me more aware of dashboard design considerations that I might otherwise overlook.",
      "Any examples? Please explain.",
    ],
    [
      "VIZier helped me understand the ‘why’ behind dashboard design choices, and what makes them potentially effective or ineffective.",
      "Any examples? Please explain.",
    ],
    [
      "After using VIZier, I feel better equipped to systematically review a dashboard.",
      "Why or why not? If yes, what, and in what ways?",
    ],
    [
      "After using VIZier, I feel better able to formulate dashboard feedback requests (from people and/or systems) in a useful manner.",
      "Please explain any changes to how you might ask another person or system for feedback.",
    ],
    [
      "When using VIZier, I felt in control of dashboard design decisions and design process.",
      "Please explain what helped you feel more in control and what didn’t.",
    ],
    [
      "I expect to apply something from this session to future dashboard design work.",
      "Provide examples. Also, how would you envision VIZier fitting into your existing workflows?",
    ],
  ]);
});

test("scale telemetry serializes numeric, N/A, and missing responses explicitly", () => {
  const sections = scaleSectionsForAssessment("post");
  const responses = serializeScaleResponses(sections, {
    vizier_final_dashboard_confidence: "6",
    vizier_comfort: "NA",
  });
  assert.deepEqual(responses[0], {
    instrument: "vizier-experience",
    itemId: "vizier_final_dashboard_confidence",
    statement: sections[0].items[0].statement,
    value: 6,
    notApplicable: false,
    answered: true,
  });
  assert.equal(responses[1].value, null);
  assert.equal(responses[1].notApplicable, true);
  assert.equal(responses[2].answered, false);
});

test("open-ended protocol responses serialize without forcing an answer", () => {
  const responses = serializeQuestionResponses(POST_QUESTIONS, { q1: "  Hierarchy and legibility.  " });
  assert.deepEqual(responses[0], {
    itemId: "q1",
    question: POST_QUESTIONS[0],
    response: "  Hierarchy and legibility.  ",
    answered: true,
  });
  assert.equal(responses[1].answered, false);
});
