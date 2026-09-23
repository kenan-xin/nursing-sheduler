# Assistant: Add Shift Types and Shift Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app schedule assistant prepare a batch of new shift types and shift groups in one proposal. Each shift has a code, a name, a start time, an end time and a rest break in minutes. An overnight shift is allowed. The code path is the same as the Shifts page.

**Architecture:** Add two arms to the assistant command union in `web/lib/proposal/commands.ts`: `add_shift_type` and `add_shift_group`. In `web/lib/proposal/operations.ts`, each arm calls the Shifts page's own pure functions (`addItem`, `addGroup`, `setGroupMembers` over `shiftTypesDescriptor`). The same gates apply: `validateFullEditId` and `validateWorkingTimeDraft`. The batch is the existing `operations` array of `prepare_scenario_change`. `applyAssistantCommands` checks each command against the document from the previous command. Thus a duplicate inside the batch is refused with no extra code. Preview, confirmation and Apply do not change. The diff shows clock times and group members. The help content says that the assistant can propose shift setup.

**Depends on:** a separate change that corrects `READ_ONLY_AUTHORITY_STATEMENT` (`web/lib/ai/assistant/scenario-context.ts:97`). Today that statement tells the model that it has no change tool, which is already wrong for the four existing ops. Release that change first. Without it, the model is likely to refuse the shift request. This plan does not edit that file.

**Tech Stack:** Next.js 16 (`web/`), TypeScript, zod v4, vitest 4, CopilotKit 1.66.2 (tool schema transport), oxlint, ast-grep.

**Spec:** There is no separate spec document. This plan implements the feature request of 2026-09-23. The real user request that it must handle is this quote:

> help me setup these shifts — am: am1 0800-1500, am2 0800-1600, am3 0800-1700; pm: pm1 1200-2100, pm2 1300-2100, pm3 1400-2100; long shift 0800-2030; Night shift 2000-0830

**Op design (decided):** Use two arms, `add_shift_type` and `add_shift_group`. Do not use one `add_shift_types` batch arm. The command list is already the batch: up to 25 ops, applied in order, and fail-closed. Each existing arm is one manual host operation. A batch arm needs its own duplicate check and ordering logic, and the fold already gives these. The user's example is 8 shifts and 4 groups, which is 12 ops. Shift groups are in scope because the scenario model has them (`ScenarioUiState.shiftGroups: UiShiftTypeGroup[]`), and the Shifts page makes them.

## Global Constraints

- Dependency: the `READ_ONLY_AUTHORITY_STATEMENT` correction is released before this plan (refer to **Depends on**). Do not edit `scenario-context.ts` in this plan.
- The only assistant mutation path is `prepare_scenario_change`. The user confirms in the Preview before a change occurs. Only the host applies.
- The model-facing time format is `"HH:MM"`, 24-hour. The model converts `"0800"` to `"08:00"`. The arm descriptions tell the model this.
- Clock times are on the 30-minute grid (`CLOCK_GRID_PATTERN = /^([01]\d|2[0-3]):(00|30)$/`). An end time before the start time means that the shift ends on the next day.
- `add_shift_type` has a required `restMinutes` field (integer minutes). The model sends `0` when the user gave no break. The host treats `0` as no rest, as the Shifts page sub-form does (`deriveValue`, `working-time-fields.tsx:75-94`). The Shifts page rules apply: rest is a non-negative multiple of 30 and less than the span (`working-time.ts:63-69`). Paid minutes = span - rest, from `paidMinutesFor`.
- Use the existing validation. Do not write a copy of it. The functions are `validateFullEditId`, `validateWorkingTimeDraft` and `paidMinutesFor`, all from `@/components/entity-editor/core`.
- Refuse a duplicate code against the live document and inside the batch. The message names the code.
- Duplicate codes use exact identity, as the Shifts page does. Thus `NIGHT` is accepted when `Night` exists (decision of 2026-09-23). Codes that are not case-sensitive are a separate ticket for the shared validator (`validateFullEditId`), for both surfaces.
- Shift codes and shift-group IDs share one namespace. This is the Shifts page rule. A group cannot use a shift code.
- Every arm field is required. Do not use `.optional()` or `.nullable()`. `model-visible-tools.test.ts` asserts that the advertised properties equal `required`. The CopilotKit converter has no `null` case.
- Each discriminant is a one-member `z.enum([...])`, not `z.literal`. Refer to the comment in `commands.ts`, lines 119-133.
- The arm order in `assistantCommandSchema` is the same as the order in `ASSISTANT_COMMAND_TYPES`. The wire test compares ordered lists. Add the new arms at the end of both.
- `lib/proposal` does not import React. `@/components/entity-editor/core` and `@/components/shift-types/shift-types-descriptor` have no React. Do not import `save-shift-card.ts`, `groups-section.tsx` or `shift-type-grid.tsx` from `operations.ts`.
- Tests: `cd web && pnpm vitest run <path>`. Gates: `pnpm typecheck` and `pnpm lint`. The disk is almost full. Do not run `pnpm install` or `pnpm build`.
- `test_feasibility_candidates` embeds the same union, so it also accepts the new arms. This is accepted and harmless: new shifts with no staffing requirement do not change feasibility.
- Out of scope (follow-ups): edit, rename or delete shifts. Add a shift to an existing group. Staffing counts for new shifts (refer to Follow-ups). People. Rules.

## Review Focus

