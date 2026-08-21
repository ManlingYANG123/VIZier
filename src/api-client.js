/**
 * Thin client between the v2 frontend and the re_api critique engine.
 *
 * The real engine is mandatory. Full, focused, and selected-region requests all
 * use one criteria-aware provider-backed review path.
 *
 * Both endpoints stream Server-Sent Events; every TraceEvent is forwarded to
 * `onEvent` so the observability panel can render the engine's work live
 * (especially critique generation) before the final `result` arrives.
 */

const DEFAULT_BASE =
  typeof location !== "undefined" &&
  location.hostname !== "localhost" &&
  location.hostname !== "127.0.0.1"
    ? location.origin
    : "http://127.0.0.1:8091";

export function reApiBase() {
  const params = new URLSearchParams(location.search);
  return params.get("engineBase") || localStorage.getItem("reApiBase") || DEFAULT_BASE;
}

export function reApiEnabled() {
  return true;
}

async function getEngineJson(path, label) {
  let res;
  try {
    res = await fetch(reApiBase() + path, { cache: "no-store" });
  } catch (error) {
    throw new Error(`cannot reach ${label} at ${reApiBase()}: ${error.message || error}`);
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `${label} API ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${label} returned a non-JSON response. Restart the local API server.`);
  }
  return res.json();
}

export async function listDashboardLibrary() {
  const payload = await getEngineJson("/api/dashboards", "dashboard library");
  return Array.isArray(payload.dashboards) ? payload.dashboards : [];
}

export function loadDashboardFromLibrary(id) {
  return getEngineJson(
    `/api/dashboards/${encodeURIComponent(id)}`,
    "dashboard library",
  );
}

// Migrate away any legacy mode persisted by older prototype builds.
(function initEngineMode() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("reApiEngine");
    console.info(
      `[re_api] engine mode: REAL — unified criteria review · base ${reApiBase()}`,
    );
  } catch {
    /* non-browser context */
  }
})();

