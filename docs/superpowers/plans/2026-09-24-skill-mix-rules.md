# Skill-Mix Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a ward manager say "at least 2 RNs among the 4 on every night" (or "at least one senior on every day"), in the Staffing requirements UI and through the assistant (propose, then Apply). The solver enforces it natively and bans nobody.

**Architecture:** Add an optional `skillMix: [{people, minNumPeople}]` field to the existing `shift type requirement` (core model plus web `RequirementCard`). The solver adds one `>=` inequality per (date, requirement group, entry) inside `shift_type_requirements`. The web threads the field through the requirement spine that already exists: form model, validation, canonical/import/export, persistence, cascade, Preview. The assistant gets one new arm (`set_skill_mix`) plus an optional `skillMix` on `add_staffing_requirement`. The static check and repair hooks learn about skill-mix entries, and the safety floor keeps forbidding every relaxation. The twin-shift idiom is not touched and keeps working.

**Tech Stack:** Python 3.14 + pydantic 2 + OR-Tools CP-SAT (core/), Next.js + TypeScript + zod + vitest + Testing Library + Playwright (web/).

**Spec:** `docs/superpowers/specs/2026-09-24-skill-mix-rules.md`

## Global Constraints

- Field name `skillMix`. Entry fields `people` (a single person or staff-group id, `int | str`) and `minNumPeople` (int). The same shape in core YAML, canonical JSON, the web card and the assistant arm.
- Skill mix is always hard: no weight field.
- Validity: `1 <= minNumPeople <= requiredNumPeople`, `people` unique per card, card `qualifiedPeople` absent or `ALL`, no `shiftTypeCoefficients`.
- The field is additive and optional. No `workspaceVersion` bump, no `SCENARIO_PERSIST_VERSION` bump, no migration, and existing twin scenarios stay unchanged.
- Validation messages exactly as in the spec (`REQUIREMENT_MESSAGES.skillMix*`).
- Preview suffix exactly: `; at least 2 from “RN”, 1 from “Senior” — anyone can fill the other places`.
- Assistant arm names: `set_skill_mix` (new), `add_staffing_requirement.skillMix` (new optional field). `edit_staffing_requirement` keeps the stored `skillMix`.
- Safety floor: never remove or lower an entry, never change its `people`, never remove a group that an entry names, and `set_skill_mix` is never in a repair (`isSafeOption`).
- Commands: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q <path>`. `cd web && pnpm vitest run <path>`, `pnpm typecheck`, `pnpm lint`, `pnpm capability:generate`, `pnpm test:e2e <spec>`.
- Locked tests change only on purpose. The ones this plan changes are listed in each task under "Deliberate test changes", each with its reason in the commit body.
- Do not commit unless the user asks (repo profile: Conservative). The "Commit" steps below give the message to use when commits are allowed.

## Review Focus

1. **A group that is empty or deleted after the rule is made.** The solver must return INFEASIBLE, not crash, and the static check must report the skill-mix gap. Pinned in Task 2 (`test_empty_group_is_infeasible_not_a_crash`) and Task 8 (`empty group is a skill-mix gap`).
2. **Lowering the headcount below the skill mix, from any entry point** (the form, Guided quick edit, Shifts page staffing, `set_staffing_requirement_people`, `edit_staffing_requirement`). Each must refuse with the same message. Pinned in Task 4 (quick edit), Task 5 (Shifts page) and Task 7 (the two arms).
3. **Renaming or deleting a staff group that a skill mix names.** A rename must rewrite the entry. A delete must prune it, and the assistant must not be able to do that delete. Pinned in Task 3 (cascade) and Task 9 (`remove_people_group` floor).
4. **Editing a card through the older paths drops the skill mix without anyone noticing** (`edit_staffing_requirement`, `save-shift-card` staffing edit, enable/disable toggle). Pinned in Task 4 (`requirementToForm` round trip), Task 5 (Shifts page keeps it) and Task 7 (the edit arm keeps it).
5. **A person in two groups (an RN who is also a senior)** counts toward both entries. The solver must accept 2 people satisfying "2 RN + 1 Senior". Pinned in Task 2 (`test_overlapping_groups_count_toward_both`).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `core/nurse_scheduling/models.py` | modify | `SkillMixEntry`, `ShiftTypeRequirementsPreference.skillMix`, validator |
| `core/nurse_scheduling/preference_types.py` | modify | skill-mix inequality in `shift_type_requirements` |
| `core/nurse_scheduling/server/workspace.py` | modify | unknown-person check for `skillMix[].people` |
| `core/tests/test_skill_mix.py` | create | model and solver tests |
| `core/tests/test_server_scheduling_input.py` | modify | workspace reference test |
| `web/lib/scenario/types.ts` | modify | `SkillMixEntry`, `skillMix?` on canonical + card body |
| `web/lib/scenario/canonical.ts`, `schemas/import.ts`, `schemas/producer.ts`, `import-scenario.ts`, `anonymize.ts` | modify | carry the field |
| `web/lib/store/persistence.ts` | modify | sanitize `skillMix` |
| `web/lib/cascade/rename.ts`, `delete.ts` | modify | rewrite/prune entries |
| `web/lib/scenario/differential/oracle.py` | check | passes the field through (Python models already validate it) |
| `web/components/requirements/requirements-model.ts` | modify | form state, messages, validation, build/load, `skillMixFloor` |
| `web/components/requirements/requirement-form.tsx` | modify | Skill mix rows + help text |
| `web/components/requirements/requirement-card-list.tsx` | modify | summary text |
| `web/components/guided-rules/mappers.ts` | modify | quick edit floor + summary |
| `web/components/shift-types/save-shift-card.ts` | modify | chip + error mapping |
| `web/lib/proposal/diff.ts` | modify | Preview wording |
| `web/lib/proposal/commands.ts`, `operations.ts` | modify | `set_skill_mix`, `add_staffing_requirement.skillMix`, floor on `set_staffing_requirement_people` |
| `web/lib/rules/shortfalls.ts` | modify | skill-mix equations, `mixPeople` |
| `web/lib/ai/assistant/repair-options.ts`, `playbook.ts` | modify | repair hooks, safety floor |
| `web/lib/capability/help-content.ts` (+ `registry.generated.ts`) | modify | help text |
| `web/lib/rules/ward-fixtures.test-support.ts`, `core/tests/fixtures/assistant_repair/rnMixOnLeave.*.yaml` | modify/create | scripted repair ward |

---

### Task 1: Core model — `skillMix` on the shift type requirement

**Files:**
- Modify: `core/nurse_scheduling/models.py:321-340` (`ShiftTypeRequirementsPreference`)
- Test: `core/tests/test_skill_mix.py` (create)

**Interfaces:**
- Produces: `models.SkillMixEntry(people: int | str, minNumPeople: int)`, `ShiftTypeRequirementsPreference.skillMix: list[SkillMixEntry] | None`.

- [ ] **Step 1: Write the failing test**

```python
"""Skill mix: at least k of a group among a shift's staff, banning nobody."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from pydantic import ValidationError

from nurse_scheduling.models import ShiftTypeRequirementsPreference


def _req(**extra):
    base = {"shiftType": "N", "requiredNumPeople": 4, "qualifiedPeople": "ALL"}
    return ShiftTypeRequirementsPreference(**{**base, **extra})


def test_skill_mix_is_optional_and_parsed():
    assert _req().skillMix is None
    pref = _req(skillMix=[{"people": "RN", "minNumPeople": 2}])
    assert pref.skillMix[0].people == "RN"
    assert pref.skillMix[0].minNumPeople == 2


@pytest.mark.parametrize(
    "extra, message",
    [
        ({"skillMix": [{"people": "RN", "minNumPeople": 0}]}, "between 1 and requiredNumPeople"),
        ({"skillMix": [{"people": "RN", "minNumPeople": 5}]}, "between 1 and requiredNumPeople"),
        (
            {"skillMix": [{"people": "RN", "minNumPeople": 1}, {"people": "RN", "minNumPeople": 2}]},
            "more than once",
        ),
        ({"qualifiedPeople": ["RN"], "skillMix": [{"people": "RN", "minNumPeople": 1}]}, "open to everyone"),
        (
            {"shiftTypeCoefficients": [["N", 2]], "skillMix": [{"people": "RN", "minNumPeople": 1}]},
            "shiftTypeCoefficients",
        ),
        ({"skillMix": [{"people": "RN", "minNumPeople": 1, "weight": 1}]}, "Extra inputs"),
    ],
)
def test_invalid_skill_mix_is_rejected(extra, message):
    with pytest.raises(ValidationError, match=message):
        _req(**extra)


def test_omitted_qualified_people_counts_as_everyone():
    pref = ShiftTypeRequirementsPreference(
        shiftType="N", requiredNumPeople=2, skillMix=[{"people": "RN", "minNumPeople": 1}]
    )
    assert pref.skillMix[0].minNumPeople == 1
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q tests/test_skill_mix.py`
Expected: FAIL. `skillMix` is rejected as an extra input.

- [ ] **Step 3: Implement**

In `models.py`, add this above `ShiftTypeRequirementsPreference`:

```python
class SkillMixEntry(BaseModel):
    """At least `minNumPeople` of `people` among the shift's staff. Bans nobody."""

    model_config = ConfigDict(extra="forbid")
    people: int | str  # One person or people-group id
    minNumPeople: int
```

Inside `ShiftTypeRequirementsPreference`, after `preferredNumPeople`:

```python
    # Skill mix: each entry is a hard floor on how many of its people work the
    # shift. Unlike qualifiedPeople it bans nobody. See shift_type_requirements.
    skillMix: list[SkillMixEntry] | None = None