1. A group with the name of a shift code. For example, shift `Night` exists and the model proposes group `Night`. Expected: refused, and the message names the group and says that the ID is in use. The tool text tells the model to use a different group name, such as "Night shifts". (Test: Task 1, `refuses a group id that is already a shift code`.)
2. A time that is not on the half-hour grid, for example "am1 0815-1500". Expected: refused, and the message names the shift and the 30-minute rule. Then the model can tell the user that the app accepts only :00 and :30. (Test: Task 1, `refuses an off-grid time`.)
3. Codes that differ only in case, for example `Night` exists and the model proposes `NIGHT`. Expected: accepted, because the Shifts page accepts it (IDs use exact identity). The test pins this as a known decision. Codes that are not case-sensitive are a separate shared-validator ticket. (Test: Task 1, `accepts a case-variant code, as the Shifts page does`.)
4. A group before its shifts in the same batch. Expected: refused, and the message tells the model to add the shift earlier in the same change. (Test: Task 1, `refuses a group whose shift comes later in the batch`.)
5. The Preview shows an overnight shift clearly, for example `20:00–08:30 (ends next day)`, not only the name. (Test: Task 3, `shows each new shift with its clock times`.)

---

## File Structure

- Modify `web/lib/proposal/commands.ts`: two new arms in the type union, in `ASSISTANT_COMMAND_TYPES` and in the zod union. Update the comment about the deliberate subset.
- Modify `web/lib/proposal/operations.ts`: `applyAddShiftType`, `applyAddShiftGroup` and two `switch` cases.
- Modify `web/lib/proposal/diff.ts`: the shift row shows times. The shift-group row lists members. `directKeys` names the new keys.
- Modify `web/lib/capability/help-content.ts`: the shift-types summary and the assistant-limits summary.
- Regenerate `web/lib/capability/registry.generated.ts` with `pnpm capability:generate`.
- Tests: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`, `web/lib/proposal/operations.parity.test.ts`, `web/lib/proposal/diff.test.ts`, `web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`.

---

### Task 1: Command arms and host operations

Arms and their host transforms land together: adding an arm to the union without its `switch` case breaks `tsc` (`applyAssistantCommand` must return on every path).

**Files:**
- Modify: `web/lib/proposal/commands.ts:11-17` (comment), `:39-77` (type + list), `:134-163` (zod union)
- Modify: `web/lib/proposal/operations.ts:25-40` (imports), `:303-319` (dispatch), new functions before `applyAssistantCommand`
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`
- Modify (locked lists): `web/lib/ai/phase-2-absence.test.ts:60-65`, `web/lib/ai/runtime/model-visible-tools.test.ts:266-285`

**Interfaces:**
- Consumes: `addItem`, `addGroup`, `setGroupMembers`, `validateFullEditId`, `validateWorkingTimeDraft`, `paidMinutesFor` from `@/components/entity-editor/core`. `shiftTypesDescriptor` from `@/components/shift-types/shift-types-descriptor`.
- Produces:
  - `AssistantCommandV1` arm `{ type: "add_shift_type"; code: string; name: string; startTime: string; endTime: string; restMinutes: number }`
  - `AssistantCommandV1` arm `{ type: "add_shift_group"; groupId: string; members: string[] }`
  - `ASSISTANT_COMMAND_TYPES` ends with `"add_shift_type", "add_shift_group"`.
  - Rejection messages start with `Shift "<trimmed code>": ` or `Shift group "<trimmed id>": `.

- [ ] **Step 1: Write the failing schema tests**

Append inside the existing `describe` in `web/lib/proposal/commands.test.ts`:

```ts
  it("accepts the shift-setup arms with HH:MM times", () => {
    const result = parseAssistantCommands([
      {
        type: "add_shift_type",
        code: "N",
        name: "Night shift",
        startTime: "20:00",
        endTime: "08:30",
        restMinutes: 60,
      },
      { type: "add_shift_group", groupId: "Night shifts", members: ["N"] },
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses shift-setup payloads the model must fix itself", () => {
    const refused: unknown[] = [
      // Time not converted to HH:MM.
      [
        {
          type: "add_shift_type",
          code: "am1",
          name: "",
          startTime: "0800",
          endTime: "15:00",
          restMinutes: 0,
        },
      ],
      // A required field omitted (name).
      [{ type: "add_shift_type", code: "am1", startTime: "08:00", endTime: "15:00", restMinutes: 0 }],
      // Rest omitted: the model must send 0 for no break.
      [{ type: "add_shift_type", code: "am1", name: "", startTime: "08:00", endTime: "15:00" }],
      // Rest that is not whole minutes.
      [
        {
          type: "add_shift_type",
          code: "am1",
          name: "",
          startTime: "08:00",
          endTime: "15:00",
          restMinutes: 12.5,
        },
      ],
      // Content alongside targets: paid minutes are the host's to derive.
      [
        {
          type: "add_shift_type",
          code: "am1",
          name: "",
          startTime: "08:00",
          endTime: "15:00",
          restMinutes: 0,
          durationMinutes: 420,
        },
      ],
      // A group with nothing in it.
      [{ type: "add_shift_group", groupId: "AM", members: [] }],
    ];
    for (const payload of refused) {
      expect(parseAssistantCommands(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });
```

- [ ] **Step 2: Write the failing operation tests**

Append to `web/lib/proposal/operations.test.ts` (fixture `proposalScenario()` already has shifts `Day` and `Night`):

