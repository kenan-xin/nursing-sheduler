# Scenario-style test assets for evaluating the AI Schedule assistant

Inventory of everything in the repo that already encodes a "scheduling scenario",
usable as raw material for assistant evals. Read-only research, no code changed.

## 1. `core/tests/testcases/` — solver-level scenario corpus

Three dirs, `apiVersion: alpha` YAML + matching `.csv`/`.xlsx`/`.txt` (expected error
text) siblings, consumed by `core/tests/schedule_test_helper.py` and
`core/tests/test_real_run_schedule.py` for byte-exact CSV regression + error-message
regression against the real CP-SAT solver.

- **`basics/`** (300 files, ~75 cases): numbered micro-scenarios building up solver
  features one at a time — `01_1nurse_1shift_1day*`, `02_..._nested_aggregate`,
  shift-count coefficients, date/people/shift-type group keywords, weight validation,
  pattern errors, an ortools-version regression bug case. Each `*_error.yaml` +
  `*_error.txt` pair is a **negative** scenario: malformed input, expected validation
  message. `*_infeasible.yaml` files are minimal **infeasible** cases (empty `.csv`
  output). Eval angle: too granular for assistant evals directly (these test the
  solver's input grammar, not ward-manager scenarios) but the `_infeasible` and
  `_error` pairs are a ready template for "assistant explains an infeasible/invalid
  scenario" eval prompts — the expected explanation is already the `.txt` file.
- **`artificial/ortools/`** (33 files, ~5 cases): adapted from Google OR-Tools'
  employee-scheduling example (see `README.md`), modified for a unique optimum —
  `ex1_even_shift_distribution*` (with `_count_all_mse`/`_count_nested`/`_count_offs`/
  `_count_penalty` variants) and `ex2_multiple_date_formats`/`_multiple_shift_requests`/
  `_shorthand_dates`. These are feasible, "fairness" scenarios (even shift
  distribution across nurses) — good for eval prompts like "make shifts more even" /
  "why is the distribution uneven".
- **`real/`** (3 files, hand-authored, heavily commented — best eval seeds):
  - `sg-28day-160h-compliance-14-nurses.yaml`: 28-day/160-contracted-hour ward with
    Singapore Employment Act rest rules + NHS-style night-recovery block. Header
    comment is a full worked proof (gap-hour table, feasibility identity
    `14×20 = 280 = 28×(4+3+3)`). Feasible by construction. Excluded from the CSV-exact
    suite (`EXCLUDED_TESTCASE_DIRS`) because it has many equally-optimal solutions.
    Eval angle: "explain why these succession rules are needed" / "would adding leave
    break this roster" (comment literally says leave breaks the headcount identity).
  - `ward-8-shift-patterns-senior-on-every-shift.yaml`: 32-nurse ward, 8 shift
    patterns (am1-3/pm1-3/long/night) each doubled into a plain + `+` senior-only
    twin via `qualifiedPeople`, `XxxAll` staffing groups, full leave/day-off request
    sheet. Feasible. Eval angle: "add a senior-coverage rule" / "why do SSN and SN
    counts look odd" (comment explains the per-part-of-day vs per-shift subtlety and
    the group-must-list-every-member trap).
  - `large-ward-with-87-people-2025-11.yaml`: 87-person ward, Nov 2025, Chinese-
    language date groups (workday/non-workday/freeday-shift-right/before-after-4),
    per-person shift `history`. Eval angle: scale/stress scenario, i18n descriptions,
    "explain this date group" prompts.

## 2. Backend solver/scheduler tests (`core/tests/*.py`, not under `testcases/`)

Not YAML scenario files but Python tests that build scenarios programmatically or
assert solver contracts relevant to assistant tool results:
- `test_solver_ortools_cp_sat.py`, `test_schedule_ortools_cp_sat.py`,
  `test_scheduler.py`, `test_scheduler_on_roster.py`, `test_solver_interface.py` —
  solver correctness/status (FEASIBLE/OPTIMAL/INFEASIBLE) on constructed inputs.
