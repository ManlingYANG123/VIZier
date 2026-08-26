import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readApp = () => readFile(new URL("../src/app.js", import.meta.url), "utf8");

test("Review Area sends rendered semantic targets instead of raw bounds alone", async () => {
  const source = await readApp();
  assert.match(source, /function semanticTargetsForRegion\(selection\)/);
  assert.match(source, /"dashboard-title", "board\.title"/);
  assert.match(source, /"dashboard-subtitle", "board\.subtitle"/);
  assert.match(source, /"filter-control", `board\.filters\.\$\{filter\.id\}`/);
  assert.match(source, /"axis", `tile\.\$\{tile\.id\}\.encoding`/);
  assert.match(source, /"legend", `tile\.\$\{tile\.id\}\.encoding`/);
  assert.match(source, /const semanticTargets = semanticTargetsForRegion\(bounds\)/);
  assert.match(source, /region: \{[\s\S]*?bounds,[\s\S]*?request,[\s\S]*?semanticTargets,/);
});

test("an unavailable executable preview is never replaced with an unchanged proposed dashboard", async () => {
  const source = await readApp();
  assert.match(source, /expectsLivePreview && !livePreview/);
  assert.match(source, /could not produce a verified proposed dashboard/);
  assert.match(source, /!descriptor\.previewFailure[\s\S]*?!critiqueIsExecutable\(critique\)/);
});
