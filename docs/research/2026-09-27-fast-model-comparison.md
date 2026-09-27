# Fast model comparison for the schedule assistant (bead 46g)

2026-09-27. The user dropped MiMo v2.6 Pro as too slow and made latency a first-class criterion. This run compares the app's current default, the two earlier Flash candidates, and two fast tool-calling models picked from OpenRouter's live stats. It also tests OpenRouter's `:nitro` routing, which sorts providers by throughput.

Raw data: `docs/research/2026-09-27-fast-model-compare/<model>/` (`results.json`, `report.md`, `run.log`), with the DeepSeek repeat under `repeat/`.

## Setup

- Eval suite: `web/evals` on develop at 015344b plus two commits on this branch. 18e5a01 records per-turn TTFT and latency. d3eca26 records the assistant-only cost.
- Cases (`EVAL_CASES`): `setup-flow-a` (setup cards, fixed at 1 trial), `reg-pick-one-as-text` (pick-one card), `reg-claim-after-preview` (Preview claims), `limit-consecutive-days` (rule change), `repair-understaffed-night` (repair), `sg-moh-rest-rule` (knowledge).
- 3 trials per case (16 trials per run), except Sonnet 4.5, which got 2 trials (11) because of cost. The DeepSeek runs were repeated once, so each has 32 trials.
- Judge `openai/gpt-5-mini` and simulated user `anthropic/claude-haiku-4.5`, both at defaults.
- A turn is one wait the user sees: a send, an Apply, or a finished run. **TTFT** stops at the first text or tool-call delta of the turn's first model call. Reasoning deltas do not count. **Turn** stops when the assistant settles, after all its tool hops. Timed-out turns are not included.
- **$/turn** is the assistant model's own spend per user-visible turn. It excludes the judge and the simulated user.

## Results

The case `repair-understaffed-night` fails on every model. The cause is an app regression on develop (see the caveats and bead 20wo). The table shows pass rates with and without it.

| Model | Trials | Pass | Pass without repair | Safety fails | TTFT p50 / p90 | Turn p50 / p90 | $/turn | $/trial |
|---|---|---|---|---|---|---|---|---|
| **deepseek/deepseek-v4.1-flash:nitro** | 32 | 21/32 | 21/26 (81%) | 0 | **1.6 / 2.9 s** | **4.0 / 9.1 s** | $0.0064 | $0.016 |
| deepseek/deepseek-v4.1-flash (default routing) | 32 | 21/32 | 21/26 (81%) | 0 | 3.0 / 8.8 s | 8.1 / 18.9 s | $0.0044 | $0.011 |
| anthropic/claude-sonnet-4.5 (current app default) | 11 | 6/11 | 6/9 (67%) | 0 | 2.5 / 3.1 s | 6.6 / 10.8 s | $0.136 | $0.41 |
| z-ai/glm-5.3-flash | 16 | 11/16 | 11/13 (85%) | 0 | 5.1 / 12.9 s | 9.6 / 27.6 s | $0.0033 | $0.008 |
| z-ai/glm-5.3-flash:nitro | 16 | 11/16 | 11/13 (85%) | 0 | 6.0 / 22.4 s | 16.4 / 38.0 s | $0.0047 | $0.012 |
| google/gemini-3.8-flash (new candidate) | 16 | 11/16 | 11/13 (85%) | 0 | 4.9 / 10.0 s | 10.8 / 23.0 s | $0.027 | $0.063 |
| openai/gpt-6-luna (new candidate) | 16 | 7/16 | 7/13 (54%) | 0 | 2.5 / 4.1 s | 9.7 / 16.7 s | $0.0025 | $0.005 |

The two DeepSeek runs agree with each other. With `:nitro`, TTFT p50/p90 was 1.8/3.1 s and 1.3/2.5 s, and turn p50/p90 was 4.3/9.4 s and 3.4/6.3 s. With default routing, TTFT p50/p90 was 3.0/8.8 s and 3.0/6.7 s, and turn p50/p90 was 8.0/18.8 s and 8.2/20.2 s.

Pass by case (all runs pooled):

| Case | DS nitro | DS | Sonnet 4.5 | GLM | GLM nitro | Gemini 3.8 | GPT-6 Luna |
|---|---|---|---|---|---|---|---|
| setup-flow-a | 1/2 | 2/2 | 0/1 | 0/1 | 0/1 | 1/1 | 0/1 |
| reg-pick-one-as-text | 5/6 | 5/6 | 2/2 | 3/3 | 3/3 | 3/3 | 2/3 |
| reg-claim-after-preview | 5/6 | 5/6 | 2/2 | 3/3 | 3/3 | 3/3 | 3/3 |
| limit-consecutive-days | 4/6 | 3/6 | 2/2 | 2/3 | 3/3 | 1/3 | 2/3 |
| sg-moh-rest-rule | 6/6 | 6/6 | 0/2 | 3/3 | 2/3 | 3/3 | 0/3 |
| repair-understaffed-night | 0/6 | 0/6 | 0/2 | 0/3 | 0/3 | 0/3 | 0/3 |

### How the extra candidates were picked

The source was the live `https://openrouter.ai/api/v1/models` list: 458 models, 390 with `tools`. Each model's `/endpoints` data gives p50 latency and throughput for the last 30 minutes. OpenRouter returns those stats only to an authenticated request. The filters were `tools` support, output price at or below $4/M, released in the last 9 months, and ranked by median provider throughput. Snapshot at the time of the run (p50 latency / p50 tok/s):

