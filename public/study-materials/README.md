# VIZier user-study materials

This directory contains the four dashboard stimuli and the two design-guideline PDFs used by the current study plan.

## Material codes

| Code | Dashboard | Study role | Design PDF |
| --- | --- | --- | --- |
| A | Britain's Garden Birds | VIZier training or controlled revision task | `A_bbc-gel-infographics.pdf` |
| B | Retail Sales Command Center | VIZier training or controlled revision task | `B_tableau-dashboard-best-practices.pdf` |
| 1 | Air Quality Where You Live | Pre- or post-session assessment | None |
| 2 | Ocean Biodiversity Atlas | Pre- or post-session assessment | None |

`A` and `B` are counterbalanced so that each dashboard is used for training by one participant group and for the controlled task by the other. `1` and `2` are counterbalanced between the pre- and post-session assessments. The numbers therefore identify the assessment stimuli; they do not permanently assign a dashboard to the pre or post phase.

## Assignment groups

- Group 1 (`/study/group-1`): Pre `1` -> Training `A` -> Controlled task `B` -> Post `2`
- Group 2 (`/study/group-2`): Pre `2` -> Training `B` -> Controlled task `A` -> Post `1`

Participants never choose or see a group or material code in the interface. The route fixes the counterbalanced assignment, while the Study Runner presents neutral Part 1-4 labels. Pre and Post use the annotation/questionnaire surface; only Training and Controlled task open the VIZier workspace.

## Directory layout

- `dashboards/`: frozen JSON stimuli. Always create a fresh working copy before a session.
- `pdfs/`: fixed guideline documents for dashboards A and B. Dashboards 1 and 2 intentionally have no participant-facing PDF.
- `manifest.json`: machine-readable mapping for study setup and logging.

Do not reveal seeded issues, expected issue counts, or study hypotheses to participants. Keep design briefs, seeded-issue inventories, and expert-rating materials outside this public directory if they contain study answers.
