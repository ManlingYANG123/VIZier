import type { DashboardType, ScaffoldRequest, ScaffoldResponse } from "./contracts.ts";
import type { LLMClient } from "./llm/client.ts";
import { buildContextSnapshot } from "./generate/evidence.ts";
import { DEFAULT_DASHBOARD_TYPE, isDashboardType } from "./generate/dashboard-type.ts";

// The 11 recommendation branches plus the crosscutting `accessibility` tag.
// `performance` is not a scope in v2 (the review dimension was dropped).
const ALLOWED_SCOPES = new Set([
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
  "accessibility",
]);

export const SCAFFOLD_SYSTEM = `You are an expert dashboard analyst. Your task is to analyze a dashboard's design, data, and structure to infer its purpose and create a review context.

You will receive:
1. AUTHOR MATERIAL: optional notes/requirements from the user (may be empty)
2. DASHBOARD EVIDENCE: actual Vega-Lite specs with data, marks, encodings, titles

Your job:
- Analyze the DASHBOARD EVIDENCE deeply: examine the data values, field names, chart types, titles, and relationships between charts
- Infer the dashboard's purpose from its content (what domain? what metrics? what story?)
- Generate a review context with:
  * goal: one concise sentence (25 words maximum) naming the dashboard subject, the central comparison or pattern, and the decision or question it supports
  * audience: one concise phrase or sentence (20 words maximum) naming the likely user role and how they would use the dashboard
  * constraints: ONLY explicit constraints from AUTHOR MATERIAL or technical limits visible in specs (e.g., color palette, specific formats). If none stated, return empty string.
  * dashboardType: the communicative genre this dashboard is FOR — exactly one of "analytical", "operational", "infographic", "executive". Infer it from what the artifact is built to do:
      - "analytical": supports open exploration and pattern-finding — many views, filters/drill-downs, granular data, no single packaged conclusion
      - "operational": at-a-glance status monitoring — KPI status, thresholds/alerts, meant to be scanned repeatedly and often refreshed live
      - "infographic": a narrative that delivers one explicit conclusion — heavy annotation/text, guided reading order, polished visual design, little or no interactivity
      - "executive": a high-level so-what summary for decision-makers — a few headline metrics and a clear takeaway, low detail, low interactivity
    When genuinely ambiguous, default to "analytical".
  * assumptions: list what you inferred vs. what was stated
  * missingFields: ["goal", "audience", "constraints"] for fields that need author confirmation

Analysis approach:
1. Read sample data rows - what domain/subject? (sales, marine life, projects, etc.)
2. Examine field names and values - what metrics are tracked?
3. Look at chart types and encodings - what comparisons/patterns are shown?
4. Consider chart titles and dashboard title - what story is being told?
5. Identify relationships between charts - is there a narrative flow?

Be specific to THIS dashboard's actual content. Do not use generic placeholders.
Prefer concrete analytical language over vague phrases such as "understand performance" or "make better decisions."
If analyzing a dashboard about ocean species, mention marine biology/oceanography.
If analyzing project metrics, mention project management/operations.

Return ONLY JSON:
{"goal":"...","audience":"...","constraints":"...","dashboardType":"analytical|operational|infographic|executive","assumptions":["..."],"missingFields":[...]}`;

function collectFields(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => collectFields(item, out));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "field" && typeof child === "string") out.add(child);
      else collectFields(child, out);
    }
  }
  return out;
}

function dashboardEvidence(req: ScaffoldRequest): Record<string, unknown> {
  const tiles = Object.entries(req.specMap || {}).map(([id, spec]) => {
    const data = spec.data as { values?: unknown[] } | undefined;
    const values = Array.isArray(data?.values) ? data.values : [];
    const markValue = spec.mark;
    const mark = typeof markValue === "string"
      ? markValue
      : markValue && typeof markValue === "object"
        ? (markValue as Record<string, unknown>).type
        : undefined;

    // Extract encoding channels to understand what's being visualized
    const encoding = spec.encoding as Record<string, unknown> | undefined;
    const encodingChannels = encoding ? Object.keys(encoding) : [];

    // Get more sample data for better analysis (up to 8 rows)
    const sampleRows = values.slice(0, 8);

    // Extract unique field names and infer data types
    const fields = [...collectFields(spec.encoding)];

    return {
      id,
      title: req.board?.tiles?.find((tile) => tile.id === id)?.title,
      mark,
      encodingChannels,
      encodedFields: fields,
      transforms: Array.isArray(spec.transform) ? spec.transform : [],
      rowCount: values.length,
      sampleRows,
      // Include field statistics for numeric fields if available
      dataTypes: inferDataTypes(sampleRows, fields),
    };
  });
  return {
    title: req.board?.title || req.dashboard?.title,
    subtitle: req.board?.subtitle,
    hasKpis: req.board?.hasKpis,
    visibleMetrics: req.dashboard?.visibleMetrics || [],
    tileCount: tiles.length,
    tiles,
  };
}

function inferDataTypes(rows: unknown[], fields: string[]): Record<string, string> {
  const types: Record<string, string> = {};
  if (rows.length === 0) return types;

  for (const field of fields) {
    const firstRow = rows[0] as Record<string, unknown>;
    const value = firstRow?.[field];
    if (typeof value === "number") types[field] = "quantitative";
    else if (typeof value === "string") types[field] = "nominal";
    else if (value instanceof Date) types[field] = "temporal";
  }
  return types;
}

