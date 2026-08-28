/**
 * Study-session telemetry (user-study data collection).
 *
 * The product's own interaction journal (state.interactionJournal) is capped at
 * 100 events and is wiped on every page load, so it cannot serve as research
 * data. This module keeps a SEPARATE, uncapped, refresh-surviving record of the
 * session for the study, independent of the product logic.
 *
 * Every recorded event carries a stable envelope — eventName, schemaVersion,
 * participantId, sessionId, timestamp, tRelMs, logId, sequenceNumber,
 * dashboardId, dashboardVersion, appVersion — plus the semantic fields the
 * product already produces. The full session bundle (events + a snapshot of
 * the before/after dashboards, critiques, decisions, rationales, and context)
 * is uploaded to the backend (which stores it in S3) and can also be
 * downloaded locally as a backup.
 *
 * Design rules:
 *  - Telemetry must NEVER break the product: every entry point is guarded so a
 *    logging failure cannot throw into the app's critical paths.
 *  - No secrets live here; upload goes through the same-origin backend, which
 *    holds the AWS credentials.
 */
import { reApiBase, saveStudyData } from "./api-client.js";
import { dashboardDocumentFromSnapshot } from "./vega-dashboard-adapter.js";

/** localStorage key. Preserved across the app's startup storage wipe (see the
 * keep-list in app.js) so a mid-session refresh or crash does not lose data. */
export const STUDY_STORAGE_KEY = "vizierStudySession";
export const STUDY_SCHEMA_VERSION = 2;
export const STUDY_BUILD_ID = typeof __VIZIER_BUILD_ID__ !== "undefined"
  ? String(__VIZIER_BUILD_ID__)
  : "test";
export const STUDY_APP_VERSION = `0.2.0+${STUDY_BUILD_ID}`;
export const STUDY_PHASES = [
  "pre_assessment",
  "training",
  "practice",
  "brief_reading",
  "timed_task",
  "dashboard_task",
  "post_assessment",
  "post_session",
  "complete",
];
export const RESEARCHER_ANNOTATION_KINDS = [
  "assistance",
  "interruption",
  "technical_problem",
  "deviation",
  "bookmark",
];

let session = null; // active/complete session metadata, or null
let events = []; // uncapped, ordered event log for the session
let nextLogId = 1; // monotonic per-session Log ID
let persistScheduled = false;
let taskCapture = { snapshot: null, artifacts: [] };
let dashboardContextFn = null;
let notingLoggingStatus = false;

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through to the non-crypto id below */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newStudyId() {
  return uuid();
}

/** Remember this request so the next one can set parentRequestId. */
export function takeStudyRequestLink(requestId = null) {
  const parentRequestId = session?.lastRequestId || null;
  const id = requestId || uuid();
  if (session) session.lastRequestId = id;
  return { requestId: id, parentRequestId };
}

export function bumpStudyContextVersion() {
  if (!session) return null;
  session.contextVersion = (Number(session.contextVersion) || 0) + 1;
  return session.contextVersion;
}

/** App.js binds live dashboard id/version so every event can stamp them. */
export function bindStudyContext(fn) {
  dashboardContextFn = typeof fn === "function" ? fn : null;
}

function dashboardContext() {
  try {
    const value = dashboardContextFn?.();
    if (!value || typeof value !== "object") {
      return { dashboardId: null, dashboardVersion: null };
    }
    const version = Number(value.dashboardVersion);
    return {
      dashboardId: value.dashboardId ?? null,
      dashboardVersion: Number.isFinite(version) ? version : null,
    };
  } catch {
    return { dashboardId: null, dashboardVersion: null };
  }
}

function persistNow() {
  persistScheduled = false;
  try {
    if (!session) {
      localStorage.removeItem(STUDY_STORAGE_KEY);
      return true;
    }
    localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify({ session, events, nextLogId, taskCapture }));
    return true;
  } catch {
    return false;
  }
}

