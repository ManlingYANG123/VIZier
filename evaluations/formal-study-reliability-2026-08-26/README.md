# Formal-study Overall Review reliability evaluation

This folder contains a reproducible five-run evaluation of the two counterbalanced VIZier task materials (A and B).

## Run

From the VIZier repository root, with the backend available at `127.0.0.1:8091`:

```bash
node evaluations/formal-study-reliability-2026-08-26/run.mjs --runs 5
```

The runner is resumable: successful raw run files are skipped. A failed run is retried once and can be resumed later with the same command. To recompute metrics without model calls:

```bash
node evaluations/formal-study-reliability-2026-08-26/analyze.mjs
```

To intentionally regenerate the frozen context/PDF configuration, pass `--refresh-config`. Do not use that flag when resuming a partially completed formal run, because it would change the inputs.

## Outputs

- `raw/A.config.json`, `raw/B.config.json`: frozen dashboard, context, PDF constraints, and exact critique request base.
- `raw/A-run-*.json`, `raw/B-run-*.json`: complete terminal responses and SSE trace events.
- `summary.json`: aggregate and pairwise metrics.
- `run-metrics.csv`: one row per attempted repetition.
- `report.md`: concise methods and results for review before paper reporting.

Metric definitions are implemented and tested in `metrics.mjs` and `metrics.test.mjs`.
