# Lane 2 — Playwright on GitHub Actions: research + sharding plan

Date: 2026-09-26 · Repo: kenan-xin/nursing-sheduler (PRIVATE) · Scope: read-only research
Measured from: `gh run view 36221607608` (full success, develop-fix branch, 2026-09-26 05:42–06:08 UTC)
and `gh run view 36221230554` (second sample for variance). All timings below are from these two runs.

---

## 1. TL;DR — ranked recommendations

| # | Change | Wall saved | Effort | Risk |
|---|--------|-----------|--------|------|
| R1 | Shard the base e2e suite ×4 with `--shard=N/4` + blob reporter + `merge-reports` job | ~6–8 min | M | Low |
| R2 | Build Next **once** in a dedicated job, share `.next` as an artifact to all shards | ~1.5–2.5 min | M | Low-Med |
| R3 | Run the focused `public-roster-dispatch` spec as a parallel job on the shared build (kills its 2nd build) | ~0.5–1 min | S | Low |
| R4 | Keep `runs-on: ubuntu-24.04` on **every** shard; optionally pin the mcr Playwright container | 0 min (+ determinism) | S | Med |
| R5 | Gate e2e on a fast typecheck/lint job instead of the full `checks` job (unit tests run in parallel) | ~5–7 min more | M | Med |
| R6 | Small wins: `setup-node` `cache: pnpm`, add `github` reporter, keep `--with-deps chromium` (no browser cache) | ~0.5 min | S | Low |

**Expected wall time:** today **22–25.4 min** (measured 21m40s and 25m23s).
Plan A (R1–R4, keeps `needs: checks` gating): **~16–18 min**.
Plan B (A + R5): **~10–12 min**.
Compute cost: private repo → e2e-phase runner-minutes grow ~4× (see §4.5).

---

## 2. Measured step timings

### Run 36221607608 (slower sample) — wall 25m23s

| Job (start → end) | Total | Dominant steps |
|---|---|---|
| `checks` 05:42:45→05:52:59 | **10m14s** | Unit tests **7m24s** (7483 passed / 76 skipped of 7559); Build 1m16s; Typecheck 23s; pnpm install 25s; backend pip deps 16s; Lint 4s; Format 2s |
| `e2e` 05:53:03→06:08:08 | **15m05s** | Run e2e **12m33s** (incl. webServer build); focused-dispatch run **1m22s**; Install Playwright browser 28s; pnpm install 24s |
| `core` 05:42:46→05:48:51 | 6m05s | Pytest 5m03s (not on e2e critical path) |

Key derived numbers (from the e2e job log):

- webServer `next build` inside "Run e2e": `05:54:10.8 → 05:55:26.2` = **75s**, then `node scripts/start-standalone.mjs`.
- Base suite result: **645 passed (12.5m)** — i.e. ~**8–11 min of pure test execution at 2 workers** (step total minus build+start).
- Focused dispatch run: **3 passed (1.3m)** — ~75s of that is a **second full `next build`** (`reuseExistingServer: false`, own `pnpm build && pnpm start` webServer).
- e2e began 4s after `checks` finished → the `needs: checks` edge is the whole serialization.

### Run 36221230554 (faster sample) — wall 21m40s

| Job | Total | Notes |
|---|---|---|
| `checks` | 10m14s | Identical shape |
| `e2e` | **11m24s** | "Run e2e" **9m22s**; focused **54s**; pnpm install 47s (runner variance) |
| `core` | 5m28s | |

Variance on the base e2e step across the two runs: **9m22s – 12m33s** (~±15%). Estimates below use midpoints.

### Worker count on CI (the parallelism math)

`web/playwright.workers.ts` resolves `clamp(floor(cpus/2), 1, 8)`. GitHub standard `ubuntu-24.04` runners
have **4 vCPUs** → CI runs **2 workers** for 645 tests. The qq0.29 audit (recorded in the file) showed
the safe oversubscription ratio is ≤0.5× cores (16 workers passed on 32 cores; failures at 1.5–2×).
So **2 workers on a 4-core runner is already the audited maximum** — raising it would reintroduce the
CPU-starvation flake the cap exists to prevent. The lever is **more 4-core runners (shards)**, not more
workers per runner. (Official docs recommend `workers: 1` in CI for stability; this repo has better,
measured evidence for 2. Endform's "50% → try 75–100%" guidance lands where the repo already is.)

---

## 3. Where the minutes go (critical path)

```
t=0        checks (10m14s) ──────────────────────────────┐
t=10m14s   e2e: setup 40s + browser 28s + [build 75s    │ serialization
           + start 15s + tests ~8-11m] + focused 54-82s │ = wall
t=21-25m   done ◄───────────────────────────────────────┘
```

- **Serialization (~10 min):** `needs: checks` makes e2e start only after 7m24s of vitest it doesn't depend on.
- **Double build (~2.5 min):** two full `next build` runs per e2e job (base config + focused config).
- **Single-runner test execution (~8–11 min at 2 workers ≈ 22 worker-min):** the only part sharding attacks.
- **Fixed per-job costs (~1.5–2 min):** checkout+pnpm+node ~12s, pnpm install 24–47s, browser install 28s.
  These get *multiplied* by sharding, which caps useful shard count (§4.4).

The endform decision rule — shard when a single runner can't finish inside the PR window, ~10+ min —
is met exactly: 645 tests take 8–11 min of execution. (Endform also says try a bigger runner first;
for a **private** repo, larger runners are billed at higher multipliers, and 2×4-core shard runners beat
1×8-core on price while keeping the audited worker ratio. Standard runners also keep the platform contract.)

---

## 4. The sharding plan

### 4.1 `web/playwright.config.ts` changes (2 small diffs)

a) Blob reporter in CI (required for merge-reports), plus `github` annotations (R6):

