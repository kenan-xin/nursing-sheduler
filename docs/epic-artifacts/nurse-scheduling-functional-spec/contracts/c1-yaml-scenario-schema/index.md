---
kind: spec
title: "Contract C1 — YAML Scenario Schema"
domain: YAML scenario schema (input contract)
prefix: CON-YAML
fidelity: STRICT PARITY
status: conformance-only
---

# Contract C1 — YAML Scenario Schema

> **CONTRACT — CONFORMANCE ONLY.** This document is a fixed-contract reference
> for the *rebuild of the frontend*. The Python core is **not** being rebuilt.
> The schema below is the immutable conformance target the new frontend must
> produce **exactly**, byte-for-field, so that the unchanged core loader
> (`core/nurse_scheduling/loader.py`) and validators
> (`core/nurse_scheduling/models.py`) accept its output.
>
> This spec documents **shape, types, defaults, required-ness, validators,
> reserved IDs, and emitted key order**. It does **not** document the
> *scheduling semantics* of each field (how `weight`, `expression`, `pattern`,
> date keywords, group expansion, etc. affect the solve). For semantics, see
> **C3** (cross-referenced inline as `→ C3`).

---

## 1. Purpose & Scope

### 1.1 Purpose

The core accepts a single YAML document, parses it with `ruamel.yaml`
(`YAML(typ="safe")`, YAML 1.2) and constructs a `NurseSchedulingData` Pydantic
model. Loading is the entire contract surface:

- `core/nurse_scheduling/loader.py:28-41` — `_load_yaml(content: bytes)` loads
  YAML 1.2 via `ruamel.yaml` **specifically to avoid PyYAML auto-converting
  strings like `Off` into the boolean `False`** (see comment at
  `loader.py:38-40`). The new frontend must therefore be able to emit `OFF`,
  `ON`, `Yes`, weekday names, etc. as plain strings and rely on YAML 1.2
  semantics; it must **not** depend on YAML 1.1 boolean coercion.
- `core/nurse_scheduling/loader.py:44-54` — `load_data` calls
  `NurseSchedulingData(**data)`. Every top-level key becomes a constructor
  kwarg; `extra="forbid"` (see §4) rejects any unknown key.

### 1.2 Scope — what the frontend must guarantee

The rebuilt frontend is the **producer**. Its emitter
(`web-frontend/src/utils/yamlGenerator.ts`) and state assembly
(`web-frontend/src/hooks/schedulingState.ts`, `.../save-and-load/page.tsx:78-90`)
must produce a document that:

1. Contains exactly the keys defined in §3/§4 (no extra keys anywhere —
   `extra="forbid"` is set on **every** model).
2. Uses the exact **camelCase, Kubernetes-style** key names quoted in §3.
3. Omits `dates.items` as *input* (auto-generated; forbidden as input — §5).
4. Includes at least one `at most one shift per day` preference (§5).
5. Uses only permitted reserved IDs and never collides with reserved IDs (§5).
6. Emits keys in the exact order in §3.4 and leaf arrays in flow style (§3.4).

### 1.3 Out of scope (deferred to C3)

Solve semantics; weight meaning; date-string interpretation (`D`, `MM-DD`,
`YYYY-MM-DD`, ranges like `20~21`, weekday/keyword filters); group-member
expansion; `expression` grammar; `pattern` matching; export rendering behavior.

---

## 2. Conventions

- **camelCase Kubernetes-style.** All keys are camelCase: `apiVersion`,
  `startDate`, `endDate`, `shiftTypes`, `requiredNumPeople`, `countShiftTypes`,
  `backgroundColor`, etc. (`models.py`, throughout).
- **`extra="forbid"` everywhere.** Every Pydantic model sets
  `model_config = ConfigDict(extra="forbid")` (e.g. `models.py:47, 54, 60, 67,
  73, 80, 87, 93, 99, 106, 129, 148, 153, 158`-adjacent classes, `177, 188, 198,
  205`, and every preference class `210, 225, 240, 246, 270, 288`, and the root
  `304`). Any key not listed for a model raises a validation error.
- **Type notation.** `int | str` means the YAML scalar may be an integer or a
  string. `(int | str) | list[int | str]` means "a single scalar **or** a list
  of scalars" (Pydantic union). `datetime.date` means a YAML date scalar
  (`YYYY-MM-DD`) — but many date-typed fields also accept `int | str` shorthand
  forms (`→ C3` for interpretation).
- **`| None = None`** = optional, default `null`/omitted.
- **`Field(default_factory=list)`** = optional, defaults to empty list `[]`.

---