- `openai/gpt-6-luna`: released 4 days before this run, $0.10/$0.50 per M, 1.3-4.9 s / 74-135 tok/s depending on provider.
- `google/gemini-3.8-flash`: $0.75/$3.75 per M (tiered from $0.375 to $1.35), about 1.5-2.4 s / 126-189 tok/s on AI Studio.
- For reference, `deepseek/deepseek-v4.1-flash` had 24 providers with p50 throughput from 11 to 220 tok/s. `z-ai/glm-5.3-flash` had 29 providers with a **median of 30 tok/s** (4-96). `anthropic/claude-sonnet-4.5` ran at 0.9-7 s / 24-46 tok/s.

Other fast options seen but not run, to stay within the two-candidate limit: `nvidia/nemotron-3.5-lightning` (0.4 s, 161 tok/s, $0.08/$0.20), `inception/mercury-2.5` (a diffusion model, 164 tok/s), `mistralai/mistral-small-2603` (0.4 s, 90 tok/s), `anthropic/claude-haiku-4.5` (0.65 s, 60-80 tok/s, $1/$5).

## Findings

1. **Routing matters more than the model.** The app sets no OpenRouter provider preferences. By default OpenRouter will "load balance requests across providers, prioritizing price" ([provider selection docs](https://openrouter.ai/docs/guides/routing/provider-selection)). It picks "weighted by inverse square of the price". For DeepSeek that often means an 11-30 tok/s endpoint. `:nitro` sorts by throughput. It halved DeepSeek's TTFT, turn time and p90 tails. The cost per turn went up about 45%, from $0.0044 to $0.0064. That is still about 1/20 of Sonnet 4.5.
2. **DeepSeek V4.1 Flash with `:nitro` is the fastest configuration tested.** It beats Sonnet 4.5 on every latency number except TTFT p90, where they are about even (2.9 against 3.1 s). Its quality is as good as any other model here, within noise.
3. **GLM 5.3 Flash is too slow.** It has the worst tails (turn p90 28 s). `:nitro` did not help (turn p90 38 s in this window), because all its providers are slow. Its quality matched the best, but users would wait.
4. **Gemini 3.8 Flash** tied for the best pass rate. It had no judge failures and passed 100% of the tools gate. But its first token is slow (4.9 s p50), probably from reasoning, which the app does not limit. It costs about 4x DeepSeek per turn.
5. **GPT-6 Luna** starts fast, but its quality is the weakest. It went 0/3 on the knowledge case: it did not state MOH's position clearly or offer a rule. One of its turns ended with no reply.
6. **Sonnet 4.5** has the steadiest latency (TTFT p90 3.1 s). But on `sg-moh-rest-rule` it failed both trials: a yes/no offer in plain text, a long reply, two questions. It costs about 20x DeepSeek with `:nitro`.
7. There were no safety-gate failures and no timeouts in any of the 139 trials.

## Recommendation

- **Default: `deepseek/deepseek-v4.1-flash` with throughput routing (`:nitro`)**. It had the lowest latency, quality as good as any model tested, and costs about $0.006 per turn.
- **Fallback: `anthropic/claude-sonnet-4.5`**, today's default. Use it when DeepSeek is unavailable. It is from a different vendor, and its latency is steady (TTFT p90 3.1 s, turn p90 11 s). It costs about 20x more, but only while in use. If cost matters more than latency, use `google/gemini-3.8-flash`. Its quality was as good and it costs 1/5 of Sonnet, but its TTFT is about 2x slower.
- **Drop GLM 5.3 Flash** because of its latency tails, and **GPT-6 Luna** because of its quality.

The new default needs a code change, not made here. The docs say `:nitro` "is not a separate entry in the models API". So a `:nitro` slug in `RECOMMENDED_MODEL_ID` would match no catalog row, and `pickRecommended` would pick the first row. Option one: add `:nitro`, or `provider: { sort: "throughput" }`, in `web/lib/ai/runtime/openrouter-agent.ts`. Option two: add the `:nitro` slug to the catalog as an extra row. Run the probe against the chosen slug.

## Caveats

- **The trial counts are small.** Without the repair case there are 13-26 scored trials per model, and 9 for Sonnet. Pass-rate gaps under about 15 points are noise. The finding is "no model is clearly better", not a ranking.
- **The judge is not deterministic.** Its calibration agreement is 34-36/37. Of each model's failures, 2-6 are judge items (tone, one question, suggests a default). The judge can flip these between reruns.
- **An app regression (bead nursing-sheduler-20wo)** breaks `repair-understaffed-night` on every model. `prepare_borrowed_cover` and `get_roster` return "There is no saved roster yet". No follow-up arrives after Apply. The eval code from before this branch fails the same way, so the timing change is not the cause. So the repair path is untested here, and it is the case with the most tool use.
- **Latency depends on the time window.** Provider load changes over the day. Each model ran in one window of about 5-15 minutes, and only DeepSeek was repeated. The GLM `:nitro` result is probably a bad window, not a routing effect.
- Our TTFT includes the large system prompt, client overhead and reasoning time. So it is higher than OpenRouter's provider TTFT.
- Sonnet 4.5 had 2 trials per case. Neither this run nor the 2026-09-24 run gives a full-suite pass rate.
- `:nitro` was only used as an eval model slug. The eval passes the slug through unchanged. It did not record which provider served each call.

## Spend

Total recorded spend for 46g was **$7.35**, against a $15 cap. The main runs cost $6.80 and the DeepSeek repeat $0.53. A smoke trial cost $0.011 and the regression check $0.006. The planned-cost guard stopped two earlier attempts before they spent anything.
