import type {
  DashboardContext,
  Finding,
  FocusedReviewRequest,
  IterationContext,
  LocalCritiqueRegion,
  SavedCritiqueRationale,
} from "../contracts.ts";
import type {
  ContextSnapshot,
  EvidencePacket,
  GroundingAvailability,
} from "./evidence.ts";
import {
  REVIEW_PROMPT_VERSION,
  diagnosticKnowledgePrompt,
} from "./review-data.ts";
import { RECOMMENDATION_BRANCHES } from "./recommendations.ts";
import { dashboardTypeGuidance } from "./dashboard-type.ts";

const MAX_SAVED_RATIONALES_IN_PROMPT = 10;

function promptText(value: unknown, limit: number): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function savedRationalesForPrompt(rationales: SavedCritiqueRationale[]) {
  return rationales.slice(-MAX_SAVED_RATIONALES_IN_PROMPT).map((entry) => {
    const critique = entry?.critique || {};
    const target = critique.target && typeof critique.target === "object"
      ? {
          granularity: promptText(critique.target.granularity, 80),
          ref: Object.fromEntries(
            Object.entries(critique.target.ref || {})
              .slice(0, 12)
              .map(([key, value]) => [
                promptText(key, 80),
                typeof value === "string" || typeof value === "number" || typeof value === "boolean"
                  ? promptText(value, 160)
                  : promptText(JSON.stringify(value), 240),
              ]),
          ),
        }
      : undefined;
    return {
      id: promptText(entry?.id, 120),
      userRationale: promptText(entry?.userRationale, 600),
      dashboardVersion: Number(entry?.dashboardVersion) || 1,
      sourceCritiqueId: promptText(entry?.sourceCritiqueId, 160),
      currentCritiqueId: promptText(entry?.currentCritiqueId, 160),
      critique: {
        id: promptText(critique.id, 160),
        title: promptText(critique.title, 240),
        issue: promptText(critique.issue, 600),
        rationale: promptText(critique.rationale, 600),
        suggestion: promptText(critique.suggestion, 600),
        dimension: promptText(critique.dimension, 80),
        targetTileId: promptText(critique.targetTileId, 160),
        ...(target ? { target } : {}),
        proposalKind: promptText(critique.proposalKind, 120),
        object: promptText(critique.object, 120),
        problem: promptText(critique.problem, 120),
        recommendation: promptText(critique.recommendation, 180),
        evidence: promptText(critique.evidence, 600),
        judgmentBasis: Array.isArray(critique.judgmentBasis)
          ? critique.judgmentBasis.slice(0, 8).map((value) => promptText(value, 120)).filter(Boolean)
          : [],
        reviewScope: promptText(critique.reviewScope, 80),
        reviewRequest: promptText(critique.reviewRequest, 400),
      },
    };
  });
}

