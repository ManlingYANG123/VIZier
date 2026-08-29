/**
 * Constraint intake module — adapters, normalization, and the buildConstraintSet
 * entry point. The generation path is never touched here; this is the isolated
 * input-processing module (design source → normalized ConstraintSet JSON).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor, IntakeUnsupportedError } from "../src/intake/sources.ts";
import { INTAKE_SYSTEM, intakeUser } from "../src/intake/prompt.ts";
import { normalizeConstraintSet, emptyConstraintSet } from "../src/intake/normalize.ts";
import {
  buildConstraintSet,
  clearConstraintIntakeCache,
  INTAKE_MAX_OUTPUT_TOKENS,
} from "../src/intake/index.ts";
import { SequenceClient, StubClient } from "./helpers.ts";

test("raw-text adapter yields text-only material", async () => {
  const material = await adapterFor("raw-text").extract({ kind: "raw-text", text: "  Use brand blue.\r\n" });
  assert.equal(material.provenance, "pasted design notes");
  assert.deepEqual(material.blocks, ["Use brand blue."]);
});

test("pdf-text adapter records filename and page count in provenance", async () => {
  const material = await adapterFor("pdf-text").extract({
    kind: "pdf-text",
    text: "Brand palette: #0A2540.",
    filename: "brand-guide.pdf",
    pageCount: 12,
  });
  assert.equal(material.provenance, "brand-guide.pdf · 12 page(s)");
  assert.deepEqual(material.blocks, ["Brand palette: #0A2540."]);
});

test("an author note rides through the adapter and steers the prompt", async () => {
  const material = await adapterFor("pdf-text").extract({
    kind: "pdf-text",
    text: "Palette: #0A2540, #00A1E0.",
    filename: "brand.pdf",
    pageCount: 4,
    note: "  use the color palette in here  ",
  });
  assert.equal(material.note, "use the color palette in here", "note is trimmed and carried");
  const user = intakeUser(material);
  assert.match(user, /AUTHOR INSTRUCTION: use the color palette in here/);
  // No note → no AUTHOR INSTRUCTION line (byte-identical to the original prompt).
  const bare = await adapterFor("pdf-text").extract({ kind: "pdf-text", text: "x", filename: "b.pdf", pageCount: 1 });
  assert.equal(bare.note, undefined);
  assert.doesNotMatch(intakeUser(bare), /AUTHOR INSTRUCTION/);
});

test("best-practices documents yield explicit recommendations as candidate rules", async () => {
  assert.match(INTAKE_SYSTEM, /prescriptive recommendations/);
  assert.match(INTAKE_SYSTEM, /Coverage target, not a quota/);
  const client = new StubClient({
    constraints: [{
      category: "layout",
      rule: "Use no more than four views",
      sourceText: "Use no more than four views.",
      confidence: "medium",
    }],
  });
  const result = await buildConstraintSet({
    kind: "pdf-text",
    text: "Use no more than four views. Avoid decorative chart elements.",
    filename: "dashboard-best-practices.pdf",
    pageCount: 10,
    note: "find rules",
  }, client, { requireLLM: true });
  assert.equal(result.constraintSet.constraints.length, 1);
  assert.equal(result.constraintSet.constraints[0].category, "layout");
  assert.equal(result.constraintSet.constraints[0].rule, "Use no more than four views");
  assert.match(client.userTexts[0], /AUTHOR INSTRUCTION: find rules/);
  assert.match(client.userTexts[0], /Avoid decorative chart elements/);
});

test("url and image adapters are declared but not implemented yet", async () => {
  await assert.rejects(() => adapterFor("url").extract({ kind: "url", url: "https://x" }), IntakeUnsupportedError);
  await assert.rejects(
    () => adapterFor("image").extract({ kind: "image", dataUrl: "data:," }),
    IntakeUnsupportedError,
  );
});

test("normalizeConstraintSet coerces categories and machine values", () => {
  const set = normalizeConstraintSet(
    {
      constraints: [
        { category: "palette", rule: "Brand only", sourceText: "Use brand colors", confidence: "high", value: { colors: ["#000"], locked: true } },
        { category: "not-a-real-category", rule: "Weird", sourceText: "?", confidence: "banana" },
        { rule: "", sourceText: "" }, // dropped: no rule and no sourceText
      ],
    },
    "pdf-text",
    "brand.pdf",
  );
  assert.equal(set.constraints.length, 2);
  assert.equal(set.constraints[0].category, "palette");
  assert.equal(set.constraints[0].value?.locked, true);
  assert.equal(set.constraints[1].category, "other", "unknown category collapses to other");
  assert.equal(set.constraints[1].confidence, "medium", "invalid confidence defaults to medium");
  assert.match(set.id, /^ct-[0-9a-f]{12}$/);
  assert.match(set.constraints[0].id, /^hc-1-[0-9a-f]{8}$/);
});

test("the content-hash id is stable for identical input", () => {
  const raw = { constraints: [{ category: "palette", rule: "Brand only", sourceText: "brand", confidence: "high" }] };
  const a = normalizeConstraintSet(raw, "pdf-text", "brand.pdf");
  const b = normalizeConstraintSet(raw, "pdf-text", "brand.pdf");
  assert.equal(a.id, b.id);
  assert.equal(a.constraints[0].id, b.constraints[0].id);
});

test("identical design material reuses one exact extracted rule set", async () => {
  clearConstraintIntakeCache();
  const client = new SequenceClient([
    { constraints: [{ category: "layout", rule: "Keep one focal point", sourceText: "Keep one focal point.", confidence: "medium" }] },
    { constraints: [
      { category: "layout", rule: "Keep one focal point", sourceText: "Keep one focal point.", confidence: "medium" },
      { category: "other", rule: "A second unstable rule", sourceText: "Second.", confidence: "low" },
    ] },
  ]);
  const source = { kind: "pdf-text" as const, text: "Keep one focal point.", filename: "stable.pdf", pageCount: 1 };
  const first = await buildConstraintSet(source, client, { requireLLM: true });
  const second = await buildConstraintSet(source, client, { requireLLM: true });
  assert.equal(first.source, "llm");
  assert.equal(second.source, "cache");
  assert.deepEqual(second.constraintSet, first.constraintSet);
  assert.equal(client.userTexts.length, 1, "the same document is not generated twice");
});

test("harmless PDF whitespace differences share the stable extraction cache", async () => {
  clearConstraintIntakeCache();
  const client = new StubClient({
    constraints: [{ category: "typography", rule: "Use the brand font", sourceText: "Use the brand font.", confidence: "high" }],
  });
  const common = { kind: "pdf-text" as const, filename: "spacing.pdf", pageCount: 2 };
  const first = await buildConstraintSet({ ...common, text: "Use  the brand font.\nPage two." }, client);
  const second = await buildConstraintSet({ ...common, text: "Use the brand font.   Page two." }, client);
  assert.equal(second.source, "cache");
  assert.deepEqual(second.constraintSet, first.constraintSet);
  assert.equal(client.userTexts.length, 1);
});

test("changing the author's extraction note intentionally creates a new rule set", async () => {
  clearConstraintIntakeCache();
  const client = new StubClient({ constraints: [] });
  const common = { kind: "raw-text" as const, text: "Use blue. Keep labels short." };
  await buildConstraintSet({ ...common, note: "find palette rules" }, client);
  await buildConstraintSet({ ...common, note: "find typography rules" }, client);
  assert.equal(client.userTexts.length, 2);
});

test("the content-addressed rule cache survives an API-process restart", async () => {
  clearConstraintIntakeCache();
  const directory = await mkdtemp(join(tmpdir(), "vizier-intake-test-"));
  const cacheFile = join(directory, "cache.json");
  const source = { kind: "pdf-text" as const, text: "Use a 12-column grid.", filename: "durable.pdf", pageCount: 1 };
  try {
    const firstClient = new StubClient({
      constraints: [{ category: "layout", rule: "Use a 12-column grid", sourceText: "Use a 12-column grid.", confidence: "high" }],
    });
    const first = await buildConstraintSet(source, firstClient, {
      cacheFile,
      cacheNamespace: "openai/test/reasoning=low",
    });
    clearConstraintIntakeCache(); // simulate a new Node process
    const changedClient = new StubClient({
      constraints: [{ category: "other", rule: "Unstable replacement", sourceText: "replacement", confidence: "low" }],
    });
    const second = await buildConstraintSet(source, changedClient, {
      cacheFile,
      cacheNamespace: "openai/test/reasoning=low",
    });
    assert.equal(first.source, "llm");
    assert.equal(second.source, "cache");
    assert.deepEqual(second.constraintSet, first.constraintSet);
    assert.equal(changedClient.userTexts.length, 0, "cold memory cache still avoids a new model call");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizeConstraintSet caps runaway model output at 40 constraints", () => {
  const constraints = Array.from({ length: 60 }, (_, i) => ({
    category: "layout",
    rule: `rule ${i}`,
    sourceText: `text ${i}`,
    confidence: "low",
  }));
  const set = normalizeConstraintSet({ constraints }, "raw-text", "notes");
  assert.equal(set.constraints.length, 40);
});

test("empty material short-circuits to an empty set with no model call", async () => {
  const client = new StubClient({ constraints: [{ category: "palette", rule: "x", sourceText: "x", confidence: "high" }] });
  const result = await buildConstraintSet({ kind: "raw-text", text: "   " }, client, {});
  assert.equal(result.source, "empty");
  assert.deepEqual(result.constraintSet.constraints, []);
  assert.equal(client.userTexts.length, 0, "no model call for empty material");
});

test("requireLLM throws when no model is configured", async () => {
  await assert.rejects(
    () => buildConstraintSet({ kind: "raw-text", text: "Use brand blue." }, undefined, { requireLLM: true }),
    /LLM_REQUIRED/,
  );
});

test("buildConstraintSet with a stub client returns a normalized set", async () => {
  const client = new StubClient({
    constraints: [
      { category: "palette", rule: "Use brand palette", sourceText: "brand palette only", confidence: "high", value: { locked: true } },
    ],
  });
  const result = await buildConstraintSet(
    { kind: "pdf-text", text: "Brand palette only.", filename: "b.pdf", pageCount: 3 },
    client,
    {},
  );
  assert.equal(result.source, "llm");
  assert.equal(result.constraintSet.constraints.length, 1);
  assert.equal(result.constraintSet.constraints[0].category, "palette");
  assert.equal(result.constraintSet.provenance, "b.pdf · 3 page(s)");
  assert.equal(client.userTexts.length, 1);
  assert.equal(client.completeOptions[0]?.maxTokens, INTAKE_MAX_OUTPUT_TOKENS);
  assert.equal(INTAKE_MAX_OUTPUT_TOKENS, 8000);
});

test("emptyConstraintSet is well-formed", () => {
  const set = emptyConstraintSet("url", "https://x");
  assert.deepEqual(set.constraints, []);
  assert.equal(set.sourceKind, "url");
  assert.match(set.id, /^ct-[0-9a-f]{12}$/);
});
