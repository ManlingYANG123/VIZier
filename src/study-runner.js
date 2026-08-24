/*
THESIS: One quiet study path reveals only the tool needed now, moving from practice to formal use to a closing questionnaire and interview.
OWN-WORLD: The incumbent VIZier grayscale system, firm rules, compact controls, and one dark primary action continue across a wider research canvas.
STORY: A participant enters an anonymous ID, practices with guidance, uses VIZier formally, completes the questionnaire and interview, and finishes without seeing counterbalancing codes.
FIRST VIEWPORT: A restrained study header and single participant-ID field lead directly to Begin; each stage exposes only the controls needed for that work.
FORM: Operate mode, staged as a three-part session runner with a persistent progress line and phase-specific workspace.
*/
import embed from "vega-embed";
import "./styles.css";
import { normalizeDashboardDocument } from "./vega-dashboard-adapter.js";
import {
  buildStudyBundle,
  discardStudySession,
  endStudySession,
  exportStudyBackupZip,
  isStudyActive,
  recordStudyAction,
  restoreStudySession,
  saveStudySessionToServer,
  setStudyPhase,
  startStudySession,
  studySessionInfo,
  studyTaskCapture,
} from "./study-session.js";
import {
  POST_QUESTIONS,
  scaleSectionsForAssessment,
  serializeQuestionResponses,
  serializeScaleResponses,
  STUDY_GROUPS,
  STUDY_PHASE_INTROS,
  STUDY_RUNNER_PHASES,
  assessmentKeyForPhase,
  createStudyRunnerState,
  formatStudyPhaseTimer,
  isDashboardTaskPhase,
  isStudyRunnerState,
  makeAnnotation,
  materialForPhase,
  nextStudyPhase,
  normalizeStudyPhase,
  operationStudyScreenId,
  previousStudyScreenId,
  startStudyPhaseTimerSegment,
  stopStudyPhaseTimerSegment,
  studyPhaseTimerIsRunning,
  studyPhaseLabel,
  studyPhaseNumber,
  studyPhaseTimerElapsedMs,
  studyPhaseUsesVizier,
  studyRunnerStorageKey,
  studyScreenDescriptor,
  studyScreenIdForState,
} from "./study-runner-model.js";

let runnerState = null;
let runnerGroup = null;
let dashboardResizeObserver = null;
let annotationMode = false;
let draftRegion = null;
let editingAnnotationId = null;
let assessmentViews = [];
let assessmentCanvas = null;
let assessmentCanvasAbortController = null;
let assessmentCanvasTelemetryTimer = null;
let stageTimerInterval = null;
let studyNavigationBusy = false;
let studyBrowserHistoryBound = false;

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clone(value) {
  return structuredClone(value);
}

function runnerKey() {
  return studyRunnerStorageKey(runnerGroup.id);
}

function loadRunnerState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(runnerKey()) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    const normalized = { ...parsed, phase: normalizeStudyPhase(parsed.phase) };
    return isStudyRunnerState(normalized, runnerGroup.id) ? normalized : null;
  } catch {
    return null;
  }
}

function persistRunnerState() {
  if (!runnerState) return;
  runnerState.updatedAt = new Date().toISOString();
  localStorage.setItem(runnerKey(), JSON.stringify(runnerState));
}

function ensureAssessmentState(key) {
  const fallback = {
    annotations: [],
    answers: {},
    scales: {},
    filters: {},
    canvasView: null,
    questionnaireScrollTop: 0,
    submissions: [],
    submittedAt: null,
  };
  runnerState.assessments ||= {};
  runnerState.assessments[key] = { ...fallback, ...(runnerState.assessments[key] || {}) };
  runnerState.assessments[key].annotations = Array.isArray(runnerState.assessments[key].annotations)
    ? runnerState.assessments[key].annotations
    : [];
  runnerState.assessments[key].submissions = Array.isArray(runnerState.assessments[key].submissions)
    ? runnerState.assessments[key].submissions
    : [];
  return runnerState.assessments[key];
}

function appendAssessmentSubmission(assessment, submission) {
  assessment.submissions ||= [];
  assessment.submissions.push({
    id: `submission-${assessment.submissions.length + 1}`,
    ...clone(submission),
  });
}

function ensureRunnerNavigation() {
  if (!runnerState) return null;
  const currentScreenId = studyScreenIdForState(runnerState);
  const existing = runnerState.navigation && typeof runnerState.navigation === "object"
    ? runnerState.navigation
    : {};
  const history = Array.isArray(existing.history)
    ? existing.history.filter((screenId) => studyScreenDescriptor(screenId))
    : [];
  let historyIndex = Number.isInteger(existing.historyIndex)
    ? Math.max(0, Math.min(existing.historyIndex, Math.max(0, history.length - 1)))
    : history.length - 1;
  if (!history.length) {
    history.push(currentScreenId);
    historyIndex = 0;
  } else if (history[historyIndex] !== currentScreenId) {
    history.splice(historyIndex + 1);
    history.push(currentScreenId);
    historyIndex = history.length - 1;
  }
  runnerState.navigation = {
    currentScreenId,
    history,
    historyIndex,
    reopenings: Array.isArray(existing.reopenings) ? existing.reopenings : [],
  };
  runnerState.workspaces ||= {};
  return runnerState.navigation;
}

function currentStudyScreenId() {
  return ensureRunnerNavigation()?.currentScreenId || null;
}

function previousScreenForCurrent() {
  const navigation = ensureRunnerNavigation();
  if (!navigation || navigation.currentScreenId === "complete") return null;
  if (navigation.historyIndex > 0) {
    return navigation.history[navigation.historyIndex - 1];
  }
  return previousStudyScreenId(navigation.currentScreenId);
}

function ensurePhaseTimers() {
  runnerState.phaseTimers ||= {};
  return runnerState.phaseTimers;
}

function activePhaseTimer() {
  if (!runnerState || runnerState.phase === "complete") return null;
  return ensurePhaseTimers()[normalizeStudyPhase(runnerState.phase)] || null;
}

function clearStageTimerTicker() {
  if (stageTimerInterval !== null) clearInterval(stageTimerInterval);
  stageTimerInterval = null;
}

function updateStageTimerDisplay() {
  const output = document.getElementById("studyStageTimer");
  const timer = activePhaseTimer();
  if (!output || !timer) return;
  output.textContent = formatStudyPhaseTimer(studyPhaseTimerElapsedMs(timer));
}

function wireStageTimerControl() {
  const button = document.getElementById("studyStartStageTimer");
  if (!button) return;
  button.addEventListener("click", () => {
    startPhaseTimer(runnerState.phase, new Date().toISOString(), "operation-page");
    button.remove();
    document.querySelector(".study-stage-timer")?.classList.add("is-running");
    startStageTimerTicker();
    document.dispatchEvent(new CustomEvent("vizier:practice-action", {
      detail: { type: "timer:started", phase: runnerState.phase },
    }));
  }, { once: true });
}

function startStageTimerTicker() {
  clearStageTimerTicker();
  if (!document.getElementById("studyStageTimer") || !studyPhaseTimerIsRunning(activePhaseTimer())) return;
  updateStageTimerDisplay();
  stageTimerInterval = setInterval(updateStageTimerDisplay, 1000);
}

function stageTimerMarkup(className = "") {
  if (!runnerState || runnerState.phase === "complete") return "";
  const timer = activePhaseTimer();
  const running = studyPhaseTimerIsRunning(timer);
  const elapsed = studyPhaseTimerElapsedMs(timer);
  return `<div class="study-stage-timer ${escapeHTML(className)}" aria-label="Elapsed time in ${escapeHTML(studyPhaseLabel(runnerState.phase))}">
    <span>Stage time</span><time id="studyStageTimer">${formatStudyPhaseTimer(elapsed)}</time>
    ${running ? "" : '<button type="button" id="studyStartStageTimer">Start timer</button>'}
  </div>`;
}

function startPhaseTimer(phase, startedAt = new Date().toISOString(), source = "participant") {
  const normalized = normalizeStudyPhase(phase);
  const timers = ensurePhaseTimers();
  if (studyPhaseTimerIsRunning(timers[normalized])) return timers[normalized];
  const timer = startStudyPhaseTimerSegment(timers[normalized], {
    startedAt,
    reason: timers[normalized] ? "reopened" : "initial",
    source,
  });
  timers[normalized] = timer;
  persistRunnerState();
  const segment = timer.segments[timer.segments.length - 1];
  recordStudyAction("study_phase_timer_started", `Started timer for ${studyPhaseLabel(normalized)}`, {
    phase: normalized,
    part: studyPhaseNumber(normalized),
    startedAt,
    source,
    segmentId: segment.id,
    segmentReason: segment.reason,
    segmentNumber: timer.segments.length,
    accumulatedDurationMs: studyPhaseTimerElapsedMs(timer, Date.parse(startedAt)),
  });
  return timer;
}

