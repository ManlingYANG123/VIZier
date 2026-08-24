import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Vite entry does not contain an unevaluated server-side cache token", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.doesNotMatch(html, /<\?=/);
  assert.match(html, /<script type="module" src="\/src\/bootstrap\.js"><\/script>/);
});

test("frontend sends review scope instead of context-dependent generation modes", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /reviewScope: "full"/);
  assert.match(source, /criterionEvaluations/);
  assert.doesNotMatch(source, /mode: "synthesis"/);
  assert.doesNotMatch(source, /mode: "rubric"/);
  assert.doesNotMatch(source, />Generate Context</);
});

test("context inference is a visible, confirm-before-review workflow", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /CONTEXT_WORKFLOW_STATUS\.GENERATING/);
  assert.match(source, /Confirm Context First/);
  assert.match(source, /contextReadyForReview\(\)/);
  assert.match(source, /Review and confirm context in the left panel/);
  assert.match(source, /setContextWorkflow\(CONTEXT_WORKFLOW_STATUS\.CONFIRMED\)/);
  // The confirm control gates review from a persistent footer pinned to the
  // bottom of the context panel (it survives the status header's re-renders).
  assert.match(source, /id="contextConfirmFooter"/);
  assert.match(source, /id="saveContextBtn"/);
  assert.match(source, /id="contextConfirmLabel"/);
  assert.match(source, /context-extract-steps/);
  assert.doesNotMatch(source, /context-workflow-spinner/);
  assert.doesNotMatch(source, />Use Standard Rubric</);
});

test("context extraction shows a breathing icon and rotating text hints instead of a static spinner", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /CONTEXT_EXTRACTION_HINTS/);
  assert.match(source, /startContextExtractionHints/);
  assert.match(source, /id="contextExtractHint"/);
  assert.match(source, /class="context-extract-dots"/);
  assert.match(css, /context-icon-breathe/);
  assert.match(css, /context-extract-dot-pulse/);
});

test("a Gemini-style running-light ring marks the context box, design-doc uploader, region box, and focused review while generating", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // The animated ring is driven by an @property angle spun by a keyframe.
  assert.match(css, /@property --viz-edge-angle/);
  assert.match(css, /@keyframes viz-edge-spin/);
  // It attaches to all generating surfaces via a masked ::before ring.
  assert.match(css, /\.context-box-field\.is-generating::before/);
  assert.match(css, /\.doc-uploader\[data-state="loading"\]::before/);
  assert.match(css, /\.draft-marker\.is-generating::before/);
  assert.match(css, /\.focused-review-input-wrap\.is-generating::before/);
  // The context field lights up on manual regenerate and on auto-inference.
  assert.match(source, /function setContextInferring\(/);
  assert.match(source, /\.context-box-field/);
  // The region selection box keeps its ring toggled by the submit lifecycle.
  assert.match(source, /\.draft-marker"\)\?\.classList\.toggle\("is-generating"/);
  assert.match(source, /function setFocusedReviewGenerating\(/);
});

test("a focused review send lights the input, then clears it and opens the generated critique", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /state\.focusedReviewRunning = true/);
  assert.match(source, /setFocusedReviewGenerating\(true\)/);
  assert.match(source, /succeeded = await runAIAssist\(\{ focusedRequest: request \}\)/);
  assert.match(source, /focusedInput\.value = ""/);
  assert.match(source, /state\.reviewRequest = ""/);
  // After a focused ask, open the answering critique in the right-hand inspector.
  assert.match(source, /const opened = \(kept && \["pending", "updated"\]\.includes\(kept\.status\) \? kept : null\)/);
  assert.match(source, /state\.selectedCritiqueId = opened\?\.id \|\| null/);
  assert.match(source, /await renderInspector\(\)/);
});

test("regenerating the context overwrites the box with one description (no field-split merge)", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // The description is one paragraph combining goal + audience.
  assert.match(source, /function inferredContextDescription\(/);
  // Regenerate overwrites the whole box rather than filling only-empty fields.
  assert.match(source, /box\.value = description;/);
  // The old only-fill-empty merge is gone.
  assert.doesNotMatch(source, /const merged = \{\};[\s\S]*?filledField/);
});

test("workspace entry points collapse context into one description so a confirmed context never dead-ends", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // The context box only round-trips `goal`, so any path that confirms context
  // must store a single description there (audience/constraints empty) — else the
  // first focused review re-parses the box, changes the fingerprint, and the
  // panel locks up (confirmed yet not review-ready).
  const enterWorkspace = source.match(/function enterWorkspace\(\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(enterWorkspace, /serializeContextBox\(/);
  assert.match(enterWorkspace, /state\.context\.audience = "";/);
  assert.match(enterWorkspace, /state\.context\.constraints = "";/);
  // Accepting a preference-agent context suggestion collapses the same way.
  assert.match(
    source,
    /mergeSuggestionIntoContext[\s\S]*?state\.context\.goal = serializeContextBox\(state\.context\);/,
  );
});

test("all standard feedback scopes are selected by default", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /const DEFAULT_FEEDBACK_SCOPE = \[\.\.\.CATEGORY_ORDER\]/);
  assert.match(source, /value="chart" checked/);
  assert.match(source, /value="design process" checked/);
  assert.doesNotMatch(source, /scope: \["visual", "narrative", "interaction", "data"\]/);
});

test("shared dashboard library loads dynamic JSON through the canonical upload flow", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/api-client.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../re_api/src/server.ts", import.meta.url), "utf8");

  assert.match(source, /getElementById\("dashboardLibrarySelect"\)/);
  assert.match(source, /getElementById\("onboardingDashboardLibrarySelect"\)/);
  assert.match(source, /listDashboardLibrary/);
  assert.match(source, /loadDashboardFromLibrary/);
  assert.match(source, /await loadJsonDashboard\(dashboard, `\$\{id\}\.json`\)/);
  assert.match(source, /window\.addEventListener\("focus"/);
  assert.match(source, /The current critiques, context, design document, and Working Draft will be cleared/);
  assert.match(source, /class="upload-col-status" id="onboardingDashboardLibraryStatus"/);
  assert.doesNotMatch(source, /state\.artifact\.source = "shared-dashboard-library"/);
  assert.doesNotMatch(source, /\["workspace-performance", "ocean-life", "workspace-overview"\]/);
  assert.match(client, /\/api\/dashboards/);
  assert.match(client, /Restart the local API server/);
  assert.match(server, /listDashboardFiles/);
  assert.match(server, /loadDashboardFile/);
});