function cleanString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim().slice(0, 1200) || fallback;
}

function cleanContextField(value: unknown, fallback = "", limit = 180): string {
  const normalized = cleanString(value, fallback);
  if (normalized.length <= limit) return normalized;
  const clipped = normalized.slice(0, limit + 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  return clipped.slice(0, wordBoundary > limit * 0.6 ? wordBoundary : limit)
    .replace(/[\s,;:–—-]+$/g, "");
}

function cleanList(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter(Boolean).slice(0, limit);
}

function withSnapshot(result: Omit<ScaffoldResponse, "contextSnapshotId">): ScaffoldResponse {
  const context = { ...result.context, fieldStatus: result.fieldStatus };
  return { ...result, contextSnapshotId: buildContextSnapshot(context).id };
}

/** Best-effort genre guess for the network-free path from author words only.
 * Deliberately conservative: it returns the permissive default unless the author
 * material names the genre outright, so a real inference is left to the LLM. */
function templateDashboardType(raw: string): DashboardType {
  const text = raw.toLowerCase();
  if (/\binfographic|\bnarrative|\bstory\b|storytelling/.test(text)) return "infographic";
  if (/\bexecutive|\bleadership|\bboard(room)?\b|\bc-?suite/.test(text)) return "executive";
  if (/\boperational|\bmonitor(ing)?\b|\breal[- ]?time|\balert(s|ing)?\b|\bstatus\b/.test(text)) return "operational";
  return DEFAULT_DASHBOARD_TYPE;
}

/** Network-free extraction. It preserves only explicit author material and
 * never presents generic template copy as dashboard-derived context. */
export function templateScaffold(req: ScaffoldRequest): ScaffoldResponse {
  const raw = cleanString(req.rawText, "");
  const sentences = raw.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const audience = sentences.find((s) => /audience|\bfor\b.*(pmo|executive|leader|manager|team|client|stakeholder|analyst)/i.test(s));
  const goal = sentences.find((s) => /need|decid|spot|identify|monitor|track|help|action|risk/i.test(s));
  const constraints = sentences.filter((s) => /must|keep|constraint|brand|wall|mobile|export|accessib|deadline|avoid/i.test(s));
  const scope = [...ALLOWED_SCOPES];
  const missingFields: ScaffoldResponse["missingFields"] = [];
  if (!goal) missingFields.push("goal");
  if (!audience) missingFields.push("audience");
  if (!constraints.length) missingFields.push("constraints");
  return withSnapshot({
    context: {
      goal: cleanContextField(goal || ""),
      audience: cleanContextField(audience || ""),
      constraints: constraints.join(" "),
      dashboardType: templateDashboardType(raw),
      scope: [...new Set(scope)],
    },
    assumptions: missingFields.map((field) => `${field} was not explicit and remains unknown.`),
    missingFields,
    source: "template",
    fieldStatus: {
      goal: goal ? "confirmed" : "missing",
      audience: audience ? "confirmed" : "missing",
      constraints: constraints.length ? "confirmed" : "missing",
    },
  });
}

export function validateScaffold(model: Record<string, unknown>, fallback: ScaffoldResponse): ScaffoldResponse {
  const missingFields = cleanList(model.missingFields).filter((item): item is "goal" | "audience" | "constraints" =>
    item === "goal" || item === "audience" || item === "constraints");
  const constraints = missingFields.includes("constraints")
    ? ""
    : cleanString(model.constraints, "");
  const goal = cleanContextField(model.goal, fallback.context.goal);
  const audience = cleanContextField(model.audience, fallback.context.audience);
  const dashboardType: DashboardType = isDashboardType(model.dashboardType)
    ? model.dashboardType
    : fallback.context.dashboardType;
  const fieldStatus: ScaffoldResponse["fieldStatus"] = {
    goal: !goal ? "missing" : fallback.fieldStatus.goal === "confirmed" ? "confirmed" : "inferred",
    audience: !audience ? "missing" : fallback.fieldStatus.audience === "confirmed" ? "confirmed" : "inferred",
    constraints: !constraints || missingFields.includes("constraints") ? "missing" : fallback.fieldStatus.constraints === "confirmed" ? "confirmed" : "inferred",
  };
  return withSnapshot({
    context: {
      goal,
      audience,
      constraints,
      dashboardType,
      scope: [...ALLOWED_SCOPES],
    },
    assumptions: cleanList(model.assumptions),
    missingFields,
    source: "llm",
    fieldStatus,
  });
}

export async function buildScaffold(req: ScaffoldRequest, client?: LLMClient): Promise<ScaffoldResponse> {
  const fallback = templateScaffold(req);
  if (!client?.available()) {
    if (req.requireLLM) throw new Error("LLM_REQUIRED: no gateway token is configured");
    return fallback;
  }
  try {
    const model = await client.completeJson<Record<string, unknown>>(
      ["AUTHOR MATERIAL:", req.rawText || "(none supplied)", "", "DASHBOARD EVIDENCE (actual specs and samples):", JSON.stringify(dashboardEvidence(req), null, 2), "", `MODE: ${req.mode || "paste"}`].join("\n"),
      { system: SCAFFOLD_SYSTEM, temperature: 0, maxTokens: 900 },
    );
    return validateScaffold(model, fallback);
  } catch (error) {
    if (req.requireLLM) {
      throw new Error(`LLM_CALL_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    return fallback;
  }
}
