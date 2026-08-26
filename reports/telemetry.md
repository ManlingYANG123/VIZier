# VIZier User-Study Telemetry — What We Capture and Why

This note records which in-app events VIZier logs for the user study, which it
deliberately does **not**, and the reasoning behind each call. It is the companion
to the frontend module `src/study-session.js` (the uncapped, refresh-surviving
event log) and the backend store `re_api/src/study-store.ts` (per-save upload to
S3, local `data/` fallback in dev).

## Guiding rule

We instrument only **reliable, discrete user interactions** — a click, a toggle, a
panel expand/collapse, a selection, a form submit. These are signals the system
observes unambiguously.

We do **not** instrument **perception or attention** — where the eye went, what was
read, hover, scan, dwell. Those are noisy or impossible to capture in-app and are
better recovered from **think-aloud + screen recording**.

Important nuance: "did the participant look at the rationale/evidence" is an
attention question (→ think-aloud), but "did the participant **open** the Why &
Evidence panel" is a discrete click (→ **capture**). We log the *act of opening*,
never a claim about reading.

## Marker legend

- **[CAPTURE]** — instrumented as a study event (the event `kind` is given).
- **[SKIP — reason]** — intentionally not instrumented; the reason is one of:
  - *not supported* — the product has no such affordance, so there is nothing to log.
  - *hover/passive → think-aloud* — only an unreliable mouse/scroll/gaze signal
    exists; use think-aloud instead.
  - *attention → think-aloud (the discrete act is captured separately)* — the
    "looking/reading" is a think-aloud signal; the click that precedes it is logged.

## Base fields (on every event)

Every recorded event carries a schema-v2 envelope, stamped in `recordStudyEvent`:

| field | meaning |
|---|---|
| `eventName` | same as `kind` (stable name for analysis) |
| `schemaVersion` | currently `2` |
| `participantId` | who |
| `sessionId` | which session (new UUID per Start) |
| `timestamp` | ISO wall-clock |
| `tRelMs` | milliseconds since session start (for ordering / durations) |
| `logId` / `sequenceNumber` | monotonic per-session sequence (same value; use to detect gaps) |
| `dashboardId` | current artifact id |
| `dashboardVersion` | working-draft version at event time |
| `appVersion` | VIZier build id (`0.2.0`) |

## Captured event catalog

"New" = added in this instrumentation pass. Un-marked rows were already emitted by
the product and are mirrored into the study log automatically (the hook in
`appendInteractionEvent`).