```ts
describe("add_shift_type / add_shift_group", () => {
  const shift = (code: string, startTime: string, endTime: string, name = "", restMinutes = 0) => ({
    type: "add_shift_type" as const,
    code,
    name,
    startTime,
    endTime,
    restMinutes,
  });
  const group = (groupId: string, members: string[]) => ({
    type: "add_shift_group" as const,
    groupId,
    members,
  });

  it("sets up the ward's whole shift list in one batch", () => {
    // The real request: am1-3, pm1-3, a long shift and an overnight night shift, grouped.
    const result = applyAssistantCommands(proposalScenario(), [
      shift("am1", "08:00", "15:00"),
      shift("am2", "08:00", "16:00"),
      shift("am3", "08:00", "17:00"),
      shift("pm1", "12:00", "21:00"),
      shift("pm2", "13:00", "21:00"),
      shift("pm3", "14:00", "21:00"),
      shift("L", "08:00", "20:30", "Long shift"),
      shift("N", "20:00", "08:30", "Night shift"),
      group("AM", ["am1", "am2", "am3"]),
      group("PM", ["pm1", "pm2", "pm3"]),
      group("Long", ["L"]),
      group("Night shifts", ["N"]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = result.next.shifts.slice(2);
    expect(added.map((s) => s.id)).toEqual(["am1", "am2", "am3", "pm1", "pm2", "pm3", "L", "N"]);
    expect(added.find((s) => s.id === "am1")).toMatchObject({
      startTime: "08:00",
      endTime: "15:00",
      durationMinutes: 420,
    });
    // Overnight: 20:00 -> 08:30 next day is 12.5 hours.
    expect(added.find((s) => s.id === "N")).toMatchObject({
      description: "Night shift",
      startTime: "20:00",
      endTime: "08:30",
      durationMinutes: 750,
    });
    expect(result.next.shiftGroups.map((g) => [g.id, g.members])).toEqual([
      ["AM", ["am1", "am2", "am3"]],
      ["PM", ["pm1", "pm2", "pm3"]],
      ["Long", ["L"]],
      ["Night shifts", ["N"]],
    ]);
  });

  it("trims the code and drops an empty name, as the Shifts page does", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("  am1  ", "08:00", "15:00", "  "));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.next.shifts.at(-1);
    expect(created?.id).toBe("am1");
    expect(created?.description).toBeUndefined();
  });

  it("refuses a code that already exists, naming it", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("Day", "08:00", "15:00"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid_value");
    expect(result.rejection.message).toContain('Shift "Day"');
  });

  it("refuses a duplicate inside the batch at the second occurrence", () => {
    const result = applyAssistantCommands(proposalScenario(), [
      shift("am1", "08:00", "15:00"),
      shift("am1", "08:00", "16:00"),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.index).toBe(1);
    expect(result.rejection.message).toContain('Shift "am1"');
  });

  it("accepts a case-variant code, as the Shifts page does", () => {
    // Ids are exact-identity across the app; `Night` and `NIGHT` are distinct.
    expect(applyAssistantCommand(proposalScenario(), shift("NIGHT", "20:00", "08:30")).ok).toBe(true);
  });

  it("refuses reserved, numbers-only and empty codes", () => {
    for (const code of ["OFF", "all", "123", "   "]) {
      const result = applyAssistantCommand(proposalScenario(), shift(code, "08:00", "15:00"));
      expect(result.ok, code).toBe(false);
      if (!result.ok) expect(result.rejection.code).toBe("invalid_value");
    }
  });

  it("refuses an off-grid time", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("am1", "08:15", "15:00"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Shift "am1"');
    expect(result.rejection.message).toContain("30-minute grid");
  });

  it("refuses a shift whose start and end are the same", () => {
    expect(applyAssistantCommand(proposalScenario(), shift("x", "08:00", "08:00")).ok).toBe(false);
  });

  it("treats rest 0 as no break: paid minutes are the full span", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("L", "08:00", "20:30", "", 0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.next.shifts.at(-1);
    expect(created?.durationMinutes).toBe(750);
    // Stored as the Shifts page stores it: rest absent, not `restMinutes: 0`.
    expect(created?.restMinutes).toBeUndefined();
  });

  it("subtracts a rest break from the paid minutes, overnight too", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("N", "20:00", "08:30", "", 60));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.shifts.at(-1)).toMatchObject({ restMinutes: 60, durationMinutes: 690 });
  });

  it("refuses a rest the Shifts page cannot hold, naming the shift", () => {
    for (const [restMinutes, text] of [
      [-30, "non-negative multiple of 30"],
      [45, "non-negative multiple of 30"],
      [420, "less than the shift span"], // 08:00-15:00 span is 420
      [480, "less than the shift span"],
    ] as const) {
      const result = applyAssistantCommand(
        proposalScenario(),
        shift("am1", "08:00", "15:00", "", restMinutes),
      );
      expect(result.ok, String(restMinutes)).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code).toBe("invalid_value");
      expect(result.rejection.message).toContain('Shift "am1"');
      expect(result.rejection.message).toContain(text);
    }
  });

  it("refuses a group id that is already a shift code", () => {
    const result = applyAssistantCommand(proposalScenario(), group("Night", ["Day"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid_value");
    expect(result.rejection.message).toContain('Shift group "Night"');
  });

  it("refuses a group whose shift comes later in the batch", () => {
    const result = applyAssistantCommands(proposalScenario(), [
      group("AM", ["am1"]),
      shift("am1", "08:00", "15:00"),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.index).toBe(0);
    expect(result.rejection.code).toBe("unknown_target");
    expect(result.rejection.message).toContain('"am1"');
  });

  it("puts group members in shift order and ignores repeats", () => {
    const result = applyAssistantCommand(proposalScenario(), group("Both", ["Night", "Day", "Night"]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.shiftGroups.at(-1)?.members).toEqual(["Day", "Night"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: FAIL. The new schema cases do not parse. The operation cases fail because `add_shift_type` is unknown.

- [ ] **Step 4: Add the arms to `commands.ts`**

Replace the comment block at lines 11-16 ("THE SUBSET IS DELIBERATE ... Arms are additive under `schemaVersion`.") keeping its first paragraph, and add one sentence at the end:

```ts
// THE SUBSET IS DELIBERATE, and its boundary is the ticket's: an arm exists here
// only when the host already owns a validated transform for it. The tech plan's
// example list (`add_backup_person`, a generic `batch`, ...) is illustrative, not
// authorising -- inventing an arm whose host operation does not exist would let the
// model announce a capability no validated path can honour, which is the exact
// failure the closed flows forbid. Arms are additive under `schemaVersion`.
//
// `add_shift_type` / `add_shift_group` widen the original Phase-1 four on purpose:
// shift setup is Phase-1 scenario authoring, and both compile to the Shifts page's
// own primitives (`addItem` / `addGroup` / `setGroupMembers`), so the rule above holds.
```

Extend the type union (replace the `move_leave` arm's terminating `;` at line 67 with the two new arms):

```ts
  | { type: "move_leave"; personId: PersonRef; fromDate: DateRef; toDate: DateRef }
  /**
   * Add one shift type -- the Shifts page "Add shift" form with no staffing.
   * `endTime` before `startTime` is an overnight shift. `restMinutes: 0` means no
   * break. Paid minutes are derived by the host, never supplied.
   */
  | {
      type: "add_shift_type";
      code: string;
      name: string;
      startTime: string;
      endTime: string;
      restMinutes: number;
    }
  /** Add one shift group whose members are existing shift codes -- the Groups "New group" form. */
  | { type: "add_shift_group"; groupId: string; members: string[] };