test("the default dev command starts both the UI and API", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const devScript = await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8");

  assert.equal(packageJson.scripts.dev, "node scripts/dev.mjs");
  assert.match(devScript, /re_api\/src\/server\.ts/);
  assert.match(devScript, /node_modules\/vite\/bin\/vite\.js/);
});

test("learned context remains visible while updating and shows saved destinations", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /mergePendingContextSuggestions/);
  assert.match(source, /contextSavedList/);
  assert.match(source, /Saved to \$\{escapeHTML\(contextFieldLabel/);
  assert.match(source, /isStrongInteractionEvent\(event\)/);
});

test("first-run onboarding has no demo-dashboard escape hatch", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Use Demo Dashboard|skipUploadBtn|skipDemo|demoBoardPreview|obShowSplit/);
  assert.doesNotMatch(styles, /upload-skip-btn|demo-board-preview|demo-kpi-strip|demo-chart-grid/);
});

test("study onboarding binds each assigned dashboard to its protocol PDF", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /Choose a material/);
  assert.match(source, /const STUDY_MATERIALS = \[/);
  assert.match(source, /code: "A",\s+dashboardId: "garden-birds-new",[\s\S]*?docId: "study-a"/);
  assert.match(source, /code: "B",\s+dashboardId: "sales-command-center-new",[\s\S]*?docId: "study-b"/);
  assert.match(source, /code: "1",\s+dashboardId: "air-quality-new",[\s\S]*?docId: ""/);
  assert.match(source, /code: "2",\s+dashboardId: "ocean-life",[\s\S]*?docId: ""/);
  assert.match(source, /\/study-materials\/pdfs\/A_bbc-gel-infographics\.pdf/);
  assert.match(source, /\/study-materials\/pdfs\/B_tableau-dashboard-best-practices\.pdf/);
  assert.doesNotMatch(source, /id="onboardingGuidelineCards"/);
  assert.match(source, /startBtn\.disabled = !material \|\| dashboardLibraryBusy;/);
  assert.match(source, /`Open Material \$\{material\.code\}`/);
  assert.doesNotMatch(source, /startBtn\.disabled = [^;]*designDocLibraryBusy/);
  assert.match(source, /Select the assigned code\./);
  assert.doesNotMatch(source, /Dashboard and PDF settings are applied together/);
  assert.match(source, /Task materials/);
  assert.match(source, /Assessment materials/);
  assert.match(source, /id="onboardingSelectionSummary"/);
  assert.match(styles, /\.upload-card-code/);
  assert.match(styles, /\.upload-picker--bundles/);
});

