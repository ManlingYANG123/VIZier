import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointSelectionForClick,
  revisionDisplayLabel,
} from "../src/revision-preview.js";

test("revision labels use Title Case and correct pluralization", () => {
  assert.equal(
    revisionDisplayLabel({ id: 1, kind: "initial" }),
    "Checkpoint 1 · Original Dashboard",
  );
  assert.equal(
    revisionDisplayLabel({
      id: 2,
      kind: "revision",
      appliedRecommendations: [{}],
    }, { includeApplied: true }),
    "Checkpoint 2 · 1 Change Applied",
  );
  assert.equal(
    revisionDisplayLabel({
      id: 3,
      kind: "revision",
      appliedRecommendations: [{}, {}],
    }),
    "Checkpoint 3 · 2 Changes",
  );
});

test("checkpoint selection builds a chronological pair from two timeline clicks", () => {
  assert.deepEqual(
    checkpointSelectionForClick({
      comparison: { before: 2, after: 2 },
      clickedId: 4,
      orderedIds: [1, 2, 3, 4],
      lastSelectedId: 2,
    }),
    { before: 2, after: 4 },
  );
  assert.deepEqual(
    checkpointSelectionForClick({
      comparison: { before: 4, after: 4 },
      clickedId: 1,
      orderedIds: [1, 2, 3, 4],
      lastSelectedId: 4,
    }),
    { before: 1, after: 4 },
  );
});

test("clicking either selected endpoint resets comparison to that checkpoint", () => {
  assert.deepEqual(
    checkpointSelectionForClick({
      comparison: { before: 1, after: 3 },
      clickedId: 1,
      orderedIds: [1, 2, 3],
      lastSelectedId: 3,
    }),
    { before: 1, after: 1 },
  );
  assert.deepEqual(
    checkpointSelectionForClick({
      comparison: { before: 1, after: 3 },
      clickedId: 3,
      orderedIds: [1, 2, 3],
      lastSelectedId: 1,
    }),
    { before: 3, after: 3 },
  );
});