function noteLoggingStatus(status, detail = "") {
  if (!session || session.loggingStatus === status || notingLoggingStatus) return;
  notingLoggingStatus = true;
  try {
    session.loggingStatus = status;
    if (isStudyActive()) {
      recordStudyAction("logging_status_changed", `Study logging ${status}`, {
        status,
        detail: detail || null,
      });
    }
  } finally {
    notingLoggingStatus = false;
  }
}

/** Debounced persistence: recording is frequent; coalesce writes to a microtask. */
function schedulePersist() {
  if (persistScheduled) return;
  persistScheduled = true;
  const flush = () => {
    const ok = persistNow();
    if (!session) return;
    if (!ok) noteLoggingStatus("degraded", "localStorage persist failed");
    else if (session.loggingStatus === "degraded") {
      noteLoggingStatus("recovered", "localStorage persist recovered");
    }
  };
  if (typeof queueMicrotask === "function") queueMicrotask(flush);
  else Promise.resolve().then(flush);
}

export function isStudyActive() {
  return !!(session && session.active);
}

export function studySessionInfo() {
  if (!session) return null;
  return { ...session, eventCount: events.length };
}

export function studyEventLog() {
  return events.slice();
}

/** Restore an in-progress (or just-ended) session from localStorage. Called by
 * app.js AFTER its startup storage-preserve step. Returns the restored session
 * info, or null when there was nothing to restore. */
export function restoreStudySession() {
  try {
    const raw = localStorage.getItem(STUDY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.session) return null;
    session = parsed.session;
    events = Array.isArray(parsed.events) ? parsed.events : [];
    nextLogId = Number(parsed.nextLogId) || events.length + 1;
    const captured = parsed.taskCapture && typeof parsed.taskCapture === "object" ? parsed.taskCapture : null;
    taskCapture = {
      snapshot: captured?.snapshot && typeof captured.snapshot === "object" ? captured.snapshot : null,
      artifacts: Array.isArray(captured?.artifacts) ? captured.artifacts : [],
    };
    return studySessionInfo();
  } catch {
    return null;
  }
}

export function startStudySession(info = {}) {
  session = {
    active: true,
    participantId: String(info.participantId || "").trim() || `anon-${uuid().slice(0, 8)}`,
    groupId: String(info.groupId || "").trim() || null,
    notes: String(info.notes || "").trim(),
    sessionId: uuid(),
    startedAt: nowIso(),
    startedAtMs: Date.now(),
    endedAt: null,
    userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
    viewport:
      typeof window !== "undefined"
        ? { width: window.innerWidth, height: window.innerHeight }
        : null,
    loggingStatus: "started",
    studyPhase: null,
    schemaVersion: STUDY_SCHEMA_VERSION,
    appVersion: STUDY_APP_VERSION,
    buildId: STUDY_BUILD_ID,
    contextVersion: 0,
    lastRequestId: null,
  };
  events = [];
  nextLogId = 1;
  taskCapture = { snapshot: null, artifacts: [] };
  persistNow();
  recordStudyAction("session_started", `Study session started for ${session.participantId}`, {
    groupId: session.groupId,
  });
  recordStudyAction("logging_status_changed", "Study logging started", { status: "started" });
  return studySessionInfo();
}

/** Stamp and store one event. `event` is a product journal event (already has
 * kind/summary/detail/critiqueId/dimension/…); we add the four base fields plus
 * a relative timestamp. Study-only fields can be merged via `extra`. No-ops when
 * inactive, and never throws. */
export function recordStudyEvent(event, extra = null) {
  try {
    if (!isStudyActive() || !event) return null;
    const logId = nextLogId++;
    const kind = String(event.kind || extra?.kind || "study_action");
    const dash = dashboardContext();
    const phaseTransition = kind === "study_phase_changed";
    const record = {
      ...event,
      ...(extra && typeof extra === "object" ? extra : null),
      eventName: kind,
      kind,
      schemaVersion: STUDY_SCHEMA_VERSION,
      participantId: session.participantId,
      sessionId: session.sessionId,
      timestamp: nowIso(),
      tRelMs: Date.now() - session.startedAtMs,
      logId,
      sequenceNumber: logId,
      studyPhase: session.studyPhase || null,
      dashboardId: phaseTransition ? null : dash.dashboardId,
      dashboardVersion: phaseTransition ? null : dash.dashboardVersion,
      appVersion: STUDY_APP_VERSION,
      buildId: STUDY_BUILD_ID,
    };
    events.push(record);
    schedulePersist();
    return record;
  } catch {
    return null;
  }
}

