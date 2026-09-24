# Leave Questions per Run and a Temporary-Staff Flag: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) The Preview asks one "gave up their leave" question per unbroken run of one person's leave. It names calendar dates (`10–16 Oct`), not internal date ids. (2) A person can be marked **temporary** (borrowed from another ward, float pool or agency). The Preview then asks the lending ward to confirm, even for a whole-period loan. The repair playbook can then offer a whole-period borrow into a skill group.

**Architecture:** Task 1 changes only `deriveAssumptions` in `web/lib/proposal/assumptions.ts`. A one-day run keeps its current assumption id, so stored single-day answers still match. Tasks 2-6 add an optional `temporary` boolean to the person record. It is **authoring-only**, like `ShiftType.durationMinutes`. `core` accepts it (`StrictBool | None`) and the solver ignores it. The web writes only `true`. Thus existing documents and hashes do not change. One pure primitive, `writeTemporary` (in `people-descriptor.ts`), is used by both the Staff screen and the assistant's `add_person` / `edit_person` arms. That keeps the parity tests meaningful. The assumptions and the repair builder then read the flag.

**Tech Stack:** Next.js 16 (`web/`), React 19, TypeScript, zod 4, zustand 5, vitest 4 and Testing Library, Base UI `Switch`. Python 3.14 and pydantic 2 for `core/`. Lint is oxlint and ast-grep.

**Spec:** There is no separate spec. This plan implements beads `nursing-sheduler-4lt` ("Leave confirmation: one question per leave run + real dates") and `nursing-sheduler-jsx` ("add_person: required temporary flag for borrowed/agency staff"), as the controller wrote them on 2026-09-24. Read both with `bd show nursing-sheduler-<id>`.

## Global Constraints

