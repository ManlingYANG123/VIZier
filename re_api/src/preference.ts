import type {
  ContextSuggestion,
  ContextSuggestionField,
  InteractionEvent,
  PreferenceSynthesisRequest,
  PreferenceSynthesisResponse,
} from "./contracts.ts";
import type { LLMClient } from "./llm/client.ts";

const ALLOWED_FIELDS = new Set<ContextSuggestionField>([
  "goal",
  "audience",
  "constraints",
  "notes",
]);

const STRONG_SIGNALS = new Set([
  "context_saved",
  "context_note_added",
  "local_critique_requested",
  "critique_rationale_added",
  "recommendation_accepted",
  "recommendation_rejected",
]);

export const PREFERENCE_SYNTHESIS_SYSTEM = `You are VIZier's dashboard-scoped context memory agent.

Infer any reusable authoring context the recorded actions consistently point to — not only constraints.
The journal contains semantic product events, not a complete account of the author's intent.

Infer whichever of these the evidence supports, and route each to its field:
- goal — what the dashboard is trying to accomplish or the decision it should support.
- audience — who it is for.
- constraints — what the review should preserve or avoid.
- notes — anything else reusable: what the author repeatedly cares about, a recurring
  priority or emphasis, a stylistic or interaction preference, or a concern they keep raising.
Choose the field that fits the inference; use notes for preferences/priorities/concerns that are not a goal, audience, or constraint.

Rules:
- Return at most 3 suggestions; the strongest are surfaced first, so lead with your best-supported inference.
- Every suggestion must cite at least 2 supplied event IDs.
- Prefer repeated accept/reject decisions, explicit local review requests, and authored context.
- Opening a critique or viewing a preview is weak evidence and cannot support an inference alone.
- Do not infer sensitive traits, identity, expertise, or intent unrelated to dashboard authoring.
- Do not convert one rejected recommendation into a durable preference.
- Treat contradictory evidence as uncertainty; omit the suggestion when the evidence is ambiguous.
- Scope every suggestion to this dashboard.
- Do not repeat current context or previously resolved suggestions.
- Suggestions remain proposals for the author to confirm; never imply they were automatically adopted.
- Write the text as one short, self-contained phrase — no more than 12 words. State the reusable idea directly; do not restate the evidence.

Return ONLY JSON:
{"suggestions":[
  {
    "field":"goal|audience|constraints|notes",
    "text":"one short context phrase (12 words maximum)",
    "rationale":"why the repeated actions support this inference",
    "evidenceEventIds":["exact-event-id-1","exact-event-id-2"],
    "confidence":"tentative|supported"
  }
]}`;

function cleanText(value: unknown, limit: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/** How many suggestions reach the client. The rest are dropped after the
 * signal-strength sort, so the panel never accumulates an unbounded confirm
 * queue; the client surfaces the top ones and collapses any remainder. */
const MAX_SUGGESTIONS = 2;

export function validatePreferenceSuggestions(
  value: unknown,
  events: InteractionEvent[],
  resolvedSuggestionTexts: string[] = [],
): ContextSuggestion[] {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).suggestions
    : null;
  if (!Array.isArray(raw)) return [];

  const eventById = new Map(events.map((event) => [event.id, event]));
  const resolved = new Set(resolvedSuggestionTexts.map((text) => cleanText(text, 120).toLowerCase()));
  const seen = new Set<string>();

  return raw.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const field = item.field as ContextSuggestionField;
    const text = cleanText(item.text, 120);
    const rationale = cleanText(item.rationale, 260);
    const confidence: ContextSuggestion["confidence"] =
      item.confidence === "supported" ? "supported" : "tentative";
    const evidenceEventIds = Array.isArray(item.evidenceEventIds)
      ? [...new Set(item.evidenceEventIds
          .filter((id): id is string => typeof id === "string" && eventById.has(id)))]
      : [];
    const normalized = text.toLowerCase();
    const strongEvidenceCount = evidenceEventIds.filter((id) =>
      STRONG_SIGNALS.has(eventById.get(id)?.kind || "")).length;

    if (
      !ALLOWED_FIELDS.has(field) ||
      !text ||
      !rationale ||
      evidenceEventIds.length < 2 ||
      strongEvidenceCount < 2 ||
      resolved.has(normalized) ||
      seen.has(normalized)
    ) {
      return [];
    }
    seen.add(normalized);
    // Strong-signal evidence count is the primary weight; "supported" confidence
    // adds a half-point tiebreak so a firmer inference edges out an equally-cited
    // tentative one. Exposed on the suggestion so the client can re-rank the
    // accumulated list identically.
    const signalStrength = strongEvidenceCount + (confidence === "supported" ? 0.5 : 0);
    return [{
      id: `context-${slug(field)}-${slug(text) || index + 1}`,
      field,
      text,
      rationale,
      evidenceEventIds,
      confidence,
      scope: "dashboard" as const,
      signalStrength,
    }];
  })
    .sort((a, b) => b.signalStrength - a.signalStrength)
    .slice(0, MAX_SUGGESTIONS);
}

export async function synthesizePreferences(
  req: PreferenceSynthesisRequest,
  client?: LLMClient,
): Promise<PreferenceSynthesisResponse> {
  const events = (req.events || []).slice(-60);
  const strongEventCount = events.filter((event) => STRONG_SIGNALS.has(event.kind)).length;
  if (strongEventCount < 2) {
    return { suggestions: [], analyzedEventCount: events.length, source: "llm" };
  }
  if (!client?.available()) {
    throw new Error("LLM_REQUIRED: no gateway token is configured");
  }

  let model: Record<string, unknown>;
  try {
    model = await client.completeJson<Record<string, unknown>>(
      [
        `DASHBOARD ID: ${cleanText(req.dashboardId, 160) || "(current dashboard)"}`,
        "",
        "CURRENT EXPLICIT CONTEXT:",
        JSON.stringify(req.context || {}, null, 2),
        "",
        "PREVIOUSLY RESOLVED SUGGESTIONS:",
        JSON.stringify(req.resolvedSuggestionTexts || [], null, 2),
        "",
        "SEMANTIC INTERACTION JOURNAL:",
        JSON.stringify(events, null, 2),
      ].join("\n"),
      {
        system: PREFERENCE_SYNTHESIS_SYSTEM,
        temperature: 0,
        maxTokens: 1100,
      },
    );
  } catch (error) {
    throw new Error(`LLM_CALL_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    suggestions: validatePreferenceSuggestions(
      model,
      events,
      req.resolvedSuggestionTexts,
    ),
    analyzedEventCount: events.length,
    source: "llm",
  };
}
