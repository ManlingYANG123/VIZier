# VIZier v2 — spatial workspace redesign

> **Current execution contract:** the selected or imported dashboard JSON is
> the source of truth. The frontend sends that exact spec map to `re_api` for
> critique and apply, and only commits the engine-returned spec map, board
> metadata, and recommendation delta. PNG files are reference previews for the
> bundled examples; an arbitrary image is not treated as executable JSON.

### Shared dashboard library

Place dashboard JSON files in `public/dashboards/v2/`. The API scans that
directory on every `GET /api/dashboards` request, and
`GET /api/dashboards/:id` returns the selected validated JSON. No filename
manifest or critique content is hard-coded. The first-run screen and workspace
top bar both expose the library; use the refresh button (or refocus the app) to
pick up newly added local files without rebuilding the frontend. In a deployed
Heroku slug, `public/` is read-only, so new shared files appear after the next
deployment.

This is the **v2 UI design** iteration, forked from
`prototype/v1/vega-interaction` (which keeps all the Vega-Lite critique +
interaction-simulation machinery). v2 changes the *interaction paradigm*, not the
renderer:

> **Keep a scaffolded first upload, then replace the implicit step-by-step flow
> with a persistent spatial workspace. Recommendations remain attached to the
> artifact, context can be injected globally or per unit, and every accepted
> change triggers a visible recommendation re-evaluation.**

What v2 adds on top of v1:
- **Proactive context inference.** JSON/spec uploads immediately request an
  inferred Goal and Audience, preserve their inferred/confirmed status, and
  expose the editable brief in the Context panel. Image-only uploads remain
  artifact-only until a vision evidence path exists.
- **One non-linear workspace.** Context remains an explicit stage entry in the
  left rail, while Diagnose/Review/Revise happen directly in the workspace.
  Recommendation controls live with the list and canvas controls live on the
  canvas.
- **Per-unit context injection.** Each feedback unit has an *Add context* action
  that opens a structured pop-up (no chat box); the note produces a **revised
  version of that unit**, kept in the unit's own history.
- **Scoped design-tool controls.** Search and filters sit with recommendations;
  minimap and annotation sit on the canvas; criterion coverage sits beside AI Assist.
  Hover reveals a label, click opens a transient component, and Pin keeps one
  component open in its own workspace scope.
- **Lint-style recommendations.** Findings use compact diagnostic rows with
  severity marks, thin separators, relationship codes, and click-to-locate
  behavior instead of large stacked cards.
- **Living recommendations.** Recommendations declare semantic reads/writes,
  dependencies, conflicts, and invalidations. Applying a fix can keep, update,
  supersede, or introduce other recommendations.
- **Author-defined checkpoints.** Accepted changes accumulate in a Working
  Draft. The author saves a checkpoint only when that draft represents a
  meaningful moment, then selects timeline nodes directly for visual
  Before/After comparison.
- **Confirmable context memory.** A dashboard-scoped agent observes semantic
  author actions—such as context saves, local review requests, and
  accept/reject decisions—and may propose evidence-backed context. The author
  can edit, confirm, or dismiss each proposal; inferred context is never applied
  silently.

### Primary author flow

1. The author reviews a grounded critique and compares the current and proposed
   states.
2. Accepting a change updates the Working Draft and re-evaluates the complete
   dashboard without creating a checkpoint.
3. When the draft reaches a meaningful moment, the author saves it as a
   checkpoint and can compare it with another node on the checkpoint timeline.
4. Repeated decisions accumulate in a semantic interaction journal. When a
   stable dashboard-specific preference appears, the Context panel presents it
   as a confirmable suggestion with its supporting decisions.
5. Saved checkpoints are inspect-only; selecting them does not change the
   active Working Draft.

Context inference and critique generation use the `re_api` backend. Full,
focused, and selected-region reviews share one criteria-aware LLM path. The
model returns criterion outcomes before critique candidates; code validates
criterion linkage, evidence references, context applicability, judgment basis,
and proposal capability before anything reaches the UI.
The UI fails visibly instead of silently substituting mock or template critiques.

### Judgment-basis authorization paths

