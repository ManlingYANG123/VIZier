import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Vite entry does not contain an unevaluated server-side cache token", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.doesNotMatch(html, /<\?=/);
  assert.match(html, /<script type="module" src="\/src\/bootstrap\.js"><\/script>/);
});

test("checkpoint details remain comparison-only without a restore action", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /Restore this checkpoint/);
  assert.doesNotMatch(source, /restoreCheckpointButton/);
  assert.doesNotMatch(source, /restoreDashboardCheckpoint/);
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
  assert.doesNotMatch(source, /Review and confirm context in the left panel/);
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

test("a Gemini-style running-light ring marks the context box, design-doc uploader, region box, focused review, and Refine Solution while generating", async () => {
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
  assert.match(css, /\.focus-action\.refine\.is-generating::before/);
  // The context field lights up on manual regenerate and on auto-inference.
  assert.match(source, /function setContextInferring\(/);
  assert.match(source, /\.context-box-field/);
  // The region selection box keeps its ring toggled by the submit lifecycle.
  assert.match(source, /\.draft-marker"\)\?\.classList\.toggle\("is-generating"/);
  assert.match(source, /function setFocusedReviewGenerating\(/);
  assert.match(source, /function setRefineSolutionGenerating\(/);
});

test("a focused review send shows its generated card and unlocks the other review entry points", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /state\.focusedReviewRunning = true/);
  assert.match(source, /setFocusedReviewGenerating\(true\)/);
  assert.match(source, /succeeded = await runAIAssist\(\{ focusedRequest: request \}\)/);
  assert.match(source, /focusedInput\.value = ""/);
  assert.match(source, /state\.reviewRequest = ""/);
  // A successful focused ask lands on the main card list; only an explicit
  // stale-refresh keep id may open the inspector automatically.
  assert.match(source, /const opened = kept && \["pending", "updated"\]\.includes\(kept\.status\) \? kept : null/);
  assert.match(source, /state\.selectedCritiqueId = opened\?\.id \|\| null/);
  assert.match(source, /state\.focusedReviewRunning = false;[\s\S]*?syncReviewReadiness\(\)/);
  assert.match(source, /critique-answer-preview/);
  assert.doesNotMatch(source, /id="askAnswer"/);
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
  assert.match(source, /code: "B",\s+dashboardId: "workspace-overview",[\s\S]*?docId: "study-b"/);
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
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const runner = await readFile(new URL("../src/study-runner.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(html, /src="\/src\/bootstrap\.js"/);
  assert.match(bootstrap, /studyGroupIdFromPath/);
  assert.match(bootstrap, /bootStudyRunner/);
  assert.doesNotMatch(runner, /Review the dashboard/);
  assert.match(runner, /three stages: practice, formal use/);
  assert.match(runner, /Part \$\{part\} of 3/);
  assert.match(runner, /study_phase_intro_viewed/);
  assert.match(runner, /study_phase_intro_completed/);
  assert.match(runner, /study_phase_timer_started/);
  assert.match(runner, /study_phase_timer_completed/);
  assert.match(app, /versions: compactVersionMediaForWorkspace\(state\.versions\)/);
  assert.match(app, /await restoreMissingCheckpointPreviews\(\)/);
  assert.match(runner, /runnerState\.workspaces\[runnerState\.phase\] = app\.captureStudyRunnerWorkspaceState\(\)/);
  assert.match(runner, /id="studyStageTimer"/);
  assert.match(runner, /id="studyStartStageTimer">Start timer/);
  assert.match(runner, /"operation-page"/);
  assert.doesNotMatch(runner, /startPhaseTimer\(phase, completedAt\)/);
  assert.match(runner, /className: "is-phase-intro", showTimer: false/);
  assert.match(runner, /renderPhaseIntro/);
  assert.match(runner, /study-phase-axis/);
  assert.match(runner, /aria-current="step"/);
  assert.doesNotMatch(runner, /removed_pre_questionnaire_skipped/);
  assert.match(runner, /Questionnaire &amp; interview/);
  assert.match(runner, /openQuestionResponseMode: "spoken-interview"/);
  assert.match(runner, /scale_response_recorded/);
  assert.match(runner, /questionResponses: serializeQuestionResponses/);
  assert.match(runner, /scaleResponses: serializeScaleResponses/);
  assert.doesNotMatch(runner, /study-runner-state\.json/);
  assert.doesNotMatch(runner, /questionnaires\//);
  assert.match(runner, /path: "scale-post\.json"/);
  assert.match(runner, /runnerCompletionPromise/);
  assert.doesNotMatch(runner, /<textarea id="studyQuestion-/);
  assert.match(runner, /class="study-scale-interview-question"/);
  assert.doesNotMatch(runner, /study-interview-section/);
  assert.doesNotMatch(runner, /<details class="study-interview-prompts"/);
  assert.match(runner, /openStudyMaterialForRunner/);
  assert.match(runner, /studyPhaseUsesVizier\(runnerState\.phase\)/);
  assert.match(runner, /isDashboardTaskPhase\(runnerState\.phase\)/);
  assert.doesNotMatch(runner, /study-workspace-pdf|Preview PDF/);
  assert.match(app, /data-doc-preview>Preview PDF/);
  assert.match(app, /function previewDesignDocument\(\)/);
  assert.match(app, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  assert.match(app, /function iterableIds\(/);
  assert.doesNotMatch(runner, /Retry finish task/);
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
  assert.match(styles, /\.study-scale-question\s*\{[^}]*border-bottom:\s*2px solid #b8b8bd/);
  assert.match(styles, /\.study-scale-interview-question\s*\{[^}]*border-top:\s*1px solid #e2e2e6/);
  assert.doesNotMatch(styles, /\.study-questionnaire-page form > footer\s*\{[^}]*position:\s*sticky/);
  assert.match(styles, /\.study-workspace-progress/);
  assert.match(styles, /\.design-doc-status-actions/);
  assert.match(styles, /\.design-doc-action-link:focus-visible/);
});

test("practice serves one cached overall review while scoped generation stays live", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const runner = await readFile(new URL("../src/study-runner.js", import.meta.url), "utf8");
  const tutorial = await readFile(new URL("../src/practice-tutorial.js", import.meta.url), "utf8");
  const presets = await readFile(new URL("../src/practice-presets.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(runner, /practice: runnerState\.phase === "training"/);
  assert.doesNotMatch(runner, /startGuidedPracticeTutorial/);
  assert.match(app, /if \(!practiceTutorialIsGuiding\(\)\) return streamApply/);
  assert.match(app, /practiceOverallReviewResponse\(practiceRuntime\.preset\)/);
  assert.match(app, /shouldUsePracticeOverallCache\(\{[\s\S]*?explicitlyRequested: options\.usePracticeOverallCache/);
  assert.match(app, /practiceOverallReview: true/);
  assert.match(app, /practiceRuntime\.overallReviewCacheConsumed = true/);
  assert.match(app, /overallReviewCacheConsumed: practiceRuntime\.overallReviewCacheConsumed/);
  assert.match(app, /const savedCacheState = snapshot\.practice\?\.overallReviewCacheConsumed/);
  assert.match(app, /Practice Review Complete/);
  assert.match(app, /practice_overall_cache_served/);
  assert.match(app, /executionMode: "hybrid"/);
  assert.match(app, /practiceOverallReviewMode: "pre-cached-once"/);
  assert.match(app, /practiceLiveGenerationScopes: \["focused", "selected-region", "critique"\]/);
  assert.match(app, /practiceMode: "free-explore"/);
  assert.match(presets, /Should I change the layout\?/);
  assert.match(presets, /Is this title clear enough\?/);
  assert.match(tutorial, /const tutorialStepCount = milestones\.length \+ 1/);
  assert.match(tutorial, /Step \$\{displayedStep\} of \$\{tutorialStepCount\}/);
  assert.doesNotMatch(tutorial, /Step \$\{[^}]+\} of 8/);
  // Practice begins with a three-panel overview and requires the participant
  // to confirm the prepared context through the real workspace control.
  assert.match(app, /This is the Context panel/);
  assert.match(app, /This is the Canvas/);
  assert.match(app, /This is the Critique panel/);
  assert.doesNotMatch(app, /orientation-workspace/);
  assert.match(app, /expect: "context:confirmed"/);
  assert.match(app, /emitPracticeAction\("context:confirmed"/);
  // Tutorial state starts with an edited Context. Only the first overall review
  // is cached; focused, selected-area, refinement, and retry paths remain live.
  assert.match(app, /fieldStatus: \{ goal: "edited", audience: "edited", constraints: "edited" \}/);
  assert.doesNotMatch(app, /practiceReviewResponse/);
  assert.match(app, /async function generateLocalCritiques\(\{ bounds, request \}\)[\s\S]*?const resp = await streamCritique\(/);
  assert.match(app, /generateCritiquesFromEngine\(request, \{[\s\S]*?usePracticeOverallCache: false/);
  assert.equal((app.match(/expect: "review:full"/g) || []).length, 1);
  assert.equal((app.match(/expect: "checkpoint:saved"/g) || []).length, 1);
  assert.doesNotMatch(app, /practiceCheckpointActions|focused-checkpoint|local-checkpoint|save-batch/);
  // Guidance is a square-cornered, colorful clockwise outline, never a
  // page-dimming mask.
  assert.match(styles, /@keyframes practice-guide-orbit/);
  assert.match(styles, /\.practice-guide-spotlight::after/);
  assert.match(styles, /\.practice-guide-spotlight\s*\{[^}]*border-radius:\s*0/);
  assert.match(styles, /\.practice-guide-spotlight::after\s*\{[\s\S]*?#4285f4[\s\S]*?#9b72cb[\s\S]*?#34a853/);
  assert.doesNotMatch(styles, /\.practice-guide-spotlight\s*\{[^}]*9999px/);
  // The card has history-aware previous/next controls. It does not create a
  // simulated tutorial cursor; title-area selection is a real participant drag.
  assert.match(tutorial, /<a class="practice-guide-back"/);
  assert.match(tutorial, /practice-guide-back[\s\S]*?practice-guide-kicker[\s\S]*?practice-guide-next/);
  assert.doesNotMatch(tutorial, /<button[^>]+class="practice-guide-(?:back|next)"/);
  assert.match(tutorial, /function previous\(\)/);
  assert.match(tutorial, /completedOrdinals/);
  assert.match(tutorial, /setLinkDisabled\(next, completed\)/);
  assert.match(tutorial, /advance\(\{ markComplete: true \}\)/);
  assert.match(tutorial, /markComplete: !currentAction\(\)\?\.expect/);
  assert.doesNotMatch(tutorial, /Complete the highlighted action to continue|nextDisabled|frontierOrdinal/);
  assert.doesNotMatch(tutorial, /practice-guide-cursor|runDemo|demoAnimation/);
  assert.match(app, /finishLocalReviewSelection[\s\S]*?emitPracticeAction\("area:selection-ready"/);
  assert.doesNotMatch(app, /preparePracticeTitleSelection|prepare-title-selection/);
  // Scroll the recommendation into view, then follow its live rectangle until
  // the nested critique rail has stopped moving.
  assert.match(tutorial, /function followTargetUntilStable\(selector\)/);
  assert.match(tutorial, /scrollIntoView[\s\S]*?followTargetUntilStable\(action\.target\)/);
  assert.match(tutorial, /stableFrames < 8/);
  assert.match(tutorial, /addEventListener\("scrollend"/);
  assert.match(tutorial, /new MutationObserver\(handleWorkspaceMutation\)/);
  assert.match(tutorial, /childList: true,[\s\S]*?subtree: true/);
  assert.match(tutorial, /layoutObserver\?\.disconnect\(\)/);
  assert.match(tutorial, /getComputedStyle\(ancestor\)/);
  assert.doesNotMatch(tutorial, /targetPadding/);
  // Participants can pause the overlay, use the complete VIZier workspace,
  // and resume at the same tutorial action without resetting progress.
  assert.match(tutorial, /Explore freely/);
  assert.match(tutorial, /Resume tutorial/);
  assert.match(tutorial, /function setPaused\(nextPaused\)/);
  assert.match(tutorial, /root\.hidden = paused/);
  assert.match(tutorial, /modeToggle\.addEventListener\("click", \(\) => setPaused\(!paused\)\)/);
  assert.match(app, /practice_tutorial_mode_changed/);
  assert.match(app, /practiceRuntime\.tutorialMode = mode === "tutorial"/);
  assert.match(app, /practiceMode: "free-explore"/);
  assert.match(presets, /function shouldUsePracticeOverallCache\(/);
  assert.match(app, /function practiceTutorialIsGuiding\(\)/);
  assert.doesNotMatch(app, /refresh-full-review/);
  assert.match(styles, /\.practice-guide-mode-toggle\[data-mode="explore"\]/);
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
  assert.match(source, /acceptEnabled \? "" : "disabled"/);
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
    /const \[descriptor\] = await Promise\.all\(\[[\s\S]*?focusPreviewDescriptor\(critique\)[\s\S]*?if \(state\.selectedCritiqueId !== critique\.id\) return;/,
  );
});

test("guidance-only recommendations are marked as considered, not applied", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // Guidance carries a tracked decision under an honest label — nothing is
  // applied to the canvas, so the action reads "Mark as Considered", not "Accept".
  assert.match(source, /canAcceptGuidance \? "Mark as Considered" : "Accept Change"/);
  assert.match(source, /class="focus-action \$\{canAcceptGuidance && !state\.batchMode \? "consider" : "accept"\}"/);
  assert.match(source, /critique\.status = "accepted"/);
  assert.match(source, /critique\.lifecycle = "guidance-accepted"/);
  assert.match(source, /guidanceOnly: true/);
  assert.match(source, /summary: `Marked guidance as considered:/);
  assert.match(source, /Marked as considered/);
  assert.match(source, /Guidance-only recommendations must be implemented manually/);
  assert.match(source, /"Review Area"/);
  assert.match(source, /"Focused Question"/);
  // Guidance-only critiques from full, focused, and selected-area reviews share
  // the same proposal gate, so none receives the Original/Proposed switch.
  assert.match(source, /guidanceOnly: !critiqueIsExecutable\(critique\)/);
  assert.match(source, /control\.hidden = !state\.canvasPreview \|\| awaitingFocusSlot \|\| guidanceOnlyFocus/);
  assert.match(source, /critiqueIsExecutable\(critique\) \? '<div class="focus-compare-slot"/);
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

test("interaction simulation auto-compares once and remains replayable via the canvas toggle", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  // The runtime no longer ships its own Original/Proposed switch: the shared
  // Original/Proposed toggle (reparented into the detail card for a focused
  // critique) drives phase switching during a test.
  assert.doesNotMatch(source, /id="demoToggle"/);
  assert.doesNotMatch(source, /demo-toggle-opt/);
  // There is no uncontrolled auto-flipping timer loop. The initial run performs
  // one bounded Original → Proposed comparison; later switching stays manual.
  assert.doesNotMatch(source, /transitionInteractionRuntimePhase\(phase === "before" \? "after" : "before"\)/);
  assert.doesNotMatch(source, /interactionRuntimeLoop|demoLoopId/);
  // Each phase uses the same real Vega observation path, and the persistent
  // canvas toggle can invoke it again after the initial comparison.
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

test("an interaction critique replays Original then Proposed from its focused test button", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /id="focusDemoButton"[^>]*>Replay Original → Proposed interaction</);
  const demoClick = source.match(
    /getElementById\("focusDemoButton"\)\?\.addEventListener\("click", \(\) => \{[\s\S]*?\n  \}\);/,
  )?.[0] || "";
  assert.match(demoClick, /playInteractionRuntime\(critique\)/);
  assert.match(demoClick, /recordStudyAction\("interaction_replayed"/);
  const runtime = source.match(/async function playInteractionRuntime[\s\S]*?\n}/)?.[0] || "";
  assert.match(runtime, /await observeInteractionPhase\(\);[\s\S]*?transitionInteractionRuntimePhase\("after"\)[\s\S]*?await observeInteractionPhase\(\);/);
  assert.match(source, /staticInteractionPreviewForRender\([\s\S]*?state\.demoPlaying/);
  assert.match(source, /function runtimeFilterControl\(scenario\)/);
  assert.match(source, /function dispatchRuntimeFilterControl\(element, scenario\)/);
  assert.match(source, /scenario\.kind === "filter-control"/);
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

test("Saved Rationale shows the latest two and collapses older entries behind More", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /Date\.parse\(rationale\.updatedAt \|\| rationale\.createdAt \|\| ""\)/);
  assert.match(source, /const visibleRationales = orderedRationales\.slice\(0, 2\)/);
  assert.match(source, /const overflowRationales = orderedRationales\.slice\(2\)/);
  assert.match(source, /class="rationale-more context-suggestion-more"/);
  assert.match(source, /Show \$\{overflowRationales\.length\} more saved/);
  assert.match(styles, /\.rationale-more \{/);
  assert.match(styles, /\.rationale-more-list \{/);
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
  assert.match(styles, /--rationale-body-indent: 10px;/);
  assert.match(styles, /\.rationale-source strong \{\s*margin-left: var\(--rationale-body-indent\);/);
  assert.match(styles, /margin: 5px 0 6px var\(--rationale-body-indent\);/);

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

test("overlapping critiques refresh independently in the background after Apply", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /backgroundCritiqueRefreshes: new Map\(\)/);
  assert.match(source, /function queueAffectedCritiqueRefreshes/);
  assert.match(source, /void Promise\.allSettled\(promises\)/);
  assert.match(source, /focusPurpose: "stale-refresh",\s+signal: controller\.signal/);
  assert.match(source, /activeJob\?\.token !== token/);
  assert.match(source, /Number\(state\.version\) !== baseVersion/);
  assert.match(source, /cancelBackgroundCritiqueRefresh\(critique\.id\)/);
  assert.match(source, /const job = state\.backgroundCritiqueRefreshes\.get\(critiqueId\)/);
  assert.match(source, /job\?\.controller\?\.abort\(\)/);
  assert.match(source, /for \(const job of state\.backgroundCritiqueRefreshes\.values\(\)\)/);
  assert.match(source, /Updating this fix for the current dashboard/);
  assert.match(source, /Accept and Refine will unlock automatically/);
  assert.match(source, /aria-describedby="focusActionUpdate"/);
  assert.match(source, /focusRetryBackgroundRefresh/);
  assert.match(styles, /\.background-refresh-chip/);
  assert.match(styles, /\.background-refresh-chip \{[\s\S]*?color: var\(--brand\)/);
  assert.match(styles, /\.focus-update-status \{/);
  assert.match(styles, /\.focus-action-update \{/);
  assert.match(styles, /background-critique-refresh-spin/);
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

test("reviews use a fixed 0.4 temperature without exposing an exploration slider", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /class="generate-row"/);
  assert.match(styles, /\.generate-row\s*\{[^}]*justify-content:\s*center/);
  assert.match(source, /const REVIEW_TEMPERATURE = 0\.4/);
  assert.match(source, /reviewTemperature: REVIEW_TEMPERATURE/);
  const sendSites = source.match(/reviewTemperature: state\.reviewTemperature/g) ?? [];
  assert.equal(sendSites.length, 2);
  assert.doesNotMatch(source, /id="reviewTemperature"|reviewTemperatureValue|wireReviewTemperature/);
  assert.doesNotMatch(styles, /\.temp-slider/);
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
  assert.match(source, /exportStudyBackupZip\(out\.artifacts, out\.bundle\)/);
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
  assert.doesNotMatch(source, /id="focusDefer"|decision: "defer"/);
  assert.match(source, /critiques_unresolved/);
  assert.match(source, /dwellMs/);
  assert.match(source, /critique_request_failed/);
  assert.match(source, /const recommendationIds = \[\.\.\.\(state\.workingDraft\.applicationOrder \|\| \[\]\)\];/);
  assert.match(source, /const committedIds = Array\.isArray\(result\.applicationOrder\)/);
  assert.match(source, /workingDraft\.applicationOrder \|\| \[\]\)\.length/);
});

test("Generate and Regenerate save the completed round before requesting new critiques", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.match(source, /aiAssistButton\.addEventListener\("click", \(\) => \{\s*void runAIAssist\(\{\s*checkpointBeforeReview: true,\s*practiceOverallReview: true,/);
  assert.match(source, /if \(options\.checkpointBeforeReview\) \{[\s\S]*?await saveWorkingDraftCheckpoint\(\{ force: true, source: "critique-request" \}\);[\s\S]*?requestStartedAt = Date\.now\(\);/);
  assert.match(source, /checkpoint\.purpose = "round_complete"/);
  assert.match(source, /Checkpoint \$\{checkpointId\} · Previous Round Complete/);
  assert.match(source, /Automatically saved before the next critique run/);
  assert.match(source, /checkpoint_save_failed/);
});

test("a selected-area review infers its category without asking the author", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /id="localReviewDimension"|for="localReviewDimension"/);
  assert.doesNotMatch(source, /els\.localReviewDimension/);
  assert.match(source, /async function generateLocalCritiques\(\{ bounds, request \}\)/);
  assert.match(source, /region: \{\s*bounds,\s*request,\s*semanticTargets,\s*\}/);
  assert.match(source, /dimension: localCritiques\[0\]\?\.dimension \|\| "other"/);
});

test("study telemetry survives refresh and closes preview, request, inspection, and final-state lifecycles", async () => {
  const [app, runner, session, vite] = await Promise.all([
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/study-runner.js", import.meta.url), "utf8"),
    readFile(new URL("../src/study-session.js", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.js", import.meta.url), "utf8"),
  ]);

  assert.match(runner, /vizier:study-workspace-changed/);
  assert.match(runner, /visibilitychange/);
  assert.match(runner, /pagehide/);
  assert.match(runner, /captureMountedWorkspace\("workspace-mounted"\)/);
  assert.match(runner, /"workspace-mounted"/);
  assert.match(runner, /"questionnaire-mounted"/);
  assert.match(app, /batch_preview_requested/);
  assert.match(app, /batch_preview_ready/);
  assert.match(app, /batch_preview_failed/);
  assert.match(app, /batch_preview_cancelled/);
  assert.match(app, /batch_selection_changed/);
  assert.doesNotMatch(app, /critique_reviewed_for_preview/);
  assert.match(app, /critique_request_cancelled/);
  assert.match(app, /critique_request_discarded/);
  assert.match(app, /recordCritiqueInspectionClosed\("switched_critique"\)/);
  assert.match(app, /recordStudyFinalState\(\{ reason: "formal-task-finished"/);
  assert.match(app, /proposal: clone\(critique\.proposal \|\| null\)/);
  assert.match(session, /STUDY_BUILD_ID/);
  assert.match(vite, /SOURCE_VERSION/);
});

test("the public app has no basic-auth login gate or completion cheerleading", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../re_api/src/server.ts", import.meta.url), "utf8");

  assert.doesNotMatch(server, /BASIC_AUTH|requireBasicAuth|WWW-Authenticate|timingSafeEqual/);
  assert.doesNotMatch(source, /Nicely done — this draft is looking strong|No open recommendations remain/);
});
