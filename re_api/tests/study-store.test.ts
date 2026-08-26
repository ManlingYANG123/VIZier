import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveStudySession } from "../src/study-store.ts";

test("saveStudySession writes every file into one folder per participant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vizier-study-"));
  const previousDir = process.env.STUDY_DATA_DIR;
  const previousForce = process.env.STUDY_FORCE_LOCAL;
  process.env.STUDY_DATA_DIR = dir;
  process.env.STUDY_FORCE_LOCAL = "1";
  try {
    const result = await saveStudySession({
      participantId: "P01",
      sessionId: "sess-1",
      fileName: "session-2026-08-21T17-00-00Z.json",
      savedAt: "2026-08-21T17:00:00.000Z",
      events: [{ kind: "session_started" }],
      artifacts: [
        {
          path: "dashboards/checkpoint-01.json",
          contentType: "application/json",
          text: JSON.stringify({ dashboard: { title: "Original" }, tiles: [] }),
        },
        {
          path: "checkpoint-01.png",
          contentType: "image/png",
          encoding: "base64",
          data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        },
        {
          path: "final.json",
          contentType: "application/json",
          text: JSON.stringify({ dashboard: { title: "Final" }, tiles: [] }),
        },
        {
          path: "scale-post-2026-08-21T17-00-00Z.json",
          contentType: "application/json",
          text: JSON.stringify({ assessment: "post", questionResponses: [] }),
        },
      ],
    });
    assert.equal(result.stored, "local");
    assert.equal(result.files.length, 5);
    assert.equal(result.key, "studies/P01/sess-1_session-2026-08-21T17-00-00Z.json");
    assert.deepEqual((await readdir(join(dir, "studies"))).sort(), ["P01"]);
    const names = (await readdir(join(dir, "studies/P01"))).sort();
    assert.deepEqual(names, [
      "sess-1_checkpoint-01.json",
      "sess-1_checkpoint-01.png",
      "sess-1_final.json",
      "sess-1_scale-post-2026-08-21T17-00-00Z.json",
      "sess-1_session-2026-08-21T17-00-00Z.json",
    ]);
    const session = JSON.parse(await readFile(join(dir, result.key), "utf8"));
    assert.equal(session.participantId, "P01");
    assert.deepEqual(session.artifactFiles, [
      "checkpoint-01.json",
      "checkpoint-01.png",
      "final.json",
      "scale-post-2026-08-21T17-00-00Z.json",
    ]);
    assert.equal(session.artifacts, undefined);
    const json = JSON.parse(
      await readFile(join(dir, "studies/P01/sess-1_checkpoint-01.json"), "utf8"),
    );
    assert.equal(json.dashboard.title, "Original");
    const png = await readFile(join(dir, "studies/P01/sess-1_checkpoint-01.png"));
    assert.deepEqual([...png], [137, 80, 78, 71]);
    const scale = JSON.parse(
      await readFile(join(dir, "studies/P01/sess-1_scale-post-2026-08-21T17-00-00Z.json"), "utf8"),
    );
    assert.equal(scale.assessment, "post");
  } finally {
    if (previousDir === undefined) delete process.env.STUDY_DATA_DIR;
    else process.env.STUDY_DATA_DIR = previousDir;
    if (previousForce === undefined) delete process.env.STUDY_FORCE_LOCAL;
    else process.env.STUDY_FORCE_LOCAL = previousForce;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveStudySession keeps two participants in separate folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vizier-study-"));
  const previousDir = process.env.STUDY_DATA_DIR;
  const previousForce = process.env.STUDY_FORCE_LOCAL;
  process.env.STUDY_DATA_DIR = dir;
  process.env.STUDY_FORCE_LOCAL = "1";
  try {
    await saveStudySession({
      participantId: "P01",
      sessionId: "sess-1",
      fileName: "session-a.json",
    });
    await saveStudySession({
      participantId: "P02",
      sessionId: "sess-2",
      fileName: "session-b.json",
    });
    assert.deepEqual((await readdir(join(dir, "studies"))).sort(), ["P01", "P02"]);
    assert.deepEqual(await readdir(join(dir, "studies/P01")), ["sess-1_session-a.json"]);
    assert.deepEqual(await readdir(join(dir, "studies/P02")), ["sess-2_session-b.json"]);
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