function stopPhaseTimer(phase, completedAt = new Date().toISOString()) {
  const normalized = normalizeStudyPhase(phase);
  const timer = ensurePhaseTimers()[normalized];
  if (!studyPhaseTimerIsRunning(timer)) return timer || null;
  const completed = stopStudyPhaseTimerSegment(timer, completedAt);
  const segment = completed.segments[completed.segments.length - 1];
  const durationMs = completed.totalDurationMs;
  runnerState.phaseTimers[normalized] = completed;
  persistRunnerState();
  clearStageTimerTicker();
  recordStudyAction("study_phase_timer_completed", `Completed timer for ${studyPhaseLabel(normalized)}`, {
    phase: normalized,
    part: studyPhaseNumber(normalized),
    startedAt: segment.startedAt,
    completedAt,
    durationMs,
    durationSeconds: Math.round(durationMs / 1000),
    segmentId: segment.id,
    segmentReason: segment.reason,
    segmentDurationMs: segment.durationMs,
    segmentDurationSeconds: Math.round(segment.durationMs / 1000),
    segmentNumber: completed.segments.length,
    totalDurationMs: durationMs,
  });
  return completed;
}

function captureAssessmentInterfaceState(screen) {
  const key = screen.phase === "pre_assessment" ? "pre" : "post";
  const assessment = ensureAssessmentState(key);
  if (assessmentCanvas) {
    assessment.canvasView = {
      x: assessmentCanvas.x,
      y: assessmentCanvas.y,
      scale: assessmentCanvas.scale,
    };
  }
  const shell = document.querySelector(".study-runner-shell");
  if (screen.view === "questionnaire" && shell) {
    assessment.questionnaireScrollTop = shell.scrollTop;
  }
  const noteInput = document.getElementById("studyNoteText");
  if (noteInput) {
    assessment.noteDraft = {
      text: noteInput.value,
      region: draftRegion ? clone(draftRegion) : null,
      editingAnnotationId,
      kind: document.getElementById("studyNotesPanel")?.dataset.composing || "global",
    };
  } else {
    assessment.noteDraft = null;
  }
}

async function captureCurrentInterfaceState() {
  if (!runnerState) return;
  const screen = studyScreenDescriptor(currentStudyScreenId());
  if (!screen) return;
  if (screen.view === "review" || screen.view === "questionnaire") {
    captureAssessmentInterfaceState(screen);
  }
  if (screen.view === "workspace") {
    const app = await import("./app.js");
    if (typeof app.captureStudyRunnerWorkspaceState === "function") {
      runnerState.workspaces ||= {};
      runnerState.workspaces[screen.phase] = app.captureStudyRunnerWorkspaceState();
    }
  }
  persistRunnerState();
}

function applyStudyScreenState(screenId, direction = "forward") {
  const screen = studyScreenDescriptor(screenId);
  if (!screen) throw new Error(`Unknown study screen: ${screenId}`);
  const navigation = ensureRunnerNavigation();
  const currentId = navigation.currentScreenId;
  if (direction === "back") {
    if (navigation.historyIndex > 0 && navigation.history[navigation.historyIndex - 1] === screenId) {
      navigation.historyIndex -= 1;
    } else {
      navigation.history.splice(navigation.historyIndex, 0, screenId);
    }
  } else if (currentId !== screenId) {
    navigation.history.splice(navigation.historyIndex + 1);
    navigation.history.push(screenId);
    navigation.historyIndex = navigation.history.length - 1;
  }
  navigation.currentScreenId = screenId;
  runnerState.phase = screen.phase;
  if (screen.view === "review") runnerState.assessmentStep = "review";
  if (screen.view === "questionnaire") runnerState.assessmentStep = "questionnaire";
}

async function navigateToStudyScreen(screenId, {
  direction = "forward",
  source = "study-control",
  capture = true,
  historyMode = direction === "forward" ? "push" : "replace",
} = {}) {
  if (studyNavigationBusy) return false;
  const target = studyScreenDescriptor(screenId);
  const fromId = currentStudyScreenId();
  const from = studyScreenDescriptor(fromId);
  if (!target || !from || target.id === from.id) return false;
  studyNavigationBusy = true;
  try {
    if (capture) await captureCurrentInterfaceState();
    if (direction === "back" && from.phase !== target.phase) {
      if (studyPhaseTimerIsRunning(activePhaseTimer())) {
        stopPhaseTimer(from.phase, new Date().toISOString());
      }
      const reopening = {
        id: `reopen-${Date.now().toString(36)}`,
        fromScreenId: from.id,
        toScreenId: target.id,
        fromPhase: from.phase,
        phase: target.phase,
        reopenedAt: new Date().toISOString(),
      };
      ensureRunnerNavigation().reopenings.push(reopening);
      recordStudyAction("study_phase_reopened", `Reopened ${studyPhaseLabel(target.phase)}`, {
        ...reopening,
        source,
        timerRequiresManualRestart: true,
      });
    }
    applyStudyScreenState(screenId, direction);
    persistRunnerState();
    if (historyMode === "push") {
      window.history.pushState({ vizierStudyRunner: true, screenId }, "", location.href);
    } else if (historyMode === "replace") {
      window.history.replaceState({ vizierStudyRunner: true, screenId }, "", location.href);
    }
    setStudyPhase(target.phase);
    recordStudyAction(direction === "back" ? "study_screen_restored" : "study_screen_opened",
      direction === "back" ? `Returned to ${target.id}` : `Opened ${target.id}`, {
        fromScreenId: from.id,
        screenId: target.id,
        phase: target.phase,
        direction,
        source,
      });
    // The VIZier module owns the complete #app DOM. A hard reload is required
    // when crossing its boundary; otherwise the cached module cannot rebuild
    // the workspace after a neutral runner page replaced that DOM.
    if (from.view === "workspace" || target.view === "workspace") {
      location.reload();
      return true;
    }
    await renderCurrentPhase();
    return true;
  } finally {
    studyNavigationBusy = false;
  }
}

function bindStudyBrowserHistory() {
  if (studyBrowserHistoryBound) return;
  studyBrowserHistoryBound = true;
  window.addEventListener("popstate", (event) => {
    const targetId = event.state?.vizierStudyRunner ? event.state.screenId : null;
    const target = studyScreenDescriptor(targetId);
    const current = studyScreenDescriptor(currentStudyScreenId());
    if (!runnerState || !target || !current || target.id === current.id) return;
    if (current.view === "complete") {
      window.history.pushState({ vizierStudyRunner: true, screenId: current.id }, "", location.href);
      return;
    }
    const navigation = ensureRunnerNavigation();
    const targetIndex = navigation.history.lastIndexOf(target.id);
    const direction = targetIndex >= 0 && targetIndex < navigation.historyIndex ? "back" : "forward";
    if (direction === "back" && current.phase !== target.phase) {
      const confirmed = window.confirm(
        `Return to ${studyPhaseLabel(target.phase)}? This completed stage will reopen. The participant will need to start its timer again before continuing.`,
      );
      if (!confirmed) {
        window.history.pushState({ vizierStudyRunner: true, screenId: current.id }, "", location.href);
        return;
      }
    }
    void navigateToStudyScreen(target.id, {
      direction,
      source: "browser-history",
      historyMode: "none",
    });
  });
}

async function returnToPreviousStudyScreen(source = "back-control") {
  const current = studyScreenDescriptor(currentStudyScreenId());
  const previousId = previousScreenForCurrent();
  const previous = studyScreenDescriptor(previousId);
  if (!current || !previous) return false;
  if (current.phase !== previous.phase) {
    const confirmed = window.confirm(
      `Return to ${studyPhaseLabel(previous.phase)}? This completed stage will reopen. The participant will need to start its timer again before continuing.`,
    );
    if (!confirmed) return false;
  }
  return navigateToStudyScreen(previous.id, { direction: "back", source });
}

