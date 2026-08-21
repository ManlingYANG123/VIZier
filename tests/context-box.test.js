import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_BOX_FIELDS,
  CONTEXT_BOX_PLACEHOLDER,
  parseContextBox,
  serializeContextBox,
} from "../src/context-box.js";

test("serializeContextBox renders the description with no field labels", () => {
  assert.equal(
    serializeContextBox({ goal: "Spot weak stores each week for regional managers." }),
    "Spot weak stores each week for regional managers.",
  );
  assert.doesNotMatch(
    serializeContextBox({ goal: "Spot weak stores." }),
    /Goal:|Audience:|Constraints:/,
  );
});

test("serializeContextBox folds any legacy split fields into one paragraph", () => {
  // Context carried in from the onboarding form may still hold separate
  // audience/constraints; they join the same paragraph, without labels.
  assert.equal(
    serializeContextBox({ goal: "Spot weak stores.", audience: "Regional managers.", constraints: "Keep palette." }),
    "Spot weak stores. Regional managers. Keep palette.",
  );
});

test("serializeContextBox is empty when nothing is set", () => {
  assert.equal(serializeContextBox({}), "");
  assert.equal(serializeContextBox({ goal: "", audience: "  ", constraints: "" }), "");
  assert.equal(serializeContextBox(), "");
});

test("parseContextBox stores the whole box as the goal and clears the rest", () => {
  assert.deepEqual(
    parseContextBox("Helps the PMO track velocity so leads can rebalance work."),
    { goal: "Helps the PMO track velocity so leads can rebalance work.", audience: "", constraints: "" },
  );
});

test("parseContextBox keeps multi-line text intact (no label splitting)", () => {
  const text = "Line one\nline two\nline three";
  assert.deepEqual(parseContextBox(text), { goal: text, audience: "", constraints: "" });
});

test("parseContextBox does not treat 'Goal:'-style prefixes as structure", () => {
  // With the single-description model the box is free text: a leading label is
  // just part of the description, not a delimiter.
  assert.deepEqual(parseContextBox("Goal: do X"), {
    goal: "Goal: do X",
    audience: "",
    constraints: "",
  });
});

test("parse ∘ serialize round-trips a single description", () => {
  const context = { goal: "Help regional managers spot underperforming stores each week.", audience: "", constraints: "" };
  assert.deepEqual(parseContextBox(serializeContextBox(context)), context);
});

test("parseContextBox tolerates empty and whitespace input", () => {
  assert.deepEqual(parseContextBox(""), { goal: "", audience: "", constraints: "" });
  assert.deepEqual(parseContextBox(null), { goal: "", audience: "", constraints: "" });
  assert.deepEqual(parseContextBox("   \n  \n"), { goal: "", audience: "", constraints: "" });
});

test("the box is one description field with no labels in the placeholder", () => {
  assert.equal(CONTEXT_BOX_FIELDS.length, 1);
  assert.equal(CONTEXT_BOX_FIELDS[0].key, "goal");
  assert.doesNotMatch(CONTEXT_BOX_PLACEHOLDER, /Goal:|Audience:|Constraints:/);
  assert.ok(CONTEXT_BOX_PLACEHOLDER.trim().length > 0, "placeholder prompts for a description");
});
