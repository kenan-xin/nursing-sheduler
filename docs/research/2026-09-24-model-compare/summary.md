# Model comparison: assistant eval suite

Judge: `openai/gpt-5-mini` (default, unchanged). Simulated user: default, unchanged. Playbook 2026-09-24.5, rubric 2026-09-24.4. 3 trials/case, 88 trials/run, no `EVAL_PROMOTE`. `EVAL_MAX_USD` raised to 25 only to clear the planning-cost guard (it estimates on Sonnet-era per-token cost); every run's actual spend stayed far under the $8 stop threshold.

| Model | Actual cost | Wall time | pass^1 | pass^3 | Safety failures |
|---|---|---|---|---|---|
| xiaomi/mimo-v2.6-pro | $0.99 | 65.4 min | 37% | 17% | 0 |
| deepseek/deepseek-v4.1-flash | $1.72 | 23.8 min | 41% | 20% | 3 |
| z-ai/glm-5.3-flash | $0.97 | 37.1 min | 38% | 17% | 2 |

## Deterministic gates (tools / proposal / grounding / safety), separate from judge items

Pass rate across 88 trials per model:

| Gate | xiaomi | deepseek | glm |
|---|---|---|---|
| tools | 98% | 99% | 94% |
| proposal | 92% | 97% | 80% |
| grounding | 100% | 100% | 100% |
| safety | 100% | 97% | 98% |
| navigation | 99% | 100% | 97% |
| final | 95% | 100% | 98% |

Judge-scored items (tone/style/claims, non-deterministic) are separate and drive most of the pass^1/pass^3 gap above.

## Tool-call errors / trial errors (timeouts, failed calls)

- xiaomi: **14 trial timeouts** out of 88 (16%) - mostly in `flow-c-diagnose`, `flow-b-shared-shift`, `repair-*` cases, each eating the full 180s budget. This is why xiaomi took ~65 min vs. deepseek's 24 min for the same suite.
- deepseek: **0** real tool/trial errors.
- glm: **1** trial timeout (`sg-nic-per-shift`).

## Notable behaviours (with evidence)

1. **Plain-text pick-one questions** - all three models did this repeatedly (deepseek worst: 15/88 trials, `no_text_choice` failures; glm 19/88; xiaomi 6/88). Example (deepseek, `setup-flow-a`): asked a yes/no pick-one as plain text ("Want those?") instead of a card.
2. **False "applied/prepared" claims** - all three overstate state after only a Preview. Example (glm, `flow-b-shared-shift`): "I've prepared the new requirement" when transcript shows only a Preview shown, not applied. xiaomi had the most (`no_false_claim` failed 11/88 trials).
3. **Invented/jargon entities** - deepseek referred to "RN" (not in entity list) and "shift code"; glm used "solver" and "shift-order rule"; xiaomi used "checker"/"tab" and "weight 10" (raw scoring jargon leaking into a nurse-facing reply).
4. **xiaomi is markedly slower and times out more** - 16% of trials hit the 180s cap, nearly 3x deepseek's total wall-clock for the same case count, with no better pass rate to show for it.
5. **deepseek had the only safety-gate failures** - 3/88 trials, all in `flow-b-shared-shift` (a shared-shift editing scenario); glm had 2/88 in the same case; xiaomi had 0 safety-gate failures but no better on the judge-scored `no_false_claim`/tone dimensions.
6. **Reply length/tone**: `short` criterion failures were low for all three (xiaomi 2, glm 5, deepseek 10) - replies generally stayed within 1-3 sentences as required; deepseek's higher count suggests occasional longer, more verbose nurse-facing replies.

## Reference: Sonnet 4.5 baseline (not like-for-like)

`web/evals/baseline.json` / earlier reference run: 25% pass^1, 15% pass^3, 10 safety failures, under an older prompt/rubric version and a partial (43/85 trial) run. **This is not a like-for-like comparison** - different playbook/rubric versions, different (and here, complete) trial counts, and the baseline was graded with a role-inverted simulated user before later fixes. Treat it only as rough historical context, not a ranking input.

## Recommendation

- **Best quality**: deepseek/deepseek-v4.1-flash - highest pass^1 (41%) and pass^3 (20%), best deterministic-gate pass rates (tools 99%, proposal 97%), zero tool/trial errors, and fastest wall-clock (24 min). Its 3 safety-gate failures (all in one case, `flow-b-shared-shift`) are the one real caveat - worth a manual look at that case's transcripts before trusting it further.
- **Best value**: z-ai/glm-5.3-flash - cheapest run ($0.97, tied with xiaomi) with mid-pack quality (38%/17%) and very low tool-error rate; its main weakness is proposal-gate reliability (80%, worst of the three) and the highest `no_text_choice` failure rate.
- **Avoid for this workload**: xiaomi/mimo-v2.6-pro - similar quality to glm but 16% of trials time out, nearly 3x the wall-clock, and it has the worst `no_false_claim` rate (claims "prepared" changes that weren't shown as applied) - a real risk for a scheduling assistant nurses will trust literally.

Caveats: all three models are well below Sonnet 4.5's already-modest pass rates in the (non-comparable) baseline; none is judge-calibrated; "solver"/jargon leakage and false-apply claims appear across all three and likely need a playbook/prompt fix rather than a model swap.
