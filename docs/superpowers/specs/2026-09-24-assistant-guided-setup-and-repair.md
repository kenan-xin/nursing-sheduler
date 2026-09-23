# Assistant: Guided Setup and Feasibility Repair — Spec

Date: 2026-09-24. Status: draft for controller review.
Plan: `docs/superpowers/plans/2026-09-24-assistant-guided-setup-and-repair.md`.

## Why

The product goal (bd memory `agent-native-goal`, 2026-09-23) has two parts that no
single operation family covers:

1. The assistant takes a user from an empty scenario to a finished setup, a
   successful Optimize run and a roster they can review.
2. When a run is infeasible, the assistant suggests repairs that a ward manager
   really uses. Examples: borrow a nurse from another ward. Ask a nurse on leave to
   cover one shift. Allow one extra night this month. It never suggests something
   unsafe.

The binding rules do not change. Every change is a Preview that the user Applies
(`docs/ai-assistant.md`, "Product decision (2026-09-23)"). A change that relies on a
real person agreeing needs a host-derived confirmation before Apply, as `move_leave`
does (`web/lib/proposal/assumptions.ts`). AI is optional and uses the user's own key
(bd memory `ai-features-optional-byo-key`). So everything deterministic in this spec
(readiness, the staffing check, repair ranking) is a pure function. The app can
also show it without AI. The assistant only reads it and explains it.

## What exists today

- Home "Build Your Roster" (`web/components/home/home-guided.tsx`) shows six steps:
  Dates, Staff, Shifts, Rules, Requests & Leave, Generate. Readiness comes from
  `computeScenarioSummary` (`web/components/home/scenario-summary.ts`). If a step
  has at least one record (Dates: a valid range), it is "done". If
  `run.phase === "complete"`, Generate is done.
- No "Tier-1 static conflict validation" module exists. The nearest is
  `computeCoverageWarnings` (`web/components/requirements/requirements-model.ts`),
  which lists shift/date pairs that have no staffing requirement. The shared
  expansion helpers are in `web/lib/rules/expansion.ts`.
- The solver reports only a status. On an infeasible run it gives no reason
  (`CAUSE_UNAVAILABLE`, `web/lib/ai/diagnostic/diagnostic-explanations.ts`).
- `test_feasibility_candidates` (`web/components/ai/use-diagnostic-tools.ts`) tests
  up to 5 model-written candidates on copies of the last failed run. The first
  feasible one becomes an `optimizer_tested` Preview.
- The model receives three context entries: the authority statement, the full
  scenario and the current screen (`buildAssistantContext`).

## Dependencies (other plans, treated as available)

- Rule ops (`2026-09-24-assistant-rule-ops.md`): raise or lower a count rule target.
- People ops (`2026-09-24-assistant-people-ops.md`): add a person, including a
  temporary (borrowed) person, and group membership.
- Leave/request ops (`2026-09-24-assistant-leave-request-ops.md`): `add_leave`,
  `set_off_request`, `set_shift_request`, `clear_requests`. The host already adds
  the `leave_cancelled` confirmation to cleared leave ("only if the nurse agrees").
- Optimize run (`2026-09-24-assistant-optimize-run.md`): `request_optimize_run`
  shows a Run card that the user presses, and `get_optimize_result` reads the
  outcome. Its infeasible guidance line changes to point at
  `suggest_feasibility_options`.

## Part 1: Guided setup

**Step order.** Dates → Staff → Shifts → Rules (staffing) → Requests & Leave →
Run → Review. This is the Home order, so the assistant and the Home cards agree.
Shifts and staff do not depend on each other. Rules need both.

**How the assistant knows what is missing.** A new read tool is
`get_setup_progress`. It returns each step with `done` and a one-line detail. It
also returns guidance for the next step. It uses the same `computeScenarioSummary`
as Home, plus two checks that Home does not make:

- Rules is not done until every worked shift has a staffing requirement on every
  date (`computeCoverageWarnings`). "One rule exists" is not a finished setup.
- Known staffing gaps (Part 2 static check) are counted, so the assistant can warn
  before a run that is sure to fail.

Requests & Leave is optional for the assistant. "Nobody has leave this period" is a
valid answer. The assistant asks once and then moves on. Home keeps its current
display (a follow-up can align it).

**Minimum questions.** Each step's guidance lists the few facts that the assistant
must ask for. Examples:

- Dates: the first and last day, and whether to import public holidays.
- Staff: the names, and which nurses are RNs or seniors.
- Shifts: the codes, with start and end times and the unpaid break.
- Rules: how many nurses each shift needs, and how many must be RNs.

The assistant never guesses a number, date or name. It asks.

**Batching and handover.** One step is one Preview. It holds up to 25 operations,
and the assistant splits a larger step. After the Preview is shown, the assistant
says what Apply will do and stops. When the user applies, the assistant calls
`get_setup_progress` again and continues with the next step. The Run step uses the
Optimize tool (which the user confirms). The Review step uses the result reader
and gives a short summary of the roster.

## Part 2: Feasibility repair

### Static staffing check (deterministic evidence)

`findStaffingShortfalls(scenario)` is a pure function in `web/lib/rules/`. It reads
only the scenario and reports three kinds of finding that are provably infeasible:

- `requirement_short`: on a date, one staffing requirement needs N people from its
  qualified set, but fewer than N of them are free. A person on leave is not free.
  A person with a hard day off, or a hard "never" request for those shifts, is
  also not free.