Each criterion now exposes one or more versioned authorization paths. A path
declares the judgment bases, context, evidence sources, severity ceiling, and
proposal strategies that authorize a specific strength of claim. Missing
context blocks only the paths that depend on it: for example, layout can still
receive a narrow artifact/principle review without audience context, while an
audience-scanning claim remains blocked.

AI-generated critiques must identify (or be unambiguously matched to) one
eligible path and cite at least one supported judgment basis. Critiques without
a supported basis are rejected by the backend and therefore are not rendered.
The optional provenance fields preserve compatibility with existing clients.

Selected-region requests are treated as explicit author questions: returned
critiques must answer the request directly before explaining the issue and
suggesting a change. Guidance-only recommendations can be accepted as design
direction without pretending that the dashboard was modified; automatic Apply
remains available only for executable proposals.

Run the deterministic system-side fixture seam with:

```bash
cd prototype/v2/re_api
npm run evaluate:authorization-paths
```

---

## 1. Run

```bash
cd prototype/v2
npm install        # first time only
npm run dev        # starts UI on :8082 and API on :8091
```

Use `npm run dev:ui` or `npm run dev:api` only when you intentionally want one
side by itself.

Suggested tour: upload a dashboard → complete the split-screen context scaffold
→ **✦ AI Assist** → inspect `Related`, `Conflict`, `New`, and `Updated` badges →
open a critique → compare **Original / Proposed** → **Accept Change** → inspect
the recommendation delta and single version-history entry.

The two interaction critiques to look at:
- **"Charts don't respond to department selection"** (cross-filter)
- **"Task Velocity gives no detail on hover"** (hover-tooltip)

> **Dev-server caching note.** Vite's watcher sometimes serves a stale
> `src/app.js`. If an edit doesn't show after a hard refresh:
> `rm -rf node_modules/.vite && npx vite --port 8082 --strictPort --force`.

---

## Living recommendation loop and backend seam

The deterministic frontend engine lives in
`src/recommendation-engine.js`. It provides:

- `enrichRecommendations(...)` — adds reads/writes, dependencies, conflicts,
  invalidations, lifecycle, and version provenance.
- `buildApplicationPlan(...)` — includes prerequisites, topologically orders
  changes, and blocks unresolved conflicts.
- `applyPlan(...)` — applies operations to a clone so failed plans cannot
  partially mutate the dashboard.
- `reevaluateMock(...)` — produces `kept`, `updated`, `removed`, and `added`
  recommendation deltas for affected targets.

### Archived pre-`re_api` request sketch

```js
{
  version,
  context,
  selectedRecommendationIds,
  conflictChoices,
  bundle,   // grounded twbx2vegalite bundle
  specMap   // addressable tile specs
}
```

### Archived pre-`re_api` response sketch

```js
{
  dashboardState,
  applicationOrder,
  changedTargets,
  recommendationDelta: { kept, updated, removed, added },
  evaluationReport,
  rollback: { rolledBack, reason }
}
```

This historical sketch proposed mapping the backend to the existing
`pipeline.reconstruct` loop:

1. Snapshot all affected tile specs.
2. Apply structured operations or call `refine_tile(...)` per target.
3. Re-render and evaluate the complete dashboard.
4. Roll back if the candidate score regresses or guardrails fail.
5. Return updated specs and a recommendation delta.

The current backend issue shape (`per_tile[].issues[]`) contains `kind`,
`detail`, and `suggestion`. Going real requires promoting those free-text issues
into structured operations with explicit reads/writes and conflict semantics.

---

## 2. Why interaction critiques are different

A color or title problem is **visible in a still frame** — you can show a
before/after image. An interaction problem is **invisible when nothing is
happening**: a bar chart that *looks* clickable but filters nothing looks
identical to one that does. So the critique has to solve two problems a static
critique never faces:

1. **Detection** — how do you even know the interaction is missing? There's no
   pixel to point at. The signal lives in the **spec structure** (fields shared
   across views but no selection param; a line mark with no `tooltip`).
2. **Surfacing** — how do you make the user *understand* a behavior that isn't
   there? A sentence ("add cross-filtering") is weak. You have to **show the
   behavior happening**, and contrast it with its absence.

This fork answers both with a two-part inspector for `surface: "interaction"`:

```
┌─ diagnosis ──────────────────────────────────────────────┐
│ • Shared dimension: 3 views encode `department`…         │  ← how it was detected
│ • No selection link: the bar chart defines no `param`…   │     (from spec structure)
│ • Consequence: a reader can't isolate one team…          │
│ This gap leaves no visual trace in a static view.        │
├─ demo ───────────────────────────────────────────────────┤
│ [ ▶ Play interaction on the dashboard ]                  │  ← show, don't tell
└──────────────────────────────────────────────────────────┘
```

---

## 3. The two interaction critiques (exemplars of two modalities)

They're detected from the uploaded specs by `re_api/src/detect/` and phrased by
the LLM. Both use `surface: "interaction"` and are distinguished by
`interactionKind`.

| | `c5` cross-filter | `c6` hover-tooltip |
| --- | --- | --- |
| `interactionKind` | `"cross-filter"` | `"hover-tooltip"` |
| Modality | **click** a bar → other views filter | **hover** the line → values appear |
| Missing thing | no selection param linking views | no `tooltip` encoding, no points |
| Accept applies | `state.crossFilterEnabled = true` | adds `mark.point` + `encoding.tooltip` to the velocity spec |
| Demo | cursor tours the department bars, clicking each | cursor hovers each month along the line |

Having two modalities matters: it shows the pattern generalizes (click-driven
coordination vs. hover-driven detail), not a one-off.

### What makes the cross-filter *real* (not cosmetic)
The dataset is **department-keyed** (`velocityByDept`, `statusByDept`), so a
selection produces a genuine data slice:
- `onDepartmentClick()` toggles `state.crossFilterDept`.
- `specForTile()` layers cross-filter state on the base spec at render time (so a
  palette v2 still applies while filtering is on).
- `withDeptData()` swaps the target tiles' `data` to per-department values **and
  pins the velocity y-axis** to the all-teams max — without pinning, Vega
  auto-rescales each team's (smaller) line back to full height and the filter
  looks like it did nothing. That pin is the difference between "looks broken" and
  "obviously filtered."

---

## 4. The interaction simulation (the demo module)

The whole point of "show, don't tell." Lives under the
`Interaction demo` header in `src/app.js`. It runs **on the real canvas**, over
the **real Vega tiles**, and is a **non-destructive preview**: the pre-demo
cross-filter state is captured and restored on exit, so **Accept** is still what
makes a fix permanent.

### Anatomy
- **`playInteractionDemo(critique)`** — entry point. Freezes the surrounding
  panels (`.app-shell.demo-playing`), injects the toolbar (Before/After toggle +
  Exit), a caption banner, and the cursor. Branches on `demoKind` into one of two
  loops.
- **`demoTourLoop()`** (cross-filter) — a continuous loop: for each team it
  **(1) travels** the cursor to the bar, **(2) aims** with a settling ring,
  **(3) clicks** (bounce + burst + bar flash), then **(4) holds** so you can
  observe. The click's effect depends on the *live* phase.
- **`demoTooltipLoop()`** (hover) — same 4-beat rhythm, but the cursor moves
  month-by-month along the line and shows a synthetic tooltip in the "after"
  phase.
- **`setDemoPhase(phase)`** — the Before/After toggle. Flips the phase **live**;
  the loop keeps running, so you can switch mid-tour and watch the same gesture
  produce a different result.
- **`exitInteractionDemo()`** — cancels the loop (via `demoLoopId`), removes all
  demo DOM, and restores the captured pre-demo state.

### Two implementation details worth knowing
- **Accurate targeting.** The cursor lands on real geometry, read from the live
  SVG, not guessed. `deptBarPoint()`/`deptBarRect()` read the `.mark-rect`
  bars; `velocityLineVertices()` parses the line `path`'s `d` attribute and maps
  each vertex through `getScreenCTM()` so the hover dot/tooltip sit exactly on
  each month's point — and it stays correct under pan/zoom.
- **No render races.** The tour loop *and* the toggle both trigger `renderTiles()`.
  `queuedRenderTiles()` chains them through a single promise so two renders never
  interleave into the same DOM.

### It is scripted, on purpose
This demo **drives `state` directly** — it does not yet ask a real engine "what
happens if I click Eng?" It's a faithful *communication* of the behavior, which
is all the mock needs. §5 (Seam C) is how it becomes a genuinely driven
simulation.

