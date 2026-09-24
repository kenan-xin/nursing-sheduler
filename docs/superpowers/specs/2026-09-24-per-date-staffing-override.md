# Per-date staffing override (bead nursing-sheduler-2se)

## Problem

Staffing requirements are EXACT counts, and overlapping requirements all apply
(`core/nurse_scheduling/preference_types.py`, `shift_type_requirements`: every matching
equation gets its own `==` constraint). "Lower the night minimum on 14 Oct by one" next
to an all-dates "Exactly 2 on N" is therefore infeasible: the 14 Oct rule says 1, the
all-dates rule still says 2. Today a manager (or the assistant) must rewrite the
all-dates rule as ~30 explicit dates and add a one-date rule. The Preview then shows a
long date list. The repair playbook's "run one short on that date"
(`web/lib/ai/assistant/repair-options.ts`, `runOneShort`) is advice-only for any
requirement that covers more than the one short date.

## Options weighed

| | A. `exceptDates` + separate one-date rule | B. Per-date override on the requirement | C. "Narrower rule wins" precedence |
|---|---|---|---|
| Solver | skip dates, 2 lines | per-date count, 3 lines | rewrites overlap semantics |
| Existing docs | unchanged | unchanged | **changes the meaning of layered rules the solver comment calls intentional** |
| One change = | 2 cards edited/created, copying shift type, qualified people, coefficients, preferred count | 1 field on 1 card | 1 card |
| Assistant | 2 ops. `add_staffing_requirement` cannot carry preferred count or coefficients, so it cannot copy every rule | 1 op | 1 op |
| Preview | two entries, one a new rule | "14 Oct: exactly 2 → 1 on N" | new rule, but its effect on the old one is invisible |
| Coupling | a change to the base rule's shift or people does not reach the exception. Deleting the base leaves the exception behind | exception lives and dies with its rule | n/a |
| Requirements screen | more cards | one "Different number on some dates" list inside the card | no UI, invisible magic |

**Recommendation: B.** An exception is a property of one rule ("this rule, but 1 on
14 Oct"), not a second rule. It is the smallest solver change. It keeps the meaning of
every existing document. It gives the assistant one operation with one Preview line.
The exception cannot drift from its rule or outlive it. C is rejected: it silently
changes documents that layer rules on purpose.

## Design

### Schema (canonical YAML, additive, no version bump)

```yaml
- type: shift type requirement
  shiftType: N
  requiredNumPeople: 2
  requiredNumPeopleOverrides: [[2026-10-14, 1], [2026-10-24, 3]]
  date: ALL
  weight: -1
```

- `requiredNumPeopleOverrides: list[[ISO date, int]]`, optional. The pair shape copies
  `shiftTypeCoefficients`. Lists of pairs survive YAML/JSON and hash deterministically.
  Map keys that look like dates do not: PyYAML turns them into `date` objects.
- Keys are concrete ISO dates only. `ALL`, weekday names, date groups, ranges and
  `DD`/`MM-DD` shorthands are not keys. Counts are integers `>= 0`. No duplicate dates.
- An override replaces `requiredNumPeople` on that date **only**. Shift type, qualified
  people (and their ban), coefficients, preferred count and weight are unchanged.
  With `preferredNumPeople` set, the date's range becomes `override..preferred`.
- Each override date must be one of the requirement's resolved dates. If it is not,
  the solver raises. If `preferredNumPeople` is set, no override may exceed it.
- Additive optional field under `apiVersion: alpha`: web and solver ship together, so
  no version bump (precedent: `hoursContract`). `workspaceVersion` stays 1.
- The UI stores the same pairs on `RequirementCard`, sorted by date. Saving drops an
  override equal to the rule's own count (same normalization as `preferredNumPeople`).
- Changing the roster range drops overrides whose date left the range, so a copied
  roster never carries a stale exception into the solver.

### Semantics everywhere a requirement is read

Solver, static staffing check (`lib/rules/shortfalls.ts`), roster viewer per-cell
check (`lib/roster-viewer/requirements.ts`), Preview sentences, repair options: all
read the count through one rule, `requiredOn(card, iso)`. The per-shift "baseline
minimum" (`lib/roster/context.ts`) keeps showing the rule's usual number: it is a
per-shift summary, not a per-date check.

### Requirements screen

- Card editor: a "Different number on some dates" field below Dates. Each row has a
  date select, a number and Remove. "Add a date" appends a row. The date select offers
  only the dates the rule currently covers, labelled "Wed 14 Oct".
- Validation, verbatim:
  - `Pick a date for each exception`
  - `<14 Oct> has more than one exception`
  - `<14 Oct> is not one of this requirement's dates`
  - `The number of people on <14 Oct> must be a whole number, 0 or more`
  - `The number of people on <14 Oct> must not be more than the preferred number of people`
- Card list: if a card has exceptions, an "Exceptions" field shows `14 Oct: 1 · 24 Oct: 3`.
- Help note under the field: "Use this for a single day that needs a different number,
  such as one fewer on a quiet public holiday. Everything else about the rule still
  applies on that day."

### Assistant (propose, then Apply, with parity)

- New arm `set_staffing_requirement_on_date { ruleId, date, requiredNumPeople }`. It
  fills the rule's own Edit form with one exception row, then runs the same validator
  and save (`validateRequirementForm`, `applyRequirementPatch`) as the screen. Sending
  the rule's own number removes the exception. Every field is required (house rule).
- `edit_staffing_requirement` keeps overrides as stored. If its new dates no longer
  cover an override date, the host refuses it with the form's own error.
- Preview: an override-only change reads `14 Oct: exactly 2 → 1 on N` (preferred
  count: `14 Oct: 2 to 3 → 1 to 3 on N`). A rule sentence lists exceptions:
  `Exactly 2 people on N, every date, except 14 Oct: 1`.

### Repair playbook

`run_one_short` becomes appliable for a head count covering many dates: it proposes
`set_staffing_requirement_on_date` with `n - 1` on the short date, where `n` is that
date's current count. A single-date rule with no overrides keeps using
`set_staffing_requirement_people`. The safety floor is unchanged in substance and now
covers the new arm: never below 1, never on a skill-mix requirement, never below the
skill mix that holds on that date. `isSafeOption` allows the arm only as "lower one
covered date of a plain head count by exactly 1".

## Acceptance

1. pytest: all-dates "2 on N" plus a one-nurse-short date is INFEASIBLE. The same
   document with the override on that date is FEASIBLE. The override is exact:
   forcing 2 on that date is INFEASIBLE. Invalid overrides raise named errors.
2. The static check, roster viewer and Preview all use the override count.
3. The Requirements screen adds, edits and removes an exception, with the messages
   above. YAML export and import round-trip it.
4. Parity: the arm accepts and refuses exactly what the Edit form does, and writes
   the same card.
5. `run_one_short` on a multi-date head count yields one appliable operation that
   passes `isSafeOption`, and the real solver finds the resulting ward feasible.
6. `pnpm typecheck`, lint, vitest, pytest, `pnpm capability:generate` clean.
