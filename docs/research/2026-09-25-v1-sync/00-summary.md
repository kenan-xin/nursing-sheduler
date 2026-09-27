# v1 to v2 sync investigation: summary

Date: 2026-09-25. Orca run `run_94d60d723d5b`, 7 read-only lanes. The lane reports are in this directory:

| Lane | Report | Scope |
| --- | --- | --- |
| 01 | `01-solver-model-core.md` | models, preference types, scheduler, loader, exporter, solvers |
| 02 | `02-server-runtime.md` | server app, jobs, stores, optimize API |
| 03 | `03-server-new-modules.md` | auth, request limits, solver options, Sentry, suspicion, usage telemetry, version |
| 04 | `04-ai-package.md` | v1 Python AI service against the v2 client-side assistant |
| 05 | `05-tests-deps-docker-ci.md` | dependencies, test infrastructure, Docker, CI |
| 06 | `06-frontend-gap.md` | v1 `web-frontend` features against v2 `web/` (bead drafts in section 5) |
| 07 | `07-v2-deviation-inventory.md` | every v2 core change since the pin, and a minimal patch set |

## 1. Baseline correction

The T19 manifest pins v2 core at `d63519b`. That commit is not on v1 `dev`. It is on the v1 branch `feature/genie` (also `origin/feature/genie`). All 13 genie-only commits before the pin are by kenan.xin.

- `feature/genie` HEAD is `1bf4b85`. It contains all of `dev` through merge `1b6f7e5` (2026-09-24), plus 22 genie-only commits.
- The merge base of `d63519b` and `dev` is `89190ab` (2026-07-20).
- Genie carries LEAVE, `hoursContract`, shift working time, covering rules, `group_map.py` and Singapore holidays. Genie removes Sentry, the suspicion tracker, the anonymizer and the PuLP CBC and cuOpt solvers.
- `git diff d63519b dev` shows the genie features as v1 deletions. The correct upstream delta for v2 is `d63519b..feature/genie`.

All lanes except lane 04 used the corrected baseline from the start or after the correction. Lane 04 added a genie addendum.

## 2. Headline findings

1. The solver core can take genie verbatim. Genie merge `1b6f7e5` already rebuilt LEAVE, `hoursContract`, covering and working time on the v1 compiled-schedule API. 243 of 244 genie core tests pass on an archive, and the 1 failure needs a file outside `core/` (lane 01).
2. After that take, the v2-only solver-core patch set is 4 additive features: `Person.temporary`, `skillMix`, per-date overrides, and `on_roster` (lanes 01 and 07).
3. Security gap in v2: no bound on YAML alias expansion or nesting depth. v1 `3a77ad4` and `1990a1e` close it. A 342-byte document can name about 387 million nodes (lanes 01 and 02).
4. Probable v2 bug, from code reading only: v2 `scheduler.py` raises `ValueError` on solver status UNKNOWN, so the INCONCLUSIVE runner branch never runs with the real scheduler. The v1 `ScheduleResult` return fixes it (lanes 01 and 07).
5. The server runtime has two designs for the same problem. v1 added a worker lease registry (`0249f67`, `ab71cfd`, `fec52e1`, `23a77bb`). v2 built a per-job Lua `TIME` fence (T19) and the T09 priority queue on top of it. `stores/redis.py`, `jobs/worker.py` and `jobs/controller.py` are the worst conflict hotspots (lanes 02 and 07).
6. The web BFF validators are closed. New v1 `/info` keys (`auth`, `claimed_performance`, `jobs`, `workers`) and API version `0.2.0` break `/api/info` and the event parser unless the web side changes in the same step (lanes 02 and 03).
7. v2 CI runs no core `pytest` and no `ruff`. The v2 production image ships test tools, because v2 lacks the v1 split into `requirements.txt` and `requirements-optional.txt` (lane 05).
8. The v1 Python AI package (`core/nurse_scheduling/ai/`, about 9,250 lines plus about 15,900 test lines) conflicts with the v2 assistant decisions: operator key, server-side chat log, model-written Bash in an E2B sandbox. All lanes that looked at it recommend that v2 excludes it (lanes 04, 05, 06).
9. Frontend: v2 has 3 defects that v1 fixed. They are history blanking on shift-type deletion (makes the scenario invalid), one-level nested groups in count coefficients, and the Singapore holiday year range. v2 also shows no copyright or AGPL-3.0 notice (lane 06).

