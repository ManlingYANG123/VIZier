/** Provider configuration + safe API-key loading. Secrets stay in environment
 * variables or git-ignored local files and are never sent to the browser. */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..", "..");
export const ANTHROPIC_TOKEN_FILE = resolve(PROJECT_ROOT, "secrets", "anthropic_token.txt");
export const OPENAI_TOKEN_FILE = resolve(PROJECT_ROOT, "secrets", "openai.txt");
export type LLMProvider = "openai" | "anthropic";

// Convenience fallback: the sibling twbx2vegalite project already stores a
// gateway token. Reusing it lets `engine=real` do genuine LLM work without the
// developer copying the key. re_api itself has no code dependency on that
// project — this is only a secrets lookup path.
const FALLBACK_TOKEN_FILE = resolve(
  PROJECT_ROOT,
  "..",
  "..",
  "..",
  "twbx2vegalite",
  "secrets",
  "anthropic_token.txt",
);

function readFirstToken(file: string): string | null {
  if (!existsSync(file)) return null;
  for (const raw of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith("#")) return line;
  }
  return null;
}

const DEFAULT_ANTHROPIC_BASE_URL =
  "https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function openAIToken(): string | null {
  return envValue("OPENAI_API_KEY") ?? readFirstToken(OPENAI_TOKEN_FILE);
}

function anthropicToken(): string | null {
  return envValue("ANTHROPIC_AUTH_TOKEN")
    ?? readFirstToken(ANTHROPIC_TOKEN_FILE)
    ?? readFirstToken(FALLBACK_TOKEN_FILE);
}

/** OpenAI is preferred when both credentials exist. Override explicitly with
 * RE_API_PROVIDER=openai|anthropic. */
export function provider(): LLMProvider {
  const configured = envValue("RE_API_PROVIDER");
  if (configured === "openai" || configured === "anthropic") return configured;
  return openAIToken() ? "openai" : "anthropic";
}

export function baseUrl(activeProvider: LLMProvider = provider()): string {
  return activeProvider === "openai"
    ? envValue("OPENAI_BASE_URL") ?? DEFAULT_OPENAI_BASE_URL
    : envValue("ANTHROPIC_BASE_URL") ?? DEFAULT_ANTHROPIC_BASE_URL;
}

export function model(activeProvider: LLMProvider = provider()): string {
  return envValue("RE_API_MODEL")
    ?? (activeProvider === "openai" ? "gpt-5.4" : "claude-opus-4-8");
}

export function loadToken(activeProvider: LLMProvider = provider()): string | null {
  return activeProvider === "openai" ? openAIToken() : anthropicToken();
}

export function hasToken(activeProvider: LLMProvider = provider()): boolean {
  return loadToken(activeProvider) !== null;
}
