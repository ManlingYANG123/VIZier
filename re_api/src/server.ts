/**
 * SSE server exposing the critique engine to the v2 frontend.
 *
 *   POST /critique  -> streams TraceEvents, then a final `result` event
 *                      (CritiqueResponse).
 *   POST /apply     -> streams TraceEvents, then a final `result` event
 *                      (ApplyResponse).
 *   GET  /health    -> { ok }.
 *   GET  /api/dashboards      -> lists dashboard JSON available to the UI.
 *   GET  /api/dashboards/:id  -> returns one dashboard JSON document.
 *
 * Streaming (not plain JSON) is the point: the client renders each phase live,
 * including generation tokens, so the API's work is visible.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApplyRequest,
  CritiqueRequest,
  IntakeConstraintsRequest,
  PreferenceSynthesisRequest,
  ScaffoldRequest,
  TraceEvent,
} from "./contracts.ts";
import { GatewayClient, type LLMClient } from "./llm/client.ts";
import { hasToken, model, provider } from "./llm/gateway.ts";
import { Tracer, newRunId } from "./trace.ts";
import { runApply, runCritique } from "./engine.ts";
import { buildScaffold } from "./scaffold.ts";
import { buildConstraintSet, IntakeUnsupportedError } from "./intake/index.ts";
import { synthesizePreferences } from "./preference.ts";
import {
  DashboardLibraryError,
  listDashboardFiles,
  loadDashboardFile,
} from "./dashboards.ts";
import { saveStudySession, studyStorageMode } from "./study-store.ts";

const PORT = Number(process.env.PORT || process.env.RE_API_PORT || 8091);
const HOST = process.env.RE_API_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

// The second discovery pass is an explicit evaluation/debug option. Production
// defaults to one stronger, compact pass: doubling the complete dashboard
// prompt added substantial latency and tended to pad the review with weaker
// observations. Set RE_API_SECOND_PASS=1 only for coverage experiments.
if (process.env.RE_API_SECOND_PASS === undefined) process.env.RE_API_SECOND_PASS = "0";
// Preserve the high precision of one-pass review while recovering breadth only
// when the first pass is genuinely sparse. The second call still runs through
// the same judge, apply preflight, and conflict gates.
if (process.env.RE_API_ADAPTIVE_COVERAGE === undefined) process.env.RE_API_ADAPTIVE_COVERAGE = "1";
// The semantic solution judge is part of the production quality path, but stays
// opt-in for engine-library tests and deterministic measurement harnesses.
if (process.env.RE_API_SOLUTION_JUDGE === undefined) process.env.RE_API_SOLUTION_JUDGE = "1";
if (process.env.RE_API_PROPOSAL_PREFLIGHT === undefined) process.env.RE_API_PROPOSAL_PREFLIGHT = "1";
const FRONTEND_DIST = resolve(fileURLToPath(new URL("../../dist/", import.meta.url)));
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
const ALLOWED_ORIGINS = new Set(
  (process.env.RE_API_ALLOWED_ORIGIN || "http://127.0.0.1:8082,http://localhost:8082")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function makeClient(): LLMClient | undefined {
  if (process.env.RE_API_DISABLE_LLM === "1") return undefined;
  if (!hasToken()) return undefined;
  return new GatewayClient();
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const requestOrigin = req.headers.origin;
  const allowedOrigin = requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
    ? requestOrigin
    : [...ALLOWED_ORIGINS][0];
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function requestPathname(req: IncomingMessage): string | null {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

function serveFrontend(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let pathname: string;
  try {
    pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid URL" }));
    return true;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = resolve(FRONTEND_DIST, relativePath);
  if (filePath !== FRONTEND_DIST && !filePath.startsWith(`${FRONTEND_DIST}${sep}`)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return true;
  }

  try {
    if (!statSync(filePath).isFile()) throw new Error("not a file");
  } catch {
    if (extname(pathname)) return false;
    filePath = resolve(FRONTEND_DIST, "index.html");
    try {
      if (!statSync(filePath).isFile()) return false;
    } catch {
      return false;
    }
  }

  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    const stream = createReadStream(filePath);
    stream.on("error", (error) => {
      console.error("[re_api] static file read error:", error.message);
      res.destroy(error);
    });
    stream.pipe(res);
  }
  return true;
}

function sseWrite(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Human-readable terminal logging so the engine's work is visible in the
 * backend console (not only in the browser). */