/** Record a study-only action that is not a product journal event (e.g. UI-only
 * signals such as "critique displayed", "scrolled past", "time spent"). */
export function recordStudyAction(kind, summary, data = null) {
  const event = { kind: String(kind || "study_action"), summary: String(summary || "") };
  if (data && typeof data === "object" && Object.keys(data).length) event.data = data;
  return recordStudyEvent(event);
}

export function setStudyPhase(phase) {
  const next = String(phase || "").trim();
  if (!STUDY_PHASES.includes(next) || !isStudyActive() || !session) return null;
  const from = session.studyPhase || null;
  if (from === next) return null;
  session.studyPhase = next;
  return recordStudyAction("study_phase_changed", `Study phase: ${next}`, { from, to: next });
}

export function recordResearcherAnnotation(kind, note = "", extra = {}) {
  const annotationKind = String(kind || "").trim();
  if (!RESEARCHER_ANNOTATION_KINDS.includes(annotationKind)) return null;
  return recordStudyAction(
    "researcher_annotation",
    note ? `${annotationKind}: ${note}` : annotationKind,
    {
      annotationKind,
      note: String(note || "").trim() || null,
      ...(extra && typeof extra === "object" ? extra : {}),
    },
  );
}

const SVG_DATA_PREFIX = "data:image/svg+xml";

export function dashboardFileSlug(id, kind = "checkpoint") {
  if (kind === "final") return "final";
  const n = Number(id);
  const padded = Number.isFinite(n) ? String(Math.max(0, Math.trunc(n))).padStart(2, "0") : "00";
  return `checkpoint-${padded}`;
}

export function stripVersionMedia(versions = []) {
  return (Array.isArray(versions) ? versions : []).map((version) => {
    if (!version || typeof version !== "object") return version;
    const {
      beforeSnapshot: _beforeSnapshot,
      afterSnapshot: _afterSnapshot,
      beforeScreenshot: _beforeScreenshot,
      afterScreenshot: _afterScreenshot,
      afterPng: _afterPng,
      afterSvg: _afterSvg,
      screenshot: _screenshot,
      ...rest
    } = version;
    return rest;
  });
}

/** Keep only the compact checkpoint thumbnail for phase-local workspace
 * persistence. Full PNG/SVG exports are intentionally omitted from
 * localStorage, but dropping the thumbnail as well makes every checkpoint look
 * broken after a refresh or study-stage restore. */
export function compactVersionMediaForWorkspace(versions = []) {
  return (Array.isArray(versions) ? versions : []).map((version) => {
    if (!version || typeof version !== "object") return version;
    const {
      beforeScreenshot: _beforeScreenshot,
      afterPng: _afterPng,
      afterSvg: _afterSvg,
      screenshot: _screenshot,
      ...compact
    } = version;
    return compact;
  });
}

function prepareStudySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  return {
    ...snapshot,
    versions: stripVersionMedia(snapshot.versions),
  };
}

function pngBase64(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:image\/png(?:;[^,]*)?,/i.exec(dataUrl);
  if (!match) return null;
  return dataUrl.slice(match[0].length) || null;
}