- `test_real_solver_capability_probe.py`, `core/tests/real/solver_capability_probe.py`
  — a real-solver capability probe pattern reused by
  `test_assistant_repair_fixtures.py` (see §4) via `nurse_scheduling.scheduler.schedule`.
- `test_sg_compliance_roster.py`, `test_ward_shift_patterns_roster.py` — likely the
  Python-side counterparts that exercise the two `real/` YAML wards above end-to-end
  (worth opening if building a solver-verdict eval harness).
- `test_server_priority_queue.py`, `test_server_api.py`, `test_roster_routes.py`,
  `test_job_response_contract.py` — the run/queue/job-status contract the assistant's
  `request_optimize_run`/`get_optimize_result` tools ultimately depend on.

## 3. Web scripted wards — `web/lib/rules/ward-fixtures.test-support.ts`

The single canonical set of **assistant-facing scripted wards**. Explicit doc comment:
"Scripted wards for the static staffing check and the assistant evaluation harness."
Each ward is 1–7 Nov 2026 (date ids `"01".."07"`), built with the `ward()`/`cards()`/
`requirement()`/`nightCap()`/`leave()` helpers over `ScenarioUiState`. 9 named
scenarios in `SCENARIOS`:

| name | plain-language scenario | expected outcome |
|---|---|---|
| `empty` | brand-new, nothing configured | feasible trivially / used as the "no findings" baseline |
| `understaffedNight` | night of the 5th needs 3 (high acuity) but only 3 nurses total, 1 already needed on days | infeasible; static check finds the shortfall directly |
| `onlyRnOnLeave` | every night needs 1 RN; the only RN is on leave the 3rd | infeasible; static check |
| `ruleTooStrict` | 7 nights to fill, "at most 1 night each" caps 4 nurses at 4 nights total | infeasible; the count-rule is the cause |
| `tooFewNurses` | day+evening+night each need 1 every day, only 2 nurses | infeasible; plain headcount shortage |
| `personalCapsTooLow` | 7 nights, 2 nurses, each capped at 3 nights → 1 night uncovered | infeasible; per-person count rule |
| `conflictingRequirements` | every night needs exactly 1 total AND exactly 2 RNs — contradictory | infeasible; two requirements conflict |
| `busyNightsWithRestRule` | busy nights (2nd/6th) need 3, "no day after night" rule constrains cover | infeasible; static check + succession interaction |
| `restRuleTooTight` | 2 nurses, day+night, "no day after night" AND "no two nights in a row" | infeasible **only through rest rules** — deliberately NOT caught by the static check; exercises the "unexplained/cause-unavailable" path |

These map 1:1 to `RepairId` expectations in `EXPECTED` (see §4) and are the most
directly reusable eval seeds: each is already a `ScenarioUiState` factory, so an eval
harness can call `SCENARIOS[name]()`, serialize it (`serializeScenario`), and use it as
the initial scenario YAML for a live-model conversation.

## 4. Assistant repair-evaluation harness (pure, no LLM/network/solver)

- `web/lib/ai/assistant/playbook.ts` — the repair *policy* as typed/versioned data
  (`PLAYBOOK_VERSION`), not a prompt string: `SETUP_STEPS` (dates → people →
  shiftTypes → rules → requests → run → review, each with `ask`/`proposeWith`),
  `REPAIR_ORDER`, `REPAIRS`, `SAFETY_FLOOR`. Encodes controller rulings, e.g. no
  `mark_person_off` arm; borrowed nurse = `add_person{temporary:true}` +
  `set_off_request` "must"; staffing requirements are exact counts; skill-mix
  requirements can never be created/lowered; single-date override is advice-only.
