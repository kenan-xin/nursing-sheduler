# Lane 3 — Speed up the non-e2e jobs (`checks`, `core`)

Repo: kenan-xin/nursing-sheduler · Workflow: `.github/workflows/ci.yml` · Measured 2026-09-26 from GH runs
36221607608 and 36221230554 (both PR runs, conclusion=success). READ-ONLY research; no repo files touched.

## TL;DR

Wall time per PR is `checks` (10m14s) + `e2e` (15m05s) ≈ **25m25s**; `core` (6m05s) runs in
parallel and is off the critical path today. Unit tests (7m24s of vitest, 7483 tests / 379 files)
dominate `checks`; the build is only 76s and **already runs on Turbopack** (Next 16 default).
The single biggest win is **splitting `checks` into static + build + 2 vitest shards** (−5:00 to
−5:30 wall); second is **vitest projects + happy-dom for the 125 DOM test files** (−0:45 to −1:00).
`core` has ~3:20 of headroom via **pytest-xdist**, which becomes relevant the moment `checks`
drops below ~6 minutes. Lint/format cost is 6s total — nothing to do there.

| Rank | Change | Wall saved | Effort | Risk |
|---|---|---|---|---|
| R1 | Split `checks` → static / build / unit×2 shards (`--shard`) | **−5:00 to −5:30** | M | Low-Med |
| R2 | `core`: pytest-xdist `-n auto` | 0 wall today; −2:45 job (buffer) | S | Low-Med |
| R3 | Vitest `projects` split + happy-dom for DOM project | **−0:45 to −1:00** | M | Med |
| R4 | `.next/cache` via `actions/cache` (official recipe) | −0:05 to −0:20 | S | Low |
| R5 | Skip typecheck inside `next build` (CI only) | −0:10 to −0:20 | S | Low-Med |
| R6 | `uv` instead of `pip` for backend installs | −0:10 to −0:15 | S | Low |
| R7 | Vitest `pool: "threads"` trial | −0:10 to −0:30 (measure) | S | Low |
| R8 | apt cache for `glpk-utils` | −0:05 to −0:10 (core only) | S | Low |
| R9 | `isolate: false` for the node project — park behind a measured trial | up to −1:00 (uncertain) | M | **High** |

Combined realistic outcome: `checks` 10:14 → **~4:45–5:30**, PR wall 25:25 → **~20:00**.

---

## Measured step timings

### Run 36221607608 (`fix/aeu-flaky-apply-nav-test`, success, 2026-09-26 05:42Z) — step seconds

| Job | Step | Sec |
|---|---|---|
| checks (10:14 total) | checkout / pnpm setup / node / python setup | 2 / 2 / 5 / 10 |
| | Install backend dependencies (pip, cached) | 16 |
| | pnpm install --frozen-lockfile | 25 |
| | Typecheck (`tsc --noEmit`) | 23 |
| | Lint (`oxlint && ast-grep scan`) | 4 |
| | Format check (`oxfmt --check .`) | 2 |
| | **Unit tests (`vitest run`)** | **444** |
| | **Build (`next build`)** | **76** |
| core (6:05 total) | redis service container init | 9 |
| | checkout / setup-python / GLPK / pip install | 3 / 10 / 11 / 19 |
| | Ruff lint + format check | ~1 |
| | **Pytest (1280 tests, single process)** | **303** |
| | Score ground-truth replay | 5 |
| e2e (15:05 total) | install deps / browser / **Run e2e** / focused run | 24 / 28 / **753** / 82 |

Variance from run 36221230554: unit 442s, build 77s, pytest 262s, GLPK 16s. Stable.

### The vitest overhead breakdown (the "import 127s / environment 72s" line)

Run 36221607608 summary line:
```
Test Files  376 passed | 3 skipped (379)
     Tests  7483 passed | 76 skipped (7559)
  Duration  442.77s (transform 12.20s, setup 30.22s, import 141.24s, tests 133.57s, environment 84.63s)
```
The quoted 127s/72s is from an earlier run; same shape — **import 141s (32%) and environment
85s (19%) are the two biggest non-test phases**. Phases overlap across workers, so these are
worker-time, not wall savings, but they identify the levers:

- **environment 84.63s**: 125 test files opt into jsdom per-file via `// @vitest-environment jsdom`
  docblocks (115 × `*.test.tsx` + 10 × `*.test.ts`; all 115 `.tsx` files are jsdom). Each jsdom
  instantiation is expensive; happy-dom is not.
- **import 141.24s**: module graph loaded per file per worker. Gains come from sharding (more
  workers overall) or, riskier, `isolate: false` module reuse.
