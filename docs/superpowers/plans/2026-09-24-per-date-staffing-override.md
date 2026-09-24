# Per-Date Staffing Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staffing requirement can carry a different head count on a few dates ("Exactly 2 on N, except 14 Oct: 1"). The ward manager sets it on the Requirements screen. The assistant proposes it with one operation. The repair playbook's "run one short on that date" becomes appliable for a rule that covers many dates.

**Architecture:** One optional field, `requiredNumPeopleOverrides: [isoDate, count][]`, on the shift type requirement, end to end: solver model and constraint, canonical YAML, UI card, persistence, import. Every reader of a requirement count goes through one rule: on a listed date the override replaces `requiredNumPeople`, and nothing else changes. The screen edits it through the existing requirement form (`RequirementFormState` gains one list). The new assistant arm `set_staffing_requirement_on_date` fills that same form and runs the same validator and save. `runOneShort` emits the new arm, guarded by the existing safety floor.

**Tech Stack:** Python 3.14 + pydantic v2 + OR-Tools CP-SAT (`core/`). Next.js 16, TypeScript, zod v4, vitest 4, @testing-library/react, Playwright, oxlint, ast-grep (`web/`).

**Spec:** `docs/superpowers/specs/2026-09-24-per-date-staffing-override.md`. Bead `nursing-sheduler-2se`.

## Global Constraints

- Field name `requiredNumPeopleOverrides`. Shape: list of `[YYYY-MM-DD, integer >= 0]` pairs, no duplicate dates, stored sorted by date. Concrete ISO dates only.
- An override replaces `requiredNumPeople` on its date only. Shift type, qualified people and their ban, coefficients, preferred count and weight stay as they are.
- Each override date must be one of the requirement's resolved dates. If `preferredNumPeople` is set, an override must not exceed it.
- No `apiVersion` or `workspaceVersion` bump (additive optional field, web and solver ship together).
- Shared names, used by every task exactly as written: `requiredOn(card, iso)`, `requirementDateIsos(state, card)` (both in `web/lib/rules/shortfalls.ts`), `formatShortDate(iso, withWeekday?)` (in `web/lib/dates/date-id.ts`), `OverrideRow`, `requirementCoveredIsos(state, dates)`, `OVERRIDE_MESSAGES`, `parseRequirementInteger` (in `web/components/requirements/requirements-model.ts`), arm `set_staffing_requirement_on_date { ruleId, date, requiredNumPeople }`.
- Verbatim validation messages (spec): `Pick a date for each exception` / `<d> has more than one exception` / `<d> is not one of this requirement's dates` / `The number of people on <d> must be a whole number, 0 or more` / `The number of people on <d> must not be more than the preferred number of people`. `<d>` is `formatShortDate(iso)`, for example `14 Oct`.
- Preview wording: override-only change `14 Oct: exactly 2 → 1 on N`. With a preferred count: `14 Oct: 2 to 3 → 1 to 3 on N`. Rule sentence: `Exactly 2 people on N, every date, except 14 Oct: 1`.
- Assistant arm rules (from the rule-ops plan): every field required, no `.optional()`/`.nullable()`. The discriminant is a one-member `z.enum([...])`. The new arm goes at the END of `AssistantCommandV1`, `ASSISTANT_COMMAND_TYPES` and the zod union. If the skill-mix plan (`2026-09-24-skill-mix-rules.md`) lands first, append after its arms.
- `lib/proposal` imports no React (`react-free.test.ts`). Import models (`*-model.ts`, `requirement-patch.ts`), never `.tsx`.
- Validation is reused, never copied. The arm calls `requirementToForm`, `validateRequirementForm`, `applyRequirementPatch`.
- Safety floor text (`SAFETY_FLOOR` in `playbook.ts`) is unchanged. The floor code learns the new arm.
- Commands. Web: `cd web && pnpm vitest run <path>`, `pnpm typecheck`, `pnpm lint:oxlint && pnpm lint:ast-grep`, `pnpm capability:generate`. Solver: from the repo root `PYTHONPATH=core /usr/bin/python3 -m pytest <path> -v`. Do not run `pnpm install` or `pnpm build`.
- Locked tests change only where a task says so, and the commit message names the change.
- Repo default is "do not commit unless asked". A commit step runs only with commit authority in the session.

## Review Focus

1. **A roster copied to next month.** Every override is date-specific, so after a range change it is stale. Expected: overrides whose date left the range are dropped, and the Preview of `set_roster_range` lists the drop as a cascade. (Test: Task 2, `drops overrides whose date left the range`.)
2. **The rule's dates narrowed under an exception.** The manager (or `edit_staffing_requirement`) moves the rule to weekdays while an exception sits on a Saturday. Expected: the form error `<d> is not one of this requirement's dates`, in both surfaces. It must never save a document the solver rejects. (Tests: Task 5, `refuses an exception outside the rule's dates`. Task 7, `edit refuses dates that drop an exception`.)
3. **An exception above the preferred count.** Expected: refused by the form and by the solver, never saved. (Tests: Task 1, `test_override_above_preferred_raises`. Task 5, `refuses an exception above a distinct preferred count`.)
4. **The rule's own number typed as the exception.** Expected: saving drops it (no no-op exception is stored). The assistant sends the rule's own number to remove an exception. (Tests: Task 5, `drops an exception equal to the rule's number`. Task 7, `sending the rule's own number removes the exception`.)
5. **YAML written by hand or by PyYAML.** Some loaders parse an unquoted `2026-10-14` to a date object. A group name like `PH` is not a date. Expected: import normalizes date objects to ISO, and the producer schema refuses a non-ISO key. (Tests: Task 2, `imports date objects as ISO` and `refuses a non-ISO override date`.)

---

## File Structure

- `core/nurse_scheduling/models.py`: the field and its per-entry validator.
- `core/nurse_scheduling/preference_types.py`: per-date count in `shift_type_requirements`.
- `core/tests/test_requirement_overrides.py` (create): solver proof.
- `web/lib/scenario/types.ts`, `canonical.ts`, `schemas/producer.ts`, `schemas/import.ts`, `import-scenario.ts`, `web/lib/store/persistence.ts`: plumbing.
- `web/lib/dates/range-cascade.ts`: drop stale overrides.
- `web/lib/dates/date-id.ts`: `formatShortDate`.
- `web/lib/rules/shortfalls.ts`: `requiredOn`, `requirementDateIsos`, per-date equations.
- `web/lib/roster-viewer/requirements.ts`: per-cell count.
- `web/components/requirements/requirements-model.ts`: form state, validation, build, load.
- `web/components/requirements/date-overrides-field.tsx` (create) + `.test.tsx` (create): the field.
- `web/components/requirements/requirement-form.tsx`, `requirement-card-list.tsx`: wiring and display.
- `web/lib/proposal/commands.ts`, `operations.ts`, `diff.ts`: the arm and Preview wording.
- `web/lib/ai/assistant/repair-options.ts`, `playbook.ts`: repair hook.
- `web/lib/rules/ward-fixtures.test-support.ts`: new scripted ward `shortOnLeaveDay`.
- `core/tests/test_assistant_repair_fixtures.py`: solver proof for the repair.
- `web/lib/capability/help-content.ts` + regenerated `registry.generated.ts`: help text.

---

### Task 1: Solver honours per-date overrides

**Files:**
- Modify: `core/nurse_scheduling/models.py:326-347` (`ShiftTypeRequirementsPreference`)
- Modify: `core/nurse_scheduling/preference_types.py:106-218` (`shift_type_requirements`)
- Create: `core/tests/test_requirement_overrides.py`

**Interfaces:**
- Produces: YAML field `requiredNumPeopleOverrides: [[date, int], ...]` accepted by `scheduler.schedule`. Errors (ValueError text): `requiredNumPeopleOverrides date '<date>' is not one of this requirement's dates.`, `requiredNumPeopleOverrides count for '<date>' must not exceed preferredNumPeople.`, `requiredNumPeopleOverrides count for <date> must be at least 0.`, `Duplicate requiredNumPeopleOverrides date <date>.`

- [ ] **Step 1: Write the failing tests**

Create `core/tests/test_requirement_overrides.py`:

```python
"""Per-date staffing overrides (bead nursing-sheduler-2se), proven with the real solver."""

import pytest

from nurse_scheduling import scheduler

# Three nurses, every day needs 1 on D and 2 on N: all three work every day.
# cara is on leave on the 2nd, so the 2nd is one short.
BASE = """
apiVersion: alpha
dates:
  range:
    startDate: 2026-11-01
    endDate: 2026-11-03
people:
  items: [{id: ana}, {id: ben}, {id: cara}]
shiftTypes:
  items: [{id: D}, {id: N}]
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: D
    requiredNumPeople: 1
    weight: -1
  - type: shift type requirement
    shiftType: N
    requiredNumPeople: 2
{night_extra}
    weight: -1
  - type: shift request
    person: cara
    date: 2026-11-02
    shiftType: LEAVE
    weight: .inf
{more}
"""


def _status(night_extra: str = "", more: str = "") -> str:
    # str.replace, not str.format: the YAML's flow mappings use braces.
    yaml = BASE.replace("{night_extra}", night_extra).replace("{more}", more).encode()
    _df, _solution, _score, status, _cells = scheduler.schedule(yaml, timeout=30)
    return status


def test_without_override_the_leave_day_is_infeasible():
    assert _status() == "INFEASIBLE"


def test_override_on_the_leave_day_makes_it_feasible():
    assert _status("    requiredNumPeopleOverrides: [[2026-11-02, 1]]") in {"FEASIBLE", "OPTIMAL"}


def test_override_is_exact_on_its_date():
    # On the 1st nobody is away: ana and ben on N plus cara on D fits the people, so only
    # the exact override (1 on N) can make forcing two nights infeasible.
    overrides = "    requiredNumPeopleOverrides: [[2026-11-01, 1], [2026-11-02, 1]]"
    must_work = "\n".join(
        f"  - type: shift request\n    person: {p}\n    date: 2026-11-01\n    shiftType: N\n    weight: .inf"
        for p in ("ana", "ben")
    )
    assert _status(overrides) in {"FEASIBLE", "OPTIMAL"}
    assert _status(overrides, must_work) == "INFEASIBLE"


def test_override_can_raise_a_date():
    # 3 on N on the 3rd plus 1 on D needs 4 people: infeasible proves the raise applies.
    assert _status("    requiredNumPeopleOverrides: [[2026-11-02, 1], [2026-11-03, 3]]") == "INFEASIBLE"


def test_iso_string_dates_are_accepted():
    assert _status('    requiredNumPeopleOverrides: [["2026-11-02", 1]]') in {"FEASIBLE", "OPTIMAL"}


def test_override_outside_the_requirement_dates_raises():
    extra = "    date: [2026-11-01, 2026-11-03]\n    requiredNumPeopleOverrides: [[2026-11-02, 1]]"
    with pytest.raises(ValueError, match="is not one of this requirement's dates"):
        _status(extra)


def test_override_above_preferred_raises():
    extra = "    preferredNumPeople: 2\n    requiredNumPeopleOverrides: [[2026-11-02, 3]]"
    with pytest.raises(ValueError, match="must not exceed preferredNumPeople"):
        _status(extra)


def test_negative_override_raises():
    with pytest.raises(ValueError, match="must be at least 0"):
        _status("    requiredNumPeopleOverrides: [[2026-11-02, -1]]")


def test_duplicate_override_date_raises():
    with pytest.raises(ValueError, match="Duplicate requiredNumPeopleOverrides date"):
        _status("    requiredNumPeopleOverrides: [[2026-11-02, 1], [2026-11-02, 0]]")


def test_other_overlapping_requirements_still_apply():
    # A second all-dates "2 on N" rule still demands 2 on the 2nd: the override
    # relaxes only its own rule, so the leave day stays infeasible.
    second = "  - type: shift type requirement\n    shiftType: N\n    requiredNumPeople: 2\n    weight: -1"
    assert _status("    requiredNumPeopleOverrides: [[2026-11-02, 1]]", second) == "INFEASIBLE"
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests/test_requirement_overrides.py -v`
Expected: `test_without_override_the_leave_day_is_infeasible` and `test_other_overlapping_requirements_still_apply` PASS. The rest FAIL with a pydantic `Extra inputs are not permitted` error for `requiredNumPeopleOverrides`.