```

and a validator after `validate_weight_field`:

```python
    @model_validator(mode="after")
    def validate_skill_mix(self) -> Self:
        if not self.skillMix:
            return self
        qualified = self.qualifiedPeople if isinstance(self.qualifiedPeople, list) else [self.qualifiedPeople]
        if self.qualifiedPeople is not None and any(str(q).upper() != ALL for q in qualified):
            raise ValueError("'skillMix' needs the shift open to everyone: set 'qualifiedPeople' to ALL or omit it")
        if self.shiftTypeCoefficients:
            raise ValueError("'skillMix' counts people and cannot be combined with 'shiftTypeCoefficients'")
        seen: set[int | str] = set()
        for entry in self.skillMix:
            if not 1 <= entry.minNumPeople <= self.requiredNumPeople:
                raise ValueError(
                    f"skillMix minNumPeople for {entry.people!r} must be between 1 and "
                    f"requiredNumPeople ({self.requiredNumPeople})"
                )
            if entry.people in seen:
                raise ValueError(f"skillMix names {entry.people!r} more than once")
            seen.add(entry.people)
        return self
```

(`model_validator`, `Self` and `ALL` are already imported at the top of `models.py`.)

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q tests/test_skill_mix.py tests/test_models_validation.py tests/test_preference_validation.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/nurse_scheduling/models.py core/tests/test_skill_mix.py
git commit -m "feat(core): skillMix field on shift type requirement"
```

---

### Task 2: Core solver — enforce the skill mix and ban nobody, plus the workspace reference check

**Files:**
- Modify: `core/nurse_scheduling/preference_types.py:165-190` (inside `shift_type_requirements`, after the hard headcount constraint)
- Modify: `core/nurse_scheduling/server/workspace.py:320-326` (`_reference_issues`)
- Test: `core/tests/test_skill_mix.py`, `core/tests/test_server_scheduling_input.py`

**Interfaces:**
- Consumes: `SkillMixEntry` (Task 1).
- Produces: solver semantics that later tasks rely on (`sum over eligible ∩ people >= minNumPeople`, per date, per top-level selector).

- [ ] **Step 1: Write the failing solver tests** (append to `core/tests/test_skill_mix.py`)

```python
import nurse_scheduling

PEOPLE = ["rn1", "rn2", "rn3", "en1", "en2", "en3", "en4", "en5"]
RNS = {"rn1", "rn2", "rn3"}


def _ward(night_extra: str = "", extra_prefs: str = "", groups: str = "[rn1, rn2, rn3]") -> str:
    items = "\n".join(f"    - id: {p}" for p in PEOPLE)
    # RNs would rather not do nights (soft). Without a skill mix the optimum puts
    # zero RNs on nights. With one, the solver is forced to place exactly the floor.
    avoid = "\n".join(
        f"""  - type: shift request
    person: {p}
    date: ALL
    shiftType: N
    weight: -1"""
        for p in sorted(RNS)
    )
    return f"""
apiVersion: alpha
dates:
  range:
    startDate: 2026-11-01
    endDate: 2026-11-07
people:
  items:
{items}
  groups:
    - id: RN
      members: {groups}
    - id: Senior
      members: [rn1, en1]
shiftTypes:
  items:
    - id: D
    - id: N
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    description: Day needs exactly 2
    shiftType: D
    requiredNumPeople: 2
  - type: shift type requirement
    description: Night needs exactly 4
    shiftType: N
    requiredNumPeople: 4
    qualifiedPeople: ALL
{night_extra}
{avoid}
{extra_prefs}
"""


MIX_2_RN = """    skillMix:
      - people: RN
        minNumPeople: 2"""


def _nights(df, day: int) -> set[str]:
    # Non-prettify layout: 2 header rows, 1 id column, people in item order.
    return {p for i, p in enumerate(PEOPLE) if df.iloc[2 + i, 1 + day] == "N"}


def _solve(yaml_text: str):
    df, _solution, _score, status, _cells = nurse_scheduling.schedule(yaml_text.encode("utf-8"))
    return df, status


def test_control_without_skill_mix_rns_avoid_nights():
    df, status = _solve(_ward())
    assert status == "OPTIMAL"
    assert all(len(_nights(df, d) & RNS) == 0 for d in range(7))


def test_at_least_two_rns_among_four_night_staff_and_others_not_banned():
    df, status = _solve(_ward(MIX_2_RN))
    assert status == "OPTIMAL"
    for d in range(7):
        night = _nights(df, d)
        assert len(night) == 4, "headcount stays exact"
        assert len(night & RNS) == 2, "the floor is met and, because RNs avoid nights, not exceeded"
        assert len(night - RNS) == 2, "non-RNs still work nights: nobody is banned"


def test_infeasible_when_only_one_rn_is_available():
    leave = """  - type: shift request
    person: [rn2, rn3]
    date: 2026-11-03
    shiftType: LEAVE
    weight: .inf"""
    df, status = _solve(_ward(MIX_2_RN, leave))
    assert df is None
    assert status == "INFEASIBLE"


def test_empty_group_is_infeasible_not_a_crash():
    df, status = _solve(_ward(MIX_2_RN, groups="[]"))
    assert df is None
    assert status == "INFEASIBLE"


def test_overlapping_groups_count_toward_both():
    # rn1 is both RN and Senior: "2 RN + 1 Senior" is met by rn1 + rn2 without a third person.
    mix = MIX_2_RN + """
      - people: Senior
        minNumPeople: 1"""
    df, status = _solve(_ward(mix))
    assert status == "OPTIMAL"
    for d in range(7):
        night = _nights(df, d)
        assert len(night & RNS) >= 2 and len(night & {"rn1", "en1"}) >= 1


def test_aggregate_group_needs_one_across_the_group_not_one_each():
    yaml_text = """
apiVersion: alpha
dates:
  range: {startDate: 2026-11-01, endDate: 2026-11-02}
people:
  items: [{id: s1}, {id: n1}, {id: n2}, {id: n3}]
  groups: [{id: Senior, members: [s1]}]
shiftTypes:
  items: [{id: am1}, {id: am2}]
  groups: [{id: AM, members: [am1, am2]}]
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: AM
    requiredNumPeople: 4
    skillMix: [{people: Senior, minNumPeople: 1}]
  - type: shift type requirement
    shiftType: am1
    requiredNumPeople: 2
"""
    # One senior covers both am1 and am2. A per-shift reading would need two and be infeasible.
    _df, status = _solve(yaml_text)
    assert status == "OPTIMAL"
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q tests/test_skill_mix.py`
Expected: `test_at_least_two_rns...` FAILS (RN count 0) and `test_infeasible...` FAILS (status OPTIMAL). The control passes.

- [ ] **Step 3: Implement the solver constraint**

In `shift_type_requirements`, directly after the `if preference.preferredNumPeople is not None: ... >= ... else: ... == ...` block (before the soft preferred block):

```python
            # Skill mix: at least k of the named people among this group's staff.
            # Nobody is banned; the headcount above still fixes the total, so the
            # rest of the places go to anyone eligible. A person in two entries'
            # groups counts toward both.
            #   sum_{s in ss, p in eligible(s) ∩ people} shifts[(d, s, p)] >= k
            for entry in preference.skillMix or []:
                mix_ps = set(utils.parse_pids(entry.people, ctx.map_pid_p))
                mix_n = sum(ctx.shifts[(d, s, p)] for s in ss for p in qualified_ps_by_s[s] if p in mix_ps)
                ctx.solver.add_constraint(mix_n >= entry.minNumPeople)
```

If `test_empty_group_is_infeasible_not_a_crash` raises inside OR-Tools (`mix_n` is a plain `0`, so the constraint is the Python bool `False`), replace the last line with:

```python
                if isinstance(mix_n, int):  # nobody eligible: the floor cannot be met
                    ctx.solver.add_bool_or([])  # an empty OR is always false -> INFEASIBLE
                else:
                    ctx.solver.add_constraint(mix_n >= entry.minNumPeople)
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q tests/test_skill_mix.py`
Expected: PASS.

- [ ] **Step 5: Write the failing workspace reference test** (append to `core/tests/test_server_scheduling_input.py`, after `test_workspace_unknown_person_reference_is_not_ready`)

```python
def test_workspace_unknown_skill_mix_person_is_not_ready():
    document = _workspace_with_preferences(
        """  - workspaceId: r1
    type: shift type requirement
    shiftType: day
    requiredNumPeople: 1
    skillMix:
      - people: ghost
        minNumPeople: 1"""
    )
    error = _content_error(document)
    assert error.error_code == "workspace_not_ready"
    assert (["preferences", 0, "skillMix"], "unresolved_workspace_reference") in [
        (issue.path, issue.code) for issue in error.issues
    ]
```

Run: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q tests/test_server_scheduling_input.py -k skill_mix`
Expected: FAIL (no issue is raised, or the solve fails later with `Unknown person ID`).

- [ ] **Step 6: Implement the reference check**

In `workspace.py` `_reference_issues`, right after the `_PEOPLE_REFERENCE_FIELDS` loop:

```python
        for entry in preference.get("skillMix") or []:
            leaf = entry.get("people") if isinstance(entry, dict) else None
            if leaf is not None and leaf not in people_ids:
                issues.append(_reference_issue(index, "skillMix", leaf, "person or people group"))
```

- [ ] **Step 7: Run the full core suite**

Run: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q && ruff check . && ruff format --check .`
Expected: PASS. Real ward testcases (twin idiom) are unchanged.

- [ ] **Step 8: Commit**

```bash
git add core/nurse_scheduling/preference_types.py core/nurse_scheduling/server/workspace.py core/tests/test_skill_mix.py core/tests/test_server_scheduling_input.py
git commit -m "feat(core): enforce skill mix as a floor that bans nobody"
```

---

### Task 3: Web scenario spine — types, import/export, persistence, cascade, anonymize

