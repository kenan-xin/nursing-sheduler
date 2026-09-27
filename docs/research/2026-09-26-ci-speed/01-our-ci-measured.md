# Lane 1 — Our CI, measured (n=15 successful runs, 2026-09-24 → 2026-09-26)

Repo: kenan-xin/nursing-sheduler, workflow `.github/workflows/ci.yml` (jobs: `checks`, `core`, `e2e`).
Data: `gh run view <id> --json jobs` step `startedAt`/`completedAt` for 15 recent successful runs (12 PR + 3 develop push).
NOTE: the local worktree's ci.yml is stale (no `core` job); measurements and snippets use **develop's** ci.yml fetched via the GitHub API.

## TL;DR

- **Wall per PR ≈ 25 min (median 24.4, range 21.7–26.7).** It is almost exactly `checks + e2e`: the `e2e` job starts ~6 s after `checks` ends (measured across all 15 runs — no queue delay, pure `needs: checks` serialization).
- **Critical path:** `checks.Unit tests` (7.4 m) → `checks.Build` (1.3 m) → `e2e.Run e2e` (12.6 m, includes a *second* full `next build` inside the webServer) → `e2e.Run public-roster-dispatch` (1.4 m, includes a *third* `next build`).
- **The `core` job (median 6.0 m) never matters** — it runs in parallel and finishes long before the wall.
- **CI runs Playwright with 2 workers**, not 8: `resolveWorkerCount` = `floor(cpus/2)` and GitHub-hosted runners have 4 vCPU. The 8-cap never binds.
- Biggest lever is structural, not caching: **run e2e concurrently with checks and shard it** → est. wall **~8–11 m (−14 to −17 m)**. Install/browser/next caches are worth ≪1 m each because installs already measure tiny (pnpm 0.4 m, browser 0.5 m, build 1.3 m).

## Measured step timings (medians across 15 runs)

| Job | Step | Median | Min | Max |
|---|---|---:|---:|---:|
| checks | **Unit tests (vitest ~7500)** | **7.4 m** | 4.5 m | 7.7 m |
| checks | Build (`next build`) | 1.3 m | 0.8 m | 1.4 m |
| checks | Typecheck | 0.4 m | 0.2 m | 0.4 m |
| checks | Install dependencies (pnpm) | 0.4 m | 0.3 m | 0.5 m |
| checks | Install backend deps (pip) | 0.3 m | 0.2 m | 0.3 m |
| checks | Lint + Format + setup steps | ~0.5 m | — | — |
| **checks total** | | **10.2 m** | 6.8 m | 10.7 m |
| e2e | **Run e2e (webServer `pnpm build && pnpm start` + ~640 tests, 2 workers, retries=2)** | **12.6 m** | 9.4 m | 13.5 m |
| e2e | Run public-roster-dispatch e2e (own config, `reuseExistingServer: false` → rebuilds) | 1.4 m | 0.9 m | 1.5 m |
| e2e | Install Playwright browser (`--with-deps chromium`) | 0.5 m | 0.4 m | 0.6 m |
| e2e | Install dependencies (pnpm) | 0.4 m | 0.4 m | 0.5 m |
| **e2e total** | | **15.1 m** | 11.4 m | 16.1 m |
| core | Pytest (memory/fakeredis/real Redis) | 4.9 m | 3.2 m | 5.3 m |
| core | pip install + GLPK + ruff + replay | ~1.1 m | — | — |
| **core total (parallel, off critical path)** | | **6.0 m** | 4.2 m | 6.4 m |
| **Run wall (first job start → last job end)** | | **24.4 m** | 21.7 m | 26.7 m |

Per-run walls (all 15): 26.7, 26.3, 26.0, 25.7, 25.6, 25.4, 25.4, 25.2, 25.1, 24.4, 24.1, 23.0, 22.9, 22.0, 21.7 min.