```

Extend the list (lines 72-77):

```ts
export const ASSISTANT_COMMAND_TYPES = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
  "add_shift_type",
  "add_shift_group",
] as const satisfies readonly AssistantCommandType[];
```

Add a clock schema next to `isoDateSchema` (after line 103):

```ts
/** Shape only; the 30-minute grid and span rules are the Shifts page's, applied in `operations.ts`. */
const clockSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "a time must be written HH:MM in 24-hour form, e.g. 08:00 or 20:30");
```

Append two arms at the END of the `z.discriminatedUnion("type", [...])` array (after the `move_leave` arm, line 162):

```ts
  z.strictObject({
    type: z.enum(["add_shift_type"]),
    code: z
      .string()
      .describe(
        "The new shift's short code as shown on the roster, e.g. am1, N. Must not match any " +
          "existing shift code or shift group id, and must contain a letter.",
      ),
    name: z
      .string()
      .describe('The shift\'s longer name, e.g. "Night shift". Use "" when the user gave none.'),
    startTime: clockSchema.describe(
      "Start time, HH:MM 24-hour on the half hour. Convert what the user wrote: 0800 -> 08:00.",
    ),
    endTime: clockSchema.describe(
      "End time, HH:MM 24-hour on the half hour. An end earlier than the start means the " +
        "shift ends the next day (e.g. 20:00 to 08:30).",
    ),
    restMinutes: z
      .number()
      .int()
      .describe(
        "Unpaid break in whole minutes, a multiple of 30 and shorter than the shift. " +
          "Send 0 when the user gave no break.",
      ),
  }),
  z.strictObject({
    type: z.enum(["add_shift_group"]),
    groupId: z
      .string()
      .describe(
        "The new group's name. Shift codes and group names share one list, so it must differ " +
          'from every shift code -- e.g. "Night shifts" when a shift is called Night.',
      ),
    members: z
      .array(z.string())
      .min(1, "a shift group needs at least one shift")
      .describe(
        "Codes of the shifts in the group. Each must already exist or be added EARLIER in " +
          "the same change.",
      ),
  }),
```

- [ ] **Step 5: Add the host operations to `operations.ts`**

Add imports after the `@/lib/dates` import (line 31):

```ts
import {
  addGroup,
  addItem,
  paidMinutesFor,
  setGroupMembers,
  validateFullEditId,
  validateWorkingTimeDraft,
} from "@/components/entity-editor/core";
import { shiftTypesDescriptor } from "@/components/shift-types/shift-types-descriptor";
```

Extend the header comment's "VALIDATION PARITY" paragraph (after line 10) with:

```ts
// The shift arms call the Shifts page's own pure primitives (`addItem`, `addGroup`,
// `setGroupMembers`) behind the same gates the page's Save uses
// (`validateFullEditId`, `validateWorkingTimeDraft`, numbers-only code refusal), so
// they are shared code too. All of those live in React-free modules.
```

Insert before `/** Validate and apply exactly one command against \`state\`. */` (line 303):

```ts
function applyAddShiftType(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_shift_type" }>,
  index: number,
): OperationResult {
  const d = shiftTypesDescriptor;
  const idCheck = validateFullEditId(d, d.readItems(state), d.readGroups(state), command.code);
  if (!idCheck.ok) {
    return reject(index, "invalid_value", `Shift "${command.code.trim()}": ${idCheck.message}.`);
  }
  // The Shifts page forbids a numbers-only code (`shift-type-grid.tsx`, `codeNumericOnly`).
  if (/^\d+$/.test(idCheck.id)) {
    return reject(index, "invalid_value", `Shift "${idCheck.id}": a shift code must contain a letter.`);
  }
  // The same derived value the working-time sub-form produces (`deriveValue` in
  // `working-time-fields.tsx`): rest 0 is stored as absent, paid = span - rest. An
  // invalid rest leaves duration unset, and the validator reports the rest itself.
  const restMinutes = command.restMinutes || undefined;
  const workingTime = {
    startTime: command.startTime,
    endTime: command.endTime,
    restMinutes,
    durationMinutes: paidMinutesFor(command.startTime, command.endTime, restMinutes) ?? undefined,
  };
  const timeCheck = validateWorkingTimeDraft(workingTime);
  if (!timeCheck.ok) {
    return reject(index, "invalid_value", `Shift "${idCheck.id}": ${timeCheck.issues[0].message}`);
  }
  return {
    ok: true,
    next: addItem(state, d, {
      id: idCheck.id,
      description: command.name.trim() || undefined,
      extra: workingTime,
    }),
  };
}