function svgMarkup(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("<svg")) return value;
  if (!value.startsWith(SVG_DATA_PREFIX)) return null;
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const payload = value.slice(comma + 1);
  if (/;base64/i.test(value.slice(0, comma))) {
    try {
      return atob(payload);
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function studyArtifactName(path) {
  return String(path || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

function pushBoardImage(artifacts, slug, pngDataUrl, svgFallback) {
  const png = pngBase64(pngDataUrl);
  if (png) {
    artifacts.push({
      path: `${slug}.png`,
      contentType: "image/png",
      encoding: "base64",
      data: png,
    });
    return;
  }
  const svg = svgMarkup(svgFallback);
  if (svg && svg.length <= 2_000_000) {
    artifacts.push({
      path: `${slug}.svg`,
      contentType: "image/svg+xml",
      text: svg,
    });
  }
}

export function buildStudyDashboardArtifacts({
  versions = [],
  finalDocument = null,
  finalPng = null,
  finalSvg = null,
} = {}) {
  const artifacts = [];
  for (const version of Array.isArray(versions) ? versions : []) {
    const slug = dashboardFileSlug(version?.id, "checkpoint");
    if (version?.afterSnapshot) {
      artifacts.push({
        path: `${slug}.json`,
        contentType: "application/json",
        text: JSON.stringify(
          dashboardDocumentFromSnapshot(version.afterSnapshot, slug),
          null,
          2,
        ),
      });
    }
    pushBoardImage(artifacts, slug, version?.afterPng, version?.afterSvg || version?.afterScreenshot);
  }
  if (finalDocument) {
    artifacts.push({
      path: "final.json",
      contentType: "application/json",
      text: JSON.stringify(finalDocument, null, 2),
    });
  }
  pushBoardImage(artifacts, "final", finalPng, finalSvg);
  return artifacts;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

export function buildUncompressedZip(files = []) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(String(file.name || "file"));
    const data = file.bytes instanceof Uint8Array ? file.bytes : encoder.encode(String(file.bytes || ""));
    const crc = crc32(data);
    const local = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0),
      name, data,
    ]);
    const central = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concatBytes(centrals);
  const eocd = concatBytes([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralDir.length), u32(offset), u16(0),
  ]);
  return concatBytes([...locals, centralDir, eocd]);
}

