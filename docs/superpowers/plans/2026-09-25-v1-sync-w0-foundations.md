# v1 sync W0: foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI gate the vendored Python backend (`core/`) before any upstream code lands, and ship a production image without test tools.

**Architecture:** Split `core/requirements.txt` into a runtime file (what the Docker images install) and `requirements-optional.txt` (tests, tooling, optional solvers), in the upstream genie form plus two documented v2 differences. Add a Linux `core` job to the existing CI workflow that runs Ruff and the full pytest suite against a real Redis service. Record the new upstream baseline in the T19 manifest.

**Tech Stack:** Python 3.12.13 (`.python-version`), pip, pytest, Ruff 0.15.22, Redis 8 (GitHub Actions service), Docker.

**Spec:** `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md` (section 3, W0; decisions X1, X4). Evidence: `docs/research/2026-09-25-v1-sync/05-tests-deps-docker-ci.md` (L5-01, L5-10).

## Global Constraints

- Upstream target: v1 repo `/home/kenan/work/nurse-scheduling`, branch `feature/genie`, commit `1bf4b85`. Old pin `d63519b`. Merge base with v1 `dev`: `89190ab`. Read it only with `git -C /home/kenan/work/nurse-scheduling show|diff|log`.
- Keep `ruamel.yaml==0.19.1` and `pydantic==2.13.4` pinned: canonical YAML bytes depend on them.
- Keep `ruff==0.15.22` pinned and the explicit `tool.ruff.lint.select` in `core/pyproject.toml`.
- `pulp==3.3.2`, `highspy==1.12.0`, `pyscipopt==6.2.1` go in `requirements-optional.txt`, never in the runtime file (X4).
- Leave out the packages that only upstream `ai/` imports: `psycopg`, `e2b`, `Pillow`, `defusedxml`, `pypdf`, `pypdfium2`.
- Branch flow (`CLAUDE.md`): branch from `develop` in its own worktree with `wt switch --create feat/v1-sync-w0 --base develop --no-cd`, merge back into `develop`. Do not push or merge without the user's approval.
- Task tracking uses `bd` (beads), not TodoWrite.

## Review Focus

- The production backend image must not contain `pytest`, `ruff`, `fakeredis`, or `pulp`: a person running the image expects only runtime code. Pinned by Task 1 Step 5.
- The real-Redis variants must run in CI, not skip silently: a CI run where `NURSE_TEST_REDIS_URL` is unset looks green but tests nothing. Pinned by Task 2 Step 3 (skip count check).
- The web CI job must still find every Python package the differential oracle and `dev-launcher.test.ts` import after the split. Pinned by Task 1 Step 6.
- A contributor who runs `pip install -r core/requirements.txt` for local tests must get a clear pointer to the optional file. Pinned by the header comment in Task 1 Step 3.
- `ruff format --check` must pass on `develop` as it is today, or the new job starts red. Pinned by Task 2 Step 2.

---

### Task 1: Split the backend requirements

**Files:**
- Modify: `core/requirements.txt` (whole file)
- Create: `core/requirements-optional.txt`
- Modify: `.github/workflows/ci.yml:35-45` (web job cache key and install step comment only)
- Modify: `docker/README.md` (the sentence near line 390 that says the backend gate runs in CI)

**Interfaces:**
- Consumes: nothing.
- Produces: `core/requirements-optional.txt`, which starts with `-r requirements.txt`. Task 2 and every later workstream install it for tests.

- [ ] **Step 1: Create the worktree and a local venv**

```bash
wt switch --create feat/v1-sync-w0 --base develop --no-cd
cd <path printed by wt>
uv venv /tmp/v1sync-w0-venv --python 3.12
```

- [ ] **Step 2: Confirm the current state that the split changes**

Run: `grep -nE '^(pytest|pytest-cov|ruff|fakeredis)' core/requirements.txt`
Expected: 4 matches. These test tools are in the runtime file today, so `docker/Dockerfile.backend` installs them.

- [ ] **Step 3: Rewrite `core/requirements.txt` as the runtime set**

