import test from "node:test";
import assert from "node:assert/strict";
import {
  STUDY_GROUPS,
  STUDY_PHASE_INTROS,
  createStudyRunnerState,
  isDashboardTaskPhase,
  isStudyRunnerState,
  makeAnnotation,
  materialForPhase,
  nextStudyPhase,
  normalizeStudyPhase,
  scaleSectionsForAssessment,
  serializeScaleResponses,
  studyGroupIdFromPath,
  studyPhaseNumber,
  studyPhaseUsesVizier,
} from "../src/study-runner-model.js";

test("only the two fixed group routes start the study runner", () => {
  assert.equal(studyGroupIdFromPath("/study/group-1"), "group-1");
  assert.equal(studyGroupIdFromPath("/study/group-2/"), "group-2");
  assert.equal(studyGroupIdFromPath("/study/sequence-1"), null);
  assert.equal(studyGroupIdFromPath("/study/group-3"), null);
});

test("group routes preserve the counterbalanced four-part assignment", () => {
  assert.deepEqual(STUDY_GROUPS["group-1"], {
    id: "group-1", pre: "1", training: "A", task: "B", post: "2",
  });
  assert.deepEqual(STUDY_GROUPS["group-2"], {
    id: "group-2", pre: "2", training: "B", task: "A", post: "1",
  });
  assert.equal(materialForPhase("group-1", "pre_assessment").code, "1");
  assert.equal(materialForPhase("group-1", "training").code, "A");
  assert.equal(materialForPhase("group-1", "dashboard_task").code, "B");
  assert.equal(materialForPhase("group-1", "timed_task").code, "B");
  assert.equal(materialForPhase("group-1", "post_assessment").code, "2");
});

test("a participant state starts at the neutral pre assessment and advances in order", () => {
  const state = createStudyRunnerState("group-2", "P014");
  assert.equal(isStudyRunnerState(state, "group-2"), true);
  assert.equal(state.phase, "pre_assessment");
  assert.equal(state.assessmentStep, "review");
  assert.deepEqual(state.phaseIntros, {});
  assert.equal(nextStudyPhase("pre_assessment"), "training");
  assert.equal(nextStudyPhase("training"), "dashboard_task");
  assert.equal(nextStudyPhase("dashboard_task"), "post_assessment");
  assert.equal(nextStudyPhase("timed_task"), "post_assessment");
  assert.equal(normalizeStudyPhase("timed_task"), "dashboard_task");
  assert.equal(nextStudyPhase("post_assessment"), "complete");
  assert.equal(studyPhaseNumber("post_assessment"), 4);
});

test("only guided practice and the dashboard task use the full VIZier workspace", () => {
  assert.equal(studyPhaseUsesVizier("pre_assessment"), false);
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
    "pre_assessment", "training", "dashboard_task", "post_assessment",
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

test("pre and post expose paired scale IDs for direct comparison", () => {
  const pre = scaleSectionsForAssessment("pre");
  const post = scaleSectionsForAssessment("post");
  assert.deepEqual(pre[0].items.map((item) => item.id), post[0].items.map((item) => item.id));
  assert.equal(pre.length, 1);
  assert.equal(post.length, 2);
});

test("scale telemetry serializes numeric, N/A, and missing responses explicitly", () => {
  const sections = scaleSectionsForAssessment("pre");
  const responses = serializeScaleResponses(sections, {
    review_awareness: "6",
    review_explanation: "NA",
  });
  assert.deepEqual(responses[0], {
    instrument: "dashboard-review-confidence",
    itemId: "review_awareness",
    statement: sections[0].items[0].statement,
    value: 6,
    notApplicable: false,
    answered: true,
  });
  assert.equal(responses[1].value, null);
  assert.equal(responses[1].notApplicable, true);
  assert.equal(responses[2].answered, false);
});
