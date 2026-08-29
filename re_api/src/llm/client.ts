/** Provider-neutral streaming client for OpenAI and the Anthropic-compatible
 * Salesforce Express LLM Gateway. */
import {
  baseUrl,
  loadToken,
  model as defaultModel,
  provider as defaultProvider,
  type LLMProvider,
} from "./gateway.ts";

export interface CompleteOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  /** Called with each streamed text delta as it arrives. */
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

/** GPT-5.4 uses deliberate reasoning for VIZier's multi-criteria dashboard
 * analysis. Sampling controls are incompatible with any non-none effort, so
 * the OpenAI request builder omits temperature for this model family. */
export const GPT_5_4_REASONING_EFFORT = "low" as const;
export type GPT54ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
const GPT_5_4_REASONING_EFFORTS = new Set<GPT54ReasoningEffort>([
  "none", "low", "medium", "high", "xhigh",
]);

export function configuredGpt54ReasoningEffort(
  configured = process.env.RE_API_REASONING_EFFORT,
): GPT54ReasoningEffort {
  const normalized = configured?.trim().toLowerCase() as GPT54ReasoningEffort | undefined;
  return normalized && GPT_5_4_REASONING_EFFORTS.has(normalized)
    ? normalized
    : GPT_5_4_REASONING_EFFORT;
}
/** max_output_tokens includes hidden reasoning tokens. The older per-call caps
 * (often 800–2,600) predated non-none reasoning and can end before any JSON is
 * emitted, so every GPT-5.4 non-none request gets this conservative floor. */
export const GPT_5_4_MIN_OUTPUT_TOKENS = 8000;

export interface LLMClient {
  available(): boolean;
  complete(userText: string, opts?: CompleteOptions): Promise<string>;
  completeJson<T = Record<string, unknown>>(
    userText: string,
    opts?: CompleteOptions,
  ): Promise<T>;
}

/**
 * Extract text deltas from a concatenated Anthropic SSE stream body.
 *
 * Anthropic emits `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}`
 * blocks. We also tolerate an OpenAI-style `[DONE]` sentinel so canned test
 * fixtures can use either convention.
 */
export function extractTextDeltas(sseBody: string, onStop?: (reason: string) => void): string[] {
  const out: string[] = [];
  for (const line of sseBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as {
        delta?: { text?: string; stop_reason?: string };
      };
      const text = obj.delta?.text;
      if (typeof text === "string") out.push(text);
      // `stop_reason` arrives on the terminal `message_delta` event. When it is
      // "max_tokens" the reply is truncated — the caller should surface that
      // rather than fail with an opaque JSON-parse error.
      if (obj.delta?.stop_reason && onStop) onStop(obj.delta.stop_reason);
    } catch {
      // ignore keep-alive / non-JSON lines
    }
  }
  return out;
}

/** Extract text from OpenAI Responses API streaming events. */
export function extractOpenAITextDeltas(
  sseBody: string,
  onStop?: (reason: string) => void,
): string[] {
  const out: string[] = [];
  for (const line of sseBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as {
        type?: string;
        delta?: string;
        response?: {
          status?: string;
          incomplete_details?: { reason?: string } | null;
        };
      };
      if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
        out.push(obj.delta);
      }
      const incompleteReason = obj.response?.incomplete_details?.reason;
      if (
        onStop
        && (obj.type === "response.incomplete" || obj.response?.status === "incomplete")
        && incompleteReason
      ) {
        onStop(incompleteReason);
      }
    } catch {
      // Ignore keep-alive and non-JSON event lines.
    }
  }
  return out;
}

