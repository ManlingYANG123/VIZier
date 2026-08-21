import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJson,
  extractOpenAITextDeltas,
  extractTextDeltas,
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