test("group study routes boot the neutral runner before VIZier", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const bootstrap = await readFile(new URL("../src/bootstrap.js", import.meta.url), "utf8");
  const runner = await readFile(new URL("../src/study-runner.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(html, /src="\/src\/bootstrap\.js"/);
  assert.match(bootstrap, /studyGroupIdFromPath/);
  assert.match(bootstrap, /bootStudyRunner/);
  assert.match(runner, /Review the dashboard/);
  assert.match(runner, /Add area note/);
  assert.match(runner, /Continue to questions/);
  assert.match(runner, /id="studyZoomOut"/);
  assert.match(runner, /id="studyZoomIn"/);
  assert.match(runner, /id="studyZoomFit"/);
  assert.match(runner, /assessment_canvas_zoomed/);
  assert.match(runner, /assessment_canvas_panned/);
  assert.match(runner, /study_phase_intro_viewed/);
  assert.match(runner, /study_phase_intro_completed/);
  assert.match(runner, /renderPhaseIntro/);
  assert.match(runner, /study-phase-axis/);
  assert.match(runner, /aria-current="step"/);
  assert.match(runner, /Select one response for every statement/);
  assert.match(runner, /scale_response_recorded/);
  assert.match(runner, /scaleResponses: serializeScaleResponses/);
  assert.doesNotMatch(runner, /<textarea name="q/);
  assert.match(runner, /openStudyMaterialForRunner/);
  assert.match(runner, /studyPhaseUsesVizier\(runnerState\.phase\)/);
  assert.match(runner, /isDashboardTaskPhase\(runnerState\.phase\)/);
  assert.match(styles, /\.study-assessment-layout/);
  assert.match(styles, /\.study-dashboard-wrap\s*\{[^}]*display:\s*flex/);
  assert.match(styles, /\.study-dashboard-world/);
  assert.match(styles, /\.study-dashboard-zoom-controls/);
  assert.match(styles, /\.study-dashboard-stage\.is-panning/);
  assert.match(styles, /\.study-phase-intro/);
  assert.match(styles, /\.study-phase-axis/);
  assert.match(styles, /\.study-runner-shell\.is-questionnaire[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /\.study-scale-question legend\s*\{[^}]*float:\s*left/);
  assert.doesNotMatch(styles, /\.study-scale-question legend\s*\{[^}]*max-width:\s*70ch/);
  assert.doesNotMatch(styles, /\.study-questionnaire-page form > footer\s*\{[^}]*position:\s*sticky/);
  assert.match(styles, /\.study-workspace-progress/);
});

test("Heroku runtime packaging includes maintainable backend data sources", async () => {
  const deploy = await readFile(new URL("../scripts/deploy-heroku.sh", import.meta.url), "utf8");

  assert.match(deploy, /RUNTIME_PATHS=\([\s\S]*?"re_api\/data"/);
  assert.match(deploy, /RUNTIME_PATHS=\([\s\S]*?"slack_codebook"/);
});

test("focused critique details render before preview hydration", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /Preparing canvas comparison/);
  assert.match(source, /const canApplyIndividually = descriptor\.executable/);
  assert.match(source, /const canAcceptGuidance = actionable/);
  assert.match(source, /const canAcceptIndividually = canApplyIndividually \|\| canAcceptGuidance/);
  assert.match(source, /canAcceptIndividually \? "" : "disabled"/);
  assert.match(source, /const common = \{\s*livePreview,\s*previewFailure,\s*checkpoint,\s*executable,/);
  assert.doesNotMatch(source, /\$\{executable \? "" : "disabled"\}/);
  assert.match(source, /const fallbackResult = actionable && !usableLivePreview/);
  assert.match(source, /function fallbackCanvasTarget\(critique\)/);
  assert.match(source, /"narrative\.dashboard-purpose"\) return "dashboard\.title"/);
  assert.match(source, /const afterLabel = executable \? "Proposed" : "Affected area"/);
  // The detail card is trimmed for lower visual density: the decision-summary
  // headers are visually hidden (kept for screen readers, not shown), and the
  // "Compare on the Canvas" block drops its icon and the redundant descriptive
  // sentence, keeping just the heading and the inline toggle slot.
  assert.match(source, /<h3 class="visually-hidden">What Needs Attention<\/h3>/);
  assert.match(source, /<h3 class="visually-hidden">Recommended Change<\/h3>/);
  assert.match(source, /id="focusCompareSlot"/);
  assert.doesNotMatch(source, /switch above the canvas/);
  assert.doesNotMatch(source, /Switch between the current dashboard and/);
  assert.doesNotMatch(source, /focus-canvas-evidence-icon/);
  // Guard the post-await staleness check: if the author navigates away (Back/Escape)
  // or switches critiques while the engine preview is in flight, the stale
  // continuation must bail before it re-sets state.canvasPreview and strands the
  // relocated toggle visible on the canvas.
  assert.match(
    source,
    /const descriptor = await focusPreviewDescriptor\(critique\);[\s\S]*?if \(state\.selectedCritiqueId !== critique\.id\) return;/,
  );
});

test("guidance-only recommendations are marked as considered, not applied", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // Guidance carries a tracked decision under an honest label — nothing is
  // applied to the canvas, so the action reads "Mark as Considered", not "Accept".
  assert.match(source, /canAcceptGuidance \? "Mark as Considered" : "Accept Change"/);
  assert.match(source, /class="focus-action \$\{canAcceptGuidance \? "consider" : "accept"\}"/);
  assert.match(source, /critique\.status = "accepted"/);
  assert.match(source, /critique\.lifecycle = "guidance-accepted"/);
  assert.match(source, /guidanceOnly: true/);
  assert.match(source, /summary: `Marked guidance as considered:/);
  assert.match(source, /Marked as considered/);
  assert.match(source, /Guidance-only recommendations must be implemented manually/);
  assert.match(source, /"Review Area"/);
  assert.match(source, /"Focused Question"/);
  const guidanceHandler = source.match(
    /if \(!canAcceptGuidance\) return;[\s\S]*?document\.getElementById\("guidanceAcceptedNotice"\)\?\.focus\(\);/,
  )?.[0] || "";
  assert.match(guidanceHandler, /critique\.status = "accepted"/);
  assert.doesNotMatch(guidanceHandler, /applyRecommendationSelection|streamApply/);
});

test("the detail card drops the inline before/after and lists concrete grounded evidence", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // The redundant inline before/after comparison is gone — panel, hydration call,
  // renderer, and its helpers no longer exist.
  assert.doesNotMatch(source, /id="focusComparison"/);
  assert.doesNotMatch(source, /renderFocusComparison/);
  assert.doesNotMatch(source, /focusPreviewRenderers/);
  assert.doesNotMatch(source, /class="focus-comparison/);
  assert.doesNotMatch(styles, /\.focus-comparison\b/);

  // Evidence is made concrete by surfacing the validated evidenceRefs beneath the
  // general sentence — de-duplicated and capped, rendering nothing when absent.
  assert.match(source, /function focusEvidenceRefsMarkup\(critique\)/);
  assert.match(source, /Array\.isArray\(critique\.evidenceRefs\)/);
  assert.match(source, /class="focus-evidence-refs"/);
  assert.match(source, /if \(!items\.length\) return "";/);
  assert.match(styles, /\.focus-evidence-refs/);

  // Descriptor routing and its genuine-change guard are unchanged (still used to
  // configure the canvas preview), even though the inline panel is gone.
  assert.match(source, /interactionKinds\.includes\(kind\) \? "interaction"/);
  assert.match(source, /function specsMatch\(a, b\)/);
});

test("a general edit-spec fix routes to the spec-diff preview and is applyable", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const engine = await readFile(new URL("../src/recommendation-engine.js", import.meta.url), "utf8");

  // An edit-spec proposal's honest before/after IS the tile-spec diff, so it must
  // route to the "encoding" (spec-diff) renderer regardless of the branch it was
  // grouped under — never a static structural/region no-op.
  assert.match(source, /kind === "edit-spec" && tile\) \? "encoding"/);
  // It has a real change summary rather than falling through to a generic label,
  // and that summary is tile-count aware (consolidated multi-tile critiques read
  // "Chart specification on N charts") while single-tile keeps the tile label /
  // "Chart specification" fallback.
  assert.match(source, /"edit-spec": critiqueTileCount\(critique\) > 1[\s\S]*?"Chart specification"/);
  // The planner knows the primitive so it can be selected and applied.
  assert.match(engine, /"edit-spec":\s*\{/);
  assert.match(engine, /writes: \["tile\.spec"\]/);
});

test("preliminary critiques are visibly labeled and cannot be auto-applied", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /critique\.supportStatus === "tentative"/);
  assert.match(source, />Tentative<\/span>/);
  assert.match(styles, /focus-source-chip\.tentative/);
});

test("interaction simulation observes each runtime phase manually via the canvas toggle", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // The runtime no longer ships its own Original/Proposed switch: the shared
  // Original/Proposed toggle (reparented into the detail card for a focused
  // critique) drives phase switching during a test.
  assert.doesNotMatch(source, /id="demoToggle"/);
  assert.doesNotMatch(source, /demo-toggle-opt/);
  // Phase switching is manual, not an auto-flipping timer loop.
  assert.doesNotMatch(source, /transitionInteractionRuntimePhase\(phase === "before" \? "after" : "before"\)/);
  assert.doesNotMatch(source, /interactionRuntimeLoop|demoLoopId/);
  // A single observation runs per phase, driven by the canvas toggle.
  assert.match(source, /async function observeInteractionPhase\(\)/);
  assert.match(source, /async function switchInteractionRuntimePhase\(phase\)/);
  assert.match(source, /if \(state\.demoPlaying\) \{\s*switchInteractionRuntimePhase\(nextPhase\);/);
  assert.match(source, /runRuntimeObservation\(runtimeScenario, phase\)/);
  assert.match(source, /dispatchEvent\(new MouseEvent/);
  assert.match(source, /runtimeObservationInFlight/);
  assert.doesNotMatch(source, /runtimeObservedTooltip|surfaceRuntimeTooltip/);
});

test("applying an interaction fix leaves its demonstrated state visible", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /async function playApplySettleDemo\(appliedCritiques\)/);
  assert.match(source, /settleDemoPlaying: false/);
  // The demo runs only for the interaction proposals whose commit is otherwise
  // invisible, and it is awaited from the apply path.
  assert.match(source, /const enabledInteraction = committedCritiques\.some\(\(critique\) =>/);
  assert.match(source, /await playApplySettleDemo\(committedCritiques\)/);
  // Apply keeps the representative selection visible so the accepted behavior
  // cannot look like a no-op; on-demand replays still clear it afterward.
  const demo = source.match(/async function playApplySettleDemo[\s\S]*?\n}/)?.[0] || "";
  assert.match(demo, /state\.crossFilterSelection = \{/);
  assert.match(demo, /await sleep\(1500\)/);
  assert.match(demo, /const keepAppliedState = Array\.isArray\(appliedCritiques\)/);
  assert.match(demo, /if \(!keepAppliedState\)/);
  assert.match(demo, /state\.crossFilterSelection = null;/);
  assert.match(demo, /state\.settleDemoPlaying = false;/);
  // Clicks are inert while the demo plays on the source (cross-filter) view.
  // Tile-content clicks no longer select a tile or jump to a critique at all —
  // one location can carry several critiques, so that guess was removed.
  assert.doesNotMatch(source, /state\.selectedCritiqueId = state\.critiques\.find\(\(item\) => item\.tileId === state\.selectedTileId\)/);
  assert.match(source, /if \(!state\.crossFilterEnabled \|\| state\.settleDemoPlaying\) return;/);
  assert.match(source, /class="focus-demo-button" id="focusDemoButton"/);
});

test("an interaction critique is replayable from its focused Run interaction test button", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /id="focusDemoButton"[^>]*>Run interaction test on the canvas</);
  const demoClick = source.match(
    /getElementById\("focusDemoButton"\)\?\.addEventListener\("click", \(\) => \{[\s\S]*?\n  \}\);/,
  )?.[0] || "";
  assert.match(demoClick, /playInteractionRuntime\(critique\)/);
  assert.match(demoClick, /recordStudyAction\("interaction_replayed"/);
});

test("single-critique apply still flows through the focused action, and batch is inline (not the removed modal)", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // The old "Preview All Fixes" batch MODAL stays gone — batch returned as an
  // inline list multi-select, never a modal (see proposals/
  // stale-context-apply-dead-end-recovery.md for the original removal).
  assert.doesNotMatch(source, /Preview All Fixes|previewAllButton|previewAllCount|batchModal/);
  assert.doesNotMatch(source, /openBatchPreview|closeBatchPreview|renderBatchPreview|applyBatchButton/);
  assert.doesNotMatch(styles, /preview-all-button|batch-modal|batch-card|batch-preview-grid/);
  assert.match(source, /const canApplyIndividually = descriptor\.executable\s*&& applicationPlan\.canApply/);
  assert.doesNotMatch(source, /applicationPlan\.order\.length === 1/);
  assert.match(source, /Resolve its recommendation conflicts/);

  // Inline batch: a list-level multi-select whose Apply routes through the same
  // plan-based engine path as single apply, and whose canvas preview shows the
  // COMBINED after-state of the whole selection.
  assert.match(source, /batchSelectToggle/);
  assert.match(source, /id="batchApplyBar"/);
  assert.match(source, /async function refreshBatchPreview\(\)/);
  assert.match(source, /applySelectionResolvingConflicts\(selectedIds\)/);
  assert.match(styles, /\.batch-apply-bar/);
});

test("critiques carry an icon+label badge distinguishing executable fixes from guidance", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // Executability is intrinsic to the proposal (mode/kind), independent of status.
  assert.match(source, /function critiqueIsExecutable\(critique\)/);
  assert.match(source, /critique\.proposal\?\.mode === "executable" && critique\.proposal\?\.kind !== "manual"/);
  // The badge renders Fixable vs Guidance with an icon.
  assert.match(source, /function critiqueFixBadgeMarkup\(critique\)/);
  assert.match(source, /executable \? "Fixable" : "Guidance"/);
  // On the list card the capsule chip names the kind explicitly for both kinds —
  // it leads the critique summary row, replacing the old guidance-only gutter lamp.
  assert.match(source, /const summaryChips = \[\s*critiqueFixBadgeMarkup\(critique\),/);
  // Guidance cards additionally carry a whole-card kind class for a distinct surface.
  assert.match(source, /const guidance = !critiqueIsExecutable\(critique\)/);
  // The badge also appears in the focus detail chip row, for both kinds.
  assert.match(source, /<span class="focus-source-chip">\$\{sourceLabel\}<\/span>\s*\n\s*\$\{critiqueFixBadgeMarkup\(critique\)\}/);
  // Distinct styling per kind, plus the distinct guidance card surface.
  assert.match(styles, /\.fix-kind-badge\.executable/);
  assert.match(styles, /\.fix-kind-badge\.guidance/);
  assert.match(styles, /\.critique-card\.guidance/);
});

test("learned context surfaces the top two suggestions and collapses the rest behind a More expander", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // Re-rank the accumulated list by signal, show two, collapse the remainder.
  assert.match(source, /\.sort\(\(a, b\) =>\s*\n?\s*\(b\.signalStrength \|\| 0\) - \(a\.signalStrength \|\| 0\)\)/);
  assert.match(source, /const visibleSuggestions = ranked\.slice\(0, 2\)/);
  assert.match(source, /const overflowSuggestions = ranked\.slice\(2\)/);
  assert.match(source, /class="context-suggestion-more"/);
  assert.match(source, /<span>More<\/span>/);
  assert.match(styles, /\.context-suggestion-more/);
  // The verbose rationale sub-text and evidence disclosure are gone.
  assert.doesNotMatch(source, /context-suggestion-reason/);
  assert.doesNotMatch(source, /class="context-evidence"/);
  assert.doesNotMatch(styles, /\.context-suggestion-reason/);
  assert.doesNotMatch(styles, /\.context-evidence/);
});

test("Saved Rationale and Learned Context stay hidden until earned, and a shown-but-empty Learned Context is compressed", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // Both sections carry a render-time visibility gate: Saved Rationale appears
  // once a rationale exists; Learned Context waits until the preference agent is
  // actually active (a suggestion, an accepted one, mid-analysis, or
  // unavailable) — never merely because context was inferred or confirmed on a
  // fresh dashboard. Empty sections are not rendered as coaching boxes on a
  // first run.
  assert.match(source, /const showSavedRationale = state\.rationales\.length > 0;/);
  assert.match(source, /const showLearnedContext =\s*\n\s*\(state\.preferenceAgent\.suggestions \|\| \[\]\)\.length > 0/);
  assert.match(source, /state\.preferenceAgent\.status === "analyzing"/);
  // The gate no longer keys off context inference/confirmation.
  assert.doesNotMatch(source, /const contextHasBeenInferred = /);
  assert.match(source, /class="rationale-memory"[^>]*\$\{showSavedRationale \? "" : "hidden"\}/);
  assert.match(source, /class="context-memory"[^>]*\$\{showLearnedContext \? "" : "hidden"\}/);

  // Learned Context can still be shown-but-empty (preference agent analyzing, no
  // suggestions yet); that waiting state stays compressed via :has(), and the
  // rule stops matching once real suggestion cards render.
  assert.match(styles, /\.context-memory:has\(\.context-memory-state\):not\(:has\(\.context-suggestion\)\)/);
});

test("Saved Rationale sends structured critique context to review and preference synthesis", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // Future reviews receive a dedicated rationale payload. Only the user's words
  // enter context.notes; model-authored critique copy stays in metadata.
  assert.match(source, /function savedRationalesForEngine\(\)/);
  assert.match(source, /`Saved design rationale: \$\{rationale\.text\}`/);
  const sendSites = source.match(/savedRationales: savedRationalesForEngine\(\)/g) ?? [];
  assert.equal(sendSites.length, 2);
  assert.doesNotMatch(source, /Confirmed design rationale:/);

  // The semantic interaction journal carries the same snapshot, allowing the
  // preference synthesizer to understand the source and current critique ids.
  assert.match(source, /rationaleId: rationale\.id/);
  assert.match(source, /dashboardVersion: rationale\.dashboardVersion/);
  assert.match(source, /critique: rationale\.critiqueContext/);
  assert.match(source, /sourceCritiqueId:/);
  assert.match(source, /currentCritiqueId: rationale\.critiqueId/);
  assert.match(source, /context: state\.context/);
});

test("a focused question emphasizes the direct verdict while a review area shows a minimap that locates the region", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // Focused Question: lift a Yes/No verdict into an emphasized lead.
  assert.match(source, /function focusedAnswerMarkup\(answer\)/);
  assert.match(source, /focus-answer-lead/);
  assert.match(source, /isFocusedQuestion \? "Direct Answer" : "Answer"/);
  assert.match(styles, /\.focus-answer-lead\.positive/);
  assert.match(styles, /\.focus-answer-lead\.negative/);

  // Review Area: a minimap with the dragged box, and clicking it reveals the region on canvas.
  assert.match(source, /function regionRecallMarkup\(critique\)/);
  assert.match(source, /miniBoard\(\{ box: bounds \}\)/);
  assert.match(source, /function revealRegionOnCanvas\(bounds\)/);
  assert.match(source, /data-region-recall/);
  assert.match(source, /flash\.className = "region-flash"/);
  assert.match(styles, /\.region-recall/);
  assert.match(styles, /@keyframes region-flash-pulse/);
});

test("a stale-context critique disables Accept and offers an inline regenerate recovery instead of an alert dead-end", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // Freshness gates the individual apply: a critique built for the previous
  // context can no longer reach the apply path (so the stale-context alert is
  // unreachable). resultsMatchContext is the last conjunct.
  assert.match(source, /const resultsMatchContext = reviewResultsMatchContext\(\)/);
  assert.match(
    source,
    /const canApplyIndividually = descriptor\.executable\s*&& applicationPlan\.canApply\s*&& resultsMatchContext/,
  );

  // The stale case surfaces an in-panel recovery notice with a one-click
  // Regenerate button — not a dead-end browser alert.
  assert.match(source, /actionable && descriptor\.executable && !resultsMatchContext \?/);
  assert.match(source, /focus-decision-notice needs-regenerate/);
  assert.match(source, /id="focusRegenerate" class="focus-notice-action"/);
  assert.match(source, /!recommendationMatchesDashboard \?/);
  assert.match(source, /Regenerate for the current dashboard/);
  assert.match(source, /overlaps a change you already applied/);

  // The genuine-conflict notice is mutually exclusive with both stale notices.
  assert.match(
    source,
    /actionable && descriptor\.executable && resultsMatchContext && recommendationMatchesDashboard && !canApplyIndividually \?/,
  );
  assert.doesNotMatch(source, /alert\(`Could not apply recommendation/);
  assert.doesNotMatch(source, /alert\(`Could not apply the selected recommendations/);

  // The misleading "no executable transformation yet" small-text is suppressed
  // while stale (the preview is skipped, not absent by nature).
  assert.match(source, /descriptor\.previewFailure/);
  assert.match(source, /Cannot safely apply this recommendation/);
  assert.match(source, /!descriptor\.livePreview && resultsMatchContext && recommendationMatchesDashboard/);

  // Context-stale still regenerates the full set (every card used the old brief)
  // and re-opens this critique. Overlap-after-apply refreshes only this card.
  assert.match(source, /getElementById\("focusRegenerate"\)\?\.addEventListener/);
  assert.match(source, /await runAIAssist\(\{[\s\S]*?focusedRequest: ""/);
  assert.match(source, /keepCritiqueId: targetId/);
  assert.match(source, /id="focusRegenerateOne"/);
  assert.match(source, /Regenerate this critique/);
  assert.match(source, /async function regenerateOneCritique\(/);
  assert.match(source, /persistReviewMeta: false/);
  assert.match(source, /id="focusRefreshDone"/);
  assert.match(source, /This critique no longer applies/);
  assert.match(source, /state\.selectedCritiqueId = targetId/);

  // Distinct styling for the recovery notice and its inline action button.
  assert.match(styles, /\.focus-decision-notice\.needs-regenerate/);
  assert.match(styles, /\.focus-notice-action/);
});

test("the KPI band renders real engine-computed values, not a hardcoded placeholder set", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // The old five fabricated KPI tuples are gone; the band is driven by
  // board.kpis (ResolvedKpi[]), each an engine-computed value.
  assert.doesNotMatch(source, /Tasks closed this month/);
  assert.doesNotMatch(source, /Overall velocity/);
  assert.doesNotMatch(source, /Active contributors/);
  assert.match(source, /const kpis = Array\.isArray\(board\.kpis\) \? board\.kpis : \[\]/);
  assert.match(source, /const showKpiBand = board\.showKpis && kpis\.length > 0/);
  assert.match(source, /kpis\.map\(\(kpi,\s*index\) =>/);
  // An honestly uncomputed KPI is marked, never dressed up as a real number.
  assert.match(source, /kpi\.computed === false \? " kpi-uncomputed" : ""/);
  assert.match(source, /String\(kpi\.value \?\? "—"\)/);

  // KPIs are no longer suppressed for uploaded dashboards — the nativeLayout
  // false-branch is gone; the band shows whenever real values exist.
  assert.doesNotMatch(source, /const nativeLayout = state\.artifact\.source === "uploaded-json"/);
  assert.match(source, /showKpis: previewBoard \? Boolean\(previewBoard\.hasKpis\) : Boolean\(state\.showKpis\)/);
  assert.match(source, /hasKpis: Boolean\(state\.showKpis\)/);
  assert.match(source, /hasEmbeddedKpis: Boolean\(state\.hasEmbeddedKpis\)/);

  // State carries the real band, and apply commits the engine's computed KPIs.
  assert.match(source, /boardKpis: \[\]/);
  assert.match(source, /state\.boardKpis = Array\.isArray\(result\.board\.kpis\) \? result\.board\.kpis : state\.boardKpis/);
  assert.match(source, /hero-support/);
  assert.match(source, /card-grid/);
  assert.match(source, /side-rail/);
  assert.match(source, /inline-summary/);
  assert.match(source, /iterationContext: iterationContextForEngine\(\)/);
  assert.match(source, /boardKpiStyle: null/);
  assert.match(source, /kpiStyle: previewBoard \? previewBoard\.kpiStyle : state\.boardKpiStyle/);
  assert.match(source, /state\.boardKpiStyle = result\.board\.kpiStyle \|\| state\.boardKpiStyle/);
  // The board sent to the engine carries current KPIs and the immutable canvas.
  assert.match(source, /kpis: Array\.isArray\(state\.boardKpis\) \? state\.boardKpis : \[\]/);
  assert.match(source, /kpiStyle: state\.boardKpiStyle \|\| undefined/);
  assert.match(source, /canvasWidth: state\.canvasSize\.width/);
});

test("a board-layout change moves real tiles on the canvas", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const engine = await readFile(new URL("../src/recommendation-engine.js", import.meta.url), "utf8");

  // edit-layout routes to a dedicated layout descriptor branch (kind wins over
  // the model's surface hint), never a static region no-op.
  assert.match(source, /kind === "edit-layout" \? "layout"/);
  assert.match(source, /if \(surface === "layout"\)/);
  assert.match(source, /renderer: "layout"/);
  // Only a genuine engine-produced box difference claims a change.
  assert.match(source, /const layoutChanged = Boolean\(preview\?\.board\) && afterTiles\.some/);

  // The canvas relocates tiles: a preview/applied board's per-tile bounds win
  // over the committed box so "Proposed" actually shows the move.
  assert.match(source, /const bounds = meta\?\.bounds \? \{ \.\.\.meta\.bounds \} : renderedTileBounds/);
  // Apply writes new tile boxes, while the original canvas size remains fixed.
  assert.match(source, /if \(bounds\) tile\.bounds = \{ \.\.\.bounds \}/);
  assert.match(source, /const canvasWidth = state\.canvasSize\.width/);
  assert.doesNotMatch(source, /state\.canvasSize = \{\s*\n?\s*width: Number\.isFinite\(nextWidth\)/);

  // The layout summary label exists.
  assert.match(source, /"edit-layout": "Dashboard tile layout"/);
  // The planner knows the primitive so it can be selected and applied.
  assert.match(engine, /"edit-layout":\s*\{/);
  assert.match(engine, /writes: \["dashboard\.layout", "chart\.bounds"\]/);
});

test("the review-temperature slider sits inline with Generate, shows the number, and sends it", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // The slider and the Generate button share one row.
  assert.match(source, /class="generate-row"/);
  assert.match(
    source,
    /class="generate-row">[\s\S]*id="reviewTemperature"[\s\S]*id="aiAssistButton"/,
  );

  // A continuous range input on the model's 0–1 scale, defaulting to moderate exploration.
  assert.match(source, /id="reviewTemperature"\s+type="range"/);
  assert.match(source, /min="0"\s*\n?\s*max="1"\s*\n?\s*step="0.1"\s*\n?\s*value="0.4"/);

  // The value is shown to the author (not hidden) via a live readout.
  assert.match(source, /id="reviewTemperatureValue"/);
  assert.match(source, /readout\.textContent = formatReviewTemperature\(value\)/);

  // A header row carries a short word-label at the top-left (without exposing
  // the word "temperature") and the numeric readout at the top-right.
  assert.match(
    source,
    /class="temp-slider-head">[\s\S]*class="temp-slider-label"[\s\S]*id="reviewTemperatureValue"/,
  );
  assert.match(source, /class="temp-slider-label"[^>]*>Exploration</);
  const labelText = source.match(/class="temp-slider-label"[^>]*>([^<]*)</)?.[1] ?? "";
  assert.ok(
    !/temperature/i.test(labelText),
    `the slider label must not use the word "temperature" (was "${labelText}")`,
  );

  // The state carries the number and BOTH generation requests (full + local)
  // send it verbatim — count the send sites so dropping one is caught.
  assert.match(source, /reviewTemperature: 0\.4/);
  const sendSites = source.match(/reviewTemperature: state\.reviewTemperature/g) ?? [];
  assert.equal(
    sendSites.length,
    2,
    `expected both review requests to forward state.reviewTemperature (found ${sendSites.length})`,
  );

  // The slider is wired and its filled track is driven from the value.
  assert.match(source, /function wireReviewTemperature\(\)/);
  assert.match(source, /wireReviewTemperature\(\);/);
  assert.match(source, /setProperty\("--temp-fill"/);

  // Native range input dressed as a filled-track slider whose fill is read from
  // the CSS variable (not merely mentioned in a comment).
  assert.match(styles, /\.temp-slider-input::-webkit-slider-runnable-track/);
  assert.match(styles, /var\(--temp-fill/);

  // The filled track uses the system ink color, not the old accent blue.
  assert.match(styles, /#2C2C2E/);
  assert.doesNotMatch(styles, /#4c7ef3/i);
});

test("the active critique panel hides decided recommendations and moves them to a history popover", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // §2: the default "all" view excludes decided critiques, gated on the single
  // isDecidedCritique definition shared with the §1 merge.
  assert.match(source, /groupCritiquesByAsk,/);
  assert.match(source, /state\.filters\.status === "all" && isDecidedCritique\(critique\)\) return false;/);
  // When every critique is decided the active list points at the history entry
  // instead of the misleading "No critiques yet."
  assert.match(source, /All recommendations decided — open Critique History to review them\./);

  // §3: the history is defined, rendered, and refreshed from renderCritiques.
  assert.match(source, /function renderCritiqueHistory\(\)/);
  assert.match(source, /function askScopeLabel\(scope\)/);
  const renderCritiques = source.match(/function renderCritiques\(\)[\s\S]*?\nfunction renderStatusBar\(\)/)?.[0] || "";
  assert.match(renderCritiques, /renderCritiqueHistory\(\);/);

  // History now lives in the panel header: a text+count button that opens the
  // ask-grouped list as a header popover (same [data-sidebar-popover] idiom as
  // Search), and its list container exists inside that popover.
  assert.match(source, /id="critiqueHistoryToggle" data-sidebar-popover="history"/);
  assert.match(source, /class="critique-history-button-label">History</);
  assert.match(source, /id="sidebarPopoverHistory" data-popover-name="history"/);
  assert.match(source, /id="critiqueHistoryList"/);

  // Empty history hides the button and closes a stale-open popover.
  assert.match(source, /toggle\.hidden = true;/);
  assert.match(source, /if \(state\.sidebarPopover === "history"\) closeSidebarPopovers/);

  // The obsolete bottom drawer and its bespoke toggle handler are gone.
  assert.doesNotMatch(source, /id="critiqueHistoryDrawer"/);
  assert.doesNotMatch(source, /state\.drawers\.history = !state\.drawers\.history;/);

  // The read side finally consumes the provenance §1 stamped.
  assert.match(source, /re-surfaced in Ask \$\{critique\.resurfacedByAskId\}/);

  // Dedicated CSS for the header button and the history list.
  assert.match(styles, /\.critique-history-button \{/);
  assert.match(styles, /\.critique-history-item \{/);
});

test("positive feedback renders as an inline card inside its topic group, not a separate panel", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // The standalone Well Done panel is gone entirely — no host, no renderer, no CSS.
  assert.doesNotMatch(source, /wellDonePanel/);
  assert.doesNotMatch(source, /well-done-panel/);
  assert.doesNotMatch(source, /function renderWellDone\b/);
  assert.doesNotMatch(source, /wellDoneCardMarkup/);
  assert.doesNotMatch(styles, /\.well-done-panel/);

  // A strength renders as a non-interactive positive card (an <article>, never a
  // .critique-card <button>) that keeps the critique-card footprint and title
  // scale, but leads with a warm-gold award medal in the LEFT gutter and puts a
  // concise concrete-evidence line in the slot a critique card gives its chips.
  const cardMarkup = source.match(/function strengthCardMarkup\([\s\S]*?\n\}/)?.[0] || "";
  assert.ok(cardMarkup, "expected strengthCardMarkup to exist");
  assert.match(cardMarkup, /<article class="strength-card"/);
  assert.match(cardMarkup, /strength-title/);
  // The chip/label slot is replaced by an evidence line — not a leftover detail row.
  assert.match(cardMarkup, /strength-evidence/);
  assert.doesNotMatch(cardMarkup, /strength-detail/);
  // The medal carries an actual award icon (not an empty span) — an SVG must live
  // inside the .strength-medal element.
  assert.match(cardMarkup, /<span class="strength-medal"[^>]*>\s*<svg/);
  // The medal leads on the LEFT: it renders before the text body in DOM order (the
  // card grid pins a medal gutter as the first column), and the title precedes the
  // evidence line inside the body.
  assert.ok(
    cardMarkup.indexOf("strength-medal") < cardMarkup.indexOf("diagnostic-body"),
    "expected the medal to render before the text body (left gutter of the card)",
  );
  assert.ok(
    cardMarkup.indexOf("strength-title") < cardMarkup.indexOf("strength-evidence"),
    "expected the evidence line to follow the title",
  );
  // Leads with a medal gutter as the grid's first column, and the title takes the
  // critique title's list-view scale (13.5px).
  const cardCss = styles.match(/\.strength-card \{[^}]*\}/)?.[0] || "";
  assert.ok(cardCss, "expected .strength-card CSS to exist");
  assert.match(cardCss, /grid-template-columns:\s*26px minmax\(0, 1fr\)/);
  const listTitleCss = styles.match(/\.critique-list-view \.group-items \.strength-title \{[^}]*\}/)?.[0] || "";
  assert.match(listTitleCss, /font-size:\s*13\.5px/);
  // The card SURFACE stays neutral — no green surface, gradient, or colored left
  // edge. The only color is the medal itself: a warm gold (the requested positive
  // icon), NOT the earlier green.
  assert.doesNotMatch(cardCss, /border-left/);
  assert.doesNotMatch(cardCss, /#1f7a46|#f2faf5|linear-gradient/);
  const medalCss = styles.match(/\.strength-medal \{[^}]*\}/)?.[0] || "";
  assert.ok(medalCss, "expected .strength-medal CSS to exist");
  assert.match(medalCss, /#b8801a/);

  // The card is exactly two lines: no separate grounding footer, and no leftover
  // grounding helper. The evidence lives in the concise detail line, not a footer.
  assert.doesNotMatch(source, /strength-grounding/);
  assert.doesNotMatch(source, /strengthGroundingLine/);
  assert.doesNotMatch(source, /strength\.groundedIn/);

  // Strengths are woven into the dimension groups alongside critiques: the group
  // builder buckets both by dimension and the count badge covers both kinds.
  const grouping = source.match(/function groupCritiquesWithStrengths\([\s\S]*?\n\}/)?.[0] || "";
  assert.ok(grouping, "expected groupCritiquesWithStrengths to exist");
  assert.match(grouping, /strengthItems\.forEach/);
  assert.match(grouping, /item\.dimension \|\| "other"/);
  assert.match(source, /groupCritiquesWithStrengths\(categorized, visibleStrengths\)/);
  assert.match(source, /critiques\.length \+ strengths\.length/);

  // Praise is version/scope/category/search filtered like critiques, and confined
  // to the active status views (a strength has no lifecycle state to isolate).
  const filtered = source.match(/function filteredStrengths\([\s\S]*?\n\}/)?.[0] || "";
  assert.ok(filtered, "expected filteredStrengths to exist");
  assert.match(filtered, /strength\.reviewVersion !== state\.version/);
  assert.match(filtered, /state\.filters\.category/);

  // The empty-list early return accounts for praise, so a zero-problem scope with
  // a grounded strength still renders its topic group rather than an empty state.
  assert.match(source, /if \(!visible\.length && !visibleStrengths\.length\) \{/);

  // The old inline note is gone: no per-critique strength field, no .focus-strength.
  assert.doesNotMatch(source, /critique\.strength/);
  assert.doesNotMatch(source, /class="focus-strength"/);
  assert.doesNotMatch(styles, /\.focus-strength/);

  // Dedicated CSS for the inline card, its evidence line, and its small award medal.
  assert.match(styles, /\.strength-card \{/);
  assert.match(styles, /\.strength-evidence \{/);
  assert.match(styles, /\.strength-medal \{/);
});

test("session end archives high-resolution PNG and reloadable JSON for checkpoints and the final board", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /async function captureDashboardExport\(\)/);
  assert.match(source, /async function captureDashboardDisplaySvg\(\)/);
  assert.match(source, /async function captureDashboardPngFromSvg\(/);
  assert.match(source, /async function settleDashboardForCapture\(/);
  assert.match(source, /function buildDashboardCaptureSnapshot\(/);
  assert.match(source, /copyLiveControlState\(source, snapshot\)/);
  assert.match(source, /rasterizeDashboardArtboard\(\)/);
  assert.match(source, /toDataURL\("image\/png"\)/);
  assert.match(source, /toDataURL\("image\/webp", \.84\)/);
  const captureExport = source.match(/async function captureDashboardExport\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(captureExport, /const snapshot = buildDashboardCaptureSnapshot\(\)/);
  assert.match(captureExport, /captureDashboardPngFromSvg\(svg, width, height\)/);
  assert.doesNotMatch(captureExport, /captureLiveArtboardPng\(\)|captureDashboardPngFromViews\(\)/);
  assert.doesNotMatch(source, /function paintLiveArtboardChrome\(|async function captureLiveArtboardPng\(/);
  assert.match(source, /target\.afterPng = captured\.png/);
  assert.match(source, /target\.afterSvg = captured\.svg/);
  assert.match(source, /target\.afterSnapshot = captured\.snapshot/);
  assert.match(source, /const full = version\.afterPng \|\| thumbnail/);
  assert.match(source, /full: faithful \|\| full/);
  assert.match(source, /async function collectStudyDashboardArtifacts\(\)/);
  assert.match(source, /captured\.snapshot \|\| buildDashboardCaptureSnapshot\(\)/);
  assert.match(source, /exportStudyDashboardsZip\(out\.artifacts, out\.bundle\)/);
  assert.match(source, /saveStudyBundle\("end"\)/);
});

test("study telemetry pairs review requests with displayed or failed, and checkpoint counts match applied ids", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /state\.reviewInFlight/);
  assert.match(source, /if \(state\.reviewInFlight\) return false;/);
  assert.match(source, /recordCritiquesDisplayed\(/);
  assert.match(source, /recordCritiquesDisplayed\("selected-region", askId,/);
  assert.match(source, /requestId/);
  assert.match(source, /requestMode/);
  assert.match(source, /fewShotSetId/);
  assert.match(source, /fewShotVersion/);
  assert.match(source, /fewShotIds/);
  assert.match(source, /fewShotContentHash/);
  assert.match(source, /recommendation_apply_requested/);
  assert.match(source, /dashboard_changed/);
  assert.match(source, /endStudySession\(\{ reason: "end" \}\)/);
  assert.match(source, /final_state_captured/);
  assert.match(source, /decision: "apply"/);
  assert.match(source, /recommendation_deferred/);
  assert.match(source, /critiques_unresolved/);
  assert.match(source, /dwellMs/);
  assert.match(source, /decision: "defer"/);
  assert.match(source, /critique_request_failed/);
  assert.match(source, /const recommendationIds = \[\.\.\.\(state\.workingDraft\.applicationOrder \|\| \[\]\)\];/);
  assert.match(source, /const committedIds = Array\.isArray\(result\.applicationOrder\)/);
  assert.match(source, /workingDraft\.applicationOrder \|\| \[\]\)\.length/);
});