- [ ] **Step 3: Add the field to the model**

In `core/nurse_scheduling/models.py`, `ShiftTypeRequirementsPreference`, after `requiredNumPeople: int`:

```python
    # Per-date exceptions to requiredNumPeople: [[date, count], ...]. On a listed date
    # the requirement uses that count instead. Every other field still applies there.
    requiredNumPeopleOverrides: list[tuple[datetime.date, int]] | None = None
```

After the existing `validate_weight_field` validator in the same class:

```python
    @field_validator("requiredNumPeopleOverrides")
    @classmethod
    def validate_required_num_people_overrides(cls, v):
        if v is None:
            return v
        seen = set()
        for date, count in v:
            if count < 0:
                raise ValueError(f"requiredNumPeopleOverrides count for {date} must be at least 0.")
            if date in seen:
                raise ValueError(f"Duplicate requiredNumPeopleOverrides date {date}.")
            seen.add(date)
        return v
```

- [ ] **Step 4: Use the per-date count in the constraint**

In `core/nurse_scheduling/preference_types.py`, `shift_type_requirements`, directly after `coefficients = _parse_shift_type_requirement_coefficients(...)`:

```python
    # Per-date overrides replace requiredNumPeople on their date only.
    overrides = {}
    for date, count in preference.requiredNumPeopleOverrides or []:
        d = (date - ctx.dates.range.startDate).days
        if d not in ds:
            raise ValueError(f"requiredNumPeopleOverrides date '{date}' is not one of this requirement's dates.")
        if preference.preferredNumPeople is not None and count > preference.preferredNumPeople:
            raise ValueError(f"requiredNumPeopleOverrides count for '{date}' must not exceed preferredNumPeople.")
        overrides[d] = count
```

Then at the top of `for d in ds:` add `required = overrides.get(d, preference.requiredNumPeople)`, and replace the two uses of `preference.requiredNumPeople` in the hard constraints:

```python
            if preference.preferredNumPeople is not None:
                ctx.solver.add_constraint(actual_n_people >= required)
            else:
                ctx.solver.add_constraint(actual_n_people == required)
```

Add one line to the function's header comment: `# requiredNumPeopleOverrides replaces requiredNumPeople on each listed date.`

- [ ] **Step 5: Run the tests and see them pass**

Run: `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests/test_requirement_overrides.py core/tests/test_preference_validation.py core/tests/test_models_validation.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add core/nurse_scheduling/models.py core/nurse_scheduling/preference_types.py core/tests/test_requirement_overrides.py
git commit -m "feat(solver): per-date requiredNumPeople overrides on a staffing requirement"
```

---

### Task 2: Carry the field through the web document (types, YAML, import, persistence, range change)

**Files:**
- Modify: `web/lib/scenario/types.ts:221-231` (`CanonicalShiftTypeRequirementPreference`), `:459-468` (`RequirementCardBody`)
- Modify: `web/lib/scenario/canonical.ts:141-154`
- Modify: `web/lib/scenario/schemas/producer.ts:128-138` (`zRequirement`)
- Modify: `web/lib/scenario/schemas/import.ts:102-112` (`zImportRequirement`)
- Modify: `web/lib/scenario/import-scenario.ts:295-306` (`normalizeRequirement`)
- Modify: `web/lib/store/persistence.ts:462-481` (`validateRequirementCard`)
- Modify: `web/lib/dates/range-cascade.ts`
- Test: `web/lib/scenario/serialize.test.ts`, `web/lib/scenario/import-scenario.test.ts`, `web/lib/dates/range-cascade.test.ts`, `web/lib/scenario/differential/differential.test.ts` (gated)

**Interfaces:**
- Produces: `export type RequirementOverride = [string, number];` in `types.ts`. `RequirementCardBody.requiredNumPeopleOverrides?: RequirementOverride[]`. The same optional field on `CanonicalShiftTypeRequirementPreference`.

- [ ] **Step 1: Write the failing tests**