```text
# Runtime dependencies for the CLI and the backend. The Docker images install
# only this file. Tests, tooling and the optional solver backends live in
# requirements-optional.txt: for local tests run
#   pip install -r core/requirements-optional.txt
# Upstream genie keeps pulp in this file; v2 moves it to the optional file
# because the product runs CP-SAT only (spec decision X4).
ortools==9.15.6755
pandas
# Pinned canonical-boundary dependencies: these exact versions define the golden
# canonical YAML bytes, validation locations, and 422 fixtures (T19 / tech-plan §1).
# Upstream leaves them unpinned; this pin is a recorded v2 difference.
ruamel.yaml==0.19.1
pydantic==2.13.4
openpyxl # For XLSX output support
jinja2 # For prettifying output
# For web backend
fastapi[standard]
# Diagnostic HTTP client for the public production diagnostic runner (U30a).
httpx
python-multipart
# Redis job store (memory mode never imports redis eagerly)
redis
```

- [ ] **Step 4: Create `core/requirements-optional.txt`**

```text
# Optional dependencies for development, testing, and the extra solver backends.
# Install with `pip install -r core/requirements-optional.txt`, which also pulls
# in requirements.txt. The production images never install this file.
-r requirements.txt
# Solver backends beyond OR-Tools CP-SAT. The product uses CP-SAT only; these
# keep the upstream multi-solver library and its tests runnable (spec X4).
# Keep highspy aligned with the HiGHS ABI bundled by OR-Tools 9.15.
pulp==3.3.2
highspy==1.12.0
pyscipopt==6.2.1
# For CI
pytest
pytest-cov
fakeredis
# Ruff is intentionally pinned: Ruff's *default* rule set expands between
# releases (e.g. 0.15.x -> 0.16.x widened it materially). The explicit
# `tool.ruff.lint.select` in pyproject.toml keeps the contract honest even if
# this pin is later bumped.
ruff==0.15.22
```

- [ ] **Step 5: Build the backend image and prove test tools are gone**

Run:
```bash
make APP_VERSION=w0-check build
docker run --rm --entrypoint python docker-backend -c "import importlib.util as u; print([m for m in ('pytest','ruff','fakeredis','pulp') if u.find_spec(m)])"
```
Expected: `[]`. The image name `docker-backend` comes from `docker compose -f docker/compose.yml config --images`.

- [ ] **Step 6: Run the web unit tests with only the runtime file installed**

Run:
```bash
uv venv /tmp/v1sync-w0-runtime --python 3.12
uv pip install --python /tmp/v1sync-w0-runtime/bin/python -r core/requirements.txt
cd web && PYTHON=/tmp/v1sync-w0-runtime/bin/python pnpm test
```
Expected: the same pass count as on `develop` before this change. This matches what the web CI job installs.

- [ ] **Step 7: Point the web job's pip cache at both files**

In `.github/workflows/ci.yml`, change the `setup-python` step:
```yaml
          cache: pip
          cache-dependency-path: |
            core/requirements.txt
            core/requirements-optional.txt
```
Leave `python3 -m pip install -r ../core/requirements.txt` as it is: the web tests need only the runtime set.

- [ ] **Step 8: Correct `docker/README.md`**

Find the sentence near line 390 that says the backend gate runs on "host / CI". Replace it with: "The backend gate (Ruff and pytest, with a real Redis service) runs in the `core` job of `.github/workflows/ci.yml` and on the host."

- [ ] **Step 9: Commit**

```bash
git add core/requirements.txt core/requirements-optional.txt .github/workflows/ci.yml docker/README.md
git commit -m "build(core): split runtime and optional requirements (v1 sync W0)"
```

### Task 2: Add the core CI job

**Files:**
- Modify: `.github/workflows/ci.yml` (add a `core` job after `checks`)

**Interfaces:**
- Consumes: `core/requirements-optional.txt` from Task 1.
- Produces: a CI job named `core (ruff · pytest · redis)`. W1, W2 and W6 rely on it as their gate.

- [ ] **Step 1: Run the full suite locally against real Redis on unchanged code**

```bash
uv pip install --python /tmp/v1sync-w0-venv/bin/python -r core/requirements-optional.txt
docker run -d --name v1sync-w0-redis -p 16402:6379 redis:8-alpine
cd core && NURSE_TEST_REDIS_URL=redis://localhost:16402/0 PYTHONPATH=. /tmp/v1sync-w0-venv/bin/python -m pytest -q -rs | tail -30
```
Expected: 0 failed. Record the passed and skipped counts. If a test fails here, stop and report it as a failure that already exists on `develop`: do not add a red job.