Per-run detail for one representative develop push ([36222856010](https://github.com/kenan-xin/nursing-sheduler/actions/runs/36222856010), wall 27.1 m incl. ~35 s queue):

- checks 06:08:54→06:19:27 (10.5 m): unit tests 06:10:31→06:18:02 (7.5 m), build 1.4 m, typecheck 24 s, pnpm install 25 s, pip 17 s.
- e2e 06:19:33→06:35:34 (16.0 m): started **6 s** after checks ended; Run e2e 13.5 m; dispatch 1.5 m; browser install 27 s; pnpm install 25 s.
- core 06:08:53→06:15:11 (6.3 m): pytest 5.2 m.

## Evaluation of the proposed levers (ranked)

### 1. Drop `needs: checks` (or narrow it) — run e2e concurrently — **saves ~10 m wall, effort S, risk M**

`needs: checks` puts all of checks (10.2 m median) on the e2e critical path while e2e (15.1 m) idles a runner. Running both concurrently caps wall at max(checks, e2e) ≈ **15 m → ~15 m today, less after #2**. Downside: a PR with failing unit tests still burns ~8–15 m of e2e runner time (order of 1 extra runner-hour per red PR). Keep branch protection honest with a final aggregate gate job:

```yaml
  e2e:
    # needs: checks   # removed — e2e no longer waits for checks
    runs-on: ubuntu-24.04
    # ... unchanged steps (keep ubuntu-24.04 pin + baseline contract)

  gate:               # required status check becomes `CI / gate`
    needs: [checks, e2e]
    runs-on: ubuntu-latest
    if: always()
    steps:
      - run: |
          [[ "${{ needs.checks.result }}" == "success" && "${{ needs.e2e.result }}" == "success" ]] \
            || { echo "checks=${{ needs.checks.result }} e2e=${{ needs.e2e.result }}"; exit 1; }
```

Variant (narrower, risk L): keep `needs` but split `checks` into `checks-fast` (typecheck+lint+format+build, ~2.5 m) and `unit` (7.4 m, parallel); e2e `needs: checks-fast`. Wall ≈ max(unit, checks-fast + e2e) ≈ 18 m (−7 m).

### 2. Shard the e2e suite ×2 (matrix) — **saves ~6–7 m wall, effort M, risk L-M**

12.6 m of "Run e2e" is ~640 tests over **2 workers** (floor(4 vCPU/2)). Sharding doubles the machine budget without touching the worker-cap policy (each shard still runs 2 workers, same determinism contract):

```yaml
  e2e:
    needs: checks        # or dropped per #1
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2]
    steps:
      # ...same setup steps...
      - name: Run e2e
        run: pnpm exec playwright test --shard=${{ matrix.shard }}/2
      # keep the dispatch lane in shard 1 only (it rebuilds; see #3)
      - name: Run public-roster-dispatch e2e
        if: matrix.shard == 1
        run: pnpm test:e2e:public-roster-dispatch
```

Math: ~5.5 m tests/shard + ~1.3 m webServer build + ~1 m setup ≈ 8 m/shard, parallel → e2e job 15.1 → ~8 m. With #1, wall ≈ max(checks 10.2, e2e 8) ≈ **~10.5 m (−14 m)**. Reference: https://playwright.dev/docs/test-sharding (GitHub Pages report merge optional — job pass/fail suffices).

### 3. Eliminate the third `next build` (dispatch lane) — **saves ~1.3 m, effort S, risk L**

Each run performs **three** full production builds: `checks.Build` (1.3 m), e2e base webServer `pnpm build && pnpm start` (inside the 12.6 m), and the dispatch lane's own `pnpm build && pnpm start` with `reuseExistingServer: false` (playwright.public-roster-dispatch.config.ts:36,53). The dispatch run executes seconds after the base run in the same job on the same SHA — the base lane's `.next/standalone` is fresh by construction. Its "stale server" concern (config comment: "stale server never false-greens") concerns a stale *server*, not a stale commit; the roster route exists in the same-SHA artifact. `BACKEND_API_URL` is read at server start (server-side env), not baked into the client bundle, so one build serves both lanes:

```ts
// playwright.public-roster-dispatch.config.ts
webServer: {
  command: process.env.CI ? "pnpm start" : "pnpm build && pnpm start",
  // ...rest unchanged; keep reuseExistingServer: false locally
}
```

(If this lands after sharding, shard-1 keeps this step; savings per run unchanged.)

### 4. Reuse the checks build artifact in e2e — **saves ~0.5–1 m net, effort M, risk M — probably skip**

Saves e2e's `pnpm build` (~1.3 m) at the cost of upload/download of `.next` (+standalone, order 100 MB, ~0.5–1 m). Two correctness traps: (a) `NEXT_PUBLIC_NS_TEST_BRIDGE=1` and `NS_ENABLE_DEV_FIXTURES=1` are **build-time** env baked into the bundle (playwright.config.ts:99–104) — checks builds *without* them, so a reused artifact changes what e2e tests unless checks adopts the same env; (b) caching `web/.next/cache` only speeds the three builds by ~20–40 s each given the 1.3 m measured build. Verdict: low ROI, real correctness surface.

### 5. pnpm store cache + Playwright browser cache — **saves ~0.5 m total, effort S, risk L — freebie only**

Measured installs are already tiny (pnpm 0.4 m per job, browser 0.5 m). Still, two free lines:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 24.14.0
          cache: pnpm                      # needs pnpm/action-setup to run first (it does)
      - uses: actions/cache@v4             # e2e job only
        if: ${{ hashFiles('web/package-lock.json') != '' }} == false   # guard not needed; illustrative
        with:
          path: ~/.cache/ms-playwright
          key: ms-playwright-${{ runner.os }}-${{ hashFiles('web/pnpm-lock.yaml') }}
```

(Simpler, robust key: read the installed version — `pnpm exec playwright --version` — into a step output and key on it.)

### 6. `mcr.microsoft.com/playwright` container image — **saves ≈ 0 m, effort M, risk M — skip**

`Install Playwright browser` measures **27 s**; a 1.5–2 GB image pull is comparable, and the job must stay pinned to an environment bit-compatible with the screenshot-baseline contract (baselines were generated *in* `mcr.microsoft.com/playwright:v1.61.1-noble`, per the ci.yml comment — the runner + pinned install currently matches it). Swap risk for ~0 gain.

### 7. Paths filters (docs-only / core-only PRs skip web jobs) — **saves ~19 m on docs-only/core-only PRs, effort M, risk M**

Web jobs cost ~25 m wall; `core` alone ~6 m. Filter so docs-only PRs run nothing (or only `core`) and core-only PRs skip `checks`/`e2e`. Use `dorny/paths-filter` in a first job rather than workflow-level `paths:` — workflow-level filtering *removes* the check run entirely, which can wedge required-status-check branch protection; a job-level `if:` that skips still reports and a skipped required job counts as satisfied (GitHub docs: "Handling skipped but required checks").

```yaml
  changes:
    runs-on: ubuntu-latest
    outputs:
      web: ${{ steps.f.outputs.web }}
      core: ${{ steps.f.outputs.core }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: f
        with:
          filters: |
            web:
              - 'web/**'
              - '.github/workflows/ci.yml'
            core:
              - 'core/**'
              - '.github/workflows/ci.yml'

  checks:
    needs: changes
    if: ${{ needs.changes.outputs.web == 'true' }}
    # ...
  e2e:
    needs: [changes, checks]
    if: ${{ !cancelled() && needs.changes.outputs.web == 'true' }}
    # ...
  core:
    needs: changes
    if: ${{ needs.changes.outputs.core == 'true' }}
```

Risk: required-check semantics must be re-pointed at the aggregate `gate` job (see #1) so skipped paths still merge cleanly; touch `.github/workflows/ci.yml` always runs everything.

### 8. Split unit tests off the critical path / shard vitest — **saves ~3–4 m on checks, effort M, risk L**

`Unit tests` is 7.4 m of checks' 10.2 m. If #1 makes checks non-critical this stops mattering for wall time (only red-PR signal latency). If checks stays required-gate-only-fast (#1 variant), move vitest to its own parallel job, or shard: `vitest run --shard=1/2` via matrix (~4 m/shard). Vitest config (web/vitest.config.ts) has no pool overrides; default forks-pool on 4 vCPU is already near-saturated — sharding, not pool tuning, is the lever.

### Already in place — no action

- **Concurrency + cancel-in-progress**: `concurrency.group: ci-CI-<ref>`, `cancel-in-progress: true` (ci.yml:9–11). Verified working in the data: 8 of the 30 most recent runs were cancelled as superseded on 2026-09-26 alone. No further gain available from this lever.
- **pip cache** on setup-python already present.

## Combined estimate

| Scenario | Est. wall per PR | Δ |
|---|---:|---:|
| Today (measured median) | 24.4–25 m | — |
| + #1 drop needs (+ gate) | ~15 m | −10 m |
| + #2 shard e2e ×2 | ~10.5 m | −4.5 m |
| + #3 kill 3rd build | ~9.5 m | −1 m |
| + #8 split unit job (checks ≈ 3 m fast gate) | **~8–9 m** | **−16 m total** |

## Sources

- Measured: `gh run view <id> --json jobs` for runs 36222856010, 36221060543, 36219802049 (develop) and 36221607608, 36221230554, 36221225218, 36221221451, 36221217517, 36221213820, 36221210055, 36221206786, 36221108626, 36219828888, 36219828746, 36218868143 (PRs), 2026-09-24→26. Example: https://github.com/kenan-xin/nursing-sheduler/actions/runs/36222856010
- Workflow (develop): `.github/workflows/ci.yml` via `gh api repos/kenan-xin/nursing-sheduler/contents/.github/workflows/ci.yml?ref=develop`; local worktree copy is stale (predates the `core` job).
- Configs: `web/playwright.config.ts` (workers, webServer, retries=2), `web/playwright.workers.ts` (`floor(cpus/2)`, cap 8), `web/playwright.public-roster-dispatch.config.ts` (third build), `web/vitest.config.ts`, `web/package.json` scripts, `web/next.config.*` (`output: "standalone"`).
- Docs: Playwright sharding https://playwright.dev/docs/test-sharding · parallel workers https://playwright.dev/docs/test-parallel · CI caching https://playwright.dev/docs/ci · Playwright Docker https://playwright.dev/docs/docker · setup-node pnpm cache https://github.com/actions/setup-node#caching-global-packages · dorny/paths-filter https://github.com/dorny/paths-filter · skipped-but-required checks https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branch-protection-rules/troubleshooting-required-status-checks

## Caveats

- n=15 successful runs over 3 days; unit-test duration varies with which specs a PR touches (4.5–7.7 m), so medians, not point estimates.
- Worker count in CI (2) is inferred from `resolveWorkerCount` + GitHub's documented 4-vCPU standard runners, not read from logs; `PLAYWRIGHT_WORKERS` unset in ci.yml confirms the computed path.
- Savings estimates for sharding/worker changes are arithmetic projections from the measured 12.6 m, not measured; A/B on a branch before committing (the workers file's own audit warns about oversubscription on small hosts).
- Untested assumption in #3: `BACKEND_API_URL` is consumed at standalone-server start only (server-side), never baked into client code. Verify with `grep -r NEXT_PUBLIC` usage before relying on it.