function studyBackButtonMarkup() {
  const previousId = previousScreenForCurrent();
  if (!previousId) return "";
  const previous = studyScreenDescriptor(previousId);
  const label = previous?.phase === runnerState.phase
    ? "Back"
    : `Reopen ${studyPhaseLabel(previous?.phase)}`;
  return `<button class="study-runner-back" id="studyRunnerBack" type="button" aria-label="${escapeHTML(label)}"><span aria-hidden="true">←</span><span>Back</span></button>`;
}

function wireStudyBackControl() {
  document.getElementById("studyRunnerBack")?.addEventListener("click", () => {
    void returnToPreviousStudyScreen();
  });
}

function progressMarkup() {
  const part = studyPhaseNumber(runnerState.phase);
  const label = studyPhaseLabel(runnerState.phase);
  return `
    <div class="study-runner-progress" aria-label="Study progress: part ${part} of 3">
      <span>Part ${part} of 3</span>
      <strong>${escapeHTML(label)}</strong>
      <span class="study-runner-progress-track" aria-hidden="true"><span style="width:${part * (100 / 3)}%"></span></span>
    </div>`;
}

function neutralShell(content, { className = "", showTimer = true } = {}) {
  clearStageTimerTicker();
  document.title = `${studyPhaseLabel(runnerState?.phase)} · VIZier Study`;
  document.querySelector("#app").innerHTML = `
    <div class="study-runner-shell ${className}">
      <header class="study-runner-topbar">
        <div class="study-runner-leading">
          <div class="study-runner-brand"><span aria-hidden="true">▦</span><strong>VIZier Study</strong></div>
          ${runnerState ? studyBackButtonMarkup() : ""}
        </div>
        ${runnerState ? progressMarkup() : ""}
        <div class="study-runner-status">${runnerState && showTimer ? stageTimerMarkup() : ""}<span class="study-runner-save-state">Progress saves automatically</span></div>
      </header>
      ${content}
    </div>`;
  startStageTimerTicker();
  wireStageTimerControl();
  wireStudyBackControl();
}

function telemetryPhase(phase) {
  setStudyPhase(phase);
  recordStudyAction("study_runner_phase_opened", `Opened ${studyPhaseLabel(phase)}`, {
    phase,
    groupId: runnerGroup.id,
    materialCode: materialForPhase(runnerGroup.id, phase)?.code || null,
  });
}

function startRunnerSession(participantId) {
  const current = studySessionInfo();
  if (isStudyActive() && current?.participantId !== participantId) {
    const replace = window.confirm(
      `A study session for ${current.participantId} is still active in this browser. Start a new session instead?`,
    );
    if (!replace) return false;
    discardStudySession();
  }
  if (!isStudyActive()) {
    startStudySession({ participantId, groupId: runnerGroup.id, notes: "Started from study runner" });
  }
  return true;
}

function renderWelcome() {
  const participantFromUrl = new URLSearchParams(location.search).get("participant") || "";
  neutralShell(`
    <main class="study-runner-welcome">
      <div class="study-runner-welcome-copy">
        <span>Dashboard review study</span>
        <h1>Welcome</h1>
        <p>This session has three stages: practice, formal use, and a questionnaire with interview prompts. You may pause or stop at any time.</p>
      </div>
      <form class="study-runner-start-form" id="studyRunnerStartForm">
        <label for="studyRunnerParticipant">Participant ID</label>
        <input id="studyRunnerParticipant" name="participant" value="${escapeHTML(participantFromUrl)}" autocomplete="off" spellcheck="false" placeholder="P014" required>
        <p class="study-runner-form-error" id="studyRunnerStartError" role="alert"></p>
        <button type="submit">Begin</button>
      </form>
    </main>`);
  const form = document.getElementById("studyRunnerStartForm");
  const input = document.getElementById("studyRunnerParticipant");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const participantId = input.value.trim();
    if (!participantId) {
      document.getElementById("studyRunnerStartError").textContent = "Enter the participant ID from the study sheet.";
      input.focus();
      return;
    }
    if (!startRunnerSession(participantId)) return;
    runnerState = createStudyRunnerState(runnerGroup.id, participantId);
    persistRunnerState();
    void renderCurrentPhase();
  });
  input.focus();
}

function renderPhaseIntro() {
  const phase = runnerState.phase;
  const intro = STUDY_PHASE_INTROS[phase];
  if (!intro) return false;
  const introPhases = STUDY_RUNNER_PHASES.filter((candidate) => STUDY_PHASE_INTROS[candidate]);
  runnerState.phaseIntros ||= {};
  const existing = runnerState.phaseIntros[phase] || {};
  if (!existing.openedAt) {
    existing.openedAt = new Date().toISOString();
    runnerState.phaseIntros[phase] = existing;
    persistRunnerState();
    recordStudyAction("study_phase_intro_viewed", "Viewed study phase introduction", {
      phase,
      part: studyPhaseNumber(phase),
      groupId: runnerGroup.id,
    });
  }
  neutralShell(`
    <main class="study-phase-intro">
      <div class="study-phase-intro-frame">
        <ol class="study-phase-axis" aria-label="Study stages">
          ${introPhases.map((candidate, index) => {
            const isCurrent = candidate === phase;
            return `<li class="${isCurrent ? "is-current" : ""}"${isCurrent ? ' aria-current="step"' : ""}>
              <span class="study-phase-axis-number" aria-hidden="true">${index + 1}</span>
              <span class="study-phase-axis-label">${escapeHTML(studyPhaseLabel(candidate))}</span>
            </li>`;
          }).join("")}
        </ol>
        <div class="study-phase-intro-content">
          <h1>${escapeHTML(studyPhaseLabel(phase))}</h1>
          <p>${escapeHTML(intro.description)}</p>
          <div class="study-phase-intro-action"><button type="button" id="studyBeginPhase">${escapeHTML(intro.action)}</button></div>
        </div>
      </div>
    </main>`, { className: "is-phase-intro", showTimer: false });
  document.getElementById("studyBeginPhase").addEventListener("click", () => {
    const completedAt = new Date().toISOString();
    runnerState.phaseIntros[phase] = { ...existing, completedAt };
    telemetryPhase(phase);
    persistRunnerState();
    recordStudyAction("study_phase_intro_completed", "Continued from study phase introduction", {
      phase,
      part: studyPhaseNumber(phase),
      openedAt: existing.openedAt,
      completedAt,
      groupId: runnerGroup.id,
    });
    const nextScreenId = operationStudyScreenId(phase);
    if (nextScreenId) void navigateToStudyScreen(nextScreenId, { source: "phase-intro" });
  });
  return true;
}

function cleanupAssessmentViews() {
  dashboardResizeObserver?.disconnect();
  dashboardResizeObserver = null;
  assessmentCanvasAbortController?.abort();
  assessmentCanvasAbortController = null;
  if (assessmentCanvasTelemetryTimer) clearTimeout(assessmentCanvasTelemetryTimer);
  assessmentCanvasTelemetryTimer = null;
  assessmentCanvas = null;
  assessmentViews.forEach((view) => {
    try { view?.finalize?.(); } catch { /* best effort */ }
  });
  assessmentViews = [];
}

function filterTransform(filter, value) {
  if (value === null || value === undefined || value === "") return null;
  if (filter.kind === "range") return { filter: `datum[${JSON.stringify(filter.field)}] <= ${Number(value)}` };
  return { filter: `datum[${JSON.stringify(filter.field)}] == ${JSON.stringify(value)}` };
}

function specForAssessmentTile(tile, filters, values) {
  const spec = clone(tile.spec);
  const transforms = filters.flatMap((filter) => {
    if (!filter.wired || !filter.targets.includes(tile.id)) return [];
    const transform = filterTransform(filter, values[filter.id]);
    return transform ? [transform] : [];
  });
  if (transforms.length) spec.transform = [...(Array.isArray(spec.transform) ? spec.transform : []), ...transforms];
  return spec;
}

async function renderAssessmentTile(tile, filters, values) {
  const host = document.getElementById(`study-vega-${CSS.escape(tile.id)}`);
  if (!host) return;
  const spec = specForAssessmentTile(tile, filters, values);
  spec.width = Math.max(96, host.clientWidth - 8);
  spec.height = Math.max(80, host.clientHeight - 8);
  spec.autosize = { type: "fit", contains: "padding", resize: false };
  try {
    const result = await embed(host, spec, { actions: false, renderer: "svg", mode: "vega-lite" });
    assessmentViews.push(result.view);
  } catch (error) {
    host.innerHTML = `<p class="study-dashboard-render-error">This chart could not be displayed.</p>`;
    console.warn("[study-runner] assessment tile failed", tile.id, error);
  }
}