function logEvent(e: TraceEvent): void {
  if (e.phase === "generate_token") {
    // Print streamed tokens inline (no newline) so LLM output is visible live.
    const t = (e.data as { t?: string } | undefined)?.t;
    if (typeof t === "string") process.stdout.write(t);
    else if (e.message) console.log(`      · ${e.message}`);
    return;
  }
  const dt = `+${String(e.ts).slice(-5)}`;
  console.log(`  ${dt} ${e.phase.padEnd(16)} ${e.message ?? ""}`);
  const d = e.data as Record<string, unknown> | undefined;
  if (e.phase === "detect_done" && Array.isArray(d?.findings)) {
    for (const f of d!.findings as Array<{ detail: string }>) console.log(`           ↳ ${f.detail}`);
  }
  if (e.phase === "generate_done" && Array.isArray(d?.critiques)) {
    for (const c of d!.critiques as Array<{ title: string; kind: string }>)
      console.log(`           ↳ [${c.kind}] ${c.title}`);
  }
}

function openSSE(req: IncomingMessage, res: ServerResponse): void {
  cors(req, res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

async function handleCritique(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as CritiqueRequest;
  openSSE(req, res);
  const client = makeClient();
  const requestedScope = body.reviewScope || (body.region ? "selected-region" : body.focus ? "focused" : "full");
  console.log(
    `\n[re_api] POST /critique  (v${body.version}, scope: ${requestedScope}, unified criteria engine, model adapter: ${client ? "available" : "unavailable"})`,
  );
  const tracer = new Tracer(newRunId(), {
    onEvent: (e: TraceEvent) => {
      sseWrite(res, e.phase, e);
      logEvent(e);
    },
  });
  try {
    const result = await runCritique(body, tracer, { client });
    console.log(`[re_api] → ${result.critiques.length} critique(s), ${result.findings.length} finding(s)\n`);
    sseWrite(res, "result", result);
  } catch (err) {
    console.error(`[re_api] critique error:`, err instanceof Error ? err.message : err);
    tracer.emit("error", err instanceof Error ? err.message : String(err));
    sseWrite(res, "error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
}

async function handleApply(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as ApplyRequest;
  openSSE(req, res);
  const client = makeClient();
  console.log(`\n[re_api] POST /apply  (selected: ${(body.selectedRecommendationIds || []).join(", ")})`);
  const tracer = new Tracer(newRunId(), {
    onEvent: (e: TraceEvent) => {
      sseWrite(res, e.phase, e);
      logEvent(e);
    },
  });
  try {
    const result = await runApply(body, tracer, { client });
    console.log(
      `[re_api] → rollback=${result.rollback.rolledBack}, changed=[${result.changedTargets.join(", ")}], +${result.recommendationDelta.added.length} new\n`,
    );
    sseWrite(res, "result", result);
  } catch (err) {
    console.error(`[re_api] apply error:`, err instanceof Error ? err.message : err);
    tracer.emit("error", err instanceof Error ? err.message : String(err));
    sseWrite(res, "error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
}

async function handleScaffold(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(req, res);
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as ScaffoldRequest;
    const client = makeClient();
    console.log(`\n[re_api] POST /scaffold  (LLM: ${client ? "on" : "off/templates"})`);
    const result = await buildScaffold(body, client);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unavailable = message.startsWith("LLM_REQUIRED:") || message.startsWith("LLM_CALL_FAILED:");
    res.writeHead(unavailable ? 503 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message, code: unavailable ? "llm_unavailable" : "invalid_request" }));
  }
}

async function handleIntakeConstraints(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(req, res);
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as IntakeConstraintsRequest;
    if (!body.source || typeof body.source !== "object" || typeof body.source.kind !== "string") {
      throw new Error("INVALID_SOURCE: intake requires a { kind, ... } design source");
    }
    const client = makeClient();
    console.log(
      `\n[re_api] POST /intake-constraints  (source: ${body.source.kind}, LLM: ${client ? "on" : "off/empty"})`,
    );
    const { constraintSet, source } = await buildConstraintSet(body.source, client, {
      requireLLM: body.requireLLM,
    });
    console.log(`[re_api] → ${constraintSet.constraints.length} hard constraint(s) (${source})\n`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ constraintSet, source }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unsupported = err instanceof IntakeUnsupportedError;
    const unavailable = message.startsWith("LLM_REQUIRED:") || message.startsWith("LLM_CALL_FAILED:");
    const status = unavailable ? 503 : 400;
    const code = unavailable ? "llm_unavailable" : unsupported ? "unsupported_source" : "invalid_request";
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message, code }));
  }
}

