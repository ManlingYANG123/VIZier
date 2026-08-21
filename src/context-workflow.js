export const CONTEXT_WORKFLOW_STATUS = Object.freeze({
  IDLE: "idle",
  GENERATING: "generating",
  NEEDS_REVIEW: "needs-review",
  CONFIRMED: "confirmed",
  ERROR: "error",
});

// Rotated one at a time while the workflow is in the GENERATING tone, so the
// extraction reads as active progress rather than one static caption.
export const CONTEXT_EXTRACTION_HINTS = Object.freeze([
  "Reading the dashboard layout",
  "Looking for a likely audience",
  "Drafting a goal statement",
]);

export function contextFingerprint(context = {}) {
  return JSON.stringify({
    goal: String(context.goal || "").trim(),
    audience: String(context.audience || "").trim(),
    constraints: String(context.constraints || "").trim(),
    scope: [...(context.scope || [])].map(String).sort(),
    customTypes: [...(context.customTypes || [])].map(String).sort(),
    notes: [...(context.notes || [])].map((item) => String(item).trim()).filter(Boolean).sort(),
  });
}

export function createContextWorkflow(status = CONTEXT_WORKFLOW_STATUS.IDLE, overrides = {}) {
  return {
    status,
    detail: "",
    error: "",
    reason: null,
    confirmedFingerprint: null,
    requestSerial: 0,
    ...overrides,
  };
}

export function contextIsConfirmed(workflow, context) {
  return workflow?.status === CONTEXT_WORKFLOW_STATUS.CONFIRMED &&
    workflow.confirmedFingerprint === contextFingerprint(context);
}

export function contextWorkflowPresentation(workflow, context = {}) {
  const hasContext = Boolean(
    String(context.goal || "").trim() ||
    String(context.audience || "").trim() ||
    String(context.constraints || "").trim(),
  );
  const reviewReason = workflow?.reason || "generated";
  switch (workflow?.status) {
    case CONTEXT_WORKFLOW_STATUS.GENERATING:
      return {
        tone: "generating",
        title: "Extracting Context",
        description: "",
        actionLabel: "Extracting…",
        actionDisabled: true,
        actionPrompt: "",
        actionHint: "",
      };
    case CONTEXT_WORKFLOW_STATUS.NEEDS_REVIEW:
      if (hasContext && reviewReason === "edited") {
        return {
          tone: "needs-review",
          title: "Context updated",
          description: workflow.detail || "Your edits are ready. Confirm them before starting the next review.",
          actionLabel: "Confirm Changes",
          actionDisabled: false,
          actionPrompt: "Use your updated context?",
          actionHint: "Critique generation stays paused until you confirm.",
        };
      }
      if (hasContext && reviewReason === "scope") {
        return {
          tone: "needs-review",
          title: "Review scope updated",
          description: workflow.detail || "Confirm which criteria the next review should cover.",
          actionLabel: "Confirm Changes",
          actionDisabled: false,
          actionPrompt: "Use this review scope?",
          actionHint: "Critique generation stays paused until you confirm.",
        };
      }
      return {
        tone: "needs-review",
        title: hasContext ? "Review Context" : "Choose how to continue",
        description: workflow.detail || (hasContext
          ? "Edit if needed, then confirm."
          : "No context was inferred. Add what you know, or continue with dashboard evidence only."),
        actionLabel: hasContext ? "Confirm Context" : "Continue Without Context",
        actionDisabled: false,
        actionPrompt: hasContext ? "Use this context for the review?" : "Continue without added context?",
        actionHint: hasContext
          ? "Critique generation starts only after you confirm."
          : "The review will use dashboard evidence only.",
      };
    case CONTEXT_WORKFLOW_STATUS.CONFIRMED:
      return {
        tone: "confirmed",
        title: "Context confirmed",
        description: "Saved to this dashboard’s review context.",
        actionLabel: "Context Confirmed",
        actionDisabled: true,
        actionPrompt: "",
        actionHint: "",
      };
    case CONTEXT_WORKFLOW_STATUS.ERROR:
      return {
        tone: "error",
        title: "Context could not be generated",
        description: workflow.error || "Retry the inference, enter context manually, or explicitly continue without it.",
        actionLabel: hasContext ? "Confirm Context" : "Continue Without Context",
        actionDisabled: false,
        actionPrompt: hasContext ? "Use the context entered here?" : "Continue without added context?",
        actionHint: hasContext
          ? "The review will use the current fields instead of an inferred context."
          : "The review will use dashboard evidence only.",
      };
    default:
      return {
        tone: "idle",
        title: "Context starts with a dashboard",
        description: "Add a dashboard and VIZier will describe its context for you to review.",
        actionLabel: "Waiting for Dashboard",
        actionDisabled: true,
        actionPrompt: "",
        actionHint: "",
      };
  }
}
