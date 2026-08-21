// End-to-end simulation (no real model, no server): drive the REAL review engine
// (runCritique -> discoverDashboardCritiques + the guidance-only un-suppression
// changes) with a mock LLM that returns a realistic mixed payload, then run the
// surviving critiques through the REAL frontend decision logic (copied verbatim
// from src/app.js) to print exactly what a user would see: the "Fixable" vs
// "Guidance" badge and the render group.
//
// Run:  npm run sim     (from re_api/), or  node scripts/simulate-guidance.ts
//
// It verifies the three behaviors of the workflow-critique fix without a gateway:
//   1. a normal review surfaces genuine process observations as Guidance cards;
//   2. the reserve keeps them on a critique-rich (20-slot) board;
//   3. the cap holds them at GUIDANCE_RESERVE (3) so they cannot flood a review.
// Exits non-zero if any check fails, so it can gate CI if wired in.
import { runCritique } from "../src/engine.ts";
import { Tracer } from "../src/trace.ts";
import { dashboardBoard, dashboardSpecMap } from "../fixtures/specs.ts";
import { diagnosisPayload } from "../tests/helpers.ts";
import type { LLMClient, CompleteOptions } from "../src/llm/client.ts";
import type { CritiqueRequest } from "../src/contracts.ts";

// ---- Frontend logic, copied VERBATIM from prototype/v2/src/app.js ----
// critiqueIsExecutable: app.js:3124  |  badge text: app.js:3180
function critiqueIsExecutable(critique: any): boolean {
  return critique.proposal?.mode === "executable" && critique.proposal?.kind !== "manual";
}
function fixBadge(critique: any): string {
  return critiqueIsExecutable(critique) ? "Fixable" : "Guidance";
}
// Group is keyed by critique.dimension (CRITIQUE_GROUPS, app.js:3186); the
// "design process" branch renders under the "Design process" group (app.js:3227).
function renderGroup(critique: any): string {
  return critique.dimension;
}
// critiqueTileCount: app.js:3132  |  critiqueTargetLabel (multi-tile branch): app.js:3137
function critiqueTileCount(critique: any): number {
  const tiles = critique.target?.ref?.tiles;
  return Array.isArray(tiles) ? new Set(tiles).size : (critique.tileId ? 1 : 0);
}
function critiqueTargetLabel(critique: any): string {
  const tileCount = critiqueTileCount(critique);
  if (tileCount > 1) return `Applies to ${tileCount} charts`;
  return `Applies to ${critique.tileId || "Dashboard"}`;
}

// ---- A mock LLM client that returns a fixed payload (same contract as StubClient) ----
class MockModel implements LLMClient {
  private payload: Record<string, unknown>;
  constructor(payload: Record<string, unknown>) { this.payload = payload; }
  available(): boolean { return true; }
  async complete(_t: string, opts: CompleteOptions = {}): Promise<string> {
    const text = JSON.stringify(this.payload);
    opts.onToken?.(text);
    return text;
  }
  async completeJson<T = Record<string, unknown>>(_t: string, opts: CompleteOptions = {}): Promise<T> {
    opts.onToken?.(JSON.stringify(this.payload));
    return this.payload as T;
  }
}

// Distinct valid object codes so each executable critique gets a unique slot key
// (critiqueSlotKey = object|problem|tileId|proposal.kind; identical keys dedupe).
const OBJECT_POOL = [
  "readability", "clarity", "cognition", "chart", "color", "layout", "text",
  "visual design", "data", "storytelling", "insights", "usability", "component",
  "tooltip", "interaction", "metadata", "task", "usage context", "accessibility",
  "performance",
];