**Files:**
- Modify: `web/lib/scenario/types.ts` (`CanonicalShiftTypeRequirementPreference`, `RequirementCardBody`)
- Modify: `web/lib/scenario/canonical.ts:142-167`, `web/lib/scenario/schemas/import.ts:100-112`, `web/lib/scenario/schemas/producer.ts:130-142`, `web/lib/scenario/import-scenario.ts:297-309`, `web/lib/scenario/anonymize.ts:115-122`
- Modify: `web/lib/store/persistence.ts:460-482` (`validateRequirementCard`)
- Modify: `web/lib/cascade/rename.ts:28-43`, `web/lib/cascade/delete.ts:33-48`
- Test: `web/lib/scenario/canonical.test.ts`, `web/lib/scenario/import-scenario.test.ts`, `web/lib/scenario/anonymize.test.ts`, `web/lib/store/persistence.test.ts` (or the file that covers `validateRequirementCard`; find it with `grep -rln "cardsByKind.requirements element" web/lib/store`), `web/lib/cascade/cascade.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SkillMixEntry { people: PersonRef; minNumPeople: number }
  // on CanonicalShiftTypeRequirementPreference and RequirementCardBody:
  skillMix?: SkillMixEntry[];
  ```

- [ ] **Step 1: Write the failing round-trip and cascade tests**