async function streamSSE(path, body, onEvent) {
  console.info(`[re_api] → ${reApiBase()}${path} (engine=real)`);
  let res;
  try {
    res = await fetch(reApiBase() + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `cannot reach engine at ${reApiBase()} — is it running? (cd prototype/v2/re_api && npm start). ${err.message || err}`,
    );
  }
  if (!res.ok || !res.body) throw new Error(`re_api ${res.status} ${res.statusText}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let error = null;

  const handle = (block) => {
    let event = "message";
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "result") result = payload;
    else if (event === "error") error = payload;
    else onEvent?.({ phase: event, ...payload });
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      handle(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
    }
  }
  if (buffer.trim()) handle(buffer);
  if (error) throw new Error(error.message || "engine error");
  return result;
}

export function streamCritique(request, onEvent) {
  return streamSSE("/critique", request, onEvent);
}

export function streamApply(request, onEvent) {
  return streamSSE("/apply", request, onEvent);
}

/** Parse first-stage author material into the living DashboardContext. This
 * endpoint is intentionally independent from critique generation so onboarding
 * can be tested and evolved on its own. */
export async function structureBrief(request) {
  let res;
  try {
    res = await fetch(reApiBase() + "/scaffold", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (err) {
    throw new Error(`cannot reach scaffold engine at ${reApiBase()}: ${err.message || err}`);
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `scaffold API ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Turn one uploaded design source (a brand/design-guidelines document) into a
 * normalized ConstraintSet of hard constraints. Independent of critique
 * generation and of /scaffold: the design doc must not perturb the goal/audience
 * context snapshot, so it has its own endpoint (see the intake module). The
 * frontend extracts PDF text before posting, keeping the backend text-only. */
export async function extractConstraints(request) {
  let res;
  try {
    res = await fetch(reApiBase() + "/intake-constraints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (err) {
    throw new Error(`cannot reach constraint intake at ${reApiBase()}: ${err.message || err}`);
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `intake API ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Ask the dashboard-scoped context memory agent for evidence-backed proposals.
 * The response is plain JSON because this background operation does not expose
 * partial model output in the authoring workflow. */
export async function inferContext(request) {
  let res;
  try {
    res = await fetch(reApiBase() + "/infer-context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (err) {
    throw new Error(`cannot reach context memory at ${reApiBase()}: ${err.message || err}`);
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `context memory API ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Observability panel: renders the streaming TraceEvents.            */
/* ------------------------------------------------------------------ */

// The engine emits many fine-grained phases; the panel folds them into a small
// set of high-level, author-facing stages (one row each). Each stage shows a
// semantic label plus a concise result derived from the REAL event data as it
// streams in — never fabricated. A stage is only ever running or done.
const STAGE_GROUP = {
  // Critique generation. Diagnosing eligible criteria and drafting critiques are
  // one streaming LLM pass, so both fold into the "draft" stage — the criteria
  // assessment surfaces as a live sub-step under it rather than its own row.
  evidence: "understand",
  eligibility: "draft",
  generate: "draft",
  guardrail: "prioritize",
  rank: "prioritize",
  constraint_filter: "prioritize",
  // Applying a change
  apply: "apply",
  validate: "validate",
  compute: "compute",
  reevaluate: "reevaluate",
};

const GROUP_LABEL = {
  understand: "Reviewing your dashboard & goal",
  draft: "Drafting critiques",
  prioritize: "Prioritizing recommendations",
  apply: "Applying your changes",
  validate: "Validating the result",
  compute: "Computing real data",
  reevaluate: "Updating recommendations",
};

// A group without a friendly name still reads cleanly: "spec_map" -> "Spec map".
function titleCaseStep(key) {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// Fold a trace phase to its high-level stage group. Unknown phases fall back to
// their own key so nothing the engine emits is silently dropped.
function groupOf(phase) {
  const key = phase.replace(/_(start|done)$/, "");
  return STAGE_GROUP[key] || key;
}

const countLabel = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function leadingInt(text) {
  const match = /(\d+)/.exec(String(text || ""));
  return match ? Number(match[1]) : null;
}

// Turn a stage's real event data into a short, high-level result for its row
// (e.g. "3 recommendations ready"). Returns null to leave the current result
// untouched so a later, richer event can fill it in. The "draft" stage is not
// handled here — it carries its result through live sub-steps (see the draft
// stream helpers below).
function detailFor(group, phase, e) {
  const data = (e && e.data) || {};
  switch (group) {
    case "prioritize": {
      if (phase === "constraint_filter") {
        const kept = Number.isFinite(data.keptCount) ? data.keptCount : leadingInt(e.message);
        const dropped = Array.isArray(data.dropped) ? data.dropped.length : 0;
        const ready = kept == null ? "ready" : `${countLabel(kept, "recommendation", "recommendations")} ready`;
        return dropped > 0 ? `${ready} · ${dropped} set aside by your design doc` : ready;
      }
      if (phase === "rank_done" || phase === "guardrail_done") {
        const n = leadingInt(e.message);
        return n == null ? null : `${countLabel(n, "recommendation", "recommendations")} ready`;
      }
      return null;
    }
    case "apply":
      if (phase === "apply" && Array.isArray(data.order))
        return countLabel(data.order.length, "change", "changes");
      return null;
    case "validate":
      if (phase === "validate") return data.rolledBack ? "rolled back" : "verified";
      return null;
    default:
      return null;
  }
}

/* ---- Drafting sub-steps -------------------------------------------------- */
/* Critique generation is one streaming LLM pass that emits, in order, a
 * diagnoses array, a critiques array, then a strengths array. We surface that
 * real progress as sub-steps under "Drafting critiques" by watching the token
 * stream — counting the unique keys each section emits — and finalize the
 * exact counts from the trailing *_done events. Nothing here is fabricated:
 * a section only appears once its tokens actually arrive. */

const DRAFT_SUB_LABEL = {
  assess: "Assessing objects & problems",
  write: "Writing critiques",
  strengths: "Noting strengths",
};

// Accumulated generate_token text and the last rendered signature, so we only
// touch the DOM when a count or section actually changes. Reset in start().
let draftStream = "";
let draftSig = "";

// Parse the partial JSON stream for section boundaries and item counts. The
// keys are unique per section: "outcome": only in diagnoses, "issue": only in
// critiques. Strength items are counted by "title": within the strengths tail.
function draftProgress(buf) {
  const idxCritiques = buf.indexOf('"critiques"');
  const idxStrengths = buf.indexOf('"strengths"');
  const assess = (buf.match(/"outcome"\s*:/g) || []).length;
  const write = (buf.match(/"issue"\s*:/g) || []).length;
  const strengths = idxStrengths >= 0
    ? (buf.slice(idxStrengths).match(/"title"\s*:/g) || []).length
    : 0;
  const section = idxStrengths >= 0 ? "strengths" : idxCritiques >= 0 ? "critiques" : "diagnoses";
  return { assess, write, strengths, section };
}

// The sub-step rows live in a container inserted right after the draft row.
function draftSubContainer(body, draftRow) {
  let c = document.getElementById("rtDraftSubs");
  if (!c) {
    c = document.createElement("div");
    c.className = "rt-substeps";
    c.id = "rtDraftSubs";
    draftRow.after(c);
  }
  return c;
}

function upsertSub(container, key, label) {
  let row = container.querySelector(`[data-sub="${key}"]`);
  if (row) return row;
  row = document.createElement("div");
  row.className = "rt-substep";
  row.dataset.sub = key;
  row.dataset.state = "active";
  row.innerHTML = `<span class="rt-ico" aria-hidden="true"></span><span class="rt-step-label"></span><span class="rt-step-detail"></span>`;
  row.querySelector(".rt-step-label").textContent = label;
  container.appendChild(row);
  return row;
}

function setSub(container, key, label, opts) {
  const row = upsertSub(container, key, label);
  const o = opts || {};
  if (o.detail != null) row.querySelector(".rt-step-detail").textContent = o.detail;
  if (o.state) row.dataset.state = o.state;
  return row;
}

// Render sub-steps live from the current stream. Only runs while the draft
// stage row exists (created by generate_start/eligibility_start).
function renderDraftLive() {
  const node = document.getElementById("reApiTrace");
  if (!node) return;
  const body = node.querySelector("#rtBody");
  const draftRow = body && body.querySelector('[data-group="draft"]');
  if (!draftRow) return;
  const p = draftProgress(draftStream);
  const sig = `${p.section}|${p.assess}|${p.write}|${p.strengths}`;
  if (sig === draftSig) return;
  draftSig = sig;
  const subs = draftSubContainer(body, draftRow);
  // Assessing runs first; it settles once the critiques section begins.
  if (p.assess > 0 || p.section !== "diagnoses") {
    setSub(subs, "assess", DRAFT_SUB_LABEL.assess, {
      detail: p.assess ? `${p.assess} checked` : null,
      state: p.section === "diagnoses" ? "active" : "done",
    });
  }
  // Writing critiques appears at the critiques section.
  if (p.section === "critiques" || p.section === "strengths" || p.write > 0) {
    setSub(subs, "write", DRAFT_SUB_LABEL.write, {
      detail: p.write ? `${p.write} so far` : null,
      state: p.section === "strengths" ? "done" : "active",
    });
  }
  // Noting strengths appears only when strengths actually stream in.
  if (p.strengths > 0) {
    setSub(subs, "strengths", DRAFT_SUB_LABEL.strengths, {
      detail: `${p.strengths} noted`,
      state: "active",
    });
  }
  body.scrollTop = body.scrollHeight;
}

// Finalize the sub-steps from the authoritative *_done counts: eligibility_done
// carries the diagnosis outcomes, generate_done the accepted critiques.
function finalizeDraftSubsteps(body, draftRow, phase, e) {
  const data = (e && e.data) || {};
  const subs = draftSubContainer(body, draftRow);
  if (phase === "eligibility_done" && Array.isArray(data.outcomes)) {
    setSub(subs, "assess", DRAFT_SUB_LABEL.assess, {
      detail: `${data.outcomes.length} checked`,
      state: "done",
    });
  }
  if (phase === "generate_done" && Array.isArray(data.critiques)) {
    setSub(subs, "write", DRAFT_SUB_LABEL.write, {
      detail: `${data.critiques.length} written`,
      state: "done",
    });
    // Any still-running sub-step (e.g. strengths) is complete now.
    subs.querySelectorAll('[data-state="active"]').forEach((r) => {
      r.dataset.state = "done";
    });
  }
}

function onDraftToken(e) {
  const t = e && e.data && e.data.t;
  if (typeof t !== "string" || !t) return;
  draftStream += t;
  renderDraftLive();
}

/* The engine trace renders inline, inside the Critiques panel (host element
 * #reApiTraceHost), instead of a floating draggable window. It streams the
 * engine's phases while a request runs, then clears itself when generation
 * completes so the panel returns to the critique list. A failure keeps it
 * visible with the error and a manual dismiss control. */

function ensureStyles() {
  if (document.getElementById("reApiTraceStyles")) return;
  const style = document.createElement("style");
  style.id = "reApiTraceStyles";
  style.textContent = `
    #reApiTraceHost{margin:10px 16px 0}
    #reApiTraceHost:empty{display:none}
    /* Panel-top fallback mount (used while the list view is hidden): the module
       is a direct child of the aside and needs its own margin. */
    #critiquesPanelFixed > #reApiTrace{margin:10px 16px 0}
    #reApiTrace{display:flex;flex-direction:column;border:1px solid var(--border,#e5e7eb);
      border-radius:10px;background:var(--surface,#fff);overflow:hidden;
      box-shadow:0 1px 2px rgba(15,23,42,.05);animation:rtFadeIn .16s ease;
      font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif)}
    #reApiTrace.rt-hiding{opacity:0;transition:opacity .28s ease}
    #reApiTrace .rt-head{display:flex;align-items:center;gap:8px;padding:8px 10px;
      border-bottom:1px solid var(--border,#e5e7eb);
      background:color-mix(in srgb,var(--brand,#5b4cf0) 5%,#fff)}
    #reApiTrace .rt-dot{width:8px;height:8px;border-radius:50%;background:var(--brand,#5b4cf0);
      flex:0 0 auto;animation:rtPulse 1.1s ease-in-out infinite}
    #reApiTrace .rt-dot.ok{background:var(--success,#10b981);animation:none}
    #reApiTrace .rt-dot.err{background:var(--danger,#ef4444);animation:none}
    #reApiTrace .rt-title{flex:1;min-width:0;font-weight:600;font-size:12px;letter-spacing:.01em;
      color:var(--text,#111827);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #reApiTrace .rt-close{cursor:pointer;color:var(--text-secondary,#6b7280);background:none;
      border:none;font-size:14px;line-height:1;padding:2px 5px;border-radius:4px}
    #reApiTrace .rt-close:hover{color:var(--text,#111827);background:rgba(15,23,42,.06)}
    #reApiTrace .rt-close:focus-visible{outline:2px solid var(--primary,#4f46e5);outline-offset:1px}
    #reApiTrace .rt-body{overflow:auto;max-height:210px;padding:6px 4px}
    #reApiTrace .rt-step{display:flex;align-items:center;gap:9px;padding:4px 10px;font-size:12px;line-height:1.4}
    #reApiTrace .rt-ico{width:14px;height:14px;flex:0 0 auto;box-sizing:border-box;
      display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1}
    /* Icon state rules use a direct-child combinator so they apply to both
       top-level stage rows (.rt-step) and nested draft sub-steps (.rt-substep). */
    #reApiTrace [data-state="pending"] > .rt-ico{border:2px solid var(--border,#e5e7eb);border-radius:50%}
    /* Solid base ring so the spinner is visible even where color-mix is
       unsupported (there the whole shorthand would be dropped, leaving no
       border to show or spin). color-mix, when available, refines the ring. */
    #reApiTrace [data-state="active"] > .rt-ico{border:2px solid var(--border,#e5e7eb);
      border-top-color:var(--brand,#5b4cf0);border-radius:50%;animation:rtSpin .7s linear infinite}
    @supports (color:color-mix(in srgb,red,blue)){
      #reApiTrace [data-state="active"] > .rt-ico{
        border-color:color-mix(in srgb,var(--brand,#5b4cf0) 25%,transparent);
        border-top-color:var(--brand,#5b4cf0)}
    }
    #reApiTrace [data-state="done"] > .rt-ico::after{content:"✓";color:var(--success,#10b981);font-weight:700}
    #reApiTrace [data-state="error"] > .rt-ico::after{content:"✕";color:var(--danger,#ef4444);font-weight:700}
    #reApiTrace .rt-step-label{flex:1;min-width:0;color:var(--text-secondary,#6b7280);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #reApiTrace .rt-step[data-state="active"] .rt-step-label{color:var(--text,#111827);font-weight:500}
    #reApiTrace .rt-step-detail{flex:0 0 auto;padding-left:10px;color:var(--text-muted,#9ca3af);
      font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
    #reApiTrace .rt-step-detail:empty{display:none}
    #reApiTrace .rt-step[data-state="done"] .rt-step-detail{color:var(--text-secondary,#6b7280)}
    /* Draft sub-steps: indented, smaller rows that stream under the draft row. */
    #reApiTrace .rt-substeps{display:flex;flex-direction:column;margin:-2px 0 2px}
    #reApiTrace .rt-substep{display:flex;align-items:center;gap:8px;
      padding:2px 10px 2px 33px;font-size:11px;line-height:1.4}
    #reApiTrace .rt-substep .rt-ico{width:11px;height:11px;font-size:9px}
    #reApiTrace .rt-substep .rt-step-label{color:var(--text-muted,#9ca3af)}
    #reApiTrace .rt-substep[data-state="active"] .rt-step-label{color:var(--text-secondary,#6b7280);font-weight:500}
    #reApiTrace .rt-substep[data-state="done"] .rt-step-label{color:var(--text-secondary,#6b7280)}
    #reApiTrace .rt-substep .rt-step-detail{font-size:10px}
    /* Error reason is real content: a darker red keeps it >=4.5:1 on the white
       panel (the #ef4444 fallback is only ~3.76:1). */
    #reApiTrace .rt-step-error .rt-step-label{white-space:normal;color:var(--danger,#b91c1c)}
    #reApiTrace .rt-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;
      overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
    @keyframes rtFadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
    @keyframes rtPulse{0%,100%{opacity:1}50%{opacity:.45}}
    @keyframes rtSpin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){
      #reApiTrace{animation:none}
      #reApiTrace .rt-dot{animation:none}
      #reApiTrace [data-state="active"] > .rt-ico{animation:none}
      #reApiTrace.rt-hiding{transition:none}
    }
  `;
  document.head.appendChild(style);
}

let traceHideTimer = null;

// The primary host sits below the generate button, inside the critique list
// view. That view is hidden while a single critique is focused (and during its
// Apply flow), so treat a [hidden] ancestor as "not visible" and fall back to
// mounting at the top of the panel — keeping progress, and any failure, visible.
function isViewHidden(node) {
  for (let n = node; n && n.id !== "critiquesPanelFixed"; n = n.parentElement) {
    if (n.nodeType === 1 && n.hasAttribute("hidden")) return true;
  }
  return false;
}

function traceHost() {
  const inline = document.getElementById("reApiTraceHost");
  if (inline && !isViewHidden(inline)) return inline;
  // Fallbacks: the panel itself (focus/apply flow), then <body> (harnesses).
  return document.getElementById("critiquesPanelFixed") || inline || document.body;
}

// Place the module in its host. In the panel-top fallback it sits right under
// the header, above the focus card; in a normal host it just appends.
function mountInto(host, node) {
  if (host.id === "critiquesPanelFixed") {
    const header = host.querySelector(".panel-header");
    host.insertBefore(node, header ? header.nextSibling : host.firstChild);
    return;
  }
  host.appendChild(node);
}

function el() {
  ensureStyles();
  const host = traceHost();
  let node = document.getElementById("reApiTrace");
  if (node) {
    if (node.parentElement !== host) mountInto(host, node);
    return node;
  }
  node = document.createElement("div");
  node.id = "reApiTrace";
  node.setAttribute("role", "status");
  node.setAttribute("aria-label", "Engine activity");
  node.innerHTML = `
    <div class="rt-head">
      <span class="rt-dot" id="rtDot"></span>
      <span class="rt-title" id="rtTitle">Engine</span>
      <button class="rt-close" id="rtClose" type="button" aria-label="Hide engine activity">×</button>
    </div>
    <div class="rt-body" id="rtBody"></div>`;
  mountInto(host, node);
  node.querySelector("#rtClose").addEventListener("click", removeTrace);
  return node;
}

function removeTrace() {
  clearTimeout(traceHideTimer);
  traceHideTimer = null;
  document.getElementById("reApiTrace")?.remove();
}

// The stage rows convey progress visually; the ✓/✕ icons and header dot are
// aria-hidden. So terminal states (success/failure) would otherwise reach a
// screen reader as silence. Writing into a visually-hidden node inside the
// role="status" region speaks the outcome before the panel fades away.
function announce(node, text) {
  let sr = node.querySelector(".rt-sr");
  if (!sr) {
    sr = document.createElement("span");
    sr.className = "rt-sr";
    node.appendChild(sr);
  }
  sr.textContent = text;
}

// A finished run clears itself so the panel returns to the critique list. A
// short delay lets the "done" state register, then a fade removes the module.
function dismissTrace(delay = 420) {
  const node = document.getElementById("reApiTrace");
  if (!node) return;
  clearTimeout(traceHideTimer);
  traceHideTimer = setTimeout(() => {
    node.classList.add("rt-hiding");
    traceHideTimer = setTimeout(removeTrace, 280);
  }, delay);
}

// Trace phases we never surface as their own stage row: the overall run
// bookends, the streaming token firehose, and the terminal signals (done/error
// are represented by the header dot and, for real API failures, fail()).
const NON_STAGE_PHASES = new Set(["run_start", "done", "error"]);

// Momentary phases that carry a completed result (they have no matching
// "_done"): seeing one settles its stage rather than leaving it spinning.
const MOMENTARY_DONE = new Set(["constraint_filter", "validate"]);
function marksGroupDone(phase) {
  return phase.endsWith("_done") || MOMENTARY_DONE.has(phase);
}

// Find the row for a stage group, creating it (and settling any still-running
// stage to done) if this is the first event we've seen for that group.
function upsertStage(body, group) {
  let row = body.querySelector(`[data-group="${group}"]`);
  if (row) return row;
  body.querySelectorAll('[data-state="active"]').forEach((r) => {
    r.dataset.state = "done";
  });
  row = document.createElement("div");
  row.className = "rt-step";
  row.dataset.group = group;
  row.dataset.state = "active";
  row.innerHTML = `<span class="rt-ico" aria-hidden="true"></span><span class="rt-step-label"></span><span class="rt-step-detail"></span>`;
  row.querySelector(".rt-step-label").textContent = GROUP_LABEL[group] || titleCaseStep(group);
  body.appendChild(row);
  return row;
}

export const tracePanel = {
  start(title) {
    clearTimeout(traceHideTimer);
    traceHideTimer = null;
    draftStream = "";
    draftSig = "";
    const node = el();
    node.classList.remove("rt-hiding");
    node.querySelector("#rtTitle").textContent = title || "Engine";
    node.querySelector("#rtBody").innerHTML = "";
    node.querySelector("#rtDot").className = "rt-dot";
    const sr = node.querySelector(".rt-sr");
    if (sr) sr.textContent = "";
  },
  event(e) {
    const phase = e && e.phase;
    if (!phase || NON_STAGE_PHASES.has(phase)) return;
    // Generation tokens drive the live draft sub-steps; other token firehoses
    // are ignored (the stepper shows stages, not raw model output).
    if (phase === "generate_token") return onDraftToken(e);
    if (phase.endsWith("_token")) return;
    const node = el();
    node.classList.remove("rt-hiding");
    const body = node.querySelector("#rtBody");
    const group = groupOf(phase);
    const row = upsertStage(body, group);
    if (group === "draft") {
      // The draft row carries its result through sub-steps, not a row detail.
      finalizeDraftSubsteps(body, row, phase, e);
    } else {
      const detail = detailFor(group, phase, e);
      if (detail != null) row.querySelector(".rt-step-detail").textContent = detail;
    }
    if (marksGroupDone(phase)) row.dataset.state = "done";
    body.scrollTop = body.scrollHeight;
  },
  done() {
    const node = document.getElementById("reApiTrace");
    if (!node) return;
    node.querySelectorAll(".rt-step, .rt-substep").forEach((r) => {
      r.dataset.state = "done";
    });
    node.querySelector("#rtDot").className = "rt-dot ok";
    announce(node, "Engine work complete.");
    dismissTrace();
  },
  // Only ever called when the engine/API request genuinely fails. It marks the
  // in-flight stage as errored, shows the reason, and stays visible (no
  // auto-dismiss) so the author can read what went wrong.
  fail(message) {
    clearTimeout(traceHideTimer);
    traceHideTimer = null;
    const node = el();
    node.classList.remove("rt-hiding");
    node.querySelector("#rtDot").className = "rt-dot err";
    const body = node.querySelector("#rtBody");
    body.querySelectorAll('[data-state="active"]').forEach((r) => {
      r.dataset.state = "error";
    });
    const row = document.createElement("div");
    row.className = "rt-step rt-step-error";
    row.dataset.state = "error";
    row.innerHTML = `<span class="rt-ico" aria-hidden="true"></span><span class="rt-step-label"></span>`;
    row.querySelector(".rt-step-label").textContent = message;
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  },
};