// A grounded, executable chart fix on a real fixture tile.
function executableCritique(i: number) {
  return {
    object: OBJECT_POOL[(i - 1) % OBJECT_POOL.length],
    recommendation: "chart:support perception",
    kind: `legibility-${i}`,
    priority: i <= 2 ? "high" : "medium",
    surface: "encoding",
    tileId: "department-tasks",
    title: `Legibility fix ${i}`,
    issue: `Compact axis labels are hard to scan (${i}).`,
    rationale: "Leads compare departments quickly without decoding crowded labels.",
    evidence: "The department-tasks tile encodes department on a compact categorical axis.",
    suggestion: "Rotate labels and rank the axis by descending tasks.",
    judgmentBasis: ["dashboard evidence", "general design principle"],
    requiredContext: [],
    contextStatus: "not_applicable",
    evidenceRefs: [{
      source: "dashboard",
      path: "tile.department-tasks.encoding.x",
      detail: "department on a compact categorical axis",
      tileId: "department-tasks",
      field: "department",
      channel: "x",
    }],
    proposal: { kind: "edit-spec", mode: "executable", edits: [{ op: "set", path: ["encoding", "x", "axis", "labelAngle"], value: -40 }] },
    target: { granularity: "chart", ref: { tile: "department-tasks" } },
  };
}

// The SAME crowded-axis-label fix emitted once per tile — identical object,
// problem, leaf and edits, differing only by tileId. This is what the model does
// when it ignores the prompt's consolidation nudge; the engine backstop should
// collapse these into ONE critique carrying every tile in target.ref.tiles.
function crowdedLabelCritique(tileId: string) {
  return {
    object: "chart",
    problem: "cluttered | crowded",
    recommendation: "chart:support perception",
    kind: `crowded-labels-${tileId}`,
    priority: "medium",
    surface: "encoding",
    tileId,
    title: "Axis labels are crowded",
    issue: "The axis labels overlap and are hard to read.",
    rationale: "Readers need legible axis labels to compare values across the view.",
    evidence: `The ${tileId} tile renders crowded axis labels.`,
    suggestion: "Angle the axis labels so they no longer overlap.",
    judgmentBasis: ["dashboard evidence", "general design principle"],
    requiredContext: [],
    contextStatus: "not_applicable",
    evidenceRefs: [{
      source: "dashboard",
      path: `tile.${tileId}`,
      detail: `The ${tileId} tile is part of this dashboard.`,
      tileId,
    }],
    proposal: { kind: "edit-spec", mode: "executable", edits: [{ op: "set", path: ["encoding", "x", "axis", "labelAngle"], value: -40 }] },
    target: { granularity: "chart", ref: { tile: tileId } },
  };
}

// A genuine workflow/process observation: about the process, not a mark. No
// resolvable evidenceRef; rests on "general design principle" alone (Change B).
function processCritique(recommendation: string, kind: string, title: string, issue: string) {
  return {
    object: "design process",
    recommendation,
    kind,
    priority: "medium",
    surface: "structural",
    tileId: null,
    title,
    issue,
    rationale: "The dashboard risks drifting from user needs without this practice.",
    evidence: "No board subtitle, annotation, or metadata indicates this practice is in place.",
    suggestion: "Adopt the practice as part of the dashboard's authoring workflow.",
    judgmentBasis: ["general design principle"],
    requiredContext: [],
    contextStatus: "not_applicable",
    evidenceRefs: [],
    proposal: { kind: "manual", mode: "guidance_only" },
    target: { granularity: "dashboard", ref: {} },
  };
}

const PROCESS_LEAVES: Array<[string, string, string, string]> = [
  ["design process:iterate and evaluate", "no-evaluation-loop", "No feedback or evaluation loop is evident", "The board shows no sign of a review or usability-check cadence."],
  ["design process:involve stakeholders", "no-stakeholder-input", "Stakeholders may not be involved", "Nothing indicates the intended audience was consulted on these views."],
  ["design process:formalize process", "no-ownership", "Ownership and update cadence are unclear", "No metadata names an owner or a refresh cadence."],
  ["design process:study users", "no-user-study", "User needs may be assumed, not studied", "The view set does not reflect an explicit user-task study."],
  ["design process:prototype early", "no-prototyping", "Design may be locked in without prototyping", "A single finished layout suggests little early exploration."],
];