function artifactBytes(artifact) {
  if (artifact?.encoding === "base64" && typeof artifact.data === "string") {
    const binary = atob(artifact.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(String(artifact?.text || ""));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeDownloadName(value) {
  return String(value || "na").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Filesystem-safe UTC stamp: 2026-08-23T22-21-41Z */
export function studyFileStamp(iso = nowIso()) {
  const text = String(iso || nowIso());
  const date = new Date(text);
  const source = Number.isNaN(date.getTime()) ? text : date.toISOString();
  return source.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export function studyRecordFileName({
  recordKind = "phase-log",
} = {}) {
  if (recordKind === "scale") return "scale-post.json";
  return "session.json";
}

export function buildStudyBundle(snapshot = null, reason = "manual", options = {}) {
  const savedAt = nowIso();
  const recordKind = options.recordKind || "phase-log";
  const phase = options.phase ?? (session ? session.studyPhase : null);
  const eventList = Array.isArray(options.events) ? options.events.slice() : events.slice();
  return {
    schema: "vizier-study-session/2",
    schemaVersion: STUDY_SCHEMA_VERSION,
    appVersion: STUDY_APP_VERSION,
    buildId: STUDY_BUILD_ID,
    recordKind,
    studyPhase: phase,
    phase,
    loggingStatus: session ? session.loggingStatus : null,
    bundleId: `${session ? session.sessionId : "no-session"}-${savedAt}`,
    fileName: options.fileName || studyRecordFileName({
      recordKind,
      phase,
      assessment: options.assessment,
      savedAt,
    }),
    reason,
    participantId: session ? session.participantId : null,
    groupId: session ? session.groupId : null,
    sessionId: session ? session.sessionId : null,
    notes: session ? session.notes : null,
    startedAt: session ? session.startedAt : null,
    endedAt: session ? session.endedAt : null,
    savedAt,
    userAgent: session ? session.userAgent : null,
    viewport: session ? session.viewport : null,
    eventCount: eventList.length,
    events: eventList,
    dashboard: recordKind === "scale" ? null : prepareStudySnapshot(snapshot),
  };
}

export function buildStudyScaleRecord({
  phase,
  scaleResponses = [],
  questionsPresented = [],
  submittedAt = null,
} = {}) {
  const savedAt = nowIso();
  return {
    schema: "vizier-study-scale/1",
    schemaVersion: 1,
    appVersion: STUDY_APP_VERSION,
    buildId: STUDY_BUILD_ID,
    recordKind: "scale",
    assessment: "post",
    phase: phase || "post_assessment",
    participantId: session ? session.participantId : null,
    groupId: session ? session.groupId : null,
    sessionId: session ? session.sessionId : null,
    submittedAt: submittedAt || savedAt,
    savedAt,
    instrumentVersion: "vizier-study-scales-v1",
    questionsPresented: Array.isArray(questionsPresented) ? questionsPresented : [],
    scaleResponses: Array.isArray(scaleResponses) ? scaleResponses : [],
    fileName: studyRecordFileName({ recordKind: "scale", savedAt }),
  };
}

export async function saveStudySessionToServer(bundle) {
  return saveStudyData(bundle);
}

/** Best-effort save that survives page unload (sendBeacon cannot be awaited). */
export function beaconSaveStudySession(bundle) {
  try {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
    const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
    return navigator.sendBeacon(`${reApiBase()}/study-session`, blob);
  } catch {
    return false;
  }
}

export function exportStudyBundleLocal(bundle) {
  try {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    downloadBlob(
      blob,
      `vizier-study-${safeDownloadName(bundle.fileName || `${bundle.participantId}-${bundle.sessionId}-${bundle.savedAt}`)}`.replace(/\.json$/i, "") + ".json",
    );
    return true;
  } catch {
    return false;
  }
}

export function buildStudyBackupFiles(artifacts = [], bundle = {}) {
  const files = [];
  const names = new Set();
  if (bundle && typeof bundle === "object") {
    files.push({
      name: "session.json",
      bytes: new TextEncoder().encode(JSON.stringify(bundle, null, 2)),
    });
    names.add("session.json");
  }
  for (const artifact of artifacts || []) {
    const name = studyArtifactName(artifact?.path);
    if (!name || name === "." || name === ".." || names.has(name)) continue;
    names.add(name);
    files.push({ name, bytes: artifactBytes(artifact) });
  }
  return files;
}

export function exportStudyBackupZip(artifacts = [], bundle = {}) {
  try {
    const files = buildStudyBackupFiles(artifacts, bundle);
    if (!files.length) return false;
    downloadBlob(
      new Blob([buildUncompressedZip(files)], { type: "application/zip" }),
      `vizier-study-${safeDownloadName(bundle.participantId)}-${safeDownloadName(bundle.sessionId)}-backup.zip`,
    );
    return true;
  } catch {
    return false;
  }
}

export function endStudySession({ reason = "end", recordEvent = true } = {}) {
  if (!session) return null;
  if (recordEvent && session.active) {
    noteLoggingStatus("stopped", reason);
    recordStudyAction("session_ended", "Study session ended", {
      reason,
      eventCount: events.length + 1,
    });
  } else if (session) {
    session.loggingStatus = "stopped";
  }
  session.active = false;
  session.endedAt = nowIso();
  persistNow();
  return studySessionInfo();
}

/** Permanently drop the local session (used when abandoning a run). */
export function discardStudySession() {
  session = null;
  events = [];
  nextLogId = 1;
  taskCapture = { snapshot: null, artifacts: [] };
  persistNow();
}

/** Keep the dashboard-task snapshot across the post-assessment reload so the
 * session writes one JSON file at the end, not a mid-task file. */
export function stashStudyTaskCapture(snapshot, artifacts = []) {
  const next = {
    snapshot: snapshot && typeof snapshot === "object" ? snapshot : null,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
  };
  taskCapture = next;
  if (persistNow()) return;
  // Snapshot without PNG payloads may still fit when the full capture does not.
  taskCapture = { snapshot: next.snapshot, artifacts: [] };
  persistNow();
  taskCapture = next;
}

export function studyTaskCapture() {
  return {
    snapshot: taskCapture.snapshot,
    artifacts: Array.isArray(taskCapture.artifacts) ? taskCapture.artifacts.slice() : [],
  };
}