`web/lib/scenario/import-scenario.test.ts` (add next to the requirement round-trip tests, using that file's helpers):

```ts
it("round-trips a requirement's skill mix through export and import", () => {
  const card: RequirementCard = {
    uid: "night",
    description: "Night: 4, at least 2 RN",
    shiftType: ["N"],
    requiredNumPeople: 4,
    qualifiedPeople: ["ALL"],
    skillMix: [
      { people: "RN", minNumPeople: 2 },
      { people: "Senior", minNumPeople: 1 },
    ],
    date: ["ALL"],
    weight: -1,
  };
  const state = ward({
    staff: people("rn1", "en1"),
    staffGroups: [
      { id: "RN", members: ["rn1"] },
      { id: "Senior", members: ["rn1"] },
    ],
    cardsByKind: cards({ requirements: [card] }),
  });
  const yaml = serializeScenario(state);
  expect(yaml).toContain("skillMix:");
  const back = importScenario(yaml); // the file's existing import entry point
  expect(back.cardsByKind.requirements[0].skillMix).toEqual(card.skillMix);
});

it("omits an empty skill mix on export", () => {
  const state = ward({
    staff: people("a"),
    cardsByKind: cards({ requirements: [requirement("d", "D", 1, { skillMix: [] })] }),
  });
  expect(serializeScenario(state)).not.toContain("skillMix");
});
```

`web/lib/cascade/cascade.test.ts`:

```ts
describe("skill mix follows its group", () => {
  const base = () =>
    ward({
      staff: people("rn1", "en1"),
      staffGroups: [{ id: "RN", members: ["rn1"] }],
      cardsByKind: cards({
        requirements: [
          requirement("night", "N", 2, { skillMix: [{ people: "RN", minNumPeople: 1 }] }),
        ],
      }),
    });

  it("renaming the group rewrites the entry", () => {
    const next = renameEntity(base(), "person", "RN", "RegisteredNurse");
    expect(next.cardsByKind.requirements[0].skillMix).toEqual([
      { people: "RegisteredNurse", minNumPeople: 1 },
    ]);
  });

  it("deleting the group prunes the entry and keeps the headcount", () => {
    const next = deleteEntity(base(), "person", "RN");
    const card = next.cardsByKind.requirements[0];
    expect(card.requiredNumPeople).toBe(2);
    expect(card.skillMix).toBeUndefined();
  });
});
```

Also add a persistence sanitizer case to the test file that covers `validateRequirementCard`: a persisted requirement with `skillMix: [{ people: "RN", minNumPeople: "2" }]` is refused with a message containing `cardsByKind.requirements element skillMix`, and a valid one passes. Add an anonymize case: `skillMix[0].people` gets the same pseudonym as the group elsewhere in the document.

(`ward`, `cards`, `people` and `requirement` come from `@/lib/rules/ward-fixtures.test-support`. Check the entity-domain string cascade uses for staff groups in `web/lib/cascade/domain.ts`. `"person"` covers people and groups.)

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && pnpm vitest run lib/scenario/import-scenario.test.ts lib/cascade/cascade.test.ts`
Expected: FAIL. There is a type error on `skillMix` and the field is dropped on import.

- [ ] **Step 3: Implement**

`types.ts`:

```ts
/** At least `minNumPeople` of `people` among a shift's staff. Bans nobody (unlike qualifiedPeople). */
export interface SkillMixEntry {
  people: PersonRef;
  minNumPeople: number;
}
```

Add `skillMix?: SkillMixEntry[];` after `preferredNumPeople?` in both `CanonicalShiftTypeRequirementPreference` and `RequirementCardBody`.

`canonical.ts`, in the requirement `compact({...})`: `skillMix: card.skillMix?.length ? card.skillMix : undefined,`

`schemas/import.ts`:

```ts
const zImportSkillMixEntry = z.strictObject({
  people: z.union([z.string(), z.number().int()]),
  minNumPeople: z.number().int(),
});
// in zImportRequirement:
  skillMix: z.array(zImportSkillMixEntry).nullish(),
```

`schemas/producer.ts`: the same entry schema, strict, with `skillMix: z.array(zSkillMixEntry).optional()` in `zRequirement`.

`import-scenario.ts` `normalizeRequirement`: `skillMix: (pref.skillMix as SkillMixEntry[] | null | undefined) ?? undefined,` (`clean` drops `undefined`). Keep an empty array out: `skillMix: Array.isArray(pref.skillMix) && pref.skillMix.length ? (pref.skillMix as SkillMixEntry[]) : undefined`.

`anonymize.ts`, next to `qualifiedPeople`:

```ts
if (Array.isArray(pref.skillMix))
  pref.skillMix = pref.skillMix.map((entry) => ({ ...entry, people: ref(entry.people) }));
```

(`ref` is the single-ref mapper that `refOrList` uses in that file. If it is not exported under that name, use the scalar branch of `refOrList`.)

`persistence.ts` `validateRequirementCard`:

```ts
if (el.skillMix !== undefined) {
  if (!Array.isArray(el.skillMix))
    throw new Error("cardsByKind.requirements element skillMix must be an array");
  for (const entry of el.skillMix) {
    validateRefOrArray(entry?.people, "cardsByKind.requirements element skillMix people");
    requireNumber(entry?.minNumPeople, "cardsByKind.requirements element skillMix minNumPeople");
  }
}
```

(Copy the file's own error style: use whatever helper `validateRefOrArray`/`requireNumber` throw through.)

`rename.ts`, inside the per-card transform after the `CARD_REF_FIELDS` loop:

```ts
if (kind === "requirements" && domain === "person" && Array.isArray(next.skillMix)) {
  next.skillMix = (next.skillMix as SkillMixEntry[]).map((entry) =>
    sameRef(entry.people, oldId) ? { ...entry, people: newId } : entry,
  );
}
```

`delete.ts`, same position:

```ts
if (kind === "requirements" && domain === "person" && Array.isArray(next.skillMix)) {
  const kept = (next.skillMix as SkillMixEntry[]).filter((entry) => !deleted.has(entry.people));
  if (kept.length) next.skillMix = kept;
  else delete next.skillMix;
}
```

`web/lib/scenario/differential/oracle.py` feeds documents to the vendored core models, so it validates `skillMix` already. Run `pnpm test:differential` to confirm, and change the file only if it copies requirement fields one by one.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd web && pnpm vitest run lib/scenario lib/cascade lib/store && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/scenario web/lib/store/persistence.ts web/lib/cascade
git commit -m "feat(web): carry requirement skillMix through import, export, persistence and cascade"
```

---

### Task 4: Requirements model — form state, validation, build/load, shared floor helper, Guided quick edit

**Files:**
- Modify: `web/components/requirements/requirements-model.ts` (`REQUIREMENT_MESSAGES`, `RequirementFormState`, `emptyRequirementForm`, `RequirementErrors`, `validateRequirementForm`, `buildRequirementCard`, `requirementToForm`)
- Modify: `web/components/guided-rules/mappers.ts:55-93` (`requirementsMapper`)
- Test: `web/components/requirements/requirements-model.test.ts`, `web/components/guided-rules/*.test.ts` (the file that covers `applyRequirementQuickEdit`; find it with `grep -rln applyRequirementQuickEdit web/components`)

**Interfaces:**
- Consumes: `SkillMixEntry` (Task 3).
- Produces:
  ```ts
  export interface SkillMixDraft { people: PersonRef | ""; minNumPeople: RequirementNumberValue }
  // RequirementFormState.skillMix: SkillMixDraft[]
  // RequirementErrors.skillMix?: string
  export function skillMixFloor(card: Pick<RequirementCardBody, "skillMix">): number; // max minNumPeople, 0 when none
  ```

- [ ] **Step 1: Write the failing tests** (`requirements-model.test.ts`)

```ts
describe("skill mix", () => {
  const domain = buildRequirementShiftTypeDomain(ward({ staff: people("a") }));
  const form = (patch: Partial<RequirementFormState>): RequirementFormState => ({
    ...emptyRequirementForm(),
    shiftType: ["N"],
    requiredNumPeople: 4,
    qualifiedPeople: ["ALL"],
    date: ["ALL"],
    ...patch,
  });

  it.each([
    [[{ people: "", minNumPeople: 1 }], REQUIREMENT_MESSAGES.skillMixPeopleEmpty],
    [[{ people: "RN", minNumPeople: 0 }], REQUIREMENT_MESSAGES.skillMixMinInvalid],
    [[{ people: "RN", minNumPeople: "" }], REQUIREMENT_MESSAGES.skillMixMinInvalid],
    [[{ people: "RN", minNumPeople: 5 }], REQUIREMENT_MESSAGES.skillMixAboveRequired],
    [
      [
        { people: "RN", minNumPeople: 1 },
        { people: "RN", minNumPeople: 2 },
      ],
      REQUIREMENT_MESSAGES.skillMixDuplicate,
    ],
  ])("rejects %j", (skillMix, message) => {
    expect(validateRequirementForm(form({ skillMix }), domain).skillMix).toBe(message);
  });

  it("needs the shift open to everyone", () => {
    const errors = validateRequirementForm(
      form({ qualifiedPeople: ["RN"], skillMix: [{ people: "RN", minNumPeople: 1 }] }),
      domain,
    );
    expect(errors.skillMix).toBe(REQUIREMENT_MESSAGES.skillMixNeedsEveryone);
  });

  it("lowering the headcount below the skill mix is refused on the skill mix row", () => {
    const errors = validateRequirementForm(
      form({ requiredNumPeople: 1, skillMix: [{ people: "RN", minNumPeople: 2 }] }),
      domain,
    );
    expect(errors.skillMix).toBe(REQUIREMENT_MESSAGES.skillMixAboveRequired);
  });

  it("builds the card with the skill mix and loads it back unchanged", () => {
    const card = buildRequirementCard(
      form({ skillMix: [{ people: "RN", minNumPeople: 2 }] }),
      domain,
      "u1",
    );
    expect(card.skillMix).toEqual([{ people: "RN", minNumPeople: 2 }]);
    expect(requirementToForm(card, domain).skillMix).toEqual([{ people: "RN", minNumPeople: 2 }]);
  });

  it("an empty skill mix is not written to the card", () => {
    expect(buildRequirementCard(form({ skillMix: [] }), domain, "u1")).not.toHaveProperty(
      "skillMix",
    );
  });

  it("skillMixFloor is the largest minimum", () => {
    expect(skillMixFloor({})).toBe(0);
    expect(
      skillMixFloor({
        skillMix: [
          { people: "RN", minNumPeople: 2 },
          { people: "S", minNumPeople: 1 },
        ],
      }),
    ).toBe(2);
  });
});
```

Guided quick-edit test:

```ts
it("quick edit refuses a head count below the skill mix", () => {
  const card = requirement("night", "N", 4, { skillMix: [{ people: "RN", minNumPeople: 2 }] });
  expect(applyRequirementQuickEdit([card], "night", "requiredNumPeople", 1)).toEqual({
    kind: "invalid-value",
    message: REQUIREMENT_MESSAGES.skillMixAboveRequired,
  });
  expect(applyRequirementQuickEdit([card], "night", "requiredNumPeople", 2).kind).toBe("applied");
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && pnpm vitest run components/requirements components/guided-rules`
Expected: FAIL (`skillMix` is not in the form, messages are missing).

- [ ] **Step 3: Implement**

`REQUIREMENT_MESSAGES` gets:

```ts
  skillMixPeopleEmpty: "Choose a staff group or person for each skill mix row",
  skillMixMinInvalid: "Each skill mix number must be a whole number of at least 1",
  skillMixAboveRequired: "A skill mix cannot ask for more people than the required number",
  skillMixDuplicate: "Each group or person can appear in the skill mix only once",
  skillMixNeedsEveryone:
    "A skill mix needs the shift open to everyone. Set Qualified people to Everyone first",
  skillMixCoefficients:
    "A skill mix counts people, so it cannot be combined with staffing multipliers",
```

The form state gets `skillMix: SkillMixDraft[]`. `emptyRequirementForm` returns `skillMix: []`. `RequirementErrors` gets `skillMix?: string`.

In `validateRequirementForm`, before the weight check:

```ts
const skillMixError = validateSkillMix(form);
if (skillMixError) errors.skillMix = skillMixError;
```

```ts
const isAllRef = (ref: PersonRef) => String(ref).toUpperCase() === RESERVED_SHIFT_TYPE.all;

function validateSkillMix(form: RequirementFormState): string | undefined {
  if (form.skillMix.length === 0) return undefined;
  if (!form.qualifiedPeople.every(isAllRef)) return REQUIREMENT_MESSAGES.skillMixNeedsEveryone;
  if (form.shiftTypeCoefficients.length > 0) return REQUIREMENT_MESSAGES.skillMixCoefficients;
  const seen = new Set<string>();
  for (const entry of form.skillMix) {
    if (entry.people === "") return REQUIREMENT_MESSAGES.skillMixPeopleEmpty;
    const n = entry.minNumPeople;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1)
      return REQUIREMENT_MESSAGES.skillMixMinInvalid;
    if (typeof form.requiredNumPeople === "number" && n > form.requiredNumPeople)
      return REQUIREMENT_MESSAGES.skillMixAboveRequired;
    const key = String(entry.people);
    if (seen.has(key)) return REQUIREMENT_MESSAGES.skillMixDuplicate;
    seen.add(key);
  }
  return undefined;
}

/** The lowest head count this card's skill mix allows: its largest minimum. */
export function skillMixFloor(card: Pick<RequirementCardBody, "skillMix">): number {
  return Math.max(0, ...(card.skillMix ?? []).map((entry) => entry.minNumPeople));
}
```

`buildRequirementCard`: after the coefficient line, add
`if (form.skillMix.length > 0) body.skillMix = form.skillMix.map((e) => ({ people: e.people as PersonRef, minNumPeople: e.minNumPeople as number }));`

`requirementToForm`: `skillMix: (card.skillMix ?? []).map((e) => ({ ...e })),`

`mappers.ts`, in `requirementsMapper.quickFields` `validate`:

```ts
validate: (value) =>
  !(Number.isFinite(value) && value >= 0)
    ? REQUIREMENT_MESSAGES.requiredMin
    : value < skillMixFloor(card)
      ? REQUIREMENT_MESSAGES.skillMixAboveRequired
      : undefined,
```

`summary(card)` appends the mix: ``const mix = card.skillMix?.length ? `, at least ${card.skillMix.map((e) => `${e.minNumPeople} ${e.people}`).join(", ")}` : "";`` and returns `` `Needs ${people}${mix} for ${shiftLabel} on ${dateLabel}.` ``.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd web && pnpm vitest run components/requirements components/guided-rules lib/proposal/operations.parity.test.ts && pnpm typecheck`
Expected: PASS. The parity suite still passes, because both sides now share the floor.

- [ ] **Step 5: Commit**

```bash
git add web/components/requirements/requirements-model.ts web/components/requirements/requirements-model.test.ts web/components/guided-rules
git commit -m "feat(web): skill mix in the requirement form model and Guided quick edit"
```

---

### Task 5: Requirements UI — Skill mix rows, help text, card summary, Shifts page chip

**Files:**
- Modify: `web/components/requirements/requirement-form.tsx` (a new `FieldShell` after "Qualified people", about line 342)
- Modify: `web/components/requirements/requirement-card-list.tsx:~114` (summary)
- Modify: `web/components/shift-types/save-shift-card.ts:136-138` (error chain), `:222-224` (chips)
- Test: `web/components/requirements/requirement-form.skill-mix.test.tsx` (create), `web/components/shift-types/save-shift-card.test.ts`, `web/e2e/requirements.spec.ts`

**Interfaces:**
- Consumes: `SkillMixDraft`, `REQUIREMENT_MESSAGES.skillMix*`, `buildQualifiedPeopleTransferOptions` (Task 4 and existing code).

- [ ] **Step 1: Write the failing component test**

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequirementForm } from "./requirement-form";
import { emptyRequirementForm, REQUIREMENT_MESSAGES } from "./requirements-model";
import { people, ward } from "@/lib/rules/ward-fixtures.test-support";

afterEach(cleanup);

const state = ward({
  staff: people("rn1", "rn2", "en1"),
  staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
});
const initial = {
  ...emptyRequirementForm(),
  shiftType: ["N"],
  requiredNumPeople: 4,
  qualifiedPeople: ["ALL"],
  date: ["ALL"],
};

describe("Skill mix rows", () => {
  it("adds 'at least 2 from RN' and saves it", async () => {
    const onSave = vi.fn();
    render(<RequirementForm state={state} mode="add" initialForm={initial} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Add skill mix" }));
    await userEvent.clear(screen.getByLabelText("Skill mix 1 minimum"));
    await userEvent.type(screen.getByLabelText("Skill mix 1 minimum"), "2");
    await userEvent.selectOptions(screen.getByLabelText("Skill mix 1 group"), "RN");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ skillMix: [{ people: "RN", minNumPeople: 2 }] }),
    );
  });

  it("shows the help text", () => {
    render(<RequirementForm state={state} mode="add" initialForm={initial} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(
      screen.getByText(
        "At least this many of the shift's nurses must come from the group. Anyone can fill the other places.",
      ),
    ).toBeInTheDocument();
  });

  it("is disabled while qualified people is not Everyone", () => {
    render(
      <RequirementForm
        state={state}
        mode="edit"
        initialForm={{ ...initial, qualifiedPeople: ["RN"] }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Add skill mix" })).toBeDisabled();
    expect(screen.getByText(REQUIREMENT_MESSAGES.skillMixNeedsEveryone + ".")).toBeInTheDocument();
  });

  it("removes a row", async () => {
    const onSave = vi.fn();
    render(
      <RequirementForm
        state={state}
        mode="edit"
        initialForm={{ ...initial, skillMix: [{ people: "RN", minNumPeople: 2 }] }}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove skill mix 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ skillMix: [] }));
  });

  it("shows the validation message when the minimum is above the required number", async () => {
    render(
      <RequirementForm
        state={state}
        mode="edit"
        initialForm={{ ...initial, skillMix: [{ people: "RN", minNumPeople: 5 }] }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(REQUIREMENT_MESSAGES.skillMixAboveRequired)).toBeInTheDocument();
  });
});
```

(Check the Save button's accessible name in `requirement-form.tsx` and the `FieldShell` error rendering before running. Adjust only the query, not the behaviour.)

Add to `save-shift-card.test.ts`: saving a shift whose staffing card has `skillMix: [{people:"RN", minNumPeople:2}]` with the staffing lowered to 1 returns the `skillMixAboveRequired` error. Saving the same card with staffing 3 keeps `skillMix` on the card. The staffing chips for that card include `"at least 2 RN"`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && pnpm vitest run components/requirements/requirement-form.skill-mix.test.tsx components/shift-types/save-shift-card.test.ts`
Expected: FAIL. There is no "Add skill mix" button.

- [ ] **Step 3: Implement the rows** (in `requirement-form.tsx`, after the Qualified people `FieldShell`)

```tsx
const SKILL_MIX_HELP =
  "At least this many of the shift's nurses must come from the group. Anyone can fill the other places.";
```

```tsx
const openToEveryone = form.qualifiedPeople.every(
  (ref) => String(ref).toUpperCase() === RESERVED_SHIFT_TYPE.all,
);
const mixOptions = [...people.groups, ...people.items].filter(
  (option) => String(option.id).toUpperCase() !== RESERVED_SHIFT_TYPE.all,
);
function setMix(next: SkillMixDraft[]) {
  setForm((prev) => ({ ...prev, skillMix: next }));
  setErrors((prev) => (prev.skillMix ? { ...prev, skillMix: undefined } : prev));
}
```

```tsx
<FieldShell label="Skill mix" error={errors.skillMix}>
  <p className="text-meta leading-[1.45] text-ink3">{SKILL_MIX_HELP}</p>
  {!openToEveryone && (
    <p className="text-meta italic text-ink3">{REQUIREMENT_MESSAGES.skillMixNeedsEveryone}.</p>
  )}
  {form.skillMix.map((entry, i) => (
    <div key={i} className="flex items-center gap-2">
      <Input
        type="number"
        min={1}
        aria-label={`Skill mix ${i + 1} minimum`}
        value={entry.minNumPeople}
        disabled={!openToEveryone}
        onChange={(e) =>
          setMix(form.skillMix.map((x, j) => (j === i ? { ...x, minNumPeople: parseRequirementInteger(e.target.value) } : x)))
        }
        onWheel={blurOnWheel}
        className="w-[88px] flex-none font-bold"
      />
      <span className="text-meta text-ink3">from</span>
      <select
        aria-label={`Skill mix ${i + 1} group`}
        value={entry.people === "" ? "" : String(entry.people)}
        disabled={!openToEveryone}
        onChange={(e) => {
          const picked = mixOptions.find((o) => String(o.id) === e.target.value);
          setMix(form.skillMix.map((x, j) => (j === i ? { ...x, people: picked ? picked.id : "" } : x)));
        }}
      >
        <option value="">Choose a group</option>
        {mixOptions.map((o) => (
          <option key={String(o.id)} value={String(o.id)}>{String(o.id)}</option>
        ))}
      </select>
      <Button
        type="button"
        variant="ghost"
        aria-label={`Remove skill mix ${i + 1}`}
        onClick={() => setMix(form.skillMix.filter((_, j) => j !== i))}
      >
        Remove
      </Button>
    </div>
  ))}
  <Button
    type="button"
    variant="outline"
    disabled={!openToEveryone}
    onClick={() => setMix([...form.skillMix, { people: "", minNumPeople: 1 }])}
  >
    Add skill mix
  </Button>
</FieldShell>
```

Use the `Input`/`Button`/select primitives the file already imports. If it uses a shared `Select` component, use that and keep the same `aria-label`s. `parseRequirementInteger` and `blurOnWheel` are already used by the Required field.

`requirement-card-list.tsx`: append `` ` · at least ${card.skillMix.map((e) => `${e.minNumPeople} ${e.people}`).join(", ")}` `` to the summary when `card.skillMix?.length`.

`save-shift-card.ts`: add `errors.skillMix ??` to the error `??` chain at 136-138. In the chip builder at ~222, after the qualified-people chips:
``for (const e of match.card.skillMix ?? []) chips.push(`at least ${e.minNumPeople} ${e.people}`);``

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd web && pnpm vitest run components/requirements components/shift-types && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: E2E** (`web/e2e/requirements.spec.ts`, new test in the same style as the file)

```ts
test("adds 'Night needs 4, at least 2 RN' and shows it on the card", async ({ page }) => {
  // seed: people rn1, rn2, en1, en2 and group RN via the file's existing seeding helper
  await page.getByRole("button", { name: /add requirement/i }).click();
  await page.getByLabel("N").check(); // the shift radio, as the file's other tests do
  await page.getByLabel("Required").fill("4");
  await page.getByRole("button", { name: "Add skill mix" }).click();
  await page.getByLabel("Skill mix 1 minimum").fill("2");
  await page.getByLabel("Skill mix 1 group").selectOption("RN");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("at least 2 RN")).toBeVisible();
});
```

Run: `cd web && pnpm test:e2e e2e/requirements.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/components/requirements web/components/shift-types web/e2e/requirements.spec.ts
git commit -m "feat(web): Skill mix rows on the staffing requirement form"
```

---

### Task 6: Preview wording

**Files:**
- Modify: `web/lib/proposal/diff.ts:202-222` (`describeRequirement`)
- Test: `web/lib/proposal/diff.test.ts`

**Interfaces:**
- Consumes: `RequirementCard.skillMix`.
- Produces: the suffix string from Global Constraints. Tasks 7 and 9 assert on it.

- [ ] **Step 1: Write the failing test**

```ts
describe("skill mix in the Preview", () => {
  const before = ward({
    staff: people("rn1", "en1"),
    staffGroups: [
      { id: "RN", members: ["rn1"] },
      { id: "Senior", members: ["rn1"] },
    ],
    cardsByKind: cards({ requirements: [requirement("night", "N", 4)] }),
  });
  const after = {
    ...before,
    cardsByKind: cards({
      requirements: [
        requirement("night", "N", 4, {
          skillMix: [
            { people: "RN", minNumPeople: 2 },
            { people: "Senior", minNumPeople: 1 },
          ],
        }),
      ],
    }),
  };

  it("shows the skill mix as a before/after change on the card", () => {
    const entries = diffScenarioDocuments(before, after);
    const entry = entries.find((e) => e.key === "rule:requirements:night");
    expect(entry?.kind).toBe("changed");
    expect(entry?.before).not.toContain("at least");
    expect(entry?.after).toContain(
      "; at least 2 from “RN”, 1 from “Senior” — anyone can fill the other places",
    );
  });
});
```

(Use the `Entry` fields that `diffScenarioDocuments` really returns. The existing requirement diff tests in `diff.test.ts` show the key format and the before/after fields.)

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && pnpm vitest run lib/proposal/diff.test.ts -t "skill mix"`
Expected: FAIL. The before and after text are identical, so there is no entry.

- [ ] **Step 3: Implement** (at the end of `describeRequirement`, before the return, appended to the returned string)

```ts
const mix = card.skillMix?.length
  ? `; at least ${card.skillMix.map((e) => `${e.minNumPeople} from “${e.people}”`).join(", ")} — anyone can fill the other places`
  : "";
```

Update the docblock above `describeRequirement`: "A skill mix adds floors for named groups among those people and bans nobody."

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd web && pnpm vitest run lib/proposal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/proposal/diff.ts web/lib/proposal/diff.test.ts
git commit -m "feat(web): Preview states a requirement's skill mix"
```

---

### Task 7: Assistant arms — `set_skill_mix`, `add_staffing_requirement.skillMix`, head count floor

**Files:**
- Modify: `web/lib/proposal/commands.ts` (union ~200-226, `ASSISTANT_COMMAND_TYPES` list 263-285, zod arms ~640-652, `requirementFields()`)
- Modify: `web/lib/proposal/operations.ts` (`requirementDraft` ~600, new `applySetSkillMix`, `applySetRequirementPeople` ~1190, dispatch ~1420)
- Modify: `web/lib/proposal/diff.ts:750-808` (`directKeys`: `set_skill_mix` names `rule:requirements:${ruleId}`)
- Test: `web/lib/proposal/operations.test.ts`, `web/lib/proposal/operations.parity.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`

**Interfaces:**
- Consumes: `requirementToForm`, `validateRequirementForm`, `skillMixFloor` (Task 4), `applyRequirementPatch`.
- Produces:
  ```ts
  | { type: "set_skill_mix"; ruleId: string; skillMix: { people: PersonRef; minNumPeople: number }[] }
  // add_staffing_requirement gains: skillMix?: { people: PersonRef; minNumPeople: number }[]
  ```

- [ ] **Step 1: Write the failing tests**

`operations.test.ts`:

```ts
describe("set_skill_mix", () => {
  const state = () =>
    ward({
      staff: people("rn1", "rn2", "en1", "en2"),
      staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
      cardsByKind: cards({ requirements: [requirement("night", "N", 4)] }),
    });

  it("sets 'at least 2 from RN' on the night requirement", () => {
    const result = applyAssistantCommand(
      state(),
      { type: "set_skill_mix", ruleId: "night", skillMix: [{ people: "RN", minNumPeople: 2 }] },
      0,
    );
    expect(result.ok && result.next.cardsByKind.requirements[0].skillMix).toEqual([
      { people: "RN", minNumPeople: 2 },
    ]);
  });

  it.each([
    [{ ruleId: "gone", skillMix: [{ people: "RN", minNumPeople: 1 }] }, "unknown_target"],
    [{ ruleId: "night", skillMix: [{ people: "Nobody", minNumPeople: 1 }] }, "unknown_target"],
    [{ ruleId: "night", skillMix: [{ people: "RN", minNumPeople: 5 }] }, "invalid_value"],
    [{ ruleId: "night", skillMix: [] }, "no_effect"],
  ])("refuses %j with %s", (fields, code) => {
    const result = applyAssistantCommand(state(), { type: "set_skill_mix", ...fields }, 0);
    expect(!result.ok && result.rejection.code).toBe(code);
  });

  it("edit_staffing_requirement keeps the stored skill mix", () => {
    const seeded = applyAssistantCommand(
      state(),
      { type: "set_skill_mix", ruleId: "night", skillMix: [{ people: "RN", minNumPeople: 2 }] },
      0,
    );
    if (!seeded.ok) throw new Error(seeded.rejection.message);
    const edited = applyAssistantCommand(
      seeded.next,
      {
        type: "edit_staffing_requirement",
        ruleId: "night",
        description: "Night",
        shiftType: "N",
        qualifiedPeople: ["ALL"],
        dates: ["ALL"],
        requiredNumPeople: 3,
      },
      0,
    );
    expect(edited.ok && edited.next.cardsByKind.requirements[0].skillMix).toEqual([
      { people: "RN", minNumPeople: 2 },
    ]);
  });

  it("set_staffing_requirement_people refuses a count below the skill mix", () => {
    const s = state();
    s.cardsByKind.requirements[0].skillMix = [{ people: "RN", minNumPeople: 2 }];
    const result = applyAssistantCommand(
      s,
      { type: "set_staffing_requirement_people", ruleId: "night", requiredNumPeople: 1 },
      0,
    );
    expect(!result.ok && result.rejection.message).toContain(
      REQUIREMENT_MESSAGES.skillMixAboveRequired,
    );
  });

  it("add_staffing_requirement can carry a skill mix", () => {
    const result = applyAssistantCommand(
      state(),
      {
        type: "add_staffing_requirement",
        description: "Day: 3, at least 1 RN",
        shiftType: "D",
        qualifiedPeople: ["ALL"],
        dates: ["ALL"],
        requiredNumPeople: 3,
        skillMix: [{ people: "RN", minNumPeople: 1 }],
      },
      0,
    );
    expect(result.ok && result.next.cardsByKind.requirements.at(-1)?.skillMix).toEqual([
      { people: "RN", minNumPeople: 1 },
    ]);
  });
});
```

`operations.parity.test.ts` (a new `describe`, reusing the file's `ruleWardScenario` or a local `ward`):

```ts
describe("set_skill_mix is the Staffing requirements Edit form's skill mix rows", () => {
  it.each([
    [[{ people: "RN", minNumPeople: 2 }]],
    [[{ people: "RN", minNumPeople: 9 }]], // above the head count: both refuse
    [[{ people: "RN", minNumPeople: 1 }, { people: "RN", minNumPeople: 2 }]], // duplicate: both refuse
  ])("assistant and form agree on %j", (skillMix) => {
    const state = ward({
      staff: people("rn1", "en1"),
      staffGroups: [{ id: "RN", members: ["rn1"] }],
      cardsByKind: cards({ requirements: [requirement("night", "N", 4)] }),
    });
    const domain = buildRequirementShiftTypeDomain(state);
    const draft = { ...requirementToForm(state.cardsByKind.requirements[0], domain), skillMix };
    const formErrors = validateRequirementForm(draft, domain);
    const manual =
      Object.keys(formErrors).length === 0
        ? applyRequirementPatch(state, { type: "update", uid: "night", form: draft })
        : null;
    const assistant = applyAssistantCommand(state, { type: "set_skill_mix", ruleId: "night", skillMix }, 0);
    expect(assistant.ok).toBe(manual !== null);
    if (assistant.ok && manual) expect(assistant.next.cardsByKind).toEqual(manual.cardsByKind);
  });

  it("the Guided quick edit and set_staffing_requirement_people agree below the skill mix", () => {
    const card = requirement("night", "N", 4, { skillMix: [{ people: "RN", minNumPeople: 2 }] });
    const manual = applyRequirementQuickEdit([card], "night", "requiredNumPeople", 1);
    const assistant = applyAssistantCommand(
      ward({ cardsByKind: cards({ requirements: [card] }) }),
      { type: "set_staffing_requirement_people", ruleId: "night", requiredNumPeople: 1 },
      0,
    );
    expect(manual.kind).toBe("invalid-value");
    expect(assistant.ok).toBe(false);
  });
});
```

`model-visible-tools.test.ts`, in `representative`:

```ts
set_skill_mix: {
  type: "set_skill_mix",
  ruleId: "r1",
  skillMix: [{ people: "RN", minNumPeople: 2 }],
},
```

**Deliberate test changes:** in the same file, change the `add_staffing_requirement` and `edit_staffing_requirement` representatives from the misleading "Two RNs on every night shift" with `qualifiedPeople: ["RN"]` to `description: "Night needs 4, at least 2 RNs"`, `qualifiedPeople: ["ALL"]`, `requiredNumPeople: 4`, and add `skillMix: [{ people: "RN", minNumPeople: 2 }]` to the add arm. Reason for the commit body: the old example taught the model the banning idiom.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/runtime/model-visible-tools.test.ts`
Expected: FAIL (unknown arm, type errors).

- [ ] **Step 3: Implement**

`commands.ts`: add the union arm with a doc comment:

```ts
  /**
   * Replace one staffing requirement's skill mix -- that screen's Edit form "Skill mix"
   * rows. Each entry: at least `minNumPeople` of `people` among the shift's staff. It
   * bans nobody (unlike qualifiedPeople). An empty list clears it.
   */
  | {
      type: "set_skill_mix";
      ruleId: string;
      skillMix: { people: PersonRef; minNumPeople: number }[];
    }
```

Add `skillMix?: { people: PersonRef; minNumPeople: number }[];` to the `add_staffing_requirement` arm. Add `"set_skill_mix"` to `ASSISTANT_COMMAND_TYPES` after `"edit_staffing_requirement"`. Zod:

```ts
const skillMixSchema = () =>
  z
    .array(
      z.strictObject({
        people: refSchema.describe("One staff group id (or one person id), for example \"RN\"."),
        minNumPeople: z.number().int().min(1).describe("At least this many of them on the shift."),
      }),
    )
    .describe(
      "Skill mix: floors for named groups AMONG the shift's staff. Bans nobody. " +
        "\"At least 2 RNs among the 4 on nights\" = requiredNumPeople 4 + skillMix [{people:\"RN\",minNumPeople:2}]. " +
        "Never use qualifiedPeople for this: qualifiedPeople bans everyone else.",
    );
```

```ts
  z.strictObject({
    type: z.enum(["set_skill_mix"]),
    ruleId: ruleIdSchema(),
    skillMix: skillMixSchema(),
  }),
```

and in the `add_staffing_requirement` zod arm: `skillMix: skillMixSchema().optional(),`. Only the add arm gets it: `requirementFields()` is shared with the edit arm, so spread it and add the field separately.

`operations.ts`:

```ts
function applySetSkillMix(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "set_skill_mix" }>,
  index: number,
): OperationResult {
  const source = state.cardsByKind.requirements.find((card) => card.uid === command.ruleId);
  if (!source) {
    return reject(index, "unknown_target", "That staffing requirement is not in this schedule any more.");
  }
  const name = ruleName("requirements", source.description?.trim() || source.uid);
  const people = buildQualifiedPeopleTransferOptions(state);
  const unknown = firstUnoffered(
    command.skillMix.map((e) => e.people),
    [...people.items, ...people.groups],
  );
  if (unknown !== undefined) {
    return reject(index, "unknown_target", `${name}: there is no person or staff group "${unknown}".`);
  }
  const domain = buildRequirementShiftTypeDomain(state);
  const draft = { ...requirementToForm(source, domain), skillMix: command.skillMix.map((e) => ({ ...e })) };
  const error = firstFormError(validateRequirementForm(draft, domain));
  if (error) return reject(index, "invalid_value", `${name}: ${error}.`);
  const next = applyRequirementPatch(state, { type: "update", uid: source.uid, form: draft });
  const after = next.cardsByKind.requirements.find((card) => card.uid === source.uid);
  if (stableStringify(after) === stableStringify(source)) {
    return reject(index, "no_effect", `${name} already has that skill mix.`);
  }
  return { ok: true, next };
}
```

Add `case "set_skill_mix": return applySetSkillMix(state, command, index);` to the dispatch. In `requirementDraft`, carry the add arm's mix: `skillMix: "skillMix" in fields && fields.skillMix ? fields.skillMix.map((e) => ({ ...e })) : base.skillMix,` (the edit arm has no `skillMix`, so `base`, loaded from the card, keeps it). `requirementRejection` also checks the add arm's `skillMix[].people` with `firstUnoffered`. In `applySetRequirementPeople`, after the finite/non-negative check:

```ts
if (command.requiredNumPeople < skillMixFloor(card)) {
  return reject(index, "invalid_value", `${REQUIREMENT_MESSAGES.skillMixAboveRequired}.`);
}
```

`diff.ts` `directKeys`: `case "set_skill_mix": keys.add(`rule:requirements:${command.ruleId}`); break;`

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd web && pnpm vitest run lib/proposal lib/ai && pnpm typecheck && pnpm lint`
Expected: PASS. The exhaustive `ASSISTANT_COMMAND_TYPES` `satisfies` compiles.

- [ ] **Step 5: Commit**

```bash
git add web/lib/proposal web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): set_skill_mix and skill mix on add_staffing_requirement"
```

---

### Task 8: Static check — skill-mix gaps in `findStaffingShortfalls`

**Files:**
- Modify: `web/lib/rules/shortfalls.ts` (`Equation` +`mix`, `StaffingFinding` +`mixPeople`, `buildEquations`, the `requirement_short` push)
- Test: `web/lib/rules/shortfalls.test.ts`

**Interfaces:**
- Produces: `StaffingFinding.mixPeople: string | null`. It is the entry's `people` ref when the finding comes from a skill-mix equation, else `null`. It is always set, so existing `toEqual` fixtures need `mixPeople: null` (see "Deliberate test changes").

- [ ] **Step 1: Write the failing tests**

```ts
describe("skill-mix gaps", () => {
  const rnWard = (patch: Partial<ScenarioUiState> = {}) =>
    ward({
      staff: people("rn1", "rn2", "en1", "en2", "en3"),
      staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 2, { skillMix: [{ people: "RN", minNumPeople: 2 }] }),
        ],
      }),
      ...patch,
    });

  it("an RN on leave leaves the night one RN short, flagged as skill mix", () => {
    const findings = findStaffingShortfalls(rnWard({ reqData: [leave("rn2", "03")] }));
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "requirement_short",
        dateId: "03",
        ruleIds: ["night"],
        required: 2,
        available: 1,
        skillMix: true,
        mixPeople: "RN",
        away: [{ person: "rn2", reason: "leave" }],
      }),
    ]);
  });

  it("a skill mix does not ban anyone: non-RNs still count toward the head count", () => {
    expect(findStaffingShortfalls(rnWard())).toEqual([]);
  });

  it("empty group is a skill-mix gap on every night", () => {
    const findings = findStaffingShortfalls(rnWard({ staffGroups: [{ id: "RN", members: [] }] }));
    expect(findings.filter((f) => f.mixPeople === "RN")).toHaveLength(7);
  });
});
```

(`leave` and the fixtures come from `ward-fixtures.test-support.ts`. The date id for 2026-11-03 is `"03"`, as `onlyRnOnLeave` uses.)

**Deliberate test changes:** existing `toEqual` finding literals in `shortfalls.test.ts`, `repair-options.test.ts` and `setup-progress.test.ts` gain `mixPeople: null`. The reason: the finding shape grew.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && pnpm vitest run lib/rules/shortfalls.test.ts`
Expected: FAIL. No finding is produced (the skill mix is ignored).