async function runScenario(name: string, critiques: any[]) {
  const req: CritiqueRequest = {
    version: 2,
    context: {}, // sparse context: no goal/audience/constraints -> no context refs
    specMap: dashboardSpecMap(),
    board: dashboardBoard(),
    requireLLM: true,
  } as CritiqueRequest;
  const client = new MockModel(diagnosisPayload(critiques));
  const tracer = new Tracer(`sim-${name}`, { logDir: null });
  const res = await runCritique(req, tracer, { client });

  const process = res.critiques.filter((c) => c.dimension === "design process");
  const executable = res.critiques.filter((c) => c.dimension !== "design process");

  console.log(`\n================ SCENARIO: ${name} ================`);
  console.log(`model returned ${critiques.length} critiques  ->  engine kept ${res.critiques.length}` +
    `  (design-process: ${process.length}, other: ${executable.length})`);
  console.log("what the user sees (badge · group · target · support · title):");
  for (const c of res.critiques) {
    const badge = fixBadge(c);
    const flag = c.dimension === "design process" ? "  <-- WORKFLOW / GUIDANCE"
      : critiqueTileCount(c) > 1 ? "  <-- CONSOLIDATED (multi-tile)" : "";
    console.log(
      `  [${badge.padEnd(8)}] ${renderGroup(c).padEnd(16)} ${critiqueTargetLabel(c).padEnd(24)} ${(c.supportStatus || "").padEnd(10)} ${c.title}${flag}`,
    );
  }
  // The consolidated card (if any): the one critique naming several tiles. Used
  // by the crowded-labels scenario to check the merge + the frontend label.
  const consolidated = res.critiques.find((c) => critiqueTileCount(c) > 1);
  return {
    kept: res.critiques.length,
    process: process.length,
    tileCount: consolidated ? critiqueTileCount(consolidated) : 0,
    label: consolidated ? critiqueTargetLabel(consolidated) : "",
  };
}

async function main() {
  // 1) Normal review: a handful of executable fixes + 2 genuine process observations.
  //    Expect BOTH process critiques to appear as "Guidance" under "design process".
  const s1 = await runScenario("normal-mix", [
    executableCritique(1),
    executableCritique(2),
    processCritique(...PROCESS_LEAVES[0]),
    processCritique(...PROCESS_LEAVES[2]),
  ]);

  // 2) Critique-rich board: 20 strong executable fixes would fill every slot, plus
  //    2 process observations. Expect the reserve to keep BOTH despite the 20-cap.
  const s2 = await runScenario("critique-rich-reserve", [
    ...Array.from({ length: 20 }, (_, i) => executableCritique(i + 1)),
    processCritique(...PROCESS_LEAVES[0]),
    processCritique(...PROCESS_LEAVES[1]),
  ]);

  // 3) Model floods 5 process critiques. Expect the CAP to keep at most 3.
  const s3 = await runScenario("process-flood-cap", PROCESS_LEAVES.map((l) => processCritique(...l)));

  // 4) The SAME crowded-axis-label fix emitted once per tile (3 charts). Expect the
  //    engine to collapse them into ONE consolidated card whose target.ref.tiles
  //    names all 3, which the frontend renders as "Applies to 3 charts".
  const s4 = await runScenario("crowded-labels-3-tiles", [
    crowdedLabelCritique("task-velocity"),
    crowdedLabelCritique("department-tasks"),
    crowdedLabelCritique("sprint-burndown"),
  ]);

  console.log("\n================ CHECKS ================");
  const checks: Array<[string, boolean]> = [
    ["normal review surfaces both process critiques as Guidance", s1.process === 2],
    ["reserve keeps both process critiques on a 20-critique board", s2.kept === 20 && s2.process === 2],
    ["cap holds process critiques at GUIDANCE_RESERVE (3)", s3.process === 3],
    ["three per-tile duplicates collapse into one consolidated card", s4.kept === 1],
    ["the consolidated card applies to all 3 charts", s4.tileCount === 3],
    ["the frontend labels it \"Applies to 3 charts\"", s4.label === "Applies to 3 charts"],
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    ok &&= pass;
  }
  console.log(ok ? "\nALL SIMULATION CHECKS PASSED\n" : "\nSIMULATION HAD FAILURES\n");
  if (!ok) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