/** Pull the first balanced JSON value out of a model reply (ported from config.py). */
export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\[{][\s\S]*?[\]}])\s*```/);
  let candidate: string | null = fence ? fence[1] : null;
  if (candidate === null) {
    const startObj = text.indexOf("{");
    const startArr = text.indexOf("[");
    const start =
      startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
    if (start === -1) return null;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) {
        depth--;
        if (depth === 0) {
          candidate = text.slice(start, i + 1);
          break;
        }
      }
    }
  }
  if (candidate === null) return null;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")) as T;
    } catch {
      return null;
    }
  }
}

type DeltaExtractor = (body: string, onStop?: (reason: string) => void) => string[];

/** Build the Responses API payload independently so model-specific parameter
 * compatibility stays testable without making a network request. */
export function buildOpenAIRequestBody(
  userText: string,
  opts: CompleteOptions,
  activeModel: string,
  reasoningEffort = configuredGpt54ReasoningEffort(),
): Record<string, unknown> {
  const usesGpt54 = /^gpt-5\.4(?:$|-)/.test(activeModel);
  const usesGpt54Reasoning = usesGpt54 && reasoningEffort !== "none";
  const requestedMaxTokens = opts.maxTokens ?? 4096;
  return {
    model: activeModel,
    input: userText,
    stream: true,
    max_output_tokens: usesGpt54Reasoning
      ? Math.max(requestedMaxTokens, GPT_5_4_MIN_OUTPUT_TOKENS)
      : requestedMaxTokens,
    ...(usesGpt54 ? { reasoning: { effort: reasoningEffort } } : {}),
    ...((!usesGpt54 || reasoningEffort === "none") && opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
    ...(opts.system ? { instructions: opts.system } : {}),
  };
}

/** Concrete client bound to the configured provider. */
export class GatewayClient implements LLMClient {
  private key: string | null;
  private base: string;
  private provider: LLMProvider;

  constructor(opts: {
    apiKey?: string | null;
    baseUrl?: string;
    provider?: LLMProvider;
  } = {}) {
    this.provider = opts.provider ?? defaultProvider();
    this.key = opts.apiKey ?? loadToken(this.provider);
    this.base = opts.baseUrl ?? baseUrl(this.provider);
  }

  available(): boolean {
    return Boolean(this.key);
  }

  async complete(userText: string, opts: CompleteOptions = {}): Promise<string> {
    const key = this.key;
    if (!key) {
      throw new Error(
        `GatewayClient used without a ${this.provider} API token. Set ${
          this.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_AUTH_TOKEN"
        } or add the matching git-ignored secrets file.`,
      );
    }
    return this.provider === "openai"
      ? this.completeOpenAI(userText, opts, key)
      : this.completeAnthropic(userText, opts, key);
  }

  private async completeOpenAI(
    userText: string,
    opts: CompleteOptions,
    key: string,
  ): Promise<string> {
    const activeModel = opts.model ?? defaultModel("openai");
    const base = this.base.replace(/\/+$/, "");
    const endpoint = `${base}${base.endsWith("/v1") ? "" : "/v1"}/responses`;
    const body = buildOpenAIRequestBody(userText, opts, activeModel);
    const effectiveOpts = {
      ...opts,
      maxTokens: body.max_output_tokens as number,
    };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    return this.readStream(res, effectiveOpts, extractOpenAITextDeltas, "OpenAI");
  }

  private async completeAnthropic(
    userText: string,
    opts: CompleteOptions,
    key: string,
  ): Promise<string> {
    const activeModel = opts.model ?? defaultModel("anthropic");
    // Newer models (e.g. the opus-4-8 family) reject `temperature` outright —
    // the gateway returns a 400 "`temperature` is deprecated for this model."
    // Only send it for models that still accept it.
    const supportsTemperature = !/opus-4-8/.test(activeModel);
    const body = {
      model: activeModel,
      max_tokens: opts.maxTokens ?? 4096,
      ...(supportsTemperature ? { temperature: opts.temperature ?? 0 } : {}),
      stream: true,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    };

    const res = await fetch(`${this.base.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    return this.readStream(res, opts, extractTextDeltas, "Gateway");
  }

  private async readStream(
    res: Response,
    opts: CompleteOptions,
    extract: DeltaExtractor,
    providerLabel: string,
  ): Promise<string> {
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${providerLabel} ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let stopReason = "";
    const onStop = (reason: string) => {
      stopReason = reason;
    };
    // Process complete SSE events (separated by a blank line) as they arrive.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const token of extract(event, onStop)) {
          full += token;
          opts.onToken?.(token);
        }
      }
    }
    for (const token of extract(buffer, onStop)) {
      full += token;
      opts.onToken?.(token);
    }
    if (stopReason === "max_tokens" || stopReason === "max_output_tokens") {
      throw new Error(
        `Model reply was truncated at the ${opts.maxTokens ?? 4096}-token limit ` +
          `(stop_reason=${stopReason}). Raise maxTokens or narrow the request.`,
      );
    }
    return full;
  }

  async completeJson<T = Record<string, unknown>>(
    userText: string,
    opts: CompleteOptions = {},
  ): Promise<T> {
    const text = await this.complete(userText, opts);
    const parsed = extractJson<T>(text);
    if (parsed === null) {
      throw new Error(`Could not parse JSON from model reply: ${text.slice(0, 300)}`);
    }
    return parsed;
  }
}