## 3. Schema Reference

### 3.1 Top-level: `NurseSchedulingData` (`models.py:303-320`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `appVersion` | `str \| None` | No | `None` | Frontend metadata; appended **last** by the emitter (§3.4). `models.py:305` |
| `apiVersion` | `str` | **Yes** | — | Frontend emits the literal `alpha` (`web-frontend/src/utils/keywords.ts:35 API_VERSION = 'alpha'`). `models.py:306` |
| `description` | `str \| None` | No | `None` | Frontend always emits (empty string `''` when unset). `models.py:307` |
| `dates` | `DateContainer` | **Yes** | — | §3.2. `models.py:308` |
| `country` | `str \| None` | No | `None` | Ordered *after* `dates` in the model, but the frontend does **not** emit it (not in `SchedulingState`, `schedulingState.ts:24-32`). `models.py:309` |
| `people` | `PeopleContainer` | **Yes** | — | §3.2. `models.py:310` |
| `shiftTypes` | `ShiftTypesContainer` | **Yes** | — | §3.2. `models.py:311` |
| `preferences` | `list[<union of 6 preference models>]` | **Yes** | — | §3.3; must include `at most one shift per day` (§5). `models.py:312-319` |
| `export` | `ExportConfig` | No | `ExportConfig()` (empty) | §3.5. `models.py:320` |

### 3.2 Containers, items, and groups