| kind | trigger | key fields | new |
|---|---|---|---|
| `session_started` | session starts | | |
| `logging_status_changed` | logging started / degraded / recovered / stopped | status | ✅ |
| `study_phase_changed` | researcher sets practice / brief_reading / timed_task / post_session | from, to | ✅ |
| `researcher_annotation` | researcher notes assistance, interruption, technical problem, deviation, bookmark | annotationKind, note | ✅ |
| `session_ended` | End & save | reason, eventCount | ✅ |
| `final_state_captured` | End & save, immediately before deactivate | critiqueIds, dashboardVersion | ✅ |
| `context_generation_requested` | AI describe-context | source, generationId | ✅ |
| `context_generation_completed` / `_failed` | infer succeeds or fails | generationId, latencyMs, reason | ✅ |
| `context_saved` | Confirm / Continue-Without-Context | **outcome** (`confirmed` \| `continued_without_context`), contextVersion, source, generatedText, submittedText, edited, origin | ✅ (fields) |
| `inferred_context_accepted` | "Add as Context" on a learned-context card | field, detail | |
| `inferred_context_dismissed` | "Dismiss" on a learned-context card | field, detail | |
| `critique_requested` | Generate / regenerate / focused Ask / local / stale recovery | **requestId, requestMode, parentRequestId, scope, queryText, dashboardVersion** | ✅ |
| `local_critique_requested` | region select + submit | detail, bounds, requestId | |
| `critiques_displayed` | a review **successfully** renders | requestId, critiqueIds, critiqueCount, latencyMs, model/prompt/systemVersion | ✅ |
| `critique_regenerated` | stale-dashboard recovery resolves | requestId, outcome (`updated` \| `retired`) | ✅ |
| `critique_request_failed` | a review request does not complete | requestId, requestMode, reason, latencyMs | ✅ |
| `critique_opened` | click a critique card / history item | critiqueId | |
| `critique_details_expanded` / `_collapsed` | toggle "Why & Evidence" | critiqueId, dimension | ✅ |
| `evidence_region_revealed` | "recall region" jump on the canvas | critiqueId | ✅ |
| `interaction_replayed` | "Run interaction test on the canvas" | critiqueId | ✅ |
| `preview_viewed` | Original/Proposed (before/after) toggle | phase | |
| `critique_closed` | Back to the critique list | critiqueId, **dwellMs** | ✅ |
| `recommendation_accepted` | Accept Change **or** Mark as Considered | **decision** (`apply` \| `considered`), applyId, dashboardVersion, reason | ✅ (fields) |
| `recommendation_deferred` | Defer | decision=`defer` | ✅ |
| `recommendation_apply_requested` | author starts an apply (denominator) | applyId, via, requestedCritiqueIds | ✅ |
| `changes_applied` | a successful apply commits | applyId, committedCritiqueIds, before/after version | |
| `dashboard_changed` | dashboard version actually moved | source (`vizier_apply` \| `system`), operation, relatedCritiqueIds, relatedApplyId | ✅ |
| `working_draft_reevaluated` | post-apply re-evaluation | remainingFindings | |
| `recommendation_apply_failed` | apply did not commit | applyId, via, failureStage, rollback | ✅ |
| `recommendation_rejected` | Reject | decision=`reject`, reason | |
| `critiques_unresolved` | End & save: displayed with no later decision | critiqueIds | ✅ |
| `critique_rationale_added` / `_updated` / `_removed` | rationale modal | critiqueId, dimension | |
| `dashboard_state_restored` | Reset demo **or** restore a saved checkpoint | source, checkpointId, before/after version | ✅ |

`requestMode` is one of: `generate` | `regenerate_all` | `focused_ask` | `stale_recovery` | `local`.

`recommendation_accepted` with `decision:"apply"` is **intent/commit of an engine apply**, not a substitute for `recommendation_apply_requested`. `decision:"considered"` is Mark as Considered (guidance). Ignore/unresolved is derived at session end: ids in `critiques_displayed` with no later decision.

The product has **no** undo/redo. Restoring a saved checkpoint or Reset is `dashboard_state_restored`. Manual dashboard edits also have no editor path, so `dashboard_changed.source=manual` is not produced yet.

Batch-vs-single apply is explicit on `via` and also derivable from `requestedCritiqueIds.length`.

## Taxonomy triage

### A. Context panel

- A1 open / close the panel — **[SKIP — not supported]** (panel is always-on; only a
  resize drag exists, which is passive).
- A2 add / modify / delete a context item — **[CAPTURE]** the confirmed result via
  `context_saved`. The event stores **generatedText** (last AI draft) and
  **submittedText** (what the author confirmed), plus `edited` / `origin`
  (`ai-unchanged` | `ai-edited` | `user-written` | `none`). Per-keystroke edits
  are not logged.
- A3 generate / regenerate context (AI) — **[CAPTURE]** `context_generation_requested`,
  then `context_generation_completed` or `context_generation_failed` (with latency).
- A4 accept / modify-before-accept / reject an inferred suggestion —
  **[CAPTURE]** `inferred_context_accepted` / `inferred_context_dismissed`, with
  `generatedText` vs `submittedText` on accept (the card is editable before Add).
- A5 distinct goal / audience / constraints fields — **[CAPTURE]** in the
  `context_saved` snapshot (onboarding splits these; the workspace box merges them).
- A6 add a contextual constraint (design doc / steering note / rule toggles) —
  **[SKIP — deferred]** discrete and loggable, but a secondary setup workflow; add
  only if constraint-use becomes a research question.