- `web/lib/ai/assistant/repair-options.ts` — pure function
  `rankRepairOptions(scenario, findings, {runInfeasible}) → RepairOption[]`, each with
  `title`, `why`, `operations` (`AssistantCommandV1[]`, empty = advice-only),
  `confirmation`, `enforcedBy`, `confirmationQuestion`, `needsFromUser`,
  `capabilityId`, `evidence: "static_check"|"hypothesis"`. Joins `lib/rules/shortfalls`
  (WHERE it's short) with the playbook (WHICH repair, in what order).
- `web/lib/ai/assistant/repair-eval.test.ts` — **the evaluation harness itself**. For
  each of the 7 infeasible `SCENARIOS`, asserts the ranked `RepairId[]` matches
  `EXPECTED` exactly (e.g. `understaffedNight → ["borrow_temporary_nurse",
  "run_one_short"]`, `conflictingRequirements → ["align_overlapping_requirements"]`),
  asserts the top option's operations apply cleanly (`applyAssistantCommands`) and the
  resulting scenario has no remaining shortfall, and asserts the right
  `AssumptionType` confirmation is raised per repair (`AGREEMENT` map). It then writes
  before/after scenario YAML to `core/tests/fixtures/assistant_repair/*.{before,after}.yaml`
  via `pnpm vitest run lib/ai/assistant/repair-eval -u` (file-snapshot update).
- `core/tests/test_assistant_repair_fixtures.py` — the **real-solver cross-check**:
  reads those 14 YAML fixtures (7 before/after pairs) and asserts, with the actual
  CP-SAT solver (`nurse_scheduling.scheduler.schedule`), that every `.before.yaml` is
  `INFEASIBLE` and every `.after.yaml` is `FEASIBLE`/`OPTIMAL`. This is the one place
  in the repo where a TypeScript-authored "the assistant's repair works" claim is
  proven against the real solver rather than mocked.
- `web/lib/ai/assistant/setup-progress.ts` (+ `.test.ts`) — `deriveSetupProgress`,
  used by the `get_setup_progress` tool result to know which `SETUP_STEPS` are done.
  Guided-setup UI counterpart: `web/components/guided-rules/use-guided-rules.ts`,
  `web/components/home/home-guided.tsx`.

**Turning a scripted ward into a full eval case** (initial YAML + prompt(s) +
expected tool calls/proposal/verdict) is nearly free: `SCENARIOS[name]()` gives the
initial scenario, `serializeScenario()` gives the YAML, `EXPECTED[name]` gives the
expected repair id (→ expected `prepare_scenario_change` operations via
`rankRepairOptions(...).operations`), and `AGREEMENT[name]` gives the expected
confirmation/assumption. A natural user prompt is implicit in each ward's one-line
comment (e.g. for `onlyRnOnLeave`: "my only RN nurse is on leave the 3rd, every night
needs an RN, what do I do").

## 5. Diagnostic / cause explanation layer

- `web/lib/ai/diagnostic/diagnostic-explanations.test.ts` — pins the honest wording
  ("does not prove", "proves only", `CAUSE_UNAVAILABLE` baseline) that the assistant
  must use whenever it cannot causally explain an infeasible run — directly relevant
  to the `restRuleTooTight` scenario above, which is the one designed to hit this path.
- `core/tests/test_server_*` (priority queue, diagnostic, replay, lifecycle-gates,
  worker-loss) — backend counterparts proving the trusted/stale semantic basis for
  diagnostics the assistant reads via `get_optimize_result`/diagnostic tools.

## 6. e2e Playwright specs touching the assistant (`web/e2e/*.spec.ts`)

- `ai-assistant-activation.spec.ts` — fresh-profile off-by-default, enable→probe→Ready
  and every failure lane, credential containment across the whole browser, late-
  callback quarantine across a reload, single-writer cross-tab authority. Uses
  `window.__nsStore`/`__nsAssistant` test seams; same-origin setup routes
  (`/api/ai/openrouter/test`, `/api/ai/openrouter/models`) answered in-page so **no
  live provider is used**.
- `ai-assistant-chat-ui.spec.ts` (48KB, largest) — measured layout/computed-style
  assertions on the real shipped chat panel (regression for a missing-stylesheet
  defect), seeded via "the assistant test bridge's real fenced write" so what renders
  is a genuinely persisted thread — still no live model.
- `ai-assistant-stop-control.spec.ts` — Stop/interruption behavior.
- `assistant-proposal-apply.spec.ts` — prepare → confirm → Apply → receipt → Undo,
  driven through `window.__nsStore.assistantProposal.{prepare,apply}` (a host seam,
  not a chat turn) to prove atomic IndexedDB apply, cascade correctness, and that the
  applied change reaches the right screens — deliberately bypasses the LLM.
- `roster-real-ward-assembled.spec.ts` — references `shortfalls`, likely exercises a
  real-ward roster end-to-end (worth reading directly if building UI-level evals).

**None of the e2e specs make a live model call.** All "Ready" states in e2e are
reached by answering the two same-origin setup routes locally with a sentinel key.

## 7. Assistant-test-bridge and component-level harnesses

- `web/components/ai/assistant-test-bridge.test.tsx`,
  `assistant-bridge-facts.test.tsx` — the bridge referenced by `app-shell.tsx` and by
  the e2e specs to seed a "real fenced write" conversation without a live model.
- `web/lib/ai/assistant/test-support.ts` — `createAssistantHarness()`: fresh isolated
  Dexie DB (`NurseSchedulerDb`), controlled clock, deterministic ids — the fixture
  every assistant unit test builds on.
- `web/lib/ai/assistant/*.test.ts` (clear-*, commit-window, complete-tool-pairs,
  diagnostic-cancellation, fence, history-repo, interruption, runtime-stop, scrub-
  history, send-gate, settings-repo, settle-race, writer-context) — session-lifecycle
  and fence-safety unit tests, all against the harness above, none touching a real
  model or transport.
- `web/components/ai/use-*-tools.test.tsx` (feasibility, optimize, diagnostic,
  context, help) — tool-registration-level tests. Pattern: `vi.mock("@copilotkit/
  react-core/v2", ...)` capturing `useFrontendTool` registrations, then invoking the
  captured handler directly with args — this is effectively a **headless assistant
  tool harness** already, just per-tool rather than per-conversation.

## 8. Runtime / CopilotKit / OpenRouter harness (`web/lib/ai/runtime/`)

This is the closest thing to a "run the assistant headless" harness that exists, but
it stops short of a real model:

- `web/lib/ai/runtime/test-support.ts` — `recordingOpenRouter` fetch fixture: a fake
  `fetch` that **records the exact outgoing HTTP payload** instead of calling
  OpenRouter, plus `runAgentInput`/`runRequest`/`credentialHeaders`/`routeUrl` helpers
  targeting `/api/copilotkit/agent/{id}/run`. Sentinel key
  `sk-or-v1-TEST-SENTINEL-DO-NOT-LEAK-0000000000`.
- `copilot-runtime.test.ts`, `model-visible-tools.test.ts`,
  `transient-agent-runner.test.ts`, `containment.test.ts`, `deployment.test.ts`,
  `package-family.test.ts`, `registration-delegates.test.ts` — drive the real
  `createSchedulerCopilotRuntime` handler end-to-end through `readSse` against the
  fake-fetch recording transport. `model-visible-tools.test.ts` is notable: it uses
  the REAL `schemaToJsonSchema`/`zodToJsonSchema` resolved through the installed
  `@copilotkit/react-core` client and the REAL `convertToolsToVercelAITools` from
  `@copilotkit/runtime/v2` — this is a genuine (if network-free) integration test of
  the tool-schema wire format, written specifically to catch the class of defect
  where CopilotKit's client-side schema serializer and the runtime's server-side
  converter disagree (the `{"type":"null"}` incident documented in the file header).
- `openrouter-agent.ts` — `readAiCredentials(request)` reads `AI_KEY_HEADER`/
  `AI_MODEL_HEADER`; `createOpenRouterAgent(request, {fetch})` — the `fetch` override
  point is exactly where a real (or recorded) OpenRouter call would be substituted.
- `web/app/api/ai/openrouter/test/route.ts`, `.../models/route.ts` — the two
  same-origin setup routes (`handleProbeRequest`, `handleModelCatalogRequest`),
  `force-dynamic`, Node runtime; these are what e2e specs answer locally instead of
  reaching OpenRouter.

**What is missing to run the REAL model against a scenario offline:** every existing
harness substitutes a fake/recording `fetch` for the OpenRouter call, by design (the
activation runbook, `docs/ai-assistant-phase-1-activation.md`, states outright: **"Live-
provider journeys are an external release blocker... No test supplies a real
credential"**). To run a real model offline against a scenario you would need to:
1. Supply a real `OPENROUTER_API_KEY` + tool-capable model id (the two headers
   `openrouter-agent.ts` reads) instead of `credentialHeaders()`'s sentinel.
2. Skip `recordingOpenRouter`/`test-support.ts`'s fake fetch and let
   `createOpenRouterAgent` use global `fetch` (its default when `options.fetch` is
   omitted) so the request really reaches OpenRouter.
3. Seed the conversation's scenario state the way `assistant-test-bridge` or
   `SCENARIOS[name]()` + `serializeScenario` already do, and drive a turn via
   `runRequest`/`readSse` against `createSchedulerCopilotRuntime` exactly as
   `model-visible-tools.test.ts` does structurally — just with the real key.
4. There is no existing "assistant eval" runner that scores a live transcript against
   an expected tool-call/proposal/verdict — `repair-eval.test.ts` is the nearest
   analog but is explicitly pure/no-LLM. Building one would mean combining: a
   `SCENARIOS`-style ward → `serializeScenario` → seed via the runtime handler with a
   real key → capture the tool calls and the resulting `prepare_scenario_change`
   proposal → diff against `EXPECTED`/`AGREEMENT`-style expectations, and separately
   confirm the proposal's operations solve correctly via
   `test_assistant_repair_fixtures.py`'s pattern (real CP-SAT on the resulting YAML).

## 9. Docs

- `docs/ai-assistant.md` — user-facing Phase-1 description: capability table (can/
  cannot), turn-on flow, data-sent-to-OpenRouter disclosure, storage table, stop/clear
  table, troubleshooting table. States the Phase-1 scope precisely (no autonomous
  roster repair; tested candidates via `prepare_scenario_change`; optimize runs lifted
  2026-09-24 with a Run-button gate).
- `docs/ai-assistant-phase-1-activation.md` — the release gate / test-to-contract
  map. Full `mise`/pytest/playwright/docker command list (9 numbered lanes). Contains
  the authoritative "Where it is proved" table mapping each contract (containment,
  detachment, one-web-instance, activation, credential containment, atomic apply,
  diagnostic priority, capability-anchor drift, AI independence, Phase-2 absence, no
  secret leakage) to its exact test file — a ready checklist for scoping new evals so
  they don't duplicate an existing gate. Explicitly names live-provider testing as
  "the one lane this gate cannot run."
- `docs/superpowers/plans/2026-09-24-assistant-*.md` (guided-setup-and-repair,
  leave-request-ops, optimize-run, people-ops, rule-ops, self-correction) and
  `docs/superpowers/specs/2026-09-24-*.md` — the design/implementation plans behind
  the current playbook/repair-options code; useful for recovering the *intended*
  tool-call sequences per feature when writing new eval expectations.

## Summary of best eval-seed candidates, ranked

1. `web/lib/rules/ward-fixtures.test-support.ts` `SCENARIOS` (9 wards) — smallest,
   most directly reusable, already paired with expected repair ids and confirmations.
2. `core/tests/testcases/real/*.yaml` (3 wards) — richest real-world detail and
   documentation, best for open-ended "explain/modify this schedule" prompts.
3. `core/tests/fixtures/assistant_repair/*.{before,after}.yaml` — auto-generated,
   solver-proven before/after pairs; good for "does the assistant's proposed fix
   actually solve" regression evals.
4. `core/tests/testcases/artificial/ortools/*` and `basics/*_infeasible*` /
   `*_error*` — narrower, solver-grammar-level, best for negative/validation-message
   eval prompts.