- Assistant command arms: every field is REQUIRED. No optional or nullable fields (`web/lib/ai/runtime/model-visible-tools.test.ts` "offers, for every arm, exactly the fields the canonical schema requires").
- `ASSISTANT_COMMAND_SCHEMA_VERSION` stays `1` (see Decisions D3). Host code reads a stored command's flag as `command.temporary === true`, never as a plain truthy value. A stored command from before this change has no key, and that means "not temporary".
- The person record stores `temporary` only as `true`. Absent means the ward's own staff. `false` is never written to the document, the YAML or IndexedDB.
- No `REPOSITORY_SCHEMA_VERSION`, `SCENARIO_PERSIST_VERSION`, `workspaceVersion` or `apiVersion` bump. The field is additive and optional.
- `core/nurse_scheduling` changes only `models.Person`. The solver, exporter and `server/workspace.py` do not change (`WorkspaceSchedulingDataV1` reuses `PeopleContainer`).
- User copy: "Temporary", "borrowed from another ward, float pool or agency". Use British spelling as the app does. The calendar labels use fixed English month abbreviations (`Jan` to `Dec`), never `Intl` (ICU's en-GB gives `Sept`, which depends on the runtime).
- Tests: `cd web && pnpm vitest run <path>`. Gates: `cd web && pnpm typecheck` and `cd web && pnpm run lint` (`oxlint && ast-grep scan`). Use `run`. Do not run `pnpm install` or `pnpm build`.
- Core tests: from the repo root, `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests/<file> -q`.
- Help copy changes: after you edit `web/lib/capability/help-content.ts`, run `cd web && pnpm capability:generate` and commit the regenerated registry.
- Some tests are locked: `model-visible-tools.test.ts`, the `repair-eval.test.ts` expectations and file snapshots, and the exact question strings in `assumptions.test.ts` / `proposal.test.ts`. Change them on purpose, in the task that changes the behaviour. Never change them "to make it green" in another task.
- Sibling plans of the same day can also edit `help-content.ts` (`staff-list`), `repair-options.ts`, `playbook.ts` and `commands.ts`. If an edit of this plan conflicts, keep both changes. Do not overwrite.

## Review Focus

1. **A pending proposal prepared before Task 1 that cancels several consecutive leave days.** Its stored per-day answers no longer match the grouped question. Expected: Apply refuses safely ("still needs a real-world confirmation") and the user asks again. Nothing is applied without an answer. A one-day cancellation keeps working unchanged. (Test: Task 1, `keeps a one-day question's identity, so stored answers still match`.)
2. **Leave that crosses a month or year, or dates the range cannot resolve.** Expected: `30 Oct – 1 Nov` and `30 Dec 2026 – 2 Jan 2027`. An unresolvable date id falls back to its own one-day question with the raw id. (Tests: Task 1, `calendarSpan` cases and `spans a month boundary`.)
3. **A YAML or backup file with `temporary: "yes"`, `1` or `false`.** Expected: web and core reject the string and the number. `false` loads and is dropped. (Tests: Task 2 import and core cases. The differential case runs with `RUN_DIFFERENTIAL=1`.)
4. **Editing a temporary nurse's name or groups on the Staff screen or through `edit_person`.** Expected: the flag survives a rename (the cascade keeps the other fields). The host reports "no change" only for the same name, groups and flag. (Tests: Task 3 `keeps Temporary through a rename`, Task 4 parity cases.)
5. **An ordinary new hire (`temporary: false`, no hard days off).** Expected: no lending-ward question, as today. (Test: Task 5, the existing `does not ask about an ordinary new staff member`, updated.)

---

## File Structure

| File | Change |
|---|---|
| `web/lib/proposal/assumptions.ts` | Group lost leave into runs, `calendarSpan` label, borrowed nurse from `temporary` |
| `core/nurse_scheduling/models.py` | `Person.temporary: StrictBool \| None` |
| `web/lib/scenario/types.ts`, `canonical.ts`, `import-scenario.ts`, `schemas/import.ts`, `schemas/producer.ts` | Carry `temporary` through the canonical, import and Workspace boundaries |
| `web/lib/store/persistence.ts` | Check the persisted field |
| `web/components/people/people-descriptor.ts` | `writeTemporary` primitive |
| `web/components/people/people-table.tsx` | Temporary switch in the row editor, badge in the read row |
| `web/lib/proposal/commands.ts`, `operations.ts`, `diff.ts` | Required `temporary` on `add_person` / `edit_person`, Preview text |
| `web/lib/ai/assistant/repair-options.ts`, `playbook.ts` | Borrow always `temporary: true`, always a host question |
| `web/lib/capability/help-content.ts` | `staff-list` summary |

Task order: Task 1 is independent. Tasks 2 → 3 → 4 → 5 → 6 depend on each other in that order.

---

### Task 1: One leave question per run, in calendar dates

**Files:**
- Modify: `web/lib/proposal/assumptions.ts` (imports at line 20, the destroyed-leave loop in `deriveAssumptions` at lines 145-163, the `toDate` doc on `OperationalAssumption`)
- Test: `web/lib/proposal/assumptions.test.ts`, `web/lib/proposal/proposal.test.ts:98`

**Interfaces:**
- Consumes: `dateIdToIso(id, range)` and `isoToUtcMs(iso)` from `@/lib/dates/date-id`, and `proposalDigest` from `./digest`.
- Produces: `export function calendarSpan(fromIso: string, toIso: string): string`, used again in Task 5. A `leave_cancelled` assumption now has `date` = first date id of the run, and `toDate` = last date id for a run of 2 or more days, or `null` for a single day.

**How answers are keyed (read before you start):** `assumptionId(type, person, date, toDate)` hashes the three fields. `activeConfirmations` accepts a stored confirmation only when its id and all three fields match a live assumption and its `proposalRevision` is current. `repository.ts:1293` re-derives assumptions inside the Apply transaction and throws `confirmation_missing` for any that is not answered. Receipts store only `confirmationsDigest`, which is never re-derived. So a one-day run (`toDate: null`) keeps today's id byte for byte. A multi-day run gets a new id, so old per-day answers do not count for it (Review Focus 1).

- [ ] **Step 1: Write the failing tests**

In `assumptions.test.ts`, add `import { proposalDigest } from "./digest";` and add `calendarSpan` to the `./assumptions` import. Change the existing expectation at line 159 to `question: "Has Ana agreed to give up their leave on 14 Oct?",`. Rename `"removing a person asks about each leave day"` to `"removing a person asks about each run of their leave"` (its body does not change). Then append:

```ts
describe("calendarSpan", () => {
  it.each([
    ["2026-10-14", "2026-10-14", "14 Oct"],
    ["2026-10-10", "2026-10-16", "10–16 Oct"],
    ["2026-10-30", "2026-11-01", "30 Oct – 1 Nov"],
    ["2026-12-30", "2027-01-02", "30 Dec 2026 – 2 Jan 2027"],
    ["2026-09-01", "2026-09-02", "1–2 Sep"],
  ])("%s to %s reads %s", (from, to, label) => {
    expect(calendarSpan(from, to)).toBe(label);
  });
});

describe("cancelled leave is asked about once per unbroken run", () => {
  /** octoberWard with Ana's leave replaced by exactly these October days. */
  function anaOnLeave(days: string[]) {
    const base = octoberWard();
    return {
      ...base,
      reqData: [
        ...base.reqData.filter((cell) => cell.kind !== "leave"),
        ...days.map((d) => ({ uid: `ana-leave-${d}`, person: "Ana", date: d, kind: "leave" as const })),
      ],
    };
  }
  function derive(
    before: ReturnType<typeof octoberWard>,
    commands: Parameters<typeof applyAssistantCommands>[1],
  ) {
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(applied.rejection.message);
    return deriveAssumptions(before, applied.next, commands);
  }
  const clearWeek = [
    { type: "clear_requests" as const, personId: "Ana", startDate: "2026-10-10", endDate: "2026-10-16" },
  ];

  it("asks once about a cleared week, in calendar dates", () => {
    const assumptions = derive(anaOnLeave(["10", "11", "12", "13", "14", "15", "16"]), clearWeek);
    expect(assumptions).toEqual([
      expect.objectContaining({
        type: "leave_cancelled",
        person: "Ana",
        date: "10",
        toDate: "16",
        question: "Has Ana agreed to give up their leave on 10–16 Oct?",
      }),
    ]);
  });

  it("asks separately about two runs a free day splits", () => {
    const assumptions = derive(anaOnLeave(["10", "11", "13", "14"]), clearWeek);
    expect(assumptions.map((a) => a.question).sort()).toEqual(
      [
        "Has Ana agreed to give up their leave on 10–11 Oct?",
        "Has Ana agreed to give up their leave on 13–14 Oct?",
      ].sort(),
    );
  });

  it("spans a month boundary", () => {
    const before = {
      ...octoberWard(),
      rangeEnd: "2026-11-30",
      reqData: ["10-30", "10-31", "11-01"].map((d) => ({
        uid: `ana-leave-${d}`,
        person: "Ana",
        date: d,
        kind: "leave" as const,
      })),
    };
    const assumptions = derive(before, [{ type: "remove_person", personId: "Ana" }]);
    expect(assumptions.map((a) => [a.date, a.toDate, a.question])).toEqual([
      ["10-30", "11-01", "Has Ana agreed to give up their leave on 30 Oct – 1 Nov?"],
    ]);
  });

  it("keeps a one-day question's identity, so stored answers still match", () => {
    const [only] = derive(octoberWard(), [
      { type: "clear_requests", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
    ]);
    expect(only.assumptionId).toBe(
      `leave_cancelled:${proposalDigest({ person: "Ana", date: "14", toDate: null })}`,
    );
  });

  it("keeps Apply blocked until every run is answered", () => {
    const assumptions = derive(anaOnLeave(["10", "11", "13", "14"]), clearWeek);
    const [first] = assumptions;
    const answer: OperationalConfirmationV1 = {
      assumptionId: first.assumptionId,
      type: first.type,
      person: first.person,
      date: first.date,
      toDate: first.toDate,
      proposalRevision: 1,
      confirmedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(outstandingAssumptions(assumptions, [answer], 1)).toHaveLength(1);
  });
});
```

In `proposal.test.ts:98`, change `"Has Ana agreed to give up their leave on 14?"` to `"Has Ana agreed to give up their leave on 14 Oct?"`.

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd web && pnpm vitest run lib/proposal/assumptions.test.ts lib/proposal/proposal.test.ts`
Expected: FAIL. `calendarSpan` is not exported. The week case gets 7 assumptions. The "14 Oct" strings do not match.

- [ ] **Step 3: Implement**

In `assumptions.ts`, change the import on line 20 to:

```ts
import { dateIdToIso, generateDateItems, isoToUtcMs } from "@/lib/dates/date-id";
```

Add below `leavePins`:

```ts
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/**
 * A run of calendar days as a ward writes it: "14 Oct", "10–16 Oct", "30 Oct – 1 Nov",
 * "30 Dec 2026 – 2 Jan 2027". The month names are fixed here: ICU's en-GB "Sept"
 * would make the same question read differently on another runtime.
 */
export function calendarSpan(fromIso: string, toIso: string): string {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const from = `${fd} ${MONTHS[fm - 1]}`;
  if (fromIso === toIso) return from;
  if (fy !== ty) return `${from} ${fy} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fm !== tm) return `${from} – ${td} ${MONTHS[tm - 1]}`;
  return `${fd}–${td} ${MONTHS[fm - 1]}`;
}

/**
 * Leave the change destroys, ONE question per unbroken run of one person's days.
 * Clearing a week is one agreement with that nurse, not seven. A one-day run keeps
 * `toDate: null`, so its id is the one a per-day question always had and a stored
 * answer to it still counts. A date the BEFORE range cannot resolve gets its own
 * question with its raw id.
 */
function cancelledLeave(before: ScenarioUiState, lost: readonly UiRequestCell[]) {
  const range = { start: before.rangeStart, end: before.rangeEnd };
  const byPerson = new Map<string, { cell: UiRequestCell; iso: string | null }[]>();
  for (const cell of lost) {
    const key = stableStringify(cell.person);
    const days = byPerson.get(key) ?? [];
    days.push({ cell, iso: dateIdToIso(String(cell.date), range) });
    byPerson.set(key, days);
  }
  const assumptions: OperationalAssumption[] = [];
  for (const days of byPerson.values()) {
    days.sort((a, b) => (a.iso ?? "").localeCompare(b.iso ?? ""));
    const runs: (typeof days)[] = [];
    for (const day of days) {
      const run = runs[runs.length - 1];
      const previous = run?.[run.length - 1];
      const next = previous?.iso && day.iso && isoToUtcMs(day.iso) - isoToUtcMs(previous.iso) === DAY_MS;
      if (next) run.push(day);
      else runs.push([day]);
    }
    for (const run of runs) {
      const first = run[0];
      const last = run[run.length - 1];
      const person = ref(first.cell.person);
      const date = ref(first.cell.date);
      const toDate = run.length > 1 ? ref(last.cell.date) : null;
      const when = first.iso && last.iso ? calendarSpan(first.iso, last.iso) : date;
      assumptions.push({
        assumptionId: assumptionId("leave_cancelled", person, date, toDate),
        type: "leave_cancelled",
        person,
        date,
        toDate,
        question: `Has ${person} agreed to give up their leave on ${when}?`,
        detail:
          (run.length > 1
            ? `This change removes all ${run.length} days of that leave from the schedule.`
            : "This change removes that leave from the schedule.") +
          " Applying it does not tell anyone, and it cannot be recovered except by Undo.",
      });
    }
  }
  return assumptions;
}
```

Replace the destroyed-leave loop in `deriveAssumptions` (the `for (const [key, cell] of leavePins(before))` block that pushes `leave_cancelled`) with:

```ts
  const lost: UiRequestCell[] = [];
  for (const [key, cell] of leavePins(before)) {
    const followed = `${renamedTo(stableStringify(cell.person))}|${stableStringify(cell.date)}`;
    if (claimed.has(key) || surviving.has(key) || surviving.has(followed)) continue;
    lost.push(cell);
  }
  assumptions.push(...cancelledLeave(before, lost));
```

Change the `toDate` doc comment on `OperationalAssumption` to:

```ts
  /** `leave_moved`: where it moves to. `leave_cancelled` / `borrowed_staff_arranged`: the run's last date (null for one day). */
```

Update the header comment line "once per named person, date and action" to "once per named person, unbroken run of dates, and action".

- [ ] **Step 4: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run lib/proposal lib/repository/assistant-apply.test.ts lib/store/assistant-proposal.test.ts lib/ai/assistant`
Expected: PASS. `repair-eval`'s `ask_nurse_on_leave` still gets a `leave_cancelled` question.

- [ ] **Step 5: Gates and commit**

Run: `cd web && pnpm typecheck && pnpm run lint`

```bash
git add web/lib/proposal/assumptions.ts web/lib/proposal/assumptions.test.ts web/lib/proposal/proposal.test.ts
git commit -m "fix(assistant): one leave question per run, in calendar dates"
```

---

### Task 2: `temporary` round-trips through every document boundary

**Files:**
- Modify: `core/nurse_scheduling/models.py:6` (import) and `:53-57` (`Person`)
- Modify: `web/lib/scenario/types.ts:131-135` (`CanonicalPerson`) and the `UiPerson` interface
- Modify: `web/lib/scenario/canonical.ts:88-94` (`mapPerson`)
- Modify: `web/lib/scenario/schemas/producer.ts:48-52` (`zPerson`. The Workspace schema reuses `producerPeopleContainer`.)
- Modify: `web/lib/scenario/schemas/import.ts:34-38` (`zImportPerson`)
- Modify: `web/lib/scenario/import-scenario.ts:240-242` (`normalizePerson`. `workspace.ts` reuses it.)
- Modify: `web/lib/store/persistence.ts:266-279` (`validatePerson`)
- Test: `core/tests/test_models_validation.py`, `web/lib/scenario/canonical.test.ts`, `web/lib/scenario/import-scenario.test.ts`, `web/lib/scenario/workspace.test.ts`, `web/lib/scenario/differential/differential.test.ts`

**Interfaces:**
- Produces: `UiPerson.temporary?: boolean` and `CanonicalPerson.temporary?: boolean`. The canonical projection emits the key only as `true`.

- [ ] **Step 1: Write the failing core test**

Append to `core/tests/test_models_validation.py`:

```python
def test_person_accepts_the_authoring_only_temporary_flag():
    payload = _base_payload()
    payload["people"]["items"] = [{"id": "n1", "temporary": True}]
    data = NurseSchedulingData.model_validate(payload)
    assert data.people.items[0].temporary is True


def test_person_rejects_a_non_boolean_temporary_flag():
    for bad in ("yes", 1):
        payload = _base_payload()
        payload["people"]["items"] = [{"id": "n1", "temporary": bad}]
        with pytest.raises(ValueError):
            NurseSchedulingData.model_validate(payload)
```

- [ ] **Step 2: Run it and check that it fails**

Run: `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests/test_models_validation.py -q`
Expected: FAIL with `Extra inputs are not permitted` on `temporary`.

- [ ] **Step 3: Implement the core field**

In `models.py`, add `StrictBool` to the pydantic import on line 6. Then:

```python
class Person(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int | str
    description: str | None = None
    history: list[str] | None = None
    # Authoring-only: a nurse borrowed from another ward, float pool or agency. The
    # frontend derives the lending-ward confirmation from it; the solver reads nothing
    # from it. StrictBool, so "yes" or 1 cannot pass as true.
    temporary: StrictBool | None = None
```

Run: `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests/test_models_validation.py core/tests/test_shift_type_working_time.py -q`
Expected: PASS.

- [ ] **Step 4: Write the failing web tests**

`canonical.test.ts` (add the import of `makeValidUiState` from `./test-fixtures` if the file lacks it):

```ts
it("emits temporary only for a temporary person", () => {
  const state = makeValidUiState();
  state.staff = [{ id: "Float", temporary: true }, { id: "Own", temporary: false }, { id: "Plain" }];
  expect(toCanonicalScenarioDocument(state).people.items).toEqual([
    { id: "Float", temporary: true },
    { id: "Own" },
    { id: "Plain" },
  ]);
});
```

`import-scenario.test.ts`:

```ts
describe("the temporary flag", () => {
  const yaml = (flag: string) => `apiVersion: alpha
dates: {range: {startDate: 2026-05-14, endDate: 2026-05-14}}
people: {items: [{id: P1, temporary: ${flag}}, {id: P2}]}
shiftTypes: {items: [{id: D}]}
preferences: [{type: at most one shift per day}]
`;

  it("imports true and drops false", () => {
    const yes = importScenarioYaml(yaml("true"));
    if (!yes.ok) throw new Error(JSON.stringify(yes.issues));
    expect(yes.target.staff).toEqual([{ id: "P1", temporary: true }, { id: "P2" }]);
    const no = importScenarioYaml(yaml("false"));
    if (!no.ok) throw new Error(JSON.stringify(no.issues));
    expect(no.target.staff).toEqual([{ id: "P1" }, { id: "P2" }]);
  });

  it("rejects a non-boolean flag", () => {
    expect(importScenarioYaml(yaml('"yes"')).ok).toBe(false);
    expect(importScenarioYaml(yaml("1")).ok).toBe(false);
  });

  it("survives the browser store", () => {
    expect(() =>
      sanitizePersistedScenario({ staff: [{ id: "P1", temporary: "yes" }] }),
    ).toThrow(/temporary/);
  });
});
```

(`sanitizePersistedScenario` is already imported in this file. If it reports bad input by some channel other than throwing, match what the neighbouring persistence tests in this file assert.)

`workspace.test.ts`:

```ts
it("keeps a temporary person through a Workspace backup", () => {
  const state = makeValidUiState();
  state.staff = [{ id: "Alice", history: ["D"], temporary: true }, { id: "Bob" }];
  const yaml = serializeWorkspace(state);
  expect(yaml).toMatch(/temporary: true/);
  const loaded = prepareScenarioLoad(yaml);
  expect(loaded.issues).toEqual([]);
  expect(loaded.target?.staff).toEqual([
    { id: "Alice", history: ["D"], temporary: true },
    { id: "Bob" },
  ]);
});
```

`differential/differential.test.ts`: add inside the `"differential — C1 ..."` describe:

```ts
it(
  "both languages accept a temporary person and reject a non-boolean flag",
  { timeout: oracleBudget(2) },
  () => {
    const state = makeValidUiState();
    state.staff = [{ id: "Alice", temporary: true }, { id: "Bob" }];
    const ok = callOracle({ op: "load", yaml: serializeScenario(state) });
    expect(ok.ok).toBe(true);
    const people = ok.model!.people as { items: Record<string, unknown>[] };
    expect(people.items[0].temporary).toBe(true);

    const bad = serializeScenario(state).replace("temporary: true", 'temporary: "yes"');
    expect(callOracle({ op: "load", yaml: bad }).ok).toBe(false);
    expect(importScenarioYaml(bad).ok).toBe(false);
  },
);
```

- [ ] **Step 5: Run them and check that they fail**

Run: `cd web && pnpm vitest run lib/scenario/canonical.test.ts lib/scenario/import-scenario.test.ts lib/scenario/workspace.test.ts`
Expected: FAIL. `temporary` is not on the types, the strict import schema rejects the key, and the persistence check is missing.

- [ ] **Step 6: Implement the web boundaries**

`types.ts`, on `UiPerson` after `history`, and the same line on `CanonicalPerson`:

```ts
  /** Borrowed from another ward, float pool or agency. Absent = the ward's own staff; only `true` is stored. */
  temporary?: boolean;
```

`canonical.ts` `mapPerson`:

```ts
function mapPerson(person: UiPerson): CanonicalPerson {
  return compact({
    id: person.id,
    description: person.description,
    history: person.history,
    temporary: person.temporary === true ? true : undefined,
  });
}
```

`schemas/producer.ts` `zPerson`: add `temporary: z.boolean().optional(),`.
`schemas/import.ts` `zImportPerson`: add `temporary: z.boolean().nullish(),`.

`import-scenario.ts` `normalizePerson`:

```ts
function normalizePerson(p: ImportScenarioParsed["people"]["items"][number]): UiPerson {
  return clean({
    id: p.id,
    description: str(p.description),
    history: p.history ?? undefined,
    temporary: p.temporary === true ? true : undefined,
  });
}
```

`persistence.ts` `validatePerson`, after the history check:

```ts
  if (el.temporary !== undefined && typeof el.temporary !== "boolean") {
    throw new Error("Persisted staff element temporary must be a boolean or absent.");
  }
```

Do not change `web/lib/roster/context.ts` `pickPerson`. The roster viewer context carries only `id/description/history` by contract (`roster/types.ts:9-11`), and it derives the same way from old and new submissions.

- [ ] **Step 7: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run lib/scenario lib/store lib/roster`
Expected: PASS.
Optional, when Python is set up: `cd web && pnpm test:differential` (sets `RUN_DIFFERENTIAL=1`). Expected: PASS, including the new case.

- [ ] **Step 8: Gates and commit**

Run: `cd web && pnpm typecheck && pnpm run lint` and `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests -q`

```bash
git add core/nurse_scheduling/models.py core/tests/test_models_validation.py web/lib/scenario web/lib/store/persistence.ts
git commit -m "feat(staff): authoring-only temporary flag round-trips through YAML, backup and store"
```

---

### Task 3: A Temporary switch on the Staff screen

**Files:**
- Modify: `web/components/people/people-descriptor.ts` (add `writeTemporary`)
- Modify: `web/components/people/people-table.tsx` (`ReadRow` name cell near line 604, and the `RowEditor` state, `submit` and Nurse cell near lines 690-800)
- Modify: `web/lib/capability/help-content.ts:50-57` (`staff-list` summary), then regenerate
- Test: `web/components/people/people-descriptor.test.ts` (create), `web/components/people/people-table.test.tsx`

**Interfaces:**
- Consumes: `UiPerson.temporary` (Task 2).
- Produces: `export function writeTemporary(state: ScenarioUiState, id: PersonId, temporary: boolean): ScenarioUiState`. It returns the same `state` object when nothing changes (no spurious undo entry). It removes the key when it sets `false`. Task 4 uses it.

- [ ] **Step 1: Write the failing tests**

Create `web/components/people/people-descriptor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { writeTemporary } from "./people-descriptor";

const ward = () => ({
  ...createEmptyScenarioUiState(),
  staff: [{ id: "ana" }, { id: 7, temporary: true }],
});

describe("writeTemporary", () => {
  it("sets true, and removes the key for false", () => {
    const on = writeTemporary(ward(), "ana", true);
    expect(on.staff[0]).toEqual({ id: "ana", temporary: true });
    const off = writeTemporary(on, "ana", false);
    expect(off.staff[0]).toEqual({ id: "ana" });
    expect("temporary" in off.staff[0]).toBe(false);
  });

  it("returns the same state when nothing changes, and matches ids exactly", () => {
    const state = ward();
    expect(writeTemporary(state, "ana", false)).toBe(state);
    expect(writeTemporary(state, 7, true)).toBe(state);
    expect(writeTemporary(state, "7", false)).toBe(state); // "7" is not 7
  });
});
```

Append to `people-table.test.tsx`:

```ts
describe("PeopleTable — temporary staff", () => {
  it("adds a nurse marked Temporary and shows the badge", async () => {
    await seed({ staff: [], staffGroups: [] });
    render(<PeopleTable />);
    fireEvent.click(screen.getByTestId("people-add"));
    fireEvent.change(screen.getByTestId("people-name-input-__new__"), {
      target: { value: "Float RN" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /temporary/i }));
    fireEvent.click(screen.getByTestId("people-save-__new__"));
    expect(await staff()).toEqual([{ id: "Float RN", history: [], temporary: true }]);
    expect(
      within(screen.getByTestId(`people-row-${sk("Float RN")}`)).getByText("Temporary"),
    ).toBeInTheDocument();
  });

  it("keeps Temporary through a rename, and clears it in one undo step", async () => {
    await seed({ staff: [{ id: "Float", history: [], temporary: true }], staffGroups: [] });
    render(<PeopleTable />);
    fireEvent.click(screen.getByTestId(`people-edit-${sk("Float")}`));
    fireEvent.change(screen.getByTestId(`people-name-input-${sk("Float")}`), {
      target: { value: "Float RN" },
    });
    fireEvent.click(screen.getByTestId(`people-save-${sk("Float")}`));
    expect(await staff()).toEqual([{ id: "Float RN", history: [], temporary: true }]);

    const before = await historyLength();
    fireEvent.click(screen.getByTestId(`people-edit-${sk("Float RN")}`));
    const toggle = screen.getByRole("switch", { name: /temporary/i });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId(`people-save-${sk("Float RN")}`));
    expect(await staff()).toEqual([{ id: "Float RN", history: [] }]);
    expect(await historyLength()).toBe(before + 1);
  });
});
```

(If Base UI's switch exposes its state on another attribute in jsdom, assert on `data-checked` instead. The role and the accessible name are what matter.)

- [ ] **Step 2: Run them and check that they fail**

Run: `cd web && pnpm vitest run components/people`
Expected: FAIL. `writeTemporary` is not exported, and there is no switch.

- [ ] **Step 3: Implement the primitive**

Append to `people-descriptor.ts` (add `PersonId` to its `@/lib/scenario` type import):

```ts
/**
 * Mark one person temporary (borrowed from another ward, float pool or agency) or
 * not. The Staff row's Save and the assistant's `add_person` / `edit_person` both
 * write the flag through here. Only `true` is stored; the same state comes back when
 * nothing changes, so an unchanged Save makes no undo entry.
 */
export function writeTemporary(
  state: ScenarioUiState,
  id: PersonId,
  temporary: boolean,
): ScenarioUiState {
  const index = state.staff.findIndex((person) => Object.is(person.id, id));
  if (index === -1 || (state.staff[index].temporary === true) === temporary) return state;
  const { temporary: _was, ...rest } = state.staff[index];
  const staff = state.staff.slice();
  staff[index] = temporary ? { ...rest, temporary: true } : rest;
  return peopleDescriptor.writeState(state, { items: staff });
}
```

If oxlint flags `_was` as unused, use `const next = { ...state.staff[index] }; delete next.temporary;` instead.

- [ ] **Step 4: Implement the screen**

In `people-table.tsx`, import `Switch` from `@/components/ui/switch` and `writeTemporary` from `./people-descriptor` (next to `peopleDescriptor`).

`ReadRow`, in the name cell after the `people-name-${itemKey}` span:

```tsx
          {item.temporary && (
            <Badge
              variant="neutral"
              className="normal-case"
              data-testid={`people-temporary-${itemKey}`}
              title="Borrowed from another ward, float pool or agency"
            >
              Temporary
            </Badge>
          )}
```

`RowEditor`, next to the `draftGroups` state:

```tsx
  const [temporary, setTemporary] = React.useState(mode === "edit" && item!.temporary === true);
```

In `submit`, the add branch becomes:

```tsx
        commit((live) =>
          writeTemporary(
            writeItemGroups(addItem(live, descriptor, { id: check.id }), descriptor, check.id, draftGroups),
            check.id,
            temporary,
          ),
        );
```

and the edit branch's transform returns:

```tsx
          const renamed = nameChanged ? renameItem(live, descriptor, item!.id, check.id) : live;
          return writeTemporary(
            writeItemGroups(renamed, descriptor, effectiveId, draftGroups),
            effectiveId,
            temporary,
          );
```

In the Nurse cell, below the name error `div`:

```tsx
        <div className="mt-2 flex items-center gap-2">
          <Switch
            id={`people-temporary-input-${key}`}
            aria-label="Temporary: borrowed from another ward, float pool or agency"
            data-testid={`people-temporary-input-${key}`}
            checked={temporary}
            onCheckedChange={setTemporary}
          />
          <label htmlFor={`people-temporary-input-${key}`} className="text-meta text-ink2">
            Temporary (borrowed or agency)
          </label>
        </div>
```

Update the file-header bullet "INLINE-ROW edit" to say "…group toggle chips in the Group cell, a Temporary switch under the name, Save/Cancel in Actions".

- [ ] **Step 5: Update the help copy**

In `help-content.ts`, `staff-list` `nurseFacingSummary`, replace the sentence "A nurse borrowed from another ward for a few days is added like anyone else and marked off on the days they are not here." with "A nurse borrowed from another ward, the float pool or an agency is added with Temporary switched on, and marked off on the days they are not here." Add `"temporary staff"` to `concepts`.

Run: `cd web && pnpm capability:generate`

- [ ] **Step 6: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run components/people lib/capability`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

Run: `cd web && pnpm typecheck && pnpm run lint`

```bash
git add web/components/people web/lib/capability
git commit -m "feat(staff): Temporary switch and badge for borrowed or agency nurses"
```

---

### Task 4: `add_person` / `edit_person` carry a required `temporary`, and the Preview shows it

**Files:**
- Modify: `web/lib/proposal/commands.ts` (the `AssistantCommandV1` union at lines 236-241, the zod arms near lines 641-672, the header comment at lines 24-35)
- Modify: `web/lib/proposal/operations.ts:1197-1262` (`applyAddPerson`, `applyEditPerson`)
- Modify: `web/lib/proposal/diff.ts:411-417` (staff `render`)
- Test: `web/lib/proposal/operations.test.ts`, `web/lib/proposal/operations.parity.test.ts:344-400`, `web/lib/proposal/diff.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts:397-408`, and every other `add_person` / `edit_person` literal (`commands.test.ts`, `assumptions.test.ts`, `use-diagnostic-tools.test.tsx`, `repair-*.test.ts`)

**Interfaces:**
- Consumes: `writeTemporary(state, id, temporary)` (Task 3).
- Produces: `{ type: "add_person"; name: string; groups: string[]; temporary: boolean }` and `{ type: "edit_person"; personId: PersonRef; name: string; groups: string[]; temporary: boolean }`. Tasks 5 and 6 read `command.temporary === true`.

- [ ] **Step 1: Write the failing tests**

`model-visible-tools.test.ts`: add `temporary: true,` to the `add_person` representative and `temporary: false,` to `edit_person`.

`operations.parity.test.ts`: extend the two manual helpers and loops.

```ts
  function manualAddPerson(state: ScenarioUiState, name: string, groups: string[], temporary = false) {
    // ...existing body up to the return...
    return writeTemporary(
      writeItemGroups(addItem(state, d, { id: check.id }), d, check.id, groups),
      check.id,
      temporary,
    );
  }
```

(Keep the existing validation lines of both helpers. Only wrap the returned value in `writeTemporary(…, <final id>, temporary)`, as the Staff row does in Task 3. Import `writeTemporary` from `@/components/people/people-descriptor`.) In the `add_person` test, loop over `for (const temporary of [false, true])` and pass `temporary` to both sides. In the `edit_person` test, add a fourth tuple element `temporary: boolean` to `cases`, set `true` on the `["ana", "Ana Lim", ["RN"]]` and `[7, "7", ["Seniors"]]` rows, and add one case that only toggles the flag: `["ana", "ana", [], true]`.

`operations.test.ts`: add

```ts
it("edit_person that only changes the temporary flag is a change; the same flag is no effect", () => {
  const state = peopleScenario();
  const on = applyAssistantCommand(state, {
    type: "edit_person", personId: "ana", name: "ana", groups: groupsOf(state, "ana"), temporary: true,
  });
  if (!on.ok) throw new Error(on.rejection.message);
  expect(on.next.staff.find((p) => p.id === "ana")?.temporary).toBe(true);
  const again = applyAssistantCommand(on.next, {
    type: "edit_person", personId: "ana", name: "ana", groups: groupsOf(state, "ana"), temporary: true,
  });
  expect(again).toMatchObject({ ok: false, rejection: { code: "no_effect" } });
});

it("reads a stored add_person without the flag as the ward's own staff", () => {
  const legacy = { type: "add_person", name: "Cara", groups: [] } as unknown as AssistantCommandV1;
  const result = applyAssistantCommand(peopleScenario(), legacy);
  if (!result.ok) throw new Error(result.rejection.message);
  expect(result.next.staff.at(-1)).toEqual({ id: "Cara", history: [] });
});
```

`groupsOf` is a two-line local helper: `(s, id) => s.staffGroups.filter((g) => g.members.includes(id)).map((g) => g.id)`. Use an existing one if `operations.test.ts` already has it.

`diff.test.ts`: add

```ts
it("says when an added person is temporary", () => {
  const before = peopleScenario();
  const commands: AssistantCommandV1[] = [
    { type: "add_person", name: "Float RN", groups: [], temporary: true },
  ];
  const applied = applyAssistantCommands(before, commands);
  if (!applied.ok) throw new Error(applied.rejection.message);
  const entry = deriveProposalDiff(before, applied.next, commands).entries.find(
    (e) => e.key === `person:${JSON.stringify("Float RN")}`,
  );
  expect(entry).toMatchObject({ kind: "created", after: "Float RN (temporary: borrowed or agency)" });
});
```

Match the property that holds the entry list (`entries` or another name) and the key format to what the neighbouring `add_person` tests in `diff.test.ts` use.

Then add `temporary: false` to every other `add_person` / `edit_person` literal in the test files listed above, **except** in `repair-options.test.ts` and `repair-eval.test.ts`. Those change in Task 6 together with the builder. For now, add `temporary: false` there only where a test builds its OWN command (the `BROKEN` / `isSafeOption` tables). Leave the literals that assert builder output alone for now; they fail until Task 6, which is expected. `pnpm typecheck` lists every hand-typed literal.

- [ ] **Step 2: Run them and check that they fail**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/runtime/model-visible-tools.test.ts`
Expected: FAIL. The wire arm has no `temporary`, and the parity and diff expectations differ.

- [ ] **Step 3: Implement**

`commands.ts` union:

```ts
  | { type: "add_person"; name: string; groups: string[]; temporary: boolean }
  /**
   * Rename one person, set EXACTLY which staff groups they are in, and whether they
   * are temporary -- the Staff row's Edit. A name equal to the current id text is not
   * a rename.
   */
  | { type: "edit_person"; personId: PersonRef; name: string; groups: string[]; temporary: boolean }
```

zod `add_person` arm, after `groups`:

```ts
    temporary: z
      .boolean()
      .describe(
        "true for a nurse borrowed from another ward, the float pool or an agency; false for " +
          "the ward's own staff, including a new hire. A temporary nurse makes the preview ask " +
          "the lending ward to confirm the loan before Apply.",
      ),
```

zod `edit_person` arm, after `groups`:

```ts
    temporary: z
      .boolean()
      .describe(
        "Whether they are borrowed from another ward, the float pool or an agency. Send " +
          "their current value to keep it.",
      ),
```

In the header comment, change "`add_person` for the float nurse" to "`add_person` with `temporary: true` for the float nurse".

`operations.ts` `applyAddPerson` return:

```ts
  // A stored command prepared before the flag existed has no key: that reads as the
  // ward's own staff, which is what it meant then.
  return {
    ok: true,
    next: writeTemporary(
      writeItemGroups(addItem(state, d, { id: idCheck.id }), d, idCheck.id, groups),
      idCheck.id,
      command.temporary === true,
    ),
  };
```

`applyEditPerson`, inside the `try`:

```ts
    const renamed = renameTo === null ? state : renameItem(state, d, person.id, renameTo);
    const id = renameTo ?? person.id;
    next = writeTemporary(writeItemGroups(renamed, d, id, groups), id, command.temporary === true);
```

and the no-effect message becomes `` `${label}: already has that name, those groups and that temporary setting.` ``. Import `writeTemporary` from `@/components/people/people-descriptor` (the file already imports `peopleDescriptor` from there).

`diff.ts`, the staff `compareKeyed` `render`:

```ts
      render: (person) =>
        `${person.description?.trim() || person.id}${person.temporary ? " (temporary: borrowed or agency)" : ""}`,
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/runtime components/ai lib/ai/phase-2-absence.test.ts`
Expected: PASS. `lib/ai/assistant` builder-output tests still fail until Task 6. That is expected. Check with `pnpm vitest run lib/ai/assistant` that the ONLY failures are expectations of builder-produced `add_person` without `temporary`.

- [ ] **Step 5: Gates and commit**

Run: `cd web && pnpm typecheck && pnpm run lint`

```bash
git add web/lib/proposal web/lib/ai/runtime web/components/ai web/lib/ai/phase-2-absence.test.ts web/lib/ai/assistant/*.test.ts
git commit -m "feat(assistant): add_person and edit_person carry a required temporary flag"
```

---

### Task 5: The Preview asks the lender about any temporary hire

**Files:**
- Modify: `web/lib/proposal/assumptions.ts:167-219` (`borrowedStaff` and its doc)
- Test: `web/lib/proposal/assumptions.test.ts` ("real-world agreements beyond leave")

**Interfaces:**
- Consumes: `command.temporary` (Task 4), `calendarSpan` (Task 1).
- Produces: a `borrowed_staff_arranged` assumption for every `add_person` that has `temporary === true` OR a hard `set_off_request` in the same change. `date`/`toDate` are ISO first/last loan days, as today, so the ids of existing loan questions do not change.

- [ ] **Step 1: Write the failing tests**

In the existing bounded-loan test, add `temporary: false` to the `add_person` literal (the must-off detection has to keep working without the flag). Add `expect(assumption.question).toContain("3 Nov");`. In `does not ask about an ordinary new staff member`, the literal becomes `{ type: "add_person", name: "Dana", groups: [], temporary: false }`. Then add:

```ts
  it("asks about a temporary nurse borrowed for the whole period", () => {
    const before = SCENARIOS.onlyRnOnLeave();
    const commands: Parameters<typeof applyAssistantCommands>[1] = [
      { type: "add_person", name: "Agency RN", groups: ["RN"], temporary: true },
    ];
    const result = applyAssistantCommands(before, commands);
    if (!result.ok) throw new Error(result.rejection.message);
    expect(deriveAssumptions(before, result.next, commands)).toEqual([
      expect.objectContaining({
        type: "borrowed_staff_arranged",
        person: "Agency RN",
        date: before.rangeStart,
        toDate: before.rangeEnd,
        question: expect.stringMatching(/lending ward or agency confirmed Agency RN for .*, qualified as RN\?$/),
      }),
    ]);
  });

  it("does not ask when a temporary flag is set on someone already on the staff", () => {
    const before = peopleScenario();
    const commands: Parameters<typeof applyAssistantCommands>[1] = [
      { type: "edit_person", personId: "ana", name: "ana", groups: ["RN"], temporary: true },
    ];
    const result = applyAssistantCommands(before, commands);
    if (!result.ok) throw new Error(result.rejection.message);
    expect(deriveAssumptions(before, result.next, commands)).toEqual([]);
  });
```

(Use ana's real groups from `peopleScenario()` in the second test, so the command is not a group change.)

- [ ] **Step 2: Run them and check that they fail**

Run: `cd web && pnpm vitest run lib/proposal/assumptions.test.ts`
Expected: FAIL. The whole-period case gets `[]`, and the bounded question still reads ISO dates.

- [ ] **Step 3: Implement**

Replace the doc comment and the filter of `borrowedStaff`:

```ts
/**
 * A borrowed nurse, read from validated targets, never from model prose: an
 * `add_person` with `temporary: true`, or one with a hard `set_off_request` ("must")
 * in the same change (the loan shape `repair-options.ts` builds, and what a stored
 * command prepared before the flag existed looks like). The loan is read from the
 * AFTER document: the days she is NOT hard-off, which is the whole period when she
 * has none. An ordinary hire (not temporary, no hard days off) is not asked about.
 * Setting the flag on someone already on the staff is a label, not a new loan, so it
 * asks nothing.
 */
```

```ts
    if (command.type !== "add_person") return [];
    if (command.temporary !== true && !loaned.has(command.name)) return [];
```

and the question:

```ts
        question: `Has the lending ward or agency confirmed ${command.name} for ${calendarSpan(first, last)}, qualified as ${skills}?`,
```

`first`/`last` stay ISO in `date`/`toDate`, so the assumption ids do not change.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run lib/proposal`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

Run: `cd web && pnpm typecheck && pnpm run lint`

```bash
git add web/lib/proposal/assumptions.ts web/lib/proposal/assumptions.test.ts
git commit -m "feat(assistant): Preview asks the lending ward about any temporary hire"
```

---

### Task 6: Whole-period borrows, skill group included, with the host question

**Files:**
- Modify: `web/lib/ai/assistant/repair-options.ts` (`borrowTemporaryNurse` near lines 548-600, the `violatesSafetyFloor` `add_person` case near line 858, the `isSafeOption` `add_person` case near line 954, the header comment at lines 4-7)
- Modify: `web/lib/ai/assistant/playbook.ts` (the `borrow_temporary_nurse` entry comment near lines 195-200, the header ruling at lines 12-14)
- Test: `web/lib/ai/assistant/repair-options.test.ts`, `web/lib/ai/assistant/repair-eval.test.ts`, the file snapshots `core/tests/fixtures/assistant_repair/*.after.yaml`, and `core/tests/test_assistant_repair_fixtures.py` (run only)

**Interfaces:**
- Consumes: `add_person.temporary` (Task 4), the whole-period question (Task 5), and core accepting `temporary` (Task 2, because the `.after.yaml` snapshots now carry it).
- Produces: every `borrow_temporary_nurse` option has `enforcedBy: "host_question"`, and each of its `add_person` operations has `temporary: true`.

- [ ] **Step 1: Write the failing tests**

In `repair-options.test.ts` and `repair-eval.test.ts`, add `temporary: true` to every EXPECTED builder-produced `add_person` (`{ type: "add_person", name, groups: [...] }` in `toEqual` / `toMatchObject` of an option's `operations`, and the shared `borrowed` constant at `repair-options.test.ts:349`). Also set `temporary: true` on every hand-built `add_person` in a case that expects the borrow to PASS `isSafeOption` or `ok(...)` (for example `repair-options.test.ts:~1167` and the `add(n)` helper near line 913). Task 4 set those to `false`, and after this task `isSafeOption` refuses an unmarked borrow. In `repair-eval.test.ts`, change:

```ts
  it("too few nurses: borrow a temporary nurse for the whole period, asked on the Preview", () => {
    const [borrow] = options("tooFewNurses");
    expect(borrow.operations).toEqual([
      { type: "add_person", name: "Borrowed nurse 1", groups: [], temporary: true },
    ]);
    expect(borrow.enforcedBy).toBe("host_question");
  });
```

In the `BROKEN` floor table (`repair-options.test.ts:~1140`), the row `"skilled hire with no host question"` becomes `{ type: "add_person", name: "Borrowed nurse 1", groups: ["RN"], temporary: false }` (still breaks the floor, `/qualification/`). Add these tests:

```ts
  it("a temporary skilled borrow passes the floor on its own", () => {
    const rn = SCENARIOS.onlyRnOnLeave();
    expect(
      violatesSafetyFloor(
        rn,
        [{ type: "add_person", name: "Borrowed nurse 1", groups: ["RN"], temporary: true }],
        { leaveAsked: false },
      ),
    ).toBeNull();
  });

  it("borrows a temporary RN for the whole period when every night lacks one", () => {
    const base = SCENARIOS.onlyRnOnLeave();
    const state: ScenarioUiState = {
      ...base,
      reqData: ["01", "02", "03", "04", "05", "06", "07"].map((d) => ({
        uid: `rn1-leave-${d}`,
        person: "rn1",
        date: d,
        kind: "leave" as const,
      })),
    };
    const borrow = rank(state).find((o) => o.repairId === "borrow_temporary_nurse");
    expect(borrow).toMatchObject({ confirmation: "lending_ward", enforcedBy: "host_question" });
    expect(borrow?.operations.filter((op) => op.type === "set_off_request")).toEqual([]);
    expect(borrow?.operations[0]).toEqual({
      type: "add_person",
      name: "Borrowed nurse 1",
      groups: ["RN"],
      temporary: true,
    });
    expect(isSafeOption(state, borrow!)).toBe(true);
    const applied = applyAssistantCommands(state, borrow!.operations);
    if (!applied.ok) throw new Error(applied.rejection.message);
    expect(deriveAssumptions(state, applied.next, borrow!.operations).map((a) => a.type)).toContain(
      "borrowed_staff_arranged",
    );
  });

  it("isSafeOption refuses a borrow that is not marked temporary", () => {
    const rn = SCENARIOS.onlyRnOnLeave();
    const option = rank(rn).find((o) => o.repairId === "borrow_temporary_nurse")!;
    const unmarked = {
      ...option,
      operations: option.operations.map((op) =>
        op.type === "add_person" ? { ...op, temporary: false } : op,
      ),
    };
    expect(isSafeOption(rn, unmarked)).toBe(false);
  });
```

Import `violatesSafetyFloor`, `isSafeOption`, `applyAssistantCommands` and `deriveAssumptions` if the file does not already import them. Match the ward's real date ids: if `SCENARIOS` wards do not run 1-7 Nov with `DD` ids, use the ids that `ward()` produces. The `"only RN on leave"` borrow already uses `2026-11-03` / `"03"`.

Before implementing, check that the whole-period test fails **because the option is missing or is `chat`**, not because of the fixture. If `rank(state)` has no skill-mix finding (nothing about RN), fix the fixture first.

- [ ] **Step 2: Run them and check that they fail**

Run: `cd web && pnpm vitest run lib/ai/assistant`
Expected: FAIL. Builder output lacks `temporary`, `tooFewNurses` is `chat`, and the skilled whole-period borrow is filtered out.

- [ ] **Step 3: Implement**

`borrowTemporaryNurse`, the `add_person` op:

```ts
      { type: "add_person", name, groups: group ? [group] : [], temporary: true },
```

Replace the `enforcedBy` line and its comment with:

```ts
    // `temporary: true` makes the Preview ask the lender (assumptions.ts), for a
    // whole-period loan too, so the agreement is always a host question.
    enforcedBy: "host_question",
```

Update the comment above `loanIds` ("She is here on the short dates only (or the whole period)…") to also say that on a whole-period loan she has no days off and the flag is what marks her as borrowed.

`violatesSafetyFloor`, `add_person` case:

```ts
        case "add_person":
          if (!PLACEHOLDER.test(op.name) || ctx.staffIds.has(op.name) || ctx.groupIds.has(op.name))
            return invented;
          // A temporary nurse, or one with hard days off, is a loan the Preview asks the lender about.
          return op.groups.length > 0 && op.temporary !== true && !loaned.has(op.name)
            ? skillGroup
            : null;
```

`isSafeOption`, `add_person` case:

```ts
      case "add_person":
        // A placeholder (the floor), marked temporary, in real groups, and a skill group only with a host question.
        return (
          loan &&
          op.temporary === true &&
          op.groups.every((g) => ctx.groupIds.has(g)) &&
          (op.groups.length === 0 || option.enforcedBy === "host_question")
        );
```

`repair-options.ts` header, and the `playbook.ts` header ruling and the `borrow_temporary_nurse` comment: change "`add_person` + `set_off_request` "must" outside the loan" to "`add_person` with `temporary: true`, plus `set_off_request` "must" outside the loan when the loan is shorter than the period". Leave the `unexplained` situation list and its comment alone (no guessed borrow there).

- [ ] **Step 4: Refresh the solver fixtures on purpose, then prove the solver accepts them**

Run: `cd web && pnpm vitest run lib/ai/assistant/repair-eval.test.ts -u`
Then check the diff: `git diff --stat core/tests/fixtures/assistant_repair/`. Only `*.after.yaml` files can change, and only by gaining `temporary: true` on `Borrowed nurse N` people. Any other change means the edit went wrong. Stop and look.

Run: `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests/test_assistant_repair_fixtures.py -q`
Expected: PASS (it needs Task 2's core field).

- [ ] **Step 5: Run everything and check that it passes**

Run: `cd web && pnpm vitest run lib/ai lib/proposal components/ai components/people`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

Run: `cd web && pnpm typecheck && pnpm run lint` and `PYTHONPATH=core /usr/bin/python3 -m pytest core/tests -q`

```bash
git add web/lib/ai/assistant core/tests/fixtures/assistant_repair
git commit -m "feat(assistant): offer whole-period borrows, skill group included, with the lender question"
```

---

## Decisions

- **D1. `temporary` goes into the canonical person model, `core` included (authoring-only).** The flag has to survive YAML export/import and Workspace backups. `core` checks both (`models.Person` has `extra="forbid"`, and `server/workspace.py` reuses `PeopleContainer`). A UI-only field needs stripping at the strict projection and a second place to store it. That is more code for the same result. The precedent is `ShiftType.durationMinutes`/`startTime`: stored, round-tripped, ignored by the solver.
- **D2. No schema version bumps.** `workspaceVersion` is bumped "only on a breaking format change" (`server/workspace.py:141-156`). This change is additive and optional. `SCENARIO_PERSIST_VERSION` and `REPOSITORY_SCHEMA_VERSION` need no migration either, because a missing flag means "not temporary". The only compatibility cost is that an OLDER build rejects a NEW file that has a temporary nurse (`extra="forbid"`). That is acceptable for a pre-production app with no files in the wild (the same reasoning as decision 7 cited in `workspace.py`).
- **D3. `ASSISTANT_COMMAND_SCHEMA_VERSION` stays `1`.** `commandsDigest` hashes the version. A bump makes every stored pending proposal fail Apply with the misleading "the stored change does not match its own digest" (`repository.ts:1269`). Instead, the host reads a stored command without the key as not temporary. That is exactly what it meant. The parse schema still REQUIRES the field for every new model call.
- **D4. Only `true` is stored.** Existing documents, canonical hashes, fixture YAMLs and IndexedDB rows stay byte-identical. `writeTemporary` removes the key rather than writing `false`.
- **D5. One primitive, two callers.** `writeTemporary` lives in `people-descriptor.ts`. The Staff row and the assistant arms both call it, so `operations.parity.test.ts` still proves "the assistant does what the screen does".
- **D6. Leave grouping keeps the one-day id.** A single-day run hashes `{ person, date, toDate: null }` exactly as before, so stored single-day answers still count. Multi-day runs get a new id, and pending proposals prepared before the change fall to the existing fail-closed `confirmation_missing` path. No shim.
- **D7. Setting `temporary` on an existing person asks nothing.** The bead's trigger is "person added with temporary=true". Relabelling a nurse already on the roster makes no new real-world agreement.
- **D8. Every borrow option is `temporary: true` and `host_question`.** `isSafeOption` requires the flag, so a candidate that hides a skilled hire as an unmarked new hire is refused.

## Open questions

1. **Do we add a compat shim for a pending proposal with per-day answers to a multi-day run?** (For example, count a run as answered when each of its days has a per-day answer.) Recommended: no. Pending proposals are short-lived. They go stale on any scenario change, lease takeover or new commit. The app is pre-production, and the failure is safe: Apply refuses and the user asks again. The shim is permanent code for a transient case.
2. **Does the roster viewer show "Temporary" too (`roster/context.ts` `pickPerson`)?** Recommended: not now. The viewer context's contract is `id/description/history`, and no feature asks for the flag there. Add it with the first viewer feature that needs it.
3. **Does the Staff screen's "Upload list" set the flag (for example, from a column)?** Recommended: no. Uploads are the ward's own list. Borrowed nurses are added one at a time.
4. **Does the leave question also give the day count (`10–16 Oct, 7 days`)?** Recommended: not in the question. Put it in `detail`, as the plan does. The question stays short, and the detail says "all 7 days".
5. **Does the borrowed-nurse question keep ISO dates?** Recommended: no, use `calendarSpan` (Task 5). Only the text changes, not the ids, and it matches the leave questions.

## Assumptions

- A cell's `date` in `reqData` is a span-formatted date id or an ISO string. `dateIdToIso` resolves it against the BEFORE range. `borrowedStaff` already assumes this (it compares `item.id` and `item.iso`).
- The solver, exporter and anonymizer never read person fields generically. Thus an extra authoring field changes no solve. `test_shift_type_working_time.py` gives the same guarantee for shift fields. The anonymizer copies people records and only rewrites ids, so the flag reaches the solver YAML and is ignored there.
- `renameEntity` (the rename cascade) keeps a person's other fields. Task 3's "keeps Temporary through a rename" test proves it. If it fails, fix it in the cascade, not in the screen.
- Base UI's `Switch` renders `role="switch"` with the given `aria-label` in jsdom, as it does for `rule-row.tsx`.
- The `SCENARIOS` wards run 1-7 Nov 2026 with `DD` date ids (the existing `"03"` leave and `2026-11-0x` expectations say so).
