import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_EXTRACTION_HINTS,
  CONTEXT_WORKFLOW_STATUS,
  contextFingerprint,
  contextIsConfirmed,
  contextWorkflowPresentation,
  createContextWorkflow,
} from "../src/context-workflow.js";

const context = {
  goal: "Compare delivery risk.",
  audience: "Engineering leads.",
  constraints: "",
  scope: ["visual", "interaction"],
  customTypes: [],
};

test("context is review-ready only after an exact snapshot is confirmed", () => {
  const workflow = createContextWorkflow(CONTEXT_WORKFLOW_STATUS.CONFIRMED, {
    confirmedFingerprint: contextFingerprint(context),
  });
  assert.equal(contextIsConfirmed(workflow, context), true);
  assert.equal(contextIsConfirmed(workflow, { ...context, audience: "PMO leaders." }), false);
});

test("generated context requires an explicit confirmation action", () => {
  const workflow = createContextWorkflow(CONTEXT_WORKFLOW_STATUS.NEEDS_REVIEW);
  const presentation = contextWorkflowPresentation(workflow, context);
  assert.equal(presentation.title, "Review Context");
  assert.equal(presentation.actionLabel, "Confirm Context");
  assert.equal(presentation.actionPrompt, "Use this context for the review?");
  assert.equal(presentation.actionDisabled, false);
  assert.equal(contextIsConfirmed(workflow, context), false);
});

test("automatic extraction uses a concise context progress state", () => {
  const presentation = contextWorkflowPresentation(
    createContextWorkflow(CONTEXT_WORKFLOW_STATUS.GENERATING),
    {},
  );
  assert.equal(presentation.title, "Extracting Context");
  assert.equal(presentation.description, "");
  assert.equal(presentation.actionDisabled, true);
});

test("extraction hints rotate through multiple short, distinct phrases", () => {
  assert.ok(CONTEXT_EXTRACTION_HINTS.length > 1);
  CONTEXT_EXTRACTION_HINTS.forEach((hint) => {
    assert.ok(hint.length > 0 && hint.length <= 40);
  });
  assert.equal(new Set(CONTEXT_EXTRACTION_HINTS).size, CONTEXT_EXTRACTION_HINTS.length);
});

test("editing context produces an immediate confirmation action", () => {
  const workflow = createContextWorkflow(CONTEXT_WORKFLOW_STATUS.NEEDS_REVIEW, {
    reason: "edited",
  });
  const presentation = contextWorkflowPresentation(workflow, context);
  assert.equal(presentation.title, "Context updated");
  assert.equal(presentation.actionLabel, "Confirm Changes");
  assert.equal(presentation.actionPrompt, "Use your updated context?");
  assert.equal(presentation.actionDisabled, false);
});

test("a failed or empty inference still requires an explicit continue decision", () => {
  const workflow = createContextWorkflow(CONTEXT_WORKFLOW_STATUS.ERROR, {
    error: "The model connection timed out.",
  });
  const presentation = contextWorkflowPresentation(workflow, {});
  assert.equal(presentation.actionLabel, "Continue Without Context");
  assert.match(presentation.description, /timed out/);
});
