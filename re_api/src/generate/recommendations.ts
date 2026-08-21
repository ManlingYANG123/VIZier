import type { Dimension } from "../contracts.ts";

/** Ordered list of the 11 recommendation branches (display/grouping order). */
export const RECOMMENDATION_BRANCHES = [
  "chart",
  "color",
  "layout",
  "data",
  "text",
  "visual design",
  "cognition",
  "context",
  "interaction",
  "task",
  "design process",
] as const satisfies readonly Dimension[];

/** PRESENTING catalog: recommendation leaves the LLM selects from freely.
 * Derived from slack_codebook/recommendation_new.csv (rows marked （deleted）
 * excluded; full-width-paren aliases normalized to their canonical leaf id).
 * Branch is a display/grouping label only — the LLM may prescribe a leaf from
 * any branch regardless of the diagnosed object×problem (no branch gate). */
export interface RecommendationLeaf {
  /** Canonical `<branch>:<leaf>` id. */
  id: string;
  branch: Dimension;
  leaf: string;
  definition: string;
}

export const RECOMMENDATION_BRANCH_COLORS: Record<string, string> = {
  "chart": "orange",
  "color": "red",
  "layout": "blue",
  "data": "yellow",
  "text": "green",
  "visual design": "purple",
  "cognition": "green",
  "context": "green",
  "interaction": "yellow",
  "task": "yellow",
  "design process": "grey",
};