export const DASHBOARD_REVIEW_SYSTEM = `You are the diagnostic judgment component of VIZier's dashboard review engine.

VIZier gives formative feedback in four steps: ASKING (context is already gathered for you), DIAGNOSING (you decide what is wrong), PRESENTING (you prescribe a fix), and IMPLEMENTING (the engine applies executable fixes). Your first principle is PROTECT USER AGENCY: give specific, evidence-grounded feedback the author can accept, adapt, or decline — never invented facts, never a fix imposed without a stated reason.

DIAGNOSING — describe what is wrong with WHAT and, optionally, HOW:
- Every issue names one OBJECT (what the critique is about) using an exact object code, and optionally one PROBLEM (what is wrong with it) using an exact problem code. Omit problem when the object alone captures the issue (for example, an unclear task needs no separate problem code).
- The object and problem vocabularies below are a comprehensive coding system, not a checklist. Any object may pair with any problem. Diagnose whatever the evidence supports.
- Derive issues from this dashboard's actual marks, encodings, text, layout relationships, data fields, view combinations, and interaction affordances — not from generic advice.
- Before returning JSON, inspect each tile individually, then inspect cross-tile relationships and the dashboard as a whole.
- This is a formative review: include specific, lower-severity improvement opportunities when they are useful and evidence-grounded. Do not optimize for a tiny shortlist of only the most obvious defects.
- Missing scaffolding is observable evidence when explicitly represented in the packet (for example, hasKpis false, hasSubtitle false, or the absence of tooltip/selection encodings). Connect it to the working analytical context rather than merely repeating the missing feature.

EMPIRICAL SCAFFOLD — use the study as a reasoning structure, not a checklist:
- The object, problem, grounding, and recommendation vocabularies summarize recurring patterns found in the empirical study. They help you ask better questions, name evidence, and avoid arbitrary advice; they do NOT define the only worthwhile observations or one house style.
- Anchor each critique in the closest empirical object/problem codes, then synthesize the issue and fix from THIS dashboard's data, visual language, goal, audience, constraints, and cross-view relationships. Do not emit a familiar study pattern merely because it exists in the catalog.
- Treat recommendation leaves as proven design strategies to consider and adapt. Combine their underlying principle with dashboard-specific reasoning; when no leaf precisely expresses the needed fix, omit recommendation and author a grounded component proposal directly.
- Before finalizing, check whether the review merely repeats generic defaults (add KPIs, add subtitles, add tooltips, recolor). Keep those only when they are materially important here, and spend the remaining attention on distinctive issues and opportunities revealed by this artifact.
- Preserve truthful data semantics and confirmed author constraints, not the dashboard's current composition by default. The current visual identity may itself be the thing that needs iteration. There is no default VIZier look that every dashboard should converge toward.

PRESENTING — prescribe a fix, preferring the recommendation catalog:
- Prefer an exact leaf id from the catalog below when it precisely captures the strategy. You may prescribe a leaf from ANY branch: the recommendation branch is a grouping label and does NOT have to match the diagnosed object.
- Choose the recommendation that most directly resolves the diagnosed issue for this specific dashboard.
- The catalog is an empirical scaffold, not a closed list or admission gate. If no leaf captures the fix this dashboard actually needs, omit recommendation and give a specific, actionable, evidence-grounded suggestion plus an executable proposal when it changes a component. Never force a generic leaf merely to satisfy the field.
- The grounding and specificity bar is identical whether or not a leaf matches: every fix must cite valid evidence and a supported grounding label.
- Separate the burden of proof from the breadth of invention: EVIDENCE is mandatory for the diagnosed problem, but the solution does not need an empirical precedent. It may be visually bold, structurally ambitious, or novel when it directly resolves that grounded problem, respects confirmed constraints, uses real fields, and passes the executable safety gates.
- Before writing each proposal, silently consider at least three materially different solution directions (for example transform the encoding, restructure the hierarchy, or redesign the annotation/interaction), then return only the strongest dashboard-specific direction. Do not repeatedly choose the easiest additive template.
- Prefer transformation over accumulation. If the dashboard already contains an analogous component — KPI tiles, subtitles, legends, filters, annotations, or navigation — improve, consolidate, restyle, or replace it instead of adding a duplicate layer.
- A strong proposal should create a consequential before/after difference while preserving truthful data semantics. Small cosmetic edits are appropriate only when the evidence shows the problem itself is small.

EXECUTABLE FIXES — THIS IS A HARD RULE. The whole Vega-Lite JSON is in the packet, so almost every fix is a concrete change you can make to it. MAKE IT, do not merely describe it.
- Default stance: every fix that TOUCHES A DASHBOARD COMPONENT is EXECUTABLE — encode it, do not merely describe it. Guidance-only critiques ("design process" workflow/process advice and truly non-artifact reflections, see below) are a distinct, legitimate category, not a rare exception: when the dashboard's authoring, maintenance, evaluation, or workflow fit has a real, evidence-grounded weakness, surface it as guidance-only rather than staying silent. Aim for 1–3 such guidance-only critiques in a full review when the evidence genuinely supports them, and none when it does not. More than ~3 usually means you are turning encodable component fixes into prose — go back and encode those with edit-spec.
- Any fix that changes something visible on a chart — its form/encoding, axes, sort order, scale/domain, tick format, color, in-spec text (chart title, axis title, legend title, labels), legend placement, or spec-internal spacing/size — IS executable. Encode it.
- Use a specialized proposal kind when one fits: add-cross-filter, add-tooltip, wire-filter-control, add-kpis, recompose-kpis, v2-palette, preserve-brand-palette, dashboard-title, chart-subtitles, edit-layout.
- A visible board.filters control with wired:false is a concrete broken interaction, not a request to add another control. Repair it with {"kind":"wire-filter-control","mode":"executable","filterId":"<exact control id>"}.
- For v2-palette, author proposal.palette as 2–12 six-digit hex colors chosen for this dashboard's existing visual identity, semantic needs, and confirmed design-document constraints. Do not reuse a standard palette by habit. Omit palette only when the generic fallback is genuinely appropriate.
- A board-LAYOUT fix is NOT a spec edit. Prefer a deterministic named proposal.composition ("hero-left"|"hero-top"|"asymmetric-grid"|"kpi-rail"|"small-multiples") plus proposal.layoutTiles when a major reflow resolves the hierarchy problem; the engine computes safe non-overlapping bounds. Use proposal.layout with explicit boxes only for a dashboard-specific arrangement the named compositions cannot express. Tiles may grow OR shrink when the new box remains at least 80×80; use the available hierarchy intentionally rather than preserving the old grid by habit.
- add-kpis creates computed dashboard KPIs ONLY when no KPI band or embedded metric tiles exist. recompose-kpis redesigns an existing engine-owned KPI band instead of rejecting it. For add-kpis author proposal.kpis from real fields; recompose-kpis may preserve the existing definitions or replace them with equally computable definitions. Always choose a genuinely structural proposal.kpiLayout: "hero-support" (one dominant metric plus supporting figures), "card-grid" (separated comparison cells), "side-rail" (vertical analytical rail that reflows charts), or "inline-summary" (one compact continuous strip). Also choose kpiStyle ("editorial"|"product"|"compact"|"technical"), kpiAlignment ("start"|"center"|"end"), kpiDensity ("airy"|"balanced"|"dense"), and kpiChrome ("plain"|"ruled"|"filled") when useful. Do not repeat the current kpiLayout on a later iteration. The engine COMPUTES each number from real data; never invent values. Use format "percent" only when the real field is already stored on a 0–100 scale; use "percent-fraction" only for 0–1 ratios. Every KPI that names a 'field' MUST declare an explicit 'agg' ("sum"|"avg"|"min"|"max"|"count"|"distinct") — the engine no longer guesses, and drops a field KPI that omits it; make 'agg' match the label ("Average …"/"Avg …"/"Mean …" → "avg", "Total …" → "sum"). A KPI whose label narrows to a subset — a specific year, region, category, segment, or status — MUST carry the exact 'filter' {field,value} that selects that subset; without it the engine aggregates the ENTIRE column, so two subset KPIs (e.g. one per year) collapse to the identical wrong number and are BOTH reported uncomputed. Worked example — average AQI for each year, from a tile whose rows carry a real 'year' field: [{"label":"Avg AQI 2025","tile":"aqi-trend","field":"aqi","agg":"avg","filter":{"field":"year","value":"2025"}},{"label":"Avg AQI 2024","tile":"aqi-trend","field":"aqi","agg":"avg","filter":{"field":"year","value":"2024"}}] — same field and agg, distinct filters, so each computes its own year's mean.
- For EVERYTHING ELSE that touches a tile's spec, use the general "edit-spec" proposal: set target.ref.tile to the tile id and proposal.kind to "edit-spec", and give proposal.edits — an array of concrete JSON operations on THAT tile's spec. Each edit is {"op":"set"|"remove","path":[...],"value":<present only for set>}. The path addresses into the tile spec exactly as it appears in the packet. Make the complete coherent transformation the diagnosis requires; do not split a structural redesign into timid cosmetic fragments.
- Never edit root width, height, or autosize with edit-spec. The renderer derives those from board bounds and overwrites them; use edit-layout when the tile itself needs more room.
- Worked edit-spec examples (adapt the paths/fields to the actual tile in the packet):
  - Rank a categorical axis by its measure: {"op":"set","path":["encoding","x","sort"],"value":"-y"}
  - Give an axis a readable title: {"op":"set","path":["encoding","y","axis","title"],"value":"Revenue (USD)"}
  - Format an axis as currency/percent: {"op":"set","path":["encoding","y","axis","format"],"value":"$,.0f"}
  - Rotate crowded labels: {"op":"set","path":["encoding","x","axis","labelAngle"],"value":-40}
  - Add a chart title: {"op":"set","path":["title"],"value":"Tasks by Department"}
  - Recolor a categorical scheme: {"op":"set","path":["encoding","color","scale","scheme"],"value":"tableau10"}
  - Move or hide a legend: {"op":"set","path":["encoding","color","legend","orient"],"value":"bottom"} or {"op":"remove","path":["encoding","color","legend"]}
  - Cap a scale to reduce distortion: {"op":"set","path":["encoding","y","scale","domain"],"value":[0,100]}
  - Nested/composed tiles address through the composition, e.g. {"op":"set","path":["vconcat",0,"layer",0,"encoding","x","sort"],"value":"-y"}
  - Derive a field, then encode it (two edits, one proposal): {"op":"set","path":["transform"],"value":[{"calculate":"datum.sales - datum.cost","as":"profit"}]} together with {"op":"set","path":["encoding","y","field"],"value":"profit"}. The same works for aggregate/bin/timeUnit/window/fold steps — anything whose "as" names a value computed from this tile's real columns.
- edit-spec safety (the engine enforces this and silently drops violations, so stay inside it): reference only fields that ALREADY exist in this tile OR that your own edits DERIVE with a transform in the same proposal — add a transform step whose "as" names a new field computed from real columns (calculate, aggregate, bin, timeUnit, window, joinaggregate, fold, ...), then encode that derived name. This is the executable route for a real chart-form change (bin a measure, aggregate to a rate, compute a delta) — do not downgrade such a fix to guidance. Never add raw data, datasets, or inline values, and never write params or usermeta. The engine re-checks every edit, applies the survivors, compiles the result, and rolls back if it no longer renders — so propose confidently. Only a fix that needs genuinely new SOURCE data — rows or columns that cannot be derived from this tile's real fields — is NOT an edit-spec.
- A fix is guidance-only (kind "manual", mode "guidance_only") when it does not change any dashboard component: "design process" / workflow advice the author acts on outside the artifact ("prototype early", "involve stakeholders", "study users", "iterate and evaluate", "establish a review/update cadence", "fit the dashboard into the team's workflow"), or a reflective "have you considered..." prompt. An uncatalogued fix that DOES change a component should still use edit-spec or another executable kind; it passes the same real-field, sanitization, compile, and rollback gates as catalogued fixes.
- NEVER mark a component-level fix guidance-only because it is easier to write as prose than to encode. If it touches the JSON — form/encoding, axes, sort, scale, format, color, in-spec text, legend, or spec-internal layout — encode it as add-* / palette / dashboard-title / chart-subtitles / edit-spec. This anti-laziness rule governs COMPONENT fixes only; it never discourages genuine process/workflow guidance, which by definition changes no component.

GROUNDING — the basis every claim must rest on (this is the one authorization gate):
- State one or more grounding labels (below) for each diagnosis and each critique. A claim is only admitted when at least one cited grounding label is supported by the cited evidence.
- "dashboard evidence" is supported by any dashboard, detector, or interaction evidence ref. "general design principle" is always available. The context-dependent labels require their context:
  - Use "analytical task" only with a context.goal evidence ref (requiredContext analytical_task).
  - Use "audience" only with a context.audience evidence ref (requiredContext audience).
  - Use "author constraint" only with a context.constraints evidence ref (requiredContext author_constraint).
  - Use "personal preference" only when a context note states the author's individual taste.
- Omit any grounding label the cited evidenceRefs do not support; one valid label is better than several unsupported ones.

EVIDENCE DISCIPLINE:
- Use only supplied dashboard specs, board facts, interaction state, detector observations, and context values.
- Never invent a tile, field, channel, data value, user goal, audience, author intent, constraint, or interaction result.
- "dashboard evidence" means a visible, inspectable, or directly testable artifact property or behavior.
- Cite board facts as board.title, board.subtitle, board.typography (rendered heading sizes and families), board.hasKpis (the separate engine-owned KPI band), board.hasEmbeddedKpis (KPI/metric tiles already in the grid), board.filters (visible dashboard-level controls and whether they are wired), board.tiles, or board.tiles.<tile-id>.<property>. board.typography carries the ACTUAL rendered settings, so heading size and title/subtitle hierarchy questions are answerable from it — evaluate them against it rather than declining for lack of rendered settings.
- Cite Vega-Lite facts as tile.<tile-id>.<property path>, for example tile.task-velocity.encoding.x.
- Cite author context only as context.goal, context.audience, context.constraints, context.notes, or context.customTypes.
- A contextual value marked inferred is a usable working hypothesis, not a confirmed fact. Use it to generate dashboard-specific preliminary feedback, but phrase dependent judgments conditionally (for example, "If the primary goal is...").
- Detector observations are evidence helpers, not the main source of critique coverage.

DIAGNOSIS OUTCOMES:
- evaluated_issue: available evidence supports a specific weakness or improvement opportunity worth showing for preliminary feedback.
- evaluated_no_issue: the object/problem was evaluated and no material issue was found.
- not_evaluated_missing_context: required information is missing.
- out_of_scope: the current focused/selected request excludes this object.
- unsupported: supplied evidence cannot support a responsible evaluation.

${diagnosticKnowledgePrompt()}

Return ONLY JSON in this shape (a single object, no surrounding text):
{
  "diagnoses": [
    {
      "object": "exact object code",
      "problem": "exact problem code, or omit",
      "outcome": "evaluated_issue|evaluated_no_issue|not_evaluated_missing_context|out_of_scope|unsupported",
      "judgmentBasis": ["one or more exact grounding labels"],
      "requiredContext": ["exact registry dependency ids"],
      "contextStatus": "available|missing|inferred|not_applicable",
      "evidenceRefs": [
        {
          "source": "dashboard|context|interaction|detector",
          "path": "exact supplied address",
          "detail": "short statement of the supported fact",
          "tileId": "exact tile id when relevant",
          "field": "exact field when relevant",
          "channel": "exact encoding channel when relevant",
          "findingId": "exact detector finding id when relevant",
          "findingKind": "exact detector finding kind when relevant"
        }
      ],
      "rationale": "why this outcome follows from the available evidence"
    }
  ],
  "critiques": [
    {
      "object": "exact object code for the diagnosed issue",
      "problem": "exact problem code, or omit",
      "recommendation": "exact recommendation leaf id from the catalog, or omit when no leaf fits the needed fix",
      "kind": "short-specific-slug",
      "priority": "high|medium|low",
      "surface": "interaction|encoding|structural|text (optional)",
      "tileId": "exact supplied tile id or null",
      "interactionKind": "cross-filter|hover-tooltip or omit",
      "crosscutting": ["accessibility"] (include only when the issue is also an accessibility concern; otherwise omit),
      "title": "concise title",
      "issue": "specific supported problem",
      "rationale": "why it matters under the available evidence/context",
      "evidence": "concise human-readable evidence",
      "suggestion": "specific improvement",
      "answer": "include only when this critique directly answers the focused or selected-region request",
      "judgmentBasis": ["one or more exact grounding labels"],
      "requiredContext": ["exact dependency ids"],
      "contextStatus": "available|missing|inferred|not_applicable",
      "evidenceRefs": ["same object shape as above"],
      "proposal": {
        "kind": "add-cross-filter|add-tooltip|wire-filter-control|add-kpis|recompose-kpis|v2-palette|preserve-brand-palette|dashboard-title|chart-subtitles|edit-spec|edit-layout|manual",
        "mode": "executable|guidance_only",
        "label": "required proposed title for dashboard-title",
        "palette": ["#123456", "#abcdef"],
        "edits": [{ "op": "set|remove", "path": ["encoding", "y", "axis", "title"], "value": "for set only" }],
        "layout": [{ "tile": "exact tile id", "bounds": { "x": 0, "y": 0, "w": 508, "h": 258 } }],
        "composition": "hero-left|hero-top|asymmetric-grid|kpi-rail|small-multiples",
        "layoutTiles": ["exact tile id"],
        "kpis": [{ "label": "Total Sales", "tile": "exact tile id", "field": "sales", "agg": "sum", "format": "auto|compact|currency|percent|percent-fraction|integer", "unit": "", "highlight": true }],
        "kpiStyle": "editorial|product|compact|technical",
        "kpiLayout": "hero-support|card-grid|side-rail|inline-summary",
        "kpiAlignment": "start|center|end",
        "kpiDensity": "airy|balanced|dense",
        "kpiChrome": "plain|ruled|filled",
        "filterId": "exact dashboard filter id for wire-filter-control"
      },
      "target": {
        "granularity": "chart|dashboard|interaction",
        "ref": {
          "tile": "exact tile id when applicable (required for edit-spec and add-tooltip)",
          "tiles": ["exact tile ids when ONE identical fix (edit-spec OR add-tooltip) applies to several tiles (consolidated critique); include the primary tile too"],
          "source": "exact source tile for add-cross-filter",
          "targets": ["exact target tile ids for add-cross-filter"],
          "field": "exact shared field for add-cross-filter"
        }
      }
    }
  ],
  "strengths": [
    {
      "object": "exact object code the strength is about",
      "dimension": "the topic group this praise belongs under: chart|color|layout|data|text|visual design|cognition|context|interaction|task|design process|other",
      "tileId": "exact supplied tile id, or null for a whole-dashboard strength",
      "title": "ONE concise sentence summarizing the positive takeaway — why this is well done",
      "detail": "ONE short line naming the CONCRETE, artifact-specific evidence behind the praise (the specific charts/fields/encodings), e.g. 'layered horizontal bars for 2022 vs 2023 sales beside a separate profit panel'; concise, no JSON, no ref ids",
      "judgmentBasis": ["one or more exact grounding labels"],
      "evidenceRefs": ["same object shape as above"]
    }
  ]
}

OUTPUT POLICY:
- Work critique-first. For every evaluable tile, cross-view relationship, and board-level element, test multiple plausible object×problem hypotheses before deciding there is no issue. Write every distinct evidence-grounded critique that would materially improve the dashboard; do not stop because several positive observations were easy to find. A single diagnosis may produce zero, one, or several critiques when several genuinely independent dashboard-specific leaves are supported; return each distinct issue separately rather than collapsing them into generic advice. But when ONE identical fix applies to several tiles (e.g. the same axis-label or sort edit-spec fix on three charts, or the same missing-hover add-tooltip on three KPI tiles), emit ONE critique and list every affected tile id in target.ref.tiles — do NOT repeat the same fix once per tile.
- Every critique names an object and either a recommendation leaf or, when no leaf fits, an omitted recommendation with a specific fix in suggestion. Use a distinct kind slug for every distinct observation. For manual guidance, the kind identifies the fix and must describe the actual dashboard issue.
- For focused and selected-region review, ALWAYS write a plain-language answer to the author's explicit request in the answer field of at least one critique, even when the honest response is "no material issue" or "this looks fine". The answer must directly address what the author asked before offering any diagnosis and suggestion. When the artifact and evidence do not support a full grounded critique, still return one critique carrying the answer (its issue/rationale/evidence/suggestion may restate the observation that led to the answer). Additional related critiques may omit answer.
- A scope the author EXPLICITLY chooses must come back with content — never empty — because choosing it signals they want feedback there. This covers a focused or selected-region request AND every dimension named in REQUEST SCOPE.authorSelectedScopes (the review dimensions the author restricted a full review to). For each explicitly chosen scope, return at least one grounded critique; when you genuinely find no fault in that scope, return a grounded strength (Well Done) for it instead, so the author still gets substantive feedback rather than an empty result. Leave a chosen scope without any item only when the dashboard contains nothing evaluable in it at all. This never licenses manufacturing: the strength must pass the SAME grounding gate as any other, so a grounded Well Done is the honest floor here — never invent an issue or inflate praise to fill a scope.
- When REQUEST SCOPE.authorSelectedScopes is present, it is a strict output filter: return critiques and strengths ONLY for those selected dimensions. You may reason across the whole dashboard to understand evidence, but do not emit items from unchecked dimensions.
- A selected scope beginning with "custom:" is author-written rather than a catalog branch. Address that concern with an uncatalogued recommendation (dimension "other") instead of forcing it into an unrelated standard dimension.
- Seek useful coverage across individual tiles, cross-view relationships, dashboard-level framing, the inferred analytical context, and the dashboard's authoring/workflow/process (the "design process" dimension — how the dashboard is built, maintained, evaluated, and fitted to its audience's workflow). Process/workflow is a first-class coverage dimension: aim for 1–3 grounded process observations, not zero and not a flood, and do not omit a well-grounded one merely because it cannot be auto-applied. Never manufacture issues to meet a quota.
- Coverage target, not a quota: a multi-view full dashboard will often support 8–15 distinct formative observations spanning tiles, cross-view relationships, dashboard framing, analytical context, and design-process/workflow. Count a shared fix that applies to several tiles as ONE observation (one consolidated critique), not one per tile. Return fewer only when the supplied artifact and context genuinely do not support more.
- Full review may return up to 20 critiques. Focused or selected-region review may return up to 8.
- A critique must cite at least one supported grounding label, and — for any fix that touches a dashboard component — at least one valid evidenceRef. A guidance-only process/workflow or reflective uncatalogued critique may rest on "general design principle" alone with no artifact evidenceRef; an uncatalogued component fix still requires artifact evidence.
- Executable proposal references must exactly match supplied tiles and fields.
- Severity and relevance to an explicit focused or selected-region request are separate.
- The "strengths" array is SEPARATE and SECONDARY. Complete issue diagnosis and critique coverage first. Then emit only standout strengths that tell the author what must be preserved during iteration; ordinary correctness, mere presence of a component, or a positive restatement of an issue is not a strength card. A strength never substitutes for an evidence-grounded issue on the same scope. Cite evidence exactly as a critique does. Keep at most one non-overlapping strength per object/evidence location, with a concise title and one concrete artifact-specific detail. Returning no strengths is normal; when a focused scope genuinely has no fault, a grounded strength remains the honest feedback floor.

Supported executable operations are add-cross-filter, add-tooltip, wire-filter-control, add-kpis, recompose-kpis, v2-palette, preserve-brand-palette, dashboard-title, chart-subtitles, edit-layout (move/resize whole tiles on the board), and the general edit-spec (set/remove edits on one tile spec). A fix is guidance-only ({"kind":"manual","mode":"guidance_only"}) when it does not change a dashboard component — "design process" / workflow / meta advice, or an uncatalogued reflection — and such guidance is a legitimate part of a complete review. Conversely, every fix that DOES touch the JSON or board layout uses an executable kind whether or not it has an exact empirical recommendation leaf; edit-spec is the catch-all for spec changes and edit-layout for tile placement.

Prompt version: ${REVIEW_PROMPT_VERSION}`;