In `web/lib/scenario/serialize.test.ts` (use the file's existing `makeValidUiState` import from `./test-fixtures`):

```ts
it("round-trips requirement overrides through YAML", () => {
  const state = makeValidUiState();
  state.cardsByKind.requirements = [
    {
      uid: "r",
      shiftType: "D",
      requiredNumPeople: 2,
      requiredNumPeopleOverrides: [[state.rangeStart, 1]],
      weight: -1,
    },
  ];
  const yaml = serializeScenario(state);
  expect(yaml).toContain("requiredNumPeopleOverrides");
  const back = importScenarioYaml(yaml);
  expect(back.ok).toBe(true);
  if (back.ok) {
    expect(back.state.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([
      [state.rangeStart, 1],
    ]);
  }
});

it("refuses a non-ISO override date", () => {
  const state = makeValidUiState();
  state.cardsByKind.requirements = [
    { uid: "r", shiftType: "D", requiredNumPeople: 2, requiredNumPeopleOverrides: [["PH", 1]], weight: -1 },
  ];
  expect(() => serializeScenario(state)).toThrow();
});
```

Adjust the two `importScenarioYaml` result field names (`ok`, `state`) to the ones `import-scenario.test.ts` already uses. Check that file's first test before writing.

In `web/lib/scenario/import-scenario.test.ts`:

```ts
it("imports date objects as ISO", () => {
  // `yaml` 1.2 keeps ISO dates as strings. A loader that makes Date objects must not leak them.
  const yaml = `apiVersion: alpha
dates: {range: {startDate: 2026-10-01, endDate: 2026-10-31}}
people: {items: [{id: ana}]}
shiftTypes: {items: [{id: N}]}
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: N
    requiredNumPeople: 2
    requiredNumPeopleOverrides: [[2026-10-14, 1]]
    weight: -1
`;
  const result = importScenarioYaml(yaml);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.state.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([
      ["2026-10-14", 1],
    ]);
  }
});
```

In `web/lib/dates/range-cascade.test.ts` (reuse the file's `seeded()` helper, and set a requirement card on it first):

```ts
it("drops overrides whose date left the range", () => {
  const state = seeded();
  state.cardsByKind.requirements = [
    {
      uid: "r",
      shiftType: "D",
      requiredNumPeople: 2,
      requiredNumPeopleOverrides: [
        [state.rangeStart, 1],
        [state.rangeEnd, 3],
      ],
      weight: -1,
    },
  ];
  const next = applyRangeChange(state, { start: state.rangeStart, end: state.rangeStart });
  expect(next.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([
    [state.rangeStart, 1],
  ]);
  const gone = applyRangeChange(state, { start: state.rangeEnd, end: state.rangeEnd });
  expect(gone.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([[state.rangeEnd, 3]]);
});

it("removes the field when no override is left", () => {
  const state = seeded();
  state.cardsByKind.requirements = [
    { uid: "r", shiftType: "D", requiredNumPeople: 2, requiredNumPeopleOverrides: [[state.rangeEnd, 1]], weight: -1 },
  ];
  const next = applyRangeChange(state, { start: state.rangeStart, end: state.rangeStart });
  expect(next.cardsByKind.requirements[0]).not.toHaveProperty("requiredNumPeopleOverrides");
});
```

Check `seeded()`'s range first. The tests need `rangeStart !== rangeEnd`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `cd web && pnpm vitest run lib/scenario/serialize.test.ts lib/scenario/import-scenario.test.ts lib/dates/range-cascade.test.ts`
Expected: FAIL. TS errors on the unknown property, and the strict producer schema rejects the key.

- [ ] **Step 3: Add the type and the canonical projection**

`web/lib/scenario/types.ts`, above `RequirementCardBody`:

```ts
/** One per-date exception to `requiredNumPeople`: `[YYYY-MM-DD, count]`. */
export type RequirementOverride = [string, number];
```

Add `requiredNumPeopleOverrides?: RequirementOverride[];` after `requiredNumPeople` in BOTH `RequirementCardBody` and `CanonicalShiftTypeRequirementPreference`. Export `RequirementOverride` from `web/lib/scenario/index.ts` next to the other card types.

`web/lib/scenario/canonical.ts`, requirements loop, after `requiredNumPeople: card.requiredNumPeople,`:

```ts
        requiredNumPeopleOverrides: card.requiredNumPeopleOverrides,
```

- [ ] **Step 4: Add the schemas, the import normalizer and the persistence check**

`schemas/producer.ts`, `zRequirement`, after `requiredNumPeople`:

```ts
  requiredNumPeopleOverrides: z.array(z.tuple([zIsoDate, z.number().int().min(0)])).optional(),
```

`schemas/import.ts`, `zImportRequirement`, after `requiredNumPeople`:

```ts
  requiredNumPeopleOverrides: z
    .array(z.tuple([z.union([z.string(), z.date()]), z.number().int()]))
    .nullish(),
```

`import-scenario.ts`, `normalizeRequirement`, after `requiredNumPeople` (`isoDate` is the file's existing helper at line ~91):

```ts
    requiredNumPeopleOverrides: (
      pref.requiredNumPeopleOverrides as [string | Date, number][] | null | undefined
    )?.map(([date, count]): RequirementOverride => [isoDate(date), count]),
```

Import `RequirementOverride` with the other types. `clean` drops the `undefined`.

`web/lib/store/persistence.ts`, `validateRequirementCard`, at the end. The pair shape is the coefficient shape, so reuse its validator:

```ts
  validateOptionalCoefficients(
    el.requiredNumPeopleOverrides,
    "cardsByKind.requirements element requiredNumPeopleOverrides",
  );
```

- [ ] **Step 5: Drop stale overrides on a range change**

`web/lib/dates/range-cascade.ts`: extend the header comment's last bullet with `Requirement overrides are the exception: each is a single ISO date, so one whose date left the range is dropped, or it would reach the solver as an out-of-range date.` Then, in `applyRangeChange`, before the `rangeStart/rangeEnd` assignment:

```ts
  const kept = new Set(newItemsByIso(newRange).map(([iso]) => iso));
  next = {
    ...next,
    cardsByKind: {
      ...next.cardsByKind,
      requirements: next.cardsByKind.requirements.map((card) => withOverridesIn(card, kept)),
    },
  };
```

And below `newItemsByIso`:

```ts
/** The card without overrides on dates outside `kept`; the same object when none left. */
function withOverridesIn(card: RequirementCard, kept: ReadonlySet<string>): RequirementCard {
  const overrides = card.requiredNumPeopleOverrides;
  if (!overrides) return card;
  const inRange = overrides.filter(([iso]) => kept.has(iso));
  if (inRange.length === overrides.length) return card;
  const { requiredNumPeopleOverrides: _dropped, ...rest } = card;
  return inRange.length > 0 ? { ...rest, requiredNumPeopleOverrides: inRange } : rest;
}
```

Import `RequirementCard` from `@/lib/scenario`.

- [ ] **Step 6: Add the gated differential row**

In `web/lib/scenario/differential/differential.test.ts`, in the C1 describe, after the first test:

```ts
  it(
    "loads requirement overrides and dumps them as ISO pairs",
    { timeout: oracleBudget(1) },
    () => {
      const state = makeValidUiState();
      state.cardsByKind.requirements = [
        {
          uid: "r",
          shiftType: "D",
          requiredNumPeople: 1,
          requiredNumPeopleOverrides: [[state.rangeStart, 0]],
          weight: -1,
        },
      ];
      const res = callOracle({ op: "load", yaml: serializeScenario(state) });
      expect(res.ok).toBe(true);
      const prefs = res.model!.preferences as Record<string, unknown>[];
      const requirement = prefs.find((p) => p.type === "shift type requirement")!;
      expect(requirement.requiredNumPeopleOverrides).toEqual([[state.rangeStart, 0]]);
    },
  );
```

- [ ] **Step 7: Run the tests**

Run: `cd web && pnpm vitest run lib/scenario lib/dates lib/store/persistence && pnpm typecheck`
Expected: PASS. Then, where Python is available: `cd web && pnpm test:differential` PASS.

- [ ] **Step 8: Commit**

```bash
git add web/lib/scenario web/lib/store/persistence.ts web/lib/dates/range-cascade.ts web/lib/dates/range-cascade.test.ts
git commit -m "feat(scenario): carry requirement date overrides through YAML, import, storage and range change"
```

---

### Task 3: One count rule for every reader, and the static staffing check

**Files:**
- Modify: `web/lib/dates/date-id.ts` (add `formatShortDate`)
- Modify: `web/lib/rules/shortfalls.ts`
- Test: `web/lib/rules/shortfalls.test.ts`, `web/lib/dates/date-id.test.ts` (append, or create it if it does not exist)

**Interfaces:**
- Produces:
  - `formatShortDate(iso: string, withWeekday = false): string`: `"14 Oct"`, or `"Wed 14 Oct"`.
  - `requiredOn(card: Pick<RequirementCard, "requiredNumPeople" | "requiredNumPeopleOverrides">, iso: string): number`.
  - `requirementDateIsos(state: ScenarioUiState, card: Pick<RequirementCard, "date">): string[]`: the ISO dates a rule covers in this roster, in order.
  - `requirementDateIds(state, card)` now takes `Pick<RequirementCard, "date">` (callers unchanged).

- [ ] **Step 1: Write the failing tests**

`web/lib/rules/shortfalls.test.ts` (the file already imports `requirement`, `ward`, `people`, `cards`, `leave` from `./ward-fixtures.test-support`, or add them):

```ts
describe("requirement overrides", () => {
  // Every night needs 2, cara is on leave on the 5th: the 5th is one short.
  const shortFifth = (overrides?: [string, number][]) =>
    ward({
      staff: people("ana", "ben", "cara"),
      reqData: [leave("cara", "05")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 2, overrides ? { requiredNumPeopleOverrides: overrides } : {}),
        ],
      }),
    });

  it("reads the override on its date and the rule's number elsewhere", () => {
    const card = { requiredNumPeople: 2, requiredNumPeopleOverrides: [["2026-11-05", 1]] as [string, number][] };
    expect(requiredOn(card, "2026-11-05")).toBe(1);
    expect(requiredOn(card, "2026-11-04")).toBe(2);
  });

  it("finds the one-short date without an override", () => {
    expect(findStaffingShortfalls(shortFifth()).map((f) => f.dateId)).toEqual(["05"]);
  });

  it("finds no gap once the short date has an override of one fewer", () => {
    expect(findStaffingShortfalls(shortFifth([["2026-11-05", 1]]))).toEqual([]);
  });

  it("an override that raises a date makes that date short", () => {
    const findings = findStaffingShortfalls(shortFifth([["2026-11-05", 1], ["2026-11-03", 3]]));
    expect(findings.map((f) => [f.dateId, f.required])).toContainEqual(["03", 4]);
  });

  it("lists the ISO dates a rule covers", () => {
    const state = shortFifth();
    expect(requirementDateIsos(state, { date: ["2026-11-02", "2026-11-04"] })).toEqual([
      "2026-11-02",
      "2026-11-04",
    ]);
    expect(requirementDateIsos(state, { date: ["ALL"] })).toHaveLength(7);
  });
});
```

Date test:

```ts
import { describe, expect, it } from "vitest";
import { formatShortDate } from "./date-id";

describe("formatShortDate", () => {
  it("writes a date the way a ward roster does", () => {
    expect(formatShortDate("2026-10-14")).toBe("14 Oct");
    expect(formatShortDate("2026-10-14", true)).toBe("Wed 14 Oct");
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `cd web && pnpm vitest run lib/rules/shortfalls.test.ts lib/dates/date-id.test.ts`
Expected: FAIL. `requiredOn`, `requirementDateIsos` and `formatShortDate` are not exported. The override case still reports `05`.

- [ ] **Step 3: Add `formatShortDate`**

`web/lib/dates/date-id.ts`, below `describeDate`:

```ts
const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const SHORT_DATE_WEEKDAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** `14 Oct`, or `Wed 14 Oct`: how a ward roster writes a single day. */
export function formatShortDate(iso: IsoDate, withWeekday = false): string {
  return (withWeekday ? SHORT_DATE_WEEKDAY : SHORT_DATE).format(new Date(isoToUtcMs(iso)));
}
```

If `en-GB` puts a comma after the weekday in this Node build (`Wed, 14 Oct`), use `formatToParts` and join the parts with spaces. The test pins the output.

- [ ] **Step 4: Add the helpers and per-date equations to the static check**

`web/lib/rules/shortfalls.ts`:

1. Header comment, first bullet: append `a requiredNumPeopleOverrides entry replaces the count on its date;`.
2. Below `requirementDateIds`, and change that function's `card` parameter to `Pick<RequirementCard, "date">`:

```ts
/** The ISO dates a requirement covers in this roster period, in order. */
export function requirementDateIsos(
  state: ScenarioUiState,
  card: Pick<RequirementCard, "date">,
): string[] {
  const { items, expand } = makeDates(state);
  const covered = expand(card.date == null ? [RESERVED_SHIFT_TYPE.all] : asList(card.date));
  return items.filter((item) => covered.has(item.id)).map((item) => item.iso);
}

/** A requirement's head count on one date: its override there, else `requiredNumPeople`. */
export function requiredOn(
  card: Pick<RequirementCard, "requiredNumPeople" | "requiredNumPeopleOverrides">,
  iso: string,
): number {
  return card.requiredNumPeopleOverrides?.find(([date]) => date === iso)?.[1] ?? card.requiredNumPeople;
}
```

3. `Equation`: replace `max: number` with:

```ts
  /** Span id -> that date's floor, from `requiredNumPeopleOverrides`. */
  overrides: Map<string, number>;
  /** `preferredNumPeople`, the solver's ceiling on every date; null = the floor is exact. */
  preferred: number | null;
```

and add below the interface:

```ts
const need = (eq: Equation, dateId: string) => eq.overrides.get(dateId) ?? eq.required;
const ceiling = (eq: Equation, dateId: string) => eq.preferred ?? need(eq, dateId);
```

4. `buildEquations(state, range, expand, shiftsOf, peopleOf)` takes `range: Range` second. The caller passes `makeDates(state).range` (destructure `range` in `findStaffingShortfalls`). Replace `const max = ...` with:

```ts
    const overrides = new Map(
      (card.requiredNumPeopleOverrides ?? []).map(([iso, n]) => [toDateId(iso, range), n] as const),
    );
```

and in the pushed object replace `max,` with `overrides, preferred: card.preferredNumPeople ?? null,`.

5. `disjoint(candidates, dateId)` sorts by `need(b, dateId) - need(a, dateId)`. Pass `dateId` at both call sites.
6. `requirement_short`: `a.free.size >= need(eq, dateId)` and `required: need(eq, dateId)`.
7. `day_short`: `chosen.reduce((sum, eq) => sum + need(eq, dateId), 0)`.
8. `requirement_conflict`: `inner.reduce((sum, eq) => sum + need(eq, dateId), 0)`, `required <= ceiling(outer, dateId)`, `available: ceiling(outer, dateId)`.
9. `cap_short`: `const demand = dates.reduce((sum, d) => sum + need(eq, d), 0);`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `cd web && pnpm vitest run lib/rules lib/dates lib/ai/assistant && pnpm typecheck`
Expected: PASS. The existing repair tests do not change: no fixture has overrides yet.

- [ ] **Step 6: Commit**

```bash
git add web/lib/dates/date-id.ts web/lib/dates/date-id.test.ts web/lib/rules/shortfalls.ts web/lib/rules/shortfalls.test.ts
git commit -m "feat(rules): static staffing check reads per-date requirement overrides"
```

---

### Task 4: Roster viewer checks each day against that day's count

**Files:**
- Modify: `web/lib/roster-viewer/requirements.ts` (`RequirementEquation` ~50-90, model build ~290-320, `evaluateRequirementCell` ~425-480, single-target lookup ~590-607)
- Test: `web/lib/roster-viewer/requirements.test.ts`

**Interfaces:**
- Consumes: canonical `requiredNumPeopleOverrides` (Task 2).
- Produces: `RequirementEquation.requiredByDate: ReadonlyMap<number, number>` (date index -> count).

- [ ] **Step 1: Write the failing test**

In `requirements.test.ts`, next to the existing single-shift tests (reuse its `requirement(...)` document builder and its roster-index helper. Read the top of the file for their names):

```ts
it("checks a date with an override against the override", () => {
  const model = buildModelFor([
    requirement({ shiftType: "N", requiredNumPeople: 2, requiredNumPeopleOverrides: [[DAY_2_ISO, 1]] }),
  ]);
  // One person on N every day.
  const grid = gridWithOnePersonOnNEveryDay(model);
  expect(grid[0][1]).toMatchObject({ status: "checked", required: 1, short: 0, mismatch: false });
  expect(grid[0][0]).toMatchObject({ status: "checked", required: 2, short: 1, mismatch: true });
});
```

Replace `buildModelFor`, `gridWithOnePersonOnNEveryDay` and `DAY_2_ISO` with the file's own helpers and fixture range. Keep the two assertions exactly.

- [ ] **Step 2: Run it and see it fail**

Run: `cd web && pnpm vitest run lib/roster-viewer/requirements.test.ts`
Expected: FAIL, `required: 2` on the override day.

- [ ] **Step 3: Implement**

`RequirementEquation`, after `required`:

```ts
  /** Date index -> that day's lower/exact target, from `requiredNumPeopleOverrides`. */
  readonly requiredByDate: ReadonlyMap<number, number>;
```

In the model build, before `groups.forEach`:

```ts
    const requiredByDate = new Map<number, number>();
    for (const [iso, count] of requirement.requiredNumPeopleOverrides ?? []) {
      const day = resolver.resolveDates(iso);
      if (day.resolved) for (const index of day.values) requiredByDate.set(index, count);
    }
```

and add `requiredByDate,` to `base`. In `evaluateRequirementCell`, before `const upper`:

```ts
  const required = equation.requiredByDate.get(dateIdx) ?? equation.required;
```

and use `required` in `upper`, `short` and the returned `required`. In the single-target lookup (~line 603): `found = equation.requiredByDate.get(dateIdx) ?? equation.required;`. Add one line to the file header's solver-mirror list: `requiredNumPeopleOverrides replaces the target on its date.`

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd web && pnpm vitest run lib/roster-viewer && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/roster-viewer/requirements.ts web/lib/roster-viewer/requirements.test.ts
git commit -m "feat(roster-viewer): check each day against its requirement override"
```

---

### Task 5: Requirements form model: exception rows, validation, save and load

**Files:**
- Modify: `web/components/requirements/requirements-model.ts`
- Modify: `web/components/requirements/requirement-form.tsx` (only: import `parseRequirementInteger` from the model instead of its local copy)
- Test: `web/components/requirements/requirements-model.test.ts`

**Interfaces:**
- Consumes: `requirementDateIsos` and `formatShortDate` (Task 3).
- Produces:
  - `export interface OverrideRow { date: string; requiredNumPeople: RequirementNumberValue }`
  - `RequirementFormState.requiredNumPeopleOverrides: OverrideRow[]` (empty in `emptyRequirementForm`)
  - `RequirementErrors.requiredNumPeopleOverrides?: string`
  - `validateRequirementForm(form, domain, coveredIsos?: ReadonlySet<string>)`: with `coveredIsos` omitted, date coverage is not checked (the Shift Types quick-save path, which never has exceptions).
  - `requirementCoveredIsos(state: ScenarioUiState, dates: DateRef[]): string[]`
  - `OVERRIDE_MESSAGES`: `{ dateEmpty: string; duplicate(d): string; notCovered(d): string; invalid(d): string; abovePreferred(d): string }`
  - `export function parseRequirementInteger(raw: string): RequirementNumberValue` (moved verbatim from the form)

- [ ] **Step 1: Write the failing tests**

In `requirements-model.test.ts`, add `requiredNumPeopleOverrides: []` to the file's `form()` defaults, then:

```ts
describe("date exceptions", () => {
  const covered = new Set(["2026-10-14", "2026-10-15"]);
  const withRows = (rows: OverrideRow[], extra: Partial<RequirementFormState> = {}) =>
    form({ shiftType: ["D"], qualifiedPeople: ["ALL"], date: ["ALL"], requiredNumPeople: 2, requiredNumPeopleOverrides: rows, ...extra });

  it("accepts a covered date with a whole number", () => {
    expect(validateRequirementForm(withRows([{ date: "2026-10-14", requiredNumPeople: 1 }]), domain, covered)).toEqual({});
  });

  it.each([
    [[{ date: "", requiredNumPeople: 1 }], OVERRIDE_MESSAGES.dateEmpty],
    [[{ date: "2026-10-14", requiredNumPeople: 1 }, { date: "2026-10-14", requiredNumPeople: 0 }], OVERRIDE_MESSAGES.duplicate("14 Oct")],
    [[{ date: "2026-10-20", requiredNumPeople: 1 }], OVERRIDE_MESSAGES.notCovered("20 Oct")],
    [[{ date: "2026-10-14", requiredNumPeople: -1 }], OVERRIDE_MESSAGES.invalid("14 Oct")],
    [[{ date: "2026-10-14", requiredNumPeople: 1.5 }], OVERRIDE_MESSAGES.invalid("14 Oct")],
    [[{ date: "2026-10-14", requiredNumPeople: "" }], OVERRIDE_MESSAGES.invalid("14 Oct")],
  ])("refuses an exception outside the rule's dates, twice, or not a whole number: %j", (rows, message) => {
    expect(validateRequirementForm(withRows(rows as OverrideRow[]), domain, covered).requiredNumPeopleOverrides).toBe(message);
  });

  it("refuses an exception above a distinct preferred count", () => {
    const errors = validateRequirementForm(
      withRows([{ date: "2026-10-14", requiredNumPeople: 4 }], { preferredNumPeople: 3 }),
      domain,
      covered,
    );
    expect(errors.requiredNumPeopleOverrides).toBe(OVERRIDE_MESSAGES.abovePreferred("14 Oct"));
  });

  it("messages read as the spec writes them", () => {
    expect(OVERRIDE_MESSAGES.dateEmpty).toBe("Pick a date for each exception");
    expect(OVERRIDE_MESSAGES.duplicate("14 Oct")).toBe("14 Oct has more than one exception");
    expect(OVERRIDE_MESSAGES.notCovered("14 Oct")).toBe("14 Oct is not one of this requirement's dates");
    expect(OVERRIDE_MESSAGES.invalid("14 Oct")).toBe("The number of people on 14 Oct must be a whole number, 0 or more");
    expect(OVERRIDE_MESSAGES.abovePreferred("14 Oct")).toBe(
      "The number of people on 14 Oct must not be more than the preferred number of people",
    );
  });

  it("saves exceptions sorted by date and drops an exception equal to the rule's number", () => {
    const card = buildRequirementCard(
      withRows([
        { date: "2026-10-15", requiredNumPeople: 3 },
        { date: "2026-10-14", requiredNumPeople: 2 },
        { date: "2026-10-13", requiredNumPeople: 1 },
      ]),
      domain,
      "u",
    );
    expect(card.requiredNumPeopleOverrides).toEqual([["2026-10-13", 1], ["2026-10-15", 3]]);
  });

  it("omits the field when no exception is left", () => {
    const card = buildRequirementCard(withRows([{ date: "2026-10-14", requiredNumPeople: 2 }]), domain, "u");
    expect(card).not.toHaveProperty("requiredNumPeopleOverrides");
  });

  it("loads stored exceptions back into rows", () => {
    const card = buildRequirementCard(withRows([{ date: "2026-10-14", requiredNumPeople: 1 }]), domain, "u");
    expect(requirementToForm(card, domain).requiredNumPeopleOverrides).toEqual([
      { date: "2026-10-14", requiredNumPeople: 1 },
    ]);
  });
});
```

Also add one case to the test that exercises `requirementCoveredIsos` on the file's existing scenario fixture: `ALL` gives every roster ISO date, a single ISO gives itself.

- [ ] **Step 2: Run the tests and see them fail**

Run: `cd web && pnpm vitest run components/requirements/requirements-model.test.ts`
Expected: FAIL. The new exports do not exist.

- [ ] **Step 3: Implement**

In `requirements-model.ts`:

1. Imports: add `formatShortDate` from `@/lib/dates/date-id`, `requirementDateIsos` from `@/lib/rules/shortfalls`, and the `RequirementOverride` type from `@/lib/scenario`.
2. Below `REQUIREMENT_MESSAGES`:

```ts
/** Verbatim messages for the "Different number on some dates" rows (spec 2026-09-24). */
export const OVERRIDE_MESSAGES = {
  dateEmpty: "Pick a date for each exception",
  duplicate: (d: string) => `${d} has more than one exception`,
  notCovered: (d: string) => `${d} is not one of this requirement's dates`,
  invalid: (d: string) => `The number of people on ${d} must be a whole number, 0 or more`,
  abovePreferred: (d: string) =>
    `The number of people on ${d} must not be more than the preferred number of people`,
} as const;

/** One exception row: a roster ISO date (`""` until picked) and its head count. */
export interface OverrideRow {
  date: string;
  requiredNumPeople: RequirementNumberValue;
}
```

3. `RequirementFormState`: add `requiredNumPeopleOverrides: OverrideRow[];` after `requiredNumPeople`. `emptyRequirementForm()`: add `requiredNumPeopleOverrides: [],`. `RequirementErrors`: add `requiredNumPeopleOverrides?: string;`.
4. Move `parseRequirementInteger` (and its comment) from `requirement-form.tsx` here and export it. The form imports it.
5. Add:

```ts
/** The roster ISO dates a draft's Dates selection covers: the choices for an exception row. */
export function requirementCoveredIsos(state: ScenarioUiState, dates: DateRef[]): string[] {
  return requirementDateIsos(state, { date: dates });
}

function validateOverrides(
  form: RequirementFormState,
  coveredIsos: ReadonlySet<string> | undefined,
): string | undefined {
  const ceiling = preferredDiffersFromRequired(form) ? Number(form.preferredNumPeople) : Infinity;
  const seen = new Set<string>();
  for (const row of form.requiredNumPeopleOverrides) {
    if (!row.date) return OVERRIDE_MESSAGES.dateEmpty;
    const day = formatShortDate(row.date);
    if (seen.has(row.date)) return OVERRIDE_MESSAGES.duplicate(day);
    seen.add(row.date);
    if (coveredIsos && !coveredIsos.has(row.date)) return OVERRIDE_MESSAGES.notCovered(day);
    const n = row.requiredNumPeople;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return OVERRIDE_MESSAGES.invalid(day);
    if (n > ceiling) return OVERRIDE_MESSAGES.abovePreferred(day);
  }
  return undefined;
}
```

6. `validateRequirementForm(form, domain, coveredIsos?: ReadonlySet<string>)`: after the `date` check add:

```ts
  const overrides = validateOverrides(form, coveredIsos);
  if (overrides) errors.requiredNumPeopleOverrides = overrides;
```

Update its doc comment's field order to name the exceptions after dates.

7. `buildRequirementCard`, before `return`:

```ts
  // An exception equal to the rule's own number says nothing: drop it, as preferred is dropped.
  const overrides = form.requiredNumPeopleOverrides
    .filter((row) => row.requiredNumPeople !== form.requiredNumPeople)
    .map((row): RequirementOverride => [row.date, row.requiredNumPeople as number])
    .sort(([a], [b]) => a.localeCompare(b));
  if (overrides.length > 0) body.requiredNumPeopleOverrides = overrides;
```

8. `requirementToForm`: add

```ts
    requiredNumPeopleOverrides: (card.requiredNumPeopleOverrides ?? []).map(([date, n]) => ({
      date,
      requiredNumPeople: n,
    })),
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd web && pnpm vitest run components/requirements components/shift-types lib/proposal && pnpm typecheck`
Expected: PASS. If typecheck names a literal `RequirementFormState` elsewhere (for example `save-shift-card.ts`), add `requiredNumPeopleOverrides: []` there.

- [ ] **Step 5: Commit**

```bash
git add web/components/requirements web/components/shift-types
git commit -m "feat(requirements): exception rows in the requirement form model"
```

---

### Task 6: Requirements screen: the exceptions field and the card summary

**Files:**
- Create: `web/components/requirements/date-overrides-field.tsx`
- Create: `web/components/requirements/date-overrides-field.test.tsx`
- Modify: `web/components/requirements/requirement-form.tsx` (below the Dates `FieldShell`, and `submit`)
- Modify: `web/components/requirements/requirement-card-list.tsx` (fields list)
- Test: `web/e2e/requirements.spec.ts`

**Interfaces:**
- Consumes: `OverrideRow`, `parseRequirementInteger`, `requirementCoveredIsos`, `validateRequirementForm(…, coveredIsos)` (Task 5), `formatShortDate` (Task 3).
- Produces: `DateOverridesField({ rows, dates, onChange })`, with `dates: { iso: string; label: string }[]`. Test ids `date-overrides-field`, `date-override-<i>`, `date-overrides-add`.

- [ ] **Step 1: Write the failing component test**

`date-overrides-field.test.tsx`:

```tsx
// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateOverridesField } from "./date-overrides-field";
import type { OverrideRow } from "./requirements-model";

afterEach(cleanup);

const DATES = [
  { iso: "2026-10-14", label: "Wed 14 Oct" },
  { iso: "2026-10-15", label: "Thu 15 Oct" },
];

function Harness({ initial = [] as OverrideRow[], onRows = (_: OverrideRow[]) => {} }) {
  const [rows, setRows] = React.useState(initial);
  return (
    <DateOverridesField
      rows={rows}
      dates={DATES}
      onChange={(next) => {
        setRows(next);
        onRows(next);
      }}
    />
  );
}

describe("DateOverridesField", () => {
  it("adds a row on the first free date, then edits its number", () => {
    let last: OverrideRow[] = [];
    render(<Harness onRows={(r) => (last = r)} />);
    fireEvent.click(screen.getByTestId("date-overrides-add"));
    expect(last).toEqual([{ date: "2026-10-14", requiredNumPeople: "" }]);
    fireEvent.change(screen.getByLabelText("Number of people on exception 1"), { target: { value: "1" } });
    expect(last).toEqual([{ date: "2026-10-14", requiredNumPeople: 1 }]);
  });

  it("changes the date and removes a row", () => {
    let last: OverrideRow[] = [];
    render(<Harness initial={[{ date: "2026-10-14", requiredNumPeople: 1 }]} onRows={(r) => (last = r)} />);
    fireEvent.change(screen.getByLabelText("Date of exception 1"), { target: { value: "2026-10-15" } });
    expect(last).toEqual([{ date: "2026-10-15", requiredNumPeople: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Remove exception 1" }));
    expect(last).toEqual([]);
  });

  it("keeps a date the rule no longer covers visible, so its error can name it", () => {
    render(<Harness initial={[{ date: "2026-10-20", requiredNumPeople: 1 }]} />);
    expect((screen.getByLabelText("Date of exception 1") as HTMLSelectElement).value).toBe("2026-10-20");
  });

  it("offers no add once every covered date has a row", () => {
    render(
      <Harness
        initial={[
          { date: "2026-10-14", requiredNumPeople: 1 },
          { date: "2026-10-15", requiredNumPeople: 1 },
        ]}
      />,
    );
    expect(screen.getByTestId("date-overrides-add")).toBeDisabled();
  });
});
```

If `toBeDisabled` is not set up (no jest-dom), use `expect((el as HTMLButtonElement).disabled).toBe(true)`. Check `date-scope-field.test.tsx` for which one the repo uses.

- [ ] **Step 2: Run it and see it fail**

Run: `cd web && pnpm vitest run components/requirements/date-overrides-field.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the component**

`date-overrides-field.tsx`:

```tsx
"use client";

// The "Different number on some dates" rows of the Staffing requirements form. Pure
// presentation: the rows live in RequirementFormState, validation in requirements-model.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { parseRequirementInteger, type OverrideRow } from "./requirements-model";

export interface OverrideDateOption {
  iso: string;
  label: string;
}

interface DateOverridesFieldProps {
  rows: OverrideRow[];
  /** The dates the rule covers now: the only dates a new row may pick. */
  dates: OverrideDateOption[];
  onChange: (rows: OverrideRow[]) => void;
}

export function DateOverridesField({ rows, dates, onChange }: DateOverridesFieldProps) {
  const update = (index: number, patch: Partial<OverrideRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const firstFree = dates.find((d) => !rows.some((row) => row.date === d.iso))?.iso;
  return (
    <div className="flex flex-col gap-2" data-testid="date-overrides-field">
      {rows.map((row, index) => (
        // Rows have no identity of their own; index keys are stable while the list only appends and removes.
        <div key={index} className="flex flex-wrap items-center gap-2" data-testid={`date-override-${index}`}>
          <Select
            aria-label={`Date of exception ${index + 1}`}
            value={row.date}
            onChange={(e) => update(index, { date: e.target.value })}
          >
            <option value="">Pick a date</option>
            {row.date && !dates.some((d) => d.iso === row.date) && (
              <option value={row.date}>{row.date}</option>
            )}
            {dates.map((d) => (
              <option key={d.iso} value={d.iso}>
                {d.label}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            min={0}
            step={1}
            aria-label={`Number of people on exception ${index + 1}`}
            className="w-[96px] font-bold"
            value={row.requiredNumPeople}
            onChange={(e) => update(index, { requiredNumPeople: parseRequirementInteger(e.target.value) })}
            onWheel={(e) => (e.target as HTMLInputElement).blur()}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove exception ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        data-testid="date-overrides-add"
        disabled={firstFree === undefined}
        onClick={() => firstFree && onChange([...rows, { date: firstFree, requiredNumPeople: "" }])}
      >
        Add a date
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the form and the card list**

`requirement-form.tsx`:

1. Imports: `DateOverridesField` from `./date-overrides-field`, `formatShortDate` from `@/lib/dates/date-id`, `requirementCoveredIsos` from `./requirements-model`.
2. Constant beside the other notes:

```ts
const OVERRIDES_NOTE =
  "Use this for a single day that needs a different number, such as one fewer on a quiet public holiday. Everything else about the rule still applies on that day.";
```

3. In the component body, after `dateItems`:

```ts
  const coveredIsos = requirementCoveredIsos(state, form.date);
```

4. `submit`: `validateRequirementForm(form, domain, new Set(coveredIsos))`.
5. After the Dates `FieldShell`:

```tsx
      <FieldShell
        label="Different number on some dates"
        hint="optional"
        error={errors.requiredNumPeopleOverrides}
      >
        <p className="text-meta text-ink3">{OVERRIDES_NOTE}</p>
        <DateOverridesField
          rows={form.requiredNumPeopleOverrides}
          dates={coveredIsos.map((iso) => ({ iso, label: formatShortDate(iso, true) }))}
          onChange={(next) => {
            setForm((prev) => ({ ...prev, requiredNumPeopleOverrides: next }));
            setErrors((prev) =>
              prev.requiredNumPeopleOverrides ? { ...prev, requiredNumPeopleOverrides: undefined } : prev,
            );
          }}
        />
      </FieldShell>
```

`requirement-card-list.tsx`: import `formatShortDate`. In `fields`, after the `Required` entry:

```tsx
              ...(card.requiredNumPeopleOverrides?.length
                ? [
                    {
                      label: "Exceptions",
                      value: card.requiredNumPeopleOverrides
                        .map(([iso, n]) => `${formatShortDate(iso)}: ${n}`)
                        .join(" · "),
                    },
                  ]
                : []),
```

- [ ] **Step 5: Add the Playwright row**

In `e2e/requirements.spec.ts`, add `requiredNumPeopleOverrides?: [string, number][];` to the local `RequirementCard` type. Then add inside the serial describe:

```ts
  test("an exception on one date saves one override and one undo entry", async ({ page }) => {
    await gotoReady(page);
    await seed(page, {
      ...BASE_SEED,
      cardsByKind: {
        requirements: [
          { uid: "n", description: "Nights", shiftType: ["N"], requiredNumPeople: 2, qualifiedPeople: ["ALL"], date: ["ALL"], weight: -1 },
        ],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    const before = await pastCount(page);
    await page.getByTestId("requirement-edit-0").click();
    await page.getByTestId("date-overrides-add").click();
    await page.getByLabel("Date of exception 1").selectOption("2026-01-14");
    await page.getByLabel("Number of people on exception 1").fill("1");
    await page.getByTestId("card-editor-submit").click();

    await expect(page.getByTestId("requirement-card-0")).toContainText("14 Jan: 1");
    const cards = await readRequirements(page);
    expect(cards[0].requiredNumPeopleOverrides).toEqual([["2026-01-14", 1]]);
    expect((await pastCount(page)) - before).toBe(1);
  });
```

If `seed` does not accept a whole `cardsByKind`, mirror how the `editing a stored requirement` test (line ~272) seeds a stored card.

- [ ] **Step 6: Run the tests and gates**

Run: `cd web && pnpm vitest run components/requirements && pnpm typecheck && pnpm lint:oxlint && pnpm lint:ast-grep`
Expected: PASS. Then, where the Playwright build exists: `cd web && pnpm test:e2e e2e/requirements.spec.ts -g "exception"` PASS.

- [ ] **Step 7: Commit**

```bash
git add web/components/requirements web/e2e/requirements.spec.ts
git commit -m "feat(requirements): Different number on some dates field and Exceptions summary"
```

---

### Task 7: Assistant arm `set_staffing_requirement_on_date`, with parity

**Files:**
- Modify: `web/lib/proposal/commands.ts` (union type, `ASSISTANT_COMMAND_TYPES`, zod union: all at the end)
- Modify: `web/lib/proposal/operations.ts` (new transform, `requirementRejection` coverage, dispatcher)
- Modify: `web/lib/proposal/diff.ts` (`directKeys` only. Wording is Task 8)
- Test: `web/lib/proposal/operations.test.ts`, `operations.parity.test.ts`, `commands.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`, `web/lib/ai/phase-2-absence.test.ts`

**Interfaces:**
- Consumes: `requirementToForm`, `validateRequirementForm(…, coveredIsos)`, `requirementCoveredIsos`, `applyRequirementPatch` (Task 5), `formatShortDate` (Task 3).
- Produces: `AssistantCommandV1` arm `{ type: "set_staffing_requirement_on_date"; ruleId: string; date: string; requiredNumPeople: number }`. Rejections: `unknown_target` (rule gone), `invalid_value` (form error, prefixed `Staffing requirement "<title>": `), `no_effect` (`Staffing requirement "<title>" already needs <n> on <d>.`).

- [ ] **Step 1: Write the failing tests**

`operations.test.ts` (uses `ruleWardScenario()` from `./test-support`. `req-day` is Day, 2 people, every date of April 2026):

```ts
describe("set_staffing_requirement_on_date", () => {
  const onDate = (date: string, requiredNumPeople: number) =>
    ({ type: "set_staffing_requirement_on_date", ruleId: "req-day", date, requiredNumPeople }) as const;

  it("sets one date's number and keeps the rule's own number", () => {
    const result = applyAssistantCommand(ruleWardScenario(), onDate("2026-04-14", 1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const card = result.next.cardsByKind.requirements.find((c) => c.uid === "req-day")!;
    expect(card.requiredNumPeople).toBe(2);
    expect(card.requiredNumPeopleOverrides).toEqual([["2026-04-14", 1]]);
  });

  it("sending the rule's own number removes the exception", () => {
    const first = applyAssistantCommand(ruleWardScenario(), onDate("2026-04-14", 1));
    if (!first.ok) throw new Error(first.rejection.message);
    const second = applyAssistantCommand(first.next, onDate("2026-04-14", 2));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.next.cardsByKind.requirements.find((c) => c.uid === "req-day")).not.toHaveProperty(
        "requiredNumPeopleOverrides",
      );
    }
  });

  it("refuses the same exception twice as no change", () => {
    const first = applyAssistantCommand(ruleWardScenario(), onDate("2026-04-14", 1));
    if (!first.ok) throw new Error(first.rejection.message);
    const again = applyAssistantCommand(first.next, onDate("2026-04-14", 1));
    expect(again).toMatchObject({
      ok: false,
      rejection: { code: "no_effect", message: 'Staffing requirement "Day cover" already needs 1 on 14 Apr.' },
    });
  });

  it("refuses a date the rule does not cover, naming it", () => {
    expect(applyAssistantCommand(ruleWardScenario(), onDate("2026-05-01", 1))).toMatchObject({
      ok: false,
      rejection: {
        code: "invalid_value",
        message: 'Staffing requirement "Day cover": 1 May is not one of this requirement\'s dates.',
      },
    });
  });

  it("refuses a rule that is gone", () => {
    expect(
      applyAssistantCommand(ruleWardScenario(), { ...onDate("2026-04-14", 1), ruleId: "nope" }),
    ).toMatchObject({ ok: false, rejection: { code: "unknown_target" } });
  });

  it("edit refuses dates that drop an exception", () => {
    const first = applyAssistantCommand(ruleWardScenario(), onDate("2026-04-14", 1));
    if (!first.ok) throw new Error(first.rejection.message);
    const edit = applyAssistantCommand(first.next, {
      type: "edit_staffing_requirement",
      ruleId: "req-day",
      description: "Day cover",
      shiftType: "Day",
      qualifiedPeople: ["ALL"],
      dates: ["2026-04-15"],
      requiredNumPeople: 2,
    });
    expect(edit).toMatchObject({
      ok: false,
      rejection: { code: "invalid_value", message: expect.stringContaining("14 Apr is not one of this requirement's dates") },
    });
  });
});
```

Check the rejection field names (`code`, `message`) against an existing `operations.test.ts` assertion before running.

`operations.parity.test.ts`, after the requirements parity describe (it already imports the model helpers. Add `requirementCoveredIsos` and `stableStringify` from `./digest`):

```ts
describe("set_staffing_requirement_on_date is the Edit form with one exception row", () => {
  const rows: [string, number][] = [
    ["2026-04-14", 1],
    ["2026-04-14", 0],
    ["2026-04-14", 2],
    ["2026-04-14", 3],
    ["2026-04-14", -1],
    ["2026-04-14", 1.5],
    ["2026-05-01", 1],
  ];

  it("accepts and refuses what the form does, and commits the same document", () => {
    const state = ruleWardScenario();
    const source = state.cardsByKind.requirements.find((c) => c.uid === "req-day")!;
    const domain = buildRequirementShiftTypeDomain(state);
    for (const [i, [date, n]] of rows.entries()) {
      const base = requirementToForm(source, domain);
      const form = { ...base, requiredNumPeopleOverrides: [{ date, requiredNumPeople: n }] };
      const covered = new Set(requirementCoveredIsos(state, form.date));
      const manual = applyRequirementPatch(state, { type: "update", uid: "req-day", form });
      const formSaves =
        valid(validateRequirementForm(form, domain, covered)) &&
        stableStringify(manual) !== stableStringify(state);
      const assistant = applyAssistantCommand(state, {
        type: "set_staffing_requirement_on_date",
        ruleId: "req-day",
        date,
        requiredNumPeople: n,
      });
      expect(assistant.ok, `row ${i}`).toBe(formSaves);
      if (assistant.ok) expect(assistant.next).toEqual(manual);
    }
  });

  it("both refuse a multi-shift rule the same way", () => {
    const state = ruleWardScenario();
    const assistant = applyAssistantCommand(state, {
      type: "set_staffing_requirement_on_date",
      ruleId: "req-multi",
      date: "2026-04-14",
      requiredNumPeople: 1,
    });
    const source = state.cardsByKind.requirements.find((c) => c.uid === "req-multi")!;
    const domain = buildRequirementShiftTypeDomain(state);
    const form = { ...requirementToForm(source, domain), requiredNumPeopleOverrides: [{ date: "2026-04-14", requiredNumPeople: 1 }] };
    expect(assistant.ok).toBe(valid(validateRequirementForm(form, domain, new Set(requirementCoveredIsos(state, form.date)))));
  });
});
```

In `commands.test.ts`, `model-visible-tools.test.ts` and `phase-2-absence.test.ts`, add the arm name at the END of each ordered arm list. Add this sample to the per-arm sample record in `model-visible-tools.test.ts`:

```ts
      set_staffing_requirement_on_date: {
        type: "set_staffing_requirement_on_date",
        ruleId: "r1",
        date: "2026-10-14",
        requiredNumPeople: 1,
      },
```

In `commands.test.ts`, add:

```ts
it("parses set_staffing_requirement_on_date and refuses a non-ISO date", () => {
  expect(
    assistantCommandSchema.safeParse({ type: "set_staffing_requirement_on_date", ruleId: "r", date: "2026-10-14", requiredNumPeople: 1 }).success,
  ).toBe(true);
  expect(
    assistantCommandSchema.safeParse({ type: "set_staffing_requirement_on_date", ruleId: "r", date: "14", requiredNumPeople: 1 }).success,
  ).toBe(false);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/runtime/model-visible-tools.test.ts lib/ai/phase-2-absence.test.ts`
Expected: FAIL. Unknown arm, and the ordered lists differ.

- [ ] **Step 3: Add the arm**

`commands.ts`, END of the `AssistantCommandV1` union:

```ts
  /**
   * Give one staffing requirement a different head count on ONE date -- the Staffing
   * requirements form's "Different number on some dates" row. The rule's own number
   * removes the exception.
   */
  | {
      type: "set_staffing_requirement_on_date";
      ruleId: string;
      date: string;
      requiredNumPeople: number;
    }
```

END of `ASSISTANT_COMMAND_TYPES`: `"set_staffing_requirement_on_date",`. END of the zod union:

```ts
  z.strictObject({
    type: z.enum(["set_staffing_requirement_on_date"]),
    ruleId: ruleIdSchema(),
    date: isoDateSchema.describe("One roster date the requirement covers, YYYY-MM-DD."),
    requiredNumPeople: z
      .number()
      .describe(
        "How many people that shift needs on that date only: exactly this many, or at least " +
          "this many when the requirement has a preferred count. Every other date keeps the " +
          "requirement's own number. Send the requirement's own number to remove the exception.",
      ),
  }),
```

- [ ] **Step 4: Add the transform and the edit coverage check**

`operations.ts`: import `requirementCoveredIsos` with the other requirements-model imports, and `formatShortDate` from `@/lib/dates/date-id`.

In `requirementRejection`, replace the `validateRequirementForm(...)` call with:

```ts
    validateRequirementForm(
      draft,
      buildRequirementShiftTypeDomain(state),
      new Set(requirementCoveredIsos(state, draft.date)),
    ),
```

After `applyEditStaffingRequirement`:

```ts
function applySetRequirementOnDate(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "set_staffing_requirement_on_date" }>,
  index: number,
): OperationResult {
  const source = state.cardsByKind.requirements.find((card) => card.uid === command.ruleId);
  if (!source) {
    return reject(index, "unknown_target", "That staffing requirement is not in this schedule any more.");
  }
  const name = ruleName("requirements", source.description?.trim() || source.uid);
  const domain = buildRequirementShiftTypeDomain(state);
  const base = requirementToForm(source, domain);
  // The form with one row for this date: an existing row for it is replaced, as the user would.
  const draft: RequirementFormState = {
    ...base,
    requiredNumPeopleOverrides: [
      ...base.requiredNumPeopleOverrides.filter((row) => row.date !== command.date),
      { date: command.date, requiredNumPeople: command.requiredNumPeople },
    ],
  };
  const error = firstFormError(
    validateRequirementForm(draft, domain, new Set(requirementCoveredIsos(state, draft.date))),
  );
  if (error) return reject(index, "invalid_value", `${name}: ${error}.`);
  const next = applyRequirementPatch(state, { type: "update", uid: source.uid, form: draft });
  const after = next.cardsByKind.requirements.find((card) => card.uid === source.uid);
  if (stableStringify(after) === stableStringify(source)) {
    return reject(
      index,
      "no_effect",
      `${name} already needs ${command.requiredNumPeople} on ${formatShortDate(command.date)}.`,
    );
  }
  return { ok: true, next };
}
```

Dispatcher (`applyAssistantCommand`), after `edit_staffing_requirement`:

```ts
    case "set_staffing_requirement_on_date":
      return applySetRequirementOnDate(state, command, index);
```

`diff.ts`, `directKeys`, after `set_staffing_requirement_people`:

```ts
      case "set_staffing_requirement_on_date":
        keys.add(`rule:requirements:${command.ruleId}`);
        break;
```

If the `no_effect` message test fails because `ruleName` quotes the title differently, match the arm's message to `ruleName`'s real output and update the test string once.

- [ ] **Step 5: Run the tests and gates**

Run: `cd web && pnpm vitest run lib/proposal lib/ai lib/repository lib/store components/ai && pnpm typecheck && pnpm lint:oxlint && pnpm lint:ast-grep`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/proposal web/lib/ai/runtime/model-visible-tools.test.ts web/lib/ai/phase-2-absence.test.ts
git commit -m "feat(assistant): set_staffing_requirement_on_date arm, parity with the requirement form"
```

---

### Task 8: Preview says what the exception does

**Files:**
- Modify: `web/lib/proposal/diff.ts` (`describeRequirement`, new `requirementChange`, `compareKeyed` option type, the rules loop)
- Test: `web/lib/proposal/diff.test.ts`

**Interfaces:**
- Consumes: `requiredOn` (Task 3), `formatShortDate` (Task 3), the arm (Task 7).
- Produces: `compareKeyed` option `renderChange?: (from: T, to: T) => string | undefined` (`undefined` falls back to the full render).

- [ ] **Step 1: Write the failing tests**

In `diff.test.ts` (it already builds diffs with `deriveProposalDiff` over `ruleWardScenario()`. Mirror an existing rule-change test for the call shape):

```ts
describe("requirement exceptions in the Preview", () => {
  const exception = (requiredNumPeople: number) =>
    ({ type: "set_staffing_requirement_on_date", ruleId: "req-day", date: "2026-04-14", requiredNumPeople }) as const;

  it("names the date and both numbers", () => {
    const [entry] = previewOf(ruleWardScenario(), [exception(1)]).direct;
    expect(entry.after).toBe("14 Apr: exactly 2 → 1 on Day");
    expect(entry.before).toMatch(/^On · “Day cover” · Exactly 2 people on Day, every date/);
  });

  it("uses the range words when the rule has a preferred count", () => {
    const state = ruleWardScenario();
    state.cardsByKind.requirements[0] = { ...state.cardsByKind.requirements[0], preferredNumPeople: 3, weight: -5 };
    const [entry] = previewOf(state, [exception(1)]).direct;
    expect(entry.after).toBe("14 Apr: 2 to 3 → 1 to 3 on Day");
  });

  it("lists exceptions in the rule sentence", () => {
    const first = applyAssistantCommands(ruleWardScenario(), [exception(1)]);
    if (!first.ok) throw new Error(first.rejection.message);
    const [entry] = previewOf(first.next, [
      { type: "set_staffing_requirement_people", ruleId: "req-day", requiredNumPeople: 3 },
    ]).direct;
    expect(entry.after).toContain("Exactly 3 people on Day, every date, except 14 Apr: 1");
  });
});
```

`previewOf(state, commands)` stands for the file's existing way to apply commands and derive the diff. Use its real helper name.

`ruleWardScenario()`'s `req-day` has weight `Infinity` and no `date`. The first Apply rebuilds it through the form (weight `-1`, `date: ["ALL"]`), so the first test's `before` differs from `after` in more than the exception. If `entry.after` then shows the full sentence, first normalize the fixture card with `buildRequirementCard(requirementToForm(card, domain), domain, "req-day")` inside the test. Assert the exact line above.

- [ ] **Step 2: Run the tests and see them fail**

Run: `cd web && pnpm vitest run lib/proposal/diff.test.ts`
Expected: FAIL. `after` is the whole sentence without exceptions.

- [ ] **Step 3: Implement**

`diff.ts`: import `requiredOn` from `@/lib/rules/shortfalls` and `formatShortDate` from `@/lib/dates/date-id`.

Split the shift label out of `describeRequirement`, and add the exceptions:

```ts
function requirementShifts(card: RequirementCard): { labels: string[]; shifts: string } {
  const entries = Array.isArray(card.shiftType) ? card.shiftType : [card.shiftType];
  const labels = entries.map((entry) => flattenRefs(entry).map(String).join(" + "));
  return { labels, shifts: labels.length === 1 ? labels[0] : `each of ${labels.join(", ")}` };
}

function describeRequirement(card: RequirementCard): string {
  const n = card.requiredNumPeople;
  const p = card.preferredNumPeople;
  const { labels, shifts } = requirementShifts(card);
  const dates = renderDates(card.date);
  const except = (card.requiredNumPeopleOverrides ?? [])
    .map(([iso, count]) => `${formatShortDate(iso)}: ${count}`)
    .join(", ");
  const exceptions = except ? `, except ${except}` : "";
  const who = renderPeople(card.qualifiedPeople, "");
  const ban = who ? `; only ${who} may work ${labels.join(", ")}` : "";
  if (p == null || p === n) {
    return `Exactly ${n} ${n === 1 ? "person" : "people"} on ${shifts}, ${dates}${exceptions}${ban}`;
  }
  const lean =
    card.weight < 0 ? `${p} preferred` : card.weight > 0 ? `${n} preferred` : "no preference";
  return `${n} to ${p} people on ${shifts}, ${dates}${exceptions} (${lean}, weight ${card.weight})${ban}`;
}

/** A day's count as the Preview says it: `2`, or `2 to 3` with a distinct preferred count. */
function countOn(card: RequirementCard, iso: string): string {
  const n = requiredOn(card, iso);
  const p = card.preferredNumPeople;
  return p == null || p === n ? `${n}` : `${n} to ${p}`;
}

/**
 * An exception-only change, one line per date: "14 Oct: exactly 2 → 1 on N". Any other
 * change returns undefined, so the full sentence shows.
 */
function requirementChange(from: RequirementCard, to: RequirementCard): string | undefined {
  const rest = ({ requiredNumPeopleOverrides: _o, ...card }: RequirementCard) => stableStringify(card);
  if (rest(from) !== rest(to)) return undefined;
  const dates = [
    ...new Set(
      [...(from.requiredNumPeopleOverrides ?? []), ...(to.requiredNumPeopleOverrides ?? [])].map(
        ([iso]) => iso,
      ),
    ),
  ].sort();
  const lines = dates
    .filter((iso) => requiredOn(from, iso) !== requiredOn(to, iso))
    .map((iso) => {
      const was = countOn(from, iso);
      const lead = was.includes(" to ") ? was : `exactly ${was}`;
      return `${formatShortDate(iso)}: ${lead} → ${countOn(to, iso)} on ${requirementShifts(to).shifts}`;
    });
  return lines.length > 0 ? lines.join("; ") : undefined;
}
```

`compareKeyed` options: `renderChange?: (from: T, to: T) => string | undefined;` (the call site's `?? to` already handles `undefined`). In the rules loop:

```ts
        renderChange:
          kind === "requirements"
            ? (from, to) =>
                requirementChange(from as unknown as RequirementCard, to as unknown as RequirementCard)
            : undefined,
```

- [ ] **Step 4: Run the tests**

Run: `cd web && pnpm vitest run lib/proposal lib/ai && pnpm typecheck`
Expected: PASS. Existing requirement sentences are unchanged, because no card had exceptions.

- [ ] **Step 5: Commit**

```bash
git add web/lib/proposal/diff.ts web/lib/proposal/diff.test.ts
git commit -m "feat(preview): say a requirement exception as '14 Oct: exactly 2 → 1 on N'"
```

---

### Task 9: Repair playbook: run one short on one date, solver-proven

**Files:**
- Modify: `web/lib/ai/assistant/repair-options.ts` (`runOneShort`, `violatesSafetyFloor`, `skillMixOn`, `isSafeOption`)
- Modify: `web/lib/ai/assistant/playbook.ts` (`run_one_short` entry comment and `opTypes`, `PLAYBOOK_VERSION`)
- Modify: `web/lib/rules/ward-fixtures.test-support.ts` (new ward `shortOnLeaveDay`)
- Modify: `core/tests/test_assistant_repair_fixtures.py`
- Test: `web/lib/ai/assistant/repair-options.test.ts`, `repair-eval.test.ts`, `playbook.test.ts`
- Generated: `core/tests/fixtures/assistant_repair/shortOnLeaveDay.{before,after,run_one_short}.yaml`

**Interfaces:**
- Consumes: `requiredOn`, `requirementDateIsos` (Task 3), the arm (Task 7).
- Produces: `run_one_short` options whose `operations` are `[{ type: "set_staffing_requirement_on_date", ruleId, date: iso, requiredNumPeople: n - 1 }]` for a multi-date head count. `skillMixOn(ctx, card, iso?)`.

- [ ] **Step 1: Add the scripted ward**

`ward-fixtures.test-support.ts`, in `SCENARIOS` after `busyNightsWithRestRule`:

```ts
  /** Every night needs 2 and every day 1, from 3 nurses. Cara is on leave on the 5th: one short. */
  shortOnLeaveDay: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben", "cara"),
      reqData: [leave("cara", "05")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 2, { description: "2 on every night" }),
        ],
      }),
    }),
```

- [ ] **Step 2: Write the failing tests**

`repair-options.test.ts`: change the locked test `runs one short with ops only when the requirement targets that date alone` deliberately. Its second half now expects ops:

```ts
  it("runs one short on a single-date rule by lowering it, and on an every-night rule with a date exception", () => {
    const single = rank(SCENARIOS.understaffedNight()).find((o) => o.repairId === "run_one_short");
    expect(single?.operations).toEqual([
      { type: "set_staffing_requirement_people", ruleId: "night-05", requiredNumPeople: 2 },
    ]);
    const state = SCENARIOS.shortOnLeaveDay();
    const short = rank(state).find((o) => o.repairId === "run_one_short");
    expect(short?.operations).toEqual([
      { type: "set_staffing_requirement_on_date", ruleId: "night", date: "2026-11-05", requiredNumPeople: 1 },
    ]);
    expect(short?.why).toContain('"2 on every night" stays at 2 on its other days');
    expect(short && isSafeOption(state, short)).toBe(true);
  });

  it("uses the date's own count when the rule already has an exception there", () => {
    const base = SCENARIOS.shortOnLeaveDay();
    const state = {
      ...base,
      reqData: [...base.reqData, leave("ben", "03")],
      cardsByKind: {
        ...base.cardsByKind,
        requirements: base.cardsByKind.requirements.map((r) =>
          r.uid === "night" ? { ...r, requiredNumPeopleOverrides: [["2026-11-03", 3]] as [string, number][] } : r,
        ),
      },
    };
    const short = rank(state).find((o) => o.repairId === "run_one_short");
    expect(short?.operations[0]).toMatchObject({ date: "2026-11-03", requiredNumPeople: 2 });
  });
```

Check the second test's premise before relying on it. The 3rd needs N3 + D1 = 4 from 2 free nurses: gap 2. `gapOn !== 1` skips it, so `runOneShort` goes on to the 5th. If so, drop `leave("ben", "03")` so the 3rd has 3 free and a gap of 1 (N3 + D1 = 4 > 3). Keep whichever version makes the 3rd the first one-short date, and assert `date: "2026-11-03", requiredNumPeople: 2`.

In the `isSafeOption` SAFE list:

```ts
    [
      "one short on one date of an every-night head count",
      SCENARIOS.shortOnLeaveDay(),
      {
        operations: [
          { type: "set_staffing_requirement_on_date", ruleId: "night", date: "2026-11-05", requiredNumPeople: 1 },
        ] as Op[],
      },
    ],
```

In the UNSAFE list:

```ts
    [
      "one date lowered by 2",
      SCENARIOS.shortOnLeaveDay(),
      { operations: [{ type: "set_staffing_requirement_on_date", ruleId: "night", date: "2026-11-05", requiredNumPeople: 0 }] as Op[] },
    ],
    [
      "one date raised by a repair",
      SCENARIOS.shortOnLeaveDay(),
      { operations: [{ type: "set_staffing_requirement_on_date", ruleId: "night", date: "2026-11-05", requiredNumPeople: 3 }] as Op[] },
    ],
    [
      "a date the rule does not cover",
      lowered,
      { operations: [{ type: "set_staffing_requirement_on_date", ruleId: "night-05", date: "2026-11-04", requiredNumPeople: 1 }] as Op[] },
    ],
    [
      "one date of a skill-mix rule",
      conflictingNights(),
      { operations: [{ type: "set_staffing_requirement_on_date", ruleId: "night-rn", date: "2026-11-03", requiredNumPeople: 1 }] as Op[] },
    ],
```

In the `violatesSafetyFloor` BROKEN list:

```ts
    [
      "one date's head count set to 0",
      rn,
      [{ type: "set_staffing_requirement_on_date", ruleId: "day", date: "2026-11-03", requiredNumPeople: 0 }],
      /to 0/,
    ],
    [
      "one date of a skill-mix rule lowered",
      conflictingNights(),
      [{ type: "set_staffing_requirement_on_date", ruleId: "night-rn", date: "2026-11-03", requiredNumPeople: 1 }],
      /skill-mix/,
    ],
    [
      "one date lowered below the skill mix that holds there",
      ward({
        staff: people("ana", "ben", "cara", "dev"),
        staffGroups: [{ id: "RN", members: ["ana", "ben"] }],
        cardsByKind: cards({
          requirements: [
            requirement("night-total", "N", 3),
            requirement("night-rn", "N", 2, { qualifiedPeople: ["RN"] }),
          ],
        }),
      }),
      [{ type: "set_staffing_requirement_on_date", ruleId: "night-total", date: "2026-11-03", requiredNumPeople: 1 }],
      /skill-mix/,
    ],
```

`repair-eval.test.ts`: add `"shortOnLeaveDay"` to `INFEASIBLE`. Add `shortOnLeaveDay: ["borrow_temporary_nurse", "ask_nurse_on_leave", "run_one_short"]` to `EXPECTED`. Then in the "read as real ward situations" describe:

```ts
  it("short on a leave day: running that night one short is one date exception, and the solver agrees", async () => {
    const state = SCENARIOS.shortOnLeaveDay();
    const short = options("shortOnLeaveDay").find((o) => o.repairId === "run_one_short")!;
    const result = applyAssistantCommands(state, short.operations);
    if (!result.ok) throw new Error(result.rejection.message);
    expect(findStaffingShortfalls(result.next)).toEqual([]);
    await expect(stableYaml(result.next)).toMatchFileSnapshot(
      `${FIXTURE_DIR}shortOnLeaveDay.run_one_short.yaml`,
    );
  });
```

`core/tests/test_assistant_repair_fixtures.py`: add `"shortOnLeaveDay"` to the locked list in `test_the_harness_wrote_every_case` (sorted position: after `personalCapsTooLow`), and:

```python
def test_running_one_short_with_a_date_exception_is_feasible():
    assert _status(FIXTURES / "shortOnLeaveDay.run_one_short.yaml") in {"FEASIBLE", "OPTIMAL"}
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `cd web && pnpm vitest run lib/ai/assistant`
Expected: FAIL. `run_one_short` for `night` has `operations: []`. `isSafeOption` refuses the new arm (`default: return false`). The floor does not know the arm.

- [ ] **Step 4: Implement the repair**

`repair-options.ts`: import `requiredOn` and `requirementDateIsos` from `@/lib/rules/shortfalls`. Update the header's controller-rulings sentence: `a requirement is lowered for one date through a date exception (set_staffing_requirement_on_date), or lowered outright when it targets that date alone`.

`runOneShort`, replace the body of the inner `for (const uid of f.ruleIds)` loop:

```ts
      const card = requirementCard(ctx, uid);
      const iso = isoOf(ctx, f.dateId);
      if (!card || !iso || !isHeadCount(card)) continue;
      const n = requiredOn(card, iso);
      if (n < 2) continue;
      if (!sameDay.every((g) => g.ruleIds.includes(uid))) continue;
      // One short may not drop the shift below the skill mix it must hold that day.
      if (n - 1 < skillMixOn(ctx, card, iso)) continue;
      const shift = String(flattenShiftTypeRefs(card.shiftType)[0]);
      const when = dateLabel(ctx, f.dateId);
      const dates = requirementDateIds(ctx.state, card);
      // A rule for that date alone is lowered outright. Any other gets an exception for that date.
      const alone =
        dates.length === 1 && dates[0] === f.dateId && !card.requiredNumPeopleOverrides?.length;
      return makeOption("run_one_short", {
        title: `Run ${shift} on ${when} with ${n - 1} instead of ${n} (the manager's safety call)`,
        why: alone
          ? `Nobody else is free: ${shift} can have at most ${n - 1} there as things stand.`
          : `Nobody else is free: ${shift} can have at most ${n - 1} there. "${ruleName(card, uid)}" stays at ${card.requiredNumPeople} on its other days.`,
        operations: [
          alone
            ? { type: "set_staffing_requirement_people", ruleId: uid, requiredNumPeople: n - 1 }
            : {
                type: "set_staffing_requirement_on_date",
                ruleId: uid,
                date: iso,
                requiredNumPeople: n - 1,
              },
        ],
        confirmationQuestion: `As the manager, are you satisfied it is safe to run ${shift} on ${when} with ${n - 1} nurses?`,
        needsFromUser: [
          "Whether the manager accepts running the shift one short. Only they can make that safety call.",
        ],
        capabilityId: "staffing-requirements",
        evidence: "static_check",
      });
```

`skillMixOn`, replace:

```ts
/** The largest skill-mix count on a head count's shift, on one date or any date it covers. */
function skillMixOn(ctx: Ctx, card: RequirementCard, iso?: string): number {
  const shifts = new Set(flattenShiftTypeRefs(card.shiftType).map(String));
  const dates = iso ? [iso] : requirementDateIsos(ctx.state, card);
  return Math.max(
    0,
    ...ctx.state.cardsByKind.requirements
      .filter(
        (c) =>
          !c.disabled &&
          isSkillMix(c) &&
          flattenShiftTypeRefs(c.shiftType).some((s) => shifts.has(String(s))),
      )
      .flatMap((c) => {
        const covered = new Set(requirementDateIsos(ctx.state, c));
        return dates.filter((d) => covered.has(d)).map((d) => requiredOn(c, d));
      }),
  );
}
```

`violatesSafetyFloor`, replace `lowered` with:

```ts
  const loweredTo = (card: RequirementCard | undefined, before: number, n: number, iso?: string) => {
    if (n < 1) return zero;
    if (!card || n >= before) return null;
    return isSkillMix(card) || n < skillMixOn(ctx, card, iso) ? skillMix : null;
  };
  const lowered = (uid: string, n: number) => {
    const card = requirementCard(ctx, uid);
    return loweredTo(card, card?.requiredNumPeople ?? Infinity, n);
  };
```

and add the switch case:

```ts
        case "set_staffing_requirement_on_date": {
          const card = requirementCard(ctx, op.ruleId);
          return loweredTo(card, card ? requiredOn(card, op.date) : Infinity, op.requiredNumPeople, op.date);
        }
```

`isSafeOption`, add the switch case:

```ts
      case "set_staffing_requirement_on_date": {
        // Lower one covered date of a plain head count by exactly 1 (the floor keeps it at 1 or more).
        const card = requirementCard(ctx, op.ruleId);
        if (!card || !isHeadCount(card) || !Number.isInteger(op.requiredNumPeople)) return false;
        if (!requirementDateIsos(state, card).includes(op.date)) return false;
        return op.requiredNumPeople === requiredOn(card, op.date) - 1;
      }
```

`playbook.ts`: `run_one_short` entry. Replace the three-line comment with `// A single-date rule is lowered. Any other head count gets a one-date exception.`, and set `opTypes: ["set_staffing_requirement_people", "set_staffing_requirement_on_date"]`. Bump `PLAYBOOK_VERSION` to `"2026-09-24.4"` (if another change bumped it first, use the next number). The guardrail text is unchanged.

- [ ] **Step 5: Write the fixtures and run everything**

Run: `cd web && pnpm vitest run lib/ai/assistant/repair-eval -u` (writes the three `shortOnLeaveDay.*.yaml` fixtures), then `cd web && pnpm vitest run lib/ai/assistant lib/rules`.
Expected: PASS. If `EXPECTED.shortOnLeaveDay` differs, look at why before you edit it. For example, `ask_nurse_on_leave` can skip Cara because the `day_short` finding lists her differently. A skip that is right for the ward gets a new expectation. A skip that is a bug gets a fix.

Then: `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests/test_assistant_repair_fixtures.py -v`
Expected: PASS, including `test_running_one_short_with_a_date_exception_is_feasible` and the `shortOnLeaveDay` before/after cases.

Inspect `shortOnLeaveDay.run_one_short.yaml` once. It must contain `requiredNumPeopleOverrides` with `2026-11-05` and `1` under the night requirement.

- [ ] **Step 6: Commit**

```bash
git add web/lib/ai/assistant web/lib/rules/ward-fixtures.test-support.ts core/tests/test_assistant_repair_fixtures.py core/tests/fixtures/assistant_repair/shortOnLeaveDay.*
git commit -m "feat(assistant): run one short on one date via a requirement exception (locked tests: run_one_short ops, harness case list)"
```

---

### Task 10: Help text, capability registry, final gates

**Files:**
- Modify: `web/lib/capability/help-content.ts` (`staffing-requirements` entry, ~line 126)
- Regenerate: `web/lib/capability/registry.generated.ts`

- [ ] **Step 1: Update the help entry**

`nurseFacingSummary` becomes:

```ts
      "How many people a shift needs: exactly that number, or a range when a preferred number " +
      "is set. Naming who is qualified means nobody else may work that shift at all. A " +
      "requirement can have a different number on a few dates, such as one fewer on a quiet " +
      "public holiday. Everything else about the rule still applies on those days. The " +
      "assistant cannot yet set up a skill-mix rule such as needing two seniors on every " +
      "night shift. Explain this and point the user to the Rules screen.",
```

Add `"exception"` and `"one date"` to `concepts`. If the skill-mix plan has already changed the last sentence, keep its wording and insert only the exception sentences.

- [ ] **Step 2: Regenerate and run the full gates**

Run:

```bash
cd web && pnpm capability:generate && pnpm vitest run && pnpm typecheck && pnpm lint:oxlint && pnpm lint:ast-grep
PYTHONPATH=core /usr/bin/python3 -m pytest core/tests -q
```

Expected: all PASS. `git diff web/lib/capability/registry.generated.ts` shows only the staffing-requirements text change.

- [ ] **Step 3: Commit**

```bash
git add web/lib/capability
git commit -m "docs(help): staffing requirements can differ on a few dates"
```

- [ ] **Step 4: Close out the bead**

`bd close nursing-sheduler-2se`, only once all tasks are done and the gates are green. Report changed files and validation to the user. Push only on request.

---

## Decisions

1. **Per-date override on the requirement (option B)**, not "except dates + a second rule" (A) and not "narrower rule wins" (C). One field, one operation, one Preview line. An exception lives and dies with its rule. C changes what existing layered documents mean.
2. **Shape `[[ISO date, count], ...]`**, like `shiftTypeCoefficients`. A map with date keys breaks under PyYAML (keys become date objects) and hash order.
3. **An override replaces `requiredNumPeople` only.** Qualified people, coefficients, preferred count and weight still apply. With a preferred count the day's range is `override..preferred`.
4. **Strict dates.** An override must sit on one of the rule's dates. The solver raises, the form refuses, and narrowing the rule's dates under an exception is refused, not silently pruned.
5. **Range change prunes overrides** whose date left the range. Plain ISO `date` entries still do not get pruned (existing behaviour). Overrides are always date-specific, so without the prune every copied roster breaks.
6. **Saving drops an override equal to the rule's number**, as `preferredNumPeople` is dropped. So the arm removes an exception by sending the rule's own number, and needs no nullable field.
7. **New arm `set_staffing_requirement_on_date`**, one date per operation. `edit_staffing_requirement` keeps overrides as stored. A few dates = a few operations.
8. **No version bump.** Additive optional field, web and solver ship together.
9. **The per-shift baseline minimum** (`lib/roster/context.ts`) shows the rule's usual number. Per-date checks (static check, roster viewer) use the override.
10. **Repair:** a single-date rule with no overrides keeps `set_staffing_requirement_people`. Every other head count gets the date exception. `isSafeOption` allows only "lower one covered date by exactly 1". Safety floor text unchanged.

## Open questions (with recommended answers)

1. **Does the manager see a warning when changing the rule's number while exceptions exist?** Recommend no. The card list and the Preview sentence already list the exceptions next to the new number.
2. **Does the Guided Rules quick edit show or edit exceptions?** Recommend no for now. Exceptions are an Advanced Requirements-screen feature. If managers ask, add them to Guided.
3. **Do stale plain ISO `date` entries also get pruned on a range change?** Recommend a separate bead. It is the same footgun, but a different field with its own Preview cascade, so it is out of scope here.
4. **May the assistant raise a date (for example "3 on the busy night") with the new arm?** Recommend yes. The arm accepts whatever the form accepts. Only the repair playbook is limited to lowering by 1.
5. **Skill-mix coordination:** if `2026-09-24-skill-mix-rules.md` adds an "at least k from a group" field, do overrides change k too? Recommend no. An override changes `requiredNumPeople` only. A per-date skill-mix change is a separate feature, and the assistant never lowers a skill mix anyway.
6. **Can the assistant create a new requirement with exceptions in one step?** Recommend no. It is rare, and the new rule's uid is minted by the host, so a same-batch follow-up operation cannot name it. The manager adds exceptions on the screen.

## Assumptions

- The skill-mix sibling plan did not exist when this plan was written. The names in Global Constraints are authoritative for this feature. The skill-mix plan is to reuse `requiredOn` and `requirementDateIsos`.
- Web and solver always deploy together, so an older solver never meets the new field.
- PyYAML loads unquoted `2026-10-14` as a date, and pydantic lax mode accepts both a date and an ISO string for `datetime.date`. `yaml` (1.2) in the web keeps ISO dates as strings.
- `Intl.DateTimeFormat("en-GB")` in the Node test runtime has full ICU. Task 3's test pins the exact output.
- `ruleName("requirements", title)` yields `Staffing requirement "<title>"`, as the rule-ops plan's rejection-prefix constraint states.
- oxlint's enabled rules do not include `no-array-index-key`. If they do, give `OverrideRow` a stable key instead of the index.
- `ask_nurse_on_leave` ranks second for `shortOnLeaveDay` (Task 9 Step 5 covers the other case).
