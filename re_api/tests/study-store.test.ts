import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveStudySession } from "../src/study-store.ts";

test("saveStudySession writes the event log plus complete study artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vizier-study-"));
  const previousDir = process.env.STUDY_DATA_DIR;
  const previousForce = process.env.STUDY_FORCE_LOCAL;
  process.env.STUDY_DATA_DIR = dir;
  process.env.STUDY_FORCE_LOCAL = "1";
  try {
    const result = await saveStudySession({
      participantId: "P01",
      sessionId: "sess-1",
      fileName: "03-dashboard-task-2026-08-21T17-00-00Z.json",
      savedAt: "2026-08-21T17:00:00.000Z",
      events: [{ kind: "session_started" }],
      artifacts: [
        {
          path: "dashboards/checkpoint-01.json",
          contentType: "application/json",
          text: JSON.stringify({ dashboard: { title: "Original" }, tiles: [] }),
        },
        {
          path: "dashboards/checkpoint-01.png",
          contentType: "image/png",
          encoding: "base64",
          data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        },
        {
          path: "dashboards/final.json",
          contentType: "application/json",
          text: JSON.stringify({ dashboard: { title: "Final" }, tiles: [] }),
        },
        {
          path: "questionnaires/post.json",
          contentType: "application/json",
          text: JSON.stringify({ assessment: "post", questionResponses: [] }),
        },
        {
          path: "study-runner-state.json",
          contentType: "application/json",
          text: JSON.stringify({ phase: "complete" }),
        },
      ],
    });
    assert.equal(result.stored, "local");
    assert.equal(result.files.length, 6);
    assert.equal(result.key, "studies/P01/sess-1/03-dashboard-task-2026-08-21T17-00-00Z.json");
    const session = JSON.parse(await readFile(join(dir, result.key), "utf8"));
    assert.equal(session.participantId, "P01");
    assert.deepEqual(session.artifactFiles, [
      "dashboards/checkpoint-01.json",
      "dashboards/checkpoint-01.png",
      "dashboards/final.json",
      "questionnaires/post.json",
      "study-runner-state.json",
    ]);
    assert.equal(session.artifacts, undefined);
    const json = JSON.parse(
      await readFile(join(dir, "studies/P01/sess-1/dashboards/checkpoint-01.json"), "utf8"),
    );
    assert.equal(json.dashboard.title, "Original");
    const png = await readFile(join(dir, "studies/P01/sess-1/dashboards/checkpoint-01.png"));
    assert.deepEqual([...png], [137, 80, 78, 71]);
    const questionnaire = JSON.parse(
      await readFile(join(dir, "studies/P01/sess-1/questionnaires/post.json"), "utf8"),
    );
    assert.equal(questionnaire.assessment, "post");
    const runner = JSON.parse(
      await readFile(join(dir, "studies/P01/sess-1/study-runner-state.json"), "utf8"),
    );
    assert.equal(runner.phase, "complete");
  } finally {
    if (previousDir === undefined) delete process.env.STUDY_DATA_DIR;
    else process.env.STUDY_DATA_DIR = previousDir;
    if (previousForce === undefined) delete process.env.STUDY_FORCE_LOCAL;
    else process.env.STUDY_FORCE_LOCAL = previousForce;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveStudySession rejects artifact paths that leave the session folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vizier-study-"));
  const previousDir = process.env.STUDY_DATA_DIR;
  const previousForce = process.env.STUDY_FORCE_LOCAL;
  process.env.STUDY_DATA_DIR = dir;
  process.env.STUDY_FORCE_LOCAL = "1";
  try {
    await assert.rejects(
      () => saveStudySession({
        participantId: "P01",
        sessionId: "sess-1",
        artifacts: [{ path: "../secret.json", text: "{}" }],
      }),
      /INVALID_BUNDLE/,
    );
  } finally {
    if (previousDir === undefined) delete process.env.STUDY_DATA_DIR;
    else process.env.STUDY_DATA_DIR = previousDir;
    if (previousForce === undefined) delete process.env.STUDY_FORCE_LOCAL;
    else process.env.STUDY_FORCE_LOCAL = previousForce;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveStudySession rejects unrecognized top-level artifact folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vizier-study-"));
  const previousDir = process.env.STUDY_DATA_DIR;
  const previousForce = process.env.STUDY_FORCE_LOCAL;
  process.env.STUDY_DATA_DIR = dir;
  process.env.STUDY_FORCE_LOCAL = "1";
  try {
    await assert.rejects(
      () => saveStudySession({
        participantId: "P01",
        sessionId: "sess-1",
        artifacts: [{ path: "other/file.json", text: "{}" }],
      }),
      /INVALID_BUNDLE/,
    );
  } finally {
    if (previousDir === undefined) delete process.env.STUDY_DATA_DIR;
    else process.env.STUDY_DATA_DIR = previousDir;
    if (previousForce === undefined) delete process.env.STUDY_FORCE_LOCAL;
    else process.env.STUDY_FORCE_LOCAL = previousForce;
    await rm(dir, { recursive: true, force: true });
  }
});