**`DateContainer`** (`models.py:98-102`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `range` | `DateRange` | **Yes** | — | see below |
| `items` | `list[datetime.date]` | No | `[]` | **Forbidden as input** — auto-generated from `range`; supplying a non-empty `items` fails (§5). `models.py:101, 382-383` |
| `groups` | `list[DateGroup]` | No | `[]` | `models.py:102` |

**`DateRange`** (`models.py:53-56`)

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `startDate` | `datetime.date` | **Yes** | `YYYY-MM-DD` |
| `endDate` | `datetime.date` | **Yes** | must be `>= startDate` (§5) |

**`DateGroup`** (`models.py:79-83`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `id` | `str` | **Yes** | — | reserved-ID + format rules apply (§5) |
| `description` | `str \| None` | No | `None` | |
| `members` | `list[int \| str \| datetime.date]` | **Yes** | — | date IDs, group IDs, or date objects (`→ C3`) |

**`PeopleContainer`** (`models.py:86-89`)

| Key | Type | Required | Default |
|-----|------|----------|---------|
| `items` | `list[Person]` | **Yes** | — |
| `groups` | `list[PeopleGroup]` | No | `[]` |

**`Person`** (`models.py:46-50`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `id` | `int \| str` | **Yes** | — | reserved-ID rules (§5) |
| `description` | `str \| None` | No | `None` | |
| `history` | `list[str] \| None` | No | `None` | validated against shift-type IDs (§5) (`→ C3` for meaning) |

**`PeopleGroup`** (`models.py:59-63`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `id` | `str` | **Yes** | — | reserved-ID rules (§5) |
| `description` | `str \| None` | No | `None` | |
| `members` | `list[int \| str]` | **Yes** | — | person IDs or other group IDs |

**`ShiftTypesContainer`** (`models.py:92-95`)

| Key | Type | Required | Default |
|-----|------|----------|---------|
| `items` | `list[ShiftType]` | **Yes** | — |
| `groups` | `list[ShiftTypeGroup]` | No | `[]` |

**`ShiftType`** (`models.py:66-69`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `id` | `int \| str` | **Yes** | — | reserved-ID rules — `ALL`/`OFF` forbidden (§5) |
| `description` | `str \| None` | No | `None` | |

**`ShiftTypeGroup`** (`models.py:72-76`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `id` | `str` | **Yes** | — | reserved-ID rules (§5) |
| `description` | `str \| None` | No | `None` | |
| `members` | `list[int \| str]` | **Yes** | — | shift-type IDs or other group IDs |

### 3.3 `preferences` — the 6 preference field-schemas

All preference models set `extra="forbid"`. The `type` field is a
constrained/`Literal` string that both defaults to and is pattern-locked to the
canonical value (so the discriminated union resolves). Canonical `type` strings
(`models.py:29-35`):

`"at most one shift per day"`, `"shift type requirement"`, `"shift request"`,
`"shift type successions"`, `"shift count"`, `"shift affinity"`,
**`"shift type covering"`** (added — see §3.3(g) for schema and
`→ C3 §CON-SEM-07` for handler semantics).

**(a) `MaxOneShiftPerDayPreference`** — `type: "at most one shift per day"`
(`models.py:239-242`)

| Key | Type | Required | Default |
|-----|------|----------|---------|
| `type` | pattern-locked `str` | **Yes** (value fixed) | `"at most one shift per day"` |
| `description` | `str \| None` | No | `None` |

**(b) `ShiftRequestPreference`** — `type: "shift request"` (`models.py:209-216`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `type` | pattern `^shift request$` | fixed | `"shift request"` | |
| `description` | `str \| None` | No | `None` | |
| `person` | `(int \| str) \| list[int \| str]` | **Yes** | — | single or list (person/group ID) |
| `date` | `(int \| str \| date) \| list[...]` | **Yes** | — | single or list (`→ C3`) |
| `shiftType` | `str \| list[str]` | **Yes** | — | single or list |
| `weight` | `int \| float` | No | `1` | float only `.inf`/`-.inf` (§5, `models.py:216-221`) |

**(c) `ShiftTypeSuccessionsPreference`** — `type: "shift type successions"`
(`models.py:224-231`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `type` | pattern `^shift type successions$` | fixed | `"shift type successions"` | |
| `description` | `str \| None` | No | `None` | |
| `person` | `(int \| str) \| list[int \| str]` | **Yes** | — | |
| `pattern` | `list[str \| list[str]]` | **Yes** | — | shift-type IDs or nested patterns (`→ C3`) |
| `date` | `(int \| str \| date) \| list[...] \| None` | No | `None` | `None` ⇒ all dates |
| `weight` | `int \| float` | No | `1` | float only `.inf`/`-.inf` |

**(d) `ShiftTypeRequirementsPreference`** — `type: "shift type requirement"`
(`models.py:245-261`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `type` | pattern `^shift type requirement$` | fixed | `"shift type requirement"` | |
| `description` | `str \| None` | No | `None` | |
| `shiftType` | `str \| list[str \| list[str]]` | **Yes** | — | single, flat-list, or nested aggregate (`→ C3`) |
| `shiftTypeCoefficients` | `list[tuple[str, int]] \| None` | No | `None` | e.g. `- [D, 1]` |
| `requiredNumPeople` | `int` | **Yes** | — | |
| `qualifiedPeople` | `(int \| str) \| list[int \| str] \| None` | No | `None` | `None` **and** reserved `"ALL"` both mean all people (§6, `models.py:254-256`) |
| `preferredNumPeople` | `int \| None` | No | `None` | |
| `date` | `(int \| str \| date) \| list[...] \| None` | No | `None` | `None` **and** `"ALL"` both mean all dates (§6, `models.py:258-260`) |
| `weight` | `int \| float` | No | **`-1`** | float only `.inf`/`-.inf` |

**(e) `ShiftCountPreference`** — `type: "shift count"` (`models.py:269-279`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `type` | pattern `^shift count$` | fixed | `"shift count"` | |
| `description` | `str \| None` | No | `None` | |
| `person` | `(int \| str) \| list[int \| str]` | **Yes** | — | |
| `countDates` | `(int \| str \| date) \| list[...]` | **Yes** | — | |
| `countShiftTypes` | `str \| list[str]` | **Yes** | — | |
| `countShiftTypeCoefficients` | `list[tuple[str, int]] \| None` | No | `None` | |
| `expression` | `str \| list[str]` | **Yes** | — | mathematical expression(s) (`→ C3`; frontend allows `\|x - T\|^2`, `x >= T`, `x <= T`, `x > T`, `x < T`, `x = T` — `scheduling.ts:158`) |
| `target` | `int \| list[int]` | **Yes** | — | |
| `weight` | `int \| float` | No | **`-1`** | float only `.inf`/`-.inf` |

**(f) `ShiftAffinityPreference`** — `type: "shift affinity"` (`models.py:287-295`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `type` | pattern `^shift affinity$` | fixed | `"shift affinity"` | |
| `description` | `str \| None` | No | `None` | |
| `date` | `(int \| str \| date) \| list[...]` | **Yes** | — | |
| `people1` | `list[int \| str \| list[int \| str]]` | **Yes** | — | list or nested |
| `people2` | `list[int \| str \| list[int \| str]]` | **Yes** | — | list or nested |
| `shiftTypes` | `list[str \| list[str]]` | **Yes** | — | list or nested |
| `weight` | `int \| float` | No | `1` | float only `.inf`/`-.inf` |

**(g) `ShiftTypeCoveringPreference`** — `type: "shift type covering"`
(`models.py:304-323`)

| Key | Type | Required | Default | Notes |
|-----|------|----------|---------|-------|
| `type` | pattern `^shift type covering$` | fixed | `"shift type covering"` | |
| `description` | `str \| None` | No | `None` | |
| `date` | `(int \| str \| datetime.date) \| list[int \| str \| datetime.date] \| None` | No | `None` | `None` and empty list both mean all dates |
| `preceptors` | `list[int \| str \| list[int \| str]]` | **Yes** | — | list, supports nesting; see §6 conformance note |
| `preceptees` | `list[int \| str \| list[int \| str]]` | **Yes** | — | list, supports nesting; see §6 conformance note |
| `shiftTypes` | `list[str \| list[str]]` | **Yes** | — | list, supports nesting; see §6 conformance note |
| `weight` | `int \| float` | No | **`1`** | float only `.inf`/`-.inf` |

**Important shape difference from (a)–(f):** the three required selectors
(`preceptors`, `preceptees`, `shiftTypes`) are **always lists, not
"single-or-list"** — there is no scalar union for these fields. The list may
contain scalars or nested sub-lists; the nested form is the
group-of-groups/aggregate convention (same as (f) shift affinity). The
frontend's `ShiftTypeCoveringPreference` interface
(`web-frontend/src/types/scheduling.ts:229-237`) types these as
`(string | string[])[]`. See §6 for the frontend coercion rule that flattens
the form to single-level lists for the editor.

Semantics (handler-level): `→ C3 §CON-SEM-07`.

### 3.4 Emitted key order & array style (frontend producer contract)

The emitter (`web-frontend/src/utils/yamlGenerator.ts`) uses `js-yaml`, which
serializes object keys in **insertion order**. Two rules the new frontend must
preserve exactly:

1. **`appVersion` is appended last.** `generateYamlFromState`
   (`yamlGenerator.ts:99-116`) builds
   `exportObject = { ...stateObject, appVersion: CURRENT_APP_VERSION }`, so
   `appVersion` is always the **final** top-level key (`yamlGenerator.ts:110-113`).
   `CURRENT_APP_VERSION` comes from `NEXT_PUBLIC_APP_VERSION` (default
   `'unknown'`) (`web-frontend/src/utils/version.ts:23`).
2. **Leaf arrays are emitted flow-style.** `replacer`/`isLeafArray`
   (`yamlGenerator.ts:34-89`) wrap any array whose items are *all* primitives
   (`string \| number \| boolean \| null \| undefined`) in `CustomDump` with
   `flowLevel: 0`, producing `[a, b, c]`. Arrays that contain nested arrays
   (e.g. `pattern: [[D, E], N]`) are **not** leaf arrays and render block-style
   from the emitter (hand-authored testcases show them inline, but that is
   author formatting, not emitter output). `Date` values are stringified to
   `YYYY-MM-DD` (`yamlGenerator.ts:85-87`).

The top-level insertion order the frontend state object produces
(`save-and-load/page.tsx:78-87` building on `SchedulingState`,
`schedulingState.ts:24-32`) is:

```
apiVersion, description, dates, people, shiftTypes, preferences, [export], appVersion
```

Note: the frontend does **not** emit `country` (not part of `SchedulingState`).
The model permits it; a conforming frontend simply omits it.

### 3.5 `export` — `ExportConfig` (`models.py:197-201`)

| Key | Type | Required | Default |
|-----|------|----------|---------|
| `formatting` | `list[ExportFormattingRule]` | No | `[]` |
| `extraColumns` | `list[ExportExtraColumn]` | No | `[]` |
| `extraRows` | `list[ExportExtraRow]` | No | `[]` |

`ExportFormattingRule` is a **discriminated union on `type`**
(`models.py:167-173`). Common base fields (`BaseExportFormattingRule`,
`models.py:105-111`), all optional, all `#RRGGBB` hex where a color:

| Key | Type | Constraint |
|-----|------|-----------|
| `description` | `str \| None` | — |
| `backgroundColor` | `str \| None` | `^#[0-9a-fA-F]{6}$` |
| `bottomBorderColor` | `str \| None` | `^#[0-9a-fA-F]{6}$` |
| `rightBorderColor` | `str \| None` | `^#[0-9a-fA-F]{6}$` |
| `fontColor` | `str \| None` | `^#[0-9a-fA-F]{6}$` |

Discriminator variants:

- `ExportPersonFormattingRule` (`models.py:114-116`): `type: "row" \| "people header" \| "history"`; `people: list[int \| str]` (**Yes**).
- `ExportDateFormattingRule` (`models.py:119-121`): `type: "column" \| "date header"`; `dates: list[int \| str]` (**Yes**).
- `ExportHistoryHeaderFormattingRule` (`models.py:124-125`): `type: "history header"`; no extra fields.
- `ExportCellFormattingRule` (`models.py:157-164`): `type: "cell"`; `appendText: str \| None`; `note: {text: str} \| None` (`ExportFormattingNote`, `models.py:152-154`); `people/dates/shiftTypes: list[int \| str]` (**all Yes**); `when: ExportFormattingCondition \| None`.

`ExportFormattingCondition` (`models.py:147-149`): `{ preference: ExportPreferenceCondition }`.
`ExportPreferenceCondition` (`models.py:128-144`):

| Key | Type | Required | Default |
|-----|------|----------|---------|
| `types` | `list[Literal["shift request"]]` | **Yes** | — |
| `requestShape` | `list[Literal["person-item-to-date-item","people-group-to-date-item","person-item-to-date-group","people-group-to-date-group","ALL"]] \| None` | No | `None` |
| `satisfied` | `bool \| None` | No | `None` |
| `weightRange` | `list[int \| float] \| None` | No | `None` |

`ExportExtraColumn` (`models.py:176-184`): `description?`, `rightBorderColor?`
(hex), `type` (pattern `^count$`, **Yes**), `header: str` (**Yes**),
`countShiftTypes: list[int \| str]` (**Yes**),
`countShiftTypeCoefficients: list[tuple[str, int]] \| None`,
`countDates: list[int \| str]` (**Yes**).

`ExportExtraRow` (`models.py:187-194`): `description?`, `bottomBorderColor?`
(hex), `type` (pattern `^count$`, **Yes**), `header: str` (**Yes**),
`countShiftTypes: list[int \| str]` (**Yes**),
`countPeople: list[int \| str]` (**Yes**).

### 3.6 Annotated example (grounded in `core/tests/testcases/basics/01_1nurse_1shift_1day_all_prefs.yaml`)

```yaml
apiVersion: alpha              # REQUIRED. Frontend literal "alpha" (keywords.ts:35).
# description: ""              # optional; frontend emits "" when unset.
dates:                         # REQUIRED (DateContainer).
  range:                       # REQUIRED. startDate/endDate REQUIRED, endDate >= startDate.
    startDate: 2023-08-18
    endDate: 2023-08-18
  # items: [...]               # FORBIDDEN as input — auto-generated from range (§5).
  # groups:                    # optional; DateGroup {id, description?, members[]}
  #   - id: odd
  #     members: [19]          # leaf array -> flow style
people:                        # REQUIRED (PeopleContainer).
  items:
    - id: 0                    # id: int | str
      # description: Nurse 0   # optional
      # history: [E]           # optional; validated vs shift-type IDs (§5)
  # groups: [...]              # optional; PeopleGroup {id, description?, members[]}
shiftTypes:                    # REQUIRED (ShiftTypesContainer).
  items:
    - id: D                    # ALL / OFF forbidden as id (§5)
  # groups: [...]
preferences:                   # REQUIRED list; MUST contain "at most one shift per day" (§5).
  - type: at most one shift per day
  - type: shift type requirement
    shiftType: D               # str | list[str | list[str]]
    requiredNumPeople: 1
    # qualifiedPeople omitted  # None == "ALL" (all people) (§6)
    # date omitted             # None == "ALL" (all dates)  (§6)
    # weight: -1               # default -1
  - type: shift request
    person: 0
    date: ALL                  # reserved "ALL" selector
    shiftType: D
    weight: -1                 # int | float (float only .inf / -.inf)
  - type: shift type successions
    person: 0
    pattern: [D]               # leaf array -> flow; nested e.g. [[D, E], N]
    weight: -10
  - type: shift count
    person: 0
    countDates: ALL
    countShiftTypes: OFF       # OFF is a valid selector here (not an id) (→ C3)
    expression: 'x < T'
    target: 1
    weight: -100
# export: { formatting: [], extraColumns: [], extraRows: [] }  # optional
appVersion: <build>            # appended LAST by emitter (yamlGenerator.ts:110-113).
```

---

## 4. Field-by-Field Requirements

- **CON-YAML-01** — The root document MUST parse as a YAML 1.2 mapping and
  deserialize into `NurseSchedulingData(**data)` (`loader.py:44-54`). The
  loader uses `ruamel.yaml YAML(typ="safe")` to preserve strings like `OFF`
  (`loader.py:25, 38-40`); the frontend MUST NOT rely on YAML 1.1 truthy coercion.

- **CON-YAML-02** — `apiVersion` (`str`) is REQUIRED (`models.py:306`). A
  conforming frontend emits the literal `alpha`
  (`web-frontend/src/utils/keywords.ts:35`).

- **CON-YAML-03** — `appVersion` (`str \| None`, default `None`,
  `models.py:305`) is OPTIONAL for the core but the frontend ALWAYS appends it
  as the **last** top-level key (`yamlGenerator.ts:110-113`).

- **CON-YAML-04** — `description` and `country` are OPTIONAL `str \| None`
  (`models.py:307, 309`). The frontend emits `description` (empty string when
  unset) and does NOT emit `country`.

- **CON-YAML-05** — `dates` REQUIRED; `dates.range.startDate` and
  `dates.range.endDate` REQUIRED `datetime.date`; `endDate >= startDate`
  (`models.py:98-102, 53-56, 332-333`).

- **CON-YAML-06** — `dates.items` MUST be absent or empty; it is
  auto-generated from `range` and any non-empty value is rejected
  (`models.py:101, 382-383`). See §5.

- **CON-YAML-07** — `dates.groups[*]`: `id` (`str`, REQUIRED), `description?`,
  `members` (`list[int \| str \| datetime.date]`, REQUIRED) (`models.py:79-83`).
  `id` is subject to reserved-ID and format rules (§5).

- **CON-YAML-08** — `people.items` REQUIRED (`list[Person]`); `people.groups`
  OPTIONAL default `[]` (`models.py:86-89`).

- **CON-YAML-09** — `Person`: `id` (`int \| str`, REQUIRED), `description?`,
  `history?` (`list[str]`) (`models.py:46-50`). `history` entries validated (§5).

- **CON-YAML-10** — `PeopleGroup`: `id` (`str`, REQUIRED), `description?`,
  `members` (`list[int \| str]`, REQUIRED) (`models.py:59-63`).

- **CON-YAML-11** — `shiftTypes.items` REQUIRED (`list[ShiftType]`);
  `shiftTypes.groups` OPTIONAL default `[]` (`models.py:92-95`).

- **CON-YAML-12** — `ShiftType`: `id` (`int \| str`, REQUIRED), `description?`
  (`models.py:66-69`). `id` MUST NOT be a reserved value `ALL`/`OFF` (§5).

- **CON-YAML-13** — `ShiftTypeGroup`: `id` (`str`, REQUIRED), `description?`,
  `members` (`list[int \| str]`, REQUIRED) (`models.py:72-76`).

- **CON-YAML-14** — `preferences` REQUIRED, a list whose items each match one of
  the six preference models by discriminating `type`
  (`models.py:312-319`). At least one `at most one shift per day` MUST be present
  (§5).

- **CON-YAML-15** — Each preference `type` is pattern/`Literal`-locked to its
  canonical string (`models.py:211, 226, 241, 247, 271, 289, 317`) and defaults to
  it, so the frontend MUST emit the exact canonical strings from
  `models.py:29-35` (including `"shift type covering"`).

- **CON-YAML-16** — `weight` fields: `int \| float`, defaults **`1`** for
  `shift request`/`shift type successions`/`shift affinity` and **`-1`** for
  `shift type requirement`/`shift count` (`models.py:216, 231, 261, 279, 295`).
  `shift type covering` defaults to **`1`** (`models.py:323`). Float weights
  MUST be `+inf` or `-inf` only (§5). (`→ C3` for meaning.)

- **CON-YAML-17** — "Single-or-list" scalar fields (`person`, `date`,
  `shiftType`, `countDates`, `countShiftTypes`, `target`, `expression`) accept
  either a lone scalar or a list; the frontend state stores them as arrays
  (`scheduling.ts:170-226`) and MAY emit either a length-1 leaf array `[x]` or a
  bare scalar — both are accepted by the union types.

- **CON-YAML-18** — `shiftType` in `shift type requirement` and `pattern`,
  `people1`, `people2`, `shiftTypes` in the respective preferences accept
  **nested** lists (aggregate/grouped structure) (`models.py:229, 251, 292-294`).
  Nested arrays are not leaf arrays and are emitted block-style (§3.4).
  `shift type covering` follows the same nested-list convention for
  `preceptors`, `preceptees`, and `shiftTypes` (`models.py:320-322`).

- **CON-YAML-19** — `shiftTypeCoefficients` / `countShiftTypeCoefficients` are
  `list[tuple[str, int]] \| None` — each entry a 2-element `[id, int]` pair
  (`models.py:252, 276, 183`), emitted e.g. `- [D, 1]`.

- **CON-YAML-19a** — `shift type covering`'s `preceptors`, `preceptees`, and
  `shiftTypes` are typed as `list[int \| str \| list[int \| str]]` /
  `list[str \| list[str]]` respectively (`models.py:320-322`). The frontend
  (`web-frontend/src/app/shift-type-coverings/page.tsx:155-162`) emits these
  fields as a **single-level array** wrapping the form selections (one
  single-level list per top-level slot). The backend flattens nested lists
  via the same `_flatten_persons` / `_flatten_shifts` helpers used by
  `shift affinity` (`preference_types.py:644-664`). Conforming emitters may
  emit either the single-level form (frontend convention) or the nested form
  (backend-supported); both parse correctly.

- **CON-YAML-20** — `export` OPTIONAL, default empty `ExportConfig`
  (`models.py:320, 197-201`). All color fields MUST match `^#[0-9a-fA-F]{6}$`
  (`models.py:108-111, 179, 190`). `type` fields on extra column/row match
  `^count$` (`models.py:180, 191`). Formatting rules form a `type`-discriminated
  union (`models.py:167-173`) — the emitted `type` MUST be one of the exact
  literals in §3.5.

---

## 5. Validation & Reserved-ID Rules

All checks below are in `NurseSchedulingData.validate_model`
(`models.py:322-401`) unless noted. **Exact error messages** (the frontend must
produce data that never triggers these):

| # | Rule | Trigger | Exact message (`models.py`) |
|---|------|---------|-----------------------------|
| V1 | Required preference | No `at most one shift per day` in `preferences` | `Missing required preferences: {missing}` (`:329`) |
| V2 | Date order | `endDate < startDate` | `enddate must be after or equal to startdate` (`:333`) |
| V3 | Duplicate shift-type id | repeated `shiftTypes.items[*].id` | `Duplicated shift type ID: {id!r}` (`:341`) |
| V4 | Reserved shift-type id | `id.upper()` in `{ALL, OFF}` | `Shift type ID {id!r} cannot be one of the reserved values: {'ALL','OFF'}` (`:343-345`) |
| V5 | Duplicate shift-type group id | group id collides with an item or group id | `Duplicated shift type group (or shift type) ID: {id!r}` (`:349`) |
| V6 | Reserved shift-type group id | `group.id.upper()` in `{ALL, OFF}` | `Shift type group ID {id!r} cannot be one of the reserved values: {'ALL','OFF'}` (`:351-353`) |
| V7 | Duplicate person id | repeated `people.items[*].id` | `Duplicated person ID: {id!r}` (`:361`) |
| V8 | Reserved person id | `id.upper()` in `{ALL}` | `Person ID {id!r} cannot be one of the reserved values: {'ALL'}` (`:363`) |
| V9 | History = ALL | `history` entry `== "ALL"` (exact) | `History must not include 'ALL', but got {v!r}` (`:366`) |
| V10 | History group id | `history` entry is a shift-type **group** id | `History must not include group ID, but got {v!r}` (`:368`) |
| V11 | History unknown | `history` entry `!= "OFF"` and not a known shift-type id | `Unknown shift type ID in history: {v!r}` (`:370`) |
| V12 | Duplicate people group id | group id collides with a person/group id | `Duplicated people group (or person) ID: {id!r}` (`:373`) |
| V13 | Reserved people group id | `group.id.upper()` in `{ALL}` | `People group ID {id!r} cannot be one of the reserved values: {'ALL'}` (`:375-377`) |
| V14 | `dates.items` supplied | non-empty `dates.items` | `dates.items is not allowed since it is automatically generated from dates.range` (`:383`) |
| V15 | Duplicate date group id | repeated `dates.groups[*].id` | `Duplicated date group ID: {id!r}` (`:388`) |
| V16 | Reserved date group id | `id.upper()` in weekday names + `{ALL, WEEKDAY, WEEKEND}` | `Date group ID {id!r} cannot be one of the reserved values: {...}` (`:389-392`) |
| V17 | Date group id format | `id` matches `^\d{1,2}$`, `^\d{2}-\d{2}$`, or `^\d{4}-\d{2}-\d{2}$` | `Date group ID {id!r} must not be in the format of YYYY-MM-DD, MM-DD, or D` (`:394-398`) |
| V18 | Float weight | any `weight` float other than `±inf` | `Float weights can only be positive infinity or negative infinity.` (`models.py:41`, via `validate_weight`) |
| V19 | Unknown key | any key not declared on a model | Pydantic `extra="forbid"` error (all models) |
| V20 | `shift type covering` empty selectors | `preceptors` / `preceptees` / `shiftTypes` expand to no resolvable person/date/shift-type indices | `Preceptors list must contain at least one valid person or group.` / `Preceptees list must contain at least one valid person or group.` / `Shift types list must contain at least one valid shift type.` (`preference_types.py:670-675`). Cross-reference C3 §CON-SEM-07. |

**Reserved-ID reference** (`core/nurse_scheduling/constants.py`):

- `ALL = "ALL"` — reserved for dates, shift types, and people (`constants.py:22`).
- `OFF = "OFF"` — reserved for shift types (`constants.py:23`).
- Date reserved words: weekday names `MONDAY..SUNDAY` (`constants.py:26-34`) plus
  keyword filters `ALL`, `WEEKDAY`, `WEEKEND` (`constants.py:35-39`). All
  reserved comparisons are **case-insensitive** (via `.upper()`),
  `models.py:336, 342, 357, 362, 375, 384, 389`.
- Reserved values are usable as **selectors** in preference/date fields (e.g.
  `date: ALL`, `countShiftTypes: OFF`, `person: ALL`) but MUST NOT be declared
  as `items[*].id` or `groups[*].id`. (`→ C3` for selector semantics.)

---

## 6. Conformance Notes for the new frontend

- **Emit key order exactly** as §3.4: `apiVersion, description, dates, people,
  shiftTypes, preferences, [export], appVersion` — `appVersion` always last
  (`yamlGenerator.ts:110-113`). Do not emit `country`.

- **Leaf arrays flow-style, nested arrays block-style**, `Date` → `YYYY-MM-DD`
  (`yamlGenerator.ts:34-89`). Match this so diffs against existing testcases and
  round-trips stay stable.

- **Strip auto-generated data before emit.** The frontend keeps auto-generated
  items/groups (`OFF` shift type; `ALL`/weekday date groups; `ALL` people/
  shift-type groups — `keywords.ts:37-141`) in in-memory state and MUST remove
  them before serializing (`filterAutoGeneratedState`, used at
  `save-and-load/page.tsx:79`). In particular, never emit `dates.items` (V14) or
  the reserved auto-groups as declared groups.

- **Explicit `ALL` vs backend implicit-all.** This is the single most important
  parity note:
  - For `shift type requirement`, the backend treats **both** `None`/omitted
    **and** the literal `"ALL"` as "all people"/"all dates"
    (`models.py:254-260`).
  - The frontend intentionally **normalizes implicit-all to explicit `"ALL"`**
    in its state and output (`scheduling.ts:176-183`; comments at
    `models.py:255, 259`). The rebuilt frontend SHOULD keep emitting the
    explicit `ALL` selector (e.g. `date: ALL`, `qualifiedPeople: [ALL]`) rather
    than omitting the field, so forms and persisted client state never hold an
    ambiguous empty scope. Both forms validate; explicit `ALL` is the chosen
    convention.

- **`type` strings verbatim.** Emit the exact canonical strings
  (`models.py:29-35`); mirrored in `scheduling.ts:151-157`.

- **Weights.** Emit integers normally; emit infinities as YAML `.inf` / `-.inf`
  (float weights are otherwise rejected — V18). Respect defaults (CON-YAML-16)
  if you choose to omit `weight`.

- **`extra="forbid"` is total.** Never add convenience/debug keys anywhere in
  the document; any unknown key fails loading (V19).

---

## 7. Cross-References

- **C3 — Scenario semantics** (deferred): meaning of `weight`, `expression`
  grammar, `pattern` matching, date-string forms (`D`, `MM-DD`, `YYYY-MM-DD`,
  ranges like `20~21`), weekday/keyword date filters, group-member expansion,
  `OFF`/`ALL` selector behavior, history semantics, export rendering.
- **Source of truth:** `core/nurse_scheduling/models.py`,
  `core/nurse_scheduling/loader.py`, `core/nurse_scheduling/constants.py`.
- **Producer:** `web-frontend/src/utils/yamlGenerator.ts`,
  `web-frontend/src/types/scheduling.ts`,
  `web-frontend/src/hooks/schedulingState.ts`,
  `web-frontend/src/utils/keywords.ts`.
- **Grounding examples:** `core/tests/testcases/basics/*.yaml`,
  `core/tests/testcases/artificial/ortools/*.yaml` (e.g.
  `01_1nurse_1shift_1day_all_prefs.yaml`, `ex2_multiple_date_formats.yaml`,
  `02_2nurses_2shifts_6days_shift_count_coefficients_balance.yaml`,
  `02_4nurses_3shifts_3days_dates_group_odd.yaml`,
  `03_4nurses_3shifts_7days_unwanted_pattern_history.yaml`).
