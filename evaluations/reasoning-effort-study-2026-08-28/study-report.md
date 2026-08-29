# GPT-5.4 review-configuration study

Generated: 2026-08-28T22:40:51.408Z

Visible-card target: 12–13 total cards per review, counting fixable critiques, guidance critiques, and Good Job strengths.

| Configuration | Runs | Median | Total cards mean (range) | Target hits | Fixable | Guidance | Good Job | Stability A/B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| none-temp04-baseline | 10/10 | 58.8s | 9.50 (8–12) | 1/10 | 5.10 | 2.20 | 2.20 | 0.533 / 0.590 |
| none-temp02 | 6/6 | 50.4s | 9.67 (7–12) | 1/6 | 5.50 | 2.00 | 2.17 | 0.505 / 0.655 |
| low | 6/6 | 118.6s | 8.33 (4–11) | 0/6 | 5.17 | 1.17 | 2.00 | 0.283 / 0.465 |
| medium | 6/6 | 193.8s | 1.00 (0–2) | 0/6 | 1.00 | 0.00 | 0.00 | 1.000 / 0.185 |
| high | 6/6 | 242.0s | 1.17 (1–2) | 0/6 | 1.17 | 0.00 | 0.00 | 1.000 / 0.704 |
| low-nojudge | 6/6 | 103.4s | 11.17 (10–12) | 2/6 | 8.00 | 1.17 | 2.00 | 0.432 / 0.635 |
| low-coverage12 | 6/6 | 94.8s | 11.33 (9–13) | 3/6 | 8.33 | 1.00 | 2.00 | 0.531 / 0.707 |
| low-recovery11-cap11 | 6/6 | 121.5s | 12.50 (11–13) | 5/6 | 8.83 | 1.50 | 2.17 | 0.541 / 0.569 |

## Recommendation

Use GPT-5.4 low for full-review discovery, keep the LLM solution judge off, retain grounding + deterministic merge/rank + real apply/compile preflight + document constraints, allow at most two bounded recovery passes when coverage is sparse, and cap the visible critique list at 11. This configuration produced 12–13 total visible cards in 5/6 runs (the remaining run produced 11 after one preflight and one document-constraint rejection).

Do not use global medium or high for this study workflow. They produced only 0–2 visible cards while taking roughly 3–4 minutes per review. Stage traces show that medium can return empty critique arrays in both discovery passes; deterministic fallbacks are then rewritten or rejected by the same reasoning-heavy judge, and document constraints can remove the final survivor.

## Study guidance

- Freeze the model snapshot, reasoning effort, judge setting, recovery policy, critique cap, prompt/few-shot hashes, and PDF constraint extraction before collecting participants.
- Treat total visible cards as fixable + guidance + Good Job. Report the three components separately so a stable total cannot hide a collapse in actionable feedback.
- Log first-pass candidates, recovery candidates, preflight drops, constraint drops, final card counts, and latency. An 11-card result after a real safety or constraint rejection is preferable to padding the review to a quota.
- Use this recovery policy only for Overall Review. Focused and selected-region requests keep their four-critique cap and should not pay the extra discovery latency.
- Expect about two minutes median latency for Overall Review; show phase-level progress or pre-generate the review before the participant reaches the feedback screen.
