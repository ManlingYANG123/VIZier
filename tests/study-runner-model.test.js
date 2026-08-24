import test from "node:test";
import assert from "node:assert/strict";
import {
  STUDY_GROUPS,
  STUDY_PHASE_INTROS,
  POST_EXPERIENCE_SCALE_ITEMS,
  POST_QUESTIONS,
  createStudyRunnerState,
  isStudyRunnerState,
  makeAnnotation,
  materialForPhase,
  nextStudyPhase,
  normalizeStudyPhase,
  scaleSectionsForAssessment,
  serializeScaleResponses,
  studyGroupIdFromPath,
  studyPhaseNumber,
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
  assert.match(materialForPhase("group-1", "training").pdfUrl, /\.pdf$/);
  assert.equal(materialForPhase("group-1", "post_assessment"), null);
});

test("a participant starts in practice and advances through three stages", () => {
  const state = createStudyRunnerState("group-2", "P014");
  assert.equal(isStudyRunnerState(state, "group-2"), true);
  assert.equal(state.phase, "training");
  assert.equal(state.assessmentStep, "questionnaire");
  assert.deepEqual(state.phaseIntros, {});
  assert.equal(nextStudyPhase("training"), "dashboard_task");
  assert.equal(nextStudyPhase("dashboard_task"), "post_assessment");
  assert.equal(nextStudyPhase("timed_task"), "post_assessment");
  assert.equal(normalizeStudyPhase("pre_assessment"), "training");
  assert.equal(normalizeStudyPhase("timed_task"), "dashboard_task");
  assert.equal(nextStudyPhase("post_assessment"), "complete");
  assert.equal(studyPhaseNumber("post_assessment"), 3);
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

test("the final questionnaire keeps eight scale and interview questions paired by theme", () => {
  const pre = scaleSectionsForAssessment("pre");
  const post = scaleSectionsForAssessment("post");
  assert.equal(pre.length, 0);
  assert.equal(post.length, 1);
  assert.equal(post[0].items.length, 8);
  assert.equal(POST_EXPERIENCE_SCALE_ITEMS.length, 8);
  assert.deepEqual(
    POST_QUESTIONS,
    post[0].items.map((item) => item.interviewQuestion),
  );
  post[0].items.forEach((item) => {
    assert.ok(item.statement.length > 0);
    assert.ok(item.interviewQuestion.length > 0);
  });
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