function applyAddShiftGroup(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_shift_group" }>,
  index: number,
): OperationResult {
  const d = shiftTypesDescriptor;
  const items = d.readItems(state);
  const idCheck = validateFullEditId(d, items, d.readGroups(state), command.groupId, true);
  if (!idCheck.ok) {
    return reject(
      index,
      "invalid_value",
      `Shift group "${command.groupId.trim()}": ${idCheck.message}.`,
    );
  }
  const members = [...new Set(command.members)];
  const missing = members.find((member) => !items.some((item) => item.id === member));
  if (missing !== undefined) {
    return reject(
      index,
      "unknown_target",
      `Shift group "${idCheck.id}": there is no shift "${missing}". Add the shift earlier in the same change, or use an existing code.`,
    );
  }
  const withGroup = addGroup(state, d, { id: idCheck.id });
  return { ok: true, next: setGroupMembers(withGroup, d, idCheck.id, members) };
}
```

Add two cases to the `switch` in `applyAssistantCommand`:

```ts
    case "move_leave":
      return applyMoveLeave(state, command, index);
    case "add_shift_type":
      return applyAddShiftType(state, command, index);
    case "add_shift_group":
      return applyAddShiftGroup(state, command, index);
```

- [ ] **Step 6: Update the two locked lists, consciously**

In `web/lib/ai/phase-2-absence.test.ts`, replace the `PROPOSAL_OPERATIONS` constant (lines 60-65):

```ts
// WIDENED DELIBERATELY (2026-09-23, plan assistant-add-shift-types): shift setup is
// Phase-1 scenario authoring, not roster repair, and both arms compile to the Shifts
// page's own primitives. A Phase-2 verb here would still be caught by PHASE_2_VERBS.
const PROPOSAL_OPERATIONS = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
  "add_shift_type",
  "add_shift_group",
] as const;
```

In `web/lib/ai/runtime/model-visible-tools.test.ts`, add to the `representative` map (after the `move_leave` entry, line ~284):

```ts
      add_shift_type: {
        type: "add_shift_type",
        code: "N",
        name: "Night shift",
        startTime: "20:00",
        endTime: "08:30",
        restMinutes: 60,
      },
      add_shift_group: { type: "add_shift_group", groupId: "Night shifts", members: ["N"] },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts lib/ai/phase-2-absence.test.ts lib/ai/runtime/model-visible-tools.test.ts`
Expected: PASS. If `model-visible-tools.test.ts` fails on `members`, examine the wire JSON for the array property. It must arrive as `{ type: "array", items: { type: "string" } }`. `restMinutes` must arrive as `{ type: "integer" }`. The CopilotKit converter supports `integer` (refer to the comment in `use-proposal-tools.ts:31-43`). Read the failure before you change the schema.

- [ ] **Step 8: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors. (`diff.ts`'s `directKeys` switch has no return, so it compiles before Task 3.)

- [ ] **Step 9: Commit.** Do this step only if the session has commit authority. The default profile of this repo is "do not commit unless asked".

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/operations.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.test.ts web/lib/ai/phase-2-absence.test.ts web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): add_shift_type + add_shift_group proposal ops"
```

---

### Task 2: Manual-vs-assistant parity

These are characterisation tests. They pass on the first run. The mutation check in Step 3 proves that they find a defect.

**Files:**
- Test: `web/lib/proposal/operations.parity.test.ts` (append)

**Interfaces:**
- Consumes: `saveShiftTypeCard` from `@/components/shift-types/save-shift-card` (the real "Add shift" save). `addGroup`, `setGroupMembers`, `validateFullEditId`, `validateWorkingTimeDraft` and `paidMinutesFor` from `@/components/entity-editor/core`. `shiftTypesDescriptor`. The Task 1 arms.
- Produces: nothing new.

- [ ] **Step 1: Write the parity tests**

Add imports at the top of `web/lib/proposal/operations.parity.test.ts`:

```ts
import type { ScenarioUiState } from "@/lib/scenario";
import { saveShiftTypeCard } from "@/components/shift-types/save-shift-card";
import { shiftTypesDescriptor } from "@/components/shift-types/shift-types-descriptor";
import {
  addGroup,
  paidMinutesFor,
  setGroupMembers,
  validateFullEditId,
  validateWorkingTimeDraft,
} from "@/components/entity-editor/core";
```

Append:

