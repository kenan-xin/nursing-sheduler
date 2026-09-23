# Assistant: People (Staff) Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The in-app assistant can propose every change the Staff screen can make. For a person, that is add, rename or regroup, and remove. For a staff group, that is add, edit and remove. The assistant can also propose a nurse borrowed from another ward (float pool or agency) who works only on some dates. Each change goes through `prepare_scenario_change` → Preview → the user's Apply.

**Architecture:** Append seven arms to the assistant command union in `web/lib/proposal/commands.ts`: `add_person`, `edit_person`, `remove_person`, `add_people_group`, `edit_people_group`, `remove_people_group`, `mark_person_off`. `web/lib/proposal/operations.ts` compiles each arm to the pure functions the Staff screen calls, over `peopleDescriptor`: `addItem`, `renameItem`, `deleteItem`, `addGroup`, `renameGroup`, `updateGroupFields`, `deleteGroup`. The gate is the same too: `validateFullEditId`. The two membership writers are private inside React files today. Task 1 moves them into the React-free core (`writeItemGroups`, `writeGroupMembers`), and the screens use them from there. A borrowed nurse is `add_person` plus `mark_person_off` on the days before and after the loan. `mark_person_off` is the Requests screen's quick paint of `OFF` at weight `Infinity` across a run of days. The Preview names people, group members, renames and runs of days off in plain words. The leave questions (`deriveAssumptions`) stop asking about leave that a rename only re-labels.

**Tech Stack:** Next.js 16 (`web/`), TypeScript, zod v4, vitest 4, CopilotKit 1.66.2 (tool schema transport), oxlint, ast-grep.

**Spec:** There is no separate spec document. This plan implements the controller's request of 2026-09-24 and the binding product decision in `docs/ai-assistant.md` ("Product decision (2026-09-23)"). That decision says the assistant can propose anything the UI can do, and every change goes through Preview and the user's Apply. Template: `docs/superpowers/plans/2026-09-23-assistant-add-shift-types.md` and its merged implementation. The realistic case it must handle:

> borrow one RN from Ward 5 for nights on 12-14 Oct

**How the UI does it today (read before coding):**

| UI action | File | Pure transform the UI commits |
|---|---|---|
| Add nurse (name + group toggles) | `web/components/people/people-table.tsx:740-745` | `addItem(live, peopleDescriptor, { id })` then `writeGroups(…, id, draftGroups)` |
| Edit nurse (rename + group toggles) | `people-table.tsx:747-757` | when the raw text changed (`name !== String(item.id)`, `:719`): `renameItem`. Then `writeGroups` |
| Delete nurse | `people-table.tsx:419-422` | `deleteItem` = `deleteEntity(state, "person", id)`. **No dialog asks first.** It cascades: group members, rule fields (a rule whose required person field empties is dropped), request cells, export rows (`web/lib/cascade/delete.ts`) |
| New / edit staff group (id, description, members) | `web/components/entity-editor/groups-section.tsx:769-790` | Add: `addGroup`. Edit: when the id text changed, `renameGroup`, then `updateGroupFields({ description: trim \|\| undefined })`. Both: `writeGroupMembers` (SET model, keeps nested/unknown members) |
| Delete staff group | `groups-section.tsx:670-676` | `deleteGroup` (cascade, no dialog) |
| Person unavailable on some days | `web/components/requests/*` quick paint + `web/lib/store/paint.ts` `foldGesture` | per coordinate: XOR-replace with one `{ kind: "off", weight }` cell, keeping a prior day-state cell's `uid`. Weight `Infinity` is a hard "must be off" (`core/nurse_scheduling/utils.py:41-44`) |

The Staff table does not edit a person's `description` (it keeps it unchanged, `people-table.tsx:14-15`). So the arms do not edit it either. Duplicate, reorder and Upload list are not in this plan (refer to Follow-ups).

## Global Constraints

- The only assistant mutation path is `prepare_scenario_change`. The user approves in the Preview. Only the host applies. `use-proposal-tools.ts` is not changed.
- Every arm field is required. Do not use `.optional()` or `.nullable()` (`model-visible-tools.test.ts` asserts advertised properties equal `required`, and the CopilotKit converter has no `null` case).
- Each discriminant is a one-member `z.enum([...])`, never `z.literal` (refer to the comment in `commands.ts` above `assistantCommandSchema`).
- Add new arms at the END of the type union, `ASSISTANT_COMMAND_TYPES`, the zod union, `PROPOSAL_OPERATIONS` and the `representative` map, in this order: `add_person`, `edit_person`, `remove_person`, `add_people_group`, `edit_people_group`, `remove_people_group`, `mark_person_off`.
- Sibling plans written on 2026-09-24 also append arms to these same lists and edit the same `ai-assistant-conversation` help summary. Whichever merges second rebases: keep both sets of arms in merge order, and merge the help sentence (keep their clauses, add ours). Do not reorder existing arms.
- Reuse the Staff screen's pure functions. Do not write a copy. Person and staff-group ids use `validateFullEditId(peopleDescriptor, …)`. People and staff groups share one id namespace. Only `ALL` is reserved (case-insensitive).
- Person references are exact identity (`1` and `"1"` are different, `sameEntityId`). The model sends a person id exactly as the staff list shows it. A numeric id stays a number (`refSchema` = `string | number`).
- A rejection message starts with `Person "<id>": ` or `Staff group "<id>": ` so the model can correct itself.
- Unavailable days are `OFF` at weight `Infinity`, not `LEAVE` (Decision 1). `mark_person_off` takes ISO dates (`YYYY-MM-DD`). The model can read the roster period (`rangeStart`/`rangeEnd`). It is never given the date-id format (`get_schedule_section("dates")`, `web/components/ai/use-context-tools.ts:115-120`).
- Operations stay pure and deterministic (Apply re-derives the document, `web/lib/repository/repository.ts:1280`). New request cells get a deterministic, unique `uid` (never `crypto.randomUUID()`). Workspace serialization throws on a cell without a `uid` (`web/lib/scenario/workspace.ts:718-724`).
- `lib/proposal` does not import React. `@/components/entity-editor/core`, `@/components/people/people-descriptor` and `@/lib/cascade` have no React. Do not import `people-table.tsx` or `groups-section.tsx` from `lib/proposal`.
- Removing a person or group does what the UI does: it cascades, with no block. The host's existing leave check (`deriveAssumptions` → `leave_cancelled`) asks once for each leave day the cascade destroys. Apply stays disabled until the user answers.
- Tests: `cd web && pnpm vitest run <path>`. Typecheck: `pnpm typecheck`. Lint: `pnpm exec oxlint && pnpm exec ast-grep scan`. pnpm 11 can map `pnpm lint` to something else. Do not run `pnpm install` or `pnpm build` (the disk is almost full).
- Commit steps need commit authority for the session. The repo default is "do not commit unless asked".

## Review Focus

1. The model sends person id `"7"` for a person whose id is the number `7`. Expected: refused. The message names `"7"` and says a number stays a number. (Test: Task 2, `refuses a numeric id sent as text, and says why`.)
2. A person who has leave is renamed. Expected: the leave follows them, and the Preview does NOT ask "Has ana agreed to give up their leave". (Test: Task 5, `a rename relabels leave; it does not ask about giving it up`.)
3. A person who has leave and is named in a rule is removed. Expected: accepted, as the Staff screen accepts it. The Preview lists the dropped rule and the removed request cells under consequences, and asks once for each leave day. (Tests: Task 5, `removing a person lists what goes with them` and `removing a person asks about each leave day`.)
4. `mark_person_off` over a day where the person already has leave. Expected: the leave becomes a must-be-off day, as a quick-paint does. The Preview shows that day as changed, and the host asks about the lost leave. (Tests: Task 3, `replaces what is on those days and keeps a day-state uid`. Task 5, `marking a person off over their leave asks about it`.)
5. A date outside the roster period, for example the model uses the wrong month. Expected: refused. The message names both dates and the roster period. (Test: Task 3, `refuses dates outside the roster period, naming it`.)

---

## File Structure

- Modify `web/components/entity-editor/core/mutations.ts` and `core/index.ts`: export `writeItemGroups` and `writeGroupMembers`, moved from the two React files.
- Modify `web/components/people/people-table.tsx` and `web/components/entity-editor/groups-section.tsx`: delete the private copies and import from core. The behaviour is the same.
- Modify `web/lib/store/paint.ts`: export `foldGesture` (one word), so the parity test drives the real quick-paint fold.
- Modify `web/lib/proposal/commands.ts`: seven arms (type, list, zod) and the comment about the deliberate subset.
- Modify `web/lib/proposal/operations.ts`: seven `apply*` functions and switch cases.
- Modify `web/lib/proposal/diff.ts`: staff-group members in plain words, "Must be off", rename merge, collapse runs of days off, `directKeys` for the new arms.
- Modify `web/lib/proposal/assumptions.ts`: follow renames before it asks about destroyed leave.
- Modify `web/lib/proposal/test-support.ts`: add the `peopleScenario()` fixture.
- Modify `web/lib/capability/help-content.ts` and regenerate `registry.generated.ts`.
- Tests: `core/mutations.test.ts`, `lib/proposal/{commands,operations,operations.parity,diff,assumptions}.test.ts`, `lib/ai/phase-2-absence.test.ts`, `lib/ai/runtime/model-visible-tools.test.ts`.

---

### Task 1: Move the two membership writers into the core

The Staff row's `writeGroups` (`people-table.tsx:864-882`) and the group form's `writeGroupMembers` (`groups-section.tsx:222-249`) are pure, but they are private in `"use client"` files. The assistant must call the same code, so move them into the core. No behaviour changes.

**Files:**
- Modify: `web/components/entity-editor/core/mutations.ts` (append after `toggleGroupMembership`)
- Modify: `web/components/entity-editor/core/index.ts` (mutations export list)
- Modify: `web/components/people/people-table.tsx:67-80` (imports), `:740-757` (calls), `:864-882` (delete)
- Modify: `web/components/entity-editor/groups-section.tsx:90-105` (imports), `:222-249` (delete)
- Test: `web/components/entity-editor/core/mutations.test.ts`

**Interfaces:**
- Consumes: `toggleGroupMembership`, `setGroupMembers` (same file).
- Produces:
  - `writeItemGroups<TItem>(state: ScenarioUiState, descriptor: EntityDescriptor<TItem>, itemId: EntityId, desiredGroupIds: readonly string[]): ScenarioUiState`
  - `writeGroupMembers<TItem>(state: ScenarioUiState, descriptor: EntityDescriptor<TItem>, groupId: string, desiredItemMembers: readonly EntityId[]): ScenarioUiState`

- [ ] **Step 1: Write the failing tests**

Add `writeGroupMembers` and `writeItemGroups` to the `./mutations` import list at the top of `web/components/entity-editor/core/mutations.test.ts`, and append:

```ts
describe("writeItemGroups (the Staff row's group toggles)", () => {
  it("sets one person's membership to exactly the desired groups", () => {
    const state = fixture();
    state.staffGroups = [
      { id: "TeamA", members: ["P1", "P3"] },
      { id: "TeamB", members: ["P2"] },
    ];
    const after = writeItemGroups(state, peopleDescriptor(), "P1", ["TeamB"]);
    expect(after.staffGroups).toEqual([
      { id: "TeamA", members: ["P3"] },
      { id: "TeamB", members: ["P1", "P2"] },
    ]);
  });

  it("ignores a group id that is not in the slice, and returns the same state when nothing moves", () => {
    const state = fixture();
    expect(writeItemGroups(state, peopleDescriptor(), "P1", ["TeamA", "Ghost"])).toBe(state);
  });
});

describe("writeGroupMembers (the group form's SET write)", () => {
  it("writes exactly the live items asked for, keeping the group's unknown members", () => {
    const state = fixture();
    state.staffGroups = [{ id: "TeamA", members: ["P3", "Nested"] }];
    const after = writeGroupMembers(state, peopleDescriptor(), "TeamA", ["P2", "Ghost", "P1"]);
    expect(after.staffGroups[0].members).toEqual(["P1", "P2", "Nested"]);
  });

  it("returns the same state for an unknown group", () => {
    const state = fixture();
    expect(writeGroupMembers(state, peopleDescriptor(), "Nope", ["P1"])).toBe(state);
  });
});
```

