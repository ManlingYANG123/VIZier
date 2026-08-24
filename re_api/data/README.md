# Critique few-shot data

`critique-few-shots-v1.json` is the single maintained source for VIZier's six
fixed end-to-end critique demonstrations. These examples supplement the
recommendation-level empirical excerpts in
`slack_codebook/recommendation_v3_examples.csv`; they do not replace that
catalog.

Each example contains:

- `id`: stable telemetry identifier;
- `purpose`: the behavior boundary the example teaches;
- `sources`: provenance into the consolidated Slack coding data;
- `input`: a compact, de-identified version of the real review packet;
- `expectedOutput`: the same `diagnoses` / `critiques` / `strengths` shape the
  review model must return.

The API sends only `id`, `purpose`, `input`, and `expectedOutput` to the model.
The `sources` block is intentionally excluded so dataset row metadata cannot
leak into generated feedback.

## Current six-shot coverage

1. evidence to an executable fix;
2. choosing the most direct recommendation when several leaves could fit;
3. interaction applicability for an analytical dashboard;
4. interaction non-applicability for an infographic, paired with the narrative
   requirement that does apply;
5. keeping a chart-level issue local;
6. respecting a focused feedback scope.

## Updating the set

1. Edit the JSON only; do not duplicate the examples in TypeScript.
2. Preserve stable IDs for semantically equivalent examples. Create a new ID
   when the intended behavior changes.
3. Update the top-level `version` for every reviewed content change.
4. Keep exactly six examples for the study's fixed experimental condition.
5. Use exact current object, problem, and recommendation codes. The loader fails
   at API startup on unknown codes, duplicates, missing arrays, invalid genres,
   or oversized examples.
6. Run `npm test` in `re_api`, then restart the API. The examples are loaded once
   at process startup.

Every API response and `generate_start` trace records the set ID, human version,
six example IDs, and a SHA-256 content hash. The frontend copies the same fields
into the `critiques_displayed` study telemetry event. The hash preserves exact
run reproducibility even if the human version is accidentally left unchanged.

The Slack-derived inputs and gold outputs are adapted demonstrations rather than
verbatim quotes. A study researcher should review changes to their judgment,
grounding, and proposal behavior before freezing a new experimental version.