```ts
describe("add_shift_type is the Shifts page's Add shift save", () => {
  // The value the working-time sub-form hands the grid, restated from `deriveValue`
  // in `working-time-fields.tsx:75-94`: rest 0 is absent, duration = paid minutes.
  const uiWorkingTime = (startTime: string, endTime: string, rest: number) => {
    const restMinutes = rest ? rest : undefined;
    return {
      startTime,
      endTime,
      restMinutes,
      durationMinutes: paidMinutesFor(startTime, endTime, restMinutes) ?? undefined,
    };
  };

  // The grid's own Save gate, restated from `shift-type-grid.tsx` (`canSave`).
  const gridCanSave = (
    state: ScenarioUiState,
    code: string,
    startTime: string,
    endTime: string,
    rest: number,
  ) => {
    const d = shiftTypesDescriptor;
    const idCheck = validateFullEditId(d, d.readItems(state), d.readGroups(state), code);
    const timeCheck = validateWorkingTimeDraft(uiWorkingTime(startTime, endTime, rest));
    return { ok: idCheck.ok && timeCheck.ok && !/^\d+$/.test(code.trim()), idCheck };
  };

  /** Run the REAL manual save, capturing the document its single commit produces. */
  async function manualAdd(
    state: ScenarioUiState,
    code: string,
    name: string,
    startTime: string,
    endTime: string,
    rest: number,
  ): Promise<ScenarioUiState> {
    let next = state;
    await saveShiftTypeCard(
      async (updater) => {
        next = { ...state, ...updater(state) };
        return { ok: true };
      },
      {
        mode: "add",
        fields: { code, name, workingTime: uiWorkingTime(startTime, endTime, rest) },
        staffing: { type: "none" },
      },
    );
    return next;
  }

  // The Rest select only offers multiples of 30 up to span - 30; the off-list values
  // below check that the shared validator refuses them on both paths.
  const matrix: [code: string, name: string, start: string, end: string, rest: number][] = [
    ["am1", "Morning 1", "08:00", "15:00", 0],
    ["N", "Night shift", "20:00", "08:30", 60],
    ["  L  ", "", "08:00", "20:30", 30],
    ["Day", "", "08:00", "15:00", 0], // duplicate
    ["OFF", "", "08:00", "15:00", 0], // reserved
    ["123", "", "08:00", "15:00", 0], // numbers only
    ["x", "", "08:15", "15:00", 0], // off grid
    ["x", "", "08:00", "08:00", 0], // zero span
    ["", "", "08:00", "15:00", 0], // empty
    ["x", "", "08:00", "15:00", 45], // rest off the 30-minute grid
    ["x", "", "08:00", "10:00", 120], // rest = span
    ["x", "", "08:00", "15:00", -30], // negative rest
  ];

  it("accepts and refuses the same shifts, and produces the same document", async () => {
    const state = proposalScenario();
    for (const [code, name, startTime, endTime, rest] of matrix) {
      const gate = gridCanSave(state, code, startTime, endTime, rest);
      const assistant = applyAssistantCommand(state, {
        type: "add_shift_type",
        code,
        name,
        startTime,
        endTime,
        restMinutes: rest,
      });
      expect(assistant.ok, `grid ${gate.ok ? "accepts" : "refuses"} "${code}"`).toBe(gate.ok);
      if (gate.ok && gate.idCheck.ok && assistant.ok) {
        // The grid passes the TRIMMED id (`idCheck.id`) as the code.
        const manual = await manualAdd(state, gate.idCheck.id, name, startTime, endTime, rest);
        expect(assistant.next).toEqual(manual);
      }
    }
  });
});

describe("add_shift_group is the Groups New group save", () => {
  // `groups-section.tsx` save for a new group: `addGroup` then `writeGroupMembers`,
  // which for a brand-new group is `setGroupMembers` over live items.
  const withShifts = (): ScenarioUiState => ({
    ...proposalScenario(),
    shifts: [...proposalScenario().shifts, { id: "am1" }, { id: "am2" }],
  });

  it("accepts and refuses the same group ids, and produces the same document", () => {
    const state = withShifts();
    const d = shiftTypesDescriptor;
    for (const groupId of ["AM", "Day", "ALL", "", "  AM  "]) {
      const idCheck = validateFullEditId(d, d.readItems(state), d.readGroups(state), groupId, true);
      const assistant = applyAssistantCommand(state, {
        type: "add_shift_group",
        groupId,
        members: ["am2", "am1"],
      });
      expect(assistant.ok, `group "${groupId}"`).toBe(idCheck.ok);
      if (idCheck.ok && assistant.ok) {
        const manual = setGroupMembers(
          addGroup(state, d, { id: idCheck.id, description: undefined }),
          d,
          idCheck.id,
          ["am2", "am1"],
        );
        expect(assistant.next).toEqual(manual);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify they pass**

Run: `cd web && pnpm vitest run lib/proposal/operations.parity.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation check (do not commit this)**

Change `applyAddShiftType` in `operations.ts` to pass `description: command.name` (no trim). Run the parity suite again. Make sure that a name case FAILS. Then revert the change. Do the same with `const restMinutes = command.restMinutes;` (keeps `0`): the rest-0 cases must FAIL. If no case fails, the parity assertion is vacuous. Fix the test before you continue.

- [ ] **Step 4: Commit** Do this step only if the session has commit authority.

```bash
git add web/lib/proposal/operations.parity.test.ts
git commit -m "test(assistant): shift op parity with Shifts page save"
```

---

### Task 3: Preview shows times, members, and classifies them as requested

**Files:**
- Modify: `web/lib/proposal/diff.ts:20` (import), `:283-296` (shift + shift-group render), `:345-362` (`directKeys`)
- Test: `web/lib/proposal/diff.test.ts`

**Interfaces:**
- Consumes: Task 1's arms (`command.code`, `command.groupId`).
- Produces: the diff keys `shift:"<code>"` (from `stableStringify`) and `shiftgroup:<groupId>` for the new arms. The `after` text of a shift entry is `<name or code> · HH:MM–HH:MM`, with ` (ends next day)` for an overnight shift. A shift-group entry shows its members, separated by commas.

- [ ] **Step 1: Write the failing test**

Append inside `describe("deriveProposalDiff", ...)` in `web/lib/proposal/diff.test.ts`:

```ts
  it("shows each new shift with its clock times and each new group with its shifts, as asked-for", () => {
    const before = proposalScenario();
    const commands = [
      {
        type: "add_shift_type" as const,
        code: " N ",
        name: "Night shift",
        startTime: "20:00",
        endTime: "08:30",
        restMinutes: 60,
      },
      {
        type: "add_shift_type" as const,
        code: "am1",
        name: "",
        startTime: "08:00",
        endTime: "15:00",
        restMinutes: 0,
      },
      { type: "add_shift_group" as const, groupId: "Night shifts", members: ["N", "Night"] },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.direct.map((entry) => entry.key).sort()).toEqual([
      'shift:"N"',
      'shift:"am1"',
      "shiftgroup:Night shifts",
    ]);
    expect(diff.cascade).toEqual([]);

    const night = diff.direct.find((entry) => entry.key === 'shift:"N"');
    expect(night?.kind).toBe("created");
    expect(night?.after).toBe("Night shift · 20:00–08:30 (ends next day)");
    expect(diff.direct.find((entry) => entry.key === 'shift:"am1"')?.after).toBe(
      "am1 · 08:00–15:00",
    );
    // Members follow shift order: Night (existing) before N (new).
    expect(diff.direct.find((entry) => entry.key === "shiftgroup:Night shifts")?.after).toBe(
      "Night, N",
    );
    expect(diff.capabilityIds).toContain("shift-types");
    expect(diff.needsReview).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm vitest run lib/proposal/diff.test.ts`
