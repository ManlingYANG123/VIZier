// The workspace "Dashboard context" field is one editable text box holding a
// single natural-language description of what the dashboard is for and who uses
// it — no "Goal:" / "Audience:" labels. This module is the seam between that box
// text and state.context: serialize renders the description into the box, parse
// reads the box back. The whole description is stored in state.context.goal (the
// field the review engine already consumes); audience/constraints are no longer
// split out here, so parse clears them.

export const CONTEXT_BOX_FIELDS = [
  {
    key: "goal",
    label: "Context",
    hint: "What the dashboard is for and who uses it.",
  },
];

export const CONTEXT_BOX_PLACEHOLDER =
  "Describe what this dashboard is for and who uses it — e.g. “Helps the " +
  "PMO track task velocity against targets so delivery leads can spot at-risk " +
  "teams and rebalance work.”";

/**
 * Render state.context into the box as one description. The single field is
 * `goal`; any legacy audience/constraints text (e.g. carried in from the
 * onboarding form) is folded into the same paragraph so the box always reads as
 * one natural-language description.
 */
export function serializeContextBox(context = {}) {
  return [context.goal, context.audience, context.constraints]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Parse the box text back into state fields. The box is now a single free-text
 * description, so the whole thing becomes the goal and the other two fields are
 * cleared — the review consumes this description as the dashboard context.
 */
export function parseContextBox(text) {
  return { goal: String(text || "").trim(), audience: "", constraints: "" };
}