export const RECOMMENDATION_LEAVES: readonly RecommendationLeaf[] = [
  // chart
  { id: "chart:support perception", branch: "chart", leaf: "support perception", definition: "make marks, axes, labels, and other chart elements directly legible at the needed level of detail" },
  { id: "chart:use suitable shape", branch: "chart", leaf: "use suitable shape", definition: "pick a shape or aspect ratio that fits the comparison" },
  { id: "chart:keep encoding consistent", branch: "chart", leaf: "keep encoding consistent", definition: "use the same visual encoding for the same idea" },
  { id: "chart:differentiate views", branch: "chart", leaf: "differentiate views", definition: "make different views or meanings easy to tell apart" },
  { id: "chart:choose suitable encoding", branch: "chart", leaf: "choose suitable encoding", definition: "use a chart form that fits the thing being shown" },
  // color
  { id: "color:use color purposefully", branch: "color", leaf: "use color purposefully", definition: "use color because it helps, not just because it is available" },
  { id: "color:keep color consistent", branch: "color", leaf: "keep color consistent", definition: "reuse colors for the same attributes across the dashboard" },
  { id: "color:encode and distinguish meaning", branch: "color", leaf: "encode and distinguish meaning", definition: "use color to carry meaning and distinguish categories, scales, or status clearly" },
  // layout
  { id: "layout:show relationships among views", branch: "layout", leaf: "show relationships among views", definition: "use placement, coordination, or alignment to show how views connect" },
  { id: "layout:organize related views", branch: "layout", leaf: "organize related views", definition: "group or integrate related views so their connection is easy to understand" },
  { id: "layout:maintain reading order", branch: "layout", leaf: "maintain reading order", definition: "support a natural reading flow" },
  { id: "layout:fit page and space", branch: "layout", leaf: "fit page and space", definition: "choose page structure and fit available screen space without awkward crowding" },
  { id: "layout:organize clearly", branch: "layout", leaf: "organize clearly", definition: "make things easy to find on the screen" },
  { id: "layout:reduce layout complexity", branch: "layout", leaf: "reduce layout complexity", definition: "keep the layout simple and remove unnecessary repeated views" },
  { id: "layout:prioritize component placement", branch: "layout", leaf: "prioritize component placement", definition: "place and size components according to role, importance, hierarchy, and purpose" },
  { id: "layout:support comparison", branch: "layout", leaf: "support comparison", definition: "place comparable things where they can be compared fairly" },
  { id: "layout:keep layout consistent", branch: "layout", leaf: "keep layout consistent", definition: "keep repeated elements in predictable places" },
  // data
  { id: "data:summarize key information", branch: "data", leaf: "summarize key information", definition: "summarize and surface key values, trends, status, or performance signals" },
  { id: "data:select and scope data", branch: "data", leaf: "select and scope data", definition: "include relevant data and indicators at a focused scope that supports real questions or actions" },
  { id: "data:show appropriate detail", branch: "data", leaf: "show appropriate detail", definition: "match the level of detail to the task, including raw detail when needed" },
  { id: "data:define and manage metrics", branch: "data", leaf: "define and manage metrics", definition: "define, balance, and maintain metrics as a coherent set" },
  { id: "data:show relationships in data", branch: "data", leaf: "show relationships in data", definition: "show how metrics, signals, or related information connect or trade off" },
  { id: "data:ensure data quality and infrastructure", branch: "data", leaf: "ensure data quality and infrastructure", definition: "ensure data is accurate, fresh, trustworthy, and supported by necessary systems" },
  { id: "data:support valid inference", branch: "data", leaf: "support valid inference", definition: "avoid misleading conclusions from small samples, weak significance, confounds, or invalid comparisons" },
  // text
  { id: "text:support interpretation and analysis", branch: "text", leaf: "support interpretation and analysis", definition: "use labels, axes, symbols, or short explanatory text to make values and encodings interpretable" },
  { id: "text:communicate takeaways", branch: "text", leaf: "communicate takeaways", definition: "state a conclusion, implication, key takeaway, or call to action in text" },
  { id: "text:keep text readable and concise", branch: "text", leaf: "keep text readable and concise", definition: "make text easy to read and scan without unnecessary wording" },
  { id: "text:guide reading", branch: "text", leaf: "guide reading", definition: "use text to guide the reading path" },
  { id: "text:pair with symbols", branch: "text", leaf: "pair with symbols", definition: "let text and symbols clarify each other" },
  { id: "text:use familiar terms", branch: "text", leaf: "use familiar terms", definition: "use words users would naturally use" },
  // visual design
  { id: "visual design:manage visual complexity", branch: "visual design", leaf: "manage visual complexity", definition: "reduce clutter and balance visual complexity with usefulness so the display stays organized" },
  { id: "visual design:keep appearance consistent", branch: "visual design", leaf: "keep appearance consistent", definition: "keep the overall look consistent" },
  { id: "visual design:guide attention", branch: "visual design", leaf: "guide attention", definition: "draw attention to what matters" },
  { id: "visual design:support acceptance", branch: "visual design", leaf: "support acceptance", definition: "make the visual design feel credible, acceptable, and engaging enough to use" },
  { id: "visual design:provide redundant cues", branch: "visual design", leaf: "provide redundant cues", definition: "add a second visual cue—such as a label, icon, shape, pattern, or border—so meaning is not conveyed by color alone" },
  { id: "visual design:use common visual vocabulary", branch: "visual design", leaf: "use common visual vocabulary", definition: "use visual conventions readers can pick up quickly" },
  { id: "visual design:keep accessible", branch: "visual design", leaf: "keep accessible", definition: "keep the visual display easy enough to access" },
  { id: "visual design:use meaningful familiar components", branch: "visual design", leaf: "use meaningful familiar components", definition: "use icons, symbols, widgets, or components that are recognizable and clarify meaning" },
  // cognition
  { id: "cognition:reduce recall", branch: "cognition", leaf: "reduce recall", definition: "keep cues visible so users do not have to remember everything" },
  // context
  { id: "context:provide interpretive context", branch: "context", leaf: "provide interpretive context", definition: "add descriptions, explanations, and surrounding context needed to interpret the view" },
  { id: "context:disclose source", branch: "context", leaf: "disclose source", definition: "say where the data comes from and how it was handled" },
  { id: "context:state assumptions", branch: "context", leaf: "state assumptions", definition: "make assumptions, caveats, and data freshness visible" },
  { id: "context:show history", branch: "context", leaf: "show history", definition: "show past state when it helps explain the current one" },
  // interaction
  { id: "interaction:support exploration and detail access", branch: "interaction", leaf: "support exploration and detail access", definition: "let users explore, filter, and access more detail when needed" },
  { id: "interaction:support personalization", branch: "interaction", leaf: "support personalization", definition: "let users access or tailor settings, views, and formats to their needs" },
  { id: "interaction:support efficient use", branch: "interaction", leaf: "support efficient use", definition: "support faster paths for repeated use" },
  { id: "interaction:show system status and response", branch: "interaction", leaf: "show system status and response", definition: "make system state, feedback, and responses to user actions visible" },
  { id: "interaction:guide and orient users", branch: "interaction", leaf: "guide and orient users", definition: "help users know where they are, what to do next, and how to proceed" },
  { id: "interaction:support control and recovery", branch: "interaction", leaf: "support control and recovery", definition: "let users control the flow and recover from unwanted or dead-end states" },
  { id: "interaction:alert and advise", branch: "interaction", leaf: "alert and advise", definition: "warn users when something important needs attention" },
  { id: "interaction:ensure functional fit", branch: "interaction", leaf: "ensure functional fit", definition: "make sure features and functions match the dashboard purpose" },
  { id: "interaction:support evolution", branch: "interaction", leaf: "support evolution", definition: "leave room for feedback and dashboard changes over time" },
  { id: "interaction:support flexible formats", branch: "interaction", leaf: "support flexible formats", definition: "let the format or level of aggregation change when useful" },
  { id: "interaction:handle empty states", branch: "interaction", leaf: "handle empty states", definition: "avoid blank or empty states, or explain them clearly when no data is shown" },
  // task
  { id: "task:task support analysis", branch: "task", leaf: "task support analysis", definition: "support the questions, monitoring, comparisons, and decisions users need to handle" },
  { id: "task:support action", branch: "task", leaf: "support action", definition: "help people decide what to do next" },
  // design process
  { id: "design process:iterate and evaluate", branch: "design process", leaf: "iterate and evaluate", definition: "revise and validate the dashboard through feedback, usability testing, or regular evaluation" },
  { id: "design process:balance tradeoffs", branch: "design process", leaf: "balance tradeoffs", definition: "notice the tradeoffs and choose a workable balance" },
  { id: "design process:choose data and encoding", branch: "design process", leaf: "choose data and encoding", definition: "think about both what to show and how to show it" },
  { id: "design process:prototype early", branch: "design process", leaf: "prototype early", definition: "try rough versions before locking in the design" },
  { id: "design process:involve stakeholders", branch: "design process", leaf: "involve stakeholders", definition: "bring relevant people into decisions and build shared understanding" },
  { id: "design process:formalize process", branch: "design process", leaf: "formalize process", definition: "make ownership, updates, review, and change processes explicit" },
  { id: "design process:study users", branch: "design process", leaf: "study users", definition: "learn from users before deciding what to build" },
  { id: "design process:adapt methods", branch: "design process", leaf: "adapt methods", definition: "adjust the design method to fit the dashboard context" },
  { id: "design process:align with strategic goals", branch: "design process", leaf: "align with strategic goals", definition: "connect the dashboard to goals, strategy, and changing conditions" },
  { id: "design process:fit and socialize workflow", branch: "design process", leaf: "fit and socialize workflow", definition: "fit existing work practices and make the dashboard purpose and use process clear to the team" },
  { id: "design process:maintain load performance", branch: "design process", leaf: "maintain load performance", definition: "keep dashboard performance responsive enough to support smooth use and analysis workflow" },
];

