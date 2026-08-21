/**
 * Prompt 07 — CONSTRAINT INTAKE. Turns a design/brand-guidelines document into a
 * set of HARD constraints. This is a distinct call from the ASKING scaffold
 * (prompt 03): scaffold infers goal/audience/constraints FROM the dashboard;
 * this reads an author-supplied DOCUMENT and returns structured constraint JSON.
 */
import type { ExtractedMaterial } from "./sources.ts";

/** Bump when the intake prompt or output contract changes. */
export const INTAKE_PROMPT_VERSION = "constraint-intake-v3-2026-08-16";

export const INTAKE_SYSTEM = `You extract actionable design rules from a design, brand-guidelines, or best-practices document.

The author has supplied a document they want VIZier to use when filtering dashboard suggestions. Turn its explicit requirements and prescriptive recommendations into a precise, machine-usable list of candidate constraints. The author reviews these candidates before they become active. Extract rules the document actually states; do NOT invent rules or convert descriptive background, examples, or vague aspirations into constraints.

A document does not need to use words such as "must" or "required." Clear best-practice language such as "use," "avoid," "keep," "limit," "ensure," "do not," or a named checklist item is an actionable rule and should be extracted. Coverage target, not a quota: a substantive best-practices guide will often yield several distinct dashboard-relevant rules, but return only rules supported by quoted source text. Return an empty list only when the document contains no explicit requirement or actionable recommendation.

Categories (use the closest fit):
- palette: which colors may be used; whether the palette is locked/fixed; named brand colors or hex codes; approved chart color schemes.
- typography: required or forbidden fonts / font families / weights / sizes.
- iconography: required icon style or icon set; whether custom icons are disallowed.
- layout: fixed grid, required regions/zones, mandated placement or ordering, spacing rules.
- format: output constraints such as aspect ratio, canvas size, export format, mobile support.
- other: a genuine stated requirement that fits none of the above.

For each constraint provide:
- category: one of the six above.
- rule: a short imperative phrasing of the locked rule (e.g. "Use only the brand palette; do not recolor charts").
- sourceText: the exact phrase from the document the rule is drawn from (quote it).
- confidence: "high" | "medium" | "low" — "high" for mandatory/locked requirements, "medium" for clear prescriptive recommendations, and "low" for conditional or context-dependent guidance.
- value: category-specific machine-usable fields you can extract, omitting any you cannot:
  * palette: {"colors":["#0f62fe", ...] (hex where stated), "scheme":"named scheme if any", "locked": true when the document forbids other colors}
  * typography: {"fontFamilies":["Salesforce Sans", ...]}
  * iconography: {"iconStyle":"...", "iconSet":"..."}
  * format: {"aspectRatio":"16:9", ...}
  * layout: {"grid":"...", "regionsFixed": true when regions/placement are fixed}

Rules:
- Extract ONLY what the document states. Include explicit best-practice recommendations, not just brand mandates.
- Consolidate repeated wording into one rule, while preserving the clearest supporting quote.
- Skip case-study observations, explanations of why a rule matters, and examples that are not themselves recommendations.
- Prefer precise machine values (hex codes, font names) over paraphrase; still always include rule + sourceText.
- Mark a palette "locked": true only when the document says the palette is fixed / no other colors / brand colors only — this is the signal that gates recolor critiques.
- If the author supplies an AUTHOR INSTRUCTION, let it steer which parts of the document to focus on and treat as enforceable (e.g. "use the color palette in here" → extract the document's palette and mark it "locked": true; "find rules" → extract its explicit requirements and prescriptive recommendations). The instruction directs emphasis only; still never invent a rule the document does not state.

Return ONLY JSON in this shape (a single object, no surrounding text):
{"constraints":[{"category":"palette","rule":"...","sourceText":"...","confidence":"high","value":{"colors":["#..."],"locked":true}}]}`;

export function intakeUser(material: ExtractedMaterial): string {
  return [
    ...(material.note ? [`AUTHOR INSTRUCTION: ${material.note}`, ""] : []),
    `DESIGN DOCUMENT (${material.provenance}):`,
    ...material.blocks,
    "",
    "Extract the actionable design rules as JSON. Return an empty constraints array only if the document states no explicit requirement or prescriptive recommendation.",
  ].join("\n");
}