Expected: FAIL. The new entries are in `cascade` because no command names their keys. Also, `after` is `"Night shift"` with no times.

- [ ] **Step 3: Implement**

Change the import at line 20:

```ts
import type { CardsByKind, ScenarioUiState, UiRequestCell, UiShiftType } from "@/lib/scenario";
```

Add a helper next to `describeCoordinateCells`:

```ts
/** A shift as a ward manager reads it: name, then clock times, overnight made explicit. */
function renderShift(shift: UiShiftType): string {
  const name = shift.description?.trim() || `${shift.id}`;
  if (!shift.startTime || !shift.endTime) return name;
  // Grid-valid "HH:MM" strings compare correctly as text.
  const overnight = shift.endTime < shift.startTime ? " (ends next day)" : "";
  return `${name} · ${shift.startTime}–${shift.endTime}${overnight}`;
}
```

Replace the two shift `compareKeyed` blocks' `render` lines:

```ts
    ...compareKeyed(before.shifts, after.shifts, {
      scope: "shift-types",
      keyPrefix: "shift",
      identity: (shift) => stableStringify(shift.id),
      label: (shift) => `${shift.id}`,
      render: renderShift,
    }),
    ...compareKeyed(before.shiftGroups, after.shiftGroups, {
      scope: "shift-types",
      keyPrefix: "shiftgroup",
      identity: (group) => group.id,
      label: (group) => `Shift group “${group.id}”`,
      render: (group) => (group.members.length ? group.members.map(String).join(", ") : "No shifts"),
    }),
```

Add two cases to `directKeys`:

```ts
      case "add_shift_type":
        // The host trims the code (Shifts page rule), so the key must too.
        keys.add(`shift:${stableStringify(command.code.trim())}`);
        break;
      case "add_shift_group":
        keys.add(`shiftgroup:${command.groupId.trim()}`);
        break;
```

- [ ] **Step 4: Run to verify it passes, plus the neighbouring suites that render diffs**

Run: `cd web && pnpm vitest run lib/proposal components/ai/assistant-proposal.test.tsx lib/store/assistant-proposal.test.ts`
Expected: PASS. An existing assertion can pin the old shift text (`description || id`) or `"N members"` for a shift group. If so, change the assertion to the new format and write this in the commit message. Do not revert the new text.

- [ ] **Step 5: Commit** Do this step only if the session has commit authority.

```bash
git add web/lib/proposal/diff.ts web/lib/proposal/diff.test.ts
git commit -m "feat(assistant): preview shows shift times and group members"
```

---

### Task 4: Help content says the assistant can propose shift setup

The `READ_ONLY_AUTHORITY_STATEMENT` correction is not in this task. It is a separate change that is released first (refer to **Depends on**).

**Files:**
- Modify: `web/lib/capability/help-content.ts:62-74` (shift-types), `:279-293` (assistant limits)
- Regenerate: `web/lib/capability/registry.generated.ts`
- Test: `web/lib/capability/registry.generated.test.ts` (existing stale-manifest gate, no edits)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a new manifest hash in `registry.generated.ts`.

- [ ] **Step 1: Update the help content**

In `help-content.ts`, `shift-types` entry `nurseFacingSummary`:

```ts
    nurseFacingSummary:
      "Define each kind of shift the ward runs — its code, name, clock times and rest break — " +
      "and group related shifts together, such as all the night shifts. The assistant can also " +
      "prepare new shifts and shift groups for you to review and apply.",
```

`ai-assistant-conversation` entry `nurseFacingSummary`:

```ts
    nurseFacingSummary:
      "Once it is on, the assistant can read the set-up you have open, explain how the app " +
      "works, and suggest which rule expresses a policy you describe. It can also prepare a few " +
      "kinds of change — the roster period, turning a rule on or off, a staffing head count, " +
      "moving leave, and adding new shifts and shift groups — which you review and apply " +
      "yourself. It cannot change the roster on its own, and it cannot edit or delete existing " +
      "shifts. It is not a source of employment, legal or clinical-safety authority.",
```

- [ ] **Step 2: Run the manifest gate to verify it fails**

Run: `cd web && pnpm vitest run lib/capability/registry.generated.test.ts`
Expected: FAIL. The recomputed manifest hash does not match `registry.generated.ts`.

- [ ] **Step 3: Regenerate the capability manifest**

Run: `cd web && pnpm capability:generate`
Expected: `registry.generated.ts` changes (new `manifestSha256` and `canonicalByteLength`). Examine the generated diff. Only the hash and length fields change.

- [ ] **Step 4: Run the affected suites to verify they pass**

