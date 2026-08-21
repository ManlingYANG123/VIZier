import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DASHBOARD_TYPES,
  dashboardTypeGuidance,
  dimensionEmphasis,
  isDashboardType,
  suppressedDetectorsFor,
} from "../src/generate/dashboard-type.ts";

test("the four dashboard genres are recognized and nothing else is", () => {
  assert.deepEqual([...DASHBOARD_TYPES], ["analytical", "operational", "infographic", "executive"]);
  for (const type of DASHBOARD_TYPES) assert.ok(isDashboardType(type));
  assert.equal(isDashboardType("nonsense"), false);
  assert.equal(isDashboardType(undefined), false);
});

test("analytical suppresses the takeaway/subtitle detectors, others do not", () => {
  const analytical = suppressedDetectorsFor("analytical");
  assert.ok(analytical.has("generic-title"));
  assert.ok(analytical.has("missing-subtitles"));
  assert.equal(suppressedDetectorsFor("operational").has("generic-title"), false);
  // An unknown/absent genre suppresses nothing.
  assert.equal(suppressedDetectorsFor(undefined).size, 0);
});

test("infographic suppresses interaction/self-service detector defaults", () => {
  const infographic = suppressedDetectorsFor("infographic");
  for (const kind of ["cross-filter-gap", "missing-tooltip", "ineffective-filter-control", "missing-kpi"]) {
    assert.ok(infographic.has(kind), `expected ${kind} suppressed for infographic`);
  }
});

test("dimension emphasis orders genre-relevant dimensions above peripheral ones", () => {
  // Analytical values interaction; text (takeaway pressure) is de-emphasized.
  assert.ok(dimensionEmphasis("analytical", "interaction") > dimensionEmphasis("analytical", "text"));
  // Infographic is the inverse: text over interaction.
  assert.ok(dimensionEmphasis("infographic", "text") > dimensionEmphasis("infographic", "interaction"));
  // Unknown genre is neutral everywhere.
  assert.equal(dimensionEmphasis(undefined, "text"), 0);
});

test("guidance prose is genre-specific and always resolves", () => {
  assert.match(dashboardTypeGuidance("analytical"), /analytical/i);
  assert.match(dashboardTypeGuidance("infographic"), /narrative|story/i);
  // Absent genre resolves to the permissive default rather than empty text.
  assert.ok(dashboardTypeGuidance(undefined).length > 0);
});