- A7 proceed without context — **[CAPTURE]** via `context_saved` with
  `outcome:"continued_without_context"` (`hasContext:false`).

### B. Feedback request

- B8 full critique request — **[CAPTURE]** `critique_requested` with
  `requestMode` `generate` or `regenerate_all`, plus `requestId` shared with
  `critiques_displayed` / `critique_request_failed`.
- B9 focused review request — **[CAPTURE]** `critique_requested` (scope `focused`,
  with exact `requestText`).
- B10 select a feedback dimension — **[CAPTURE]** as `activeScopes` on
  `critique_requested` (the set active at request time), and as `dimension` on
  `local_critique_requested`. Per-checkbox toggles are not logged individually.
- B11 select a region for a local critique — **[CAPTURE]** `local_critique_requested`
  (with bounds + exact text).
- B12 cancel an in-flight request — **[SKIP — not supported]** (no abort path).
- B13 resubmit / regenerate — **[CAPTURE]** as `hadPriorCritiques:true` (+ `trigger`)
  on `critique_requested`. Regenerating a *single* stale critique (the
  stale-dashboard recovery path) additionally emits `critique_regenerated` with
  the `outcome` — `updated` when a fresh solution replaces it, `retired` when the
  issue no longer applies to the current dashboard.
- B14 follow-up sub-types (ask-why / clarify / alternative / elaborate) —
  **[SKIP — not supported]** (no follow-up affordance). *What a participant would ask
  next is a think-aloud signal.*
- B15 narrow / broaden scope — **[CAPTURE]** via the `activeScopes` snapshot on each
  request (the effect is visible in the set); no per-toggle event.
- B16 reference a previous critique — **[SKIP — not supported]** (only implicit, via
  saved rationale, which is already logged).
- B17 exact request text — **[CAPTURE]** for all three request paths now:
  `local_critique_requested.detail`, and `critique_requested.requestText`
  (focused/open-ended). Full reviews carry `requestText:null` (no text by design).

### C. Critique exposure / inspection

- C18 critique "displayed" — **[CAPTURE]** `critiques_displayed` when a review
  **successfully** renders (full, focused, and selected-region). If the request
  fails, we log `critique_request_failed` instead. Only one review runs at a
  time, so a second ask cannot swallow the first's displayed event.
- C19 expand / collapse critique details — **[CAPTURE]** `critique_details_expanded` /
  `_collapsed`.
- C20 view an explanation — **[SKIP — attention → think-aloud; the discrete open is
  captured by C19]** (the rationale lives inside the same Why & Evidence panel).
- C21 view localized evidence — **[SKIP — attention → think-aloud; the discrete open is
  captured by C19]**, plus the explicit jump `evidence_region_revealed` when used.
- C22 hover to highlight the element — **[SKIP — mouse hover, unreliable data]**.
- C23 navigate / replay a dashboard state — **[CAPTURE]** `evidence_region_revealed`
  and `interaction_replayed`.
- C24 inspect a recommendation — **[CAPTURE]** = `critique_opened`.
- C25 inspect related critiques — **[SKIP — not supported]** (relationships are static
  text, not clickable).
- C26 switch between / return to critiques — **[CAPTURE]** re-`critique_opened` on
  switch; `critique_closed` on return to the list.
- C27 scroll past without opening — **[SKIP — passive scroll → think-aloud]**
  (derivable instead: in `critiques_displayed` but never in a `critique_opened`).
- C28 dismiss a critique — **[CAPTURE]** = `recommendation_rejected`.
- C29 mark resolved — **[SKIP — not a user action]** (status flips automatically on a
  successful apply; implied by `changes_applied`).

### D. Recommendation / decision

- D30 preview / exit preview — **[CAPTURE]** `preview_viewed` (the before/after
  Original ↔ Proposed toggle — a high-value, unambiguous signal).
- D31 accept as-is / partial (batch) — **[CAPTURE]** `recommendation_apply_requested`
  then, on success, `recommendation_accepted` with `decision:"apply"`,
  `changes_applied`, and `dashboard_changed`. Mark as Considered is
  `recommendation_accepted` with `decision:"considered"` — not an apply.
