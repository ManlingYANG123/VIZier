# VIZier Telemetry Verification Report

**Updated:** 2026-08-27
**Scope:** three-stage group runner (practice, formal use, questionnaire/interview),
workspace telemetry, saved artifacts, and request/apply lifecycle integrity.

## Outcome

The telemetry pipeline is research-usable after this pass. Events remain in an
uncapped, refresh-surviving study log, carry monotonic ids and timestamps, and
are uploaded with checkpoint/final JSON and image artifacts. The implementation
now closes the gaps found in two local end-to-end study sessions.

## Changes verified in code

- **Refresh durability:** the active practice/formal workspace is captured after
  mutations (250 ms debounce) and flushed on hidden/pagehide, navigation, and
  stage completion. A hard refresh no longer silently returns the dashboard to
  an earlier phase snapshot while keeping a newer event history.
- **Request terminal states:** every critique request can resolve as displayed,
  regenerated, failed, cancelled, or discarded. Automatic stale recovery logs
  late-result reasons such as version change, superseded request, missing card,
  or decided card.
- **Combined preview:** mode entry/exit, selection changes, and preview
  requested/ready/failed/cancelled/exited are logged with selection, exclusions,
  validation state, and latency. The duplicate `critique_reviewed_for_preview`
  event was removed; the canonical `recommendation_reviewed` event remains.
- **Critique inspection:** automatic result focus, list/history opening, switching,
  and closing share one open/close path. Close includes dwell time and reason.
- **Formal-task boundary:** `critiques_unresolved` and `final_state_captured` are
  emitted before final JSON/PNG capture; unresolved ids are limited to the formal
  phase rather than contaminated by practice.
- **Reproducibility:** every event and bundle includes `appVersion` and `buildId`.
  Heroku uses its source commit; local/test builds are explicitly marked. Review
  terminal events retain model/prompt/engine/few-shot metadata when available.
- **Payload completeness:** `critiques_displayed` keeps diagnosis, rationale,
  suggestion, evidence, target, proposal, request/scope, revision, and evaluated
  dashboard version—not only card labels.
- **Timing:** phase timers start when the workspace/questionnaire mounts, so an
  omitted Start timer click cannot produce a zero-timer session.
- **Persistence degradation:** runner localStorage writes are guarded, while the
  study log continues to emit its existing degraded/recovered status signals.

## Event-chain invariants

For analysis, enforce these joins:

1. `critique_requested.requestId` → one terminal event:
   `critiques_displayed`, `critique_regenerated`, `critique_request_failed`,
   `critique_request_cancelled`, or `critique_request_discarded`. A later
   `refinement_alternative_selected` is a participant decision, not a second
   request terminal.
2. `recommendation_apply_requested.applyId` → `changes_applied` or
   `recommendation_apply_failed`.
3. `batch_preview_requested.previewId` → `batch_preview_ready`,
   `batch_preview_failed`, or `batch_preview_cancelled`.
4. `critique_opened` → `critique_closed`; an open interval at session end is
   right-censored rather than interpreted as attention.
5. Formal completion → `critiques_unresolved` + `final_state_captured` before
   `session_ended` and artifact upload.

## Validation

The source-of-truth event catalog and interpretation guidance live in
[telemetry.md](telemetry.md). Automated verification covers the envelope,
bundle/media behavior, group runner persistence hooks, and frontend/backend
behavior. On this update: frontend `205/205`, backend `330/330`, and the Vite
production build completed successfully.
