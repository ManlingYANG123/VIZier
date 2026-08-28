# Formal-study Overall Review reliability report

Generated: 2026-08-28T00:38:24.741Z

## Configuration

- Materials: A and B, the two counterbalanced VIZier task dashboards. Assessment dashboards 1 and 2 are excluded because they do not run Overall Review.
- Successful repetitions: A = 5, B = 5; requested = 5 per dashboard.
- Review temperature: 0.4.
- Context policy: infer once per dashboard with `/scaffold`, keep the generated description unchanged, and reuse it for every repetition.
- Design-document policy: extract each bound PDF once, activate all extracted rules (the UI default), and reuse the same ConstraintSet and clipped PDF text for every repetition.
- Dashboard version/iteration state: version 1, full review, no prior accepted or rejected critiques, no saved rationales.
- Requests were executed sequentially to avoid provider contention. Raw SSE events and terminal responses are retained in `raw/`.

## Results

| Dashboard | Critiques/run (mean, range) | Executable ratio | Layout-composition frequency | Recommendation overlap | Edit-path similarity | Within-dashboard stability |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 7.400 (6–9) | 73.0% | 8.1% | 0.453 | 0.360 | 0.533 |
| B | 7.200 (6–10) | 66.7% | 8.3% | 0.562 | 0.592 | 0.590 |

Cross-dashboard proposal-kind similarity (A × B): **0.512** mean Jaccard (range 0.333–0.750, 25 pairs).

## Operational definitions

1. **Cross-dashboard proposal-kind similarity:** Jaccard similarity between the unique `proposal.kind` sets from every A run and every B run. A high value may indicate reusable solution patterns, but an extremely high value can also indicate dashboard-insensitive generation.
2. **Recommendation overlap:** within-dashboard pairwise Jaccard similarity over exact recommendation-leaf IDs. An uncatalogued recommendation uses its object/problem/dimension tuple so it remains in the denominator.
3. **Edit-path similarity:** within-dashboard pairwise Jaccard similarity over explicit `proposal.edits` paths plus canonical board/interaction paths for proposal kinds whose changes are not represented by `proposal.edits`.
4. **Layout-composition frequency:** share of critiques that change tile bounds/composition, KPI composition, or spec-internal width/height/spacing/facet/concat structure.
5. **Executable ratio:** critiques with `proposal.mode === "executable"` divided by all returned critiques.
6. **Within-dashboard run-to-run stability:** equal-weight mean of recommendation overlap, proposal-kind Jaccard, and edit-path Jaccard. Component values remain visible so the composite is not treated as a black box.

All set comparisons use unique values within a run. Frequency tables in `summary.json` retain repeated counts.

## Files

- `summary.json`: machine-readable aggregate metrics and every pairwise score.
- `run-metrics.csv`: one row per attempted run.
- `raw/A.config.json`, `raw/B.config.json`: frozen formal inputs, scaffold output, and PDF intake output.
- `raw/A-run-*.json`, `raw/B-run-*.json`: raw critique responses and trace events.