- D32 reject / dismiss — **[CAPTURE]** `recommendation_rejected` (`decision:"reject"`).
- D33 request a different recommendation — **[SKIP — not supported]** (only whole-set
  regenerate, captured by B13).
- D34 refine / edit before applying — **[SKIP — not supported]** (no in-app spec editor,
  so `dashboard_changed.source=manual` is not emitted).
- D35 apply success vs failure — **[CAPTURE]** requested = `recommendation_apply_requested`;
  success = `changes_applied`; failure = `recommendation_apply_failed` (shared `applyId`).
- D36 undo / redo — **[SKIP — not supported]**. Restoring a saved checkpoint or Reset
  emits `dashboard_state_restored`.
- D37 reverse a prior accept/reject decision — **[SKIP — not supported]** (those
  decisions stay in history).
- D38 defer — **[CAPTURE]** `recommendation_deferred`. Ignore/unresolved is emitted at
  End as `critiques_unresolved` (displayed IDs with no later decision).

## What think-aloud + screen recording covers (not telemetry)

These are the perception/reasoning signals we intentionally leave to the video:

- Where attention went; what was actually read in a rationale or evidence block
  (C20, C21).
- Hover / highlight behavior (C22).
- Scanning the list and skipping critiques without opening them (C27 — partly
  derivable, but the *why* is think-aloud).
- What the participant would have asked as a follow-up (B14, D33 — features that do
  not exist). Manual in-spec edits (D34) also still need think-aloud.
- The reasoning behind any accept/reject/skip decision.

## Derived metrics (no extra instrumentation needed)

- **Displayed vs inspected**: `critiques_displayed` minus the set that ever appears in
  a `critique_opened`.
- **Time on a critique**: `critique_opened` → `critique_closed` interval (uses
  `tRelMs`).
- **Iteration / dissatisfaction**: repeated `critique_requested` with
  `hadPriorCritiques:true`.
- **Depth of engagement per critique**: presence of `critique_details_expanded`,
  `evidence_region_revealed`, `interaction_replayed`, `preview_viewed` for that
  `critiqueId`.
- **Ignored / unresolved critiques**: ids in any `critiques_displayed.critiqueIds`
  that never appear with a later `decision` of apply / considered / reject.
- **Apply success rate**: `recommendation_apply_requested` vs `changes_applied` /
  `recommendation_apply_failed` joined on `applyId`.
- **Request latency**: `critiques_displayed.latencyMs` or failed counterpart,
  joined on `requestId`.

## Where the new hooks live (`src/app.js`)

All new signals go through `recordStudyAction(kind, summary, data)` — a no-op unless a
session is active, and never on the product's 100-capped journal or preference
synthesis path (study-only, zero product-behavior impact).

- `critique_requested`, `critiques_displayed`, `critique_request_failed` — in
  `runAIAssist` (full/focused), local-review submit, and `regenerateOneCritique`,
  joined by `requestId`.
- `recommendation_apply_requested` / `_failed` / `dashboard_changed` — in
  `applyRecommendationSelection`.
- `session_ended`, `final_state_captured`, `study_phase_changed`,
  `researcher_annotation` — study session modal.
- `context_generation_requested` / `_completed` / `_failed` — workspace infer,
  upload infer, and onboarding infer.

## Session-end dashboard files

When **End & save** (and **Save now**) runs, VIZier writes
high-resolution PNG and reloadable JSON for every checkpoint plus the live
final dashboard, beside the event log:

```
studies/{participant}/
  {session}_{stamp}.json            ← event log (no embedded images)
  {session}_checkpoint-01.json
  {session}_checkpoint-01.png
  {session}_checkpoint-02.json
  ...
  {session}_final.json
  {session}_final.png
  {session}_scale-post-{stamp}.json
```

PNGs are 2× the canvas CSS size. JSON is `{ dashboard, tiles }` and can be
re-opened in VIZier. The in-app revision rail still uses 770px WebP thumbnails.
A local zip of the dashboard files is also downloaded on End.