- [ ] **Step 2: Run to check it fails**

Run: `cd web && pnpm vitest run components/entity-editor/core/mutations.test.ts`
Expected: FAIL. `writeItemGroups` and `writeGroupMembers` are not exported.

- [ ] **Step 3: Move the functions into the core**

Append to `web/components/entity-editor/core/mutations.ts`, after `toggleGroupMembership`:

```ts
/**
 * Write one item's membership to EXACTLY `desiredGroupIds` (SET model, idempotent):
 * for every live group, add or remove the item to match. A desired id that is not a
 * live group is ignored; every other member is untouched. The Staff row editor's
 * group toggles, and the assistant's `add_person` / `edit_person`.
 */
export function writeItemGroups<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  itemId: EntityId,
  desiredGroupIds: readonly string[],
): ScenarioUiState {
  const desired = new Set(desiredGroupIds);
  let next = state;
  for (const group of descriptor.readGroups(state)) {
    const isMember = group.members.some((member) => sameId(member, itemId));
    if (isMember !== desired.has(group.id)) {
      next = toggleGroupMembership(next, descriptor, group.id, itemId);
    }
  }
  return next;
}

/**
 * Write a group's membership to EXACTLY `desiredItemMembers` that are live items, plus
 * the group's own unknown/nested members kept as they are (a SET model). Idempotent:
 * `setGroupMembers` returns the same state when the sequence is unchanged. The group
 * form's Save, and the assistant's `add_people_group` / `edit_people_group`.
 */
export function writeGroupMembers<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  groupId: string,
  desiredItemMembers: readonly EntityId[],
): ScenarioUiState {
  const group = descriptor.readGroups(state).find((g) => g.id === groupId);
  if (!group) return state;
  const items = descriptor.readItems(state);
  const isItem = (member: EntityId) => items.some((item) => sameId(item.id, member));
  const realMembers = desiredItemMembers.filter(isItem);
  const unknownMembers = group.members.filter((member) => !isItem(member));
  return setGroupMembers(state, descriptor, groupId, [...realMembers, ...unknownMembers]);
}
```

In `web/components/entity-editor/core/index.ts`, add the two names to the `./mutations` export list after `toggleGroupMembership,`:

```ts
  toggleGroupMembership,
  writeItemGroups,
  writeGroupMembers,
```

- [ ] **Step 4: Point the two screens at the core**

In `web/components/people/people-table.tsx`:
- In the `@/components/entity-editor/core` import, replace `toggleGroupMembership,` with `writeItemGroups,`.
- Replace the add commit (lines 742-744) with:

```ts
        commit((live) =>
          writeItemGroups(addItem(live, descriptor, { id: check.id }), descriptor, check.id, draftGroups),
        );
```

- Replace `return writeGroups(renamed, effectiveId, draftGroups);` (line 755) with:

```ts
          return writeItemGroups(renamed, descriptor, effectiveId, draftGroups);
```

- Delete the `writeGroups` function and its doc comment (lines 864-882).

In `web/components/entity-editor/groups-section.tsx`:
- In the `@/components/entity-editor/core` import, replace `setGroupMembers,` with `writeGroupMembers,`.
- Delete the "Membership SET writer" section: the banner comment, the doc comment and the `writeGroupMembers` function (lines 222-249). The call at line 790 (`writeGroupMembers(next, descriptor, gid, draftMembers)`) now resolves to the core export with the same signature.

- [ ] **Step 5: Run the tests to check they pass, including the two screens**

Run: `cd web && pnpm vitest run components/entity-editor components/people`
Expected: PASS. The screen suites (`people-table.test.tsx`, `people-v2-roles.test.tsx`, `groups-section.test.tsx`) pass without edits, because the behaviour is the same.

- [ ] **Step 6: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors. An "unused import" means a name is still in an import list. Remove it.

- [ ] **Step 7: Commit** (only with commit authority)

```bash
git add web/components/entity-editor/core/mutations.ts web/components/entity-editor/core/index.ts web/components/entity-editor/core/mutations.test.ts web/components/people/people-table.tsx web/components/entity-editor/groups-section.tsx
git commit -m "refactor(staff): membership writers live in entity-editor core"
```

---

### Task 2: Six Staff-screen arms and their host operations

Add the arms and their host transforms in one task. An arm in the union without its `switch` case breaks `tsc`.

**Files:**
- Modify: `web/lib/proposal/commands.ts` (comment block at the top, type union, `ASSISTANT_COMMAND_TYPES`, zod union)
- Modify: `web/lib/proposal/operations.ts` (imports, header comment, new functions before `applyAssistantCommand`, switch)
- Modify: `web/lib/proposal/test-support.ts` (new fixture)
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`
- Modify (locked lists): `web/lib/ai/phase-2-absence.test.ts` (`PROPOSAL_OPERATIONS`), `web/lib/ai/runtime/model-visible-tools.test.ts` (`representative`)

**Interfaces:**
- Consumes: Task 1's `writeItemGroups`, `writeGroupMembers`. `addItem`, `renameItem`, `deleteItem`, `addGroup`, `renameGroup`, `updateGroupFields`, `deleteGroup`, `validateFullEditId`, `isReservedKeyword` from `@/components/entity-editor/core`. `peopleDescriptor` from `@/components/people/people-descriptor`. `RenameCollisionError` from `@/lib/cascade`. `stableStringify` from `./digest`.
- Produces:
  - Arms `{ type: "add_person"; name: string; groups: string[] }`, `{ type: "edit_person"; personId: PersonRef; name: string; groups: string[] }`, `{ type: "remove_person"; personId: PersonRef }`, `{ type: "add_people_group"; groupId: string; description: string; members: PersonRef[] }`, `{ type: "edit_people_group"; groupId: string; newGroupId: string; description: string; members: PersonRef[] }`, `{ type: "remove_people_group"; groupId: string }`.
  - `peopleScenario(): ScenarioUiState` in `test-support.ts`, used by Tasks 3-5.
  - The helper `findPerson(state, personId)` in `operations.ts`, used by Task 3.

- [ ] **Step 1: Add the shared fixture**

Append to `web/lib/proposal/test-support.ts`:

```ts
/**
 * A ward for the people arms. It is `proposalScenario()` moved to October 2026 (a
 * one-month range, so date ids stay two-digit `DD`), plus:
 *
 *   • a person with a NUMERIC id (`7`), for the exact-identity rule;
 *   • two staff groups, one with a description;
 *   • a shift-count rule that names only `bo`, so removing `bo` drops it (cascade).
 *
 * The fixture cells stay: `ana` leave on 02, `bo` off on 29, `ana` Day request on 07.
 */