```ts
  // was: reporter: "list",
  reporter: process.env.CI
    ? [["blob"], ["github"]]   // blob → merged after shards; github → inline annotations
    : "list",
```

b) Prebuilt-server switch so shards skip the build (R2) — build env must stay identical
(`NEXT_PUBLIC_NS_TEST_BRIDGE=1` is **compile-time** inlined; the artifact is useless without it):

```ts
  webServer: {
    // CI prebuilds once and ships .next as an artifact; shards only start the server.
    command: process.env.PW_PREBUILT ? "pnpm start" : "pnpm build && pnpm start",
    ...
  }
```

### 4.2 Workflow: build once → 4 shards → merge (Plan A)

Keep `runs-on: ubuntu-24.04` **in every matrix leg** — the pinned OS is part of the screenshot-baseline
contract (see the comment in `ci.yml`), and sharding must not vary the rendering environment.
`fullyParallel: true` (already set) makes Playwright balance **per test**, so 645 tests split ~161/shard.

```yaml
  e2e-build:
    name: e2e build (shared Next artifact)
    runs-on: ubuntu-24.04
    needs: checks                 # Plan A gating (Plan B: needs: fast-gate, see §4.6)
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { package_json_file: web/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 24.14.0 }
      - run: pnpm install --frozen-lockfile
      # Same env the webServer used, because NEXT_PUBLIC_* is inlined at build time:
      - name: Build (e2e env)
        run: pnpm build
        env:
          NEXT_PUBLIC_NS_TEST_BRIDGE: "1"
      - uses: actions/upload-artifact@v4
        with:
          name: next-e2e-build
          path: |
            web/.next
            web/public
          retention-days: 1

  e2e:
    name: e2e (shard ${{ matrix.shardIndex }}/${{ matrix.shardTotal }})
    runs-on: ubuntu-24.04         # PINNED — screenshot-baseline contract, every leg
    needs: e2e-build
    strategy:
      fail-fast: false
      matrix:
        shardIndex: [1, 2, 3, 4]
        shardTotal: [4]
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { package_json_file: web/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 24.14.0 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - uses: actions/download-artifact@v4
        with: { name: next-e2e-build, path: web }
      - name: Run e2e shard
        env: { PW_PREBUILT: "1" }
        run: pnpm exec playwright test --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}
      - name: Upload blob report
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with: { name: blob-report-${{ matrix.shardIndex }}, path: web/blob-report, retention-days: 1 }

  merge-reports:
    if: ${{ !cancelled() }}        # merge even when a shard fails
    needs: [e2e]
    runs-on: ubuntu-24.04
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { package_json_file: web/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 24.14.0 }
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with: { path: all-blob-reports, pattern: blob-report-*, merge-multiple: true }
      - run: pnpm exec playwright merge-reports --reporter html,github ../all-blob-reports
      - uses: actions/upload-artifact@v4
        with: { name: e2e-html-report, path: web/playwright-report, retention-days: 14 }
```

### 4.3 Focused dispatch spec (R3)

Move `pnpm test:e2e:public-roster-dispatch` out of the e2e job into a sibling job
`e2e-focused` with the same steps as a shard but:

```yaml
      - name: Run public-roster-dispatch e2e
        env: { PW_PREBUILT: "1" }
        run: pnpm test:e2e:public-roster-dispatch
```

and `PW_PREBUILT` honored in that config's webServer too (drop its forced second build; the
"fresh build" guarantee moves to the e2e-build job, which is fresh per run anyway). It still runs
after the base gate ordering-wise only if you keep `needs: [e2e-build]` — it can run **concurrently**
with the shards; nothing shares state (distinct port 3101, stub backend 8765).

### 4.4 Why 4 shards

| Shards | Tests/shard | Test time (2 workers) | Fixed cost/shard | Shard wall | Runner-min (e2e phase) |
|---|---|---|---|---|---|
| 1 (today) | 645 | 8–11 min | ~1.5 min | 9.4–12.6 min | ~15 |
| 4 | ~161 | 2–2.8 min | ~1.6 min | **~4–4.5 min** | ~25 |
| 8 | ~81 | 1–1.4 min | ~1.6 min | ~2.7–3 min | ~45 |

