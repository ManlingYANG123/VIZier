# GPT-5.4 reasoning-effort study

Matched comparison of `low`, `medium`, and `high`, plus pipeline ablations and
`none` temperature controls, on the two frozen A/B formal-study Overall Review
requests. The model snapshot, dashboard state, inferred context, and PDF
constraints are held constant within each comparison.

Three API servers must run with `RE_API_MODEL=gpt-5.4-2026-03-05` and matching
`RE_API_REASONING_EFFORT` values on ports 8191–8193. Then run:

```bash
node evaluations/reasoning-effort-study-2026-08-28/run.mjs --runs 5
node evaluations/reasoning-effort-study-2026-08-28/analyze-study.mjs
```

Raw responses are resumable and stored under `raw/`. `study-report.md` uses the
author-facing metric: total visible cards = fixable + guidance + Good Job.