- [ ] **Step 3: Implement**

`Equation`: add `/** The skill-mix entry this equation checks, or null for a card's own head count. */ mix: string | null;`. `StaffingFinding`: add `/** The group or person of the short skill-mix entry; null when no skill-mix entry is short. */ mixPeople: string | null;`.

In `buildEquations`, inside the selector loop, push `mix: null` on the existing equation, then:

```ts
      // Skill mix: a floor for a group AMONG this equation's staff. It bans nobody,
      // so it restricts nothing and has no ceiling of its own.
      for (const entry of card.skillMix ?? []) {
        out.push({
          ruleId: card.uid,
          shiftTypes,
          qualified: new Set([...peopleOf([entry.people])].filter((p) => qualified.has(p))),
          dateIds,
          required: entry.minNumPeople,
          max: Number.POSITIVE_INFINITY,
          restricts: false,
          counted: true,
          mix: String(entry.people),
        });
      }
```

In every `findings.push`, set `mixPeople`: `requirement_short` gets `mixPeople: eq.mix`. `day_short`, `requirement_conflict` and `cap_short` get `chosen.find((e) => e.mix)?.mix ?? null`, `inner.find((e) => e.mix)?.mix ?? null` and `eq.mix` respectively. `skillMix` becomes `eq.restricts || eq.mix !== null || a.banRules.size > 0` in `requirement_short`, and the same `|| … mix !== null` in the others.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd web && pnpm vitest run lib/rules lib/ai/assistant && pnpm typecheck`
Expected: PASS once the deliberate literal updates are done.

- [ ] **Step 5: Commit**

```bash
git add web/lib/rules web/lib/ai/assistant/*.test.ts
git commit -m "feat(rules): static check reports skill-mix gaps"
```

---

### Task 9: Repair hooks, safety floor, playbook, help text, scripted repair ward

**Files:**
- Modify: `web/lib/ai/assistant/repair-options.ts` (`skillGroup` ~463, `skillMixOn` ~875, `run_one_short` builder ~646, `violatesSafetyFloor` ~765-850, `isSafeOption` untouched)
- Modify: `web/lib/ai/assistant/playbook.ts` (header rulings 17-21, `rules` step `proposeWith` ~102, `PLAYBOOK_VERSION`)
- Modify: `web/lib/capability/help-content.ts:127-131` and regenerate `web/lib/capability/registry.generated.ts`
- Modify: `web/lib/rules/ward-fixtures.test-support.ts` (`SCENARIOS.rnMixOnLeave`)
- Modify: `web/lib/ai/assistant/repair-eval.test.ts` (`INFEASIBLE`, `EXPECTED`)
- Create (generated): `core/tests/fixtures/assistant_repair/rnMixOnLeave.before.yaml`, `.after.yaml`
- Modify: `core/tests/test_assistant_repair_fixtures.py:27-35` (case list)
- Test: `web/lib/ai/assistant/repair-options.test.ts`, `web/lib/ai/assistant/playbook.test.ts`

**Interfaces:**
- Consumes: `StaffingFinding.mixPeople` (Task 8), `skillMixFloor` (Task 4), the `set_skill_mix` arm (Task 7).

- [ ] **Step 1: Add the scripted ward** (`ward-fixtures.test-support.ts`, in `SCENARIOS`)

```ts
  /** Nights need 2, at least 2 of them RNs; one of the two RNs is on leave on the 3rd. */
  rnMixOnLeave: (): ScenarioUiState =>
    ward({
      staff: people("rn1", "rn2", "en1", "en2", "en3"),
      staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
      reqData: [leave("rn2", "03")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 2, {
            description: "Night: 2, both RNs",
            skillMix: [{ people: "RN", minNumPeople: 2 }],
          }),
        ],
      }),
    }),