- [ ] **Step 2: Run Ruff locally**

Run: `cd core && /tmp/v1sync-w0-venv/bin/ruff check . && /tmp/v1sync-w0-venv/bin/ruff format --check .`
Expected: `All checks passed!` and no files to reformat.

- [ ] **Step 3: Confirm no real-Redis test skips when Redis is reachable**

Run: `cd core && NURSE_TEST_REDIS_URL=redis://localhost:16402/0 PYTHONPATH=. /tmp/v1sync-w0-venv/bin/python -m pytest -q -rs | grep -i 'SKIPPED.*redis' || echo "no redis skips"`
Expected: `no redis skips`. Then run the same command without `NURSE_TEST_REDIS_URL` and confirm that redis skips appear, so you know the variable is what enables them.

- [ ] **Step 4: Add the job to `.github/workflows/ci.yml`**

Insert after the `checks` job and before `e2e`:
```yaml
  core:
    name: core (ruff · pytest · redis)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: core
    services:
      redis:
        image: redis:8-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version-file: .python-version
          cache: pip
          cache-dependency-path: |
            core/requirements.txt
            core/requirements-optional.txt
      - name: Install backend dependencies
        run: python3 -m pip install -r requirements-optional.txt
      - name: Ruff lint
        run: ruff check .
      - name: Ruff format
        run: ruff format --check .
      # Real-Redis store variants skip unless NURSE_TEST_REDIS_URL is set.
      - name: Pytest (memory, fakeredis, real Redis)
        env:
          NURSE_TEST_REDIS_URL: redis://localhost:6379/0
          PYTHONPATH: .
        run: python3 -m pytest -q -rs
```

- [ ] **Step 5: Validate the workflow file**

Run: `python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs']))"`
Expected: `['checks', 'core', 'e2e']`. If PyYAML is missing, use `/tmp/v1sync-w0-venv/bin/python` after `uv pip install pyyaml`.

- [ ] **Step 6: Commit and clean up**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add core job with ruff, pytest and real Redis (v1 sync W0)"
docker rm -f v1sync-w0-redis
```

### Task 3: Record the new upstream baseline

**Files:**
- Modify: `docs/T19-upstream-backend-source-manifest.md:8-18` (the header bullets)

**Interfaces:**
- Consumes: nothing.
- Produces: the baseline facts that W1 to W6 cite.

- [ ] **Step 1: Confirm the baseline facts**

Run:
```bash
git -C /home/kenan/work/nurse-scheduling merge-base d63519b dev
git -C /home/kenan/work/nurse-scheduling merge-base --is-ancestor d63519b feature/genie && echo ancestor
git -C /home/kenan/work/nurse-scheduling rev-parse --short feature/genie
```
Expected: `89190ab…`, `ancestor`, `1bf4b85`. If `feature/genie` moved past `1bf4b85`, stop and ask the user which commit to target.

- [ ] **Step 2: Add a bullet under "Pinned revision"**

Append to the header list:
```markdown
- **Sync target (2026-09-25):** v1 branch `feature/genie` at `1bf4b85`. The old pin
  `d63519b` is a genie commit, not a `dev` commit; its merge base with v1 `dev` is
  `89190ab`. Genie contains all of `dev` through merge `1b6f7e5`. The upstream delta
  for v2 is `d63519b..feature/genie`. Governing design:
  `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md`.
- **Requirements split (W0):** runtime `core/requirements.txt`, optional
  `core/requirements-optional.txt`. v2 differences from genie: `ruamel.yaml` and
  `pydantic` pinned; `pulp` in the optional file; the `ai/`-only packages omitted.
```

- [ ] **Step 3: Commit**

```bash
git add docs/T19-upstream-backend-source-manifest.md
git commit -m "docs(t19): record feature/genie 1bf4b85 sync target (v1 sync W0)"
```

### Task 4: Hand off

- [ ] **Step 1: Report**

Report to the user: the branch name, the 3 commit SHAs, the local pytest counts from Task 2 Step 1, and the command to open a pull request into `develop`. Do not push or merge until the user approves. Acceptance for W0: the `core` job runs on that pull request and passes.