Run: `cd web && pnpm vitest run lib/capability lib/ai/phase-2-absence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** Do this step only if the session has commit authority.

```bash
git add web/lib/capability/help-content.ts web/lib/capability/registry.generated.ts
git commit -m "docs(help): assistant can propose shifts and shift groups"
```

---

### Task 5: Whole-branch gates

**Files:** none new.

- [ ] **Step 1: Run the suites that embed the command union**

Run: `cd web && pnpm vitest run lib/proposal lib/ai lib/capability lib/repository/assistant-apply.test.ts lib/store/assistant-proposal.test.ts components/ai components/shift-types`
Expected: PASS. `lib/repository/assistant-apply.test.ts` re-derives through `applyAssistantCommands`, so it covers Apply without edits.

- [ ] **Step 2: Typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm lint`
Expected: no errors. If oxlint flags the `@/components/...` imports in `lib/proposal/operations.ts`, stop and report: no current rule restricts them (checked `web/.oxlintrc.json` overrides and `web/ast-grep/rules`), so a hit means the config changed.

- [ ] **Step 3: Manual smoke (optional, needs a running dev server and an AI key)**

Make sure that the `READ_ONLY_AUTHORITY_STATEMENT` change is released. Paste the real request into the assistant on `/shift-types`. Expected: one Preview shows 8 shifts with times and the groups. The night shift shows "ends next day". No change occurs until Apply. After Apply, the Shifts page shows the shifts. If the model uses a shift code as a group ID, the host refuses the Preview with its message. Then the model tries again with different names.

---

## Self-Review

- **Spec coverage.** Batch create: Task 1, one `operations` array, test "sets up the ward's whole shift list". Name and start/end times: Task 1 arm fields. Overnight: Task 1 (`durationMinutes` 750) and Task 3 ("ends next day"). Rest: Task 1 tests for rest 0 (paid = span), rest 60 (paid 690 overnight) and invalid rest (-30, 45, = span, > span) with the shift name in the message. Task 2 parity rows for rest. Groups: Task 1 `add_shift_group`, because the model has `shiftGroups`. HH:MM with model conversion: Task 1 `clockSchema` and descriptions. Duplicates against the document and inside the batch: Task 1 tests. Case-only duplicates accepted: Task 1 test and Global Constraints. Same Preview, confirmation and Apply: no change to `use-proposal-tools.ts`, and Task 5 Step 1 runs the suites. Help text: Task 4. Authority statement: removed from this plan and stated as a dependency in the header and Global Constraints. `test_feasibility_candidates`: one line in Global Constraints. Locked op list, with its reason: Task 1 Step 6. Parity: Task 2. Validation reuse: Task 1 imports, and no rule is copied.
- **Placeholder scan.** No TBD or TODO. Each code step has code.
- **Type consistency.** Tasks 1-3 use the same arm fields: `code`, `name`, `startTime`, `endTime`, `restMinutes`, `groupId`, `members`. Each `add_shift_type` literal in Tasks 1-3 (schema tests, operation tests, wire representative, parity, diff) has `restMinutes`. Only Task 1 and the Task 2 mutation check refer to `applyAddShiftType` and `applyAddShiftGroup`.
- **Review Focus.** Each of the five lines has a test in its task: four in Task 1 and one in Task 3.

## Decisions (accepted 2026-09-23)

1. Codes that differ only in case: keep parity with the Shifts page and accept them. Codes that are not case-sensitive are a separate ticket for the shared validator.
2. The `READ_ONLY_AUTHORITY_STATEMENT` correction is released first as its own change. This plan depends on it and does not edit it.
3. `restMinutes` is a required field of `add_shift_type` now, with the Shifts page rules.
4. Staffing for new shifts is a follow-up (refer to Follow-ups).
5. `test_feasibility_candidates` accepts the new arms. This is harmless.

## Follow-ups

- **Staffing counts for new shifts.** `set_staffing_requirement_people` cannot set staffing for a shift that `add_shift_type` made in the same batch. The evidence:
  - The arm targets an existing requirement card by `ruleId`, not a shift (`web/lib/proposal/commands.ts:59`, schema `:152-156`).
  - The host finds the card by `uid` and refuses `unknown_target` when there is no card (`web/lib/proposal/operations.ts:223-229`). It only changes `requiredNumPeople` on that card (`:247-252`).
  - `add_shift_type` makes no requirement card. It calls only `addItem` (Task 1, Step 5), the same as `saveShiftTypeCard` with `staffing: { type: "none" }`, which returns before the requirement code (`web/components/shift-types/save-shift-card.ts:420`). A requirement is made only on the staffing path (`:455`, `patch = { type: "add", form }`).
  - No other arm makes a requirement card, and the model cannot know a new card's `uid`.

  A follow-up op (for example `set_shift_staffing { code, requiredNumPeople }` through `saveShiftTypeCard`'s staffing path) is necessary.
- Case-insensitive shift codes in `validateFullEditId`, for both surfaces.
- Edit, rename or delete shifts. Add a shift to an existing group.

## Open Questions

None remain from the first review.

## Assumptions

- The `READ_ONLY_AUTHORITY_STATEMENT` correction is released before this plan is used live. The unit tests in this plan do not depend on it.
- Before it proposes shifts, the model reads the existing shift codes with `get_schedule_section` (domain `shifts`). If it does not, the host refusal names the clash.
- The model selects short codes (`L`, `N`) and puts the user's words in `name`. The host does not make codes.
- The model sends `restMinutes: 0` when the user gives no break, as the arm description says. The user's example has no breaks, so all its shifts are paid for the full span.
- The assistant cannot use a numeric shift ID as a group member, because members are strings with exact match. This is acceptable, because the Shifts page does not let users make numbers-only codes.
- 25 ops in one proposal is sufficient for the shift setup of a ward. A larger setup uses two proposals.
- `saveShiftTypeCard` with `staffing: { type: "none" }` and one `commit` is the full manual "Add shift" write (checked in `save-shift-card.ts:386-448`).
- For a new group, the private `writeGroupMembers` in `groups-section.tsx` gives the same result as `setGroupMembers`, because there are no unknown members to keep. The Task 2 group parity test copies this behaviour and does not export the private function.
