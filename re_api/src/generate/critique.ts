/**
 * Turn deterministic findings into v2-schema critiques.
 *
 * Structural/semantic fields (proposal, target, interactionKind, tileId) always
 * come from the finding — the model cannot fabricate the claim. Only the text
 * fields (title/issue/rationale/evidence/suggestion) come from the model, and
 * each is validated by a grounding guardrail before it is accepted; otherwise a
 * deterministic template phrasing is used. This keeps the engine correct (and
 * fully functional) even with no API token.
 */
import type {
  Bounds,
  Critique,
  DashboardContext,
  Finding,
  Priority,
} from "../contracts.ts";
import type { LLMClient } from "../llm/client.ts";
import { CRITIQUE_SYSTEM, critiqueUser } from "./prompts.ts";

export interface CritiqueTextFields {
  title: string;
  issue: string;
  rationale: string;
  evidence: string;
  suggestion: string;
}

const TEXT_KEYS: (keyof CritiqueTextFields)[] = [
  "title",
  "issue",
  "rationale",
  "evidence",
  "suggestion",
];

/** Deterministic, always-grounded phrasing derived straight from the finding. */
export function templateText(finding: Finding): CritiqueTextFields {
  switch (finding.kind) {
    case "cross-filter-gap": {
      const field = finding.evidence.sharedField ?? "the shared dimension";
      const source = finding.evidence.sourceTile ?? "the source chart";
      const targets = finding.evidence.targetTiles ?? [];
      const targetList = targets.length ? targets.join(" and ") : "the other views";
      return {
        title: `Views don't respond to ${field} selection`,
        issue: `"${source}" looks selectable, but selecting a ${field} does not filter ${targetList}, so readers can't compare a single ${field} across views.`,
        rationale: `Coordinated views let a reader compare one ${field} across metrics in a single move; without a selection link they must cross-reference charts by hand.`,
        evidence: finding.evidence.detail,
        suggestion: `Bind a point selection on ${field} in "${source}" and filter ${targetList} to the selected value.`,
      };
    }
    case "missing-tooltip": {
      const tile = finding.evidence.tile ?? "the chart";
      return {
        title: `${tile} gives no detail on hover`,
        issue: `The ${tile} line looks like it should reveal values on hover, but it encodes no tooltip, so hovering any position reveals nothing.`,
        rationale: `On-hover detail lets a reader read exact values without cluttering the chart; a line with no tooltip forces estimation against the axis.`,
        evidence: finding.evidence.detail,
        suggestion: `Add a tooltip (and hover points) to ${tile} so each position reveals its underlying values on hover.`,
      };
    }
    case "ineffective-filter-control": {
      const label = finding.evidence.controlLabel ?? "Dashboard filter";
      return {
        title: `${label} is visible but does not change the dashboard`,
        issue: `The filter control updates visually, but it is not connected to its compatible target views.`,
        rationale: "A visible control creates a strong interaction promise; when the views do not respond, readers cannot trust the dashboard state.",
        evidence: finding.evidence.detail,
        suggestion: `Wire ${label} to the validated target views using the shared ${finding.evidence.field || "filter"} field.`,
      };
    }
    case "missing-kpi":
      return {
        title: "No summary KPIs are visible",
        issue: `The board shows only charts and no headline metrics, so a reader must scan every chart to answer "how are we doing?".`,
        rationale: "Summary metrics answer the headline question before viewers inspect detailed trends.",
        evidence: finding.evidence.detail,
        suggestion: "Add a KPI row with the dashboard's key headline numbers above the charts.",
      };
    case "uniform-palette": {
      const tiles = finding.evidence.tiles?.join(" and ") ?? "multiple charts";
      const fam = finding.evidence.colorFamily ?? "the same";
      return {
        title: `${tiles} share the same ${fam} palette`,
        issue: `${tiles} both use the ${fam} hue as their primary color, making their chart roles visually undifferentiated.`,
        rationale: "Distinct, semantic colors make chart roles easier to recognize and reduce cognitive load.",
        evidence: finding.evidence.detail,
        suggestion: `Give each chart a distinct role color instead of a shared ${fam} tone.`,
      };
    }
    case "preserve-brand": {
      const fam = finding.evidence.colorFamily ?? "brand";
      return {
        title: `Preserve the ${fam} brand palette`,
        issue: `A fully multicolor palette would improve differentiation but weaken the dashboard's established ${fam} visual identity.`,
        rationale: "Brand continuity can matter more than maximal separation when the dashboard is part of a larger suite.",
        evidence: finding.evidence.detail,
        suggestion: `Keep ${fam} as the primary hue and differentiate roles with tone, stroke, and annotation rather than unrelated colors.`,
      };
    }
    case "generic-title": {
      const title = finding.evidence.title ?? "the current heading";
      return {
        title: "Title lacks context and purpose",
        issue: `"${title}" is too generic and doesn't communicate what decisions this dashboard supports.`,
        rationale: "A descriptive title sets expectations and lets viewers grasp the dashboard's purpose immediately.",
        evidence: finding.evidence.detail,
        suggestion: "Rename the heading to name the subject and add a subtitle explaining what is tracked and why.",
      };
    }
    case "missing-subtitles":
      return {
        title: "Charts lack explanatory context",
        issue: "Chart labels are titles only, with no interpretation guidance, so viewers must infer the insights themselves.",
        rationale: "Takeaway subtitles turn raw charts into an intentional analytical narrative.",
        evidence: finding.evidence.detail,
        suggestion: "Add a takeaway subtitle beneath each chart label to explain what viewers should notice.",
      };
    default:
      return {
        title: "Review finding",
        issue: finding.evidence.detail,
        rationale: "Grounded in a deterministic structural check.",
        evidence: finding.evidence.detail,
        suggestion: "Address the structural gap described above.",
      };
  }
}

