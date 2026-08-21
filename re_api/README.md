# re_api — VIZier v2 critique engine

A standalone **Node/TypeScript**, LLM/API-driven backend for the v2 dashboard
critique studio. It takes **Vega-Lite spec maps** (addressable tile specs) and
runs the full loop:

```
discover + critique (open-ended LLM over specs) → validate references/schema
→ apply (spec transform)
→ compile-gate → compute (real data) → re-evaluate (living delta)
```

Every step is streamed as a Server-Sent Event so the frontend can show the
engine working live — especially during critique generation.

> Input is **Vega-Lite JSON**, never a `.twbx`. twbx→Vega-Lite is just one
> possible upstream adapter and is out of scope here. The only thing borrowed
> from `twbx2vegalite` is the ~40-line gateway client pattern.

## The trust invariant

**Agent proposes → Engine computes → UI shows before/after.** For real frontend
requests, the LLM inspects the complete spec map and context and independently
chooses the issue set. `src/generate/discover.ts` validates required text,
dimensions, exact tile references, and proposal structure. Deterministic code
then applies supported transforms (`src/apply`), validates compilation, and
computes real post-interaction data (`src/compute`). There is no production
template fallback.

## Run

```bash
cd prototype/v2/re_api
npm install
npm test                 # 31 tests, network-free
npm run report           # writes REPORT.md + report.html
npm start                # SSE server on http://localhost:8091
```

The open-ended review supports visual, narrative, interaction, data,
accessibility, and performance findings. Known proposal kinds are executable;
other recommendations are returned as grounded manual guidance.

## API

- `POST /critique` → SSE stream of `TraceEvent`s, then a final `result`
  (`CritiqueResponse`: findings + grounded critiques).
- `POST /apply` → SSE stream, then a final `result` (`ApplyResponse`: mutated
  spec map, `recommendationDelta`, engine-computed data slices, rollback).
- `GET /api/dashboards` → dynamically lists validated dashboard JSON files.
- `GET /api/dashboards/:id` → returns one validated dashboard JSON document.
- `GET /health` → `{ ok }`.

Request/response shapes are in `src/contracts.ts` and mirror the frontend
contract in `../README.md`.

## Enabling the LLM

Required by the default frontend critique flow. OpenAI is preferred when both
provider credentials exist. To use OpenAI:

- put a key on the first line of `secrets/openai.txt` (git-ignored), **or**
- export `OPENAI_API_KEY`.

To use the Salesforce Express LLM Gateway instead:

- put a token on the first line of `secrets/anthropic_token.txt`
  (git-ignored; see `secrets/anthropic_token.txt.example`), **or**
- export `ANTHROPIC_AUTH_TOKEN`.

Select explicitly with `RE_API_PROVIDER=openai|anthropic`. Override the model
with `RE_API_MODEL`, provider base URLs with `OPENAI_BASE_URL` or
`ANTHROPIC_BASE_URL`, the port with `RE_API_PORT`, and force offline with
`RE_API_DISABLE_LLM=1`.

## Frontend wiring

`../src/api-client.js` calls this engine by default. **AI Assist** requires
model-authored critique copy and displays an error if the gateway or grounding
guardrail fails; it never silently substitutes the old mock board or template
copy. Legacy browser mock flags are cleared and ignored. A floating trace panel
renders the streaming phases and generation tokens live.

## Layout

```
src/
  contracts.ts          shared types (SpecMap, Critique, Finding, TraceEvent, req/resp)
  llm/gateway.ts        token loading + base URL (ported from config.py)
  llm/client.ts         gateway client w/ streaming SSE parse + JSON extraction
  detect/               offline regression + post-apply verification checks
  generate/discover.ts  open-ended LLM review + schema/reference validation
  generate/critique.ts  deterministic-test/offline phrasing path
  compute/              real per-value data slice (engine computes, not the LLM)
  apply/                proposal.kind -> spec transform + vega-lite compile gate
  reevaluate.ts         re-run detectors -> living-recommendation delta
  trace.ts              phase event bus -> SSE + runs/*.jsonl
  engine.ts             orchestrator (runCritique / runApply)
  server.ts             HTTP + SSE endpoints
fixtures/specs.ts       grounded v2 dashboard spec map
tests/                  node:test suite (detect/apply/compute/reevaluate/generate/gateway/engine)
scripts/report.ts       REPORT.md + report.html generator
```