## 3. Where lanes disagree

| Topic | Lane positions | Coordinator note |
| --- | --- | --- |
| Worker lease model | 02: keep the v2 fence and T09 queue, record a permanent deviation, offer both upstream. 07: take the v1 lease model, then re-implement T09 on it. | Genuine trade-off. Taking v1 removes the largest server diff but costs L effort and needs new parity gates for T09 and the `SIGKILL` and delayed-commit probes. |
| Multi-solver library | 01, 03, 07: take genie `scheduler.py`, `cli.py`, `solver_options.py` and `solver_capabilities.py`, and keep CP-SAT only through a default allowlist and the server boundary. 05: keep CP-SAT only as a v2 delta, no PuLP. | 01 and 07 measure about 1,900 source lines of diff removed. The open cost is the PuLP runtime dependency and the multi-solver tests. |
| Sentry | 03: adopt as opt-in, with the upstream DSN removed. 04 addendum, 06: genie removed it, do not port. | Genie is the target, and genie has no Sentry. Not porting it keeps v2 equal to genie. |

## 4. Open decisions (merged across lanes)

| ID | Decision | Recommendation | Source |
| --- | --- | --- | --- |
| X1 | Upstream target: `feature/genie` or `dev`? | `feature/genie` at `1bf4b85`. Record `d63519b` as the content pin and `89190ab` as its `dev` ancestor in the T19 manifest. | all |
| X2 | Sync method | See section 5. | coordinator |
| X3 | Worker lease model | See section 3. | 02 D1, 07 Q2 |
| X4 | Restore the multi-solver library, with CP-SAT only at the boundary | Yes. It removes about 1,900 lines of diff. | 01 D2, 03 D2, 05 D1, 07 Q1 |
| X5 | v1 Python AI package | Exclude, and record the exclusion in the manifest. Reuse the eval cases and schema references from genie as a prompt corpus only. | 04 D1, D5 |
| X6 | Sentry, suspicion reports, usage telemetry with Mailgun | Leave out, as genie does. Telemetry is kept on genie, so if you adopt it, keep it off by default. | 03 D3 to D5, 05 D3 |
| X7 | Backend bearer auth | Adopt `auth.py` for parity, keep it off. The v2 backend is private behind the BFF. | 03 D1, 06 D2, 05 D6 |
| X8 | `/info` keys and API version `0.2.0` | Adopt, with one paired BFF parser change. | 02 D3, D4 |
| X9 | `country` field | Follow genie and remove it from the core model. Keep accepting it in Workspace input and drop it there, so that old files load. Stop emitting it in `web/`. | 01 D1 |
| X10 | UK spelling in backend messages, version source, deployment defaults | Take the v1 code. Put v2 values in `docker/` environment files and map text in the web layer. | 07 Q4 to Q6 |
| X11 | Frontend gaps | File beads for the 3 defect fixes, the 87-person example, LAN dev origins, the licence footer, and the assistant Retry, transcript export and attachments. Skip the v1 AI page, the server list and the star nudge. | 06 D1 to D9 |

## 5. Candidate sync methods

- A. Reset and re-apply. Replace `core/` with genie `1bf4b85`, then re-apply the v2 patch set from lane 07 section 6 (P1 to P10). Largest single change. Smallest final diff.
- B. Cherry-pick. Port v1 changes into the current v2 core one by one. Smallest single steps. The v2 diff stays large, so the next sync costs the same again.
- C. Split by layer. Reset the solver core (non-`server/` modules) to genie and re-apply P1 to P4, because the lane 01 test evidence shows that this is clean. Adopt the server changes file by file, where the lease decision (X3) controls the hotspot files.

## 6. Safe first steps, independent of the decisions

1. Add a core CI job with `pytest`, `ruff` and a real Redis service (lane 05 L5-10), after the dependency split (L5-01).
2. Port the YAML expansion and nesting bound (lane 01 C04, lane 02 S05).
3. Port `retry.py` `RepeatedFailure` and the Darwin process-tree fix (lane 02 S03, S04).
4. Fix the 3 frontend defects (lane 06 F13, F14, F18).