export function peopleScenario(): ScenarioUiState {
  const base = proposalScenario();
  return {
    ...base,
    rangeStart: "2026-10-01",
    rangeEnd: "2026-10-31",
    staff: [...base.staff, { _k: "p3", id: 7 }],
    staffGroups: [
      { _k: "sg1", id: "RN", members: ["ana", 7] },
      { _k: "sg2", id: "Seniors", description: "Band 6 and above", members: ["bo"] },
    ],
    cardsByKind: {
      ...base.cardsByKind,
      counts: [
        {
          uid: "count-bo",
          description: "Bo night cap",
          person: ["bo"],
          countDates: ["ALL"],
          countShiftTypes: ["Night"],
          expression: "<=",
          target: 8,
          weight: -1,
        },
      ],
    },
  };
}
```

- [ ] **Step 2: Write the failing schema tests**

Append inside the existing top-level `describe` in `web/lib/proposal/commands.test.ts`:

```ts
  it("accepts the Staff-screen arms", () => {
    const result = parseAssistantCommands([
      { type: "add_person", name: "Float RN (Ward 5)", groups: ["RN"] },
      { type: "edit_person", personId: 7, name: "7", groups: [] },
      { type: "remove_person", personId: "bo" },
      { type: "add_people_group", groupId: "Night team", description: "", members: ["ana", 7] },
      {
        type: "edit_people_group",
        groupId: "RN",
        newGroupId: "Registered nurses",
        description: "",
        members: ["ana"],
      },
      { type: "remove_people_group", groupId: "Seniors" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses Staff-screen payloads the model must fix itself", () => {
    const refused: unknown[] = [
      // groups omitted: the model must send [] for "no groups".
      [{ type: "add_person", name: "Cara" }],
      // A description the Staff table cannot author.
      [{ type: "add_person", name: "Cara", groups: [], description: "Agency" }],
      // name omitted on an edit: send the current name to keep it.
      [{ type: "edit_person", personId: "ana", groups: [] }],
      // description omitted on a group: send "" for none.
      [{ type: "add_people_group", groupId: "X", members: [] }],
      // members not a list.
      [{ type: "add_people_group", groupId: "X", description: "", members: "ana" }],
      // newGroupId omitted: send the current id to keep it.
      [{ type: "edit_people_group", groupId: "RN", description: "", members: [] }],
    ];
    for (const payload of refused) {
      expect(parseAssistantCommands(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });
```

- [ ] **Step 3: Write the failing operation tests**

In `web/lib/proposal/operations.test.ts`, change the fixture import to `import { peopleScenario, proposalScenario } from "./test-support";` and append:

```ts
describe("Staff-screen arms", () => {
  const addPerson = (name: string, groups: string[] = []) => ({
    type: "add_person" as const,
    name,
    groups,
  });
  const editPerson = (personId: string | number, name: string, groups: string[]) => ({
    type: "edit_person" as const,
    personId,
    name,
    groups,
  });

  it("adds a person into existing groups, trimming the name as the Staff row does", () => {
    const result = applyAssistantCommand(peopleScenario(), addPerson("  Cara  ", ["Seniors", "RN"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.staff.at(-1)).toMatchObject({ id: "Cara", history: [] });
    expect(result.next.staffGroups.map((g) => [g.id, g.members])).toEqual([
      ["RN", ["ana", 7, "Cara"]],
      ["Seniors", ["bo", "Cara"]],
    ]);
  });

  it("refuses a name the Staff row refuses, naming it", () => {
    for (const name of ["ana", "RN", "all", "   "]) {
      const result = applyAssistantCommand(peopleScenario(), addPerson(name));
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code).toBe("invalid_value");
      expect(result.rejection.message).toContain(`Person "${name.trim()}"`);
    }
  });

  it("refuses a group that does not exist, and says how to fix it", () => {
    const result = applyAssistantCommand(peopleScenario(), addPerson("Cara", ["Agency"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("unknown_target");
    expect(result.rejection.message).toContain('Person "Cara"');
    expect(result.rejection.message).toContain('no staff group "Agency"');
    expect(result.rejection.message).toContain("earlier in the same change");
  });

  it("refuses ALL as a group: everyone is in it already", () => {
    const result = applyAssistantCommand(peopleScenario(), addPerson("Cara", ["ALL"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.message).toContain("automatically");
  });

  it("joins a group made earlier in the batch, but not one made later", () => {
    const group = {
      type: "add_people_group" as const,
      groupId: "Agency",
      description: "",
      members: [],
    };
    expect(applyAssistantCommands(peopleScenario(), [group, addPerson("Cara", ["Agency"])]).ok).toBe(
      true,
    );
    const late = applyAssistantCommands(peopleScenario(), [addPerson("Cara", ["Agency"]), group]);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.rejection.index).toBe(0);
  });

  it("renames a person everywhere and sets exactly their groups", () => {
    const result = applyAssistantCommand(
      peopleScenario(),
      editPerson("ana", "Ana Lim", ["RN", "Seniors"]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.staff.map((p) => p.id)).toEqual(["Ana Lim", "bo", 7]);
    expect(result.next.staffGroups.map((g) => g.members)).toEqual([
      ["Ana Lim", 7],
      ["Ana Lim", "bo"],
    ]);
    // The rename cascade re-keys her leave; it is not lost.
    expect(result.next.reqData.find((c) => c.uid === "cell-leave")?.person).toBe("Ana Lim");
  });

  it("keeps a numeric id when the name text is unchanged, and can empty the groups", () => {
    const result = applyAssistantCommand(peopleScenario(), editPerson(7, "7", []));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.staff.at(-1)?.id).toBe(7);
    expect(result.next.staffGroups[0].members).toEqual(["ana"]);
  });

  it("refuses a numeric id sent as text, and says why", () => {
    const result = applyAssistantCommand(peopleScenario(), editPerson("7", "7", []));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("unknown_target");
    expect(result.rejection.message).toContain('Person "7"');
    expect(result.rejection.message).toContain("a number stays a number");
  });

  it("refuses a rename onto another person or group, naming both", () => {
    const result = applyAssistantCommand(peopleScenario(), editPerson("ana", "Seniors", ["RN"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid_value");
    expect(result.rejection.message).toContain('Person "ana"');
    expect(result.rejection.message).toContain('"Seniors"');
  });

  it("refuses an edit that changes nothing", () => {
    const result = applyAssistantCommand(peopleScenario(), editPerson("ana", "ana", ["RN"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("no_effect");
  });

  it("removes a person and cascades as the Staff screen's Delete does", () => {
    const result = applyAssistantCommand(peopleScenario(), {
      type: "remove_person",
      personId: "bo",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.staff.map((p) => p.id)).toEqual(["ana", 7]);
    // The emptied group stays (FR-RI-17); the rule that named only bo is dropped.
    expect(result.next.staffGroups.find((g) => g.id === "Seniors")?.members).toEqual([]);
    expect(result.next.cardsByKind.counts).toEqual([]);
    expect(result.next.reqData.some((c) => c.person === "bo")).toBe(false);
  });

  it("refuses to remove someone who is not on the staff list", () => {
    const result = applyAssistantCommand(peopleScenario(), {
      type: "remove_person",
      personId: "zed",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("unknown_target");
  });

  it("adds a staff group with members in staff order, repeats ignored", () => {
    const result = applyAssistantCommand(peopleScenario(), {
      type: "add_people_group",
      groupId: " Night team ",
      description: "  Nights only ",
      members: [7, "bo", 7],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.staffGroups.at(-1)).toMatchObject({
      id: "Night team",
      description: "Nights only",
      members: ["bo", 7],
    });
  });

  it("refuses a staff group id in use, reserved, or with an unknown member", () => {
    for (const groupId of ["RN", "ana", "ALL", ""]) {
      const result = applyAssistantCommand(peopleScenario(), {
        type: "add_people_group",
        groupId,
        description: "",
        members: [],
      });
      expect(result.ok, groupId).toBe(false);
      if (!result.ok) expect(result.rejection.message).toContain(`Staff group "${groupId}"`);
    }
    const missing = applyAssistantCommand(peopleScenario(), {
      type: "add_people_group",
      groupId: "Night team",
      description: "",
      members: ["zed"],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.rejection.code).toBe("unknown_target");
      expect(missing.rejection.message).toContain('no person "zed"');
    }
  });

  it("edits a staff group like its Edit form: rename, description, members; keeps nested members", () => {
    const state = peopleScenario();
    state.staffGroups[0] = { ...state.staffGroups[0], members: ["ana", 7, "Nested"] };
    const result = applyAssistantCommand(state, {
      type: "edit_people_group",
      groupId: "RN",
      newGroupId: "Registered nurses",
      description: "",
      members: ["bo"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.staffGroups[0]).toMatchObject({
      id: "Registered nurses",
      members: ["bo", "Nested"],
    });
  });

  it("clears a group's description when sent an empty one", () => {
    const result = applyAssistantCommand(peopleScenario(), {
      type: "edit_people_group",
      groupId: "Seniors",
      newGroupId: "Seniors",
      description: "",
      members: ["bo"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.staffGroups[1].description).toBeUndefined();
  });

  it("refuses an unknown group, and an edit that changes nothing", () => {
    const unknown = applyAssistantCommand(peopleScenario(), {
      type: "edit_people_group",
      groupId: "Nope",
      newGroupId: "Nope",
      description: "",
      members: [],
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.rejection.code).toBe("unknown_target");
    const same = applyAssistantCommand(peopleScenario(), {
      type: "edit_people_group",
      groupId: "Seniors",
      newGroupId: "Seniors",
      description: "Band 6 and above",
      members: ["bo"],
    });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.rejection.code).toBe("no_effect");
  });

  it("removes a staff group, and refuses an unknown one", () => {
    const result = applyAssistantCommand(peopleScenario(), {
      type: "remove_people_group",
      groupId: "Seniors",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.staffGroups.map((g) => g.id)).toEqual(["RN"]);
    const unknown = applyAssistantCommand(peopleScenario(), {
      type: "remove_people_group",
      groupId: "Nope",
    });
    expect(unknown.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run to check they fail**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: FAIL. The new arms do not parse, and `applyAssistantCommand` has no case for them.

- [ ] **Step 5: Add the arms to `commands.ts`**

After the paragraph that starts `` `add_shift_type` / `add_shift_group` widen`` in the top comment, add:

```ts
//
// The Staff-screen arms (`add_person`, `edit_person`, `remove_person`,
// `add_people_group`, `edit_people_group`, `remove_people_group`) compile to the
// Staff screen's own primitives over `peopleDescriptor` (`addItem`, `renameItem`,
// `deleteItem`, `addGroup`, `renameGroup`, `updateGroupFields`, `deleteGroup`,
// `writeItemGroups`, `writeGroupMembers`). `mark_person_off` is the Requests
// screen's quick paint of OFF at weight Infinity across a run of days. Together
// they express a nurse borrowed from another ward for a few dates.
```

Replace the terminating `;` of the `add_shift_group` arm in the type union with:

```ts
  | { type: "add_shift_group"; groupId: string; members: string[] }
  /** Add one person -- the Staff screen's "Add nurse" row: a name and the staff groups they join. */
  | { type: "add_person"; name: string; groups: string[] }
  /**
   * Rename one person and set EXACTLY which staff groups they are in -- the Staff
   * row's Edit. A name equal to the current id text is not a rename.
   */
  | { type: "edit_person"; personId: PersonRef; name: string; groups: string[] }
  /** Remove one person and every reference to them -- the Staff row's Delete. */
  | { type: "remove_person"; personId: PersonRef }
  /** Add one staff group -- the Staff groups "New group" form. */
  | { type: "add_people_group"; groupId: string; description: string; members: PersonRef[] }
  /** Rename a staff group, set its description and EXACTLY its members -- the group's Edit form. */
  | {
      type: "edit_people_group";
      groupId: string;
      newGroupId: string;
      description: string;
      members: PersonRef[];
    }
  /** Remove one staff group and every reference to it -- the group's Delete. */
  | { type: "remove_people_group"; groupId: string };
```

Extend `ASSISTANT_COMMAND_TYPES` after `"add_shift_group",`:

```ts
  "add_shift_group",
  "add_person",
  "edit_person",
  "remove_person",
  "add_people_group",
  "edit_people_group",
  "remove_people_group",
] as const satisfies readonly AssistantCommandType[];
```

Append these arms at the END of the `z.discriminatedUnion("type", [...])` array, after the `add_shift_group` arm:

```ts
  z.strictObject({
    type: z.enum(["add_person"]),
    name: z
      .string()
      .describe(
        'The person\'s name as the staff list should show it, e.g. "Float RN (Ward 5)". Must ' +
          "not match any existing person or staff group, and must not be ALL.",
      ),
    groups: z
      .array(z.string())
      .describe(
        "Staff groups to put them in, e.g. [\"RN\"]. Each must exist or be added EARLIER in " +
          "the same change. Send [] for none. Never list ALL: everyone is in it.",
      ),
  }),
  z.strictObject({
    type: z.enum(["edit_person"]),
    personId: refSchema.describe(
      "The person's id exactly as the staff list shows it. A number stays a number.",
    ),
    name: z
      .string()
      .describe("The name they should have. Send their current name to keep it."),
    groups: z
      .array(z.string())
      .describe(
        "EVERY staff group they should be in after the change -- groups left out are " +
          "removed. Send their current groups to keep them.",
      ),
  }),
  z.strictObject({
    type: z.enum(["remove_person"]),
    personId: refSchema.describe(
      "The person to remove, exactly as the staff list shows the id. Their requests, leave " +
        "and any rule that only names them go too; the preview lists every one.",
    ),
  }),
  z.strictObject({
    type: z.enum(["add_people_group"]),
    groupId: z
      .string()
      .describe(
        "The new staff group's name, e.g. Seniors. People and staff groups share one list of " +
          "names, so it must differ from every person and group, and must not be ALL.",
      ),
    description: z.string().describe('What the group is for. Send "" for none.'),
    members: z
      .array(refSchema)
      .describe(
        "Ids of the people in the group, exactly as the staff list shows them. Each must " +
          "exist or be added EARLIER in the same change. May be [].",
      ),
  }),
  z.strictObject({
    type: z.enum(["edit_people_group"]),
    groupId: z.string().describe("The staff group's current name."),
    newGroupId: z.string().describe("The name it should have. Send the current name to keep it."),
    description: z
      .string()
      .describe('The description it should have. Send the current one to keep it, "" to clear.'),
    members: z
      .array(refSchema)
      .describe(
        "EVERY person who should be in the group after the change -- people left out are " +
          "removed.",
      ),
  }),
  z.strictObject({
    type: z.enum(["remove_people_group"]),
    groupId: z
      .string()
      .describe(
        "The staff group to remove. Rules that only target this group go too; the preview " +
          "lists them.",
      ),
  }),
```

- [ ] **Step 6: Add the host operations to `operations.ts`**

Replace the `@/components/entity-editor/core` import and the shift-descriptor import with:

```ts
import {
  addGroup,
  addItem,
  deleteGroup,
  deleteItem,
  isReservedKeyword,
  paidMinutesFor,
  renameGroup,
  renameItem,
  setGroupMembers,
  updateGroupFields,
  validateFullEditId,
  validateWorkingTimeDraft,
  writeGroupMembers,
  writeItemGroups,
} from "@/components/entity-editor/core";
import { peopleDescriptor } from "@/components/people/people-descriptor";
import { shiftTypesDescriptor } from "@/components/shift-types/shift-types-descriptor";
import { RenameCollisionError } from "@/lib/cascade";
import type { AssistantCommandV1 } from "./commands";
import { stableStringify } from "./digest";
```

(`import type { AssistantCommandV1 } from "./commands";` already exists. Keep one copy.)

After the paragraph about the shift arms in the header comment, add:

```ts
//
// The Staff-screen arms call the same primitives the Staff table and the groups
// section commit (`people-table.tsx`, `groups-section.tsx`) over `peopleDescriptor`,
// behind the same `validateFullEditId` gate. Remove cascades exactly as the screen's
// Delete does -- no block -- and `deriveAssumptions` asks about any leave it destroys.
```

Insert before `/** Validate and apply exactly one command against \`state\`. */`:

```ts
// ---------------------------------------------------------------------------
// Staff screen: people and staff groups
// ---------------------------------------------------------------------------

const PERSON_ID_HINT =
  "Use the id exactly as the staff list shows it -- a number stays a number.";

/** The person with exactly this id (`1` and `"1"` are different people). */
function findPerson(state: ScenarioUiState, personId: PersonRef) {
  return state.staff.find((person) => person.id === personId);
}

function unknownPersonMessage(personId: PersonRef): string {
  return `Person "${String(personId)}": not on the staff list. ${PERSON_ID_HINT}`;
}

/** Refuse a group the Staff row's toggles could not have picked. */
function missingStaffGroup(
  state: ScenarioUiState,
  label: string,
  groups: readonly string[],
  index: number,
): OperationResult | null {
  const missing = groups.find((id) => !state.staffGroups.some((group) => group.id === id));
  if (missing === undefined) return null;
  if (isReservedKeyword(peopleDescriptor.reservedKeywords, missing)) {
    return reject(
      index,
      "unknown_target",
      `${label}: everyone is in "${missing}" automatically -- leave it out of the groups.`,
    );
  }
  return reject(
    index,
    "unknown_target",
    `${label}: there is no staff group "${missing}". Add the group earlier in the same change, or use an existing group name.`,
  );
}

/** Refuse a member the group form's picker could not have offered. */
function missingMember(
  state: ScenarioUiState,
  label: string,
  members: readonly PersonRef[],
  index: number,
): OperationResult | null {
  const missing = members.find((member) => !findPerson(state, member));
  if (missing === undefined) return null;
  return reject(
    index,
    "unknown_target",
    `${label}: there is no person "${String(missing)}". Add the person earlier in the same change. ${PERSON_ID_HINT}`,
  );
}

/** An edit that leaves the document as it was would spend an Undo entry on nothing. */
function unchanged(before: ScenarioUiState, after: ScenarioUiState): boolean {
  return after === before || stableStringify(after) === stableStringify(before);
}

function applyAddPerson(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_person" }>,
  index: number,
): OperationResult {
  const d = peopleDescriptor;
  const idCheck = validateFullEditId(d, d.readItems(state), d.readGroups(state), command.name);
  if (!idCheck.ok) {
    return reject(index, "invalid_value", `Person "${command.name.trim()}": ${idCheck.message}.`);
  }
  const groups = [...new Set(command.groups)];
  const refused = missingStaffGroup(state, `Person "${idCheck.id}"`, groups, index);
  if (refused) return refused;
  return {
    ok: true,
    next: writeItemGroups(addItem(state, d, { id: idCheck.id }), d, idCheck.id, groups),
  };
}

function applyEditPerson(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_person" }>,
  index: number,
): OperationResult {
  const d = peopleDescriptor;
  const person = findPerson(state, command.personId);
  if (!person) return reject(index, "unknown_target", unknownPersonMessage(command.personId));
  const label = `Person "${String(person.id)}"`;

  // The Staff row's own rule (`people-table.tsx`, `nameChanged`): only changed name
  // TEXT is a rename, so an unchanged numeric id stays numeric.
  let renameTo: string | null = null;
  if (command.name !== String(person.id)) {
    const idCheck = validateFullEditId(
      d,
      d.readItems(state),
      d.readGroups(state),
      command.name,
      false,
      person.id,
    );
    if (!idCheck.ok) {
      return reject(
        index,
        "invalid_value",
        `${label}: cannot be renamed to "${command.name.trim()}": ${idCheck.message}.`,
      );
    }
    renameTo = idCheck.id;
  }
  const groups = [...new Set(command.groups)];
  const refused = missingStaffGroup(state, label, groups, index);
  if (refused) return refused;

  let next: ScenarioUiState;
  try {
    const renamed = renameTo === null ? state : renameItem(state, d, person.id, renameTo);
    next = writeItemGroups(renamed, d, renameTo ?? person.id, groups);
  } catch (error) {
    // Backstop only: `validateFullEditId` above refuses every collision first.
    if (!(error instanceof RenameCollisionError)) throw error;
    return reject(index, "invalid_value", `${label}: ${error.message}`);
  }
  if (unchanged(state, next)) {
    return reject(index, "no_effect", `${label}: already has that name and those groups.`);
  }
  return { ok: true, next };
}

function applyRemovePerson(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "remove_person" }>,
  index: number,
): OperationResult {
  const person = findPerson(state, command.personId);
  if (!person) return reject(index, "unknown_target", unknownPersonMessage(command.personId));
  return { ok: true, next: deleteItem(state, peopleDescriptor, person.id) };
}

function applyAddPeopleGroup(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_people_group" }>,
  index: number,
): OperationResult {
  const d = peopleDescriptor;
  const idCheck = validateFullEditId(
    d,
    d.readItems(state),
    d.readGroups(state),
    command.groupId,
    true,
  );
  if (!idCheck.ok) {
    return reject(
      index,
      "invalid_value",
      `Staff group "${command.groupId.trim()}": ${idCheck.message}.`,
    );
  }
  const members = [...new Set(command.members)];
  const refused = missingMember(state, `Staff group "${idCheck.id}"`, members, index);
  if (refused) return refused;
  const withGroup = addGroup(state, d, {
    id: idCheck.id,
    description: command.description.trim() || undefined,
  });
  return { ok: true, next: writeGroupMembers(withGroup, d, idCheck.id, members) };
}

function applyEditPeopleGroup(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_people_group" }>,
  index: number,
): OperationResult {
  const d = peopleDescriptor;
  const group = state.staffGroups.find((g) => g.id === command.groupId);
  if (!group) {
    return reject(
      index,
      "unknown_target",
      `Staff group "${command.groupId}": there is no such staff group.`,
    );
  }
  const label = `Staff group "${group.id}"`;
  // The group form's own rule: only changed id TEXT is a rename.
  let gid = group.id;
  const idChanged = command.newGroupId !== group.id;
  if (idChanged) {
    const idCheck = validateFullEditId(
      d,
      d.readItems(state),
      d.readGroups(state),
      command.newGroupId,
      true,
      group.id,
    );
    if (!idCheck.ok) {
      return reject(
        index,
        "invalid_value",
        `${label}: cannot be renamed to "${command.newGroupId.trim()}": ${idCheck.message}.`,
      );
    }
    gid = idCheck.id;
  }
  const members = [...new Set(command.members)];
  const refused = missingMember(state, label, members, index);
  if (refused) return refused;

  let next: ScenarioUiState;
  try {
    next = idChanged ? renameGroup(state, d, group.id, gid) : state;
  } catch (error) {
    if (!(error instanceof RenameCollisionError)) throw error;
    return reject(index, "invalid_value", `${label}: ${error.message}`);
  }
  next = updateGroupFields(next, d, gid, { description: command.description.trim() || undefined });
  next = writeGroupMembers(next, d, gid, members);
  if (unchanged(state, next)) {
    return reject(
      index,
      "no_effect",
      `${label}: already has that name, description and those members.`,
    );
  }
  return { ok: true, next };
}

function applyRemovePeopleGroup(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "remove_people_group" }>,
  index: number,
): OperationResult {
  if (!state.staffGroups.some((group) => group.id === command.groupId)) {
    return reject(
      index,
      "unknown_target",
      `Staff group "${command.groupId}": there is no such staff group.`,
    );
  }
  return { ok: true, next: deleteGroup(state, peopleDescriptor, command.groupId) };
}
```

Add six cases to the `switch` in `applyAssistantCommand`, after `add_shift_group`:

```ts
    case "add_shift_group":
      return applyAddShiftGroup(state, command, index);
    case "add_person":
      return applyAddPerson(state, command, index);
    case "edit_person":
      return applyEditPerson(state, command, index);
    case "remove_person":
      return applyRemovePerson(state, command, index);
    case "add_people_group":
      return applyAddPeopleGroup(state, command, index);
    case "edit_people_group":
      return applyEditPeopleGroup(state, command, index);
    case "remove_people_group":
      return applyRemovePeopleGroup(state, command, index);
```

- [ ] **Step 7: Update the two locked lists, consciously**

In `web/lib/ai/phase-2-absence.test.ts`, above `const PROPOSAL_OPERATIONS`, add a second comment line under the existing "WIDENED DELIBERATELY" note, and extend the list:

```ts
// WIDENED AGAIN (2026-09-24, plan assistant-people-ops): the Staff screen's own
// add/edit/remove for people and staff groups, plus the Requests quick-paint
// "must be off" run. All address the scenario, none a produced roster.
const PROPOSAL_OPERATIONS = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
  "add_shift_type",
  "add_shift_group",
  "add_person",
  "edit_person",
  "remove_person",
  "add_people_group",
  "edit_people_group",
  "remove_people_group",
] as const;
```

In `web/lib/ai/runtime/model-visible-tools.test.ts`, add to the `representative` map after the `add_shift_group` entry:

```ts
      add_person: { type: "add_person", name: "Float RN (Ward 5)", groups: ["RN"] },
      edit_person: { type: "edit_person", personId: "ana", name: "Ana Lim", groups: ["RN"] },
      remove_person: { type: "remove_person", personId: 7 },
      add_people_group: {
        type: "add_people_group",
        groupId: "Night team",
        description: "",
        members: ["ana", 7],
      },
      edit_people_group: {
        type: "edit_people_group",
        groupId: "RN",
        newGroupId: "Registered nurses",
        description: "",
        members: ["ana"],
      },
      remove_people_group: { type: "remove_people_group", groupId: "Seniors" },
```

- [ ] **Step 8: Run the tests to check they pass**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts lib/ai/phase-2-absence.test.ts lib/ai/runtime/model-visible-tools.test.ts`
Expected: PASS. If `model-visible-tools.test.ts` fails on `members`, read the wire JSON first. It must be `{ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }`, the same union `move_leave.personId` already sends. If the converter drops `anyOf` inside `items`, stop and report. Do not change it to `z.array(z.string())`: that makes a numeric-id person impossible to name.

- [ ] **Step 9: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors. (`diff.ts` `directKeys` has no exhaustive return, so it compiles before Task 5.)

- [ ] **Step 10: Commit** (only with commit authority)

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/operations.ts web/lib/proposal/test-support.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.test.ts web/lib/ai/phase-2-absence.test.ts web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): Staff-screen person + staff-group proposal ops"
```

---

### Task 3: `mark_person_off` and the borrowed-nurse batch

**Files:**
- Modify: `web/lib/proposal/commands.ts` (type union, `ASSISTANT_COMMAND_TYPES`, zod union)
- Modify: `web/lib/proposal/operations.ts` (new function, switch case)
- Modify: `web/lib/store/paint.ts:63` (`function foldGesture` → `export function foldGesture`)
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`, `web/lib/proposal/operations.parity.test.ts`
- Modify (locked lists): `web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`

**Interfaces:**
- Consumes: `findPerson`, `unknownPersonMessage`, `reject`, `cellsAtCoordinate`, `withCoordinateCells` (`operations.ts`). `generateDateItems`, `hasCompleteRange`, `isValidIso` (`@/lib/dates`, already imported). `stableStringify`. `peopleScenario()`.
- Produces:
  - Arm `{ type: "mark_person_off"; personId: PersonRef; fromDate: IsoDate; toDate: IsoDate }`.
  - Each day in the run becomes exactly one cell `{ kind: "off", person, date, weight: Infinity, uid }`. `uid` is the prior day-state cell's `uid`. With no prior day-state cell, it is `off:<stableStringify(person)>|<stableStringify(date)>`. A taken uid gets `#2`, `#3`, … added.
  - `export function foldGesture(reqData, staged)` in `web/lib/store/paint.ts` (visibility only).

- [ ] **Step 1: Write the failing schema test**

Append inside the top-level `describe` in `web/lib/proposal/commands.test.ts`:

```ts
  it("accepts mark_person_off with ISO dates only", () => {
    const ok = parseAssistantCommands([
      { type: "mark_person_off", personId: "ana", fromDate: "2026-10-01", toDate: "2026-10-11" },
    ]);
    expect(ok.ok).toBe(true);
    for (const payload of [
      [{ type: "mark_person_off", personId: "ana", fromDate: "01", toDate: "11" }],
      [{ type: "mark_person_off", personId: "ana", fromDate: "2026-10-01" }],
      [
        {
          type: "mark_person_off",
          personId: "ana",
          fromDate: "2026-10-01",
          toDate: "2026-10-11",
          weight: 5,
        },
      ],
    ]) {
      expect(parseAssistantCommands(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });
```

- [ ] **Step 2: Write the failing operation tests**

Append to `web/lib/proposal/operations.test.ts`:

```ts
describe("mark_person_off", () => {
  const off = (personId: string | number, fromDate: string, toDate: string) => ({
    type: "mark_person_off" as const,
    personId,
    fromDate,
    toDate,
  });

  it("borrows one RN from Ward 5 for 12-14 Oct in one batch", () => {
    // The realistic infeasibility fix: a float nurse in the RN group, here only 12-14.
    const float = "Float RN (Ward 5)";
    const commands = [
      { type: "add_person" as const, name: float, groups: ["RN"] },
      off(float, "2026-10-01", "2026-10-11"),
      off(float, "2026-10-15", "2026-10-31"),
    ];
    const result = applyAssistantCommands(peopleScenario(), commands);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.next.staff.at(-1)).toMatchObject({ id: float, history: [] });
    expect(result.next.staffGroups[0].members).toEqual(["ana", 7, float]);

    const cells = result.next.reqData.filter((cell) => cell.person === float);
    expect(cells).toHaveLength(28);
    expect(cells.every((cell) => cell.kind === "off" && cell.weight === Infinity)).toBe(true);
    const offDays = new Set(cells.map((cell) => cell.date));
    for (const day of ["12", "13", "14"]) expect(offDays.has(day), day).toBe(false);
    for (const day of ["01", "11", "15", "31"]) expect(offDays.has(day), day).toBe(true);

    // Every cell has a unique durable uid (Workspace emission throws otherwise).
    const uids = result.next.reqData.map((cell) => cell.uid);
    expect(uids.every(Boolean)).toBe(true);
    expect(new Set(uids).size).toBe(uids.length);

    // Deterministic: Apply re-derives the same document the Preview showed.
    expect(applyAssistantCommands(peopleScenario(), commands)).toEqual(result);
  });

  it("replaces what is on those days and keeps a day-state uid", () => {
    // ana: leave on 02 (uid cell-leave), a Day request on 07 (uid cell-req).
    const result = applyAssistantCommand(peopleScenario(), off("ana", "2026-10-01", "2026-10-07"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ana = result.next.reqData.filter((cell) => cell.person === "ana");
    expect(ana).toHaveLength(7);
    expect(ana.find((cell) => cell.date === "02")).toEqual({
      kind: "off",
      person: "ana",
      date: "02",
      weight: Infinity,
      uid: "cell-leave",
    });
    expect(result.next.reqData.some((cell) => cell.uid === "cell-req")).toBe(false);
    expect(ana.find((cell) => cell.date === "07")?.uid).toBe('off:"ana"|"07"');
  });

  it("mints a different uid when the natural one is taken", () => {
    const state = peopleScenario();
    state.reqData = [
      ...state.reqData,
      { uid: 'off:"bo"|"03"', person: "ana", date: "20", kind: "off", weight: 1 },
    ];
    const result = applyAssistantCommand(state, off("bo", "2026-10-03", "2026-10-03"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.reqData.find((c) => c.person === "bo" && c.date === "03")?.uid).toBe(
      'off:"bo"|"03"#2',
    );
  });

  it("refuses dates outside the roster period, naming it", () => {
    const result = applyAssistantCommand(peopleScenario(), off("ana", "2026-09-28", "2026-10-02"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("unknown_target");
    expect(result.rejection.message).toContain('Person "ana"');
    expect(result.rejection.message).toContain("2026-09-28 to 2026-10-02");
    expect(result.rejection.message).toContain("2026-10-01 to 2026-10-31");
  });

  it("refuses a reversed run, an impossible date, and an unknown person", () => {
    for (const command of [
      off("ana", "2026-10-11", "2026-10-01"),
      off("ana", "2026-10-01", "2026-10-32"),
      off("zed", "2026-10-01", "2026-10-02"),
      off("RN", "2026-10-01", "2026-10-02"), // a staff group is not a person
    ]) {
      expect(applyAssistantCommand(peopleScenario(), command).ok, JSON.stringify(command)).toBe(
        false,
      );
    }
  });

  it("refuses when there is no roster period, and when every day is already a must-be-off day", () => {
    const empty = { ...peopleScenario(), rangeStart: "", rangeEnd: "" };
    const none = applyAssistantCommand(empty, off("ana", "2026-10-01", "2026-10-02"));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.rejection.code).toBe("cascade_unavailable");

    const once = applyAssistantCommand(peopleScenario(), off("bo", "2026-10-01", "2026-10-02"));
    if (!once.ok) throw new Error("fixture should apply");
    const twice = applyAssistantCommand(once.next, off("bo", "2026-10-01", "2026-10-02"));
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.rejection.code).toBe("no_effect");
  });
});
```

- [ ] **Step 3: Run to check they fail**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: FAIL. `mark_person_off` is unknown.

- [ ] **Step 4: Add the arm to `commands.ts`**

Replace the terminating `;` of the `remove_people_group` type arm with:

```ts
  | { type: "remove_people_group"; groupId: string }
  /**
   * The person must not work on any day from `fromDate` to `toDate` inclusive -- the
   * Requests screen's quick paint of OFF at weight Infinity across that run. ISO dates,
   * because the model is given the roster period but never the date-id format.
   */
  | { type: "mark_person_off"; personId: PersonRef; fromDate: IsoDate; toDate: IsoDate };
```

Append `"mark_person_off",` after `"remove_people_group",` in `ASSISTANT_COMMAND_TYPES`. Append at the END of the zod union:

```ts
  z.strictObject({
    type: z.enum(["mark_person_off"]),
    personId: refSchema.describe(
      "The person, exactly as the staff list shows the id. A number stays a number.",
    ),
    fromDate: isoDateSchema.describe(
      "First day they must be off, YYYY-MM-DD, inside the roster period.",
    ),
    toDate: isoDateSchema.describe(
      "Last day they must be off, YYYY-MM-DD, on or after fromDate. For a nurse borrowed " +
        "from another ward, mark them off before and after the days they are here.",
    ),
  }),
```

- [ ] **Step 5: Add the host operation to `operations.ts`**

Insert after `applyRemovePeopleGroup`:

```ts
// ---------------------------------------------------------------------------
// Requests screen: a run of must-be-off days
// ---------------------------------------------------------------------------

/**
 * A durable, DETERMINISTIC uid for a cell the assistant creates. Apply re-derives the
 * document, so a random uid would make the applied cells differ from the previewed
 * ones. Suffixed when taken (a renamed person can still hold the natural one).
 */
function mintCellUid(taken: Set<string>, person: PersonRef, date: DateRef): string {
  const base = `off:${stableStringify(person)}|${stableStringify(date)}`;
  let uid = base;
  for (let n = 2; taken.has(uid); n += 1) uid = `${base}#${n}`;
  taken.add(uid);
  return uid;
}

function isMustBeOff(cells: readonly UiRequestCell[]): boolean {
  return cells.length === 1 && cells[0].kind === "off" && cells[0].weight === Infinity;
}

function applyMarkPersonOff(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "mark_person_off" }>,
  index: number,
): OperationResult {
  const person = findPerson(state, command.personId);
  if (!person) return reject(index, "unknown_target", unknownPersonMessage(command.personId));
  const label = `Person "${String(person.id)}"`;

  const range: DateRange = { start: state.rangeStart, end: state.rangeEnd };
  if (!hasCompleteRange(range)) {
    return reject(
      index,
      "cascade_unavailable",
      "This schedule has no roster period yet, so days off cannot be marked.",
    );
  }
  if (!isValidIso(command.fromDate) || !isValidIso(command.toDate)) {
    return reject(index, "invalid_value", `${label}: those are not real calendar dates.`);
  }
  if (command.fromDate > command.toDate) {
    return reject(index, "invalid_value", `${label}: the last day must be on or after the first.`);
  }
  const items = generateDateItems(range);
  if (command.fromDate < items[0].iso || command.toDate > items[items.length - 1].iso) {
    return reject(
      index,
      "unknown_target",
      `${label}: ${command.fromDate} to ${command.toDate} is not inside the roster period (${range.start} to ${range.end}).`,
    );
  }
  const days = items
    .filter((item) => item.iso >= command.fromDate && item.iso <= command.toDate)
    .map((item) => item.id);
  if (days.every((date) => isMustBeOff(cellsAtCoordinate(state.reqData, person.id, date)))) {
    return reject(index, "no_effect", `${label}: is already marked off on all of those days.`);
  }

  // The quick-paint day-state fold (`foldGesture` in `lib/store/paint.ts`): each day
  // becomes ONE off cell, requests there are dropped, a prior day-state keeps its uid.
  const taken = new Set(state.reqData.flatMap((cell) => (cell.uid ? [cell.uid] : [])));
  let reqData = state.reqData;
  for (const date of days) {
    const prior = cellsAtCoordinate(reqData, person.id, date).find(
      (cell) => cell.kind === "leave" || cell.kind === "off",
    );
    const uid = prior?.uid ?? mintCellUid(taken, person.id, date);
    reqData = withCoordinateCells(reqData, person.id, date, [
      { kind: "off", person: person.id, date, weight: Infinity, uid },
    ]);
  }
  return { ok: true, next: { ...state, reqData } };
}
```

Add the case after `remove_people_group`:

```ts
    case "mark_person_off":
      return applyMarkPersonOff(state, command, index);
```

- [ ] **Step 6: Export the real fold and add the parity test**

In `web/lib/store/paint.ts`, change `function foldGesture(` to `export function foldGesture(`. Do not change anything else.

Add imports to `web/lib/proposal/operations.parity.test.ts`:

```ts
import { foldGesture } from "@/lib/store/paint";
import { paintCellKey, type StagedCoordinate } from "@/lib/store/types";
import { generateDateItems } from "@/lib/dates";
import { stableStringify } from "./digest";
import { peopleScenario } from "./test-support";
```

(Merge `generateDateItems` into the existing `@/lib/dates` import, and `peopleScenario` into the existing `./test-support` import.)

Append:

```ts
describe("mark_person_off is the Requests quick paint of OFF at weight Infinity", () => {
  it("produces the same cells as the real paint fold, keeping the same uids", () => {
    const state = peopleScenario();
    const beforeUids = new Set(state.reqData.map((cell) => cell.uid));
    // ana: leave on 02 and a Day request on 07 sit inside the run.
    const days = generateDateItems({ start: state.rangeStart, end: state.rangeEnd })
      .filter((item) => item.iso >= "2026-10-01" && item.iso <= "2026-10-09")
      .map((item) => item.id);
    const staged = new Map<string, StagedCoordinate>(
      days.map((date): [string, StagedCoordinate] => [
        paintCellKey("ana", date),
        { mode: "day-state", dayState: { kind: "off", weight: Infinity } },
      ]),
    );
    const manual = foldGesture(state.reqData, staged);

    const assistant = applyAssistantCommand(state, {
      type: "mark_person_off",
      personId: "ana",
      fromDate: "2026-10-01",
      toDate: "2026-10-09",
    });
    expect(assistant.ok).toBe(true);
    if (!assistant.ok) return;

    // A new cell's uid is random on the manual path; a kept uid must match exactly.
    const normalise = (cells: typeof manual) =>
      cells
        .map(({ uid, ...rest }) => ({ ...rest, uid: uid && beforeUids.has(uid) ? uid : "new" }))
        .map((cell) => stableStringify(cell))
        .sort();
    expect(normalise(assistant.next.reqData)).toEqual(normalise(manual));
  });
});
```

- [ ] **Step 7: Update the locked lists**

Append `"mark_person_off",` after `"remove_people_group",` in `PROPOSAL_OPERATIONS` (`web/lib/ai/phase-2-absence.test.ts`). Add to `representative` (`web/lib/ai/runtime/model-visible-tools.test.ts`):

```ts
      mark_person_off: {
        type: "mark_person_off",
        personId: "Float RN (Ward 5)",
        fromDate: "2026-10-01",
        toDate: "2026-10-11",
      },
```

- [ ] **Step 8: Run to check they pass**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/phase-2-absence.test.ts lib/ai/runtime/model-visible-tools.test.ts lib/store`
Expected: PASS. If `StagedCoordinate` does not accept the literal, read `web/lib/store/types.ts` and use its exact day-state shape. Do not cast.

- [ ] **Step 9: Mutation check (do not commit this)**

In `applyMarkPersonOff`, change `const uid = prior?.uid ?? mintCellUid(...)` to `const uid = mintCellUid(taken, person.id, date);`. Run the parity suite. It must FAIL on the 02 (leave) cell. Revert. If it passes, the parity test does not test uid preservation. Fix the test before you continue.

- [ ] **Step 10: Typecheck and commit** (commit only with authority)

Run: `cd web && pnpm typecheck`
Expected: no errors.

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/operations.ts web/lib/store/paint.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.test.ts web/lib/proposal/operations.parity.test.ts web/lib/ai/phase-2-absence.test.ts web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): mark_person_off proposal op for borrowed staff"
```

---

### Task 4: Staff-screen parity

These are characterisation tests. They pass on the first run. The mutation check in Step 3 proves that they find a defect. The screens' saves live in React components. After Task 1 they are compositions of core functions, so this test restates the composition with the same functions. Line numbers are cited so a reviewer can compare.

**Files:**
- Test: `web/lib/proposal/operations.parity.test.ts` (append)

**Interfaces:**
- Consumes: `addItem`, `renameItem`, `deleteItem`, `addGroup`, `renameGroup`, `updateGroupFields`, `deleteGroup`, `validateFullEditId`, `writeItemGroups`, `writeGroupMembers` from `@/components/entity-editor/core`. `peopleDescriptor`. `peopleScenario()`. Task 2 arms.
- Produces: nothing new.

- [ ] **Step 1: Write the parity tests**

Merge these names into the existing `@/components/entity-editor/core` import of `operations.parity.test.ts`: `addItem`, `deleteGroup`, `deleteItem`, `renameGroup`, `renameItem`, `updateGroupFields`, `writeGroupMembers`, `writeItemGroups`. Add `import { peopleDescriptor } from "@/components/people/people-descriptor";`. Append:

```ts
describe("the Staff-screen arms are the Staff screen's saves", () => {
  const d = peopleDescriptor;

  // `people-table.tsx:723-745`: gate on validateFullEditId, then addItem + writeGroups.
  function manualAddPerson(state: ScenarioUiState, name: string, groups: string[]) {
    const check = validateFullEditId(d, d.readItems(state), d.readGroups(state), name);
    if (!check.ok) return null;
    return writeItemGroups(addItem(state, d, { id: check.id }), d, check.id, groups);
  }

  // `people-table.tsx:719-757`: rename only when the raw text changed, then writeGroups.
  function manualEditPerson(
    state: ScenarioUiState,
    personId: string | number,
    name: string,
    groups: string[],
  ) {
    const nameChanged = name !== String(personId);
    const check = nameChanged
      ? validateFullEditId(d, d.readItems(state), d.readGroups(state), name, false, personId)
      : ({ ok: true, id: name } as const);
    if (!check.ok) return null;
    const renamed = nameChanged ? renameItem(state, d, personId, check.id) : state;
    return writeItemGroups(renamed, d, nameChanged ? check.id : personId, groups);
  }

  it("add_person accepts, refuses and writes what Add nurse does", () => {
    const state = peopleScenario();
    for (const name of ["Cara", "  Cara  ", "12", "ana", "RN", "ALL", "all", ""]) {
      const manual = manualAddPerson(state, name, ["Seniors", "RN"]);
      const assistant = applyAssistantCommand(state, {
        type: "add_person",
        name,
        groups: ["Seniors", "RN"],
      });
      expect(assistant.ok, `"${name}"`).toBe(manual !== null);
      if (manual && assistant.ok) expect(assistant.next).toEqual(manual);
    }
  });

  it("edit_person accepts, refuses and writes what the row's Edit does", () => {
    const state = peopleScenario();
    const cases: [string | number, string, string[]][] = [
      ["ana", "Ana Lim", ["RN"]],
      ["ana", "ana", []],
      ["ana", "  ana  ", ["RN", "Seniors"]],
      [7, "7", ["Seniors"]],
      [7, " 7 ", ["RN"]], // the row renames number 7 to text "7"
      ["ana", "bo", ["RN"]],
      ["ana", "Seniors", ["RN"]],
      ["ana", "ALL", ["RN"]],
      ["ana", "", ["RN"]],
    ];
    for (const [personId, name, groups] of cases) {
      const manual = manualEditPerson(state, personId, name, groups);
      const assistant = applyAssistantCommand(state, {
        type: "edit_person",
        personId,
        name,
        groups,
      });
      expect(assistant.ok, `${String(personId)} -> "${name}"`).toBe(manual !== null);
      if (manual && assistant.ok) expect(assistant.next).toEqual(manual);
    }
  });

  it("remove_person is the row's Delete", () => {
    const state = peopleScenario();
    for (const personId of ["ana", "bo", 7] as const) {
      const assistant = applyAssistantCommand(state, { type: "remove_person", personId });
      expect(assistant.ok).toBe(true);
      if (assistant.ok) expect(assistant.next).toEqual(deleteItem(state, d, personId));
    }
  });

  it("add_people_group accepts, refuses and writes what New group does", () => {
    const state = peopleScenario();
    // `groups-section.tsx:745-790` (add mode): addGroup(id, trimmed description) + writeGroupMembers.
    for (const groupId of ["Night team", "  Night team  ", "RN", "ana", "ALL", ""]) {
      const check = validateFullEditId(d, d.readItems(state), d.readGroups(state), groupId, true);
      const assistant = applyAssistantCommand(state, {
        type: "add_people_group",
        groupId,
        description: " Nights ",
        members: [7, "bo"],
      });
      expect(assistant.ok, `"${groupId}"`).toBe(check.ok);
      if (check.ok && assistant.ok) {
        const manual = writeGroupMembers(
          addGroup(state, d, { id: check.id, description: "Nights" }),
          d,
          check.id,
          [7, "bo"],
        );
        expect(assistant.next).toEqual(manual);
      }
    }
  });

  it("edit_people_group accepts, refuses and writes what the group's Edit does", () => {
    const state = peopleScenario();
    // `groups-section.tsx:741-790` (edit mode): rename if the text changed, then
    // updateGroupFields(trimmed description), then writeGroupMembers.
    for (const newGroupId of ["Registered nurses", "RN", "Seniors", "bo", "ALL", ""]) {
      const idChanged = newGroupId !== "RN";
      const check = idChanged
        ? validateFullEditId(d, d.readItems(state), d.readGroups(state), newGroupId, true, "RN")
        : ({ ok: true, id: "RN" } as const);
      const assistant = applyAssistantCommand(state, {
        type: "edit_people_group",
        groupId: "RN",
        newGroupId,
        description: " Registered ",
        members: ["bo", "ana"],
      });
      expect(assistant.ok, `"${newGroupId}"`).toBe(check.ok);
      if (check.ok && assistant.ok) {
        let manual = idChanged ? renameGroup(state, d, "RN", check.id) : state;
        manual = updateGroupFields(manual, d, check.id, { description: "Registered" });
        manual = writeGroupMembers(manual, d, check.id, ["bo", "ana"]);
        expect(assistant.next).toEqual(manual);
      }
    }
  });

  it("remove_people_group is the group's Delete", () => {
    const state = peopleScenario();
    const assistant = applyAssistantCommand(state, {
      type: "remove_people_group",
      groupId: "RN",
    });
    expect(assistant.ok).toBe(true);
    if (assistant.ok) expect(assistant.next).toEqual(deleteGroup(state, d, "RN"));
  });
});
```

- [ ] **Step 2: Run to check they pass**

Run: `cd web && pnpm vitest run lib/proposal/operations.parity.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation check (do not commit this)**

1. In `applyEditPerson`, change `if (command.name !== String(person.id))` to `if (command.name.trim() !== String(person.id))`. Run the suite. The `[7, " 7 ", ["RN"]]` case must FAIL. Revert.
2. In `applyAddPeopleGroup`, change `description: command.description.trim() || undefined` to `description: command.description`. The add-group case must FAIL. Revert.

If a mutation passes, the parity assertion does not test that behaviour. Fix the test before you continue.

- [ ] **Step 4: Commit** (only with commit authority)

```bash
git add web/lib/proposal/operations.parity.test.ts
git commit -m "test(assistant): Staff-screen op parity with the screen's saves"
```

---

### Task 5: Preview in plain words, and no false leave questions on a rename

**Files:**
- Modify: `web/lib/proposal/diff.ts` (imports, `describeCell`, staff-group render, `directKeys`, `deriveProposalDiff`, two new helpers)
- Modify: `web/lib/proposal/assumptions.ts` (`deriveAssumptions` destroyed-leave loop, one helper)
- Test: `web/lib/proposal/diff.test.ts`, `web/lib/proposal/assumptions.test.ts`

**Interfaces:**
- Consumes: the Task 2 and Task 3 arms. `peopleScenario()`.
- Produces:
  - Diff keys: `person:<stableStringify(id)>`, `peoplegroup:<id>`, `cell:<person>|<date>`, and the new `offrun:<stableStringify(person)>|<fromDate>|<toDate>`.
  - A staff-group entry renders its members, separated by commas, or `"No members"`. A group with a description adds ` · “<description>”`.
  - An off cell at weight `Infinity` renders `"Must be off"`.
  - A rename renders as one `changed` entry labelled `Renamed “old” to “new”`.
  - Two or more newly created must-be-off days from one `mark_person_off` render as one `offrun:` entry: label `<person>: must be off`, after `<n> days, <from> to <to>`.

- [ ] **Step 1: Write the failing diff tests**

In `web/lib/proposal/diff.test.ts`, change the fixture import to `import { peopleScenario, proposalScenario } from "./test-support";`. Append inside `describe("deriveProposalDiff", ...)`:

```ts
  it("shows a borrowed nurse as a person, a group change and two runs of days off", () => {
    const before = peopleScenario();
    const float = "Float RN (Ward 5)";
    const commands = [
      { type: "add_person" as const, name: float, groups: ["RN"] },
      {
        type: "mark_person_off" as const,
        personId: float,
        fromDate: "2026-10-01",
        toDate: "2026-10-11",
      },
      {
        type: "mark_person_off" as const,
        personId: float,
        fromDate: "2026-10-15",
        toDate: "2026-10-31",
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.map((entry) => entry.key).sort()).toEqual([
      `offrun:"${float}"|2026-10-01|2026-10-11`,
      `offrun:"${float}"|2026-10-15|2026-10-31`,
      "peoplegroup:RN",
      `person:"${float}"`,
    ]);
    expect(diff.cascade).toEqual([]);
    expect(diff.needsReview).toEqual([]);
    const find = (key: string) => diff.direct.find((entry) => entry.key === key);
    expect(find(`person:"${float}"`)).toMatchObject({ kind: "created", after: float });
    expect(find("peoplegroup:RN")).toMatchObject({
      label: "Staff group “RN”",
      before: "ana, 7",
      after: `ana, 7, ${float}`,
    });
    expect(find(`offrun:"${float}"|2026-10-01|2026-10-11`)).toMatchObject({
      label: `${float}: must be off`,
      after: "11 days, 2026-10-01 to 2026-10-11",
      kind: "created",
    });
    expect(find(`offrun:"${float}"|2026-10-15|2026-10-31`)?.after).toBe(
      "17 days, 2026-10-15 to 2026-10-31",
    );
  });

  it("shows a rename as one renamed entry, with the groups it touched", () => {
    const before = peopleScenario();
    const commands = [
      { type: "edit_person" as const, personId: "ana", name: "Ana Lim", groups: ["RN"] },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.find((entry) => entry.key === 'person:"ana"')).toBeUndefined();
    expect(diff.direct.find((entry) => entry.key === 'person:"Ana Lim"')).toMatchObject({
      label: "Renamed “ana” to “Ana Lim”",
      before: "ana",
      after: "Ana Lim",
      kind: "changed",
    });
    expect(diff.direct.find((entry) => entry.key === "peoplegroup:RN")?.after).toBe(
      "Ana Lim, 7",
    );
  });

  it("removing a person lists what goes with them", () => {
    const before = peopleScenario();
    const commands = [{ type: "remove_person" as const, personId: "bo" }];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.map((entry) => entry.key)).toEqual(['person:"bo"']);
    expect(diff.cascade.map((entry) => entry.key).sort()).toEqual([
      'cell:"bo"|"29"',
      "peoplegroup:Seniors",
      "rule:counts:count-bo",
    ]);
    expect(diff.cascade.find((entry) => entry.key === "peoplegroup:Seniors")?.after).toBe(
      "No members · “Band 6 and above”",
    );
    expect(diff.needsReview).toEqual(["rules", "requests"]);
  });

  it("shows a leave turned into a must-be-off day as a change", () => {
    const before = peopleScenario();
    const commands = [
      {
        type: "mark_person_off" as const,
        personId: "ana",
        fromDate: "2026-10-01",
        toDate: "2026-10-03",
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.find((entry) => entry.key === 'cell:"ana"|"02"')).toMatchObject({
      before: "Leave",
      after: "Must be off",
      kind: "changed",
    });
    expect(diff.direct.find((entry) => entry.key.startsWith("offrun:"))?.after).toBe(
      "2 days, 2026-10-01 to 2026-10-03",
    );
  });
```

- [ ] **Step 2: Write the failing assumption tests**

In `web/lib/proposal/assumptions.test.ts`, change the fixture import to `import { peopleScenario, proposalScenario } from "./test-support";`. Append:

```ts
describe("deriveAssumptions and the Staff-screen arms", () => {
  function peopleAssumptions(commands: Parameters<typeof applyAssistantCommands>[1]) {
    const before = peopleScenario();
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture refused: ${applied.rejection.message}`);
    return deriveAssumptions(before, applied.next, commands);
  }

  it("a rename relabels leave; it does not ask about giving it up", () => {
    expect(
      peopleAssumptions([{ type: "edit_person", personId: "ana", name: "Ana Lim", groups: ["RN"] }]),
    ).toEqual([]);
  });

  it("a rename chain inside one batch still asks nothing", () => {
    expect(
      peopleAssumptions([
        { type: "edit_person", personId: "ana", name: "Ana Lim", groups: ["RN"] },
        { type: "edit_person", personId: "Ana Lim", name: "Ana L.", groups: ["RN"] },
      ]),
    ).toEqual([]);
  });

  it("removing a person asks about each leave day", () => {
    const assumptions = peopleAssumptions([{ type: "remove_person", personId: "ana" }]);
    expect(assumptions.map((a) => [a.type, a.person, a.date])).toEqual([
      ["leave_cancelled", "ana", "02"],
    ]);
  });

  it("marking a person off over their leave asks about it", () => {
    const assumptions = peopleAssumptions([
      { type: "mark_person_off", personId: "ana", fromDate: "2026-10-02", toDate: "2026-10-02" },
    ]);
    expect(assumptions.map((a) => [a.type, a.person, a.date])).toEqual([
      ["leave_cancelled", "ana", "02"],
    ]);
  });
});
```

- [ ] **Step 3: Run to check they fail**

Run: `cd web && pnpm vitest run lib/proposal/diff.test.ts lib/proposal/assumptions.test.ts`
Expected: FAIL. The new entries are in `cascade`. The group render is `"2 members"`. There is no `offrun:` entry. The rename test gets a `leave_cancelled` for `ana`/`02`.

- [ ] **Step 4: Implement the diff changes**

In `web/lib/proposal/diff.ts`, add the import:

```ts
import { generateDateItems } from "@/lib/dates";
```

Replace the `off` case in `describeCell`:

```ts
    case "off":
      return cell.weight === Infinity
        ? "Must be off"
        : `Prefers off (weight ${renderWeight(cell.weight)})`;
```

Replace the staff-group `render` line inside `diffScenarioDocuments`:

```ts
      render: (group) => {
        const members = group.members.length ? group.members.map(String).join(", ") : "No members";
        const described = group.description?.trim();
        return described ? `${members} · “${described}”` : members;
      },
```

Add these helpers above `directKeys`:

```ts
/** The date ids a `mark_person_off` covers, in the document that holds its cells. */
function offRunCellKeys(
  command: Extract<AssistantCommandV1, { type: "mark_person_off" }>,
  state: ScenarioUiState,
): string[] {
  return generateDateItems({ start: state.rangeStart, end: state.rangeEnd })
    .filter((item) => item.iso >= command.fromDate && item.iso <= command.toDate)
    .map((item) => `cell:${stableStringify(command.personId)}|${stableStringify(item.id)}`);
}

/**
 * A rename is ONE change to a ward manager, but the structural comparison sees the old
 * id removed and the new one created. Fold each such pair into one entry.
 */
function mergeRenames(entries: Entry[], commands: readonly AssistantCommandV1[]): Entry[] {
  let merged = entries;
  for (const command of commands) {
    let rename: { from: string; to: string; label: string } | null = null;
    if (command.type === "edit_person" && command.name !== String(command.personId)) {
      rename = {
        from: `person:${stableStringify(command.personId)}`,
        to: `person:${stableStringify(command.name.trim())}`,
        label: `Renamed “${String(command.personId)}” to “${command.name.trim()}”`,
      };
    } else if (command.type === "edit_people_group" && command.newGroupId !== command.groupId) {
      rename = {
        from: `peoplegroup:${command.groupId}`,
        to: `peoplegroup:${command.newGroupId.trim()}`,
        label: `Renamed staff group “${command.groupId}” to “${command.newGroupId.trim()}”`,
      };
    }
    if (!rename) continue;
    const { from, to, label } = rename;
    const removed = merged.find((entry) => entry.key === from && entry.kind === "removed");
    const created = merged.find((entry) => entry.key === to && entry.kind === "created");
    if (!removed || !created) continue;
    merged = [
      ...merged.filter((entry) => entry !== removed && entry !== created),
      { ...created, label, before: removed.before, kind: "changed" },
    ];
  }
  return merged;
}

/**
 * Twenty-eight "must be off" rows would hide the one that matters. Days a run CREATES
 * fold into one summary per command; a day that already held something (a leave, a
 * request) stays its own entry, so the Preview never understates what is replaced.
 */
function collapseOffRuns(
  entries: Entry[],
  commands: readonly AssistantCommandV1[],
  after: ScenarioUiState,
): Entry[] {
  let collapsed = entries;
  for (const command of commands) {
    if (command.type !== "mark_person_off") continue;
    const keys = new Set(offRunCellKeys(command, after));
    const created = collapsed.filter((entry) => entry.kind === "created" && keys.has(entry.key));
    if (created.length < 2) continue;
    collapsed = [
      ...collapsed.filter((entry) => !created.includes(entry)),
      {
        key: `offrun:${stableStringify(command.personId)}|${command.fromDate}|${command.toDate}`,
        scope: "leave-and-requests",
        label: `${String(command.personId)}: must be off`,
        before: null,
        after: `${created.length} days, ${command.fromDate} to ${command.toDate}`,
        kind: "created",
      },
    ];
  }
  return collapsed;
}
```

Change the `directKeys` signature and add cases after `add_shift_group`:

```ts
function directKeys(
  commands: readonly AssistantCommandV1[],
  before: ScenarioUiState,
  after: ScenarioUiState,
): Set<string> {
```

```ts
      case "add_person":
        keys.add(`person:${stableStringify(command.name.trim())}`);
        for (const group of command.groups) keys.add(`peoplegroup:${group}`);
        break;
      case "edit_person":
        keys.add(`person:${stableStringify(command.personId)}`);
        keys.add(`person:${stableStringify(command.name.trim())}`);
        for (const group of command.groups) keys.add(`peoplegroup:${group}`);
        // Groups they LEAVE (or that follow their rename) were asked for too.
        for (const group of before.staffGroups) {
          if (group.members.some((member) => member === command.personId)) {
            keys.add(`peoplegroup:${group.id}`);
          }
        }
        break;
      case "remove_person":
        keys.add(`person:${stableStringify(command.personId)}`);
        break;
      case "add_people_group":
        keys.add(`peoplegroup:${command.groupId.trim()}`);
        break;
      case "edit_people_group":
        keys.add(`peoplegroup:${command.groupId}`);
        keys.add(`peoplegroup:${command.newGroupId.trim()}`);
        break;
      case "remove_people_group":
        keys.add(`peoplegroup:${command.groupId}`);
        break;
      case "mark_person_off":
        for (const key of offRunCellKeys(command, after)) keys.add(key);
        break;
```

In `deriveProposalDiff`, replace the first three lines of the body:

```ts
  const named = directKeys(commands, before, after);
  const all = diffScenarioDocuments(before, after);
  const direct = collapseOffRuns(
    mergeRenames(
      all.filter((entry) => named.has(entry.key)),
      commands,
    ),
    commands,
    after,
  );
  const cascade = all.filter((entry) => !named.has(entry.key));
```

(`capabilityIds` is still computed from `all`. The scopes are the same, so the result is the same.)

- [ ] **Step 5: Implement the assumption change**

In `web/lib/proposal/assumptions.ts`, add above `deriveAssumptions`:

```ts
/**
 * Where each person or staff group a batch renames ends up, keyed as leave pins key a
 * person. A rename cascade re-labels leave -- it does not cancel it -- so without this
 * a plain rename would ask "has ana agreed to give up their leave". Same "changed text"
 * rule as the Staff screen (`edit_person` / `edit_people_group` in `operations.ts`).
 */
function finalNames(commands: readonly AssistantCommandV1[]): (personKey: string) => string {
  const step = new Map<string, string>();
  for (const command of commands) {
    if (command.type === "edit_person" && command.name !== String(command.personId)) {
      step.set(stableStringify(command.personId), stableStringify(command.name.trim()));
    }
    if (command.type === "edit_people_group" && command.newGroupId !== command.groupId) {
      step.set(stableStringify(command.groupId), stableStringify(command.newGroupId.trim()));
    }
  }
  // ponytail: follows chains (a -> b -> c) but not a batch that reuses a freed name for
  // someone else; such a batch may ask one extra, answerable question.
  return (personKey) => {
    let current = personKey;
    for (let hops = 0; hops < step.size; hops += 1) {
      const next = step.get(current);
      if (next === undefined) break;
      current = next;
    }
    return current;
  };
}
```

In `deriveAssumptions`, replace the destroyed-leave loop header and its first line:

```ts
  const surviving = leavePins(after);
  const renamedTo = finalNames(commands);
  for (const [key, cell] of leavePins(before)) {
    const followed = `${renamedTo(stableStringify(cell.person))}|${stableStringify(cell.date)}`;
    if (claimed.has(key) || surviving.has(key) || surviving.has(followed)) continue;
```

(The rest of the loop body does not change.)

- [ ] **Step 6: Run to check they pass, plus the suites that render or store diffs**

Run: `cd web && pnpm vitest run lib/proposal components/ai lib/store/assistant-proposal.test.ts lib/repository/assistant-apply.test.ts`
Expected: PASS. An existing assertion can pin `"N members"` for a staff group or `"Prefers off (weight must)"`. If so, change it to the new text, write that in the commit message, and keep the new text.

- [ ] **Step 7: Commit** (only with commit authority)

```bash
git add web/lib/proposal/diff.ts web/lib/proposal/diff.test.ts web/lib/proposal/assumptions.ts web/lib/proposal/assumptions.test.ts
git commit -m "feat(assistant): preview names people changes; rename keeps leave unasked"
```

---

### Task 6: Help content says what the assistant can do for staff

**Files:**
- Modify: `web/lib/capability/help-content.ts` (`staff-list` entry around line 51, `ai-assistant-conversation` entry around line 285)
- Regenerate: `web/lib/capability/registry.generated.ts`
- Test: `web/lib/capability/registry.generated.test.ts` (existing stale-manifest gate, no edits)

**Interfaces:**
- Consumes: nothing.
- Produces: a new manifest hash.

- [ ] **Step 1: Update the help content**

`staff-list` entry, `nurseFacingSummary` and `concepts`:

```ts
    nurseFacingSummary:
      "List the nurses being rostered and put them into groups — for example seniors, or a " +
      "team — so a rule can be written about the group instead of naming every person. A nurse " +
      "borrowed from another ward for a few days is added like anyone else and marked off on " +
      "the days they are not here. The assistant can prepare these changes for you to review " +
      "and apply.",
    concepts: [
      "staff",
      "nurse",
      "person",
      "people group",
      "seniors",
      "team",
      "float nurse",
      "agency nurse",
      "borrowed staff",
    ],
```

`ai-assistant-conversation` entry `nurseFacingSummary`. If a sibling plan has already changed this sentence, keep its clauses and add ours:

```ts
    nurseFacingSummary:
      "Once it is on, the assistant can read the set-up you have open, explain how the app " +
      "works, and suggest which rule expresses a policy you describe. It can also prepare " +
      "changes — the roster period, turning a rule on or off, a staffing head count, moving " +
      "leave, adding shifts and shift groups, adding, renaming or removing staff and staff " +
      "groups, and marking someone off for a run of days — which you review and apply " +
      "yourself. It cannot change the roster on its own, and it cannot edit or delete existing " +
      "shifts. It is not a source of employment, legal or clinical-safety authority.",
```

- [ ] **Step 2: Run the manifest gate to check it fails**

Run: `cd web && pnpm vitest run lib/capability/registry.generated.test.ts`
Expected: FAIL. The recomputed hash does not match.

- [ ] **Step 3: Regenerate**

Run: `cd web && pnpm capability:generate`
Expected: only `manifestSha256` and `canonicalByteLength` change in `registry.generated.ts`.

- [ ] **Step 4: Run the affected suites**

Run: `cd web && pnpm vitest run lib/capability lib/ai/phase-2-absence.test.ts`
Expected: PASS. If a concept-uniqueness test fails on a new concept, remove that one concept. Do not rename an existing one.

- [ ] **Step 5: Commit** (only with commit authority)

```bash
git add web/lib/capability/help-content.ts web/lib/capability/registry.generated.ts
git commit -m "docs(help): assistant can propose staff changes and borrowed nurses"
```

---

### Task 7: Whole-branch gates

**Files:** none new.

- [ ] **Step 1: Run the suites that embed the command union or the moved writers**

Run: `cd web && pnpm vitest run lib/proposal lib/ai lib/capability lib/repository/assistant-apply.test.ts lib/store components/ai components/people components/entity-editor components/requests`
Expected: PASS. `lib/repository/assistant-apply.test.ts` re-derives through `applyAssistantCommands`, so it covers Apply without edits.

- [ ] **Step 2: Typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm exec oxlint && pnpm exec ast-grep scan`
Expected: no errors. If oxlint flags the `@/components/people/...` import in `lib/proposal/operations.ts`, stop and report. The shift arms already import `@/components/shift-types/...` there, so a hit means the config changed.

- [ ] **Step 3: Manual smoke (optional, needs a dev server and an AI key)**

Load a ward whose night staffing is infeasible on 12-14 Oct. Ask: "borrow one RN from Ward 5 for nights on 12-14 Oct". Expected: one Preview with the new person, the RN group gaining them, and two "must be off" runs. Nothing changes before Apply. After Apply, the Staff page lists the nurse, and the Requests grid shows OFF (must) on every day except 12-14.

---

## Self-Review

- **Spec coverage.** Agent-native parity with the Staff screen is in Task 2. Add is `add_person`. Edit is `edit_person`: rename and groups, the only fields the table edits. Delete is `remove_person`. Staff groups have add, edit and delete arms. Same pure functions: Task 1 moves the two private writers into the core, and Tasks 2 and 4 call and compare them. Parity with the manual path: Task 3 (quick-paint fold) and Task 4 (Staff saves), each with a mutation check. Rejections name the target: every message starts `Person "…"` / `Staff group "…"`, and the tests assert the name. Borrowed staff with the existing concept: Task 3, `mark_person_off` = quick paint OFF at weight Infinity. Realistic test "Float RN (Ward 5)", RN, only 12-14: Task 3 operations test and Task 5 diff test. Remove with leave, requests or rules: cascade as the UI does, pinned in Tasks 2 and 5, and leave questions in Task 5. Preview in plain words: Task 5. Locked lists: Tasks 2 and 3. Help: Task 6. Gates: Task 7.
- **Placeholder scan.** No TBD or TODO. Every code step has code. The one `ponytail:` comment names a real, accepted limit.
- **Type consistency.** Arm fields are the same in Tasks 2-5, the representative map and the parity tests: `name`, `groups`, `personId`, `groupId`, `newGroupId`, `description`, `members`, `fromDate`, `toDate`. `findPerson` and `unknownPersonMessage` are defined in Task 2 and used in Task 3. `writeItemGroups` and `writeGroupMembers` keep the signatures from Task 1 everywhere. The uid format `off:"ana"|"07"` is the same in Task 3 (op test) and in `mintCellUid`.
- **Review Focus.** Each of the five lines has a test in the task that owns the code. Line 1 is in Task 2. Lines 4 and 5 are in Task 3. Lines 2, 3 and 4 (the question) are in Task 5.

## Decisions

1. **Unavailable days are `OFF` at weight `Infinity`, not `LEAVE`.** Both are existing Requests-screen concepts. Both are hard in the solver: `LEAVE` is a hard pin (`preference_types.py:258-262`), and OFF at `±inf` is a hard constraint (`utils.py:41-44`). `LEAVE` means paid leave. It can count toward contracted hours through the `LEAVE` coefficient. It triggers the uncredited-leave warnings (`lib/scenario/leave-guard`). It prints as leave on the roster. Later removing it asks "has X agreed to give up their leave". A borrowed nurse's other days are none of these. OFF prints blank.
2. **`mark_person_off` takes a run of days (`fromDate` to `toDate`), not a list.** One quick-paint drag across a row is a run. A borrowed nurse is `add_person` plus two runs, which is 3 of the 25 allowed operations. A list of dates costs the model 28 date values, and one date-format mistake refuses the whole change.
3. **ISO dates, not date ids.** The model is never told the date-id format (`DD` / `MM-DD` / ISO depends on the span). The host maps ISO to id with `generateDateItems`.
4. **Removal cascades, as the Staff screen does.** There is no block. The Preview lists every consequence, and the existing host check asks about each destroyed leave day.
5. **The two edit arms take the full final state, as the forms do.** `edit_person` takes name and groups. `edit_people_group` takes id, description and members. The model sends current values to keep them. The Preview shows every group change as a direct entry, so an accidental drop is visible before Apply.
6. **No-op edits are refused (`no_effect`),** as the existing arms do. The Staff screen allows a no-op Save, but here it spends an Undo entry on nothing.
7. **New cells get deterministic uids** (`off:<person>|<date>`). A taken uid gets a suffix. Apply re-derives the document.

## Open Questions (each with a recommended answer)

1. **Rules for everyone bind the borrowed nurse.** An example is a count rule "each nurse works at least 15 shifts" on `ALL` or `RN`. It makes a 3-day float nurse infeasible. *Recommendation:* accept it for this plan. The model reads the rules before it proposes. `test_feasibility_candidates` embeds this union. Thus the model can test the borrowed-nurse fix before the Preview, and it finds out. A rules-family plan adds "exclude a person from a rule" as the real fix (refer to Follow-ups).
2. **"For nights".** This plan makes the float nurse available only on 12-14. It does not force night shifts. *Recommendation:* no extra arm now. The solver places the nurse where cover is missing, which is the point of borrowing. If wards want to restrict the shift type, a requests-family arm (a shift request at a weight) is the follow-up. Do not add it here.
3. **Overlap with a sibling requests-family plan.** `mark_person_off` is a Requests-screen action. *Recommendation:* keep it here, because borrowed staff needs it and it is narrow (one day-state, one weight). If a requests plan lands a general quick-paint arm first, keep `mark_person_off` as the named, safe shortcut. Merge order decides the arm order only.
4. **Duplicate person, reorder staff, Upload list.** *Recommendation:* out of scope. Batched `add_person` covers the Upload list's adds. Reorder changes only the display order. File as follow-ups.
5. **A person's `description`.** The Staff table never edits it. *Recommendation:* no arm field, which keeps UI parity. Revisit this after the Staff screen gains the field.

## Assumptions

- The per-turn instruction already tells the model to use `prepare_scenario_change` and not refuse. The source is the 2026-09-23 product decision and the `READ_ONLY_AUTHORITY_STATEMENT` correction released with the shift plan. This plan does not edit `scenario-context.ts`.
- The model reads the staff and groups (`get_schedule_section("staff")`) and the roster period before it proposes. A wrong id or date is refused with a message that names it.
- CopilotKit carries `z.array(refSchema)` (`anyOf` in `items`) as it carries `refSchema` for `move_leave`. Otherwise Task 2 Step 8 stops.
- Importing `lib/store/paint.ts` in the jsdom parity suite has no side effects that break the suite. The store suites already import `lib/store`.
- `sanitizePersistedScenario` accepts OFF cells at weight `Infinity` in memory (`web/lib/store/persistence.ts:701-770` handles `±Infinity`).
- An emptied staff group after removing its last member is left in place, as the UI leaves it (FR-RI-17). Normal validation reports it.

## Follow-ups

- Rules family: exclude one person from a rule, or narrow a rule's person target. Then full-time count rules do not bind a borrowed nurse (Open question 1).
- Requests family: a shift-request arm for "prefers / must work Night on these days" (Open question 2).
- Staff: duplicate person, reorder staff and staff groups, duplicate group.
- The model-facing instruction can name the float-nurse pattern as a standard infeasibility fix. Today it learns this from the `staff-list` help summary (Task 6) and the `mark_person_off` field descriptions.
