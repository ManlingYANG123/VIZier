import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCrossFilterSlice,
  distinctValues,
  pinnedDomainMax,
} from "../src/compute/crossFilter.ts";
import { dashboardSpecMap } from "../fixtures/specs.ts";

test("cross-filter slice returns the real per-department rows", () => {
  const velocity = dashboardSpecMap()["task-velocity"];
  const slice = computeCrossFilterSlice(velocity, "department", "Eng");
  assert.equal(slice.rowsBefore, 35); // 5 departments x 7 months
  assert.equal(slice.rowsAfter, 7); // Eng x 7 months
  const first = (slice.spec.data as { values: Record<string, number>[] }).values[0];
  // Eng share 0.34: round(14*0.34)=5 completed, round(18*0.34)=6 target.
  assert.equal(first.completed, 5);
  assert.equal(first.target, 6);
});

test("line slice pins the y domain to the all-teams max (not the slice max)", () => {
  const velocity = dashboardSpecMap()["task-velocity"];
  const slice = computeCrossFilterSlice(velocity, "department", "Eng");
  assert.equal(slice.pinnedMax, pinnedDomainMax(velocity));
  assert.ok((slice.pinnedMax ?? 0) > 0);
  const yScale = ((slice.spec.encoding as Record<string, any>).y).scale;
  assert.deepEqual(yScale.domain, [0, Math.ceil((slice.pinnedMax ?? 0) * 1.05)]);
});

test("arc slice filters rows but does not pin a y domain", () => {
  const status = dashboardSpecMap()["project-status"];
  const slice = computeCrossFilterSlice(status, "department", "Eng");
  assert.equal(slice.rowsAfter, 4); // Eng has 4 status rows
  assert.equal(slice.pinnedMax, null);
});

test("distinctValues enumerates every department present in the data", () => {
  const velocity = dashboardSpecMap()["task-velocity"];
  assert.deepEqual(
    distinctValues(velocity, "department").sort(),
    ["Design", "Eng", "Ops", "QA", "Research"],
  );
});
