import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCAFFOLD_SYSTEM,
  buildScaffold,
  templateScaffold,
  validateScaffold,
} from "../src/scaffold.ts";
import { StubClient } from "./helpers.ts";

test("offline scaffold extracts useful context and flags missing fields", async () => {
  const result = await buildScaffold({ rawText: "For PMO leaders. They need to spot delivery risks. Must keep the navy brand and work on a wall display." });
  assert.equal(result.source, "template");
  assert.match(result.context.goal, /spot delivery risks/i);
  assert.match(result.context.audience, /PMO leaders/i);
  assert.ok(result.context.scope.includes("accessibility"));
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.fieldStatus.goal, "confirmed");
  assert.match(result.contextSnapshotId, /^ctx-/);
});

test("offline scaffold leaves unknown context blank instead of inventing generic users or goals", () => {
  const result = templateScaffold({ dashboard: { title: "Delivery health" } });
  assert.equal(result.context.goal, "");
  assert.equal(result.context.audience, "");
  assert.equal(result.context.constraints, "");
  assert.equal(result.fieldStatus.goal, "missing");
});

test("LLM scaffold returns validated structured context", async () => {
  const client = new StubClient({
    goal: "Decide which projects need intervention before planning.",
    audience: "PMO and engineering leads.",
    constraints: "Keep navy and support a wall display.",
    scope: ["visual", "interaction", "not-a-scope"],
    assumptions: ["Data literacy was not stated."],
    missingFields: [],
  });
  const result = await buildScaffold({ rawText: "rough notes" }, client);
  assert.equal(result.source, "llm");
  assert.deepEqual(result.context.scope, [
    "chart", "color", "layout", "data", "text", "visual design",
    "cognition", "context", "interaction", "task", "design process", "accessibility",
  ]);
  assert.equal(result.assumptions.length, 1);
  assert.equal(result.fieldStatus.goal, "inferred");
});

test("invalid model fields fall back without accepting arbitrary scopes", () => {
  const fallback = templateScaffold({ dashboard: { title: "Delivery health" } });
  const result = validateScaffold({ goal: "", scope: ["admin", "data"] }, fallback);
  assert.equal(result.context.goal, fallback.context.goal);
  assert.deepEqual(result.context.scope, [
    "chart", "color", "layout", "data", "text", "visual design",
    "cognition", "context", "interaction", "task", "design process", "accessibility",
  ]);
});

test("missing constraints stay blank instead of exposing model assumptions", () => {
  const fallback = templateScaffold({ dashboard: { title: "Delivery health" } });
  const result = validateScaffold({
    goal: "Monitor delivery health.",
    audience: "Project leads.",
    constraints: "Web delivery assumed.",
    scope: ["visual"],
    missingFields: ["constraints"],
  }, fallback);
  assert.equal(result.context.constraints, "");
  assert.ok(result.missingFields.includes("constraints"));
});

test("pre-extracted goal and audience stay concise", () => {
  const fallback = templateScaffold({ dashboard: { title: "Delivery health" } });
  const result = validateScaffold({
    goal: "Help delivery leaders compare project risk, velocity, staffing, deadlines, dependencies, milestones, and team performance across every portfolio before making weekly intervention decisions. This second sentence is unnecessary.",
    audience: "Portfolio management office leaders and engineering managers who review delivery status in weekly planning meetings and need a shared summary before deciding where to intervene.",
    scope: ["visual"],
    missingFields: ["constraints"],
  }, fallback);
  assert.ok((result.context.goal || "").length <= 180);
  assert.ok((result.context.audience || "").length <= 180);
});

test("pre-extraction asks for concise but analytically useful goal and audience context", () => {
  assert.match(SCAFFOLD_SYSTEM, /goal: one concise sentence \(25 words maximum\)/);
  assert.match(SCAFFOLD_SYSTEM, /central comparison or pattern/);
  assert.match(SCAFFOLD_SYSTEM, /audience: one concise phrase or sentence \(20 words maximum\)/);
  assert.match(SCAFFOLD_SYSTEM, /likely user role and how they would use the dashboard/);
  assert.match(SCAFFOLD_SYSTEM, /Prefer concrete analytical language/);
});

test("pre-extracted context preserves common abbreviations", () => {
  const fallback = templateScaffold({ dashboard: { title: "Regional sales" } });
  const result = validateScaffold({
    goal: "Help leaders compare Q1 vs. Q2 revenue across regions.",
    audience: "Regional sales managers in the U.S. and EMEA.",
    missingFields: ["constraints"],
  }, fallback);
  assert.equal(result.context.goal, "Help leaders compare Q1 vs. Q2 revenue across regions.");
  assert.equal(result.context.audience, "Regional sales managers in the U.S. and EMEA.");
});

test("required LLM mode never disguises an offline template as model output", async () => {
  await assert.rejects(
    () => buildScaffold({ mode: "dashboard-draft", requireLLM: true }),
    /LLM_REQUIRED/,
  );
});

test("offline scaffold defaults dashboard genre to analytical and reads a named genre", () => {
  assert.equal(templateScaffold({}).context.dashboardType, "analytical");
  assert.equal(
    templateScaffold({ rawText: "An infographic that tells the story of our year." }).context.dashboardType,
    "infographic",
  );
  assert.equal(
    templateScaffold({ rawText: "Operational monitoring with real-time alerts." }).context.dashboardType,
    "operational",
  );
});

test("LLM scaffold accepts a valid genre and falls back for an invalid one", () => {
  const fallback = templateScaffold({});
  assert.equal(
    validateScaffold({ goal: "g", dashboardType: "executive", missingFields: [] }, fallback).context.dashboardType,
    "executive",
  );
  assert.equal(
    validateScaffold({ goal: "g", dashboardType: "not-a-genre", missingFields: [] }, fallback).context.dashboardType,
    fallback.context.dashboardType,
  );
});

test("scaffold system prompt enumerates the four dashboard genres", () => {
  assert.match(SCAFFOLD_SYSTEM, /"analytical", "operational", "infographic", "executive"/);
});
