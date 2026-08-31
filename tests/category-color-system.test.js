import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_ORDER,
  CATEGORY_PRESENTATIONS,
  CLUSTERS,
  categoryPresentation,
  clusterForDimension,
  clusterPresentation,
  customScopeKey,
  customScopePresentation,
  feedbackScopeFiltersDimension,
  scopeMatchesDimension,
} from "../src/category-color-system.js";

test("standard critique categories use one shared presentation", () => {
  assert.equal(categoryPresentation("interaction"), CATEGORY_PRESENTATIONS.interaction);
  // "visual design" now inherits its cluster's (Visuals) blue hue.
  assert.equal(categoryPresentation("visual design").color, "#2f6bd8");
  assert.equal(categoryPresentation("layout").label, "Layout");
});

test("every branch in a cluster shares that cluster's hue but keeps its own label", () => {
  for (const cluster of CLUSTERS) {
    for (const branch of cluster.branches) {
      const presentation = categoryPresentation(branch);
      assert.equal(clusterForDimension(branch), cluster);
      assert.equal(presentation.color, cluster.color, `${branch} color`);
      assert.equal(presentation.soft, cluster.soft, `${branch} soft`);
      assert.equal(presentation.bar, cluster.bar, `${branch} bar`);
      assert.equal(presentation.cluster, cluster.key, `${branch} cluster key`);
    }
  }
  // Sibling branches in one cluster share a hue; their labels still differ.
  assert.equal(categoryPresentation("chart").color, categoryPresentation("layout").color);
  assert.notEqual(categoryPresentation("chart").label, categoryPresentation("layout").label);
  // Different clusters use different hues.
  assert.notEqual(categoryPresentation("chart").color, categoryPresentation("data").color);
});

test("clusterForDimension and clusterPresentation resolve real dimensions and reject others", () => {
  assert.equal(clusterForDimension("cognition").key, "clarity");
  assert.equal(clusterPresentation("clarity").label, "Clarity");
  assert.equal(clusterForDimension("nope"), null);
  assert.equal(clusterPresentation("nope"), null);
});

test("custom scopes receive a stable key and color", () => {
  assert.equal(customScopeKey("Brand consistency"), "custom:brand-consistency");
  assert.notEqual(customScopeKey("Visual hierarchy"), customScopeKey("Brand consistency"));
  assert.deepEqual(
    customScopePresentation("Brand consistency"),
    customScopePresentation("Brand consistency"),
  );
  assert.deepEqual(
    categoryPresentation("Brand consistency", ["Brand consistency"]),
    customScopePresentation("Brand consistency"),
  );
});

test("a checked custom scope can rank a matching critique dimension", () => {
  const customTypes = ["Brand consistency"];
  assert.equal(
    scopeMatchesDimension(["custom:brand-consistency"], "Brand consistency", customTypes),
    true,
  );
  assert.equal(
    scopeMatchesDimension(["custom:brand-consistency"], "other", customTypes),
    true,
  );
  assert.equal(scopeMatchesDimension([], "Brand consistency", customTypes), false);
});

test("an uncatalogued result keeps the single active custom scope label", () => {
  assert.equal(categoryPresentation("other", ["Visual Hierarchy"]).label, "Visual Hierarchy");
  assert.equal(categoryPresentation("other", ["Mobile", "Brand consistency"]).label, "Custom Scope");
});

test("a narrowed Feedback Scope strictly filters standard dimensions", () => {
  assert.equal(feedbackScopeFiltersDimension(["data", "context"], "data"), true);
  assert.equal(feedbackScopeFiltersDimension(["data", "context"], "chart"), false);
  assert.equal(feedbackScopeFiltersDimension(CATEGORY_ORDER, "chart"), true);
  // Clearing the draft selection must not erase already-visible results.
  assert.equal(feedbackScopeFiltersDimension([], "chart"), true);
});

test("a custom-only Feedback Scope admits uncatalogued custom feedback", () => {
  const scope = [customScopeKey("Mobile")];
  assert.equal(feedbackScopeFiltersDimension(scope, "other", ["Mobile"]), true);
  assert.equal(feedbackScopeFiltersDimension(scope, "chart", ["Mobile"]), false);
});