/** Keywords that would indicate the model drifted to the wrong kind of finding. */
function forbiddenKeywords(finding: Finding): RegExp[] {
  const base = [/\balready\b/i, /\bshows \d/i, /\breveals \d/i, /\b\d+\s+(tasks|projects|items|records)\b/i];
  // Only interaction findings should police interaction-type drift; visual/
  // narrative critiques legitimately mention neither.
  if (finding.interactionKind === "cross-filter") base.push(/tooltip|hover/i);
  else if (finding.interactionKind === "hover-tooltip") base.push(/cross-?filter|coordinat/i);
  return base;
}

/**
 * Guardrail: accept a model-authored text field only if it is a non-empty
 * string that does not drift to a different interaction or fabricate results.
 */
export function isGroundedText(field: string, finding: Finding): boolean {
  if (typeof field !== "string") return false;
  const value = field.trim();
  if (value.length < 3) return false;
  return !forbiddenKeywords(finding).some((re) => re.test(value));
}

export interface GroundResult {
  text: CritiqueTextFields;
  usedFallbackFor: string[];
}

/** Merge model text over the template, field-by-field, enforcing the guardrail. */
export function groundText(
  finding: Finding,
  modelJson: Partial<Record<keyof CritiqueTextFields, unknown>> | null,
): GroundResult {
  const template = templateText(finding);
  const text = { ...template };
  const usedFallbackFor: string[] = [];
  for (const key of TEXT_KEYS) {
    const candidate = modelJson?.[key];
    if (typeof candidate === "string" && isGroundedText(candidate, finding)) {
      text[key] = candidate.trim();
    } else {
      usedFallbackFor.push(key);
    }
  }
  return { text, usedFallbackFor };
}

function priorityOf(finding: Finding): Priority {
  return finding.severity;
}

function critiqueId(finding: Finding): string {
  return `c-${finding.kind}-${finding.tileId ?? finding.evidence.sharedField ?? "board"}`.replace(
    /[^a-z0-9-]/gi,
    "-",
  );
}

/** Assemble a full Critique from the finding (semantics) + text (phrasing). */
export function assembleCritique(
  finding: Finding,
  text: CritiqueTextFields,
  bounds?: Bounds,
  phrasingSource: Critique["phrasingSource"] = "template",
): Critique {
  return {
    id: critiqueId(finding),
    tileId: finding.tileId,
    dimension: finding.dimension,
    ...(finding.crosscutting ? { crosscutting: finding.crosscutting } : {}),
    priority: priorityOf(finding),
    status: "pending",
    source: "ai",
    title: text.title,
    issue: text.issue,
    rationale: text.rationale,
    evidence: text.evidence,
    suggestion: text.suggestion,
    target: finding.target,
    proposal: {
      kind: finding.proposalKind,
      mode: "executable",
      ...(finding.proposalKind === "wire-filter-control" && finding.evidence.filterId
        ? { filterId: finding.evidence.filterId }
        : {}),
    },
    surface: finding.surface,
    interactionKind: finding.interactionKind,
    bounds: bounds ?? finding.bounds,
    findingId: finding.id,
    grounded: true,
    phrasingSource,
    reviewScope: "full",
  };
}

export interface GenerateOptions {
  client?: LLMClient;
  requireLLM?: boolean;
  boundsByTile?: Record<string, Bounds>;
  onToken?: (token: string) => void;
  onFieldFallback?: (findingId: string, fields: string[]) => void;
}

/** Generate one grounded critique per finding. Explicit real-mode requests
 * require model-authored text and fail instead of silently returning templates. */
export async function generateCritiques(
  findings: Finding[],
  context: DashboardContext,
  opts: GenerateOptions = {},
): Promise<Critique[]> {
  const out: Critique[] = [];
  const useLLM = Boolean(opts.client?.available());
  if (opts.requireLLM && !useLLM) {
    throw new Error("LLM_REQUIRED: no gateway token is configured");
  }

  for (const finding of findings) {
    let modelJson: Partial<Record<keyof CritiqueTextFields, unknown>> | null = null;
    if (useLLM && opts.client) {
      try {
        modelJson = await opts.client.completeJson<Record<string, unknown>>(
          critiqueUser(finding, context),
          { system: CRITIQUE_SYSTEM, temperature: 0, maxTokens: 800, onToken: opts.onToken },
        );
      } catch (error) {
        if (opts.requireLLM) {
          throw new Error(`LLM_CALL_FAILED: ${error instanceof Error ? error.message : String(error)}`);
        }
        modelJson = null;
      }
    }
    const { text, usedFallbackFor } = groundText(finding, modelJson);
    if (usedFallbackFor.length) opts.onFieldFallback?.(finding.id, usedFallbackFor);
    if (opts.requireLLM && usedFallbackFor.length) {
      throw new Error(
        `LLM_GUARDRAIL_FAILED: ${finding.id} returned invalid fields: ${usedFallbackFor.join(", ")}`,
      );
    }

    const bounds =
      (finding.tileId && opts.boundsByTile?.[finding.tileId]) ||
      (finding.evidence.sourceTile && opts.boundsByTile?.[finding.evidence.sourceTile]) ||
      undefined;
    const phrasingSource: Critique["phrasingSource"] =
      usedFallbackFor.length === 0
        ? "llm"
        : modelJson && usedFallbackFor.length < TEXT_KEYS.length
          ? "mixed"
          : "template";
    out.push(assembleCritique(finding, text, bounds, phrasingSource));
  }
  return out;
}