```

- [ ] **Step 2: Write the failing repair and floor tests** (`repair-options.test.ts`)

```ts
describe("skill-mix repairs (bead nursing-sheduler-2ti)", () => {
  const state = () => SCENARIOS.rnMixOnLeave();
  const ranked = () => rankRepairOptions(state(), findStaffingShortfalls(state()), { runInfeasible: true });

  it("borrows a nurse into the skill-mix group, then asks the RN on leave", () => {
    const options = ranked();
    expect(options.map((o) => o.repairId)).toEqual(["borrow_temporary_nurse", "ask_nurse_on_leave"]);
    expect(options[0].operations[0]).toMatchObject({ type: "add_person", groups: ["RN"] });
    expect(options[0].needsFromUser.join(" ")).toMatch(/qualif/i);
  });

  it("never offers run_one_short for a skill-mix gap", () => {
    expect(ranked().some((o) => o.repairId === "run_one_short")).toBe(false);
  });

  it.each([
    ["remove the entry", { type: "set_skill_mix", ruleId: "night", skillMix: [] }],
    ["lower the minimum", { type: "set_skill_mix", ruleId: "night", skillMix: [{ people: "RN", minNumPeople: 1 }] }],
    ["change its group", { type: "set_skill_mix", ruleId: "night", skillMix: [{ people: "en1", minNumPeople: 2 }] }],
    ["delete the group it names", { type: "remove_people_group", groupId: "RN" }],
    ["drop the head count below it", { type: "set_staffing_requirement_people", ruleId: "night", requiredNumPeople: 1 }],
    ["turn the card off", { type: "set_rule_enabled", ruleKind: "requirements", ruleId: "night", enabled: false }],
  ] as const)("the safety floor forbids: %s", (_label, op) => {
    expect(violatesSafetyFloor(state(), [op as AssistantCommandV1], { leaveAsked: false })).not.toBeNull();
  });

  it.each([
    ["raise the minimum", { type: "set_skill_mix", ruleId: "night", skillMix: [{ people: "RN", minNumPeople: 2 }, { people: "en1", minNumPeople: 1 }] }],
    ["add a skill mix to another card", { type: "set_skill_mix", ruleId: "day", skillMix: [{ people: "RN", minNumPeople: 1 }] }],
  ] as const)("the safety floor allows: %s", (_label, op) => {
    expect(violatesSafetyFloor(state(), [op as AssistantCommandV1], { leaveAsked: false })).toBeNull();
  });

  it("set_skill_mix is never part of a repair", () => {
    const option = { ...ranked()[0], operations: [{ type: "set_skill_mix", ruleId: "day", skillMix: [{ people: "RN", minNumPeople: 1 }] }] };
    expect(isSafeOption(state(), option as RepairOption)).toBe(false);
  });

  it("a head count keeps its own skill mix as its floor", () => {
    // the run_one_short guard: requiredNumPeople - 1 must stay >= skillMixOn
    const s = ward({
      staff: people("rn1", "en1", "en2"),
      staffGroups: [{ id: "RN", members: ["rn1"] }],
      cardsByKind: cards({
        requirements: [requirement("night", "N", 3, { skillMix: [{ people: "RN", minNumPeople: 3 }] })],
      }),
    });
    expect(violatesSafetyFloor(s, [{ type: "set_staffing_requirement_people", ruleId: "night", requiredNumPeople: 2 }], { leaveAsked: false })).not.toBeNull();
  });
});
```

`repair-eval.test.ts`: add `"rnMixOnLeave"` to `INFEASIBLE`, and add `rnMixOnLeave: ["borrow_temporary_nurse", "ask_nurse_on_leave"]` to `EXPECTED`.

`playbook.test.ts`: assert that the `rules` step's `proposeWith` contains `"set_skill_mix"`, and that no playbook line still says the assistant "cannot create" a skill mix.

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd web && pnpm vitest run lib/ai/assistant`
Expected: FAIL. `skillGroup` finds no group (no `qualifiedPeople`), `set_skill_mix` is not handled by the floor, and so on.

