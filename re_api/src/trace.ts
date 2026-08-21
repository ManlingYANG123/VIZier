/**
 * Observability: a phase-based trace bus.
 *
 * Every engine step emits a TraceEvent. Subscribers (the SSE handler, tests,
 * the report script) see the run unfold in real time — this is the "I want to
 * see the API working, especially during critique generation" requirement.
 * Events are also appended to runs/<id>.jsonl for after-the-fact inspection.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TraceEvent, TracePhase } from "./contracts.ts";
import { PROJECT_ROOT } from "./llm/gateway.ts";

export function newRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface TracerOptions {
  onEvent?: (event: TraceEvent) => void;
  /** Directory for JSONL logs; pass null to disable file logging (tests). */
  logDir?: string | null;
}

export class Tracer {
  readonly runId: string;
  readonly events: TraceEvent[] = [];
  private seq = 0;
  private onEvent?: (event: TraceEvent) => void;
  private logFile: string | null;

  constructor(runId: string = newRunId(), opts: TracerOptions = {}) {
    this.runId = runId;
    this.onEvent = opts.onEvent;
    if (opts.logDir === null) {
      this.logFile = null;
    } else {
      const dir = opts.logDir ?? resolve(PROJECT_ROOT, "runs");
      try {
        mkdirSync(dir, { recursive: true });
        this.logFile = resolve(dir, `${runId}.jsonl`);
      } catch {
        this.logFile = null;
      }
    }
  }

  /** Emit an event. High-frequency events (tokens) can skip persistence. */
  emit(phase: TracePhase, message?: string, data?: unknown, persist = true): TraceEvent {
    const event: TraceEvent = {
      runId: this.runId,
      seq: this.seq++,
      ts: Date.now(),
      phase,
      message,
      data,
    };
    if (persist) this.events.push(event);
    this.onEvent?.(event);
    if (persist && this.logFile) {
      try {
        appendFileSync(this.logFile, JSON.stringify(event) + "\n");
      } catch {
        // logging is best-effort
      }
    }
    return event;
  }
}
