/**
 * Study-session telemetry (user-study data collection).
 *
 * The product's own interaction journal (state.interactionJournal) is capped at
 * 100 events and is wiped on every page load, so it cannot serve as research
 * data. This module keeps a SEPARATE, uncapped, refresh-surviving record of the
 * session for the study, independent of the product logic.
 *
 * Every recorded event carries the four required base fields — participantId,
 * sessionId, timestamp, logId — plus the semantic fields the product already
 * produces. The full session bundle (events + a snapshot of the before/after
 * dashboards, critiques, decisions, rationales, and context) is uploaded to the
 * backend (which stores it in S3) and can also be downloaded locally as a backup.
 *
 * Design rules:
 *  - Telemetry must NEVER break the product: every entry point is guarded so a
 *    logging failure cannot throw into the app's critical paths.
 *  - No secrets live here; upload goes through the same-origin backend, which
 *    holds the AWS credentials.
 */
import { reApiBase, saveStudyData } from "./api-client.js";

/** localStorage key. Preserved across the app's startup storage wipe (see the
 * keep-list in app.js) so a mid-session refresh or crash does not lose data. */
export const STUDY_STORAGE_KEY = "vizierStudySession";

let session = null; // active/complete session metadata, or null
let events = []; // uncapped, ordered event log for the session
let nextLogId = 1; // monotonic per-session Log ID
let persistScheduled = false;

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

function persistNow() {
  persistScheduled = false;
  try {
    if (!session) {
      localStorage.removeItem(STUDY_STORAGE_KEY);
      return;
    }
    localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify({ session, events, nextLogId }));
  } catch {
    /* storage full/unavailable — the in-memory log is still authoritative */
  }
}

/** Debounced persistence: recording is frequent; coalesce writes to a microtask. */
function schedulePersist() {
  if (persistScheduled) return;
  persistScheduled = true;
  const flush = () => persistNow();
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
    return studySessionInfo();
  } catch {
    return null;
  }
}

export function startStudySession(info = {}) {
  session = {
    active: true,
    participantId: String(info.participantId || "").trim() || `anon-${uuid().slice(0, 8)}`,
    condition: String(info.condition || "").trim(),
    facilitator: String(info.facilitator || "").trim(),
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
  };
  events = [];
  nextLogId = 1;
  persistNow();
  recordStudyAction("session_started", `Study session started for ${session.participantId}`, {
    condition: session.condition,
    facilitator: session.facilitator,
  });
  return studySessionInfo();
}

/** Stamp and store one event. `event` is a product journal event (already has
 * kind/summary/detail/critiqueId/dimension/…); we add the four base fields plus
 * a relative timestamp. Study-only fields can be merged via `extra`. No-ops when
 * inactive, and never throws. */
export function recordStudyEvent(event, extra = null) {
  try {
    if (!isStudyActive() || !event) return null;
    const record = {
      participantId: session.participantId,
      sessionId: session.sessionId,
      timestamp: nowIso(),
      logId: nextLogId++,
      tRelMs: Date.now() - session.startedAtMs,
      ...event,
    };
    if (extra && typeof extra === "object") Object.assign(record, extra);
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

export function buildStudyBundle(snapshot = null, reason = "manual") {
  const savedAt = nowIso();
  return {
    schema: "vizier-study-session/1",
    bundleId: `${session ? session.sessionId : "no-session"}-${savedAt}`,
    reason,
    participantId: session ? session.participantId : null,
    sessionId: session ? session.sessionId : null,
    condition: session ? session.condition : null,
    facilitator: session ? session.facilitator : null,
    notes: session ? session.notes : null,
    startedAt: session ? session.startedAt : null,
    endedAt: session ? session.endedAt : null,
    savedAt,
    userAgent: session ? session.userAgent : null,
    viewport: session ? session.viewport : null,
    eventCount: events.length,
    events: events.slice(),
    dashboard: snapshot,
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
    const safe = (value) => String(value || "na").replace(/[^A-Za-z0-9._-]+/g, "-");
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vizier-study-${safe(bundle.participantId)}-${safe(bundle.sessionId)}-${safe(bundle.savedAt)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

export function endStudySession() {
  if (session) {
    session.active = false;
    session.endedAt = nowIso();
    persistNow();
  }
  return studySessionInfo();
}

/** Permanently drop the local session (used when abandoning a run). */
export function discardStudySession() {
  session = null;
  events = [];
  nextLogId = 1;
  persistNow();
}