---

## 5. Going real: LLM-driven diagnosis & agent-driven simulation

The interaction pieces slot into three seams. The render/demo layer doesn't
change.

### Seam A — Ground the **detection**
The production review sends the complete Vega-Lite specs, dashboard metadata,
and review context to the LLM for open-ended issue discovery. The model chooses
the finding count, dimensions, priorities, and recommendations; returned tile
references and proposal shapes are validated before reaching the UI.

Deterministic checks remain as a network-free regression harness and for
post-apply verification; they no longer seed the production critique list.

### Seam B — Keep "propose vs. compute" for the **result**
The model proposes an operation (`proposal.kind: "add-cross-filter"`); the
**engine computes the actual post-interaction data** (`withDeptData()` produces
the real per-department numbers). Never let the model fabricate "clicking Eng
shows 12 tasks" — that's the paper's core trust claim.

### Seam C — Make the simulation genuinely **driven** (not scripted)
Replace the scripted steps in the loops with a driver that operates the *live*
view and reads results back:

- **Vega (in-app):** drive the real Vega `View` API — `view.signal(param, value)`
  then `view.runAsync()` to apply a selection, and read the resulting
  scenegraph/data to *prove* the change. Each live view is already kept in
  `state.views[tileId]`.
- **Embedded Tableau (Nicole's stack):** Tableau Embedding API v3 —
  `selectMarksByValueAsync()` / `applyFilterAsync()` to **drive**, and
  `addEventListener("markselectionchanged", …)` to **observe**. Same critique
  flow, wrapped around the 11M-dashboard public corpus.
- **AppMCP / tool-driven agent:** expose the dashboard's interactions as semantic
  tools; an agent *calls* them (safer than raw DOM clicks). Agent decides *what*
  to try, engine computes the *result*, the demo *replays* the captured
  before/after.

In all three the invariant holds: **agent drives → engine computes → UI shows a
before/after pair.**

### Seam D — Real critique generation & dashboards
- `runAIAssist()` sends `state.context` + the tile specs to `re_api`; real
  model-authored critique copy is required and failures are shown explicitly.
- `generateLocalCritiques()` adds a provider-neutral selected-region request.
  The engine receives canvas bounds and author intent, then exposes only
  intersecting tile specs to the active `LLMClient`.
- Swap `tileDefinitions` for specs parsed from an uploaded dashboard / corpus;
  everything keys off tile `id`s.

---

## 6. The interaction critique schema (contract to reproduce)

```js
{
  id: "c5",
  tileId: "task-velocity" | null,           // addressable tile (null = whole board)
  dimension: "interaction",                  // → orange chip + grouping
  priority: "high"|"medium"|…,
  status: "pending"|"resolved",
  source: "ai"|"manual",
  title, issue,                              // panel headline + problem
  rationale, evidence,                       // collapsed "Why this matters"
  suggestion,                                // fix text
  target: { granularity, ref },             // SEMANTIC (e.g. cross-view-interaction:
                                            //   { source, targets }), not pixels
  proposal: { kind: "add-cross-filter"|"add-tooltip" },  // what Accept applies
  surface: "interaction",                    // → diagnosis + demo inspector
  interactionKind: "cross-filter"|"hover-tooltip",       // which demo/diagnosis
  bounds: { x, y, w, h },                     // for drawing the box only
}
```

---

## 7. Known limitations (it's a spike)

- Diagnosis text is **authored**, not generated (Seam A).
- The demo is **scripted**, not a driven simulation (Seam C).
- All "AI" is mocked; single hard-coded dataset; no upload parsing; no
  persistence (refresh resets).
- Fixed dev port + occasional Vite stale-serve (see §1).

---

## 8. Where this sits

- `prototype/v1/` — static / iframe UI baseline (port 3000).
- `prototype/v1/vega/` — full v1 pipeline on Vega-Lite.
- `prototype/v1/vega-interaction/` — **this folder**: the interaction critique +
  simulation spike.

Renderer names (`vega`, `tableau`, …) are *technical* experiments within UI
version 1; `prototype/v2`, `v3` are reserved for future *UI design* versions.

npm run dev

npm run deploy-heroku