function filterControlMarkup(filter, currentValue) {
  const label = escapeHTML(filter.label);
  if (filter.kind === "range") {
    const value = Number(currentValue ?? filter.value ?? filter.max);
    return `<label class="study-filter-control study-filter-range">
      <span>${label}</span>
      <input type="range" data-study-filter="${escapeHTML(filter.id)}" min="${filter.min}" max="${filter.max}" step="${filter.step || 1}" value="${value}">
      <output>${value}</output>
    </label>`;
  }
  if (filter.variant === "segmented" && Array.isArray(filter.options)) {
    return `<fieldset class="study-filter-control study-filter-segmented"><legend>${label}</legend>
      <div><button type="button" data-study-filter="${escapeHTML(filter.id)}" data-value="" aria-pressed="${!currentValue}">All</button>${filter.options.map((option) =>
        `<button type="button" data-study-filter="${escapeHTML(filter.id)}" data-value="${escapeHTML(option)}" aria-pressed="${String(currentValue ?? "") === String(option)}">${escapeHTML(option)}</button>`).join("")}</div>
    </fieldset>`;
  }
  return `<label class="study-filter-control"><span>${label}</span><select data-study-filter="${escapeHTML(filter.id)}">
    <option value="">All</option>${(filter.options || []).map((option) =>
      `<option value="${escapeHTML(option)}"${String(currentValue ?? "") === String(option) ? " selected" : ""}>${escapeHTML(option)}</option>`).join("")}
  </select></label>`;
}

function dashboardMarkup(normalized, assessment) {
  const { dashboard, tiles } = normalized;
  const topFilters = dashboard.filters.filter((filter) => filter.placement !== "left-rail");
  const sideFilters = dashboard.filters.filter((filter) => filter.placement === "left-rail");
  const controls = (filters, placement) => filters.length
    ? `<div class="study-dashboard-filters is-${placement}">${filters.map((filter) =>
        filterControlMarkup(filter, assessment.filters?.[filter.id] ?? filter.value)).join("")}</div>`
    : "";
  return `
    <div class="study-dashboard-stage" id="studyDashboardStage">
      <div class="study-dashboard-world" id="studyDashboardWorld" style="width:${dashboard.canvasWidth}px;height:${dashboard.canvasHeight}px">
        <div class="study-dashboard-artboard" id="studyDashboardArtboard" style="width:${dashboard.canvasWidth}px;height:${dashboard.canvasHeight}px">
          <header class="study-dashboard-heading"><h2>${escapeHTML(dashboard.title)}</h2><p>${escapeHTML(dashboard.subtitle)}</p></header>
          ${controls(topFilters, "top")}${controls(sideFilters, "side")}
          ${tiles.map((tile) => `<article class="study-dashboard-tile" data-study-tile="${escapeHTML(tile.id)}" style="left:${tile.bounds.x}px;top:${tile.bounds.y}px;width:${tile.bounds.w}px;height:${tile.bounds.h}px">
            <h3>${escapeHTML(tile.label)}</h3><div id="study-vega-${escapeHTML(tile.id)}" class="study-dashboard-vega"></div>
          </article>`).join("")}
          <div class="study-annotation-markers" id="studyAnnotationMarkers"></div>
          <div class="study-annotation-capture" id="studyAnnotationCapture" aria-hidden="true"><span id="studyAnnotationDraft"></span></div>
        </div>
      </div>
      <div class="study-dashboard-zoom-controls" aria-label="Dashboard zoom controls">
        <button type="button" id="studyZoomOut" title="Zoom out" aria-label="Zoom out">−</button>
        <output id="studyZoomLevel" aria-live="polite">100%</output>
        <button type="button" id="studyZoomIn" title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" id="studyZoomFit" class="study-dashboard-zoom-fit" title="Fit dashboard to view">Fit</button>
      </div>
    </div>`;
}

function clampAssessmentCanvasView() {
  const stage = document.getElementById("studyDashboardStage");
  if (!stage || !assessmentCanvas || !stage.clientWidth || !stage.clientHeight) return;
  const padding = 32;
  const worldWidth = assessmentCanvas.width * assessmentCanvas.scale;
  const worldHeight = assessmentCanvas.height * assessmentCanvas.scale;
  assessmentCanvas.x = worldWidth <= stage.clientWidth - padding * 2
    ? (stage.clientWidth - worldWidth) / 2
    : Math.min(padding, Math.max(stage.clientWidth - worldWidth - padding, assessmentCanvas.x));
  assessmentCanvas.y = worldHeight <= stage.clientHeight - padding * 2
    ? (stage.clientHeight - worldHeight) / 2
    : Math.min(padding, Math.max(stage.clientHeight - worldHeight - padding, assessmentCanvas.y));
}

function applyAssessmentCanvasView() {
  const world = document.getElementById("studyDashboardWorld");
  const zoomLevel = document.getElementById("studyZoomLevel");
  if (!world || !assessmentCanvas) return;
  clampAssessmentCanvasView();
  world.style.transform = `translate(${assessmentCanvas.x}px, ${assessmentCanvas.y}px) scale(${assessmentCanvas.scale})`;
  if (zoomLevel) zoomLevel.value = `${Math.round(assessmentCanvas.scale * 100)}%`;
  const zoomOut = document.getElementById("studyZoomOut");
  const zoomIn = document.getElementById("studyZoomIn");
  if (zoomOut) zoomOut.disabled = assessmentCanvas.scale <= .181;
  if (zoomIn) zoomIn.disabled = assessmentCanvas.scale >= 2.399;
}

function fitAssessmentCanvas({ record = false } = {}) {
  const stage = document.getElementById("studyDashboardStage");
  if (!stage || !assessmentCanvas || !stage.clientWidth || !stage.clientHeight) return;
  assessmentCanvas.scale = Math.max(.18, Math.min(
    (stage.clientWidth - 56) / assessmentCanvas.width,
    (stage.clientHeight - 56) / assessmentCanvas.height,
    1,
  ));
  assessmentCanvas.x = (stage.clientWidth - assessmentCanvas.width * assessmentCanvas.scale) / 2;
  assessmentCanvas.y = (stage.clientHeight - assessmentCanvas.height * assessmentCanvas.scale) / 2;
  applyAssessmentCanvasView();
  if (record) {
    recordStudyAction("assessment_canvas_fitted", "Fit the assessment dashboard to the viewport", {
      phase: runnerState.phase,
      scale: assessmentCanvas.scale,
    });
  }
}

