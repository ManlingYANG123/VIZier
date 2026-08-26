# VIZier Telemetry Report

**Generated:** 2026-08-21 · **Node:** v26.3.0
**Method:** ran both test suites 3× each (no code changed), then traced every telemetry
call site in the source. This report describes **what the code actually records today**,
cross-checked against the design doc [telemetry.md](telemetry.md).

---

## 1. Test results (reliability check)

Each suite was run 3 times back-to-back. Fully deterministic — identical results every run.
Full log: [reports/test-run-log.txt](test-run-log.txt).

| Suite | Command | Tests | Pass | Fail | Runs |
|---|---|---|---|---|---|
| Frontend | `node --test tests/*.test.js` | 151 | 151 | 0 | 3/3 green |
| Backend (`re_api`) | `node --test tests/*.test.ts` | 289 | 289 | 0 | 3/3 green |

No flakiness, no skipped/todo tests. One benign warning in the frontend suite
(`localStorage is not available` — expected under `node --test` without a storage file).

Telemetry-specific coverage that passed:
- `study telemetry pairs review requests with displayed or failed, and checkpoint counts match applied ids` — [tests/static-entry.test.js:794](../tests/static-entry.test.js#L794)
- `session end archives high-resolution PNG and reloadable JSON…` — [tests/static-entry.test.js:777](../tests/static-entry.test.js#L777)
- `saveStudySession writes every file into one folder per participant` + path-traversal rejection — [re_api/tests/study-store.test.ts](../re_api/tests/study-store.test.ts)
- `study-session.js` bundle/artifact/zip tests — [tests/study-session.test.js](../tests/study-session.test.js)

---

## 2. How an event gets recorded (three paths)

Every study event is stamped in `recordStudyEvent` with the base fields below, then pushed to
an **uncapped, refresh-surviving** log ([src/study-session.js](../src/study-session.js)),
separate from the product's 100-event journal.

**Base fields on every event** (`recordStudyEvent`, [study-session.js:124](../src/study-session.js#L124)):
`participantId`, `sessionId`, `timestamp` (ISO), `logId` (monotonic per session), `tRelMs` (ms since session start).

| Path | Where | What it records |
|---|---|---|
| **A. Session-level** | `startStudySession` ([study-session.js:114](../src/study-session.js#L114)) | `session_started` only |
| **B. Study-only UI signal** | `recordStudyAction(kind,…)` in [src/app.js](../src/app.js) | signals that are **not** in the product journal (displayed, opened-panels, failures, etc.) |
| **C. Journal mirror** | `appendInteractionEvent()` → `recordStudyEvent()` ([app.js:2761](../src/app.js#L2761)) | every product-journal event is *also* mirrored into the study log before the 100-cap applies |

---

## 3. Event catalog — what is actually emitted

Verified by locating each `recordStudyAction` / `appendInteractionEvent` call in `src/app.js`.

### Session
| kind | trigger | source | in doc? |
|---|---|---|---|
| `session_started` | study session starts (no extra fields; `condition` removed) | [study-session.js:113](../src/study-session.js#L113) | ✅ |

### Context panel
| kind | trigger | source | in doc? |
|---|---|---|---|
| `context_generation_requested` | "Describe this dashboard's context" (AI) | [app.js:3893](../src/app.js#L3893) | ✅ |
| `context_saved` | Confirm context (workspace + onboarding) | [app.js:4030](../src/app.js#L4030), [app.js:9558](../src/app.js#L9558) | ✅ |
| `inferred_context_accepted` | "Add as Context" on a learned-context card | [app.js:3064](../src/app.js#L3064) | ✅ |
| `inferred_context_dismissed` | "Dismiss" on a learned-context card | [app.js:3086](../src/app.js#L3086) | ✅ |

### Feedback request
| kind | trigger | source | in doc? |
|---|---|---|---|
| `critique_requested` | full/focused review **and** regenerate-one | [app.js:7261](../src/app.js#L7261), [app.js:7018](../src/app.js#L7018) | ✅ |
| `local_critique_requested` | region select + submit | [app.js:7895](../src/app.js#L7895) | ✅ |
| `critiques_displayed` | a review successfully renders | [app.js:7216](../src/app.js#L7216) | ✅ |
| `critique_request_failed` | review request fails (full/focused + local) | [app.js:7342](../src/app.js#L7342), [app.js:7914](../src/app.js#L7914) | ✅ |
| `critique_regenerated` | regenerated critique updated / no longer applies (`outcome`) | [app.js:7062](../src/app.js#L7062), [app.js:7090](../src/app.js#L7090) | ✅ (added) |

### Critique inspection
| kind | trigger | source | in doc? |
|---|---|---|---|
| `critique_opened` | open a critique card / history item | [app.js:4601](../src/app.js#L4601), [app.js:4899](../src/app.js#L4899) | ✅ |
| `critique_details_expanded` / `_collapsed` | toggle "Why & Evidence" | [app.js:6792](../src/app.js#L6792) | ✅ |
| `evidence_region_revealed` | "recall region" jump on the canvas | [app.js:6782](../src/app.js#L6782) | ✅ |
| `interaction_replayed` | "Run interaction test on the canvas" | [app.js:6846](../src/app.js#L6846) | ✅ |
| `preview_viewed` | Original/Proposed before-after toggle | [app.js:6419](../src/app.js#L6419) | ✅ |
| `critique_closed` | Back to the critique list | [app.js:7763](../src/app.js#L7763) | ✅ |

### Recommendation / decision
| kind | trigger | source | in doc? |
|---|---|---|---|
| `recommendation_accepted` | Accept Change / Mark as Considered | [app.js:5361](../src/app.js#L5361), [app.js:6872](../src/app.js#L6872) | ✅ |
| `recommendation_rejected` | Reject | [app.js:6895](../src/app.js#L6895) | ✅ |
| `recommendation_apply_failed` | apply did not commit (single + batch) | [app.js:6858](../src/app.js#L6858), [app.js:7798](../src/app.js#L7798) | ✅ |
| `changes_applied` | a successful apply commits | [app.js:5370](../src/app.js#L5370) | ✅ |
| `working_draft_reevaluated` | post-apply re-evaluation | [app.js:5378](../src/app.js#L5378) | ✅ |
| `checkpoint_saved` | Save Checkpoint | [app.js:5534](../src/app.js#L5534) | ✅ |
| `critique_rationale_added` / `_updated` | rationale modal save | [app.js:8154](../src/app.js#L8154) | ✅ |
| `critique_rationale_removed` | rationale modal delete | [app.js:2750](../src/app.js#L2750) | ✅ |

**Total: 25 distinct event kinds emitted** — all now documented in [telemetry.md](telemetry.md).

---

## 4. What is deliberately NOT recorded

Per [telemetry.md](telemetry.md), perception/attention signals are left to think-aloud +
screen recording, and non-existent affordances emit nothing:
- Hover / highlight, scroll, dwell, gaze (C22, C27).
- "Reading" a rationale/evidence block — only the *act of opening* the panel is logged (C20, C21).
- Cancel in-flight request, follow-up sub-types, undo/redo, reverse a decision, refine-before-apply — features that don't exist (B12, B14, D33/34/36/37).
- Per-keystroke context edits, per-checkbox dimension toggles, context panel open/close (always-on).

Confirmed **not** telemetry (they look like events but never reach the recording path):
- `kind: "initial"` — a dashboard **version/checkpoint label** ([app.js:416](../src/app.js#L416), 7448, 9383).
- `kind: "retired"` — a `critiqueRefreshNotice` UI banner ([app.js:6821](../src/app.js#L6821), 7086).

---

## 5. Where the data lands

- **In-app:** localStorage key `vizierStudySession` (survives refresh); uncapped in-memory log.
- **On save / session end:** bundle (events + before/after dashboard snapshots, screenshots stripped)
  uploaded via the same-origin backend → **S3** when `STUDY_S3_BUCKET` + `AWS_REGION` + creds are set,
  otherwise written to local `data/` ([re_api/src/study-store.ts](../re_api/src/study-store.ts)).
  Layout: one folder per participant, `studies/{participant}/{session}_{filename}` — session log, `checkpoint-NN.{json,png}`, `final.{json,png}`, and the post scale.
- **Backup:** local JSON + an uncompressed ZIP of dashboard files downloaded on End.

Derivable without extra instrumentation: displayed-vs-inspected, time-on-critique
(`critique_opened`→`critique_closed` via `tRelMs`), iteration (`hadPriorCritiques`), apply-failure rate.

---

## 6. Discrepancies found — both now resolved

1. **`critique_regenerated` was emitted but undocumented → documented.** The kind is a
   genuine, distinct signal ([app.js:7062](../src/app.js#L7062) `outcome:"updated"`,
   [7090](../src/app.js#L7090) `outcome:"retired"`) recording the *result* of the
   stale-dashboard recovery, separate from the `critique_requested` that starts it. Added a
   catalog row, a B13 triage note, and a hooks-section entry in [telemetry.md](telemetry.md).
2. **`condition` was still recorded → removed.** The last commit (*"Drop study
   condition/facilitator fields"*) had left three vestigial references in
   [src/study-session.js](../src/study-session.js) (`session_started` data + the bundle);
   no caller passed it and no test/doc referenced it. Removed all three;
   `facilitator` was already gone everywhere. `session_started` now carries no extra data,
   matching the doc.

*Both fixes verified by re-running the full test suite (see §1 — still 151/151 and 289/289).*
