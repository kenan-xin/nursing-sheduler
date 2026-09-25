# v1 sync W0: foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI gate the vendored Python backend (`core/`) before any upstream code lands, and ship a production image without test tools.

**Architecture:** Split `core/requirements.txt` into a runtime file (what the Docker images install) and `requirements-optional.txt` (tests, tooling, optional solvers), in the upstream genie form plus two documented v2 differences. Add a Linux `core` job to the existing CI workflow that runs Ruff and the full pytest suite against a real Redis service. Record the new upstream baseline in the T19 manifest.

**Tech Stack:** Python 3.12.13 (`.python-version`), pip, pytest, Ruff 0.15.22, Redis 8 (GitHub Actions service), GLPK, Docker.

**Spec:** `docs/superpowers/specs/2026-09-25-v1-genie-sync-design.md` (section 3, W0; decisions X1, X4). Evidence: `docs/research/2026-09-25-v1-sync/05-tests-deps-docker-ci.md` (L5-01, L5-10). Plan reviews: `10-plan-review-opus.md`, `11-plan-review-codex.md` (all accepted fixes are in this revision).

## Global Constraints

- Upstream target: v1 repo `/home/kenan/work/nurse-scheduling`, branch `feature/genie`, commit `1bf4b85`. Old pin `d63519b`. Merge base with v1 `dev`: `89190ab`. Read it only with `git -C /home/kenan/work/nurse-scheduling show|diff|log|rev-parse|merge-base`.
- Keep `ruamel.yaml==0.19.1` and `pydantic==2.13.4` pinned: canonical YAML bytes depend on them.
- Keep `ruff==0.15.22` pinned and the explicit `tool.ruff.lint.select` in `core/pyproject.toml`.
- `pulp==3.3.2`, `highspy==1.12.0`, `pyscipopt==6.2.1` go in `requirements-optional.txt`, never in the runtime file (X4).
- Leave out the packages that only upstream `ai/` imports: `psycopg`, `e2b`, `Pillow`, `defusedxml`, `pypdf`, `pypdfium2`.
- Shell convention. Shell state does not persist between command blocks. Every block starts with `cd "$(cat /tmp/v1sync-w0-root)"`, names the interpreter by its full path (`/tmp/v1sync-w0-venv/bin/python`), and runs `core/` or `web/` commands inside a subshell: `(cd core && …)`.
- Exit codes. Never pipe a test run into `tail` or `grep` for a pass or fail decision. Write the output to a log file, keep the exit status, then read the log.
- Branch flow (`CLAUDE.md`): branch from `develop` in its own worktree, merge back into `develop`. The commit steps in this plan run only after the user approves this plan for execution. Push and merge need separate approval.
- Task tracking uses `bd` (beads), not TodoWrite. Use `cp -rf` and `rm -rf` for copies and removals (`AGENTS.md`).

## Review Focus

- The production backend image must not contain `pytest`, `ruff`, `fakeredis`, or `pulp`. Pinned by Task 1 Step 6.
- The real-Redis variants must run in CI, not skip silently. Pinned by Task 2 Step 2.
- The web CI job must still find every Python package the differential oracle and `dev-launcher.test.ts` import after the split. Pinned by Task 1 Step 7.
- A contributor who runs `pip install -r core/requirements.txt` for local tests must get a clear pointer to the optional file. Pinned by the header comment in Task 1 Step 3.
- `ruff format --check` must pass on `develop` as it is today, or the new job starts red. Pinned by Task 2 Step 3.

---

### Task 1: Split the backend requirements

