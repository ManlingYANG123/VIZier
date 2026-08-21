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

Every recorded event carries the four required identifiers plus a relative clock,
stamped in `recordStudyEvent`:

| field | meaning |
|---|---|
| `participantId` | who |
| `sessionId` | which session (new UUID per Start) |
| `timestamp` | ISO wall-clock |
| `logId` | monotonic per-session sequence number |
| `tRelMs` | milliseconds since session start (for ordering / durations) |

## Captured event catalog

"New" = added in this instrumentation pass. Un-marked rows were already emitted by
the product and are mirrored into the study log automatically (the hook in
`appendInteractionEvent`).

| kind | trigger | key fields | new |
|---|---|---|---|
| `session_started` | session starts | | |
| `context_generation_requested` | "Describe this dashboard's context" (AI) | source | ✅ |
| `context_saved` | Confirm / Continue-Without-Context | scope, hasContext, **generatedText, submittedText, edited, origin** | ✅ (fields) |
| `inferred_context_accepted` | "Add as Context" on a learned-context card | field, detail | |
| `inferred_context_dismissed` | "Dismiss" on a learned-context card | field, detail | |
| `critique_requested` | Generate / Regenerate / focused Ask | **scope, requestText, trigger, hadPriorCritiques, activeScopes** | ✅ |
| `local_critique_requested` | region select + submit | detail (exact text), bounds, dimension | |
| `critiques_displayed` | a review returns and renders | count, list of {id,title,dimension,priority,status} | ✅ |
| `critique_opened` | click a critique card / history item | critiqueId | |
| `critique_details_expanded` / `_collapsed` | toggle "Why & Evidence" | critiqueId, dimension | ✅ |
| `evidence_region_revealed` | "recall region" jump on the canvas | critiqueId | ✅ |
| `interaction_replayed` | "Run interaction test on the canvas" | critiqueId | ✅ |
| `preview_viewed` | Original/Proposed (before/after) toggle | phase | |
| `critique_closed` | Back to the critique list | critiqueId | ✅ |
| `recommendation_accepted` | Accept Change / Mark as Considered | critiqueId, dimension, proposalKind | |
| `changes_applied` | a successful apply commits | recommendationIds, changedTargets | |
| `working_draft_reevaluated` | post-apply re-evaluation | remainingFindings | |
| `recommendation_apply_failed` | apply did not commit (single or batch) | **via, reason, critiqueId(s)** | ✅ |
| `recommendation_rejected` | Reject | critiqueId, dimension | |
| `critique_rationale_added` / `_updated` / `_removed` | rationale modal | critiqueId, dimension | |
| `checkpoint_saved` | Save Checkpoint | recommendationIds | |

Batch-vs-single apply is derivable without a separate field:
`changes_applied.recommendationIds.length > 1` ⇒ batch; `recommendation_apply_failed`
already carries an explicit `via`.

## Taxonomy triage

### A. Context panel

- A1 open / close the panel — **[SKIP — not supported]** (panel is always-on; only a
  resize drag exists, which is passive).
- A2 add / modify / delete a context item — **[CAPTURE]** the confirmed result via
  `context_saved`. The event stores **generatedText** (last AI draft) and
  **submittedText** (what the author confirmed), plus `edited` / `origin`
  (`ai-unchanged` | `ai-edited` | `user-written` | `none`). Per-keystroke edits
  are not logged.
- A3 generate / regenerate context (AI) — **[CAPTURE]** `context_generation_requested`.
- A4 accept / modify-before-accept / reject an inferred suggestion —
  **[CAPTURE]** `inferred_context_accepted` / `inferred_context_dismissed`, with
  `generatedText` vs `submittedText` on accept (the card is editable before Add).
- A5 distinct goal / audience / constraints fields — **[CAPTURE]** in the
  `context_saved` snapshot (onboarding splits these; the workspace box merges them).
- A6 add a contextual constraint (design doc / steering note / rule toggles) —
  **[SKIP — deferred]** discrete and loggable, but a secondary setup workflow; add
  only if constraint-use becomes a research question.
- A7 proceed without context — **[CAPTURE]** via `context_saved` with `hasContext:false`.

### B. Feedback request

- B8 full critique request — **[CAPTURE]** `critique_requested` (scope `full`). *This
  was the single biggest gap: the primary action previously emitted nothing.*
- B9 focused review request — **[CAPTURE]** `critique_requested` (scope `focused`,
  with exact `requestText`).
- B10 select a feedback dimension — **[CAPTURE]** as `activeScopes` on
  `critique_requested` (the set active at request time), and as `dimension` on
  `local_critique_requested`. Per-checkbox toggles are not logged individually.
- B11 select a region for a local critique — **[CAPTURE]** `local_critique_requested`
  (with bounds + exact text).
- B12 cancel an in-flight request — **[SKIP — not supported]** (no abort path).
- B13 resubmit / regenerate — **[CAPTURE]** as `hadPriorCritiques:true` (+ `trigger`)
  on `critique_requested`.
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

- C18 critique "displayed" — **[CAPTURE]** `critiques_displayed` (the reliable
  *system-shown* list, not a gaze signal).
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
- D31 accept as-is / partial (batch) — **[CAPTURE]** `recommendation_accepted`; batch
  is derivable from `changes_applied.recommendationIds.length`.
- D32 reject / dismiss — **[CAPTURE]** `recommendation_rejected`.
- D33 request a different recommendation — **[SKIP — not supported]** (only whole-set
  regenerate, captured by B13).
- D34 refine / edit before applying — **[SKIP — not supported]**.
- D35 apply success vs failure — **[CAPTURE]** success = `changes_applied`; failure =
  `recommendation_apply_failed` (new; previously failures were invisible).
- D36 undo / redo — **[SKIP — not supported]** (checkpoints are compare-only).
- D37 reverse a prior decision — **[SKIP — not supported]** (decisions are final;
  history is view-only).

## What think-aloud + screen recording covers (not telemetry)

These are the perception/reasoning signals we intentionally leave to the video:

- Where attention went; what was actually read in a rationale or evidence block
  (C20, C21).
- Hover / highlight behavior (C22).
- Scanning the list and skipping critiques without opening them (C27 — partly
  derivable, but the *why* is think-aloud).
- What the participant would have asked as a follow-up, or wished they could reject /
  undo (B14, D33, D34, D36, D37 — features that do not exist).
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
- **Friction**: `recommendation_apply_failed` rate and reasons.

## Where the new hooks live (`src/app.js`)

All new signals go through `recordStudyAction(kind, summary, data)` — a no-op unless a
session is active, and never on the product's 100-capped journal or preference
synthesis path (study-only, zero product-behavior impact).

- `critique_requested`, `critiques_displayed` — in `runAIAssist`.
- `critique_details_expanded/_collapsed`, `evidence_region_revealed`,
  `interaction_replayed`, `recommendation_apply_failed` (single) — in the critique
  focus view (`renderInspector`).
- `critique_closed` — `focusBackButton` handler.
- `recommendation_apply_failed` (batch) — `batchApplyButton` handler.
- `context_generation_requested` — `contextInferBtn` handler.
- `hasContext` — added to the existing `context_saved` payload.
