# Assistant: Guided Setup and Feasibility Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant guides a user from an empty scenario to a generated roster. When the schedule cannot be solved, it names the short day and shift in ward language and offers up to 3 safe, realistic, ranked repairs. Each repair is a concrete proposal with the real-world confirmation it needs.

**Architecture:** Three pure layers and two read-only tools. (1) `web/lib/rules/shortfalls.ts` is a deterministic, AI-free static staffing check. It proves three kinds of infeasibility: one requirement short on a date, a whole day short, and count caps that starve a requirement. (2) `web/lib/ai/assistant/playbook.ts` holds the setup steps, the repair catalogue, the ranking order and the safety floor as typed, versioned data. (3) `web/lib/ai/assistant/setup-progress.ts` and `repair-options.ts` join the scenario, the check and the playbook into a setup progress report and at most 3 ranked `RepairOption`s. Each option carries the exact `AssistantCommandV1[]` that the host validates. The tools `get_setup_progress` and `suggest_feasibility_options` return those reports. The assistant then uses the existing `prepare_scenario_change` / `test_feasibility_candidates` and the user Applies. `deriveAssumptions` gains two host-derived confirmations: `borrowed_staff_arranged` and `extra_shifts_agreed`.

**Depends on** (must be merged first, do not re-plan):
- `docs/superpowers/plans/2026-09-24-assistant-rule-ops.md`: arms `add_staffing_requirement`, `edit_staffing_requirement`, `add_count_rule`, `edit_count_rule`, `add_succession_rule`, `edit_succession_rule`, `remove_rule`, and `COUNT_EXPRESSIONS` exported from `web/lib/proposal/commands.ts`.
- `docs/superpowers/plans/2026-09-24-assistant-people-ops.md`: arms `add_person { name, groups }`, `add_people_group`, `mark_person_off { personId, fromDate, toDate }` (ISO dates, OFF at weight `Infinity`).
- `docs/superpowers/plans/2026-09-24-assistant-leave-request-ops.md`: arms `add_leave`, `set_off_request`, `set_shift_request { personId, shiftType, startDate, endDate, weight: number | "must" | "never" }`, `clear_requests { personId, startDate, endDate }`. `clear_requests` over leave already gets the host `leave_cancelled` question.
- `docs/superpowers/plans/2026-09-24-assistant-optimize-run.md`: `request_optimize_run` (shows a Run card; the user presses Run) and `get_optimize_result` (reads the run view, with a `guidance` line built by `guidanceFor` in `web/components/ai/use-optimize-tools.ts`). If the merged names differ, change only the two constants `OPTIMIZE_RUN_TOOL` / `OPTIMIZE_RESULT_TOOL` in Task 2. Task 2's alignment test fails until the names match. Task 6 changes that plan's infeasible `guidance` line (it says "never name a cause", which contradicts a certain static finding).

**Tech Stack:** Next.js 16 (`web/`), TypeScript, zod v4, vitest 4, zustand v5, CopilotKit 1.66.2 (tool transport), oxlint, ast-grep, Python 3.14 + pytest + OR-Tools CP-SAT (`core/`).

**Spec:** `docs/superpowers/specs/2026-09-24-assistant-guided-setup-and-repair.md`

## Global Constraints

- Every change is propose-then-Apply: an option becomes a change only through `prepare_scenario_change` or `test_feasibility_candidates`, and only the user applies it. Both new tools are read-only.
- A change that relies on a real person agreeing gets a host-derived confirmation (`deriveAssumptions`), never model prose. Leave: `leave_cancelled` (exists). Bounded loan of a borrowed nurse: `borrowed_staff_arranged` (Task 5). Raising one nurse's own hard cap: `extra_shifts_agreed` (Task 5).
- AI is optional. `web/lib/rules/**` must not import `@/lib/ai/**` or `@/components/ai/**` (the oxlint `no-restricted-imports` seam already enforces it). The static check is AI-free so a non-AI UI can reuse it.
- Safety floor. The allowlist `isSafeOption` enforces it, and no option may cross it:
  - A repair never contains `set_rule_enabled`, `remove_rule`, `add_succession_rule` or `edit_succession_rule`.
  - No staffing value goes below 1. A requirement restricted to a group (skill mix) is never lowered.
  - A count cap goes up by at most 2. It keeps its expression and its hard weight.
  - `clear_requests` / `move_leave` need `named_nurse` + `host_question`.
  - `mark_person_off` is allowed only for a nurse added in the same option.
- Tool names must not match `PHASE_2_VERBS` (`/repair|swap|reassign|minimal[_-]?change|disrupt|shortage|re[_-]?optimi/i`, `web/lib/ai/phase-2-absence.test.ts`) or `/apply|mutate|write|update_|set_|delete|propose|diagnos/` (`web/lib/capability/tools.test.ts`). The names are `get_setup_progress` and `suggest_feasibility_options`.
- Tool parameters: every property is required, no `.optional()` / `.nullable()` (the CopilotKit converter has no `null` case, `model-visible-tools.test.ts`).
- `buildAssistantContext` stays exactly three entries (`scenario-context.test.ts` asserts it). Guidance reaches the model through tool results plus one sentence in `ASSISTANT_AUTHORITY_STATEMENT`.
- Limits: 3 options (`MAX_OPTIONS`), 5 explained findings (`MAX_EXPLAINED_FINDINGS`), 3 borrowed nurses per option (`MAX_BORROWED`), 25 operations per option (`MAX_ASSISTANT_OPERATIONS`).
- Model-facing dates in operations are ISO `YYYY-MM-DD` (the dependency arms take ISO). Request-matrix cells store span ids (`DD` / `MM-DD` / ISO). Convert with `generateDateItems`.
- Locked tests change only with a dated `WIDENED DELIBERATELY (2026-09-24, plan assistant-guided-setup-and-repair)` comment.
- Tests: `cd web && pnpm vitest run <path>`. Gates: `pnpm typecheck`, `pnpm exec oxlint && pnpm exec ast-grep scan` (under pnpm 11 `pnpm lint` can map to eslint; the script `lint` is `oxlint && ast-grep scan`). Core: `cd core && PYTHONPATH=. python3 -m pytest -q <path>`. Do not run `pnpm install` or `pnpm build` (the disk is almost full).
- Commit steps apply only when the session has commit authority. The repo default is "do not commit unless asked".

## Review Focus

1. **A nurse's leave cell stored as an ISO date while the roster uses `DD` ids** (or the reverse). Expected: she is still counted as away on that day. (Test: Task 1, `treats an ISO-dated leave cell as the same day as its span id`.)
2. **A staff group used as a request row** (the leave plan allows group rows). Expected: every member of the group is away that day. (Test: Task 1, `expands a group leave row to its members`.)
3. **The borrowed nurse's name clashes with an existing person or group** (`Borrowed nurse 1` already exists). Expected: the builder picks `Borrowed nurse 2`, and the batch applies. (Test: Task 4, `picks a free placeholder name`.)
4. **A skill-mix gap where the requirement names people, not a group** (`qualifiedPeople: ["rn1"]`). Expected: no borrow option (a borrowed nurse could not count), and "ask the nurse on leave" is still offered. (Test: Task 4, `offers no borrow option when the skill group is unknown`.)
5. **A gap of 2 on one date.** Expected: no "ask one nurse on leave" and no "run one short" option (neither closes it). A borrow option for 2 nurses is offered. (Test: Task 4, `does not offer one-person fixes for a gap of two`.)

---

## File Structure

- Create `web/lib/rules/shortfalls.ts`: static staffing check, `findStaffingShortfalls`, `capOf`, `toDateId`, `requirementDateIds`. AI-free.
- Create `web/lib/rules/ward-fixtures.test-support.ts`: six scripted wards shared by the check tests and the evaluation harness.
- Create `web/lib/rules/shortfalls.test.ts`.
- Create `web/lib/ai/assistant/playbook.ts` + `playbook.test.ts`: setup steps, repair catalogue, ranking order, safety floor, instructions, version.
- Create `web/lib/ai/assistant/setup-progress.ts` + `setup-progress.test.ts`.
- Create `web/lib/ai/assistant/repair-options.ts` + `repair-options.test.ts`: ranking, builders, `isSafeOption`, `explainFinding`, `buildFeasibilityReport`.
- Create `web/components/ai/use-feasibility-tools.ts`: registers `suggest_feasibility_options`.
- Modify `web/components/ai/use-context-tools.ts`: registers `get_setup_progress`, mounts `useFeasibilityTools`.
- Modify `web/components/ai/model-visible-tools.ts`, `web/lib/capability/tools.ts`, `web/components/ai/assistant-conversation.tsx` (export `TOOL_ACTIVITY` + 2 labels), `web/lib/ai/assistant/scenario-context.ts` (one sentence), `web/components/ai/use-optimize-tools.ts` (infeasible guidance line, + its test).
- Modify `web/lib/proposal/assumptions.ts` (+ test): two new assumption types.
- Modify `web/lib/capability/help-content.ts`, regenerate `web/lib/capability/registry.generated.ts`.
- Create `web/lib/ai/assistant/repair-eval.test.ts`: scripted-scenario evaluation harness and fixture writer.
- Create `core/tests/fixtures/assistant_repair/*.yaml` (generated) and `core/tests/test_assistant_repair_fixtures.py`: real-solver proof.
- Modify locked tests: `web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/assistant/scenario-context.test.ts`. Create `web/components/ai/tool-activity.test.ts`.

---

## Preconditions (run once before Task 1)

- [ ] **Check that the dependency arms are merged**

Run: `cd web && grep -c '"add_person"\|"mark_person_off"\|"edit_count_rule"\|"add_staffing_requirement"\|"edit_staffing_requirement"\|"clear_requests"\|"set_shift_request"' lib/proposal/commands.ts`
Expected: a count of at least 7. If lower, stop: a dependency plan has not landed.

Run: `cd web && grep -n "export const COUNT_EXPRESSIONS" lib/proposal/commands.ts`
Expected: one line. If the rule-ops plan put it elsewhere, change the import in Task 4 to that path.

Run: `cd web && grep -rn '"request_optimize_run"\|"get_optimize_result"' components/ai lib/ai | head`
Expected: both names are registered. If the optimize plan uses other names, use those names in Task 2 Step 3 (`OPTIMIZE_RUN_TOOL`, `OPTIMIZE_RESULT_TOOL`).

---

### Task 1: Static staffing check

**Files:**
- Create: `web/lib/rules/shortfalls.ts`
- Create: `web/lib/rules/ward-fixtures.test-support.ts`
- Test: `web/lib/rules/shortfalls.test.ts`

**Interfaces:**
- Consumes: `expandDateRefs`, `expandPersonRefs`, `expandShiftTypeRefs`, `flattenShiftTypeRefs` (`web/lib/rules/expansion.ts`); `generateDateItems`, `getDateIdForRange`, `isValidIso` (`web/lib/dates/date-id.ts`); `deriveDateGroups` (`web/lib/dates/derived-groups.ts`); `RESERVED_SHIFT_TYPE`, `isDayStateSelector` (`@/lib/scenario`).
- Produces:
  - `type StaffingFindingKind = "requirement_short" | "day_short" | "cap_short"`
  - `type AwayReason = "leave" | "day_off" | "never_request"`
  - `interface StaffingFinding { kind; dateId: string | null; iso: string | null; shiftTypes: string[]; ruleIds: string[]; required: number; available: number; away: { person: string; reason: AwayReason }[]; capRuleIds: string[]; skillMix: boolean }`
  - `findStaffingShortfalls(state: ScenarioUiState): StaffingFinding[]`
  - `capOf(expression: string, target: number, weight: number): number` (Infinity when not a hard upper bound)
  - `toDateId(ref: DateRef, range: { start: string; end: string }): string`
  - `requirementDateIds(state: ScenarioUiState, card: RequirementCard): string[]`
  - Fixtures: `ward`, `cards`, `people`, `requirement`, `nightCap`, `leave`, and `SCENARIOS: Record<ScenarioName, () => ScenarioUiState>` with names `empty`, `understaffedNight`, `onlyRnOnLeave`, `ruleTooStrict`, `tooFewNurses`, `restRuleTooTight`.

- [ ] **Step 1: Write the ward fixtures**

Create `web/lib/rules/ward-fixtures.test-support.ts`:

```ts
// Scripted wards for the static staffing check and the assistant evaluation harness.
//
// Each ward is 1-7 Nov 2026, so the request-matrix date ids are "01".."07". Every
// ward except `empty` and `restRuleTooTight` is statically infeasible, and each one
// is a situation a real ward manager meets. `restRuleTooTight` is infeasible only
// through rest rules, which the static check does not model: it exercises the
// "unexplained" path.

import {
  createEmptyScenarioUiState,
  type CardsByKind,
  type CountCard,
  type RequirementCard,
  type ScenarioUiState,
  type UiPerson,
  type UiRequestCell,
} from "@/lib/scenario";

export function ward(patch: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-11-01",
    rangeEnd: "2026-11-07",
    shifts: [
      { id: "D", description: "Day" },
      { id: "N", description: "Night" },
    ],
    ...patch,
  };
}

export function cards(partial: Partial<CardsByKind>): CardsByKind {
  return { requirements: [], successions: [], counts: [], affinities: [], coverings: [], ...partial };
}

export const people = (...ids: string[]): UiPerson[] => ids.map((id) => ({ id }));

export function requirement(
  uid: string,
  shift: string,
  requiredNumPeople: number,
  extra: Partial<RequirementCard> = {},
): RequirementCard {
  return {
    uid,
    description: uid,
    shiftType: [shift],
    requiredNumPeople,
    qualifiedPeople: ["ALL"],
    date: ["ALL"],
    weight: -1,
    ...extra,
  };
}

/** A hard "at most `target` nights per nurse this period" rule for one group. */
export function nightCap(uid: string, group: string, target: number): CountCard {
  return {
    uid,
    description: `At most ${target} nights`,
    person: [group],
    countDates: ["ALL"],
    countShiftTypes: ["N"],
    expression: "x <= T",
    target,
    weight: Infinity,
  };
}

export const leave = (person: string, date: string): UiRequestCell => ({
  uid: `leave-${person}-${date}`,
  person,
  date,
  kind: "leave",
});

const OTHER_NIGHTS = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-06", "2026-11-07"];

export const SCENARIOS = {
  /** A brand-new scenario: nothing set up. */
  empty: (): ScenarioUiState => createEmptyScenarioUiState(),
  /** Night on the 5th needs 3 (high acuity); with 1 on days the 3 nurses cannot cover it. */
  understaffedNight: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben", "cara"),
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 1, { date: OTHER_NIGHTS }),
          requirement("night-05", "N", 3, {
            date: ["2026-11-05"],
            description: "Night on the 5th (high acuity)",
          }),
        ],
      }),
    }),
  /** Every night needs 1 RN; the only RN is on leave on the 3rd. */
  onlyRnOnLeave: (): ScenarioUiState =>
    ward({
      staff: people("rn1", "en1", "en2"),
      staffGroups: [{ id: "RN", members: ["rn1"] }],
      reqData: [leave("rn1", "03")],
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night-rn", "N", 1, { qualifiedPeople: ["RN"], description: "1 RN every night" }),
        ],
      }),
    }),
  /** 7 nights to fill, but "at most 1 night each" lets 4 nurses cover only 4. */
  ruleTooStrict: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben", "cara", "dev"),
      staffGroups: [{ id: "Nurses", members: ["ana", "ben", "cara", "dev"] }],
      cardsByKind: cards({
        requirements: [requirement("day", "D", 1), requirement("night", "N", 1)],
        counts: [nightCap("max-nights", "Nurses", 1)],
      }),
    }),
  /** Day, evening and night each need 1, every day, with only 2 nurses. */
  tooFewNurses: (): ScenarioUiState =>
    ward({
      shifts: [
        { id: "D", description: "Day" },
        { id: "E", description: "Evening" },
        { id: "N", description: "Night" },
      ],
      staff: people("ana", "ben"),
      cardsByKind: cards({
        requirements: [requirement("day", "D", 1), requirement("eve", "E", 1), requirement("night", "N", 1)],
      }),
    }),
  /** 2 nurses, day + night each day, no day after a night and no two nights in a row. */
  restRuleTooTight: (): ScenarioUiState =>
    ward({
      staff: people("ana", "ben"),
      staffGroups: [{ id: "Nurses", members: ["ana", "ben"] }],
      cardsByKind: cards({
        requirements: [requirement("day", "D", 1), requirement("night", "N", 1)],
        successions: [
          {
            uid: "no-day-after-night",
            description: "No day shift straight after a night",
            person: ["Nurses"],
            pattern: ["N", "D"],
            weight: -Infinity,
          },
          {
            uid: "no-double-night",
            description: "No two nights in a row",
            person: ["Nurses"],
            pattern: ["N", "N"],
            weight: -Infinity,
          },
        ],
      }),
    }),
} as const satisfies Record<string, () => ScenarioUiState>;

export type ScenarioName = keyof typeof SCENARIOS;
```

- [ ] **Step 2: Write the failing tests**