- [ ] **Step 4: Implement**

`repair-options.ts`:

```ts
/** A card that limits who counts: named qualifiedPeople (bans others) or a skill mix (bans nobody). */
const isSkillMix = (card: RequirementCard | undefined) => {
  const refs = asList(card?.qualifiedPeople);
  return (refs.length > 0 && !refs.some(isAll)) || (card?.skillMix?.length ?? 0) > 0;
};
```

Keep `isHeadCount` working on skill-mix cards. A card with a skill mix and everyone qualified is still one head count, so change its first clause to `asList(card.qualifiedPeople).every(isAll)` instead of `!isSkillMix(card)`.

`skillGroup`: before the `ruleIds` loop, `const mixed = skilled.find((f) => f.mixPeople && ctx.groupIds.has(f.mixPeople)); if (mixed) return mixed.mixPeople;`.

`skillMixOn`: include skill-mix entries, the card's own among them:

```ts
      .map((c) => Math.max(isNamed(c) ? c.requiredNumPeople : 0, skillMixFloor(c))),
```

Here `isNamed` is the old qualifiedPeople-only test, split out of `isSkillMix`. The filter also keeps `c === card` (today it is excluded only by `isSkillMix(c)`).

The `run_one_short` builder skips a finding whose `mixPeople !== null` (`if (f.mixPeople) continue;`): a lower head count cannot fix a skill-mix gap.