- `day_short`: on a date, requirements with separate shifts together need more
  people than are free. Each nurse works at most one shift per day, so this is a
  proof.
- `cap_short`: over the period, a requirement needs more shifts than the qualified
  people are allowed to work under hard count caps, for example "at most 4 nights".

The evidence contract lets deterministic evidence name a cause. So the assistant
can say "Night on Tue 5 Nov needs 1 RN and the only RN, Ana, is on leave" as a
fact. Sometimes the check finds nothing but the solver still says infeasible. Then
the cause is unknown, and each option is a hypothesis with that label.

Known limits: the check ignores succession, affinity and covering rules, and
requirements that use coefficients. Those infeasibilities fall to the hypothesis
path.

### Repair playbook (typed data, versioned)

Each entry has: when to use it, disruption, who must agree, how that agreement is
enforced, and the concrete operations. Ranking depends on the situation (below).

| # | Repair | When | Disruption | Who agrees (enforced by) | Ops |
|---|---|---|---|---|---|
| 1 | Turn a hard "must/never" shift request into a strong preference | A hard request removes the only free qualified nurse | Low | The nurse who asked (chat) | `set_shift_request` with a finite weight |
| 2 | One extra shift for a willing nurse, within legal limits | A single-person hard cap blocks supply | Medium | That nurse (host: `extra_shifts_agreed`) | count target +1 |
| 3 | Relax one named count rule for this period (for example 6 nights instead of 5) | A group cap blocks supply (`cap_short`) | Medium | Manager, checking contract and legal limits (Apply) | count target + smallest delta that closes the gap, at most +2 |
| 4 | Borrow a float, agency or other-ward nurse for the short dates | Short dates, no cheaper option | Medium (cost) | The lending ward or agency (host: `borrowed_staff_arranged`). Manager confirms her skill group. | add temporary person in the needed group, hard day off on other dates |
| 5 | Ask a named nurse on leave to cover one shift | A qualified nurse is on leave on the short date | High (personal) | That nurse (host: `leave_cancelled`) | `clear_requests` on that one date |
| 6 | Run the shift one short on that date (headcount only, never below 1) | Headcount requirement with everyone asked | High (safety call) | Manager (Apply) | `set_staffing_requirement_people` if the card covers only short dates. Else open the screen. |
| 7 | Split a long shift so part-timers can cover | A long shift (11 hours or more) is short | High (rework) | Manager | advice plus open the Shifts screen, no auto ops |

**Never suggested (safety floor, also enforced in code):**

- Relaxing or turning off a succession rule (rest between shifts, for example no
  day shift straight after a night shift).
- Relaxing or turning off a covering (preceptor supervision) rule.
- Lowering a requirement restricted to a group (skill mix, for example 1 RN on
  every night).
- Setting any staffing requirement to 0, or turning one off.
- Raising a cap by more than 2, or removing a cap.
- Removing or moving leave without the named nurse's host-recorded agreement.
- Asking a nurse on sick or compassionate leave. The app has one leave kind, so the
  assistant must ask what kind of leave it is.
- Putting a borrowed nurse in a skill group without the manager confirming her
  qualification.
- Inventing a real person's name. Temporary staff get a placeholder label until the
  user names them.

### Ranking

The situation is chosen from the findings. Repairs are tried in the table order for
that situation, options that cannot be built are skipped, and at most 3 are
returned.

- **Capped** (any `cap_short`): 2, 3, 4, 6.
- **Acute** (short on 3 or fewer dates): 1, 4, 5, 6, 7.
- **Chronic** (short on more than 3 dates): 4, 3, 6, 7.
- **Unexplained** (no findings, but the run was infeasible): 1, 3, as hypotheses.

The order follows ward practice. First remove a preference, then use willing staff
and the float pool. Asking someone on leave is a last resort before running short.

### Explaining it

A new read tool is `suggest_feasibility_options`. It returns up to 5 findings in
ward language: the day, the shift, how many are needed, how many are free, and who
is away and why. It also returns up to 3 ranked options, the safety floor and short
instructions. The assistant:

1. Says in one or two sentences which day and shift is short and why.
2. Offers 2-3 options, one line each, best first, each naming who must agree.
3. Asks the questions the option needs (which ward, the nurse's name, what kind of
   leave) and never invents answers.
4. After an infeasible run, tests the options' operations with
   `test_feasibility_candidates` before calling any option "tested". Otherwise it
   says "untested".
5. Prepares the chosen option. The host asks for the real-world confirmation, and
   the user Applies and runs again.

## Acceptance

- Pure tests (CI, no LLM) cover five scripted scenarios. They are: empty,
  understaffed night, the only RN on leave, rule too strict (max nights), and too
  few nurses overall. For each scenario, the tests check three things. The ranked
  options are sensible and safe. Each option maps to operations that the host
  accepts (`applyAssistantCommands`), with the right confirmation. After the top
  option, the static check is clean.
- Real-solver proof: the before and after scenarios are written as YAML fixtures.
  A core pytest shows that each one is INFEASIBLE before and FEASIBLE after the top
  option.
- Live verification on the deployed app, done by hand by the controller, following
  the plan's final task.

## Out of scope

- Roster (Phase-2) repair of a produced roster.
- Showing the static check in the non-AI UI. It is ready for that, and that is a
  follow-up.
- Legal-limit knowledge. The app cannot know labour law, so it asks the manager to
  confirm.
