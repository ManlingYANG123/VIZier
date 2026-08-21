import { test } from "node:test";
import assert from "node:assert/strict";
import type { InteractionEvent } from "../src/contracts.ts";
import {
  synthesizePreferences,
  validatePreferenceSuggestions,
} from "../src/preference.ts";
import { StubClient } from "./helpers.ts";

function event(
  id: string,
  kind: InteractionEvent["kind"],
  summary: string,
): InteractionEvent {
  return { id, kind, summary, version: 1 };
}

const repeatedDecisions = [
  event("event-1", "recommendation_rejected", "Rejected a palette change"),
  event("event-2", "recommendation_rejected", "Rejected another palette change"),
];

test("preference synthesis waits for repeated strong evidence", async () => {
  const result = await synthesizePreferences({
    dashboardId: "dashboard-1",
    context: {},
    events: [event("event-1", "critique_opened", "Opened a critique")],
  });
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.analyzedEventCount, 1);
});

test("valid model suggestions preserve evidence and dashboard scope", async () => {
  const client = new StubClient({
    suggestions: [{
      field: "constraints",
      text: "Preserve the current dashboard palette.",
      rationale: "The author rejected two palette changes.",
      evidenceEventIds: ["event-1", "event-2"],
      confidence: "supported",
    }],
  });
  const result = await synthesizePreferences({
    dashboardId: "dashboard-1",
    context: {},
    events: repeatedDecisions,
  }, client);

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].field, "constraints");
  assert.equal(result.suggestions[0].scope, "dashboard");
  assert.deepEqual(result.suggestions[0].evidenceEventIds, ["event-1", "event-2"]);
  // Two strong-signal events + "supported" confidence -> ranking weight 2.5.
  assert.equal(result.suggestions[0].signalStrength, 2.5);
});

test("suggestions without two known evidence events are rejected", () => {
  const suggestions = validatePreferenceSuggestions({
    suggestions: [{
      field: "constraints",
      text: "Preserve the current dashboard palette.",
      rationale: "A palette change was rejected.",
      evidenceEventIds: ["event-1", "unknown-event"],
      confidence: "supported",
    }],
  }, repeatedDecisions);

  assert.deepEqual(suggestions, []);
});

test("previously resolved suggestions are not repeated", () => {
  const suggestions = validatePreferenceSuggestions({
    suggestions: [{
      field: "constraints",
      text: "Preserve the current dashboard palette.",
      rationale: "The author rejected two palette changes.",
      evidenceEventIds: ["event-1", "event-2"],
      confidence: "supported",
    }],
  }, repeatedDecisions, ["Preserve the current dashboard palette."]);

  assert.deepEqual(suggestions, []);
});

test("learned context text is reduced to a short single statement", () => {
  const verbose = `${"Prefer simple labels with familiar terms ".repeat(8)}. Add another sentence that should not be retained.`;
  const suggestions = validatePreferenceSuggestions({
    suggestions: [{
      field: "audience",
      text: verbose,
      rationale: "Repeated decisions favored simpler language for the intended readers.",
      evidenceEventIds: ["event-1", "event-2"],
      confidence: "supported",
    }],
  }, repeatedDecisions);

  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].text.length <= 120);
  assert.equal(suggestions[0].text.includes("\n"), false);
});

test("suggestions are ranked by signal strength and capped to the top two", () => {
  const events: InteractionEvent[] = [
    event("event-1", "recommendation_rejected", "Rejected a palette change"),
    event("event-2", "recommendation_rejected", "Rejected another palette change"),
    event("event-3", "recommendation_accepted", "Accepted a layout change"),
    event("event-4", "context_saved", "Saved a goal statement"),
    event("event-5", "local_critique_requested", "Requested a local review"),
    event("event-6", "critique_rationale_added", "Added a rationale"),
  ];
  const suggestions = validatePreferenceSuggestions({
    suggestions: [
      { // 2 strong signals, tentative -> weight 2
        field: "constraints",
        text: "Keep the existing palette.",
        rationale: "Two palette changes were rejected.",
        evidenceEventIds: ["event-1", "event-2"],
        confidence: "tentative",
      },
      { // 4 strong signals, supported -> weight 4.5 (strongest)
        field: "goal",
        text: "Track sprint delivery against target.",
        rationale: "Repeated accept, save, and review actions reinforce this goal.",
        evidenceEventIds: ["event-3", "event-4", "event-5", "event-6"],
        confidence: "supported",
      },
      { // 3 strong signals, tentative -> weight 3 (middle, should be dropped)
        field: "audience",
        text: "Aimed at delivery leads.",
        rationale: "Rationale and review requests point to a delivery-lead reader.",
        evidenceEventIds: ["event-4", "event-5", "event-6"],
        confidence: "tentative",
      },
    ],
  }, events);

  assert.equal(suggestions.length, 2);
  assert.deepEqual(suggestions.map((s) => s.field), ["goal", "audience"]);
  assert.ok(suggestions[0].signalStrength > suggestions[1].signalStrength);
  assert.equal(suggestions[0].signalStrength, 4.5);
});

test("preference synthesis requires a configured model after strong evidence", async () => {
  await assert.rejects(
    () => synthesizePreferences({
      dashboardId: "dashboard-1",
      context: {},
      events: repeatedDecisions,
    }),
    /LLM_REQUIRED/,
  );
});
