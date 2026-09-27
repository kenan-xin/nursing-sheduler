# CI speed-up plan

Date: 2026-09-26. Sources: three research lanes run as Orca workers (opencode, `zai-coding-plan/glm-5.3-flash`), in this folder:

- `01-our-ci-measured.md`: step timings from 15 successful runs.
- `02-playwright-sharding.md`: Playwright on GitHub Actions (starts from https://endform.dev/blog/playwright-github-actions) and a sharding plan.
- `03-unit-and-core.md`: Vitest, `next build` and core pytest.

Confidence: 7.5/10 that the target is reached without rework. The timings are measured, and every lever is a documented GitHub Actions or Playwright feature. The risks are shard balance, the new pytest-xdist run against the real-Redis and process tests, and required-check names that change.

## 1. Today

A PR takes 24.4 min (median of 15 runs, range 21.7 to 26.7). The time is almost exactly `checks` plus `e2e`, because `e2e` has `needs: checks` and starts about 6 s after `checks` ends.

| Job | Median | Main cost |
|---|---:|---|
| `checks` | 10.2 min | Vitest 7.4 min, `next build` 1.3 min |
| `e2e` (after `checks`) | 15.1 min | 645 tests at 2 workers 12.6 min, including a second `next build`; the focused dispatch spec 1.4 min, including a third `next build` |
| `core` (parallel) | 6.0 min | pytest 4.9 min, single process |

Caches do not help much. pnpm install takes 0.4 min, the browser install 0.5 min, and lint plus format 6 s.

## 2. Target

```
static (typecheck, lint, format, ~1.6 min)
  -> e2e-build (one next build, upload artifact, ~1.8 min)
       -> e2e shard 1..4 (ubuntu-24.04, 2 workers each, ~4.5 min)
       -> e2e-dispatch (focused spec on the shared build)
            -> e2e-report (merge blob reports, ~1 min)
unit shard 1..2 (vitest --shard, parallel, ~4 to 5 min)
build (next build check, parallel)
core (pytest -n auto, parallel, ~3 min)
```

Expected PR wall time: about 9 to 11 min, down from about 24.4 min. Runner minutes per run rise from about 31 to about 45, because more jobs repeat setup.

## 3. Steps, in order

1. Phase 1: the serialization and the unit split. This is the biggest win for the least risk.
   - Add a `static` job (typecheck, lint, format). Change `e2e` to `needs: static` instead of `needs: checks`. Lanes 1 and 2 measure this alone at about 5 to 7 min.
   - Split Vitest into a 2-shard matrix with `--shard=N/2`. Keep `next build` as its own parallel job.
   - Run core pytest with `pytest-xdist -n auto`. First check that the real-Redis and process tests are safe in parallel. If some are not, mark them to run serially.
2. Phase 2: e2e sharding.
   - Add an `e2e-build` job that builds Next once, with the e2e environment, and uploads `.next` as an artifact.
   - Run the base suite as a 4-shard matrix with the blob reporter. Every shard runs on `ubuntu-24.04`, because the screenshot baselines depend on that environment.
   - Run the focused `public-roster-dispatch` spec as its own job on the shared build. Its second `next build` goes away.
   - Merge the shard reports in an `e2e-report` job with `playwright merge-reports`.
3. Phase 3, optional, measure first: Vitest projects with happy-dom for the DOM test files (about 1 min), caching `.next/cache`, `uv` instead of pip, and an apt cache for GLPK.

## 4. What we will not do

- Raise Playwright workers per runner. On a 4-vCPU runner, 2 workers is the maximum that the qq0.29 audit found safe.
- Cache the Playwright browser binaries. The current Playwright CI docs advise against it, and the install takes only 0.5 min.
- Let shards use a different OS or runner image. The Linux screenshot baselines are tied to `ubuntu-24.04`.
- Reuse the `checks` build for e2e. It is built without the e2e environment values.

## 5. Things to change beside the workflow

- Required status checks: if branch protection lists `checks` or `e2e` by name, update it to the new job names. This repo documents that GitHub does not enforce the branch flow today.
- `web/playwright.config.ts`: add the blob reporter for sharded CI runs, and make the webServer reuse a prebuilt `.next` when one is present.
- `ship.sh` and the wave loop wait on all PR checks, so they keep working with more job names.
