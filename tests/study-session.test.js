import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStudyBundle,
  buildStudyDashboardArtifacts,
  buildUncompressedZip,
  endStudySession,
  recordStudyAction,
  startStudySession,
  stripVersionMedia,
  takeStudyRequestLink,
} from "../src/study-session.js";

const lineSpec = {
  mark: "line",
  data: { values: [{ week: 1, sales: 10 }] },
  encoding: { x: { field: "week" }, y: { field: "sales" } },
};

function version(id, kind, png) {
  return {
    id,
    kind,
    label: kind === "initial" ? "Checkpoint 1 · Original Dashboard" : `Checkpoint ${id}`,
    afterSnapshot: {
      specMap: { trend: lineSpec },
      board: {
        title: `Dashboard ${id}`,
        subtitle: "",
        hasKpis: false,
        canvasWidth: 1100,
        canvasHeight: 720,
        tiles: [{ id: "trend", title: "Trend", bounds: { x: 28, y: 96, w: 508, h: 258 } }],
      },
    },
    afterScreenshot: "data:image/webp;base64,thumb",
    afterPng: png || null,
    afterSvg: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    beforeScreenshot: "data:image/webp;base64,before",
  };
}

test("stripVersionMedia drops in-app screenshots so the session JSON stays small", () => {
  const stripped = stripVersionMedia([version(1, "initial", "data:image/png;base64,aaa")]);
  assert.equal(stripped[0].id, 1);
  assert.ok(stripped[0].afterSnapshot.specMap.trend);
  assert.equal(stripped[0].afterScreenshot, undefined);
  assert.equal(stripped[0].beforeScreenshot, undefined);
  assert.equal(stripped[0].afterPng, undefined);
  assert.equal(stripped[0].afterSvg, undefined);
});

test("buildStudyDashboardArtifacts writes PNG and JSON for every checkpoint plus final", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const artifacts = buildStudyDashboardArtifacts({
    versions: [version(1, "initial", png), version(2, "revision", png)],
    finalDocument: {
      dashboard: { id: "final", title: "Live board" },
      tiles: [{ id: "trend", spec: lineSpec }],
    },
    finalPng: png,
  });
  const paths = artifacts.map((item) => item.path);
  assert.deepEqual(paths, [
    "dashboards/checkpoint-01.json",
    "dashboards/checkpoint-01.png",
    "dashboards/checkpoint-02.json",
    "dashboards/checkpoint-02.png",
    "dashboards/final.json",
    "dashboards/final.png",
  ]);
  const firstJson = JSON.parse(artifacts[0].text);
  assert.equal(firstJson.dashboard.title, "Dashboard 1");
  assert.equal(firstJson.tiles[0].id, "trend");
  assert.equal(artifacts[1].contentType, "image/png");
  assert.equal(artifacts[1].encoding, "base64");
  assert.equal(artifacts[1].data, "iVBORw0KGgo=");
});

test("buildStudyDashboardArtifacts accepts PNG data URLs with extra parameters", () => {
  const artifacts = buildStudyDashboardArtifacts({
    versions: [version(1, "initial", "data:image/png;charset=utf-8;base64,iVBORw0KGgo=")],
    finalDocument: { dashboard: { id: "final", title: "Live board" }, tiles: [] },
    finalPng: "data:image/png;base64,iVBORw0KGgo=",
  });
  const png = artifacts.find((item) => item.path === "dashboards/checkpoint-01.png");
  assert.equal(png?.data, "iVBORw0KGgo=");
});

test("buildStudyDashboardArtifacts falls back to SVG when PNG capture is missing", () => {
  const artifacts = buildStudyDashboardArtifacts({
    versions: [version(1, "initial", null)],
    finalDocument: { dashboard: { id: "final", title: "Live board" }, tiles: [] },
    finalSvg: "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>",
  });
  const paths = artifacts.map((item) => item.path);
  assert.deepEqual(paths, [
    "dashboards/checkpoint-01.json",
    "dashboards/checkpoint-01.svg",
    "dashboards/final.json",
    "dashboards/final.svg",
  ]);
});

test("a study bundle keeps the event log and omits screenshot payloads", () => {
  startStudySession({ participantId: "P01" });
  const bundle = buildStudyBundle({
    dashboardTitle: "Workspace",
    versions: [version(1, "initial", "data:image/png;base64,aaa")],
  }, "end");
  assert.equal(bundle.participantId, "P01");
  assert.equal(bundle.reason, "end");
  assert.equal(bundle.dashboard.versions[0].afterScreenshot, undefined);
  assert.equal(bundle.dashboard.versions[0].afterPng, undefined);
  assert.equal(bundle.dashboard.versions[0].afterSvg, undefined);
  assert.ok(bundle.dashboard.versions[0].afterSnapshot);
});

test("study events carry schema v2 envelope fields and request parent links", () => {
  startStudySession({ participantId: "P01" });
  const first = recordStudyAction("critique_requested", "first", { requestId: "req-a" });
  assert.equal(first.eventName, "critique_requested");
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.participantId, "P01");
  assert.equal(first.sequenceNumber, first.logId);
  assert.equal(typeof first.tRelMs, "number");
  assert.ok("dashboardVersion" in first);
  assert.equal(first.appVersion, "0.2.0");
  const linkA = takeStudyRequestLink("req-a");
  const linkB = takeStudyRequestLink("req-b");
  assert.equal(linkA.requestId, "req-a");
  assert.equal(linkB.requestId, "req-b");
  assert.equal(linkB.parentRequestId, "req-a");
});

test("ending a session records session_ended then stops logging", () => {
  startStudySession({ participantId: "P02" });
  endStudySession({ reason: "end" });
  const bundle = buildStudyBundle(null, "end");
  const kinds = bundle.events.map((event) => event.kind);
  assert.ok(kinds.includes("session_started"));
  assert.ok(kinds.includes("session_ended"));
  assert.equal(recordStudyAction("should_not_log", "no"), null);
});

test("buildUncompressedZip stores named files that start with a ZIP signature", () => {
  const zip = buildUncompressedZip([
    { name: "dashboards/final.json", bytes: new TextEncoder().encode('{"ok":true}') },
    { name: "dashboards/final.png", bytes: new Uint8Array([137, 80, 78, 71]) },
  ]);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
  const asText = new TextDecoder().decode(zip);
  assert.match(asText, /dashboards\/final\.json/);
  assert.match(asText, /dashboards\/final\.png/);
});