Fixed costs (setup + install + artifact download + server start) stop shrinking, so 8 shards buys
~1.5 min of wall for ~2× the compute. **4 shards is the sweet spot**; keep the count in one matrix
list so it's a one-line change as the suite grows. With `fullyParallel: true` the split is per-test
(per the sharding docs), so no manual file balancing is needed.

### 4.5 Expected wall time

| Phase | Today | Plan A (R1–R4) | Plan B (+R5) |
|---|---|---|---|
| checks (unit+build) | 10m14s | 10m14s | runs parallel, not on e2e path |
| e2e-build | — (inside e2e) | 1.75m (build 75s + setup/upload) | 1.75m |
| e2e shards | 12.5m base + 1.4m focused | **~4.5m** (slowest shard) | **~4.5m** |
| merge-reports | — | ~1m | ~1m |
| **Wall (PR)** | **22–25.4m** | **~16–18m** | **~10–12m** |

Plan B (R5) shape: `fast-gate` job (setup+install+typecheck 23s+lint 4s+format 2s ≈ **1.6m**) gates
e2e-build; `checks` (with its 7m24s vitest) and `core` run unblock-ed in parallel. e2e branch:
1.6 + 1.75 + 4.5 + 1 ≈ 9m; wall set by parallel checks ≈ 10–12m.
Trade-offs: e2e may run on commits that fail unit tests (wasted minutes only); merge queue / branch
protection should still require *both* the e2e chain and `checks`.

Compute cost (private repo, metered): e2e phase goes from ~15 runner-min to ~25 (Plan A) —
+10 Linux min/run; Plan B adds ~3 more. At many-PRs-per-day scale that's the price of ~13 min wall.

### 4.6 Optional: container image (R4, determinism only)

Official docs recommend the Playwright container precisely for "a consistent environment for
screenshots/visual regression testing" — this repo's baseline contract (`mcr.microsoft.com/playwright:v1.61.1-noble`
is cited in `ci.yml` as the baseline-generation env) argues for it:

```yaml
    container:
      image: mcr.microsoft.com/playwright:v1.61.1-noble   # == @playwright/test 1.61.1, noble = ubuntu 24.04
      options: --user 1001
```

Time impact is roughly neutral (saves the 28s browser install, adds a ~1–2GB image pull), so treat it
as a **contract hardening**, not a speed change. Risks: pnpm must be bootstrapped via corepack inside
the container; workspace path permissions with `--user 1001`. Keep the runner label `ubuntu-24.04`
underneath (the container's noble userland, not the host, is what the browsers see — but keeping both
aligned is the safest reading of the existing contract comment).

---

## 5. What NOT to do (anti-recommendations)

1. **Don't cache browser binaries.** Official CI docs now explicitly advise against it ("restore time
   comparable to download"), and this repo installs **chromium only** (28s measured) — there's almost
   nothing to win. Also don't install all three browsers "just in case": the config has exactly two
   projects, both Chromium-based.
2. **Don't raise workers per runner** (e.g. `PLAYWRIGHT_WORKERS=4` in CI): violates the measured
   qq0.29 ratio (≤0.5× cores) and reintroduces the 30s-timeout CPU-starvation flake. Add shards instead.
3. **Don't let matrix legs vary OS or runner image.** The e2e lane must stay `ubuntu-24.04` everywhere;
   the baseline filenames encode platform only, so a rolling alias or a different leg OS silently
   invalidates them.
4. **Don't reuse the `checks` job's build artifact as-is.** It builds *without*
   `NEXT_PUBLIC_NS_TEST_BRIDGE=1`, so the test bridge is dead code in that artifact and the e2e suite
   would fail confusingly. The shared artifact must be built with the e2e env (§4.2).
5. **Don't shard the focused-dispatch spec together with the base suite.** Its config exists precisely
   because its env (`BACKEND_API_URL` → stub port) collides with the base webServer's assumptions;
   keep it a separate (parallel) job.

## 6. Sources

- https://endform.dev/blog/playwright-github-actions — browser-install costs, CI `workers: 1` scaffold trap,
  4-core public/2-core private runner table, "bigger runner before sharding", shard decision rule (>200
  tests / 10+ min), `github` reporter + HTML artifact upload pattern.
- https://playwright.dev/docs/test-sharding — `--shard=x/y`, blob reporter + `merge-reports`, matrix
  example with `shardIndex/shardTotal`, `if: !cancelled()`, `merge-multiple: true`, fullyParallel test-level balancing.
- https://playwright.dev/docs/ci — workers guidance, container example (`--user 1001`), **caching browsers
  not recommended**, `--only-changed` fail-fast option (not proposed here: suite fits budget after R1–R3).
- https://playwright.dev/docs/docker — pinned image tags must match the `@playwright/test` version.
- Measured: `gh run view 36221607608` / `36221230554` (jobs + step `startedAt/completedAt`, job logs for
  webServer build timestamps and "645 passed (12.5m)" / "3 passed (1.3m)").
- Repo files: `.github/workflows/ci.yml`, `web/playwright.config.ts`, `web/playwright.workers.ts`,
  `web/playwright.public-roster-dispatch.config.ts`, `web/package.json`.
