import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenAIRequestBody,
  configuredGpt54ReasoningEffort,
  extractJson,
  extractOpenAITextDeltas,
  extractTextDeltas,
  GPT_5_4_REASONING_EFFORT,
  GPT_5_4_MIN_OUTPUT_TOKENS,
} from "../src/llm/client.ts";

const CANNED_SSE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"m1"}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  "",
  ": keep-alive",
  "",
  "event: message_stop",
  "data: [DONE]",
  "",
].join("\n");

test("extractTextDeltas pulls only text_delta tokens (and tolerates [DONE])", () => {
  assert.deepEqual(extractTextDeltas(CANNED_SSE), ["Hello", " world"]);
});

test("extractOpenAITextDeltas pulls Responses API output deltas", () => {
  const stream = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":" OpenAI"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"status":"completed"}}',
    "",
  ].join("\n");
  assert.deepEqual(extractOpenAITextDeltas(stream), ["Hello", " OpenAI"]);
});

test("extractOpenAITextDeltas reports output truncation", () => {
  let stopReason = "";
  extractOpenAITextDeltas(
    'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
    (reason) => {
      stopReason = reason;
    },
  );
  assert.equal(stopReason, "max_output_tokens");
});

test("GPT-5.4 requests use low reasoning and omit incompatible temperature", () => {
  const body = buildOpenAIRequestBody(
    "Review this dashboard",
    { system: "Be rigorous", maxTokens: 9000, temperature: 0.4 },
    "gpt-5.4",
    "low",
  );
  assert.equal(GPT_5_4_REASONING_EFFORT, "low");
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal("temperature" in body, false);
  assert.equal(body.max_output_tokens, 9000);
});

test("non-GPT-5.4 OpenAI requests preserve an explicitly supplied temperature", () => {
  const body = buildOpenAIRequestBody("Review this dashboard", { temperature: 0.4 }, "gpt-4o");
  assert.equal(body.temperature, 0.4);
  assert.equal("reasoning" in body, false);
});

test("GPT-5.4 low reasoning raises legacy output caps to a safe floor", () => {
  const body = buildOpenAIRequestBody("Extract constraints", { maxTokens: 1500 }, "gpt-5.4", "low");
  assert.equal(GPT_5_4_MIN_OUTPUT_TOKENS, 8000);
  assert.equal(body.max_output_tokens, 8000);
});

test("GPT-5.4 reasoning effort is configurable for matched evaluations", () => {
  assert.equal(configuredGpt54ReasoningEffort(" LOW "), "low");
  assert.equal(configuredGpt54ReasoningEffort("high"), "high");
  assert.equal(configuredGpt54ReasoningEffort("unsupported"), "low");
  const low = buildOpenAIRequestBody("Review", { temperature: 0.4 }, "gpt-5.4", "low");
  assert.deepEqual(low.reasoning, { effort: "low" });
  assert.equal("temperature" in low, false);
  const none = buildOpenAIRequestBody("Review", { temperature: 0.4 }, "gpt-5.4", "none");
  assert.deepEqual(none.reasoning, { effort: "none" });
  assert.equal(none.temperature, 0.4);
});

test("extractJson reads a fenced object", () => {
  const parsed = extractJson<{ a: number }>("prose ```json\n{\"a\": 1}\n``` trailing");
  assert.deepEqual(parsed, { a: 1 });
});

test("extractJson reads a bare object embedded in prose", () => {
  assert.deepEqual(extractJson('The answer is {"title":"x","n":2}. Thanks.'), { title: "x", n: 2 });
});

test("extractJson reads an array", () => {
  assert.deepEqual(extractJson("[1, 2, 3]"), [1, 2, 3]);
});

test("extractJson repairs trailing commas", () => {
  assert.deepEqual(extractJson('{"a": 1, "b": 2,}'), { a: 1, b: 2 });
});

test("extractJson returns null when there is no JSON", () => {
  assert.equal(extractJson("no json here"), null);
});