function setAssessmentCanvasScale(nextScale, anchor, source = "control") {
  const stage = document.getElementById("studyDashboardStage");
  if (!stage || !assessmentCanvas) return;
  const point = anchor || { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
  const oldScale = assessmentCanvas.scale;
  const next = Math.min(2.4, Math.max(.18, nextScale));
  const worldX = (point.x - assessmentCanvas.x) / oldScale;
  const worldY = (point.y - assessmentCanvas.y) / oldScale;
  assessmentCanvas.scale = next;
  assessmentCanvas.x = point.x - worldX * next;
  assessmentCanvas.y = point.y - worldY * next;
  applyAssessmentCanvasView();
  if (source !== "wheel") {
    recordStudyAction("assessment_canvas_zoomed", "Changed assessment dashboard zoom", {
      phase: runnerState.phase,
      scale: assessmentCanvas.scale,
      source,
    });
  }
}

function scheduleAssessmentZoomTelemetry() {
  if (assessmentCanvasTelemetryTimer) clearTimeout(assessmentCanvasTelemetryTimer);
  assessmentCanvasTelemetryTimer = setTimeout(() => {
    assessmentCanvasTelemetryTimer = null;
    if (!assessmentCanvas) return;
    recordStudyAction("assessment_canvas_zoomed", "Changed assessment dashboard zoom", {
      phase: runnerState.phase,
      scale: assessmentCanvas.scale,
      source: "wheel",
    });
  }, 220);
}

function bindAssessmentCanvas(normalized) {
  const stage = document.getElementById("studyDashboardStage");
  const controls = document.querySelector(".study-dashboard-zoom-controls");
  if (!stage) return;
  assessmentCanvasAbortController?.abort();
  assessmentCanvasAbortController = new AbortController();
  const { signal } = assessmentCanvasAbortController;
  assessmentCanvas = {
    width: normalized.dashboard.canvasWidth,
    height: normalized.dashboard.canvasHeight,
    scale: 1,
    x: 0,
    y: 0,
    panning: null,
  };

  document.getElementById("studyZoomIn")?.addEventListener("click", () => {
    setAssessmentCanvasScale(assessmentCanvas.scale * 1.18, null, "button");
  }, { signal });
  document.getElementById("studyZoomOut")?.addEventListener("click", () => {
    setAssessmentCanvasScale(assessmentCanvas.scale / 1.18, null, "button");
  }, { signal });
  document.getElementById("studyZoomFit")?.addEventListener("click", () => fitAssessmentCanvas({ record: true }), { signal });

  stage.addEventListener("wheel", (event) => {
    if (event.target.closest(".study-dashboard-zoom-controls")) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      setAssessmentCanvasScale(
        assessmentCanvas.scale * Math.exp(-event.deltaY * .003),
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        "wheel",
      );
      scheduleAssessmentZoomTelemetry();
      return;
    }
    assessmentCanvas.x -= event.deltaX;
    assessmentCanvas.y -= event.deltaY;
    applyAssessmentCanvasView();
  }, { passive: false, signal });

  stage.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || annotationMode) return;
    if (event.target.closest(".study-dashboard-tile, .study-dashboard-filters, .study-dashboard-zoom-controls, .study-annotation-markers")) return;
    event.preventDefault();
    assessmentCanvas.panning = {
      startX: event.clientX,
      startY: event.clientY,
      x: assessmentCanvas.x,
      y: assessmentCanvas.y,
      moved: false,
    };
    stage.classList.add("is-panning");
  }, { signal });
  window.addEventListener("mousemove", (event) => {
    if (!assessmentCanvas?.panning) return;
    const dx = event.clientX - assessmentCanvas.panning.startX;
    const dy = event.clientY - assessmentCanvas.panning.startY;
    assessmentCanvas.panning.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
    assessmentCanvas.x = assessmentCanvas.panning.x + dx;
    assessmentCanvas.y = assessmentCanvas.panning.y + dy;
    applyAssessmentCanvasView();
  }, { signal });
  window.addEventListener("mouseup", () => {
    if (!assessmentCanvas?.panning) return;
    const moved = assessmentCanvas.panning.moved;
    assessmentCanvas.panning = null;
    stage.classList.remove("is-panning");
    if (moved) {
      recordStudyAction("assessment_canvas_panned", "Panned the assessment dashboard", {
        phase: runnerState.phase,
        x: assessmentCanvas.x,
        y: assessmentCanvas.y,
        scale: assessmentCanvas.scale,
      });
    }
  }, { signal });

  controls?.addEventListener("dblclick", (event) => event.stopPropagation(), { signal });
  const savedView = currentAssessment()?.canvasView;
  if (savedView && ["x", "y", "scale"].every((key) => Number.isFinite(Number(savedView[key])))) {
    assessmentCanvas.x = Number(savedView.x);
    assessmentCanvas.y = Number(savedView.y);
    assessmentCanvas.scale = Number(savedView.scale);
    applyAssessmentCanvasView();
    requestAnimationFrame(() => applyAssessmentCanvasView());
  } else {
    fitAssessmentCanvas();
    requestAnimationFrame(() => fitAssessmentCanvas());
  }
  dashboardResizeObserver = new ResizeObserver(() => applyAssessmentCanvasView());
  dashboardResizeObserver.observe(stage);
}

function currentAssessment() {
  return ensureAssessmentState(assessmentKeyForPhase(runnerState.phase));
}

function renderMarkers() {
  const root = document.getElementById("studyAnnotationMarkers");
  if (!root) return;
  root.innerHTML = currentAssessment().annotations.flatMap((annotation, index) => {
    if (!annotation.region) return [];
    const { x, y, w, h } = annotation.region;
    return [`<button type="button" data-edit-annotation="${escapeHTML(annotation.id)}" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%" aria-label="Edit note ${index + 1}"><span>${index + 1}</span></button>`];
  }).join("");
  root.querySelectorAll("[data-edit-annotation]").forEach((button) => {
    button.addEventListener("click", () => openAnnotationComposer(null, button.dataset.editAnnotation));
  });
}

function notesListMarkup(assessment) {
  if (!assessment.annotations.length) {
    return `<p class="study-notes-empty">No notes yet. Add as many or as few as you like.</p>`;
  }
  return `<ol class="study-notes-list">${assessment.annotations.map((annotation, index) => `
    <li><button type="button" data-edit-annotation="${escapeHTML(annotation.id)}">
      <span>${index + 1}</span><span>${escapeHTML(annotation.text)}</span><small>${annotation.region ? "Area note" : "Dashboard note"}</small>
    </button></li>`).join("")}</ol>`;
}

function renderNotesPanel() {
  const panel = document.getElementById("studyNotesPanel");
  if (!panel) return;
  const assessment = currentAssessment();
  const editing = editingAnnotationId
    ? assessment.annotations.find((annotation) => annotation.id === editingAnnotationId)
    : null;
  const composerOpen = Boolean(draftRegion || editing || panel.dataset.composing === "global");
  panel.innerHTML = `
    <div class="study-notes-panel-head"><div><h2>Notes</h2><p>Record what you notice.</p></div></div>
    <div class="study-note-actions">
      <button type="button" id="studyAddAreaNote" aria-pressed="${annotationMode}">${annotationMode ? "Cancel selection" : "Add area note"}</button>
      <button type="button" id="studyAddGlobalNote">Add dashboard note</button>
    </div>
    ${composerOpen ? `<form class="study-note-composer" id="studyNoteComposer">
      <label for="studyNoteText">${editing ? "Edit note" : draftRegion ? "Note for selected area" : "Dashboard note"}</label>
      <textarea id="studyNoteText" rows="4" placeholder="What do you notice?">${escapeHTML(editing?.text || "")}</textarea>
      <p id="studyNoteError" role="alert"></p>
      <div><button type="button" data-cancel-note>Cancel</button><button type="submit">Save note</button></div>
    </form>` : ""}
    <div class="study-notes-scroll">${notesListMarkup(assessment)}</div>`;
  panel.querySelector("#studyAddAreaNote").addEventListener("click", () => {
    annotationMode = !annotationMode;
    draftRegion = null;
    editingAnnotationId = null;
    panel.dataset.composing = "";
    document.getElementById("studyAnnotationCapture")?.classList.toggle("is-active", annotationMode);
    renderNotesPanel();
  });
  panel.querySelector("#studyAddGlobalNote").addEventListener("click", () => {
    annotationMode = false;
    draftRegion = null;
    editingAnnotationId = null;
    panel.dataset.composing = "global";
    document.getElementById("studyAnnotationCapture")?.classList.remove("is-active");
    renderNotesPanel();
    panel.querySelector("#studyNoteText")?.focus();
  });
  panel.querySelectorAll("[data-edit-annotation]").forEach((button) => {
    button.addEventListener("click", () => openAnnotationComposer(null, button.dataset.editAnnotation));
  });
  const composer = panel.querySelector("#studyNoteComposer");
  composer?.querySelector("[data-cancel-note]").addEventListener("click", closeAnnotationComposer);
  composer?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = composer.querySelector("#studyNoteText").value.trim();
    if (!text) {
      composer.querySelector("#studyNoteError").textContent = "Write a note or cancel.";
      return;
    }
    if (editing) {
      editing.text = text;
      editing.updatedAt = new Date().toISOString();
      recordStudyAction("assessment_annotation_updated", "Updated an assessment note", {
        phase: runnerState.phase,
        annotationId: editing.id,
        text,
        region: editing.region,
      });
    } else {
      const annotation = makeAnnotation({
        id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        text,
        region: draftRegion,
      });
      assessment.annotations.push(annotation);
      recordStudyAction("assessment_annotation_added", "Added an assessment note", {
        phase: runnerState.phase,
        annotationId: annotation.id,
        text: annotation.text,
        region: annotation.region,
      });
    }
    persistRunnerState();
    closeAnnotationComposer();
    renderMarkers();
  });
}