- **setup 30.22s**: `vitest.setup.ts` imports `@testing-library/jest-dom/vitest` +
  `fake-indexeddb/auto` into every file, including the 254 pure-node files that need neither
  matcher package cost nor… (fake-indexeddb IS needed globally per the suite's design comment).
- **transform 12.20s**: already cheap. `test` timeouts: config sets no `testTimeout` (default
  5000ms) and nothing in the logs suggests near-timeout tests — **no change warranted**.

---

## R1 — Split `checks` into static / build / unit×2 shards  ⭐ biggest win

**Saves: −5:00 to −5:30 wall · Effort: M · Risk: Low-Med.** Vitest supports `--shard=i/n` in CI
([features guide](https://vitest.dev/guide/features.html)); shards are plain matrix jobs. Math from
measured steps: setup 60s + static 29s is duplicated per job; unit 444s → ~230s per shard
(file-count split, 4 vCPU per runner, already parallel within a shard). Critical path becomes the
slowest shard (~4:55) instead of the whole serial job (10:14).

Two details that matter in this repo:
- **Both shards need `PYTHON` env and the pip install** — `verify-deploy.test.ts` (runs
  `docker/validate_origin.py`) and the uvicorn-backed `dev-launcher.test.ts` can land in either
  shard, and the differential oracle imports core deps.
- Keep `e2e` waiting on an aggregate job that `needs:` every shard, so Playwright starts only when
  everything passed.

```yaml
  static:
    name: typecheck · lint · format
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { package_json_file: web/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 24.14.0 }
      - uses: actions/setup-python@v5
        id: python
        with: { python-version-file: .python-version, cache: pip, cache-dependency-path: core/requirements.txt }
      - run: python3 -m pip install -r ../core/requirements.txt
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm exec oxfmt --check .

  build:
    name: build
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { package_json_file: web/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 24.14.0 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build   # see R4/R5 for cache + typecheck-dedup

  unit:
    name: unit (${{ matrix.shard }})
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: web } }
    strategy:
      fail-fast: false
      matrix: { shard: [1, 2] }   # 3 shards → ~3:35 critical path, more billed minutes
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { package_json_file: web/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 24.14.0 }
      - uses: actions/setup-python@v5
        id: python
        with: { python-version-file: .python-version, cache: pip, cache-dependency-path: core/requirements.txt }
      - run: python3 -m pip install -r ../core/requirements.txt   # differential oracle / dev-launcher tests
      - run: pnpm install --frozen-lockfile
      - env:
          PYTHON: ${{ steps.python.outputs.python-path }}
        run: pnpm exec vitest run --shard=${{ matrix.shard }}/2
          # optional, for one merged report: --reporter=blob, then a `reports` job runs
          # `vitest run --merge-reports --reporter=junit` (vitest features guide)

  checks-ready:                       # e2e `needs:` this instead of `checks`
    name: checks aggregate
    runs-on: ubuntu-latest
    needs: [static, build, unit]
    steps: [{ run: echo ok }]
```

Cost: +~2–4 billed runner-minutes (duplicated setup). Queueing for extra hosted jobs is seconds.

## R2 — `core`: pytest-xdist `-n auto`

**Saves: 0 wall today, ~−2:45 job time · Effort: S · Risk: Low-Med.** 1280 tests take 303s in one
process on a 4-vCPU runner. `-n auto` (one worker per CPU, [xdist README](https://github.com/pytest-dev/pytest-xdist))
should land ~110–140s for CPU-bound solver tests. Safety review against this suite:

- **Real Redis is shared but namespaced**: every store instance gets a unique
  `key_prefix=f"nurse_test:{uuid4().hex}:v0"` (`core/tests/server_support.py:132,169`), so parallel
  workers cannot collide on the job `redis:8.8.0-alpine` service. Fakeredis instances are in-memory
  per test. Memory stores are process-local. ✅
- **Process tests**: `test_process_executor.py` spawns real children; `test_server_worker_loss_multiprocess.py`
  uses `multiprocessing.get_context("spawn")` — both fine inside xdist workers (each is its own
  process; xdist also restarts a crashed worker and reports the failure).
- **Timing-sensitive tests are the actual risk**: lease-expiry tests sleep wall-clock amounts
  (`LEASE_SECONDS + 0.5` in `test_server_worker_loss_multiprocess.py`; various 0.005–0.3s sleeps in
  `test_server_lifecycle_gates.py`, `test_server_worker_loss.py`). Under 4 saturated workers these
  can stretch. Mitigations: start with `-n auto --dist load` and watch for flakes; if flaky, pin
  `-n 3` or use `--dist loadscope` so the lease tests' module stays on one worker.

```yaml
      - name: Pytest (memory, fakeredis, real Redis)
        env:
          NURSE_TEST_REDIS_URL: redis://localhost:6379/0
          PYTHONPATH: .
        run: python3 -m pytest -q -rs -n auto
```
(`pytest-xdist` must be added to `core/requirements-optional.txt`.) After R1, `checks` ≈ 4:55;
without R2 `core` at 6:05 would become the new critical path — so R2 is what makes R1 pay off fully.

## R3 — Vitest `projects` split + happy-dom for the DOM project

**Saves: −0:45 to −1:00 · Effort: M · Risk: Med.** Vitest 4 removed `environmentMatchGlobs`;
[`projects`](https://vitest.dev/guide/projects.html) is the replacement. This repo is unusually
clean for it: **every `.test.tsx` already carries the jsdom docblock** (115/115); only 10 `.test.ts`
files are DOM (they keep their docblock as an override). Declare two projects, switch the DOM one to
happy-dom (jsdom instantiates ~2-3× slower per file — the 84.6s environment phase), and scope
`jest-dom` setup to the DOM project only. `@testing-library/jest-dom` and axe-core support
happy-dom, but FullCalendar/Dexie-heavy files need an audit — migrate, run the suite, and fall back
per-file via the existing `// @vitest-environment jsdom` docblock where behavior differs.

```ts
// vitest.config.ts
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "e2e/**/*.spec.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.ts"],
          setupFiles: ["./vitest.setup.node.ts"],   // fake-indexeddb/auto only
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["**/*.test.tsx", "lib/**/*.dom.test.ts" /* the 10 stragglers */],
          setupFiles: ["./vitest.setup.dom.ts"],    // jest-dom + fake-indexeddb/auto
          server: { deps: { inline: [/@copilotkit\/react-core/] } },
        },
      },
    ],
  },
});
```
Per-file docblock overrides still win, so rollback per file is one line. Sharding (R1) works
unchanged — `--shard` splits all projects' files.

## R4 — `.next/cache` via `actions/cache`

**Saves: −0:05 to −0:20 · Effort: S · Risk: Low.** The build is only 76s (already Turbopack — see
note), so the official CI caching recipe
([nextjs.org: CI build caching](https://nextjs.org/docs/app/guides/ci-build-caching)) buys little
here, but it is nearly free and also warms the e2e job's build:

```yaml
      - uses: actions/cache@v4
        with:
          path: ${{ github.workspace }}/.next/cache
          key: nextjs-${{ hashFiles('web/pnpm-lock.yaml') }}-${{ hashFiles('web/**/*.[jt]s', 'web/**/*.[jt]sx') }}
          restore-keys: |
            nextjs-${{ hashFiles('web/pnpm-lock.yaml') }}-
```
Watch the 10 GB repo cache limit once vitest/pip caches are added; Next cache for this repo is small.

**Turbopack status (task question):** Next.js 16 made **Turbopack the default bundler for dev and
build**; you opt *out* with `next build --webpack`
([version-16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16)). This repo's
`next.config.ts` has no `webpack` key, so the CI `Build` step (76s) already runs Turbopack — there
is no separate "switch to Turbopack" win left, only cache (above) and typecheck dedup (R5).

## R5 — Don't typecheck twice (CI-only `ignoreBuildErrors`)

**Saves: −0:10 to −0:20 · Effort: S · Risk: Low-Med.** `next build` type-checks by default
([typescript config docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/typescript)),
and `pnpm typecheck` (23s, `tsc --noEmit`) already gates the same program in the same job. The repo
already uses this flag conditionally for the low-memory Docker path (`next.config.ts:29-33`),
so the mechanism exists:

```ts
const skipBuildTypecheck = process.env.NS_LOW_MEMORY_BUILD === "1" || process.env.CI === "true";
const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: skipBuildTypecheck },
  // ...
};
```
The type gate is unchanged (tsc runs as its own step); only the duplicate pass inside build
disappears. Keep `e2e`'s build deduplicated the same way only if the artifact is still gated by
the static job (out of lane-3 scope).

## R6 — `uv` for the Python installs

**Saves: −0:10 to −0:15 on the checks path · Effort: S · Risk: Low.** Both jobs pip-install with a
warm `setup-python` pip cache (16s checks / 19s core). `uv pip install` resolves from cache in
~3–5s ([astral-sh/setup-uv](https://github.com/astral-sh/setup-uv) caches by default with
`**/*requirements*.txt` globs):

```yaml
      - uses: astral-sh/setup-uv@v10   # enable-cache: true is the default on GH-hosted runners
      - run: uv pip install --system -r ../core/requirements.txt
```
Keep `--system` (or create a venv) to match `python3 -m pip` semantics; the `PYTHON` env var passed
to vitest is unaffected. Also drop `pytest-cov` from `core/requirements-optional.txt` — CI never
passes `--cov`; it's installed today for nothing (small, but free).

## R7 — Vitest `pool: "threads"` trial

**Saves: −0:10 to −0:30 (measure first) · Effort: S · Risk: Low.** Vitest ≥2 defaults to `forks`;
the perf guide suggests `threads` can help larger suites
([improving-performance](https://vitest.dev/guide/improving-performance)). Worker startup is cheaper
and memory pressure lower; import-heavy phases (141s) benefit most. This suite has no native-node
deps (jsdom/fake-indexeddb/React are all pure JS), the classic threads hazard — except the
uvicorn-spawning `dev-launcher.test.ts` and python-subprocess tests, which spawn *external*
processes and are pool-agnostic. Trial: `vitest run --pool=threads` locally + one CI branch; keep
only if it wins. Combine with R3's projects config (`pool` is a root/project option).

## R8 — Cache or trim the GLPK apt install

**Saves: −0:05 to −0:10, core only · Effort: S · Risk: Low.** `apt-get update && apt-get install
glpk-utils` is 11–16s. Cache the apt archives so `update` stays but downloads don't repeat:

```yaml
      - uses: actions/cache@v4
        with:
          path: /var/cache/apt/archives
          key: apt-glpk-utils-ubuntu-24.04
      - run: sudo apt-get update && sudo apt-get install -y --no-install-recommends glpk-utils
```
Replacing glpsol with a pip-packaged solver is NOT recommended: PuLP's GLPK tests exist to exercise
the real binary (spec X4, per `requirements-optional.txt` comments). Cosmetic priority — core is
off the critical path.

## R9 — `isolate: false` for the node project (park this)

**Saves: up to −1:00, uncertain · Effort: M · Risk: High.** Disabling per-file isolation lets a
worker reuse the module registry across files, attacking the 141s import phase directly
([migration guide example](https://vitest.dev/guide/migration.html)). But 7,483 tests that rely on
`vi.mock` hoisting, `fake-indexeddb/auto` globals and module-level state become cross-file leak
candidates — this is exactly the flake class this suite has been carefully avoiding (per the
config comments). Only behind a dedicated branch trial with repeated green runs; R1 already
dilutes its value.

---

## Explicit non-recommendations (task questions answered)

- **Lint/format cost**: `oxlint && ast-grep scan` = 4s, `oxfmt --check` = 2s. Nothing to optimize;
  do not parallelize or split these — the setup overhead exceeds the step.
- **Test timeouts**: no `testTimeout` override exists; default 5s; no timeout pressure visible in
  run logs. Leave as is (lowering it would only create flakes).
- **GLPK replacement**: keep the real `glpsol`; only cache the install (R8).
- **jsdom → happy-dom globally**: only via the R3 projects split with per-file fallback, never as a
  global flip — 125 DOM files include FullCalendar/axe/Dexie suites whose behavior differences
  need the audit path.

## Cross-lane note (not lane 3)

`e2e`'s "Run e2e" step (12m33s) contains a full `pnpm build && pnpm start` webServer boot. Sharing
the `build` job's output (artifact or `.next/cache` restore) could cut ~1:00–1:30 from e2e, but the
screenshot baseline contract pins e2e to `ubuntu-24.04` while `checks` runs `ubuntu-latest` — a
cross-runner artifact needs a rendering-environment equivalence argument first. Belongs to the e2e
lane.

## Sources

- GH runs (timings): https://github.com/kenan-xin/nursing-sheduler/actions/runs/36221607608,
  https://github.com/kenan-xin/nursing-sheduler/actions/runs/36221230554 (jobs API steps,
  startedAt/completedAt; unit summary log line quoted above)
- Vitest sharding + blob/merge-reports: https://vitest.dev/guide/features.html
- Vitest projects: https://vitest.dev/guide/projects.html · isolation per project:
  https://vitest.dev/guide/migration.html · pool threads: https://vitest.dev/guide/improving-performance.html
- Next.js CI build caching (.next/cache recipe): https://nextjs.org/docs/app/guides/ci-build-caching
- Next.js Turbopack default in 16: https://nextjs.org/docs/app/guides/upgrading/version-16
- `typescript.ignoreBuildErrors`: https://nextjs.org/docs/app/api-reference/config/next-config-js/typescript
- pytest-xdist `-n auto`, worker restart: https://github.com/pytest-dev/pytest-xdist
- setup-uv caching (default `**/*requirements*.txt` glob): https://github.com/astral-sh/setup-uv
- Repo evidence: `web/vitest.config.ts`, `web/vitest.setup.ts`, `web/package.json`,
  `web/next.config.ts`, `core/tests/server_support.py`, `core/tests/conftest.py`,
  `core/requirements.txt`, PR-branch `ci.yml` @ 3deee412 (core job definition)