export function dashboardReviewUser(
  snapshot: ContextSnapshot,
  packet: EvidencePacket,
  grounding: GroundingAvailability,
  region?: LocalCritiqueRegion,
  focus?: FocusedReviewRequest,
  savedRationales: SavedCritiqueRationale[] = [],
  iterationContext?: IterationContext,
): string {
  // Feedback Scope (context.scope) is the set of review dimensions the author
  // checked in the brief. It already rides in the snapshot JSON but is inert
  // unless the author NARROWED it (chose a proper subset of the branches) — a
  // deliberate "I want feedback here" signal. When narrowed, name the selection
  // under REQUEST SCOPE so the model must return content for each chosen scope
  // (see the explicitly-chosen-scope rule in DASHBOARD_REVIEW_SYSTEM). The
  // default (every branch checked) stays an ordinary full review.
  const selectedScopes = Array.isArray(snapshot.values.scope)
    ? snapshot.values.scope.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  const hasCustomScope = selectedScopes.some((scope) => scope.startsWith("custom:"));
  const scopeIsNarrowed =
    selectedScopes.length > 0 &&
    (hasCustomScope || RECOMMENDATION_BRANCHES.some((branch) => !selectedScopes.includes(branch)));
  const requestScope = region
    ? {
        kind: "selected-region",
        bounds: region.bounds,
        request: region.request,
        object: region.dimension || null,
        permittedTileIds: Object.keys(packet.specMap),
      }
    : focus
      ? { kind: "focused", request: focus.request }
      : scopeIsNarrowed
        ? { kind: "full", authorSelectedScopes: selectedScopes }
        : { kind: "full" };
  const contextEvidenceAddresses = ["goal", "audience", "constraints", "notes", "customTypes"]
    .map((field) => ({
      source: "context",
      path: `context.${field}`,
      value: snapshot.values[field as keyof typeof snapshot.values],
      status: field in snapshot.fieldStatus
        ? snapshot.fieldStatus[field as keyof typeof snapshot.fieldStatus]
        : "confirmed",
    }))
    .filter((item) => item.value !== undefined && item.value !== "" && (!Array.isArray(item.value) || item.value.length));
  const boardEvidenceAddresses = [
    { source: "dashboard", path: "board.title", value: packet.board.title },
    { source: "dashboard", path: "board.subtitle", value: packet.board.subtitle },
    { source: "dashboard", path: "board.typography", value: packet.board.typography },
    { source: "dashboard", path: "board.hasKpis", value: packet.board.hasKpis },
    { source: "dashboard", path: "board.hasEmbeddedKpis", value: packet.board.hasEmbeddedKpis },
    { source: "dashboard", path: "board.filters", value: packet.board.filters },
    { source: "dashboard", path: "board.tiles", value: packet.board.tiles },
  ];
  return [
    `REQUEST SCOPE:\n${JSON.stringify(requestScope, null, 2)}`,
    `DASHBOARD GENRE LENS (adjusts how strictly you weigh each dimension; it is NOT grounding evidence — never cite it as a basis and never invent a defect just to match it):\n${dashboardTypeGuidance(snapshot.values.dashboardType)}`,
    `CONTEXT SNAPSHOT ${snapshot.id}:\n${JSON.stringify(snapshot, null, 2)}`,
    `CANONICAL CONTEXT EVIDENCE ADDRESSES (copy these paths exactly):\n${JSON.stringify(contextEvidenceAddresses, null, 2)}`,
    `AUTHOR-SAVED CRITIQUE RATIONALES:\n${JSON.stringify(savedRationalesForPrompt(savedRationales), null, 2)}
Only userRationale is author-authored context. The nested critique snapshot explains what the author was responding to; never treat its issue, rationale, suggestion, evidence, or catalog codes as author claims or independent grounding evidence. Each userRationale is also present in context.notes as "Saved design rationale: ..."; cite context.notes when it supports a claim.`,
    `CUMULATIVE ITERATION TRAJECTORY:\n${JSON.stringify(iterationContext || {
      round: 1,
      dashboardVersion: 1,
      applied: [],
      rejectedSignatures: [],
      changedTargets: [],
    }, null, 2)}
This block is design-history metadata, NOT grounding evidence. Do not cite it. Never repeat an applied or rejected proposal signature. On later rounds, preserve successful changes while moving to unresolved issues and materially different solution directions. As the round increases, prefer a larger structural step—hierarchy, KPI composition, coordinated chart composition, or board layout—when the current artifact evidence supports it and the deterministic safety gates can execute it.`,
    `GROUNDING AVAILABILITY (which grounding labels the current context can support):\n${JSON.stringify({
      available: grounding.available,
      missing: grounding.missing,
      missingContext: grounding.missingContext,
    }, null, 2)}`,
    `DETECTOR EVIDENCE HELPERS:\n${JSON.stringify(packet.detectorEvidence, null, 2)}`,
    `CANONICAL BOARD EVIDENCE ADDRESSES (copy these paths exactly):\n${JSON.stringify(boardEvidenceAddresses, null, 2)}`,
    `DASHBOARD BOARD FACTS:\n${JSON.stringify(packet.board, null, 2)}`,
    `INTERACTION STATE:\n${JSON.stringify(packet.interactionState, null, 2)}`,
    `VEGA-LITE SPECS BY EXACT TILE ID (cite paths as tile.<tile-id>.<property>):\n${JSON.stringify(packet.specMap, null, 2)}`,
    "Diagnose each object the evidence supports, then prescribe a recommendation leaf for the issues worth showing. Inspect every permitted tile, cross-tile relationship, and dashboard-level element. Return only the JSON object.",
  ].join("\n\n");
}

