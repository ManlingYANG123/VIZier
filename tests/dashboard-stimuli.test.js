import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashboard = (name) => JSON.parse(readFileSync(
  new URL(`../public/dashboards/v2/${name}`, import.meta.url),
  "utf8",
));

test("library dashboards retain distinct, evidence-visible critique opportunities", () => {
  const ocean = dashboard("ocean-life.json");
  assert.equal(ocean.dashboard.filters.some((filter) => filter.wired === false), true);
  assert.ok(new Set(ocean.tiles.map((tile) => tile.spec.config?.axis?.labelFont).filter(Boolean)).size > 1);
  assert.ok(ocean.tiles.find((tile) => tile.id === "species-comparison").bounds.w
    > ocean.tiles.find((tile) => tile.id === "depth-range").bounds.w);

  const command = dashboard("sales-command-center-new.json");
  const commandKpiFonts = command.tiles.slice(0, 3).map((tile) => tile.spec.config.font);
  assert.ok(new Set(commandKpiFonts).size > 1);
  assert.equal(command.tiles.find((tile) => tile.id === "revenue-trend").spec.encoding.tooltip, undefined);

  const birds = dashboard("garden-birds-new.json");
  assert.ok(birds.dashboard.filters[0].options.length
    < birds.tiles.find((tile) => tile.id === "birds-ranking").spec.data.values.length);
  assert.match(birds.tiles.find((tile) => tile.id === "did-you-know").subtitle, /declined sharply/i);
  assert.ok(new Set(birds.tiles.map((tile) => tile.spec.config?.font).filter(Boolean)).size > 1);

  const air = dashboard("air-quality-new.json");
  assert.match(air.dashboard.title, /Where You Live/);
  assert.match(air.tiles.find((tile) => tile.id === "days-by-category").label, /2024/);
  assert.match(JSON.stringify(air.tiles.find((tile) => tile.id === "takeaway").spec), /238 days in 2024/);
});

test("interaction and labeling defects remain executable critique seeds", () => {
  const performance = dashboard("workspace-performance v1.json");
  assert.equal(performance.tiles.find((tile) => tile.id === "task-velocity").spec.encoding.tooltip, undefined);
  const burndownTooltip = performance.tiles.find((tile) => tile.id === "sprint-burndown").spec.encoding.tooltip;
  assert.equal(burndownTooltip.find((item) => item.field === "week").title, "Month");

  const overview = dashboard("workspace-overview.json");
  assert.equal(overview.dashboard.title, "Workspace Overview");
  assert.equal(overview.tiles.find((tile) => tile.id === "task-velocity").spec.encoding.tooltip, undefined);

  const sales = dashboard("sales v1.json");
  const trend = sales.tiles.find((tile) => tile.id === "sales-profit-trends-over-time").spec;
  assert.doesNotMatch(JSON.stringify(trend), /"tooltip"/);
  assert.ok((JSON.stringify(sales).match(/"legend":null/g) || []).length >= 3);
});