Create `web/lib/rules/shortfalls.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { capOf, findStaffingShortfalls, toDateId } from "./shortfalls";
import { SCENARIOS, cards, leave, people, requirement, ward } from "./ward-fixtures.test-support";

describe("findStaffingShortfalls", () => {
  it("finds nothing in an empty scenario", () => {
    expect(findStaffingShortfalls(SCENARIOS.empty())).toEqual([]);
  });

  it("reports the only RN on leave as a skill-mix requirement shortfall", () => {
    const findings = findStaffingShortfalls(SCENARIOS.onlyRnOnLeave());
    expect(findings).toEqual([
      {
        kind: "requirement_short",
        dateId: "03",
        iso: "2026-11-03",
        shiftTypes: ["N"],
        ruleIds: ["night-rn"],
        required: 1,
        available: 0,
        away: [{ person: "rn1", reason: "leave" }],
        capRuleIds: [],
        skillMix: true,
      },
    ]);
  });

  it("reports a day that needs more nurses than it has across separate shifts", () => {
    const findings = findStaffingShortfalls(SCENARIOS.understaffedNight());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "day_short",
      dateId: "05",
      required: 4,
      available: 3,
      ruleIds: ["night-05", "day"],
      skillMix: false,
    });
  });

  it("reports hard count caps that cannot supply a requirement over the period", () => {
    expect(findStaffingShortfalls(SCENARIOS.ruleTooStrict())).toEqual([
      expect.objectContaining({
        kind: "cap_short",
        dateId: null,
        shiftTypes: ["N"],
        ruleIds: ["night"],
        required: 7,
        available: 4,
        capRuleIds: ["max-nights"],
      }),
    ]);
  });

  it("reports every day of a chronically short ward", () => {
    const findings = findStaffingShortfalls(SCENARIOS.tooFewNurses());
    expect(findings.map((f) => [f.kind, f.dateId, f.required, f.available])).toEqual(
      ["01", "02", "03", "04", "05", "06", "07"].map((d) => ["day_short", d, 3, 2]),
    );
  });

  it("stays silent on infeasibility it does not model (rest rules)", () => {
    expect(findStaffingShortfalls(SCENARIOS.restRuleTooTight())).toEqual([]);
  });

  it("treats an ISO-dated leave cell as the same day as its span id", () => {
    const iso = { ...SCENARIOS.onlyRnOnLeave(), reqData: [leave("rn1", "2026-11-03")] };
    expect(findStaffingShortfalls(iso).map((f) => f.dateId)).toEqual(["03"]);
  });

  it("expands a group leave row to its members", () => {
    const grouped = { ...SCENARIOS.onlyRnOnLeave(), reqData: [leave("RN", "03")] };
    expect(findStaffingShortfalls(grouped)[0].away).toEqual([{ person: "rn1", reason: "leave" }]);
  });

  it("counts a hard day off and a hard 'never' request as away, but not soft ones", () => {
    const base = SCENARIOS.onlyRnOnLeave();
    const hardOff = { ...base, reqData: [{ uid: "o", person: "rn1", date: "03", kind: "off" as const, weight: Infinity }] };
    const softOff = { ...base, reqData: [{ uid: "o", person: "rn1", date: "03", kind: "off" as const, weight: 5 }] };
    const never = {
      ...base,
      reqData: [{ uid: "r", person: "rn1", date: "03", kind: "request" as const, shiftType: "N", weight: -Infinity }],
    };
    expect(findStaffingShortfalls(hardOff)[0].away[0].reason).toBe("day_off");
    expect(findStaffingShortfalls(softOff)).toEqual([]);
    expect(findStaffingShortfalls(never)[0].away[0].reason).toBe("never_request");
  });

  it("ignores disabled requirements and ones with coefficients", () => {
    const state = ward({
      staff: people("ana"),
      cardsByKind: cards({
        requirements: [
          requirement("off", "D", 5, { disabled: true }),
          requirement("coef", "N", 5, { shiftTypeCoefficients: [["N", 2]] }),
        ],
      }),
    });
    expect(findStaffingShortfalls(state)).toEqual([]);
  });
});

describe("capOf", () => {
  it("reads every hard upper bound and nothing else", () => {
    expect(capOf("x <= T", 5, Infinity)).toBe(5);
    expect(capOf("x < T", 5, Infinity)).toBe(4);
    expect(capOf("x = T", 5, Infinity)).toBe(5);
    expect(capOf("x > T", 5, -Infinity)).toBe(5);
    expect(capOf("x >= T", 5, -Infinity)).toBe(4);
    expect(capOf("|x - T|^2", 5, -Infinity)).toBe(5);
    expect(capOf("x >= T", 5, Infinity)).toBe(Infinity);
    expect(capOf("x <= T", 5, -3)).toBe(Infinity);
  });
});

describe("toDateId", () => {
  it("maps an in-range ISO date onto the span id and leaves other refs alone", () => {
    const range = { start: "2026-11-01", end: "2026-11-07" };
    expect(toDateId("2026-11-05", range)).toBe("05");
    expect(toDateId("05", range)).toBe("05");
    expect(toDateId("WEEKDAY", range)).toBe("WEEKDAY");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && pnpm vitest run lib/rules/shortfalls.test.ts`
Expected: FAIL, "Cannot find module './shortfalls'".

- [ ] **Step 4: Write the implementation**

Create `web/lib/rules/shortfalls.ts`:

```ts
// Static staffing check: shortfalls the solver is certain to reject.
//
// Pure, React-free and AI-free (the assistant reads it, a non-AI screen may show it).
// Every finding is a PROOF, not a hint. Each check uses only hard facts:
// `requiredNumPeople` is a hard floor, leave pins and hard day-offs, hard "never"
// shift requests, hard count caps, and the always-on "at most one shift per day".
// That is what lets the assistant state a finding as the cause (the evidence
// contract's first rule, diagnostic-explanations.ts).
//
// ponytail: ignores successions, affinities, coverings, coefficient-weighted
// requirements/counts and minimum counts; those infeasibilities surface only from a
// real run. Add a check here when a real ward hits one.

import {
  RESERVED_SHIFT_TYPE,
  isDayStateSelector,
  type DateRef,
  type RequirementCard,
  type ScenarioUiState,
  type UiRequestCell,
} from "@/lib/scenario";
import { generateDateItems, getDateIdForRange, isValidIso } from "@/lib/dates/date-id";
import { deriveDateGroups } from "@/lib/dates/derived-groups";
import { expandDateRefs, expandPersonRefs, expandShiftTypeRefs, flattenShiftTypeRefs } from "./expansion";

export type StaffingFindingKind = "requirement_short" | "day_short" | "cap_short";
export type AwayReason = "leave" | "day_off" | "never_request";

export interface StaffingFinding {
  kind: StaffingFindingKind;
  /** Span-formatted date id; `null` for a whole-period `cap_short`. */
  dateId: string | null;
  iso: string | null;
  /** Worked shift ids the finding is about. */
  shiftTypes: string[];
  /** Requirement card uids involved, largest head count first. */
  ruleIds: string[];
  /** People needed that date, or shifts needed over the period (`cap_short`). */
  required: number;
  /** People free that date, or shifts the caps allow (`cap_short`). */
  available: number;
  /** Qualified people who would count but are away that date. */
  away: { person: string; reason: AwayReason }[];
  /** Hard count rules that bound supply (`cap_short` only). */
  capRuleIds: string[];
  /** A requirement involved counts only a named group or people (skill mix). */
  skillMix: boolean;
}

type Range = { start: string; end: string };
type Block = { reason: AwayReason; shifts: Set<string> | "all" };

interface Equation {
  ruleId: string;
  shiftTypes: Set<string>;
  qualified: Set<string>;
  dateIds: Set<string>;
  required: number;
  skillMix: boolean;
}

interface Cap {
  ruleId: string;
  people: Set<string>;
  shiftTypes: Set<string>;
  dateIds: Set<string>;
  cap: number;
}

const asList = <T>(value: T | T[] | null | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const isAllRef = (ref: unknown) => String(ref).toUpperCase() === RESERVED_SHIFT_TYPE.all;

/** An in-range ISO date becomes its span id; every other ref is returned as written. */
export function toDateId(ref: DateRef, range: Range): string {
  const key = String(ref);
  return isValidIso(key) ? getDateIdForRange(key, range) : key;
}

/** The most shifts a hard count lets one person work, or `Infinity` when it is no hard upper bound. */
export function capOf(expression: string, target: number, weight: number): number {
  if (weight === Infinity) {
    if (expression === "x <= T" || expression === "x = T") return target;
    if (expression === "x < T") return target - 1;
  }
  if (weight === -Infinity) {
    if (expression === "x > T" || expression === "|x - T|^2") return target;
    if (expression === "x >= T") return target - 1;
  }
  return Infinity;
}

function makeDates(state: ScenarioUiState) {
  const range = { start: state.rangeStart, end: state.rangeEnd };
  const items = generateDateItems(range);
  const allDateIds = items.map((item) => item.id);
  const derived = deriveDateGroups(items);
  const expand = (refs: DateRef[]) =>
    expandDateRefs(refs.map((ref) => toDateId(ref, range)), state, allDateIds, derived);
  return { range, items, allDateIds, expand };
}

/** The span ids a requirement covers in this roster period. */
export function requirementDateIds(state: ScenarioUiState, card: RequirementCard): string[] {
  const { allDateIds, expand } = makeDates(state);
  const covered = expand(card.date == null ? [RESERVED_SHIFT_TYPE.all] : asList(card.date));
  return allDateIds.filter((id) => covered.has(id));
}

export function findStaffingShortfalls(state: ScenarioUiState): StaffingFinding[] {
  const { items, allDateIds, expand } = makeDates(state);
  if (items.length === 0 || state.staff.length === 0) return [];
  const isoById = new Map(items.map((item) => [item.id, item.iso]));
  const staffIds = new Set(state.staff.map((person) => String(person.id)));
  const workedIds = state.shifts.map((shift) => String(shift.id)).filter((id) => !isDayStateSelector(id));
  const shiftsOf = (selector: string): Set<string> =>
    isAllRef(selector) ? new Set(workedIds) : expandShiftTypeRefs([selector], state);
  const peopleOf = (refs: Parameters<typeof expandPersonRefs>[0]) =>
    new Set([...expandPersonRefs(refs, state)].filter((id) => staffIds.has(id)));

  const equations = buildEquations(state, expand, peopleOf);
  const away = buildAway(state, expand, shiftsOf, peopleOf);
  const caps = buildCaps(state, expand, shiftsOf, peopleOf);
  const findings: StaffingFinding[] = [];

  // requirement_short: one equation needs more of its qualified people than are free.
  for (const eq of equations) {
    for (const dateId of eq.dateIds) {
      if (!isoById.has(dateId)) continue;
      const row = away.get(dateId);
      const gone = [...eq.qualified].filter((p) => isAway(row?.get(p), eq.shiftTypes));
      const free = eq.qualified.size - gone.length;
      if (free >= eq.required) continue;
      findings.push({
        kind: "requirement_short",
        dateId,
        iso: isoById.get(dateId) ?? null,
        shiftTypes: [...eq.shiftTypes],
        ruleIds: [eq.ruleId],
        required: eq.required,
        available: free,
        away: gone.map((person) => ({ person, reason: row!.get(person)!.reason })),
        capRuleIds: [],
        skillMix: eq.skillMix,
      });
    }
  }

  // day_short: equations over separate shifts need more people than are free that day.
  // Each person works at most one shift per day, so any set of equations with disjoint
  // shift sets needs that many DIFFERENT people. Both kinds can report the same date: the
  // day-level gap can be larger than any one requirement's (repair-options uses the max).
  for (const dateId of allDateIds) {
    const chosen: Equation[] = [];
    const used = new Set<string>();
    const today = equations.filter((eq) => eq.dateIds.has(dateId)).sort((a, b) => b.required - a.required);
    for (const eq of today) {
      if ([...eq.shiftTypes].some((s) => used.has(s))) continue;
      chosen.push(eq);
      eq.shiftTypes.forEach((s) => used.add(s));
    }
    if (chosen.length < 2) continue;
    const row = away.get(dateId);
    const pool = new Set<string>();
    const gone = new Map<string, AwayReason>();
    for (const eq of chosen) {
      for (const p of eq.qualified) {
        const block = row?.get(p);
        if (isAway(block, eq.shiftTypes)) gone.set(p, block!.reason);
        else pool.add(p);
      }
    }
    const required = chosen.reduce((sum, eq) => sum + eq.required, 0);
    if (pool.size >= required) continue;
    findings.push({
      kind: "day_short",
      dateId,
      iso: isoById.get(dateId) ?? null,
      shiftTypes: chosen.flatMap((eq) => [...eq.shiftTypes]),
      ruleIds: chosen.map((eq) => eq.ruleId),
      required,
      available: pool.size,
      away: [...gone].filter(([p]) => !pool.has(p)).map(([person, reason]) => ({ person, reason })),
      capRuleIds: [],
      skillMix: chosen.some((eq) => eq.skillMix),
    });
  }

  // cap_short: over the period, the qualified people may not work enough of these shifts.
  for (const eq of equations) {
    const dates = [...eq.dateIds].filter((d) => isoById.has(d));
    const demand = eq.required * dates.length;
    let supply = 0;
    const binding = new Set<string>();
    for (const p of eq.qualified) {
      const freeDays = dates.filter((d) => !isAway(away.get(d)?.get(p), eq.shiftTypes)).length;
      const cap = caps
        .filter(
          (c) =>
            c.people.has(p) &&
            [...eq.shiftTypes].every((s) => c.shiftTypes.has(s)) &&
            dates.every((d) => c.dateIds.has(d)),
        )
        .sort((a, b) => a.cap - b.cap)[0];
      if (cap && cap.cap < freeDays) {
        supply += Math.max(cap.cap, 0);
        binding.add(cap.ruleId);
      } else {
        supply += freeDays;
      }
    }
    if (supply >= demand || binding.size === 0) continue;
    findings.push({
      kind: "cap_short",
      dateId: null,
      iso: null,
      shiftTypes: [...eq.shiftTypes],
      ruleIds: [eq.ruleId],
      required: demand,
      available: supply,
      away: [],
      capRuleIds: [...binding],
      skillMix: eq.skillMix,
    });
  }

  const order = new Map(allDateIds.map((id, index) => [id, index]));
  return findings.sort(
    (a, b) => (order.get(a.dateId ?? "") ?? -1) - (order.get(b.dateId ?? "") ?? -1),
  );
}

function buildEquations(
  state: ScenarioUiState,
  expand: (refs: DateRef[]) => Set<string>,
  peopleOf: (refs: RequirementCard["qualifiedPeople"]) => Set<string>,
): Equation[] {
  const out: Equation[] = [];
  for (const card of state.cardsByKind.requirements) {
    // ponytail: with coefficients a person can count more than once; skipped.
    if (card.disabled || card.shiftTypeCoefficients?.length) continue;
    const refs = asList(card.qualifiedPeople);
    const skillMix = refs.length > 0 && !refs.some(isAllRef);
    const qualified = peopleOf(card.qualifiedPeople);
    const dateIds = expand(card.date == null ? [RESERVED_SHIFT_TYPE.all] : asList(card.date));
    const selectors = Array.isArray(card.shiftType) ? card.shiftType : [card.shiftType];
    for (const selector of selectors) {
      const shiftTypes = new Set(
        [...expandShiftTypeRefs(flattenShiftTypeRefs(selector), state)].filter((id) => !isDayStateSelector(id)),
      );
      if (shiftTypes.size === 0) continue;
      out.push({ ruleId: card.uid, shiftTypes, qualified, dateIds, required: card.requiredNumPeople, skillMix });
    }
  }
  return out;
}

function blockOf(cell: UiRequestCell, shiftsOf: (selector: string) => Set<string>): Block | null {
  if (cell.kind === "leave") return { reason: "leave", shifts: "all" };
  if (cell.kind === "off") return cell.weight === Infinity ? { reason: "day_off", shifts: "all" } : null;
  return cell.weight === -Infinity ? { reason: "never_request", shifts: shiftsOf(String(cell.shiftType)) } : null;
}

function mergeBlock(a: Block | undefined, b: Block): Block {
  if (!a) return b;
  if (a.shifts === "all") return a;
  if (b.shifts === "all") return b;
  return { reason: a.reason, shifts: new Set([...a.shifts, ...b.shifts]) };
}

function isAway(block: Block | undefined, shifts: Set<string>): boolean {
  if (!block) return false;
  if (block.shifts === "all") return true;
  const blocked = block.shifts;
  return [...shifts].every((s) => blocked.has(s));
}

function buildAway(
  state: ScenarioUiState,
  expand: (refs: DateRef[]) => Set<string>,
  shiftsOf: (selector: string) => Set<string>,
  peopleOf: (refs: UiRequestCell["person"]) => Set<string>,
): Map<string, Map<string, Block>> {
  const byDate = new Map<string, Map<string, Block>>();
  for (const cell of state.reqData) {
    const block = blockOf(cell, shiftsOf);
    if (!block) continue;
    for (const dateId of expand([cell.date])) {
      const row = byDate.get(dateId) ?? new Map<string, Block>();
      byDate.set(dateId, row);
      for (const person of peopleOf(cell.person)) row.set(person, mergeBlock(row.get(person), block));
    }
  }
  return byDate;
}

function buildCaps(
  state: ScenarioUiState,
  expand: (refs: DateRef[]) => Set<string>,
  shiftsOf: (selector: string) => Set<string>,
  peopleOf: (refs: ScenarioUiState["cardsByKind"]["counts"][number]["person"]) => Set<string>,
): Cap[] {
  const caps: Cap[] = [];
  for (const card of state.cardsByKind.counts) {
    // ponytail: hours-weighted counts are skipped.
    if (card.disabled || card.countShiftTypeCoefficients?.length) continue;
    const targets = asList(card.target);
    const cap = Math.min(
      ...asList(card.expression).map((expression, i) => capOf(expression, targets[i] ?? Infinity, card.weight)),
    );
    if (!Number.isFinite(cap)) continue;
    caps.push({
      ruleId: card.uid,
      people: peopleOf(card.person),
      shiftTypes: new Set(asList(card.countShiftTypes).flatMap((s) => [...shiftsOf(String(s))])),
      dateIds: expand(asList(card.countDates)),
      cap,
    });
  }
  return caps;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run lib/rules/shortfalls.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Typecheck and lint the new files**

Run: `cd web && pnpm typecheck && pnpm exec oxlint lib/rules`
Expected: no errors. (`lib/rules` must not import `@/lib/ai/**`; oxlint reports it if it does.)

- [ ] **Step 7: Commit**

```bash
git add web/lib/rules/shortfalls.ts web/lib/rules/shortfalls.test.ts web/lib/rules/ward-fixtures.test-support.ts
git commit -m "feat(rules): static staffing check proves short days, shifts and caps"
```

---

### Task 2: Playbook data

**Files:**
- Create: `web/lib/ai/assistant/playbook.ts`
- Test: `web/lib/ai/assistant/playbook.test.ts`

**Interfaces:**
- Consumes: `CapabilityId` (`@/lib/capability/help-content`), `AssistantCommandType`, `ASSISTANT_COMMAND_TYPES` (`@/lib/proposal/commands`), `MODEL_VISIBLE_TOOL_SCHEMAS`, `PARAMETERLESS_MODEL_VISIBLE_TOOLS` (test only).
- Produces (all exported from `playbook.ts`):
  - `PLAYBOOK_VERSION = "2026-09-24.1"`
  - `type SetupStepId = "dates" | "people" | "shiftTypes" | "rules" | "requests" | "run" | "review"`
  - `interface SetupStepGuide { id: SetupStepId; label: string; optional: boolean; capabilityId: CapabilityId; ask: readonly string[]; proposeWith: readonly string[] }`
  - `SETUP_STEPS: readonly SetupStepGuide[]`, `SETUP_INSTRUCTIONS: readonly string[]`
  - `OPTIMIZE_RUN_TOOL`, `OPTIMIZE_RESULT_TOOL`
  - `type RepairId = "soften_hard_request" | "extra_shift_willing_nurse" | "relax_count_rule" | "borrow_temporary_nurse" | "ask_nurse_on_leave" | "run_one_short" | "split_long_shift"`
  - `type Confirmation = "manager" | "named_nurse" | "lending_ward"`, `type EnforcedBy = "apply" | "host_question" | "chat"`
  - `interface RepairEntry { id; title; whenToUse; disruption: "low" | "medium" | "high"; confirmation: Confirmation; enforcedBy: EnforcedBy; opTypes: readonly AssistantCommandType[]; guardrail: string }`
  - `REPAIRS: readonly RepairEntry[]`
  - `type Situation = "capped" | "acute" | "chronic" | "unexplained"`, `REPAIR_ORDER: Record<Situation, readonly RepairId[]>`
  - `CHRONIC_DATE_COUNT = 3`, `MAX_CAP_RAISE = 2`, `MAX_OPTIONS = 3`, `MAX_BORROWED = 3`, `MAX_EXPLAINED_FINDINGS = 5`, `SOFT_REQUEST_WEIGHT = 10`, `LONG_SHIFT_MINUTES = 660`
  - `SAFETY_FLOOR: readonly string[]`, `FEASIBILITY_INSTRUCTIONS: readonly string[]`

- [ ] **Step 1: Write the failing test**

Create `web/lib/ai/assistant/playbook.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "@/components/ai/model-visible-tools";
import { getNavGroupsForMode } from "@/components/shell/nav-config";
import { CAPABILITY_ENTRIES } from "@/lib/capability/help-content";
import { ASSISTANT_COMMAND_TYPES } from "@/lib/proposal/commands";
import {
  PLAYBOOK_VERSION,
  REPAIRS,
  REPAIR_ORDER,
  SAFETY_FLOOR,
  SETUP_STEPS,
} from "./playbook";

describe("setup steps", () => {
  it("follow the Home guided order, then review", () => {
    // The Home cards and the assistant must walk the same order, or the user sees two plans.
    const HOME_PATH: Record<string, string> = {
      "/dates": "dates",
      "/people": "people",
      "/shift-types": "shiftTypes",
      "/rules": "rules",
      "/shift-requests": "requests",
      "/optimize-and-export": "run",
    };
    const home = getNavGroupsForMode("guided")
      .flatMap((group) => group.items)
      .filter((item) => item.guidedStep != null)
      .sort((a, b) => (a.guidedStep ?? 0) - (b.guidedStep ?? 0))
      .map((item) => HOME_PATH[item.path]);
    expect(SETUP_STEPS.map((step) => step.id)).toEqual([...home, "review"]);
  });

  it("only name operations and tools the app ships", () => {
    // Fails until the dependency plans land with these exact names (see Preconditions).
    const shipped = new Set<string>([
      ...ASSISTANT_COMMAND_TYPES,
      ...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS),
      ...PARAMETERLESS_MODEL_VISIBLE_TOOLS,
    ]);
    for (const step of SETUP_STEPS) {
      for (const name of step.proposeWith) expect(shipped.has(name), `${step.id}: ${name}`).toBe(true);
    }
  });

  it("point at real capability ids, and only requests is optional", () => {
    const ids = new Set<string>(CAPABILITY_ENTRIES.map((entry) => entry.id));
    for (const step of SETUP_STEPS) expect(ids.has(step.capabilityId), step.id).toBe(true);
    expect(SETUP_STEPS.filter((step) => step.optional).map((step) => step.id)).toEqual(["requests"]);
  });
});

describe("repair catalogue", () => {
  it("has a version, unique ids, and every ranked id exists", () => {
    expect(PLAYBOOK_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    const ids = REPAIRS.map((repair) => repair.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const order of Object.values(REPAIR_ORDER)) {
      for (const id of order) expect(ids).toContain(id);
    }
  });

  it("asks a named nurse only through a host question", () => {
    for (const repair of REPAIRS) {
      if (repair.confirmation === "named_nurse" && repair.opTypes.some((op) => op === "clear_requests")) {
        expect(repair.enforcedBy).toBe("host_question");
      }
    }
  });

  it("never lists a rest, supervision or rule-removal operation", () => {
    const banned = ["set_rule_enabled", "remove_rule", "add_succession_rule", "edit_succession_rule"];
    for (const repair of REPAIRS) {
      for (const op of repair.opTypes) expect(banned, `${repair.id}: ${op}`).not.toContain(op);
    }
  });

  it("states the safety floor in ward words", () => {
    const text = SAFETY_FLOOR.join(" ");
    expect(text).toMatch(/rest/i);
    expect(text).toMatch(/RN|skill/);
    expect(text).toMatch(/sick/i);
    expect(text).toMatch(/0|zero/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm vitest run lib/ai/assistant/playbook.test.ts`
Expected: FAIL, "Cannot find module './playbook'".

- [ ] **Step 3: Write the implementation**

Create `web/lib/ai/assistant/playbook.ts`:

```ts
// The assistant's playbook: how to guide setup and how to repair an infeasible
// schedule, as TYPED, VERSIONED DATA rather than one long prompt string.
//
// Tool results carry these values (get_setup_progress, suggest_feasibility_options),
// so they reach the model only when they are relevant, and a test can hold every
// line to account. Bump PLAYBOOK_VERSION on any change to the wording or order.
//
// The repair order follows ward practice: remove a preference before touching
// people, use willing staff and the float pool before asking someone on leave, and
// run a shift short only as the manager's last call. The safety floor is never
// crossed (enforced again in code by repair-options.ts `isSafeOption`).

import type { CapabilityId } from "@/lib/capability/help-content";
import type { AssistantCommandType } from "@/lib/proposal/commands";

export const PLAYBOOK_VERSION = "2026-09-24.1";

/** Names from plan 2026-09-24-assistant-optimize-run. Change here only. */
export const OPTIMIZE_RUN_TOOL = "request_optimize_run";
export const OPTIMIZE_RESULT_TOOL = "get_optimize_result";