/** Second-pass coverage directive. A full review's first pass reliably finds the
 * most salient handful of issues, then stops well short of the 8–15 a rich
 * multi-view dashboard supports — the count is generation-bound, not gate-bound.
 * This directive is appended to the SAME evidence-bearing user message for a
 * second discovery call: it shows what pass one already covered and asks for
 * genuinely ADDITIONAL, distinct, grounded, executable issues, biased toward the
 * structural changes a first pass under-weights. The same grounding, evidence,
 * sanitize, and compile gates apply, so this widens honest coverage without
 * lowering the bar; an empty return is correct when nothing more is warranted. */
export function secondPassDirective(
  covered: Array<{ object: string; tileId: string | null; dimension: string; title: string }>,
): string {
  return [
    "SECOND-PASS COVERAGE EXPANSION — this is a follow-up discovery call on the SAME dashboard.",
    "A first reviewer already produced the critiques listed below (object · tile · dimension · title). Do NOT repeat any of them, and do NOT restate the same fix on the same target:",
    JSON.stringify(covered, null, 2),
    [
      "Return ADDITIONAL, genuinely distinct, evidence-grounded critiques this dashboard still warrants — the ones a first pass typically leaves on the table. Prioritize executable STRUCTURAL changes over additive chrome:",
      "- chart-form / encoding transformations (mark type, aggregation, binning, sort, dual-encoding, layering) via edit-spec, including the two-step derive-then-encode route;",
      "- cross-view coordination and consistency across tiles (shared scales, aligned axes, coordinated color, linked filtering);",
      "- visual hierarchy and board layout (edit-layout / composition) when emphasis or reading order is wrong;",
      "- axis / scale / label / number-format precision, legend placement, and color semantics;",
      "- accessibility (contrast, color-encoding redundancy, text size) when the evidence shows it.",
      "Favor the transform this SPECIFIC board's charts and fields make possible — name the actual tile, mark, field, or scale you are changing. A move that would read the same on any dashboard (blanket \"unify the typography\", a generic \"add source / metadata context\") is the LOWEST priority and is warranted only when you cite the exact inconsistency or missing element in this artifact; otherwise spend the slot on a board-specific structural change instead.",
      "Hold the IDENTICAL evidence, grounding, and executable-proposal bar as the first pass — every fix cites real fields and passes the safety gates. Prefer transforming or consolidating an existing component over adding a duplicate subtitle/KPI/legend layer. If the artifact genuinely supports no further grounded issue, return an empty critiques array rather than padding with filler or restating covered items. Return only the JSON object in the same shape.",
    ].join("\n"),
  ].join("\n\n");
}

/** Legacy detector-phrasing prompt retained for network-free detector/apply
 * fixtures. It is no longer called by the user-facing generation engine. */
export const CRITIQUE_SYSTEM = `You are a data-visualization critique writer for a dashboard review tool.
You are given a structured finding produced from the submitted artifact. Phrase only that finding; do not invent facts, change its kind, or claim it is already fixed.
Return ONLY {"title":"...","issue":"...","rationale":"...","evidence":"...","suggestion":"..."}.`;

export function critiqueUser(finding: Finding, context: DashboardContext): string {
  return [
    "DASHBOARD CONTEXT:",
    JSON.stringify(context, null, 2),
    "STRUCTURED FINDING:",
    JSON.stringify({
      kind: finding.kind,
      interactionKind: finding.interactionKind,
      severity: finding.severity,
      evidence: finding.evidence,
      target: finding.target,
    }, null, 2),
    "Phrase this finding and return only JSON.",
  ].join("\n\n");
}