**Files:**
- Modify: `core/requirements.txt` (whole file)
- Create: `core/requirements-optional.txt`
- Modify: `core/pyproject.toml:22-23` (the comment that names the Ruff pin's file)
- Modify: `docker/README.md` (the sentence near line 390 that says the backend gate runs in CI)

**Interfaces:**
- Consumes: nothing.
- Produces: `core/requirements-optional.txt`, which starts with `-r requirements.txt`. Task 2 and every later workstream install it for tests.

- [ ] **Step 1: Create the worktree, record its path, and create a venv**

```bash
cd /home/kenan/orca/workspaces/nursing-sheduler/damselfish
wt switch --create feat/v1-sync-w0 --base develop --no-cd
git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch refs\/heads\/feat\/v1-sync-w0$/{print p}' > /tmp/v1sync-w0-root
cat /tmp/v1sync-w0-root
uv venv /tmp/v1sync-w0-venv --python 3.12
```
Expected: one absolute path printed. Every later block starts with `cd "$(cat /tmp/v1sync-w0-root)"`.

- [ ] **Step 2: Record the web baseline before the split**

```bash
cd "$(cat /tmp/v1sync-w0-root)"
uv venv /tmp/v1sync-w0-runtime --python 3.12
uv pip install --python /tmp/v1sync-w0-runtime/bin/python -r core/requirements.txt
(cd web && pnpm install --frozen-lockfile && PYTHON=/tmp/v1sync-w0-runtime/bin/python pnpm test) > /tmp/v1sync-w0-web-before.log 2>&1
echo "exit=$?"; tail -5 /tmp/v1sync-w0-web-before.log
```
Expected: `exit=0`. Record the pass count.

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
# The PuLP/GLPK tests also need the `glpsol` binary: `glpk-utils` on
# Debian/Ubuntu, `glpk` on Arch/CachyOS.
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

- [ ] **Step 5: Fix the stale comment and the README**

In `core/pyproject.toml`, change the comment line `# in core/requirements.txt.` (the end of "The matching version pin lives in core/requirements.txt") to `# in core/requirements-optional.txt.`

In `docker/README.md`, find the sentence near line 390 that says the backend gate runs on "host / CI". Replace it with: "The backend gate (Ruff and pytest, with a real Redis service) runs in the `core` job of `.github/workflows/ci.yml` and on the host."

- [ ] **Step 6: Build the backend image and prove test tools are gone**

```bash
cd "$(cat /tmp/v1sync-w0-root)"
APP_VERSION=w0-check docker compose -f docker/compose.yml build backend
docker run --rm --entrypoint python docker-backend -c "import importlib.util as u; print([m for m in ('pytest','ruff','fakeredis','pulp') if u.find_spec(m)])"
```
Expected: `[]`. The image name `docker-backend` comes from `APP_VERSION=x docker compose -f docker/compose.yml config --images` (the compose file has no top-level `name:`, and compose needs `APP_VERSION` set).

- [ ] **Step 7: Run the web unit tests with only the runtime file installed**

```bash
cd "$(cat /tmp/v1sync-w0-root)"
uv pip install --python /tmp/v1sync-w0-runtime/bin/python --reinstall -r core/requirements.txt
(cd web && PYTHON=/tmp/v1sync-w0-runtime/bin/python pnpm test) > /tmp/v1sync-w0-web-after.log 2>&1
echo "exit=$?"; tail -5 /tmp/v1sync-w0-web-after.log
```
Expected: `exit=0` and the same pass count as Step 2. The web CI job installs only `core/requirements.txt`, and it keeps doing so.

- [ ] **Step 8: Commit**

```bash
cd "$(cat /tmp/v1sync-w0-root)"
git add core/requirements.txt core/requirements-optional.txt core/pyproject.toml docker/README.md
git commit -m "build(core): split runtime and optional requirements (v1 sync W0)"
```

### Task 2: Add the core CI job

**Files:**
- Modify: `.github/workflows/ci.yml` (add a `core` job after `checks`)

**Interfaces:**
- Consumes: `core/requirements-optional.txt` from Task 1.
- Produces: a CI job named `core (ruff · pytest · redis)`. W1, W2 and W6 rely on it as their gate. W1 adds one more step to it.

- [ ] **Step 1: Install the test environment**

```bash
cd "$(cat /tmp/v1sync-w0-root)"
uv pip install --python /tmp/v1sync-w0-venv/bin/python -r core/requirements-optional.txt
which glpsol || echo "install glpk (Arch/CachyOS) or glpk-utils (Debian/Ubuntu) before W1"
docker run -d --name v1sync-w0-redis -p 16402:6379 redis:8.8.0-alpine
```

- [ ] **Step 2: Run the full suite against real Redis on unchanged code, and prove nothing skips**

```bash
cd "$(cat /tmp/v1sync-w0-root)"
(cd core && NURSE_TEST_REDIS_URL=redis://localhost:16402/0 PYTHONPATH=. /tmp/v1sync-w0-venv/bin/python -m pytest -q -rs) > /tmp/v1sync-w0-pytest.log 2>&1
status=$?
tail -30 /tmp/v1sync-w0-pytest.log
echo "pytest exit=$status"
if grep -i 'SKIPPED.*redis' /tmp/v1sync-w0-pytest.log; then echo "ERROR: real Redis tests skipped"; fi
(cd core && env -u NURSE_TEST_REDIS_URL PYTHONPATH=. /tmp/v1sync-w0-venv/bin/python -m pytest -q -rs tests/test_server_store_contract.py) > /tmp/v1sync-w0-noredis.log 2>&1
grep -ci 'SKIPPED.*redis' /tmp/v1sync-w0-noredis.log
```
Expected: `pytest exit=0`, no `ERROR` line, and a non-zero count in the last line (without the variable, the Redis variants skip; with it, they run). Record the passed and skipped counts (a reviewer saw 1067 passed, 0 Redis skips). If pytest fails here, stop and report it as a failure that already exists on `develop`: do not add a red job.

- [ ] **Step 3: Run Ruff**

```bash
cd "$(cat /tmp/v1sync-w0-root)"
(cd core && /tmp/v1sync-w0-venv/bin/ruff check . && /tmp/v1sync-w0-venv/bin/ruff format --check .)
echo "exit=$?"
```
Expected: `All checks passed!`, `111 files already formatted` (or the current count), and `exit=0`.

- [ ] **Step 4: Add the job to `.github/workflows/ci.yml`**

Insert after the `checks` job and before `e2e`:
```yaml
  core:
    name: core (ruff · pytest · redis)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: core
    services:
      redis:
        image: redis:8.8.0-alpine
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
      # PuLP/GLPK backend tests (restored in W1) call the glpsol binary; PuLP does
      # not bundle it. Upstream test-core.yaml installs the same package.
      - name: Install GLPK
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends glpk-utils
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

```bash
cd "$(cat /tmp/v1sync-w0-root)"
uv pip install --python /tmp/v1sync-w0-venv/bin/python pyyaml
/tmp/v1sync-w0-venv/bin/python -c "import yaml; d = yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs']), [s.get('name') for s in d['jobs']['core']['steps']])"
```
Expected: `['checks', 'core', 'e2e']` and the step names, with `Install GLPK` before `Install backend dependencies`.

- [ ] **Step 6: Commit and clean up**

```bash
cd "$(cat /tmp/v1sync-w0-root)"
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

```bash
git -C /home/kenan/work/nurse-scheduling merge-base d63519b dev
git -C /home/kenan/work/nurse-scheduling merge-base --is-ancestor d63519b feature/genie && echo ancestor
git -C /home/kenan/work/nurse-scheduling rev-parse --short feature/genie
```
Expected: `89190ab…`, `ancestor`, `1bf4b85`. If `feature/genie` moved past `1bf4b85`, stop and ask the user which commit to target.

- [ ] **Step 2: Add two bullets under "Pinned revision"**

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
cd "$(cat /tmp/v1sync-w0-root)"
git add docs/T19-upstream-backend-source-manifest.md
git commit -m "docs(t19): record feature/genie 1bf4b85 sync target (v1 sync W0)"
```

### Task 4: Hand off

- [ ] **Step 1: Report**

Report to the user: the branch name, the 3 commit SHAs, the counts from Task 2 Step 2, and the command to open a pull request into `develop`. Do not push or merge until the user approves. Acceptance for W0: the `core` job runs on that pull request and passes.