export type SetupStepId = "dates" | "people" | "shiftTypes" | "rules" | "requests" | "run" | "review";

export interface SetupStepGuide {
  id: SetupStepId;
  label: string;
  optional: boolean;
  capabilityId: CapabilityId;
  /** The minimum facts to ask for. Ask only what the schedule does not already say. */
  ask: readonly string[];
  /** Operations (prepare_scenario_change arms) or tools this step uses. */
  proposeWith: readonly string[];
}

export const SETUP_STEPS: readonly SetupStepGuide[] = [
  {
    id: "dates",
    label: "Set the dates",
    optional: false,
    capabilityId: "roster-period",
    ask: ["The first and last day of the roster.", "Whether to import the public holidays."],
    proposeWith: ["set_roster_range"],
  },
  {
    id: "people",
    label: "Add your staff",
    optional: false,
    capabilityId: "staff-list",
    ask: [
      "The nurses' names, as they should appear on the roster.",
      "Which of them are RNs, seniors or in another group that a rule will need.",
    ],
    proposeWith: ["add_person", "add_people_group"],
  },
  {
    id: "shiftTypes",
    label: "Define the shifts",
    optional: false,
    capabilityId: "shift-types",
    ask: ["Each shift's code, start time, end time and unpaid break."],
    proposeWith: ["add_shift_type", "add_shift_group"],
  },
  {
    id: "rules",
    label: "Set staffing and rules",
    optional: false,
    capabilityId: "staffing-requirements",
    ask: [
      "How many nurses each shift needs, and how many of them must be from a group such as RNs.",
      "The rest rules the ward uses, for example no day shift straight after a night.",
      "Limits such as the most nights one nurse may work in the period.",
    ],
    proposeWith: ["add_staffing_requirement", "add_succession_rule", "add_count_rule"],
  },
  {
    id: "requests",
    label: "Requests and leave",
    optional: true,
    capabilityId: "leave-and-requests",
    ask: ["Who has leave or a fixed day off in this period, and on which days. 'Nobody' is a fine answer."],
    proposeWith: ["add_leave", "set_off_request", "set_shift_request"],
  },
  {
    id: "run",
    label: "Generate the roster",
    optional: false,
    capabilityId: "generate-roster",
    ask: ["Whether to run Optimize now."],
    proposeWith: [OPTIMIZE_RUN_TOOL],
  },
  {
    id: "review",
    label: "Review the roster",
    optional: false,
    capabilityId: "roster-viewer",
    ask: [],
    proposeWith: [OPTIMIZE_RESULT_TOOL],
  },
];

export const SETUP_INSTRUCTIONS: readonly string[] = [
  "Work on nextStep only. Ask its questions that the schedule does not already answer, all at once, in plain words.",
  "Never guess a date, number, name or time. If the user is unsure, offer a common ward default and ask them to confirm it.",
  "Put the whole step in one prepare_scenario_change (split it only above the operation limit), say what Apply will do, and stop.",
  "After the user applies, call get_setup_progress again and continue with the new nextStep.",
  "If the user says an optional step does not apply (for example nobody has leave), move on to the step after it.",
  "If knownGaps is above 0, call suggest_feasibility_options before offering to run Optimize.",
];

export type RepairId =
  | "soften_hard_request"
  | "extra_shift_willing_nurse"
  | "relax_count_rule"
  | "borrow_temporary_nurse"
  | "ask_nurse_on_leave"
  | "run_one_short"
  | "split_long_shift";

/** Who must agree before the change is real. */
export type Confirmation = "manager" | "named_nurse" | "lending_ward";
/** How that agreement is captured: the Apply press itself, a host question on the Preview, or chat only. */
export type EnforcedBy = "apply" | "host_question" | "chat";

export interface RepairEntry {
  id: RepairId;
  title: string;
  whenToUse: string;
  disruption: "low" | "medium" | "high";
  confirmation: Confirmation;
  enforcedBy: EnforcedBy;
  /** Empty for advice-only repairs (the assistant opens the screen instead). */
  opTypes: readonly AssistantCommandType[];
  guardrail: string;
}

export const REPAIRS: readonly RepairEntry[] = [
  {
    id: "soften_hard_request",
    title: "Turn a hard shift request into a strong preference",
    whenToUse: "A hard 'must' or 'never' request takes away the qualified nurse a shift needs.",
    disruption: "low",
    confirmation: "named_nurse",
    enforcedBy: "chat",
    opTypes: ["set_shift_request"],
    guardrail: "Keep it hard if it is for health, childcare or another formal agreement.",
  },
  {
    id: "extra_shift_willing_nurse",
    title: "One extra shift for a willing nurse",
    whenToUse: "A nurse's own hard limit is what starves the shift.",
    disruption: "medium",
    confirmation: "named_nurse",
    enforcedBy: "host_question",
    opTypes: ["edit_count_rule"],
    guardrail: "Only within legal rest and contract limits, and only with that nurse's agreement.",
  },
  {
    id: "relax_count_rule",
    title: "Relax one named limit for this period",
    whenToUse: "A team-wide hard limit (for example the most nights each) cannot cover the demand.",
    disruption: "medium",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: ["edit_count_rule"],
    guardrail: "Raise by the smallest amount that closes the gap, at most 2, and ask the manager to check legal limits.",
  },
  {
    id: "borrow_temporary_nurse",
    title: "Borrow a float, agency or other-ward nurse for the short dates",
    whenToUse: "The ward has too few free nurses on some dates.",
    disruption: "medium",
    confirmation: "lending_ward",
    enforcedBy: "host_question",
    opTypes: ["add_person", "mark_person_off"],
    guardrail: "Put her in a skill group only when the manager confirms her qualification. Never invent a name.",
  },
  {
    id: "ask_nurse_on_leave",
    title: "Ask a named nurse on leave to cover one shift",
    whenToUse: "A qualified nurse is on leave on the one day that is one nurse short.",
    disruption: "high",
    confirmation: "named_nurse",
    enforcedBy: "host_question",
    opTypes: ["clear_requests"],
    guardrail: "One day only, only with her agreement, and never someone on sick or compassionate leave.",
  },
  {
    id: "run_one_short",
    title: "Run the shift one short on that date",
    whenToUse: "A head-count shift is one short and nobody else can be found.",
    disruption: "high",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: ["set_staffing_requirement_people", "edit_staffing_requirement", "add_staffing_requirement"],
    guardrail: "Head count only, never below 1, never a skill-mix requirement such as 1 RN per night.",
  },
  {
    id: "split_long_shift",
    title: "Split a long shift so part-timers can cover half",
    whenToUse: "A long shift (11 hours or more) is short.",
    disruption: "high",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: [],
    guardrail: "Advice only: open the Shifts screen, do not prepare it.",
  },
];

export type Situation = "capped" | "acute" | "chronic" | "unexplained";

export const REPAIR_ORDER: Record<Situation, readonly RepairId[]> = {
  capped: ["extra_shift_willing_nurse", "relax_count_rule", "borrow_temporary_nurse", "run_one_short"],
  acute: ["soften_hard_request", "borrow_temporary_nurse", "ask_nurse_on_leave", "run_one_short", "split_long_shift"],
  chronic: ["borrow_temporary_nurse", "run_one_short", "split_long_shift"],
  unexplained: ["soften_hard_request", "relax_count_rule", "borrow_temporary_nurse"],
};

/** More short dates than this is a staffing problem, not a bad day. */
export const CHRONIC_DATE_COUNT = 3;
export const MAX_CAP_RAISE = 2;
export const MAX_OPTIONS = 3;
export const MAX_BORROWED = 3;
export const MAX_EXPLAINED_FINDINGS = 5;
/** The strength a softened request gets (a finite weight the solver may break only if it must). */
export const SOFT_REQUEST_WEIGHT = 10;
export const LONG_SHIFT_MINUTES = 660;

export const SAFETY_FLOOR: readonly string[] = [
  "Never relax or turn off a rest rule, such as no day shift straight after a night.",
  "Never relax or turn off a supervision (preceptor) rule.",
  "Never lower a skill-mix requirement, such as 1 RN on every night.",
  "Never set a staffing requirement to 0 or turn one off.",
  "Never raise a limit by more than 2, or remove a limit.",
  "Never remove or move leave without the nurse's own agreement, and never ask a nurse on sick or compassionate leave.",
  "Never put a borrowed nurse in a skill group unless the manager confirms her qualification.",
  "Never invent a person's name.",
];

export const FEASIBILITY_INSTRUCTIONS: readonly string[] = [
  "Say in one or two sentences which day and shift is short and why, naming the numbers and who is away.",
  "Findings from the static check are certain and may be stated as the cause. If there are none, say the cause is unknown and that the options are guesses to test.",
  "Offer the options in order, one line each, saying who must agree. Offer no more than three.",
  "Ask every needsFromUser question before preparing an option. Never invent an answer.",
  "After an infeasible Optimize run, test the options' operations with test_feasibility_candidates before calling any option tested. Otherwise call it untested.",
  "Prepare only the option the user picks. The app then asks for the agreement it needs, and the user applies it and runs Optimize again.",
  "Never suggest anything in safetyFloor, even if the user asks.",
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && pnpm vitest run lib/ai/assistant/playbook.test.ts`
Expected: PASS (7 tests). If `only name operations and tools the app ships` fails on `request_optimize_run` / `get_optimize_result`, set the two constants to the merged optimize tool names and re-run. If it fails on an operation name, recheck the dependency arms (Preconditions).

- [ ] **Step 5: Commit**

```bash
git add web/lib/ai/assistant/playbook.ts web/lib/ai/assistant/playbook.test.ts
git commit -m "feat(assistant): typed, versioned setup and repair playbook"
```

---

### Task 3: Setup progress and the `get_setup_progress` tool

**Files:**
- Create: `web/lib/ai/assistant/setup-progress.ts`
- Test: `web/lib/ai/assistant/setup-progress.test.ts`
- Modify: `web/components/ai/use-context-tools.ts`
- Modify: `web/components/ai/model-visible-tools.ts` (`PARAMETERLESS_MODEL_VISIBLE_TOOLS`)
- Modify: `web/lib/capability/tools.ts` (`ASSISTANT_TOOL_NAMES`)
- Modify: `web/components/ai/assistant-conversation.tsx` (export `TOOL_ACTIVITY`, add a label)
- Modify: `web/lib/ai/phase-2-absence.test.ts` (`MODEL_VISIBLE_TOOLS`)
- Create: `web/components/ai/tool-activity.test.ts`

**Interfaces:**
- Consumes: `ScenarioSummary` type (`@/components/home/scenario-summary`, type-only), `computeScenarioSummary`, `computeCoverageWarnings` (`@/components/requirements/requirements-model`), `findStaffingShortfalls` (Task 1), `SETUP_STEPS`, `SETUP_INSTRUCTIONS`, `PLAYBOOK_VERSION` (Task 2), `useHotStore`, `pickScenario`, `useScenarioStore` (`@/lib/store`).
- Produces:
  - `interface SetupProgressInput { summary: Pick<ScenarioSummary, "ready" | "rosterMonthLabel" | "durationDays" | "peopleCount" | "staffGroupsCount" | "shiftTypesCount" | "rulesTotal" | "shiftRequestsCount">; runComplete: boolean; uncoveredShifts: readonly string[]; knownGaps: number }`
  - `interface SetupStepStatus { id: SetupStepId; label: string; optional: boolean; done: boolean; detail: string }`
  - `interface SetupProgress { playbookVersion: string; steps: SetupStepStatus[]; nextStep: (SetupStepStatus & Pick<SetupStepGuide, "ask" | "proposeWith" | "capabilityId">) | null; readyToRun: boolean; knownGaps: number; instructions: readonly string[] }`
  - `deriveSetupProgress(input: SetupProgressInput): SetupProgress`
  - Tool `get_setup_progress` (parameterless) returning `SetupProgress`.
  - `export const TOOL_ACTIVITY` from `assistant-conversation.tsx`.

- [ ] **Step 1: Write the failing progress test**

Create `web/lib/ai/assistant/setup-progress.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeScenarioSummary } from "@/components/home/scenario-summary";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import { deriveSetupProgress } from "./setup-progress";