/** Fast lookup of a leaf by its canonical `<branch>:<leaf>` id. */
export const RECOMMENDATION_LEAF_BY_ID: ReadonlyMap<string, RecommendationLeaf> =
  new Map(RECOMMENDATION_LEAVES.map((leaf) => [leaf.id, leaf]));

/** True when `id` is a known recommendation leaf. PRESENTING selects one of
 * these freely; the id is validated but the branch it belongs to never gates
 * which object×problem diagnosis may prescribe it. */
export function isRecommendationLeafId(id: string): boolean {
  return RECOMMENDATION_LEAF_BY_ID.has(id);
}

/** Compact catalog block for the LLM: every leaf grouped under its branch, so
 * the model can read all options and pick one exact id. */
export function recommendationCatalogPrompt(): string {
  const byBranch = new Map<Dimension, RecommendationLeaf[]>();
  for (const leaf of RECOMMENDATION_LEAVES) {
    const list = byBranch.get(leaf.branch) ?? [];
    list.push(leaf);
    byBranch.set(leaf.branch, list);
  }
  const lines: string[] = [];
  for (const branch of RECOMMENDATION_BRANCHES) {
    const leaves = byBranch.get(branch);
    if (!leaves || leaves.length === 0) continue;
    lines.push(`[${branch}]`);
    for (const leaf of leaves) {
      lines.push(`  - ${leaf.id} — ${leaf.definition}`);
    }
  }
  return lines.join("\n");
}