async function handlePreferenceSynthesis(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(req, res);
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as PreferenceSynthesisRequest;
    const client = makeClient();
    console.log(
      `\n[re_api] POST /infer-context  (events: ${(body.events || []).length}, model adapter: ${client ? "available" : "unavailable"})`,
    );
    const result = await synthesizePreferences(body, client);
    console.log(`[re_api] → ${result.suggestions.length} context suggestion(s)\n`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unavailable = message.startsWith("LLM_REQUIRED:") || message.startsWith("LLM_CALL_FAILED:");
    res.writeHead(unavailable ? 503 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message, code: unavailable ? "llm_unavailable" : "invalid_request" }));
  }
}

async function handleStudySession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(req, res);
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
    if (!body || typeof body !== "object" || !body.participantId || !body.sessionId) {
      throw new Error("INVALID_BUNDLE: study session requires participantId and sessionId");
    }
    const result = await saveStudySession(body);
    const extra = result.files?.length > 1 ? `, ${result.files.length} files` : "";
    console.log(
      `\n[re_api] POST /study-session  (participant: ${body.participantId}, ${result.bytes} bytes -> ${result.stored}: ${result.location}${extra})`,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const invalid = message.startsWith("INVALID_BUNDLE:");
    res.writeHead(invalid ? 400 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message, code: invalid ? "invalid_request" : "storage_error" }));
  }
}

async function handleDashboardLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  cors(req, res);
  res.setHeader("Cache-Control", "no-store");
  try {
    if (pathname === "/api/dashboards" || pathname === "/api/dashboards/") {
      const dashboards = await listDashboardFiles();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ dashboards }));
      return;
    }
    const encodedId = pathname.slice("/api/dashboards/".length);
    let id: string;
    try {
      id = decodeURIComponent(encodedId);
    } catch {
      throw new DashboardLibraryError("invalid dashboard id", 400, "invalid_dashboard_id");
    }
    const loaded = await loadDashboardFile(id);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(loaded.dashboard));
  } catch (error) {
    const known = error instanceof DashboardLibraryError;
    const status = known ? error.status : 500;
    const message = known ? error.message : "dashboard library request failed";
    const code = known ? error.code : "dashboard_library_error";
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message, code }));
  }
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    cors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }
  const pathname = requestPathname(req);
  if (!pathname) {
    cors(req, res);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid URL" }));
    return;
  }
  if (req.method === "GET" && pathname === "/health") {
    cors(req, res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  cors(req, res);
  if (req.method === "GET") {
    if (pathname === "/api/dashboards" || pathname.startsWith("/api/dashboards/")) {
      void handleDashboardLibrary(req, res, pathname);
      return;
    }
  }
  if (req.method === "POST" && pathname === "/critique") {
    void handleCritique(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/apply") {
    void handleApply(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/scaffold") {
    void handleScaffold(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/intake-constraints") {
    void handleIntakeConstraints(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/infer-context") {
    void handlePreferenceSynthesis(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/study-session") {
    void handleStudySession(req, res);
    return;
  }
  if (
    pathname.startsWith("/api/") ||
    ["/critique", "/apply", "/scaffold", "/intake-constraints", "/infer-context", "/study-session", "/health"].includes(pathname)
  ) {
    cors(req, res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "API route not found" }));
    return;
  }
  if (serveFrontend(req, res)) return;
  cors(req, res);
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`[re_api] critique engine on http://${HOST}:${PORT}`);
  console.log(`[re_api] study store: ${studyStorageMode()}`);
  console.log(
    `[re_api] model adapter: ${provider()}/${model()} (${hasToken() ? "credentials available" : "no credentials"})`,
  );
});