function openAnnotationComposer(region = null, annotationId = null) {
  annotationMode = false;
  draftRegion = region;
  editingAnnotationId = annotationId;
  const panel = document.getElementById("studyNotesPanel");
  if (panel) panel.dataset.composing = region ? "area" : annotationId ? "edit" : "global";
  document.getElementById("studyAnnotationCapture")?.classList.remove("is-active");
  renderNotesPanel();
  document.getElementById("studyNoteText")?.focus();
}

function closeAnnotationComposer() {
  const assessmentKey = assessmentKeyForPhase(runnerState?.phase);
  if (assessmentKey) {
    ensureAssessmentState(assessmentKey).noteDraft = null;
    persistRunnerState();
  }
  annotationMode = false;
  draftRegion = null;
  editingAnnotationId = null;
  const panel = document.getElementById("studyNotesPanel");
  if (panel) panel.dataset.composing = "";
  document.getElementById("studyAnnotationCapture")?.classList.remove("is-active");
  const draft = document.getElementById("studyAnnotationDraft");
  if (draft) draft.removeAttribute("style");
  renderNotesPanel();
}

function bindAnnotationCapture() {
  const capture = document.getElementById("studyAnnotationCapture");
  const artboard = document.getElementById("studyDashboardArtboard");
  const draft = document.getElementById("studyAnnotationDraft");
  if (!capture || !artboard || !draft) return;
  let start = null;
  const point = (event) => {
    const rect = artboard.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  const showDraft = (a, b) => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    draft.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%`;
  };
  capture.addEventListener("pointerdown", (event) => {
    if (!annotationMode) return;
    start = point(event);
    capture.setPointerCapture(event.pointerId);
    showDraft(start, start);
  });
  capture.addEventListener("pointermove", (event) => {
    if (!start || !annotationMode) return;
    showDraft(start, point(event));
  });
  capture.addEventListener("pointerup", (event) => {
    if (!start || !annotationMode) return;
    const end = point(event);
    let x = Math.min(start.x, end.x);
    let y = Math.min(start.y, end.y);
    let w = Math.abs(start.x - end.x);
    let h = Math.abs(start.y - end.y);
    if (w < .015 && h < .015) {
      w = .09; h = .09;
      x = Math.max(0, Math.min(1 - w, start.x - w / 2));
      y = Math.max(0, Math.min(1 - h, start.y - h / 2));
    }
    start = null;
    openAnnotationComposer({ x, y, w, h });
  });
}

async function bindDashboardControls(normalized, assessment) {
  const renderTiles = async () => {
    assessmentViews.forEach((view) => {
      try { view?.finalize?.(); } catch { /* best effort */ }
    });
    assessmentViews = [];
    await Promise.all(normalized.tiles.map((tile) => renderAssessmentTile(tile, normalized.dashboard.filters, assessment.filters || {})));
  };
  document.querySelectorAll("[data-study-filter]").forEach((control) => {
    const apply = async (value) => {
      const filterId = control.dataset.studyFilter;
      assessment.filters ||= {};
      assessment.filters[filterId] = value;
      persistRunnerState();
      recordStudyAction("assessment_filter_changed", "Changed an assessment dashboard control", {
        phase: runnerState.phase,
        filterId,
        value: value || null,
      });
      if (control.matches("button")) {
        document.querySelectorAll(`button[data-study-filter="${CSS.escape(filterId)}"]`).forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.value === value));
        });
      }
      if (control.matches('input[type="range"]')) control.parentElement.querySelector("output").textContent = value;
      await renderTiles();
    };
    if (control.matches("button")) control.addEventListener("click", () => void apply(control.dataset.value || ""));
    else control.addEventListener("change", () => void apply(control.value));
    if (control.matches('input[type="range"]')) control.addEventListener("input", () => {
      control.parentElement.querySelector("output").textContent = control.value;
    });
  });
  await renderTiles();
}

async function renderAssessmentReview() {
  cleanupAssessmentViews();
  const key = assessmentKeyForPhase(runnerState.phase);
  const assessment = ensureAssessmentState(key);
  const material = materialForPhase(runnerGroup.id, runnerState.phase);
  const savedDraft = assessment.noteDraft;
  draftRegion = savedDraft?.region ? clone(savedDraft.region) : null;
  editingAnnotationId = savedDraft?.editingAnnotationId || null;
  neutralShell(`
    <main class="study-assessment-layout">
      <section class="study-assessment-main" aria-labelledby="studyAssessmentTitle">
        <header class="study-assessment-instructions">
          <div><h1 id="studyAssessmentTitle">Dashboard notes</h1><p>Add notes for anything you would comment on. You may add as many or as few as you like.</p></div>
          <p>Please think aloud as you work.</p>
        </header>
        <div class="study-dashboard-loading" id="studyDashboardMount" role="status">Loading dashboard…</div>
      </section>
      <aside class="study-notes-panel" id="studyNotesPanel" aria-label="Dashboard notes"></aside>
      <footer class="study-assessment-footer"><span>Your notes save automatically.</span><button type="button" id="studyAssessmentReviewDone">${key === "pre" ? "Continue to guided practice" : "Continue to questions"}</button></footer>
    </main>`, { className: "is-assessment" });
  if (savedDraft?.text) document.getElementById("studyNotesPanel").dataset.composing = savedDraft.kind || "global";
  renderNotesPanel();
  if (savedDraft?.text) {
    const draftInput = document.getElementById("studyNoteText");
    if (draftInput) draftInput.value = savedDraft.text;
  }
  const mount = document.getElementById("studyDashboardMount");
  try {
    const response = await fetch(material.dashboardUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    const normalized = normalizeDashboardDocument(data, `${material.code}.json`);
    mount.className = "study-dashboard-wrap";
    mount.removeAttribute("role");
    mount.innerHTML = dashboardMarkup(normalized, assessment);
    bindAssessmentCanvas(normalized);
    bindAnnotationCapture();
    renderMarkers();
    await bindDashboardControls(normalized, assessment);
  } catch (error) {
    mount.className = "study-dashboard-load-error";
    mount.innerHTML = `<strong>Dashboard unavailable</strong><p>${escapeHTML(error.message || error)}</p><button type="button" id="studyRetryDashboard">Try again</button>`;
    mount.querySelector("#studyRetryDashboard")?.addEventListener("click", () => void renderAssessmentReview());
  }
  document.getElementById("studyAssessmentReviewDone").addEventListener("click", () => {
    const completedAt = new Date().toISOString();
    appendAssessmentSubmission(assessment, {
      kind: "dashboard-review",
      phase: runnerState.phase,
      materialCode: material.code,
      submittedAt: completedAt,
      annotations: assessment.annotations,
      filters: assessment.filters,
      canvasView: assessmentCanvas ? {
        x: assessmentCanvas.x,
        y: assessmentCanvas.y,
        scale: assessmentCanvas.scale,
      } : assessment.canvasView,
    });
    recordStudyAction("assessment_review_submitted", "Submitted dashboard review", {
      phase: runnerState.phase,
      materialCode: material.code,
      annotationCount: assessment.annotations.length,
      annotations: clone(assessment.annotations),
    });
    if (key === "pre") {
      assessment.reviewCompletedAt = completedAt;
      stopPhaseTimer(runnerState.phase, completedAt);
      recordStudyAction("pre_assessment_completed", "Completed initial dashboard assessment", {
        phase: runnerState.phase,
        materialCode: material.code,
        annotationCount: assessment.annotations.length,
        completedAt,
      });
      void navigateToStudyScreen("training:intro", { source: "pre-assessment-complete" });
      return;
    }
    void navigateToStudyScreen("post_assessment:questionnaire", { source: "post-review-complete" });
  });
}

function scaleFieldMarkup(item, value, itemIndex) {
  const choices = [1, 2, 3, 4, 5, 6, 7];
  const choiceLabels = {
    1: "Strongly disagree",
    2: "Disagree",
    3: "Somewhat disagree",
    4: "Neither agree nor disagree",
    5: "Somewhat agree",
    6: "Agree",
    7: "Strongly agree",
  };
  const name = `scale_${item.id}`;
  const selected = String(value || "");
  return `<fieldset class="study-scale-question">
    <legend><span class="study-scale-item-number" aria-hidden="true">${itemIndex + 1}</span><span>${escapeHTML(item.statement)}</span></legend>
    <div class="study-scale-response">
      <div class="study-scale-main">
        <div class="study-scale-options">
          ${choices.map((choice, index) => `<label title="${choice} — ${escapeHTML(choiceLabels[choice])}"><input type="radio" name="${escapeHTML(name)}" data-scale-id="${escapeHTML(item.id)}" value="${choice}" aria-label="${choice} — ${escapeHTML(choiceLabels[choice])}"${index === 0 ? " required" : ""}${selected === String(choice) ? " checked" : ""}><span>${choice}</span></label>`).join("")}
        </div>
        <div class="study-scale-anchors" aria-hidden="true"><span class="is-start"><strong>1</strong> Strongly disagree</span><span class="is-middle"><strong>4</strong> Neither agree nor disagree</span><span class="is-end"><strong>7</strong> Strongly agree</span></div>
      </div>
      <label class="study-scale-na"><input type="radio" name="${escapeHTML(name)}" data-scale-id="${escapeHTML(item.id)}" value="NA" aria-label="N/A — Not applicable"${selected === "NA" ? " checked" : ""}><span>N/A</span><small>Not applicable</small></label>
    </div>
    ${item.interviewQuestion ? `<p class="study-scale-interview-question">${escapeHTML(item.interviewQuestion)}</p>` : ""}
  </fieldset>`;
}

function scaleSectionMarkup(section, responseMap) {
  return `<section class="study-scale-section" aria-labelledby="studyScale-${escapeHTML(section.id)}">
    <header class="study-scale-section-head"><div><h2 id="studyScale-${escapeHTML(section.id)}">${escapeHTML(section.title)}</h2><p>Choose the number that best matches your response.</p></div><div class="study-scale-key" aria-label="Response scale"><span><strong>1</strong> Strongly disagree</span><span><strong>4</strong> Neither agree nor disagree</span><span><strong>7</strong> Strongly agree</span><span><strong>N/A</strong> Not applicable</span></div></header>
    ${section.items.map((item, index) => scaleFieldMarkup(item, responseMap?.[item.id], index)).join("")}
  </section>`;
}

function renderQuestionnaire() {
  cleanupAssessmentViews();
  const key = assessmentKeyForPhase(runnerState.phase);
  const assessment = ensureAssessmentState(key);
  const questions = POST_QUESTIONS;
  const scaleSections = scaleSectionsForAssessment(key);
  const scaleItems = scaleSections.flatMap((section) => section.items);
  const scaleQuestionnaire = scaleItems.length ? `<div class="study-scale-questionnaire">
    <div class="study-scale-progress" aria-live="polite"><div><strong id="studyScaleProgress">0 of ${scaleItems.length} answered</strong><span>Your responses save automatically.</span></div><span class="study-scale-progress-track" aria-hidden="true"><span id="studyScaleProgressFill"></span></span></div>
    ${scaleSections.map((section) => scaleSectionMarkup(section, assessment.scales)).join("")}
  </div>` : "";
  neutralShell(`
    <main class="study-questionnaire-page">
      <header><span>After formal use</span><h1>Questionnaire &amp; interview</h1><p>Select one response for every statement, then discuss the interview prompt in the same item aloud.</p></header>
      <form id="studyQuestionnaireForm">
        ${scaleQuestionnaire}
        <footer><button type="submit">Complete study</button></footer>
      </form>
    </main>`, { className: "is-questionnaire" });
  document.querySelector(".study-runner-shell.is-questionnaire")?.scrollTo({
    top: Number(assessment.questionnaireScrollTop) || 0,
  });
  const form = document.getElementById("studyQuestionnaireForm");
  const saveDraft = () => {
    const data = new FormData(form);
    scaleItems.forEach((item) => {
      assessment.scales[item.id] = String(data.get(`scale_${item.id}`) || "");
    });
    persistRunnerState();
  };
  const updateScaleProgress = () => {
    const answered = scaleItems.filter((item) => String(assessment.scales[item.id] || "") !== "").length;
    const progress = document.getElementById("studyScaleProgress");
    const progressFill = document.getElementById("studyScaleProgressFill");
    if (progress) progress.textContent = `${answered} of ${scaleItems.length} answered`;
    if (progressFill) progressFill.style.transform = `scaleX(${scaleItems.length ? answered / scaleItems.length : 0})`;
  };
  updateScaleProgress();
  form.addEventListener("change", (event) => {
    const input = event.target.closest?.("input[data-scale-id]");
    saveDraft();
    updateScaleProgress();
    if (!input) return;
    const rawValue = String(input.value || "");
    recordStudyAction("scale_response_recorded", "Recorded questionnaire scale response", {
      phase: runnerState.phase,
      assessment: key,
      itemId: input.dataset.scaleId,
      value: /^\d+$/.test(rawValue) ? Number(rawValue) : null,
      notApplicable: rawValue === "NA",
    });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveDraft();
    assessment.submittedAt = new Date().toISOString();
    appendAssessmentSubmission(assessment, {
      kind: "questionnaire",
      phase: runnerState.phase,
      submittedAt: assessment.submittedAt,
      scales: assessment.scales,
      questionsPresented: questions,
    });
    stopPhaseTimer(runnerState.phase, assessment.submittedAt);
    recordStudyAction("assessment_questionnaire_submitted", `Submitted ${key}-session questionnaire`, {
      phase: runnerState.phase,
      instrumentVersion: "vizier-study-protocol-v2",
      openQuestionResponseMode: "spoken-interview",
      questionsPresented: clone(questions),
      questionResponses: serializeQuestionResponses(questions, assessment.answers),
      scaleResponses: serializeScaleResponses(scaleSections, assessment.scales),
    });
    if (nextStudyPhase(runnerState.phase) === "complete") {
      applyStudyScreenState("complete", "forward");
      persistRunnerState();
      await completeRunnerSession();
      renderComplete();
      return;
    }
  });
}

async function completeRunnerSession() {
  recordStudyAction("study_runner_completed", "Completed all study runner phases", {
    groupId: runnerGroup.id,
    postScaleResponses: serializeScaleResponses(scaleSectionsForAssessment("post"), ensureAssessmentState("post").scales),
    phaseTimers: clone(runnerState.phaseTimers || {}),
  });
  endStudySession({ reason: "runner-complete" });
  runnerState.completedAt = new Date().toISOString();
  runnerState.saveStatus = "saving";
  persistRunnerState();
  const backup = buildRunnerBackup();
  const bundle = buildStudyBundle(backup.snapshot, "runner-complete");
  try {
    const result = await saveStudySessionToServer({ ...bundle, artifacts: backup.artifacts });
    runnerState.saveStatus = "saved";
    runnerState.saveLocation = result.location || "";
  } catch (error) {
    runnerState.saveStatus = "local-only";
    runnerState.saveError = error?.message || String(error);
  }
  persistRunnerState();
}

function questionnaireBackupArtifact(key) {
  const assessment = ensureAssessmentState(key);
  const questions = POST_QUESTIONS;
  const sections = scaleSectionsForAssessment(key);
  return {
    path: `questionnaires/${key}.json`,
    contentType: "application/json",
    text: JSON.stringify({
      schema: "vizier-study-questionnaire/1",
      assessment: key,
      submittedAt: assessment.submittedAt,
      openQuestionResponseMode: "spoken-interview",
      questionsPresented: questions,
      questionResponses: serializeQuestionResponses(questions, assessment.answers),
      scaleResponses: serializeScaleResponses(sections, assessment.scales),
      annotations: assessment.annotations,
      dashboardFilters: assessment.filters,
      submissionHistory: assessment.submissions,
    }, null, 2),
  };
}

function buildRunnerBackup() {
  const capture = studyTaskCapture();
  return {
    snapshot: capture.snapshot,
    artifacts: [
      ...capture.artifacts,
      {
        path: "study-runner-state.json",
        contentType: "application/json",
        text: JSON.stringify(runnerState, null, 2),
      },
      questionnaireBackupArtifact("post"),
    ],
  };
}

function renderComplete() {
  cleanupAssessmentViews();
  const saved = runnerState.saveStatus === "saved";
  neutralShell(`
    <main class="study-runner-complete">
      <div class="study-complete-mark" aria-hidden="true">✓</div>
      <h1>Session complete</h1>
      <p>Thank you. Please let the moderator know you are finished.</p>
      <p class="study-complete-save ${saved ? "is-saved" : "is-local"}" role="status">${saved ? "Study data saved." : "A local backup is available."}</p>
      <div><button type="button" id="studyDownloadFinal">Download backup</button><button type="button" id="studyStartAnother">Start another participant</button></div>
    </main>`, { className: "is-complete" });
  document.getElementById("studyDownloadFinal").addEventListener("click", () => {
    const button = document.getElementById("studyDownloadFinal");
    button.disabled = true;
    button.textContent = "Preparing backup…";
    const backup = buildRunnerBackup();
    const bundle = buildStudyBundle(backup.snapshot, "manual-download");
    const downloaded = exportStudyBackupZip(backup.artifacts, bundle);
    button.disabled = false;
    button.textContent = downloaded ? "Download backup again" : "Retry download";
  });
  document.getElementById("studyStartAnother").addEventListener("click", () => {
    if (!window.confirm("Clear this completed session from this browser and return to the start page?")) return;
    localStorage.removeItem(runnerKey());
    discardStudySession();
    location.reload();
  });
}

async function mountVizierPhase() {
  clearStageTimerTicker();
  cleanupAssessmentViews();
  document.body.classList.add("study-workspace-booting");
  const app = await import("./app.js");
  document.getElementById("uploadScreen")?.setAttribute("hidden", "");
  const material = materialForPhase(runnerGroup.id, runnerState.phase);
  try {
    await app.openStudyMaterialForRunner(material.code, {
      practice: runnerState.phase === "training",
    });
    const savedWorkspace = runnerState.workspaces?.[runnerState.phase];
    if (savedWorkspace && typeof app.restoreStudyRunnerWorkspaceState === "function") {
      await app.restoreStudyRunnerWorkspaceState(savedWorkspace);
      recordStudyAction("study_workspace_restored", `Restored ${studyPhaseLabel(runnerState.phase)} workspace`, {
        phase: runnerState.phase,
        materialCode: material.code,
        capturedAt: savedWorkspace.capturedAt || null,
      });
    }
  } catch (error) {
    document.body.classList.remove("study-workspace-booting");
    neutralShell(`<main class="study-workspace-error"><h1>Material unavailable</h1><p>${escapeHTML(error.message || error)}</p><button type="button" id="studyRetryWorkspace">Try again</button></main>`, { showTimer: false });
    document.getElementById("studyRetryWorkspace")?.addEventListener("click", () => location.reload());
    return;
  }
  document.body.classList.remove("study-workspace-booting");
  document.body.classList.add("study-workspace-phase");
  document.querySelectorAll("[data-study-session]").forEach((element) => { element.hidden = true; });
  const topbar = document.querySelector(".topbar");
  const title = studyPhaseLabel(runnerState.phase);
  const part = studyPhaseNumber(runnerState.phase);
  const progress = document.createElement("div");
  progress.className = "study-workspace-progress";
  progress.innerHTML = `<span>Part ${part} of 3</span><strong>${escapeHTML(title)}</strong>`;
  topbar?.querySelector(".brand-title")?.insertAdjacentElement("afterend", progress);
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.id = "studyRunnerBack";
  backButton.className = "study-runner-back is-workspace";
  backButton.setAttribute("aria-label", "Back");
  backButton.innerHTML = '<span aria-hidden="true">←</span><span>Back</span>';
  progress.insertAdjacentElement("beforebegin", backButton);
  const timerHost = document.createElement("div");
  timerHost.innerHTML = stageTimerMarkup("study-workspace-timer");
  const timerElement = timerHost.firstElementChild;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "study-workspace-finish";
  button.textContent = runnerState.phase === "training" ? "Finish practice" : "Finish formal use";
  const pdfButton = material?.pdfUrl ? document.createElement("button") : null;
  if (pdfButton) {
    pdfButton.type = "button";
    pdfButton.className = "study-workspace-pdf";
    pdfButton.textContent = "Preview PDF";
    pdfButton.setAttribute("aria-label", "Preview the assigned design document PDF in a new tab");
    pdfButton.addEventListener("click", () => {
      window.open(material.pdfUrl, "_blank", "noopener,noreferrer");
      recordStudyAction("design_document_previewed", "Previewed the assigned design document", {
        phase: runnerState.phase,
        materialCode: material.code,
        pdfUrl: material.pdfUrl,
      });
    });
  }
  const topActions = document.querySelector(".top-actions");
  topActions?.prepend(...[pdfButton, timerElement, button].filter(Boolean));
  startStageTimerTicker();
  wireStageTimerControl();
  wireStudyBackControl();
  if (runnerState.phase === "training") {
    await app.startGuidedPracticeTutorial(material.code);
  }
  button.addEventListener("click", async () => {
    const isTask = isDashboardTaskPhase(runnerState.phase);
    const confirmed = window.confirm(isTask
      ? "Finish formal use and continue to the questionnaire and interview?"
      : "Finish practice and continue to formal use?");
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = isTask ? "Saving formal-use session…" : "Opening formal use…";
    const completedAt = new Date().toISOString();
    clearStageTimerTicker();
    const timerOutput = document.getElementById("studyStageTimer");
    if (timerOutput) timerOutput.textContent = formatStudyPhaseTimer(
      studyPhaseTimerElapsedMs(activePhaseTimer(), Date.parse(completedAt)),
    );
    recordStudyAction(isTask ? "controlled_task_finished" : "training_finished", isTask ? "Finished controlled task" : "Finished guided practice", {
      groupId: runnerGroup.id,
      materialCode: material.code,
    });
    runnerState.workspaces ||= {};
    const finishedWorkspace = app.captureStudyRunnerWorkspaceState();
    runnerState.workspaces[runnerState.phase] = finishedWorkspace;
    runnerState.workspaceSubmissions ||= {};
    runnerState.workspaceSubmissions[runnerState.phase] ||= [];
    runnerState.workspaceSubmissions[runnerState.phase].push({
      id: `submission-${runnerState.workspaceSubmissions[runnerState.phase].length + 1}`,
      phase: runnerState.phase,
      materialCode: material.code,
      submittedAt: completedAt,
      workspace: finishedWorkspace,
    });
    persistRunnerState();
    if (isTask) {
      try {
        await app.captureStudyRunnerTaskDashboard();
      } catch (error) {
        button.disabled = false;
        button.textContent = "Retry finish task";
        startStageTimerTicker();
        recordStudyAction("task_backup_failed", "Could not capture the dashboard task backup", {
          groupId: runnerGroup.id,
          materialCode: material.code,
          error: error?.message || String(error),
        });
        window.alert("The task backup could not be prepared. Your work is still open; please try again.");
        return;
      }
    }
    stopPhaseTimer(runnerState.phase, completedAt);
    const nextPhase = nextStudyPhase(runnerState.phase);
    await navigateToStudyScreen(`${nextPhase}:intro`, {
      source: isTask ? "dashboard-task-complete" : "training-complete",
      capture: false,
    });
  });
}

async function renderCurrentPhase() {
  clearStageTimerTicker();
  document.body.classList.remove("study-workspace-booting", "study-workspace-phase");
  if (!runnerState) {
    renderWelcome();
    return;
  }
  const navigation = ensureRunnerNavigation();
  const screen = studyScreenDescriptor(navigation.currentScreenId);
  runnerState.phase = screen?.phase || runnerState.phase;
  if (screen?.view === "complete" || runnerState.phase === "complete") {
    renderComplete();
    return;
  }
  if (screen?.view === "intro") {
    renderPhaseIntro();
    return;
  }
  if (screen?.view === "workspace" && studyPhaseUsesVizier(runnerState.phase)) {
    await mountVizierPhase();
    return;
  }
  if (screen?.view === "questionnaire") renderQuestionnaire();
  else await renderAssessmentReview();
}

export async function bootStudyRunner(groupId) {
  runnerGroup = STUDY_GROUPS[groupId];
  if (!runnerGroup) throw new Error(`Unknown study group: ${groupId}`);
  restoreStudySession();
  runnerState = loadRunnerState();
  if (runnerState && !isStudyActive() && runnerState.phase !== "complete") {
    startStudySession({ participantId: runnerState.participantId, groupId, notes: "Recovered from study runner state" });
    recordStudyAction("study_runner_recovered", "Recovered study runner after session-state loss", { groupId, phase: runnerState.phase });
  }
  if (runnerState?.phase === "complete" && !["saved", "local-only"].includes(runnerState.saveStatus)) {
    await completeRunnerSession();
  }
  if (runnerState) {
    ensureRunnerNavigation();
    window.history.replaceState({
      vizierStudyRunner: true,
      screenId: runnerState.navigation.currentScreenId,
    }, "", location.href);
    persistRunnerState();
  }
  bindStudyBrowserHistory();
  await renderCurrentPhase();
}