`violatesSafetyFloor`, new cases:

```ts
        case "set_skill_mix": {
          const card = ctx.state.cardsByKind.requirements.find((c) => c.uid === op.ruleId);
          // Every existing entry stays, with the same people and a minimum no lower.
          const kept = (card?.skillMix ?? []).every((was) =>
            op.skillMix.some(
              (now) => String(now.people) === String(was.people) && now.minNumPeople >= was.minNumPeople,
            ),
          );
          return kept ? null : skillMix;
        }
        case "remove_people_group":
          return ctx.state.cardsByKind.requirements.some(
            (c) => !c.disabled && (c.skillMix ?? []).some((e) => String(e.people) === op.groupId),
          )
            ? skillMix
            : null; // fall through to any existing remove_people_group check, if one exists
```

If `remove_people_group` already has a case, merge this check into it. `add_staffing_requirement` stays as it is: a named `qualifiedPeople` is still forbidden, and a `skillMix` on it is allowed. `isSafeOption` needs no change, because it is an allowlist and `set_skill_mix` is not on it. The new test pins that.

`playbook.ts`:
- Header ruling: replace "The assistant cannot create or lower a skill-mix … No repair proposes one." with: "A skill mix (`skillMix` on a staffing requirement: at least k of a group among its staff, banning nobody) is set with `set_skill_mix` or `add_staffing_requirement.skillMix`. The assistant can add or raise one, and it never removes or lowers one. No repair proposes one, and a skill-mix gap is repaired by borrowing into that group (manager confirms the qualification) or asking a qualified nurse on leave."
- In the `rules` step: `proposeWith: ["add_staffing_requirement", "set_skill_mix", "add_succession_rule", "add_count_rule"]`.
- Set `PLAYBOOK_VERSION` to the next value (for example `"2026-09-24.4"`, or one higher than current if a sibling bumped it first).

`help-content.ts` `staffing-requirements.nurseFacingSummary`:

```ts
      "How many people a shift needs: exactly that number, or a range when a preferred number " +
      "is set. A skill mix says how many of a shift's people must come from a group, for " +
      "example at least 2 RNs among the 4 on nights; anyone can fill the other places. " +
      "Naming who is qualified is different: nobody else can work that shift at all.",
```

and `supportedCommands` gains the arm if the entry lists arms (it lists `["patch_scenario"]` today, so leave it unless the test demands otherwise). Then run `cd web && pnpm capability:generate`.

- [ ] **Step 5: Generate the repair fixtures and prove them with the real solver**

Run: `cd web && pnpm vitest run lib/ai/assistant/repair-eval -u`
Expected: it writes `core/tests/fixtures/assistant_repair/rnMixOnLeave.before.yaml` and `.after.yaml`. Read both. `before` has `skillMix: [{people: RN, minNumPeople: 2}]` on the night requirement and `qualifiedPeople: [ALL]`. `after` adds "Borrowed nurse 1" in group RN with hard days off on every date except the 3rd.

Edit `core/tests/test_assistant_repair_fixtures.py`, where `test_the_harness_wrote_every_case` lists the cases. **Deliberate test change:** add `"rnMixOnLeave"` between `"personalCapsTooLow"` and `"ruleTooStrict"` (the list is sorted).

Run: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q tests/test_assistant_repair_fixtures.py`
Expected: PASS. `rnMixOnLeave` before is INFEASIBLE and after is FEASIBLE/OPTIMAL.

- [ ] **Step 6: Run all the gates**

Run: `cd web && pnpm vitest run && pnpm typecheck && pnpm lint && pnpm capability:generate && git diff --stat lib/capability/registry.generated.ts`
Then: `cd core && PYTHONPATH=. /usr/bin/python3 -m pytest -q`
Expected: all PASS. `registry.generated.ts` changes only its hash and byte counts.

- [ ] **Step 7: Commit**

```bash
git add web/lib/ai/assistant web/lib/capability web/lib/rules/ward-fixtures.test-support.ts core/tests/fixtures/assistant_repair core/tests/test_assistant_repair_fixtures.py
git commit -m "feat(assistant): repair skill-mix gaps by borrowing into the group; floor keeps skill mix"
```

Commit body: the deliberate test changes (repair case list, `PLAYBOOK_VERSION`, capability registry hash).

---

## Decisions

1. **Native solver concept (option b), not the twin transformation (option a).** One inequality per (date, group, entry) is correct by construction. Rest, cap and request rules need no change because nobody moves shift. The twin rewrite has to widen every rule family now and in the future, and it was already found unsafe once.
2. **A field on the requirement, not a new preference type.** A skill mix is relative to a shift's headcount. It lives on the card managers already edit (the nav already says "Min nurses & skill mix per shift"). No new store key, page, persistence kind, cascade kind or workspace model is needed.
3. **Hard only, single ref per entry.** Use a group for "RN or Senior". There is no weight, so the repair playbook never has a soft skill mix to "relax".
4. **Skill mix requires `qualifiedPeople` = everyone and no coefficients.** This avoids two meanings on one card. Twin cards (named `qualifiedPeople`) keep working unchanged.
5. **`set_skill_mix` plus optional `add_staffing_requirement.skillMix`.** A batch cannot address a card it creates (uids are digests). `edit_staffing_requirement` keeps the stored mix, the same way it keeps the preferred count.
6. **The safety floor still forbids relaxing a skill mix** (remove, lower, regroup, delete its group, drop the headcount under it, turn it off). Adding or raising is allowed. `set_skill_mix` is never in a repair.
7. **No version bumps or migrations.** The field is additive and optional, and an older core build rejects it loudly (`extra="forbid"`).

## Open questions (each with a recommended answer)

1. *Offer a soft skill mix ("ideally one senior")?* Recommendation: no, not now. Add a `weight` later if managers ask. Hard-only keeps the floor simple.
2. *Convert the twin scenarios (`ward-8-*`, `large-ward-with-87-people-*`) to native skill mix?* Recommendation: no. They are regression coverage for the twin idiom. File a follow-up bead only if the UI starts nudging users to convert.
3. *Show whether the skill mix is met on the roster viewer (per cell or per day)?* Recommendation: follow-up bead. The solver guarantees it, so this is reassurance, not correctness.
4. *Should the assistant remove a skill mix when the manager explicitly asks, outside a repair?* Recommendation: no. Keep it UI-only, the same as the existing rule "never lower a skill-mix requirement". The assistant explains and points to the Staffing requirements screen.
5. *How does the per-date staffing override (sibling plan, not yet written) interact?* Recommendation: an override that clones a requirement for one date copies `skillMix`. Its count is validated by the same `validateRequirementForm`, so it cannot go below `skillMixFloor`. The sibling should reuse `skillMixFloor` and the field name `skillMix`.
6. *Group picker: groups only, or groups and people?* Recommendation: groups first, then people, from the existing qualified-people options, one choice per row. Core accepts either.

## Assumptions

- `nurse_scheduling.schedule` returns `df is None` and status `"INFEASIBLE"` for infeasible models (as used in `catalogue_oracle.py` and `test_assistant_repair_fixtures.py`).
- Core accepts a people group with `members: []` (nothing in `group_map.py` or `models.py` rejects it). If it does not, `test_empty_group_is_infeasible_not_a_crash` uses a group whose only member is on hard leave all week.
- OR-Tools either accepts `Add(False)` or needs the `add_bool_or([])` fallback given in Task 2. The empty-group test decides which.
- `borrowTemporaryNurse` already builds `add_person { groups: [group] }` plus hard days off when `skillGroup` returns a group, and already asks the manager to confirm the qualification (`playbook.ts` borrow guardrail).
- `firstUnoffered`, `firstFormError`, `ruleName`, `stableStringify` and `buildQualifiedPeopleTransferOptions` are in scope in `operations.ts` (they are used by the existing staffing arms).
- The persistence sanitizer throws through `validateRefOrArray`/`requireNumber`. A card with a bad `skillMix` is refused like any other malformed card field.
- No sibling plan file `2026-09-24-per-date-staffing-override.md` existed when this was written, so the names here (`skillMix`, `set_skill_mix`, `skillMixFloor`) are the ones to coordinate on.