const input = (scenario = SCENARIOS.empty()) => ({
  summary: computeScenarioSummary(scenario),
  runComplete: false,
  uncoveredShifts: [] as string[],
  knownGaps: 0,
});

describe("deriveSetupProgress", () => {
  it("starts an empty scenario at the dates step with its questions", () => {
    const progress = deriveSetupProgress(input());
    expect(progress.nextStep?.id).toBe("dates");
    expect(progress.nextStep?.ask.length).toBeGreaterThan(0);
    expect(progress.nextStep?.proposeWith).toContain("set_roster_range");
    expect(progress.readyToRun).toBe(false);
    expect(progress.steps.map((s) => s.id)).toEqual([
      "dates",
      "people",
      "shiftTypes",
      "rules",
      "requests",
      "run",
      "review",
    ]);
  });

  it("does not count rules as done while a shift has no staffing requirement", () => {
    const progress = deriveSetupProgress({ ...input(SCENARIOS.onlyRnOnLeave()), uncoveredShifts: ["E: ALL"] });
    const rules = progress.steps.find((s) => s.id === "rules");
    expect(rules?.done).toBe(false);
    expect(rules?.detail).toContain("E: ALL");
    expect(progress.nextStep?.id).toBe("rules");
  });

  it("is ready to run without any requests, because requests are optional", () => {
    const progress = deriveSetupProgress(input(SCENARIOS.ruleTooStrict()));
    expect(progress.steps.find((s) => s.id === "requests")).toMatchObject({ done: false, optional: true });
    expect(progress.readyToRun).toBe(true);
    expect(progress.nextStep?.id).toBe("requests");
  });

  it("reports known gaps so the assistant can warn before running", () => {
    expect(deriveSetupProgress({ ...input(SCENARIOS.onlyRnOnLeave()), knownGaps: 1 }).knownGaps).toBe(1);
  });

  it("moves to review only after a roster has been generated", () => {
    const progress = deriveSetupProgress({ ...input(SCENARIOS.onlyRnOnLeave()), runComplete: true });
    expect(progress.steps.find((s) => s.id === "run")?.done).toBe(true);
    expect(progress.nextStep?.id).toBe("review");
  });

  it("carries the playbook version and instructions", () => {
    const progress = deriveSetupProgress(input());
    expect(progress.playbookVersion).toMatch(/^\d{4}-/);
    expect(progress.instructions.join(" ")).toMatch(/get_setup_progress/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm vitest run lib/ai/assistant/setup-progress.test.ts`
Expected: FAIL, "Cannot find module './setup-progress'".

- [ ] **Step 3: Write the progress model**

Create `web/lib/ai/assistant/setup-progress.ts`:

```ts
// What is set up, what is missing, and what the assistant should do next.
//
// Derived from the SAME summary the Home "Build Your Roster" cards use
// (computeScenarioSummary), so the assistant and Home never disagree about a step.
// Two differences, both deliberate: Rules counts as done only when every worked shift
// has a staffing requirement on every date (one rule is not a finished setup), and
// Requests is optional ("nobody has leave" is a real answer).

import type { ScenarioSummary } from "@/components/home/scenario-summary";
import {
  PLAYBOOK_VERSION,
  SETUP_INSTRUCTIONS,
  SETUP_STEPS,
  type SetupStepGuide,
  type SetupStepId,
} from "./playbook";

export interface SetupProgressInput {
  summary: Pick<
    ScenarioSummary,
    | "ready"
    | "rosterMonthLabel"
    | "durationDays"
    | "peopleCount"
    | "staffGroupsCount"
    | "shiftTypesCount"
    | "rulesTotal"
    | "shiftRequestsCount"
  >;
  /** A roster has been generated (Home's own Generate rule: run.phase === "complete"). */
  runComplete: boolean;
  /** Shift/date pairs with no staffing requirement (computeCoverageWarnings items). */
  uncoveredShifts: readonly string[];
  /** How many static-check findings the scenario has now. */
  knownGaps: number;
}

export interface SetupStepStatus {
  id: SetupStepId;
  label: string;
  optional: boolean;
  done: boolean;
  detail: string;
}

export interface SetupProgress {
  playbookVersion: string;
  steps: SetupStepStatus[];
  nextStep: (SetupStepStatus & Pick<SetupStepGuide, "ask" | "proposeWith" | "capabilityId">) | null;
  readyToRun: boolean;
  knownGaps: number;
  instructions: readonly string[];
}

export function deriveSetupProgress(input: SetupProgressInput): SetupProgress {
  const s = input.summary;
  const uncovered = input.uncoveredShifts;
  const status: Record<SetupStepId, { done: boolean; detail: string }> = {
    dates: {
      done: s.ready.dates,
      detail: s.ready.dates
        ? `${s.rosterMonthLabel ?? "Range set"}, ${s.durationDays} days`
        : "No valid roster period yet",
    },
    people: { done: s.ready.people, detail: `${s.peopleCount} people, ${s.staffGroupsCount} groups` },
    shiftTypes: { done: s.ready.shiftTypes, detail: `${s.shiftTypesCount} shift types` },
    rules: {
      done: s.ready.rules && uncovered.length === 0,
      detail:
        uncovered.length > 0 ? `No staffing requirement for: ${uncovered.join("; ")}` : `${s.rulesTotal} rules`,
    },
    requests: { done: s.ready.requests, detail: `${s.shiftRequestsCount} requests or leave entered (optional)` },
    run: { done: input.runComplete, detail: input.runComplete ? "A roster has been generated" : "Not run yet" },
    review: { done: false, detail: "Go through the generated roster with the user" },
  };

  const steps = SETUP_STEPS.map((guide) => ({
    id: guide.id,
    label: guide.label,
    optional: guide.optional,
    ...status[guide.id],
  }));
  const readyToRun = steps
    .filter((step) => !step.optional && step.id !== "run" && step.id !== "review")
    .every((step) => step.done);
  const next = steps.find((step) => !step.done && (step.id !== "review" || input.runComplete));
  const guide = next ? SETUP_STEPS.find((g) => g.id === next.id) : undefined;

  return {
    playbookVersion: PLAYBOOK_VERSION,
    steps,
    nextStep:
      next && guide
        ? { ...next, ask: guide.ask, proposeWith: guide.proposeWith, capabilityId: guide.capabilityId }
        : null,
    readyToRun,
    knownGaps: input.knownGaps,
    instructions: SETUP_INSTRUCTIONS,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && pnpm vitest run lib/ai/assistant/setup-progress.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing locked-surface tests**

In `web/lib/ai/phase-2-absence.test.ts`, add to `MODEL_VISIBLE_TOOLS` after `"test_feasibility_candidates",`:

```ts
  // WIDENED DELIBERATELY (2026-09-24, plan assistant-guided-setup-and-repair): two
  // read-only tools. They read the scenario and return host-derived facts and playbook
  // options; neither writes anything nor names a roster.
  "get_setup_progress",
  "suggest_feasibility_options",
```

(`suggest_feasibility_options` is registered in Task 6. Until then this test fails on that one name. That is expected, and Task 6 makes it pass.)

Create `web/components/ai/tool-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TOOL_ACTIVITY } from "./assistant-conversation";
import { MODEL_VISIBLE_TOOL_SCHEMAS, PARAMETERLESS_MODEL_VISIBLE_TOOLS } from "./model-visible-tools";

describe("tool activity labels", () => {
  it("names what every shipped tool is doing, in the user's words", () => {
    const shipped = [...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS), ...PARAMETERLESS_MODEL_VISIBLE_TOOLS];
    for (const name of shipped) {
      expect(TOOL_ACTIVITY[name], `${name} has no activity label`).toMatch(/…$/);
    }
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd web && pnpm vitest run lib/ai/phase-2-absence.test.ts components/ai/tool-activity.test.ts`
Expected: FAIL. phase-2-absence: the registered set lacks `get_setup_progress`. tool-activity: `TOOL_ACTIVITY` is not exported.

- [ ] **Step 7: Register the tool and the labels**

In `web/components/ai/use-context-tools.ts`, add the imports:

```ts
import { useHotStore } from "@/lib/store";
import { computeScenarioSummary } from "@/components/home/scenario-summary";
import { computeCoverageWarnings } from "@/components/requirements/requirements-model";
import { findStaffingShortfalls } from "@/lib/rules/shortfalls";
import { deriveSetupProgress, type SetupProgress } from "@/lib/ai/assistant/setup-progress";
```

Inside `useModelVisibleTools`, after the `get_schedule_overview` registration:

```ts
  useParameterlessModelVisibleTool(
    {
      name: "get_setup_progress",
      agentId,
      description:
        "Check which set-up steps of this schedule are finished and what to do next. Call it " +
        "when the user wants to set up a schedule, asks what is left, or after they apply a " +
        "set-up change. Follow nextStep: ask only its questions, prepare that one step as one " +
        "change, and wait for the user to apply it before moving on.",
      handler: async () => readSetupProgress(),
    },
    [agentId, turnEpoch],
  );
```

At the bottom of the file:

```ts
/** Setup progress over the live committed projection. Never mutates. */
function readSetupProgress(): SetupProgress {
  const scenario = pickScenario(useScenarioStore.getState());
  const coverage = computeCoverageWarnings(scenario, scenario.cardsByKind.requirements);
  return deriveSetupProgress({
    summary: computeScenarioSummary(scenario),
    runComplete: useHotStore.getState().run.phase === "complete",
    uncoveredShifts: coverage.undefinedSection?.items ?? [],
    knownGaps: findStaffingShortfalls(scenario).length,
  });
}
```

In `web/components/ai/model-visible-tools.ts`, change `PARAMETERLESS_MODEL_VISIBLE_TOOLS` to:

```ts
export const PARAMETERLESS_MODEL_VISIBLE_TOOLS: readonly string[] = Object.freeze([
  "get_schedule_overview",
  "list_app_capabilities",
  "get_setup_progress",
]);
```

In `web/lib/capability/tools.ts`, add to `ASSISTANT_TOOL_NAMES` after `"get_schedule_section",`:

```ts
  // Read-only setup and feasibility reports (plan 2026-09-24 guided setup and repair).
  "get_setup_progress",
  "suggest_feasibility_options",
```

(`tools.test.ts` then fails on `suggest_feasibility_options` until Task 6 registers it. That is expected.)

In `web/components/ai/assistant-conversation.tsx`, change `const TOOL_ACTIVITY` to `export const TOOL_ACTIVITY` and add two entries:

```ts
  get_setup_progress: "Checking your set-up…",
  suggest_feasibility_options: "Looking for ways to fill the gaps…",
```

- [ ] **Step 8: Run the tests**

Run: `cd web && pnpm vitest run components/ai/tool-activity.test.ts lib/ai/assistant/setup-progress.test.ts lib/ai/runtime/model-visible-tools.test.ts components/ai/session-real-core.test.tsx`
Expected: PASS. (`phase-2-absence.test.ts` and `lib/capability/tools.test.ts` still fail on `suggest_feasibility_options` only. Task 6 makes them pass.)

- [ ] **Step 9: Typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm exec oxlint components/ai lib/ai`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add web/lib/ai/assistant/setup-progress.ts web/lib/ai/assistant/setup-progress.test.ts web/components/ai/use-context-tools.ts web/components/ai/model-visible-tools.ts web/lib/capability/tools.ts web/components/ai/assistant-conversation.tsx web/components/ai/tool-activity.test.ts web/lib/ai/phase-2-absence.test.ts
git commit -m "feat(assistant): get_setup_progress guides setup from the Home readiness"
```

---

### Task 4: Repair option ranking

**Files:**
- Create: `web/lib/ai/assistant/repair-options.ts`
- Test: `web/lib/ai/assistant/repair-options.test.ts`

**Interfaces:**
- Consumes: Task 1 (`StaffingFinding`, `findStaffingShortfalls`, `capOf`, `toDateId`, `requirementDateIds`), Task 2 (playbook constants and types), `COUNT_EXPRESSIONS`, `MAX_ASSISTANT_OPERATIONS`, `AssistantCommandV1` (`@/lib/proposal/commands`), `expandPersonRefs`, `flattenShiftTypeRefs` (`@/lib/rules/expansion`), `generateDateItems` (`@/lib/dates/date-id`), `paidMinutesFor` (`@/components/entity-editor/core`).
- Produces:
  - `interface RepairOption { repairId: RepairId; title: string; why: string; operations: AssistantCommandV1[]; confirmation: Confirmation; enforcedBy: EnforcedBy; confirmationQuestion: string; needsFromUser: string[]; capabilityId: CapabilityId | null; evidence: "static_check" | "hypothesis" }`
  - `classifySituation(findings: StaffingFinding[], runInfeasible: boolean): Situation | null`
  - `rankRepairOptions(state: ScenarioUiState, findings: StaffingFinding[], opts: { runInfeasible: boolean }): RepairOption[]`
  - `isSafeOption(state: ScenarioUiState, option: RepairOption): boolean`
  - `explainFinding(state: ScenarioUiState, finding: StaffingFinding): string`
  - `interface FeasibilityReport { playbookVersion: string; findings: string[]; moreFindings: number; certainty: string; options: RepairOption[]; safetyFloor: readonly string[]; instructions: readonly string[] }`
  - `buildFeasibilityReport(state: ScenarioUiState, afterInfeasibleRun: boolean): FeasibilityReport`

- [ ] **Step 1: Write the failing tests**

Create `web/lib/ai/assistant/repair-options.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findStaffingShortfalls, type StaffingFinding } from "@/lib/rules/shortfalls";
import { SCENARIOS, leave, people } from "@/lib/rules/ward-fixtures.test-support";
import {
  buildFeasibilityReport,
  classifySituation,
  explainFinding,
  isSafeOption,
  rankRepairOptions,
  type RepairOption,
} from "./repair-options";

const rank = (state = SCENARIOS.onlyRnOnLeave(), runInfeasible = false) =>
  rankRepairOptions(state, findStaffingShortfalls(state), { runInfeasible });

const option = (partial: Partial<RepairOption>): RepairOption => ({
  repairId: "run_one_short",
  title: "t",
  why: "w",
  operations: [],
  confirmation: "manager",
  enforcedBy: "apply",
  confirmationQuestion: "q",
  needsFromUser: [],
  capabilityId: null,
  evidence: "static_check",
  ...partial,
});

describe("classifySituation", () => {
  const dated = (dateId: string): StaffingFinding => ({
    kind: "requirement_short",
    dateId,
    iso: null,
    shiftTypes: ["N"],
    ruleIds: ["r"],
    required: 1,
    available: 0,
    away: [],
    capRuleIds: [],
    skillMix: false,
  });
  it("orders capped over chronic over acute, and needs a failed run for unexplained", () => {
    expect(classifySituation([], false)).toBeNull();
    expect(classifySituation([], true)).toBe("unexplained");
    expect(classifySituation([dated("01")], false)).toBe("acute");
    expect(classifySituation(["01", "02", "03", "04"].map(dated), false)).toBe("chronic");
    expect(classifySituation([{ ...dated("01"), kind: "cap_short", dateId: null }], false)).toBe("capped");
  });
});

describe("rankRepairOptions", () => {
  it("returns nothing when there is nothing to fix", () => {
    expect(rank(SCENARIOS.empty())).toEqual([]);
  });

  it("offers at most three options, all safe", () => {
    for (const make of Object.values(SCENARIOS)) {
      const state = make();
      const options = rank(state, true);
      expect(options.length).toBeLessThanOrEqual(3);
      for (const o of options) expect(isSafeOption(state, o), o.repairId).toBe(true);
    }
  });

  it("picks a free placeholder name", () => {
    const base = SCENARIOS.onlyRnOnLeave();
    const state = { ...base, staff: [...base.staff, ...people("Borrowed nurse 1")] };
    const borrow = rank(state).find((o) => o.repairId === "borrow_temporary_nurse");
    expect(borrow?.operations[0]).toEqual({ type: "add_person", name: "Borrowed nurse 2", groups: ["RN"] });
  });

  it("offers no borrow option when the skill group is unknown", () => {
    const base = SCENARIOS.onlyRnOnLeave();
    const state = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        requirements: base.cardsByKind.requirements.map((r) =>
          r.uid === "night-rn" ? { ...r, qualifiedPeople: ["rn1"] } : r,
        ),
      },
    };
    const ids = rank(state).map((o) => o.repairId);
    expect(ids).not.toContain("borrow_temporary_nurse");
    expect(ids).toContain("ask_nurse_on_leave");
  });

  it("does not offer one-person fixes for a gap of two", () => {
    // With Ana on leave on the 5th, the night requirement alone is 1 short, but the day
    // (night 3 + day 1 from 2 free) is 2 short. The date-level gap must win.
    const base = SCENARIOS.understaffedNight();
    const state = { ...base, reqData: [leave("ana", "05")] };
    const options = rank(state);
    const ids = options.map((o) => o.repairId);
    expect(ids).not.toContain("ask_nurse_on_leave");
    expect(ids).not.toContain("run_one_short");
    const borrow = options.find((o) => o.repairId === "borrow_temporary_nurse");
    expect(borrow?.operations.filter((op) => op.type === "add_person")).toHaveLength(2);
  });

  it("never lowers a skill-mix requirement", () => {
    for (const o of rank(SCENARIOS.onlyRnOnLeave())) {
      for (const op of o.operations) {
        expect(op.type).not.toBe("set_staffing_requirement_people");
        expect(op.type).not.toBe("edit_staffing_requirement");
      }
    }
  });

  it("refuses a cap raise above the limit", () => {
    const base = SCENARIOS.ruleTooStrict();
    const state = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        requirements: base.cardsByKind.requirements.map((r) =>
          r.uid === "night" ? { ...r, requiredNumPeople: 3 } : r,
        ),
      },
    };
    // 21 nights for 4 nurses capped at 1 each: +5 per nurse, above MAX_CAP_RAISE.
    expect(rank(state).map((o) => o.repairId)).not.toContain("relax_count_rule");
  });
});

describe("isSafeOption", () => {
  const state = SCENARIOS.onlyRnOnLeave();
  it("refuses every operation outside the allowlist", () => {
    for (const op of [
      { type: "set_rule_enabled", ruleKind: "requirements", ruleId: "day", enabled: false },
      { type: "set_staffing_requirement_people", ruleId: "night-rn", requiredNumPeople: 0 },
      { type: "set_staffing_requirement_people", ruleId: "day", requiredNumPeople: 0 },
      { type: "remove_rule", ruleKind: "successions", ruleId: "x" },
    ] as unknown as RepairOption["operations"]) {
      expect(isSafeOption(state, option({ operations: [op] })), op.type).toBe(false);
    }
  });

  it("refuses clearing leave without a host-asked nurse agreement", () => {
    const clear = { type: "clear_requests", personId: "rn1", startDate: "2026-11-03", endDate: "2026-11-03" } as const;
    expect(isSafeOption(state, option({ operations: [clear], confirmation: "manager" }))).toBe(false);
    expect(
      isSafeOption(state, option({ operations: [clear], confirmation: "named_nurse", enforcedBy: "host_question" })),
    ).toBe(true);
  });

  it("refuses marking off a nurse the option did not add", () => {
    const off = { type: "mark_person_off", personId: "en1", fromDate: "2026-11-01", toDate: "2026-11-02" } as const;
    expect(isSafeOption(state, option({ operations: [off], confirmation: "lending_ward" }))).toBe(false);
  });
});

describe("explaining in ward language", () => {
  it("names the day, shift, numbers and who is away", () => {
    const state = SCENARIOS.onlyRnOnLeave();
    const [finding] = findStaffingShortfalls(state);
    expect(explainFinding(state, finding)).toBe(
      "Tuesday, Nov 3, 2026, N: needs 1 from its group, only 0 free. Away: rn1 (on leave).",
    );
  });

  it("builds a report that caps findings and says how certain it is", () => {
    const report = buildFeasibilityReport(SCENARIOS.tooFewNurses(), false);
    expect(report.findings).toHaveLength(5);
    expect(report.moreFindings).toBe(2);
    expect(report.certainty).toMatch(/certain/);
    const unexplained = buildFeasibilityReport(SCENARIOS.restRuleTooTight(), true);
    expect(unexplained.findings).toEqual([]);
    expect(unexplained.certainty).toMatch(/unknown/);
    expect(unexplained.options.every((o) => o.evidence === "hypothesis")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && pnpm vitest run lib/ai/assistant/repair-options.test.ts`
Expected: FAIL, "Cannot find module './repair-options'".

- [ ] **Step 3: Write the implementation**

Create `web/lib/ai/assistant/repair-options.ts`:

```ts
// Ranked, safe repair options for a short-staffed or infeasible schedule.
//
// Pure. The static staffing check (lib/rules/shortfalls) says WHERE the schedule is
// short. The playbook says WHICH repairs a ward uses, in what order, and what is never
// allowed. This module joins them into at most three concrete options. Each option has
// the exact operations the host would validate and the real-world agreement it needs.
// Nothing here applies anything: an option reaches the schedule only as a Preview the
// user applies.

import { paidMinutesFor } from "@/components/entity-editor/core";
import type { CapabilityId } from "@/lib/capability/help-content";
import { generateDateItems, type DateItem } from "@/lib/dates/date-id";
import {
  COUNT_EXPRESSIONS,
  MAX_ASSISTANT_OPERATIONS,
  type AssistantCommandV1,
} from "@/lib/proposal/commands";
import { expandPersonRefs, flattenShiftTypeRefs } from "@/lib/rules/expansion";
import {
  capOf,
  findStaffingShortfalls,
  requirementDateIds,
  toDateId,
  type StaffingFinding,
} from "@/lib/rules/shortfalls";
import type {
  CountCard,
  PersonRef,
  RequirementCard,
  ScenarioUiState,
  UiShiftRequestCell,
} from "@/lib/scenario";
import {
  CHRONIC_DATE_COUNT,
  FEASIBILITY_INSTRUCTIONS,
  LONG_SHIFT_MINUTES,
  MAX_BORROWED,
  MAX_CAP_RAISE,
  MAX_EXPLAINED_FINDINGS,
  MAX_OPTIONS,
  PLAYBOOK_VERSION,
  REPAIRS,
  REPAIR_ORDER,
  SAFETY_FLOOR,
  SOFT_REQUEST_WEIGHT,
  type Confirmation,
  type EnforcedBy,
  type RepairId,
  type Situation,
} from "./playbook";

export interface RepairOption {
  repairId: RepairId;
  /** One line, concrete, in ward language. */
  title: string;
  /** Why this helps, citing the day, shift and numbers. */
  why: string;
  /** Exactly what prepare_scenario_change / test_feasibility_candidates would carry. Empty = advice only. */
  operations: AssistantCommandV1[];
  confirmation: Confirmation;
  enforcedBy: EnforcedBy;
  confirmationQuestion: string;
  /** Questions the assistant must ask before preparing. */
  needsFromUser: string[];
  /** A screen to open for advice-only options. */
  capabilityId: CapabilityId | null;
  /** static_check: the gap is proven. hypothesis: a guess to test on a copy. */
  evidence: "static_check" | "hypothesis";
}

interface Ctx {
  state: ScenarioUiState;
  items: DateItem[];
  staffIds: Set<string>;
  groupIds: Set<string>;
}

type Builder = (ctx: Ctx, findings: StaffingFinding[], situation: Situation) => RepairOption | null;

const asList = <T>(value: T | T[] | null | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const REASON_WORDS = { leave: "on leave", day_off: "must be off", never_request: "must not work this shift" } as const;

function makeCtx(state: ScenarioUiState): Ctx {
  return {
    state,
    items: generateDateItems({ start: state.rangeStart, end: state.rangeEnd }),
    staffIds: new Set(state.staff.map((p) => String(p.id))),
    groupIds: new Set(state.staffGroups.map((g) => String(g.id))),
  };
}

const range = (ctx: Ctx) => ({ start: ctx.state.rangeStart, end: ctx.state.rangeEnd });
const dateLabel = (ctx: Ctx, dateId: string) => ctx.items.find((i) => i.id === dateId)?.description ?? dateId;
const isoOf = (ctx: Ctx, dateId: string) => ctx.items.find((i) => i.id === dateId)?.iso ?? null;
const personRef = (ctx: Ctx, id: string): PersonRef =>
  ctx.state.staff.find((p) => String(p.id) === id)?.id ?? id;
const requirementCard = (ctx: Ctx, uid: string): RequirementCard | undefined =>
  ctx.state.cardsByKind.requirements.find((c) => c.uid === uid);
const countCard = (ctx: Ctx, uid: string): CountCard | undefined =>
  ctx.state.cardsByKind.counts.find((c) => c.uid === uid);
const staffIn = (ctx: Ctx, refs: PersonRef | PersonRef[]) =>
  [...expandPersonRefs(refs, ctx.state)].filter((id) => ctx.staffIds.has(id));
const isSkillMix = (card: RequirementCard | undefined) => {
  const refs = asList(card?.qualifiedPeople);
  return refs.length > 0 && !refs.some((r) => String(r).toUpperCase() === "ALL");
};
const weightText = (w: number) => (w === Infinity ? "infinity" : w === -Infinity ? "-infinity" : String(w));

function makeOption(
  id: RepairId,
  fields: Omit<RepairOption, "repairId" | "confirmation" | "enforcedBy"> & { enforcedBy?: EnforcedBy },
): RepairOption {
  const entry = REPAIRS.find((r) => r.id === id);
  if (!entry) throw new Error(`playbook has no repair ${id}`);
  return { repairId: id, confirmation: entry.confirmation, enforcedBy: fields.enforcedBy ?? entry.enforcedBy, ...fields };
}

/** The largest gap any finding reports on a date: one-person fixes need it to be exactly 1. */
const gapOn = (findings: StaffingFinding[], dateId: string) =>
  Math.max(0, ...findings.filter((f) => f.dateId === dateId).map((f) => f.required - f.available));

/** Short date ids, in roster order. */
function shortDates(ctx: Ctx, findings: StaffingFinding[]): string[] {
  const set = new Set(findings.flatMap((f) => (f.dateId ? [f.dateId] : [])));
  return ctx.items.map((i) => i.id).filter((id) => set.has(id));
}

export function classifySituation(findings: StaffingFinding[], runInfeasible: boolean): Situation | null {
  if (findings.some((f) => f.kind === "cap_short")) return "capped";
  const dates = new Set(findings.flatMap((f) => (f.dateId ? [f.dateId] : [])));
  if (dates.size > CHRONIC_DATE_COUNT) return "chronic";
  if (dates.size > 0) return "acute";
  return runInfeasible ? "unexplained" : null;
}

// --- Builders, one per playbook entry -------------------------------------

const softenHardRequest: Builder = (ctx, findings, situation) => {
  const hit = findings.flatMap((f) =>
    f.away.filter((a) => a.reason === "never_request").map((a) => ({ f, person: a.person })),
  )[0];
  const hard = ctx.state.reqData.filter(
    (c): c is UiShiftRequestCell => c.kind === "request" && !Number.isFinite(c.weight),
  );
  const cell = hit
    ? hard.find(
        (c) =>
          c.weight === -Infinity &&
          String(c.person) === hit.person &&
          toDateId(c.date, range(ctx)) === hit.f.dateId,
      )
    : situation === "unexplained"
      ? hard[0]
      : undefined;
  if (!cell) return null;
  const dateId = toDateId(cell.date, range(ctx));
  const iso = isoOf(ctx, dateId);
  if (!iso) return null;
  const never = cell.weight === -Infinity;
  const who = String(cell.person);
  return makeOption("soften_hard_request", {
    title: `Ask ${who} whether their "${never ? "never" : "must"} work ${cell.shiftType}" on ${dateLabel(ctx, dateId)} can become a strong preference`,
    why: hit
      ? `${who} is a nurse the ${hit.f.shiftTypes.join("/")} shift could use that day, but the request forbids it.`
      : "A hard request can make a schedule impossible. As a strong preference the solver breaks it only if it must.",
    operations: [
      {
        type: "set_shift_request",
        personId: cell.person,
        shiftType: String(cell.shiftType),
        startDate: iso,
        endDate: iso,
        weight: never ? -SOFT_REQUEST_WEIGHT : SOFT_REQUEST_WEIGHT,
      },
    ],
    confirmationQuestion: `Has ${who} agreed that this request can be a strong preference instead of a hard rule?`,
    needsFromUser: [`Why ${who} made the request. Keep it hard if it is for health, childcare or a formal agreement.`],
    capabilityId: null,
    evidence: hit ? "static_check" : "hypothesis",
  });
};

/** A count card the rule-ops `edit_count_rule` arm can carry unchanged except for its target. */
function editableCount(card: CountCard | undefined): card is CountCard & { expression: string; target: number } {
  return (
    card !== undefined &&
    !card.disabled &&
    card.tag === undefined &&
    !card.countShiftTypeCoefficients?.length &&
    typeof card.expression === "string" &&
    typeof card.target === "number" &&
    (COUNT_EXPRESSIONS as readonly string[]).includes(card.expression) &&
    !asList(card.person).some((p) => String(p).toUpperCase() === "ALL") &&
    Number.isFinite(capOf(card.expression, card.target, card.weight))
  );
}

function editCount(ctx: Ctx, card: CountCard & { expression: string; target: number }, target: number): AssistantCommandV1 {
  return {
    type: "edit_count_rule",
    ruleId: card.uid,
    description: card.description ?? "",
    people: asList(card.person),
    shiftTypes: asList(card.countShiftTypes).map(String),
    // Span ids become ISO (the card editor's form); chips and group ids stay as written.
    dates: asList(card.countDates).map((d) => {
      const key = String(d);
      return ctx.items.find((i) => i.id === key || i.iso === key)?.iso ?? key;
    }),
    expression: card.expression as (typeof COUNT_EXPRESSIONS)[number],
    target,
    weight: weightText(card.weight),
  };
}

const extraShiftWillingNurse: Builder = (ctx, findings) => {
  for (const f of findings) {
    if (f.kind !== "cap_short") continue;
    for (const uid of f.capRuleIds) {
      const card = countCard(ctx, uid);
      if (!editableCount(card)) continue;
      const people = staffIn(ctx, card.person);
      if (people.length !== 1) continue;
      const [person] = people;
      const shifts = f.shiftTypes.join("/");
      return makeOption("extra_shift_willing_nurse", {
        title: `Ask ${person} whether they will work one more ${shifts} shift this period`,
        why: `${shifts} needs ${f.required} shifts over the period but the limits allow only ${f.available}. ${person}'s own limit is one of them.`,
        operations: [editCount(ctx, card, card.target + 1)],
        confirmationQuestion: `Has ${person} agreed to one extra ${shifts} shift, within legal and contract limits?`,
        needsFromUser: [`Whether ${person} is willing, and that one more shift keeps them within legal rest and contract limits.`],
        capabilityId: null,
        evidence: "static_check",
      });
    }
  }
  return null;
};

const relaxCountRule: Builder = (ctx, findings, situation) => {
  if (situation === "unexplained") {
    const card = ctx.state.cardsByKind.counts.find(editableCount);
    return editableCount(card) ? relaxOption(ctx, card, 1, null) : null;
  }
  for (const f of findings) {
    if (f.kind !== "cap_short") continue;
    for (const uid of f.capRuleIds) {
      const card = countCard(ctx, uid);
      if (!editableCount(card)) continue;
      const capped = staffIn(ctx, card.person).length;
      if (capped < 2) continue;
      const delta = Math.ceil((f.required - f.available) / capped);
      if (delta > MAX_CAP_RAISE) continue;
      return relaxOption(ctx, card, delta, f);
    }
  }
  return null;
};

function relaxOption(
  ctx: Ctx,
  card: CountCard & { expression: string; target: number },
  delta: number,
  f: StaffingFinding | null,
): RepairOption {
  const cap = capOf(card.expression, card.target, card.weight);
  const shifts = asList(card.countShiftTypes).join("/");
  const name = card.description || card.uid;
  return makeOption("relax_count_rule", {
    title: `Allow up to ${cap + delta} ${shifts} shifts per nurse this period instead of ${cap} ("${name}")`,
    why: f
      ? `${shifts} needs ${f.required} shifts over the period, but "${name}" lets the team work only ${f.available}.`
      : `"${name}" is a hard limit that can make the schedule impossible.`,
    operations: [editCount(ctx, card, card.target + delta)],
    confirmationQuestion: `Is ${cap + delta} ${shifts} shifts per nurse in this period within your ward's contract and legal limits?`,
    needsFromUser: ["That the higher limit is within the ward's contract and legal limits. The app cannot check that."],
    capabilityId: "shift-counts",
    evidence: f ? "static_check" : "hypothesis",
  });
}

/** The staff group a borrowed nurse must join: null = none needed, undefined = needed but unknown. */
function skillGroup(ctx: Ctx, findings: StaffingFinding[]): string | null | undefined {
  const skilled = findings.filter((f) => f.skillMix);
  if (skilled.length === 0) return null;
  for (const f of skilled) {
    for (const uid of f.ruleIds) {
      const card = requirementCard(ctx, uid);
      if (!isSkillMix(card)) continue;
      const group = asList(card?.qualifiedPeople)
        .map(String)
        .find((ref) => ctx.groupIds.has(ref));
      if (group) return group;
    }
  }
  return undefined;
}

function placeholderNames(ctx: Ctx, count: number): string[] {
  const taken = new Set([...ctx.staffIds, ...ctx.groupIds]);
  const names: string[] = [];
  for (let n = 1; names.length < count; n++) {
    const name = `Borrowed nurse ${n}`;
    if (!taken.has(name)) names.push(name);
  }
  return names;
}

/** ISO runs of roster days OUTSIDE the loan, for `mark_person_off`. */
function offRuns(ctx: Ctx, loan: Set<string>): [string, string][] {
  const runs: [string, string][] = [];
  let start: DateItem | null = null;
  let last: DateItem | null = null;
  for (const item of [...ctx.items, null]) {
    if (item && !loan.has(item.id)) {
      start ??= item;
      last = item;
      continue;
    }
    if (start && last) runs.push([start.iso, last.iso]);
    start = null;
  }
  return runs;
}

const borrowTemporaryNurse: Builder = (ctx, findings, situation) => {
  const dated = findings.filter((f) => f.dateId !== null);
  const capped = findings.find((f) => f.kind === "cap_short");
  const count = dated.length
    ? Math.max(...dated.map((f) => f.required - f.available))
    : capped
      ? Math.ceil((capped.required - capped.available) / ctx.items.length)
      : 1;
  if (count < 1 || count > MAX_BORROWED || ctx.items.length === 0) return null;
  const group = skillGroup(ctx, findings);
  if (group === undefined) return null;

  // A loan is one block: from the first to the last short date (acute), or the period.
  const ids = ctx.items.map((i) => i.id);
  const short = situation === "acute" ? shortDates(ctx, findings) : ids;
  const loanIds = ids.slice(ids.indexOf(short[0]), ids.indexOf(short[short.length - 1]) + 1);
  const runs = offRuns(ctx, new Set(loanIds));
  const operations: AssistantCommandV1[] = placeholderNames(ctx, count).flatMap((name) => [
    { type: "add_person", name, groups: group ? [group] : [] } satisfies AssistantCommandV1,
    ...runs.map(
      ([fromDate, toDate]) => ({ type: "mark_person_off", personId: name, fromDate, toDate }) satisfies AssistantCommandV1,
    ),
  ]);
  if (operations.length > MAX_ASSISTANT_OPERATIONS) return null;

  const first = loanIds[0];
  const last = loanIds[loanIds.length - 1];
  const when = first === last ? dateLabel(ctx, first) : `${dateLabel(ctx, first)} to ${dateLabel(ctx, last)}`;
  const who = count === 1 ? "a nurse" : `${count} nurses`;
  const skill = group ? `, qualified as ${group}` : "";
  return makeOption("borrow_temporary_nurse", {
    title: `Borrow ${who}${skill} from the float pool, an agency or another ward for ${when}`,
    why: dated.length
      ? `${dated.length === 1 ? "That day is" : "Those days are"} short by up to ${count} ${count === 1 ? "nurse" : "nurses"} even with everyone free working.`
      : "More hands over the period remove the pressure the current staff cannot absorb.",
    operations,
    // A whole-period loan has no days off, so the host cannot tell it from a new hire:
    // the agreement is asked in chat (see Open question 2).
    enforcedBy: runs.length === 0 ? "chat" : "host_question",
    confirmationQuestion: `Has the lending ward or agency confirmed ${count === 1 ? "the nurse" : "the nurses"} for ${when}${skill}?`,
    needsFromUser: [
      "Which ward, float pool or agency can lend the nurse, and the name to show on the roster (or keep the placeholder).",
      ...(group ? [`That the borrowed nurse is qualified as ${group}.`] : []),
    ],
    capabilityId: "staff-list",
    evidence: findings.length > 0 ? "static_check" : "hypothesis",
  });
};

const askNurseOnLeave: Builder = (ctx, findings) => {
  for (const f of findings) {
    if (f.dateId === null || gapOn(findings, f.dateId) !== 1) continue;
    const onLeave = f.away.find((a) => a.reason === "leave");
    const iso = isoOf(ctx, f.dateId);
    if (!onLeave || !iso) continue;
    const when = dateLabel(ctx, f.dateId);
    const shifts = f.shiftTypes.join("/");
    return makeOption("ask_nurse_on_leave", {
      title: `Ask ${onLeave.person} whether they can give up their leave on ${when} to cover ${shifts}`,
      why: `${when} is one nurse short for ${shifts}, and ${onLeave.person} ${f.skillMix ? "is qualified and " : ""}is on leave that day.`,
      operations: [{ type: "clear_requests", personId: personRef(ctx, onLeave.person), startDate: iso, endDate: iso }],
      confirmationQuestion: `Has ${onLeave.person} agreed to give up their leave on ${when}?`,
      needsFromUser: [
        "What kind of leave it is. Do not ask a nurse on sick or compassionate leave.",
        `Whether ${onLeave.person} has agreed.`,
      ],
      capabilityId: "leave-and-requests",
      evidence: "static_check",
    });
  }
  return null;
};

const runOneShort: Builder = (ctx, findings) => {
  for (const f of findings) {
    if (f.dateId === null || gapOn(findings, f.dateId) !== 1) continue;
    for (const uid of f.ruleIds) {
      const card = requirementCard(ctx, uid);
      const selectors = card ? flattenShiftTypeRefs(card.shiftType) : [];
      if (!card || isSkillMix(card) || card.requiredNumPeople < 2 || selectors.length !== 1) continue;
      const shift = String(selectors[0]);
      const n = card.requiredNumPeople;
      const short = findings
        .filter((g) => g.dateId !== null && g.ruleIds.includes(uid) && gapOn(findings, g.dateId) === 1)
        .map((g) => g.dateId as string);
      const keep = requirementDateIds(ctx.state, card).filter((d) => !short.includes(d));
      const iso = (ids: string[]) => ids.map((d) => isoOf(ctx, d) as string);
      const operations: AssistantCommandV1[] =
        keep.length === 0
          ? [{ type: "set_staffing_requirement_people", ruleId: uid, requiredNumPeople: n - 1 }]
          : [
              {
                type: "edit_staffing_requirement",
                ruleId: uid,
                description: card.description ?? "",
                shiftType: shift,
                qualifiedPeople: ["ALL"],
                dates: iso(keep),
                requiredNumPeople: n,
              },
              {
                type: "add_staffing_requirement",
                description: `${card.description || shift} (one short)`,
                shiftType: shift,
                qualifiedPeople: ["ALL"],
                dates: iso(short),
                requiredNumPeople: n - 1,
              },
            ];
      const when = short.map((d) => dateLabel(ctx, d)).join(", ");
      return makeOption("run_one_short", {
        title: `Run ${shift} on ${when} with ${n - 1} instead of ${n} (the manager's safety call)`,
        why: `Nobody else is free: ${shift} can have at most ${n - 1} there as things stand.`,
        operations,
        confirmationQuestion: `As the manager, are you satisfied it is safe to run ${shift} on ${when} with ${n - 1} nurses?`,
        needsFromUser: ["Whether the manager accepts running the shift one short. Only they can make that safety call."],
        capabilityId: "staffing-requirements",
        evidence: "static_check",
      });
    }
  }
  return null;
};

const splitLongShift: Builder = (ctx, findings) => {
  for (const f of findings) {
    for (const id of f.shiftTypes) {
      const shift = ctx.state.shifts.find((s) => String(s.id) === id);
      const minutes = shift ? (shift.durationMinutes ?? paidMinutesFor(shift.startTime, shift.endTime, 0)) : null;
      if (minutes == null || minutes < LONG_SHIFT_MINUTES) continue;
      const hours = Math.round((minutes / 60) * 10) / 10;
      return makeOption("split_long_shift", {
        title: `Consider splitting the ${id} shift (${hours} h) into two shorter shifts so part-time or borrowed staff can cover half`,
        why: `${id} is short and ${hours} hours long. Two halves are easier to fill.`,
        operations: [],
        confirmationQuestion: "Does the ward want to change how this shift is worked?",
        needsFromUser: ["The two shorter shifts' times, if they want to try it."],
        capabilityId: "shift-types",
        evidence: "hypothesis",
      });
    }
  }
  return null;
};

const BUILDERS: Record<RepairId, Builder> = {
  soften_hard_request: softenHardRequest,
  extra_shift_willing_nurse: extraShiftWillingNurse,
  relax_count_rule: relaxCountRule,
  borrow_temporary_nurse: borrowTemporaryNurse,
  ask_nurse_on_leave: askNurseOnLeave,
  run_one_short: runOneShort,
  split_long_shift: splitLongShift,
};

export function rankRepairOptions(
  state: ScenarioUiState,
  findings: StaffingFinding[],
  opts: { runInfeasible: boolean },
): RepairOption[] {
  const situation = classifySituation(findings, opts.runInfeasible);
  if (situation === null) return [];
  const ctx = makeCtx(state);
  const options: RepairOption[] = [];
  for (const id of REPAIR_ORDER[situation]) {
    const built = BUILDERS[id](ctx, findings, situation);
    if (built && isSafeOption(state, built)) options.push(built);
    if (options.length === MAX_OPTIONS) break;
  }
  return options;
}

// --- The safety floor, in code --------------------------------------------

/** An ALLOWLIST: an operation not named here is never part of a repair. */
export function isSafeOption(state: ScenarioUiState, option: RepairOption): boolean {
  const addedHere = new Set(option.operations.flatMap((op) => (op.type === "add_person" ? [op.name] : [])));
  const hostAsked = option.enforcedBy === "host_question";
  return option.operations.every((op) => {
    switch (op.type) {
      case "set_staffing_requirement_people": {
        const card = state.cardsByKind.requirements.find((c) => c.uid === op.ruleId);
        return card !== undefined && !isSkillMix(card) && op.requiredNumPeople >= 1;
      }
      case "edit_staffing_requirement": {
        const card = state.cardsByKind.requirements.find((c) => c.uid === op.ruleId);
        return card !== undefined && !isSkillMix(card) && op.requiredNumPeople >= card.requiredNumPeople;
      }
      case "add_staffing_requirement":
        return op.requiredNumPeople >= 1 && op.qualifiedPeople.every((r) => String(r).toUpperCase() === "ALL");
      case "edit_count_rule": {
        const card = state.cardsByKind.counts.find((c) => c.uid === op.ruleId);
        if (!editableCount(card)) return false;
        const raise = op.target - card.target;
        return (
          op.expression === card.expression &&
          op.weight === weightText(card.weight) &&
          raise > 0 &&
          raise <= MAX_CAP_RAISE
        );
      }
      case "set_shift_request":
        return typeof op.weight === "number" && Number.isFinite(op.weight);
      case "clear_requests":
      case "move_leave":
        return option.confirmation === "named_nurse" && hostAsked;
      case "add_person":
        return option.confirmation === "lending_ward";
      case "mark_person_off":
        return option.confirmation === "lending_ward" && addedHere.has(String(op.personId));
      default:
        return false;
    }
  });
}

// --- Ward language ---------------------------------------------------------

export function explainFinding(state: ScenarioUiState, f: StaffingFinding): string {
  const ctx = makeCtx(state);
  const shifts = f.shiftTypes.join("/");
  const away = f.away.length
    ? ` Away: ${f.away.map((a) => `${a.person} (${REASON_WORDS[a.reason]})`).join(", ")}.`
    : "";
  const label = f.dateId ? dateLabel(ctx, f.dateId) : "";
  switch (f.kind) {
    case "requirement_short":
      return `${label}, ${shifts}: needs ${f.required}${f.skillMix ? " from its group" : ""}, only ${f.available} free.${away}`;
    case "day_short":
      return `${label}: ${shifts} need ${f.required} nurses in total, only ${f.available} free.${away}`;
    case "cap_short": {
      const names = f.capRuleIds.map((uid) => countCard(ctx, uid)?.description || uid).join(", ");
      return `${shifts} over the whole period: needs ${f.required} shifts, but the limits (${names}) allow only ${f.available}.`;
    }
  }
}

export interface FeasibilityReport {
  playbookVersion: string;
  findings: string[];
  moreFindings: number;
  certainty: string;
  options: RepairOption[];
  safetyFloor: readonly string[];
  instructions: readonly string[];
}

export function buildFeasibilityReport(state: ScenarioUiState, afterInfeasibleRun: boolean): FeasibilityReport {
  const findings = findStaffingShortfalls(state);
  return {
    playbookVersion: PLAYBOOK_VERSION,
    findings: findings.slice(0, MAX_EXPLAINED_FINDINGS).map((f) => explainFinding(state, f)),
    moreFindings: Math.max(0, findings.length - MAX_EXPLAINED_FINDINGS),
    certainty:
      findings.length > 0
        ? "These gaps are certain: the rules as written cannot be met on those days, so you may name them as the cause."
        : "No certain cause was found. The cause is unknown, and every option is a guess to test.",
    options: rankRepairOptions(state, findings, { runInfeasible: afterInfeasibleRun }),
    safetyFloor: SAFETY_FLOOR,
    instructions: FEASIBILITY_INSTRUCTIONS,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run lib/ai/assistant/repair-options.test.ts`
Expected: PASS (13 tests). If `explainFinding` fails only on the date label wording, compare with `describeDate` in `web/lib/dates/date-id.ts` (it is the source of the label) and fix the test's expected string, not the code.

- [ ] **Step 5: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors. If a dependency arm's field names differ from those used here (`add_person.name`, `mark_person_off.fromDate`, `edit_count_rule.people`, `edit_staffing_requirement.dates`, `clear_requests.startDate`, `set_shift_request.weight`), tsc names the field. Change the builder to the merged arm's field name.

- [ ] **Step 6: Commit**

```bash
git add web/lib/ai/assistant/repair-options.ts web/lib/ai/assistant/repair-options.test.ts
git commit -m "feat(assistant): rank safe, realistic repairs from the static staffing check"
```

---

### Task 5: Host confirmations for borrowed staff and extra shifts

**Files:**
- Modify: `web/lib/proposal/assumptions.ts`
- Test: `web/lib/proposal/assumptions.test.ts`

**Interfaces:**
- Consumes: `capOf` (Task 1), `expandPersonRefs` (`@/lib/rules/expansion`), `generateDateItems` (`@/lib/dates/date-id`).
- Produces: `AssumptionType` gains `"borrowed_staff_arranged"` and `"extra_shifts_agreed"`. `deriveAssumptions(before, after, commands)` returns them (sorted with the rest).

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/proposal/assumptions.test.ts` (add the imports at the top of the file):

```ts
import { applyAssistantCommands } from "./operations";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";

describe("real-world agreements beyond leave", () => {
  it("asks whether a bounded loan of a borrowed nurse is arranged", () => {
    const before = SCENARIOS.onlyRnOnLeave();
    const commands = [
      { type: "add_person", name: "Float RN (Ward 5)", groups: ["RN"] },
      { type: "mark_person_off", personId: "Float RN (Ward 5)", fromDate: "2026-11-01", toDate: "2026-11-02" },
      { type: "mark_person_off", personId: "Float RN (Ward 5)", fromDate: "2026-11-04", toDate: "2026-11-07" },
    ] as const;
    const result = applyAssistantCommands(before, [...commands]);
    if (!result.ok) throw new Error(result.rejection.message);
    const [assumption] = deriveAssumptions(before, result.next, [...commands]);
    expect(assumption).toMatchObject({
      type: "borrowed_staff_arranged",
      person: "Float RN (Ward 5)",
      date: "2026-11-03",
      toDate: "2026-11-03",
    });
    expect(assumption.question).toMatch(/lending ward or agency/);
    expect(assumption.question).toMatch(/RN/);
  });

  it("does not ask about an ordinary new staff member", () => {
    const before = SCENARIOS.onlyRnOnLeave();
    const commands = [{ type: "add_person", name: "Dana", groups: [] }] as const;
    const result = applyAssistantCommands(before, [...commands]);
    if (!result.ok) throw new Error(result.rejection.message);
    expect(deriveAssumptions(before, result.next, [...commands])).toEqual([]);
  });

  it("asks one nurse to agree before her own limit goes up, but not a team limit", () => {
    const base = SCENARIOS.ruleTooStrict();
    const solo = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        counts: [{ ...base.cardsByKind.counts[0], uid: "ana-nights", person: ["ana"] }],
      },
    };
    const edit = (ruleId: string, people: string[]) => ({
      type: "edit_count_rule" as const,
      ruleId,
      description: "At most 1 nights",
      people,
      shiftTypes: ["N"],
      dates: ["ALL"],
      expression: "x <= T" as const,
      target: 2,
      weight: "infinity",
    });
    const soloCmd = [edit("ana-nights", ["ana"])];
    const soloAfter = applyAssistantCommands(solo, soloCmd);
    if (!soloAfter.ok) throw new Error(soloAfter.rejection.message);
    expect(deriveAssumptions(solo, soloAfter.next, soloCmd)).toEqual([
      expect.objectContaining({ type: "extra_shifts_agreed", person: "ana", toDate: "2" }),
    ]);

    const teamCmd = [edit("max-nights", ["Nurses"])];
    const teamAfter = applyAssistantCommands(base, teamCmd);
    if (!teamAfter.ok) throw new Error(teamAfter.rejection.message);
    expect(deriveAssumptions(base, teamAfter.next, teamCmd)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && pnpm vitest run lib/proposal/assumptions.test.ts`
Expected: FAIL. The first and third new tests get `[]` or `undefined`.

- [ ] **Step 3: Write the implementation**

In `web/lib/proposal/assumptions.ts`:

Add imports:

```ts
import { generateDateItems } from "@/lib/dates/date-id";
import { expandPersonRefs } from "@/lib/rules/expansion";
import { capOf } from "@/lib/rules/shortfalls";
```

Extend the union:

```ts
export type AssumptionType =
  /** A leave pin is moving to another date. */
  | "leave_moved"
  /** A leave pin is being destroyed — by a range change that drops its date. */
  | "leave_cancelled"
  /** A nurse from another ward or agency is added for a bounded run of days. */
  | "borrowed_staff_arranged"
  /** One named nurse's own hard limit goes up. */
  | "extra_shifts_agreed";
```

In `deriveAssumptions`, directly before the final `return assumptions.sort(...)`:

```ts
  assumptions.push(...borrowedStaff(after, commands), ...extraShifts(before, after, commands));
```

Add the two helpers below `deriveAssumptions`:

```ts
/**
 * A borrowed nurse: `add_person` plus `mark_person_off` for the same person in one
 * change (the loan pattern, people-ops plan). An ordinary new hire has no days off and
 * is not asked about. The loan is read from the AFTER document: the days she is not
 * hard-off.
 */
function borrowedStaff(
  after: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): OperationalAssumption[] {
  const loaned = new Set(
    commands.flatMap((command) => (command.type === "mark_person_off" ? [ref(command.personId)] : [])),
  );
  const items = generateDateItems({ start: after.rangeStart, end: after.rangeEnd });
  return commands.flatMap((command) => {
    if (command.type !== "add_person" || !loaned.has(command.name)) return [];
    const off = new Set(
      after.reqData
        .filter((cell) => cell.kind === "off" && cell.weight === Infinity && ref(cell.person) === command.name)
        .map((cell) => ref(cell.date)),
    );
    const loan = items.filter((item) => !off.has(item.id) && !off.has(item.iso));
    if (loan.length === 0) return [];
    const first = loan[0].iso;
    const last = loan[loan.length - 1].iso;
    const skills = command.groups.length > 0 ? command.groups.join(", ") : "no staff group";
    return [
      {
        assumptionId: assumptionId("borrowed_staff_arranged", command.name, first, last),
        type: "borrowed_staff_arranged",
        person: command.name,
        date: first,
        toDate: last,
        question: `Has the lending ward or agency confirmed ${command.name} for ${first} to ${last}, qualified as ${skills}?`,
        detail:
          "Applying this adds a nurse the ward does not employ. The app cannot check the loan or her qualifications with anyone.",
      },
    ];
  });
}

/** Raising ONE named nurse's own hard limit is an agreement with that nurse. */
function extraShifts(
  before: ScenarioUiState,
  after: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): OperationalAssumption[] {
  const staffIds = new Set(before.staff.map((person) => String(person.id)));
  return commands.flatMap((command) => {
    if (command.type !== "edit_count_rule") return [];
    const was = before.cardsByKind.counts.find((card) => card.uid === command.ruleId);
    const now = after.cardsByKind.counts.find((card) => card.uid === command.ruleId);
    if (!was || !now || typeof was.expression !== "string" || typeof was.target !== "number") return [];
    if (typeof now.expression !== "string" || typeof now.target !== "number") return [];
    const oldCap = capOf(was.expression, was.target, was.weight);
    const newCap = capOf(now.expression, now.target, now.weight);
    if (!Number.isFinite(oldCap) || !(newCap > oldCap)) return [];
    const people = [...expandPersonRefs(was.person, before)].filter((id) => staffIds.has(id));
    if (people.length !== 1) return [];
    const [person] = people;
    const period = `${before.rangeStart}~${before.rangeEnd}`;
    const cap = Number.isFinite(newCap) ? String(newCap) : "no limit";
    return [
      {
        assumptionId: assumptionId("extra_shifts_agreed", person, period, cap),
        type: "extra_shifts_agreed",
        person,
        date: period,
        toDate: cap,
        question: `Has ${person} agreed to work up to ${cap} ${command.shiftTypes.join("/")} shifts in this period?`,
        detail:
          "Applying this lets the roster give them more shifts than their limit allowed. The app cannot check that they agreed, or that it is within legal limits.",
      },
    ];
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run lib/proposal/assumptions.test.ts lib/store/assistant-proposal.test.ts lib/repository/assistant-apply.test.ts`
Expected: PASS. (The repository refuses Apply for any outstanding assumption regardless of type. `assistant-apply.test.ts` is the guard for that.)

- [ ] **Step 5: Commit**

```bash
git add web/lib/proposal/assumptions.ts web/lib/proposal/assumptions.test.ts
git commit -m "feat(proposal): ask for borrowed-staff and extra-shift agreements before Apply"
```

---

### Task 6: The `suggest_feasibility_options` tool and the authority sentence

**Files:**
- Create: `web/components/ai/use-feasibility-tools.ts`
- Modify: `web/components/ai/use-context-tools.ts` (mount it)
- Modify: `web/components/ai/model-visible-tools.ts` (`MODEL_VISIBLE_TOOL_SCHEMAS`)
- Modify: `web/lib/ai/assistant/scenario-context.ts` (`ASSISTANT_AUTHORITY_STATEMENT`)
- Modify: `web/components/ai/use-optimize-tools.ts` (`guidanceFor`, infeasible case; from the optimize-run plan)
- Test: `web/lib/ai/assistant/scenario-context.test.ts`, `web/components/ai/use-optimize-tools.test.tsx`

**Interfaces:**
- Consumes: `buildFeasibilityReport` (Task 4), `useModelVisibleTool`, `pickScenario`, `useScenarioStore`.
- Produces: `feasibilityParameters = z.object({ afterInfeasibleRun: z.boolean() })`, `useFeasibilityTools(agentId: string, turnEpoch: number): void`, tool `suggest_feasibility_options` returning `FeasibilityReport`.

- [ ] **Step 1: Write the failing authority test**

In `web/lib/ai/assistant/scenario-context.test.ts`, inside `describe("the attached turn context", ...)`, add:

```ts
  it("points the model at guided setup and at the repair options", () => {
    // WIDENED DELIBERATELY (2026-09-24, plan assistant-guided-setup-and-repair).
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/get_setup_progress/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/suggest_feasibility_options/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/at most three/);
  });
```

In `web/components/ai/use-optimize-tools.test.tsx`, change the test `points an infeasible run at the bounded diagnostic, and forbids a cause`: rename it to `points an infeasible run at the feasibility options, then the bounded diagnostic`, and replace its last two `expect` lines with:

```ts
    // WIDENED DELIBERATELY (2026-09-24, plan assistant-guided-setup-and-repair): the static
    // staffing check is deterministic evidence, so a CERTAIN gap may be named; nothing else may.
    expect(summary.guidance).toMatch(/suggest_feasibility_options/);
    expect(summary.guidance).toMatch(/test_feasibility_candidates/);
    expect(summary.guidance).toMatch(/only when it reports a certain gap/);
    expect(summary.guidance).not.toMatch(/never name a cause/);
```

- [ ] **Step 2: Run the failing tests**

Run: `cd web && pnpm vitest run lib/ai/assistant/scenario-context.test.ts lib/ai/phase-2-absence.test.ts lib/capability/tools.test.ts components/ai/use-optimize-tools.test.tsx`
Expected: FAIL. The authority test fails on `get_setup_progress`, the optimize test on `suggest_feasibility_options`, and the other two on the unregistered `suggest_feasibility_options`.

- [ ] **Step 3: Write the tool and the sentence**

Create `web/components/ai/use-feasibility-tools.ts`:

```ts
"use client";

// Read-only feasibility options (plan 2026-09-24 guided setup and repair).
//
// Runs the static staffing check and the playbook ranking over the live committed
// scenario. It writes nothing: an option becomes a change only through
// prepare_scenario_change or test_feasibility_candidates, and only the user applies it.

import { z } from "zod";
import { useModelVisibleTool } from "./register-model-visible-tool";
import { pickScenario, useScenarioStore } from "@/lib/store";
import { buildFeasibilityReport } from "@/lib/ai/assistant/repair-options";

export const feasibilityParameters = z.object({
  afterInfeasibleRun: z
    .boolean()
    .describe(
      "True only when an Optimize run of the schedule as it stands now came back infeasible. " +
        "Then options are offered even when no certain cause is found, labelled as guesses.",
    ),
});

export function useFeasibilityTools(agentId: string, turnEpoch: number): void {
  useModelVisibleTool(
    {
      name: "suggest_feasibility_options",
      agentId,
      description:
        "Find where the schedule is short-staffed and get up to three realistic, safe ways to fix " +
        "it, best first: for example borrowing a nurse from another ward, asking a named nurse on " +
        "leave, or allowing one more night this period. Each option lists its exact operations and " +
        "who must agree. Use it before running Optimize when set-up progress reports known gaps, " +
        "and whenever a run is infeasible. It changes nothing.",
      parameters: feasibilityParameters,
      handler: async (args) =>
        buildFeasibilityReport(pickScenario(useScenarioStore.getState()), args.afterInfeasibleRun),
    },
    [agentId, turnEpoch],
  );
}
```

In `web/components/ai/use-context-tools.ts`, import it and call it right after `useDiagnosticTools(agentId, turnEpoch);`:

```ts
import { useFeasibilityTools } from "./use-feasibility-tools";
```

```ts
  // Read-only: the static staffing check plus the ranked playbook options.
  useFeasibilityTools(agentId, turnEpoch);
```

In `web/components/ai/model-visible-tools.ts`, import `feasibilityParameters` from `./use-feasibility-tools` and add to `MODEL_VISIBLE_TOOL_SCHEMAS`:

```ts
  suggest_feasibility_options: feasibilityParameters,
```

In `web/lib/ai/assistant/scenario-context.ts`, add one entry to `ASSISTANT_AUTHORITY_STATEMENT`, before the "Speak plain language" line:

```ts
  "To set up a schedule step by step, call get_setup_progress and follow its nextStep. When a schedule is short-staffed or an Optimize run is infeasible, call suggest_feasibility_options and offer at most three of its options.",
```

In `web/components/ai/use-optimize-tools.ts`, `guidanceFor`, replace the `case "infeasible":` return value with:

```ts
        return (
          "The rules as written cannot all be met, so no roster exists. The solver does not " +
          "say which rule is responsible. Call suggest_feasibility_options with " +
          "afterInfeasibleRun true: name a cause only when it reports a certain gap, and never " +
          "otherwise. Then use test_feasibility_candidates to test its options on copies."
        );
```

- [ ] **Step 4: Run the tests**

Run: `cd web && pnpm vitest run components/ai/use-optimize-tools.test.tsx lib/ai/assistant/scenario-context.test.ts lib/ai/phase-2-absence.test.ts lib/capability/tools.test.ts lib/ai/runtime/model-visible-tools.test.ts components/ai/tool-activity.test.ts components/ai/session-real-core.test.tsx components/ai/tool-payload-boundary.test.tsx`
Expected: PASS. If `session-real-core.test.tsx` or `tool-payload-boundary.test.tsx` hard-codes a tool count or a per-tool payload list, add the two tools to that list with the dated `WIDENED DELIBERATELY` comment.

- [ ] **Step 5: Typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm exec oxlint components/ai lib/ai && pnpm exec ast-grep scan`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/components/ai/use-feasibility-tools.ts web/components/ai/use-context-tools.ts web/components/ai/model-visible-tools.ts web/lib/ai/assistant/scenario-context.ts web/lib/ai/assistant/scenario-context.test.ts web/components/ai/use-optimize-tools.ts web/components/ai/use-optimize-tools.test.tsx
git commit -m "feat(assistant): suggest_feasibility_options explains gaps and ranks fixes"
```

---

### Task 7: Help content

**Files:**
- Modify: `web/lib/capability/help-content.ts` (entry `ai-assistant-conversation`)
- Regenerate: `web/lib/capability/registry.generated.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: an updated `nurseFacingSummary` and a new manifest hash.

- [ ] **Step 1: Update the summary**

In the `ai-assistant-conversation` entry, add this sentence after the sentence that lists the change kinds. Sibling plans edit the same summary: keep their clauses and add this sentence.

```ts
      "It can also walk you through setting up a new schedule one step at a time, and when a " +
      "schedule cannot be filled it says which day and shift is short and why, and suggests up to " +
      "three realistic fixes — such as borrowing a nurse from another ward, asking a nurse on leave " +
      "if she can cover, or allowing one more night this period. Anything that needs someone to " +
      "agree is asked before you can apply it. " +
```

Add `"set-up guide"`, `"infeasible"`, `"short-staffed"` to that entry's `concepts`.

- [ ] **Step 2: Regenerate the registry**

Run: `cd web && pnpm capability:generate`
Expected: `registry.generated.ts` changes (new hash).

- [ ] **Step 3: Run the capability suite**

Run: `cd web && pnpm vitest run lib/capability`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/lib/capability/help-content.ts web/lib/capability/registry.generated.ts
git commit -m "docs(help): assistant guides setup and suggests realistic fixes"
```

---

### Task 8: Evaluation harness (scripted scenarios, no LLM)

**Files:**
- Create: `web/lib/ai/assistant/repair-eval.test.ts`
- Generate: `core/tests/fixtures/assistant_repair/{understaffedNight,onlyRnOnLeave,ruleTooStrict,tooFewNurses,restRuleTooTight}.{before,after}.yaml`

**Interfaces:**
- Consumes: `SCENARIOS` (Task 1), `findStaffingShortfalls` (Task 1), `deriveSetupProgress` (Task 3), `rankRepairOptions`, `isSafeOption`, `buildFeasibilityReport` (Task 4), `deriveAssumptions` (Task 5), `applyAssistantCommands`, `serializeScenario`, `computeScenarioSummary`.
- Produces: the fixture files Task 9 reads. `UPDATE_REPAIR_FIXTURES=1` rewrites them.

- [ ] **Step 1: Write the harness**

Create `web/lib/ai/assistant/repair-eval.test.ts`:

```ts
// The evaluation harness for guided setup and feasibility repair.
//
// Pure: no LLM, no network, no solver. For each scripted ward it checks what a ward
// manager would check. Are the ranked options sensible, in the right order, and safe?
// Does each one map to operations the host accepts, with the right real-world question?
// Does the top option leave no certain gap? It also writes the before/after scenarios
// as YAML so core/tests/test_assistant_repair_fixtures.py can prove with the REAL
// solver that "before" is infeasible and "after the top option" is feasible.
// Regenerate with: UPDATE_REPAIR_FIXTURES=1 pnpm vitest run lib/ai/assistant/repair-eval

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeScenarioSummary } from "@/components/home/scenario-summary";
import { deriveAssumptions } from "@/lib/proposal/assumptions";
import { applyAssistantCommands } from "@/lib/proposal/operations";
import { findStaffingShortfalls } from "@/lib/rules/shortfalls";
import { SCENARIOS, type ScenarioName } from "@/lib/rules/ward-fixtures.test-support";
import { serializeScenario, type ScenarioUiState } from "@/lib/scenario";
import type { RepairId } from "./playbook";
import { buildFeasibilityReport, isSafeOption, rankRepairOptions, type RepairOption } from "./repair-options";
import { deriveSetupProgress } from "./setup-progress";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../core/tests/fixtures/assistant_repair/", import.meta.url));
const UPDATING = process.env.UPDATE_REPAIR_FIXTURES === "1";

/** The build stamp changes with every release; the fixtures must not. */
const stableYaml = (state: ScenarioUiState) => serializeScenario(state).replace(/^appVersion:.*\n?/m, "");

function options(name: ScenarioName, runInfeasible = true): RepairOption[] {
  const state = SCENARIOS[name]();
  return rankRepairOptions(state, findStaffingShortfalls(state), { runInfeasible });
}

function applyTop(name: ScenarioName): ScenarioUiState {
  const state = SCENARIOS[name]();
  const [top] = options(name);
  const result = applyAssistantCommands(state, top.operations);
  if (!result.ok) throw new Error(`${name}: ${result.rejection.message}`);
  return result.next;
}

const INFEASIBLE: ScenarioName[] = [
  "understaffedNight",
  "onlyRnOnLeave",
  "ruleTooStrict",
  "tooFewNurses",
  "restRuleTooTight",
];

const EXPECTED: Record<ScenarioName, RepairId[]> = {
  empty: [],
  understaffedNight: ["borrow_temporary_nurse", "run_one_short"],
  onlyRnOnLeave: ["borrow_temporary_nurse", "ask_nurse_on_leave"],
  ruleTooStrict: ["relax_count_rule", "borrow_temporary_nurse"],
  tooFewNurses: ["borrow_temporary_nurse"],
  restRuleTooTight: ["borrow_temporary_nurse"],
};

describe("guided setup from an empty scenario", () => {
  it("starts at the dates, asks before proposing, and is not ready to run", () => {
    const state = SCENARIOS.empty();
    const progress = deriveSetupProgress({
      summary: computeScenarioSummary(state),
      runComplete: false,
      uncoveredShifts: [],
      knownGaps: findStaffingShortfalls(state).length,
    });
    expect(progress.nextStep?.id).toBe("dates");
    expect(progress.nextStep?.ask).toContain("The first and last day of the roster.");
    expect(progress.readyToRun).toBe(false);
    expect(buildFeasibilityReport(state, false).options).toEqual([]);
  });

  it("warns before running a ward that is sure to fail", () => {
    const state = SCENARIOS.onlyRnOnLeave();
    const progress = deriveSetupProgress({
      summary: computeScenarioSummary(state),
      runComplete: false,
      uncoveredShifts: [],
      knownGaps: findStaffingShortfalls(state).length,
    });
    expect(progress.readyToRun).toBe(true);
    expect(progress.knownGaps).toBe(1);
  });
});

describe.each(INFEASIBLE)("infeasible after a run: %s", (name) => {
  it("offers the expected options, best first", () => {
    expect(options(name).map((o) => o.repairId)).toEqual(EXPECTED[name]);
  });

  it("offers only safe options that the host accepts, each with its agreement", () => {
    const state = SCENARIOS[name]();
    for (const option of options(name)) {
      expect(isSafeOption(state, option), option.repairId).toBe(true);
      expect(option.title.length).toBeGreaterThan(10);
      expect(option.confirmationQuestion).toMatch(/\?$/);
      if (option.operations.length === 0) {
        expect(option.capabilityId, option.repairId).not.toBeNull();
        continue;
      }
      const result = applyAssistantCommands(state, option.operations);
      expect(result.ok, `${option.repairId}: ${result.ok ? "" : result.rejection.message}`).toBe(true);
      if (!result.ok) continue;
      if (option.enforcedBy === "host_question") {
        // The agreement is a host question on the Preview, so Apply stays disabled until answered.
        expect(deriveAssumptions(state, result.next, option.operations).length, option.repairId).toBeGreaterThan(0);
      }
    }
  });

  it("leaves no certain gap after the top option", () => {
    expect(findStaffingShortfalls(applyTop(name))).toEqual([]);
  });

  it("keeps the solver fixtures in step with the scripted wards", () => {
    const before = stableYaml(SCENARIOS[name]());
    const after = stableYaml(applyTop(name));
    const beforePath = `${FIXTURE_DIR}${name}.before.yaml`;
    const afterPath = `${FIXTURE_DIR}${name}.after.yaml`;
    if (UPDATING) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(beforePath, before, "utf8");
      writeFileSync(afterPath, after, "utf8");
    }
    expect(readFileSync(beforePath, "utf8")).toBe(before);
    expect(readFileSync(afterPath, "utf8")).toBe(after);
  });
});

describe("the scripted wards read as real ward situations", () => {
  it("understaffed night: borrow one nurse for the 5th only, or run that night one short", () => {
    const [borrow, short] = options("understaffedNight");
    expect(borrow.operations).toEqual([
      { type: "add_person", name: "Borrowed nurse 1", groups: [] },
      { type: "mark_person_off", personId: "Borrowed nurse 1", fromDate: "2026-11-01", toDate: "2026-11-04" },
      { type: "mark_person_off", personId: "Borrowed nurse 1", fromDate: "2026-11-06", toDate: "2026-11-07" },
    ]);
    expect(short.operations).toEqual([
      { type: "set_staffing_requirement_people", ruleId: "night-05", requiredNumPeople: 2 },
    ]);
    expect(short.confirmation).toBe("manager");
  });

  it("only RN on leave: borrow an RN, or ask rn1 about her leave, and never lower the RN rule", () => {
    const [borrow, ask] = options("onlyRnOnLeave");
    expect(borrow.operations[0]).toEqual({ type: "add_person", name: "Borrowed nurse 1", groups: ["RN"] });
    expect(borrow.needsFromUser.join(" ")).toMatch(/qualified as RN/);
    expect(ask.operations).toEqual([
      { type: "clear_requests", personId: "rn1", startDate: "2026-11-03", endDate: "2026-11-03" },
    ]);
    expect(ask).toMatchObject({ confirmation: "named_nurse", enforcedBy: "host_question" });
    expect(ask.needsFromUser.join(" ")).toMatch(/sick or compassionate/);
  });

  it("rule too strict: allow 2 nights each instead of 1, checked against legal limits", () => {
    const [relax] = options("ruleTooStrict");
    expect(relax.operations).toEqual([
      expect.objectContaining({ type: "edit_count_rule", ruleId: "max-nights", target: 2, weight: "infinity" }),
    ]);
    expect(relax.confirmationQuestion).toMatch(/legal limits/);
  });

  it("too few nurses: borrow a nurse for the whole period, asked in chat", () => {
    const [borrow] = options("tooFewNurses");
    expect(borrow.operations).toEqual([{ type: "add_person", name: "Borrowed nurse 1", groups: [] }]);
    expect(borrow.enforcedBy).toBe("chat");
  });

  it("rest rules too tight: no certain cause, never touches the rest rules, only guesses", () => {
    const report = buildFeasibilityReport(SCENARIOS.restRuleTooTight(), true);
    expect(report.findings).toEqual([]);
    expect(report.options.map((o) => o.evidence)).toEqual(["hypothesis"]);
    for (const o of report.options) {
      for (const op of o.operations) expect(op.type).not.toMatch(/succession|remove_rule|set_rule_enabled/);
    }
    expect(buildFeasibilityReport(SCENARIOS.restRuleTooTight(), false).options).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify the fixture check fails**

Run: `cd web && pnpm vitest run lib/ai/assistant/repair-eval.test.ts`
Expected: every test PASSES except `keeps the solver fixtures in step...`, which FAILS with ENOENT (no fixture files yet). If an `offers the expected options` test fails, do not edit `EXPECTED` to match: read the finding and fix the builder or the ward. An order change needs a playbook change and a version bump.

- [ ] **Step 3: Generate the fixtures**

Run: `cd web && UPDATE_REPAIR_FIXTURES=1 pnpm vitest run lib/ai/assistant/repair-eval.test.ts`
Expected: PASS. 10 files appear in `core/tests/fixtures/assistant_repair/`.

Run: `head -5 core/tests/fixtures/assistant_repair/onlyRnOnLeave.before.yaml && grep -c appVersion core/tests/fixtures/assistant_repair/*.yaml`
Expected: YAML starting with `apiVersion:`, and 0 `appVersion` lines in each file. If `appVersion` is present, the regex in `stableYaml` does not match the serializer's line: fix the regex and regenerate.

- [ ] **Step 4: Run it again without the update flag**

Run: `cd web && pnpm vitest run lib/ai/assistant/repair-eval.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/ai/assistant/repair-eval.test.ts core/tests/fixtures/assistant_repair
git commit -m "test(assistant): scripted infeasible wards with safe, appliable top fixes"
```

---

### Task 9: Real-solver proof

**Files:**
- Create: `core/tests/test_assistant_repair_fixtures.py`

**Interfaces:**
- Consumes: the 10 fixture files from Task 8, `nurse_scheduling.scheduler.schedule(bytes) -> (df, solution, score, status_name, cell_export_info)`.
- Produces: a CI proof that each scripted ward is INFEASIBLE before and FEASIBLE after its top option.

- [ ] **Step 1: Write the test**

Create `core/tests/test_assistant_repair_fixtures.py`:

```python
"""Real-solver proof for the assistant's scripted repair scenarios.

The web harness (web/lib/ai/assistant/repair-eval.test.ts) writes each scripted ward
as YAML before and after the assistant's top-ranked repair. Here the real CP-SAT
solver confirms the claim the assistant makes: the ward as written cannot be solved,
and the ward after the top repair can. Regenerate the fixtures with
UPDATE_REPAIR_FIXTURES=1 pnpm vitest run lib/ai/assistant/repair-eval (in web/).
"""

from pathlib import Path

import pytest

from nurse_scheduling import scheduler

FIXTURES = Path(__file__).parent / "fixtures" / "assistant_repair"
CASES = sorted({path.name.split(".")[0] for path in FIXTURES.glob("*.before.yaml")})


def _status(path: Path) -> str:
    _df, _solution, _score, status_name, _cells = scheduler.schedule(path.read_bytes(), timeout=30)
    return status_name


def test_the_harness_wrote_every_case():
    assert CASES == [
        "onlyRnOnLeave",
        "restRuleTooTight",
        "ruleTooStrict",
        "tooFewNurses",
        "understaffedNight",
    ]


@pytest.mark.parametrize("case", CASES)
def test_before_is_infeasible(case):
    assert _status(FIXTURES / f"{case}.before.yaml") == "INFEASIBLE"


@pytest.mark.parametrize("case", CASES)
def test_after_the_top_repair_is_feasible(case):
    assert _status(FIXTURES / f"{case}.after.yaml") in {"FEASIBLE", "OPTIMAL"}
```

- [ ] **Step 2: Run it**

Run: `cd core && PYTHONPATH=. python3 -m pytest -q tests/test_assistant_repair_fixtures.py`
Expected: PASS (11 tests). If a `before` case is FEASIBLE, the ward is not really infeasible: fix the ward in `ward-fixtures.test-support.ts` and regenerate (Task 8 Step 3). If an `after` case is INFEASIBLE, the top option is not a real fix for that ward: that is a playbook bug, so fix the builder or the order, not the test. If `scheduler.schedule` rejects `timeout=30`, drop the argument.

- [ ] **Step 3: Lint**

Run: `cd core && ruff check tests/test_assistant_repair_fixtures.py && ruff format --check tests/test_assistant_repair_fixtures.py`
Expected: no findings.

- [ ] **Step 4: Commit**

```bash
git add core/tests/test_assistant_repair_fixtures.py
git commit -m "test(core): the real solver confirms each scripted ward and its top repair"
```

---

### Task 10: Whole-branch gates

**Files:** none new.

- [ ] **Step 1: Run the affected web suites**

Run: `cd web && pnpm vitest run lib/rules lib/ai lib/proposal lib/capability lib/store/assistant-proposal.test.ts lib/repository/assistant-apply.test.ts components/ai components/home`
Expected: PASS.

- [ ] **Step 2: Typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm exec oxlint && pnpm exec ast-grep scan`
Expected: no errors.

- [ ] **Step 3: Core suite**

Run: `cd core && PYTHONPATH=. python3 -m pytest -q`
Expected: the previous pass count plus 11, no failures.

- [ ] **Step 4: Check that nothing unplanned changed**

Run: `git status --short`
Expected: only the files in this plan's File Structure.

---

### Task 11: Live verification (manual, controller only, not CI)

**Where:** https://nurse-sheduler.agilgenie.ai, after the branch is deployed there.

**Who:** the controller, by hand, in a browser. The user turns on AI and enters their own OpenRouter key themselves (an agent never types a key). Use a throw-away scenario: loading or starting over replaces what is open, so download a backup first if the browser holds real work.

- [ ] **Step 1: Turn on the assistant**

Settings → AI assistant → AI features on → the user pastes their key and picks a tool-capable model → Save and test.
Pass: the card reads Ready and the launcher appears.

- [ ] **Step 2: Guided setup from empty**

Start an empty scenario (Save and load → start over, or load an empty file). Open the assistant and type: `Help me set up a roster from scratch for a small ward.`
Pass: it checks progress (activity line "Checking your set-up…") and asks only for the roster dates and the public holidays. It proposes nothing yet.

Answer, one step at a time, applying each Preview:
1. `1 to 7 November 2026, no public holidays.`
2. `Staff: rn1 is an RN, en1 and en2 are enrolled nurses. Put rn1 in a group called RN.`
3. `Shifts: D 07:00-15:00 and N 21:00-07:00, no breaks.`
4. `Every day shift needs 1 nurse, every night needs 1 RN.`
5. `rn1 is on annual leave on 3 November.`

Pass for each step: one Preview per step; the Preview matches the answer exactly; nothing is claimed as done before Apply; after Apply the assistant moves to the next step without being asked twice. Fail: it guesses a value it was not given, puts two steps in one Preview, or says a change is saved before Apply.

- [ ] **Step 3: Warning before the run**

After step 5 the assistant should say that the night of 3 November cannot be filled (known gap) before it offers to run.
Pass: it names 3 November, the night, 1 RN needed and rn1 on leave. Fail: it runs without warning, or names the wrong day or shift.

- [ ] **Step 4: Run Optimize through the assistant**

Type: `Run it anyway.`
Pass: the assistant shows a Run card and starts nothing by itself. The run starts only when you press Run. It then reads the result and reports that the roster cannot be built (infeasible).

- [ ] **Step 5: Ask for help**

Type: `Why did it fail and what can I do?`
Pass, all of:
- One or two sentences: the night of 3 November needs 1 RN, and the only RN, rn1, is on leave. Stated as a fact.
- 2-3 options, one line each, best first. Expected: borrow an RN from the float pool, an agency or another ward for 3 November; ask rn1 whether she can give up her leave that day.
- Each option says who must agree.
- It asks what kind of leave rn1 has before offering to ask her.
- It tests the options on copies (activity line "Testing possible fixes…") and says which one tested solvable, or labels untested ones as untested.
Fail, any of: it suggests lowering the RN rule, running a night with no RN, removing a rest rule or cancelling leave without asking; it offers more than 3 options; it states a guess as a proven cause.

- [ ] **Step 6: Apply the leave option with the agreement step**

Type: `It is annual leave. Let's ask rn1.`
Pass: a Preview removes rn1's leave on 3 November. It shows the question "Has rn1 agreed to give up their leave on 03?", and Apply stays disabled until you answer yes. After the answer, Apply works.

- [ ] **Step 7: Re-run and confirm**

Type: `Run Optimize again.` and press Run on the card.
Pass: the run succeeds, and the assistant gives a short roster summary (review step). Open the roster: rn1 works the night of 3 November.

- [ ] **Step 8: Borrowed-nurse variant**

Press Undo on the leave change (or reload the step 5 state), run again (infeasible), and pick the borrow option: `Borrow an RN from Ward 5, call her Float RN.`
Pass: the Preview adds "Float RN" in the RN group, marks her off every day except 3 November, and asks "Has the lending ward or agency confirmed Float RN for 2026-11-03 to 2026-11-03, qualified as RN?" before Apply. After Apply, re-run: feasible, and Float RN works the night of 3 November.

- [ ] **Step 9: Record the result**

Pass overall only if Steps 1-8 all pass. Record any failure as a bd issue with the exact message the assistant gave:
`bd create "Live check: <step> failed" -d "<what it said / did>"`

---

## Self-Review

1. **Spec coverage.** Guided step order and readiness: Tasks 2 and 3. Minimum questions and one Preview per step: `SETUP_STEPS.ask` and `SETUP_INSTRUCTIONS` (Task 2). Static check: Task 1. Catalogue of 7 repairs, ranking, safety floor: Tasks 2 and 4. Host confirmations: Task 5 (leave already exists). Ward-language explanation with 2-3 options: Task 4 `explainFinding` / `buildFeasibilityReport`, Task 6 tool and authority sentence. Tested before offered as "tested": `FEASIBILITY_INSTRUCTIONS` plus the existing `test_feasibility_candidates`, verified live in Task 11 Step 5. Tool activity labels: Task 3. Help and `capability:generate`: Task 7. Locked tests with dated reasons: Tasks 3 and 6. Evaluation harness: Task 8. Infeasible-after-run acceptance, pure and real-solver: Tasks 8 and 9. Live verification: Task 11.
2. **Placeholders.** None. Where a dependency name can differ, the plan names the exact constant or field to change, and a test or tsc fails until it matches.
3. **Type consistency.** `StaffingFinding`, `RepairOption`, `SetupProgress` and `FeasibilityReport` are defined once and used with the same fields. `RepairId` values match between `REPAIRS`, `REPAIR_ORDER`, `BUILDERS` and `EXPECTED`.
4. **Review Focus.** Each of the 5 items has a named test in Task 1 or Task 4.

## Decisions

1. **The static check lives in `web/lib/rules/`, not in `lib/ai`.** It is deterministic and AI-free (bd memory `ai-features-optional-byo-key`: Tier-1 never depends on AI), and a non-AI screen can reuse it. It reports only proofs, so the assistant may name its findings as causes (evidence contract rule 1).
2. **Guidance is data in tool results, not a bigger prompt.** `buildAssistantContext` stays three entries. One sentence in `ASSISTANT_AUTHORITY_STATEMENT` points at the two tools.
3. **Home order, not "dates → shifts → people".** The brief listed shifts before people. The Home cards put Staff before Shifts, and neither depends on the other, so the assistant follows Home so that the user never sees two orders.
4. **Requests are optional for the assistant.** Home still counts them as a step (unchanged display). "Nobody has leave" must not block a run.
5. **Ranking is by situation, not one fixed list.** Capped, acute, chronic and unexplained each have their own order (`REPAIR_ORDER`), because the realistic first move differs. For example, a team limit is cheaper to relax than hiring agency staff for a week, but a single bad night is a float-pool call.
6. **`isSafeOption` is an allowlist.** Any operation type not named is refused. A new arm from a sibling plan cannot enter a repair silently.
7. **A borrowed nurse's loan is one block**, from the first to the last short date. This keeps an option within 3 operations per nurse and matches how a float nurse is loaned.
8. **"Run one short" edits the card's dates and adds a date-specific card** when the card covers other dates too. Lowering the whole card would change every day.

## Open Questions (each with a recommended answer)

1. **Should the static check also appear in the non-AI UI** (for example a banner on Optimize: "3 Nov night cannot be filled")? *Recommended:* yes, as a follow-up plan. It is AI-free and ready, and it is the Tier-1 promise. It is out of scope here to keep this plan to the assistant.
2. **A whole-period borrowed nurse has no days off, so the host cannot tell her from a new hire, and her agreement is asked only in chat.** *Recommended:* accept for now (Task 4 marks it `enforcedBy: "chat"`, and the harness pins it). Follow-up: the people-ops family adds a required `temporary: boolean` on `add_person`, with a Staff screen field for parity. Then `borrowed_staff_arranged` keys on that.
3. **Is `SOFT_REQUEST_WEIGHT = 10` the right strength for a softened request?** *Recommended:* yes for now. It is well above the default soft weights in the Requests editor and finite, so the solver breaks it only under pressure. Revisit after the first live use.
4. **Should "extra shift for a willing nurse" also cover contracted-hours rules?** *Recommended:* no. The edit arm excludes contracted-hours cards (rule-ops Follow-ups), and hours need a per-shift conversion. The builder skips them. Add it when rule-ops supports contracted hours.
5. **Should the host call `suggest_feasibility_options` itself after every infeasible run?** *Recommended:* no. Task 6 points the optimize result's infeasible `guidance` at the tool, and the authority sentence says the same. That is cheaper and keeps the model's turn in one place.
6. **The detector ignores succession, covering and minimum-count rules.** *Recommended:* accept. Those cases fall to the "unexplained" path and are tested on copies. Add a check only when a real ward hits a pattern the static check could prove.

## Assumptions

- The dependency arms have the shapes quoted in **Depends on** (read from the sibling plans on 2026-09-24). tsc and `playbook.test.ts` fail loudly if they differ.
- `useHotStore.getState().run.phase === "complete"` is set only after a finished run, as Home assumes (`home-guided.tsx`).
- `computeCoverageWarnings` stays importable from `@/components/requirements/requirements-model` without pulling React into the tool module (the rule-ops plan moves its value imports into `.ts` siblings). The tool module is client code either way.
- `serializeScenario` output is accepted by `scheduler.schedule` (it is the BFF submission path) and puts `appVersion` on its own top-level line.
- A 7-day, 2-4 nurse ward solves in well under 30 seconds on CP-SAT.
- The Preview renders any `OperationalAssumption` from its `question` and `detail` alone, and the repository blocks Apply on any outstanding one (true for the two existing types, and it keys on none of them).

## Follow-ups

- Non-AI banner for the static check on the Optimize screen (Open question 1).
- `add_person.temporary` so every borrowed nurse gets a host-enforced agreement (Open question 2).
- Home "Requests & Leave" card: show it as optional to match the assistant.
- Static checks for rest-rule chains (N then D bans) once a real ward needs them.
- Contracted-hours support for the extra-shift repair (Open question 4).
