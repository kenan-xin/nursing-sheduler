# Assistant Self-Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app's refusals tell the assistant what IS valid. This applies to a wrong id, a wrong time format and a malformed payload. The assistant then corrects the call once. It does not guess again, and it does not give up. Staffing text also stops saying "at least" where the solver means "exactly".

**Architecture:** Three small changes at existing seams. (1) In `web/lib/proposal/operations.ts`, refusals for unknown people, groups, shifts and rules append a capped list of valid ids. A new pure helper module, `web/lib/proposal/choices.ts`, builds the list. (2) The shared schema refusal in `web/components/ai/tool-payload.ts` names what each bad field expected, using only schema-derived words, and allows one corrected retry. Clock fields become plain strings, so the host's `validateWorkingTimeDraft` refuses a bad time and names the shift. (3) The model's instruction text (authority statement, `get_schedule_section`, `prepare_scenario_change`) says to take ids from the schedule and never guess. The staffing wording is fixed in the help, nav, home and Guided summary text.

**Tech Stack:** Next.js app in `web/`, TypeScript, zod 4.4.3, vitest 4, pnpm.

**Spec:** beads `nursing-sheduler-912`, `nursing-sheduler-b1a`, `nursing-sheduler-ao3` (`bd show <id>`). Solver semantics: `core/nurse_scheduling/preference_types.py:174-193` (`qualifiedPeople` bans everyone else. `requiredNumPeople` is EXACT. With `preferredNumPeople` set, it is the floor.) Skill-mix pattern: `core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml` (twin shift `night+` plus its own requirement).

## Global Constraints

- All commands run from `web/`: `cd /home/kenan/work/nursing-sheduler/web`.
- Tests: `pnpm vitest run <path>`. Typecheck: `pnpm typecheck`. Lint: `pnpm exec oxlint && pnpm exec ast-grep scan`. Under pnpm 11, `pnpm lint` can resolve to eslint, so call the two tools directly.
- Any change to `web/lib/capability/help-content.ts` needs `pnpm capability:generate`, then `pnpm vitest run lib/capability` must pass.
- Locked tests (`web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`, `web/components/ai/tool-payload-boundary.test.tsx`) change only on purpose. Each edit carries a comment in the house form: `// CHANGED DELIBERATELY (2026-09-24, plan assistant-self-correction): <reason>`.
- A refusal never echoes model-supplied values. The ids it lists come from the document, never from the payload. The schema refusal still contains `not a valid call to this tool` and `Nothing was read, changed or opened`, and never contains `undefined`, `Error:` or a received value.
- Operation refusal messages (`CommandRejection.message`) are nurse-readable, because the repository's Apply-time error shows them too. They never name a model tool. Tool names such as `get_schedule_section` appear only in model-facing wrapper text (`use-proposal-tools.ts`, `tool-payload.ts`, descriptions, the authority statement).
- At most `LISTED_CHOICES = 20` ids per refusal, then `and N more`.
- Ids are written exactly as they must be sent back: strings JSON-quoted, numbers bare (`"ana", "bo", 7`).
- Commit steps assume the session has commit authority. Under this repo's default Conservative profile, stage the files and report instead of committing.
- Code style: follow the surrounding file (2 spaces, double quotes, semicolons, trailing commas). Comments explain WHY, in the house voice.

## Review Focus

1. **A ward bigger than 20 people.** The refusal lists 20 and says `and N more`. The model-facing wrapper tells it to read `get_schedule_section("staff")` for the rest. Pinned in Task 1 (`choices.test.ts` cap case) and Task 3 (wrapper text).
2. **The model sends `"ALL"`, `"everyone"` or `"Everyone"` as a rule's people.** The refusal says the rule cannot say everyone directly. It names a staff group that already holds every person. When no such group exists, it lists every person. Pinned in Task 1.
3. **Numeric person id `7` sent as `"7"`.** The listed choice shows `7` bare, so the model can see the type difference. Pinned in Task 2 (`peopleScenario` has person `7`).
4. **A schema refusal for a missing field.** Zod's default message says `received undefined`, and the boundary test forbids `undefined`. The hint must come from `issue.expected`, not `issue.message`. Pinned in Task 4.
5. **Blank clock strings once the regex is gone.** `validateWorkingTimeDraft` treats `""` and `"  "` as absent. The result is a shift with no hours and no warning. Pinned in Task 5 by a host guard and a test.

---

## File Structure

- Create `web/lib/proposal/choices.ts`: pure helpers that turn document ids into a capped "Valid choices: …" sentence. Also detects "everyone" and groups that hold everyone. React-free, so `react-free.test.ts` stays green.
- Create `web/lib/proposal/choices.test.ts`.
- Modify `web/lib/proposal/operations.ts`: every `unknown_target` refusal about a person, group, shift or rule id appends a choice list.
- Modify `web/lib/proposal/operations.test.ts`.
- Modify `web/lib/proposal/commands.ts` (clock schema only) and `web/lib/proposal/commands.test.ts`.
- Modify `web/components/ai/tool-payload.ts`, create `web/components/ai/tool-payload.test.ts`, modify `web/components/ai/tool-payload-boundary.test.tsx` (locked).
- Modify `web/components/ai/use-proposal-tools.ts`, `web/components/ai/use-context-tools.ts`, `web/lib/ai/assistant/scenario-context.ts`, and their tests `web/components/ai/proposal-tool-boundary.test.tsx` and `web/lib/ai/assistant/scenario-context.test.ts`.
- Modify the wording files: `web/components/ai/use-help-tools.ts`, `web/components/shell/nav-config.ts`, `web/components/home/home-guided.tsx`, `web/components/guided-rules/mappers.ts` (+ `mappers.test.ts`), `web/lib/capability/help-content.ts` (+ regenerated `registry.generated.ts`), `web/lib/capability/guidance.test.ts`, `docs/superpowers/plans/2026-09-24-assistant-rule-ops.md`.

---

### Task 1: Choice lists for rule-family refusals (912, part 1)

**Files:**
- Create: `web/lib/proposal/choices.ts`
- Create: `web/lib/proposal/choices.test.ts`
- Modify: `web/lib/proposal/operations.ts` (`successionRejection`, `countRejection`, `requirementRejection`, `applyEditSuccessionRule`, `applyEditCountRule`, `applyEditStaffingRequirement`, `applyRemoveRule`, `applySetRuleEnabled`, `applySetRequirementPeople`)
- Test: `web/lib/proposal/operations.test.ts`

**Interfaces:**
- Produces (used by Task 2):
  - `LISTED_CHOICES: 20`
  - `idLabel(id: unknown): string`
  - `choiceList(labels: readonly string[]): string`
  - `offeredChoices(options: readonly { value: unknown; disabled?: boolean }[]): string`
  - `peopleChoices(state: ScenarioUiState): string`
  - `staffGroupChoices(state: ScenarioUiState): string`
  - `staffRowChoices(state: ScenarioUiState): string`
  - `shiftChoices(state: ScenarioUiState): string`
  - `ruleChoices(state: ScenarioUiState, kind: keyof CardsByKind): string`
  - `meansEveryone(ref: unknown): boolean`
  - `everyoneGroups(state: ScenarioUiState): string[]`

- [ ] **Step 1: Write the failing helper tests**

`web/lib/proposal/choices.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  LISTED_CHOICES,
  choiceList,
  everyoneGroups,
  idLabel,
  meansEveryone,
  ruleChoices,
} from "./choices";
import { ruleWardScenario } from "./test-support";

describe("refusal choice lists", () => {
  it("writes ids exactly as they must be sent back: strings quoted, numbers bare", () => {
    expect(idLabel("ana")).toBe('"ana"');
    expect(idLabel(7)).toBe("7");
    expect(choiceList([idLabel("ana"), idLabel(7)])).toBe('Valid choices: "ana", 7.');
  });

  it("caps a long list and says how many more there are", () => {
    const labels = Array.from({ length: LISTED_CHOICES + 5 }, (_, n) => idLabel(`p${n}`));
    const text = choiceList(labels);
    expect(text).toContain('"p19"');
    expect(text).not.toContain('"p20"');
    expect(text).toMatch(/and 5 more\.$/);
  });

  it("says so when there is nothing to choose from", () => {
    expect(choiceList([])).toBe("There are none yet.");
  });

  it("lists rule ids with their titles", () => {
    expect(ruleChoices(ruleWardScenario(), "counts")).toBe(
      'Valid choices: "cnt-nights" (Night cap).',
    );
  });

  it("recognises the ways a model says everyone", () => {
    for (const ref of ["ALL", "all", "Everyone", " everybody "]) expect(meansEveryone(ref)).toBe(true);
    for (const ref of ["ana", 7, "RN"]) expect(meansEveryone(ref)).toBe(false);
  });

  it("finds staff groups that already hold every person, and none on an empty ward", () => {
    const state = ruleWardScenario();
    expect(everyoneGroups(state)).toEqual([]);
    const withAll = {
      ...state,
      staffGroups: [...state.staffGroups, { id: "All staff", members: ["cai", "ana", "ben"] }],
    };
    expect(everyoneGroups(withAll)).toEqual(["All staff"]);
    expect(everyoneGroups(createEmptyScenarioUiState())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run lib/proposal/choices.test.ts`
Expected: FAIL, cannot resolve `./choices`.

- [ ] **Step 3: Write `choices.ts`**

```ts
// Valid-choice lists for "unknown target" refusals (nursing-sheduler-912).
//
// A refusal that only says "not found" sends the model back to guessing. Live, "apply a
// rule to everyone" produced three invented names in a row before the model gave up and
// asked the user. A refusal that names what IS there lets it correct the id in one retry.
//
// CAPPED, because a list of 60 nurses is not a sentence anyone reads. The rest are one
// read away, and saying so is the model-facing wrapper's job (`use-proposal-tools.ts`):
// these strings are also shown to a nurse, so they never name a tool.
//
// Every id comes from the DOCUMENT, never from the payload, so listing them echoes
// nothing the model sent.

import type { CardsByKind, ScenarioUiState } from "@/lib/scenario";

/** How many choices a refusal names before "and N more". */
export const LISTED_CHOICES = 20;

/** One id as it must be sent back: strings quoted, numbers bare (`7` and `"7"` differ). */
export function idLabel(id: unknown): string {
  return typeof id === "number" ? String(id) : JSON.stringify(String(id));
}

/** `Valid choices: "ana", 7 and 3 more.` Labels are already formatted and in document order. */
export function choiceList(labels: readonly string[]): string {
  const unique = [...new Set(labels)];
  if (unique.length === 0) return "There are none yet.";
  const more = unique.length - LISTED_CHOICES;
  return (
    `Valid choices: ${unique.slice(0, LISTED_CHOICES).join(", ")}` +
    `${more > 0 ? ` and ${more} more` : ""}.`
  );
}

/** What a manual picker offers, minus what it shows disabled. */
export function offeredChoices(options: readonly { value: unknown; disabled?: boolean }[]): string {
  return choiceList(options.filter((option) => !option.disabled).map((option) => idLabel(option.value)));
}

export function peopleChoices(state: ScenarioUiState): string {
  return choiceList(state.staff.map((person) => idLabel(person.id)));
}

export function staffGroupChoices(state: ScenarioUiState): string {
  return choiceList(state.staffGroups.map((group) => idLabel(group.id)));
}

/** The request matrix's rows: people, then staff groups. */
export function staffRowChoices(state: ScenarioUiState): string {
  return choiceList([
    ...state.staff.map((person) => idLabel(person.id)),
    ...state.staffGroups.map((group) => idLabel(group.id)),
  ]);
}

export function shiftChoices(state: ScenarioUiState): string {
  return choiceList(state.shifts.map((shift) => idLabel(shift.id)));
}

/** Rule ids of one family, each with its title when it has one: `"cnt-nights" (Night cap)`. */
export function ruleChoices(state: ScenarioUiState, kind: keyof CardsByKind): string {
  const cards = state.cardsByKind[kind] as readonly { uid: string; description?: string }[];
  return choiceList(
    cards.map((card) => {
      const title = card.description?.trim();
      return title ? `${idLabel(card.uid)} (${title})` : idLabel(card.uid);
    }),
  );
}

/** Whether a person ref is the model's way of saying "every nurse". */
export function meansEveryone(ref: unknown): boolean {
  return typeof ref === "string" && /^(all|everyone|everybody)$/i.test(ref.trim());
}

/**
 * Staff groups that already hold every person on the staff list.
 *
 * The rule pickers never offer the synthetic `ALL` (see `rulePeopleSchema`), so an
 * authored group like this is the only way these screens can name everyone at once.
 */
export function everyoneGroups(state: ScenarioUiState): string[] {
  if (state.staff.length === 0) return [];
  return state.staffGroups
    .filter((group) =>
      state.staff.every((person) => group.members.some((member) => Object.is(member, person.id))),
    )
    .map((group) => String(group.id));
}
```

- [ ] **Step 4: Run the helper tests**

Run: `pnpm vitest run lib/proposal/choices.test.ts`
Expected: PASS. If `ruleChoices` does not typecheck because a card type lacks `description`, keep the structural cast shown. Do not widen `CardsByKind`.

- [ ] **Step 5: Write the failing operation tests**

Add to `web/lib/proposal/operations.test.ts`, inside `describe("add_succession_rule / edit_succession_rule", ...)`. It reuses `noDayAfterNight` and `edit()`:

```ts
  it("lists the people and groups it could have used when a name is unknown", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...noDayAfterNight,
      people: ["Sarah"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("unknown_target");
    expect(result.rejection.message).toContain('Valid choices: "ana", "ben", "cai", "RN", "Senior"');
    expect(result.rejection.message).not.toContain("get_schedule_section");
  });

  it("answers 'everyone' with the people to list when no group holds everyone", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...noDayAfterNight,
      people: ["Everyone"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('cannot say "everyone" directly');
    expect(result.rejection.message).toContain('Valid choices: "ana", "ben", "cai".');
  });

  it("answers 'ALL' with the staff group that already holds everyone", () => {
    const base = ruleWardScenario();
    const state = {
      ...base,
      staffGroups: [...base.staffGroups, { id: "All staff", members: ["ana", "ben", "cai"] }],
    };
    const result = applyAssistantCommand(state, { ...noDayAfterNight, people: ["ALL"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Use the staff group "All staff"');
  });

  it("lists the shifts it could have used when a pattern step is unknown", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...noDayAfterNight,
      pattern: ["Nights", "Day"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('"Day"');
    expect(result.rejection.message).toContain('"Night"');
  });

  it("lists this family's rule ids when an edit names one that is not there", () => {
    const result = applyAssistantCommand(ruleWardScenario(), edit({ ruleId: "nope" } as never));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Valid choices: "suc-nd" (No day after night).');
  });
```

Add to `describe("add_staffing_requirement / edit_staffing_requirement", ...)`. Build the command inline so it does not depend on local helpers:

```ts
  it("lists the staffable shifts when the shift is unknown, and never OFF or LEAVE", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      type: "add_staffing_requirement",
      description: "",
      shiftType: "Nights",
      qualifiedPeople: ["ALL"],
      dates: ["ALL"],
      requiredNumPeople: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('"Day"');
    expect(result.rejection.message).toContain('"Working shifts"');
    expect(result.rejection.message).not.toContain('"OFF"');
  });
```

Add to `describe("remove_rule", ...)`:

```ts
  it("lists the family's rule ids when the rule is not there", () => {
    const result = applyAssistantCommand(proposalScenario(), {
      type: "remove_rule",
      ruleKind: "requirements",
      ruleId: "gone",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('"req-day" (Day cover)');
    expect(result.rejection.message).toContain('"req-multi" (Day or Night cover)');
  });
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm vitest run lib/proposal/operations.test.ts`
Expected: the new cases FAIL because the messages have no `Valid choices`. Every existing case still passes.

- [ ] **Step 7: Implement in `operations.ts`**

Add this import below the other `./` imports:

```ts
import {
  everyoneGroups,
  idLabel,
  meansEveryone,
  offeredChoices,
  peopleChoices,
  ruleChoices,
} from "./choices";
```

Add this helper under `firstUnofferedPerson`:

```ts
/**
 * The refusal for a person ref a rule's People picker does not offer.
 *
 * "Everyone" gets its own answer. These pickers never offer the synthetic ALL, and the
 * live failure was a model inventing names for "apply this to everyone". Naming a group
 * that already holds everyone, or else the people to list, is the one-retry fix.
 */
function rulePersonRefusal(
  state: ScenarioUiState,
  name: string,
  person: PersonRef,
  offered: readonly PickerOption[],
  index: number,
): OperationResult {
  if (meansEveryone(person)) {
    const groups = everyoneGroups(state);
    const how =
      groups.length > 0
        ? `Use the staff group ${groups.map(idLabel).join(" or ")}, which holds everyone`
        : "List each person, or add a staff group that holds everyone earlier in the same change";
    return reject(
      index,
      "unknown_target",
      `${name}: this rule cannot say "everyone" directly. ${how}. ${peopleChoices(state)}`,
    );
  }
  return reject(
    index,
    "unknown_target",
    `${name}: there is no person or staff group ${idLabel(person)}. Name each person, or an existing staff group. ${offeredChoices(offered)}`,
  );
}
```

In `successionRejection`, replace the person and shift branches:

```ts
  const people = successionPeopleOptions(state);
  const offeredPeople = [...people.items, ...people.groups];
  const person = firstUnofferedPerson(fields.people, offeredPeople, held);
  if (person !== undefined) return rulePersonRefusal(state, name, person, offeredPeople, index);
  const shifts = buildPatternShiftTypeOptions(state);
  const offeredShifts = [...shifts.items, ...shifts.groups];
  const shift = firstUnoffered(fields.pattern, offeredShifts);
  if (shift !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no shift or shift group ${idLabel(shift)}. ${offeredChoices(offeredShifts)}`,
    );
  }
```

In `countRejection`, make the same change with `countPeopleOptions(state)` and `buildCountShiftTypeTransferOptions(state)` / `fields.shiftTypes`.

In `requirementRejection`:

```ts
  const shifts = buildRequirementShiftTypeOptions(state);
  const offeredShifts = [...shifts.items, ...shifts.groups];
  if (firstUnoffered([fields.shiftType], offeredShifts) !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: "${fields.shiftType}" is not a shift or shift group that can be staffed. Use a shift code, or a group made only of shifts. ${offeredChoices(offeredShifts)}`,
    );
  }
  const people = buildQualifiedPeopleTransferOptions(state);
  const offeredPeople = [...people.items, ...people.groups];
  const person = firstUnoffered(fields.qualifiedPeople, offeredPeople);
  if (person !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no person or staff group ${idLabel(person)}. ${offeredChoices(offeredPeople)}`,
    );
  }
```

`"${fields.shiftType}"` is already an echo of the payload in today's message. Leave it as it is. The new list is document-only.

For every "not in this schedule any more" refusal, append `ruleChoices`:
- `applyEditSuccessionRule`: `` `That shift sequence rule is not in this schedule any more. ${ruleChoices(state, "successions")}` ``
- `applyEditCountRule`: `` `That shift count rule is not in this schedule any more. ${ruleChoices(state, "counts")}` ``
- `applyEditStaffingRequirement` and `applySetRequirementPeople`: `` `That staffing requirement is not in this schedule any more. ${ruleChoices(state, "requirements")}` ``
- `applyRemoveRule` and `applySetRuleEnabled`: `` `That ${RULE_LABEL[command.ruleKind]} is not in this schedule any more. ${ruleChoices(state, command.ruleKind)}` ``

- [ ] **Step 8: Run the proposal suite**

Run: `pnpm vitest run lib/proposal`
Expected: PASS, including `operations.parity.test.ts` and `react-free.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add web/lib/proposal/choices.ts web/lib/proposal/choices.test.ts web/lib/proposal/operations.ts web/lib/proposal/operations.test.ts
git commit -m "fix(assistant): rule refusals list the valid people, shifts and rule ids"
```

---

### Task 2: Choice lists for staff, leave, request and shift-group refusals (912, part 1 cont.)

**Files:**
- Modify: `web/lib/proposal/operations.ts` (`applyMoveLeave`, `applyAddShiftGroup`, `paintIntent`, `applyRequestPaint`, `unknownPersonMessage` and its two callers, `missingStaffGroup`, `missingMember`, `applyEditPeopleGroup`, `applyRemovePeopleGroup`)
- Test: `web/lib/proposal/operations.test.ts`

**Interfaces:**
- Consumes from Task 1: `choiceList`, `idLabel`, `peopleChoices`, `staffGroupChoices`, `staffRowChoices`, `shiftChoices`.
- Produces: `unknownPersonMessage(state: ScenarioUiState, personId: PersonRef): string`. The signature gains `state`. Only this file calls it.

- [ ] **Step 1: Write the failing tests**

In `describe("Staff-screen arms", ...)`, extend the existing remove test:

```ts
  it("refuses to remove someone who is not on the staff list", () => {
    const result = applyAssistantCommand(peopleScenario(), {
      type: "remove_person",
      personId: "zed",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("unknown_target");
    // A number stays a number, so "7" and 7 look different to the model.
    expect(result.rejection.message).toContain('Valid choices: "ana", "bo", 7.');
  });

  it("lists the staff groups when a group is unknown", () => {
    const result = applyAssistantCommand(peopleScenario(), {
      type: "remove_people_group",
      groupId: "Juniors",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Valid choices: "RN", "Seniors".');
  });

  it("lists the people when a group member is unknown", () => {
    const result = applyAssistantCommand(peopleScenario(), {
      type: "add_people_group",
      groupId: "Nights",
      description: "",
      members: ["zed"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Valid choices: "ana", "bo", 7.');
  });
```

In `describe("leave and request arms", ...)`:

```ts
  it("lists the people and staff groups when the row is unknown", () => {
    const result = applyAssistantCommand(octoberWard(), {
      type: "add_leave",
      personId: "Dana",
      startDate: "2026-10-05",
      endDate: "2026-10-05",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Valid choices: "Ana", "Ben", "Chris", "Seniors".');
  });

  it("lists the shifts it could request when the shift is unknown", () => {
    const result = applyAssistantCommand(octoberWard(), {
      type: "set_shift_request",
      personId: "Ben",
      shiftType: "Late",
      startDate: "2026-10-19",
      endDate: "2026-10-19",
      weight: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Valid choices: "D", "L", "N", "Nights", "ALL".');
  });
```

In `describe("add_shift_type / add_shift_group", ...)`:

```ts
  it("lists the shifts when a group member is unknown", () => {
    const result = applyAssistantCommand(proposalScenario(), group("Nights", ["N"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Valid choices: "Day", "Night".');
  });
```

In `describe("move_leave", ...)`:

```ts
  it("lists the people when the person is unknown", () => {
    const result = applyAssistantCommand(proposalScenario(), {
      type: "move_leave",
      personId: "zed",
      fromDate: "02",
      toDate: "03",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Valid choices: "ana", "bo".');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/proposal/operations.test.ts`
Expected: the new cases FAIL. Existing cases pass.

- [ ] **Step 3: Implement**

Extend the Task 1 import from `./choices` with `choiceList, shiftChoices, staffGroupChoices, staffRowChoices`.

- `applyMoveLeave`: `` reject(index, "unknown_target", `That person is not on this schedule. ${peopleChoices(state)}`) ``
- `applyAddShiftGroup`: `` `Shift group "${idCheck.id}": there is no shift ${idLabel(missing)}. Add the shift earlier in the same change, or use an existing code. ${shiftChoices(state)}` ``
- `paintIntent`, unknown shift: `` `There is no shift or shift group ${idLabel(shiftType)}. ${choiceList(selectable.map(idLabel))}` ``
- `applyRequestPaint`: `` `There is no person or staff group ${idLabel(command.personId)} on this schedule. ${staffRowChoices(state)}` ``
- `unknownPersonMessage`:

```ts
function unknownPersonMessage(state: ScenarioUiState, personId: PersonRef): string {
  return `Person ${idLabel(personId)}: not on the staff list. ${PERSON_ID_HINT} ${peopleChoices(state)}`;
}
```

  Update both callers: `unknownPersonMessage(state, command.personId)`.
- `missingStaffGroup`: leave the reserved-keyword branch as it is. That message already says what to do. On the general branch, append `` ` ${staffGroupChoices(state)}` `` after `...use an existing group name.`
- `missingMember`: append `` ` ${peopleChoices(state)}` `` after `${PERSON_ID_HINT}`.
- `applyEditPeopleGroup` and `applyRemovePeopleGroup`: `` `Staff group "${command.groupId}": there is no such staff group. ${staffGroupChoices(state)}` ``

- [ ] **Step 4: Run the proposal suite and the diagnostic suite that reuses rejections**

Run: `pnpm vitest run lib/proposal lib/ai/diagnostic`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/proposal/operations.ts web/lib/proposal/operations.test.ts
git commit -m "fix(assistant): staff, leave and request refusals list the valid ids"
```

---

### Task 3: Tell the model to read ids first, and to retry a listed correction once (912, part 2)

**Files:**
- Modify: `web/lib/ai/assistant/scenario-context.ts` (`ASSISTANT_AUTHORITY_STATEMENT`)
- Modify: `web/components/ai/use-context-tools.ts` (`get_schedule_section` description)
- Modify: `web/components/ai/use-proposal-tools.ts` (description, and the `rejected` answer)
- Test: `web/lib/ai/assistant/scenario-context.test.ts`, `web/components/ai/proposal-tool-boundary.test.tsx`

**Interfaces:**
- Consumes: the Task 1 and 2 refusal text (`Valid choices: …`, `and N more`).
- Produces: none in code. The retry wording (`prepare the change again, once`) is what Task 4's schema refusal mirrors.

- [ ] **Step 1: Write the failing tests**

In `scenario-context.test.ts`, inside `describe("the attached turn context", ...)`:

```ts
  it("tells the model to take ids from the schedule and never guess a name", () => {
    // 2026-09-24, plan assistant-self-correction: "apply a rule to everyone" made the
    // model invent names instead of reading the staff list.
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/get_schedule_section/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/never guess/i);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/valid ones/);
  });
```

In `proposal-tool-boundary.test.tsx`, inside `describe("the model's arguments, at the shipped tool boundary", ...)`:

```ts
  it("tells the model to take ids from the schedule before naming them", async () => {
    await mount();
    expect(proposalTool().description).toContain("get_schedule_section");
    expect(proposalTool().description).toMatch(/never guess/i);
  });

  it("hands an unknown id back with the valid choices, and allows one corrected retry", async () => {
    await mount(proposalScenario());

    const answer = String(
      await proposalTool().handler(
        { summary: "Remove Zed.", operations: [{ type: "remove_person", personId: "Zed" }] },
        {},
      ),
    );

    expect(answer).toContain("The app refused that change:");
    expect(answer).toContain('Valid choices: "ana", "bo".');
    expect(answer).toContain("prepare the change again, once");
    expect(answer).toContain("get_schedule_section");
    expect(await harness.db.assistantProposals.toArray()).toHaveLength(0);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/ai/assistant/scenario-context.test.ts components/ai/proposal-tool-boundary.test.tsx`
Expected: the three new cases FAIL.

- [ ] **Step 3: Implement**

In `ASSISTANT_AUTHORITY_STATEMENT`, insert after the "When the user asks for a change…" line:

```ts
  "Before proposing a change that names people, staff groups, shifts or rules, use their ids exactly as the schedule shows them, and call get_schedule_section (staff, shifts or rules) when unsure; never guess a name. If the app refuses an id and lists the valid ones, choose from that list or ask the user.",
```

In `use-context-tools.ts`, the `get_schedule_section` description becomes:

```ts
        "Read one section of the schedule in full. The complete schedule is already in your " +
        "context; call this to get the exact ids of people, staff groups, shifts or rules " +
        "before a change that names them, or to re-read a section after the user says they " +
        "changed something.",
```

In `use-proposal-tools.ts`, the description: after `"records and values. "`, add:

```ts
        "Take every person, staff group, shift and rule id exactly from the schedule " +
        "(get_schedule_section) — never guess one. " +
```

Keep the existing `"If anything is ambiguous, ask first — never guess a date, …"` sentence. Replace the `rejected` answer:

```ts
          if (outcome.reason === "rejected") {
            // ONE CORRECTED RETRY, NOT A LOOP (2026-09-24, nursing-sheduler-912). A refusal
            // that lists the valid ids is exactly the evidence the model lacked. Retrying
            // with one of them is a correction, not an approximation. Anything else still
            // goes back to the user.
            return (
              `The app refused that change: ${outcome.rejection.message} ` +
              "If the refusal lists the valid choices or names the right format, and what the " +
              "user asked for clearly matches one of them, correct that operation and prepare " +
              "the change again, once. When the list is cut short, read the full list with " +
              "get_schedule_section. Otherwise explain this to the user in your own words and " +
              "ask for what is missing. Do not try a different operation that only " +
              "approximates what they asked for."
            );
          }
```

Update the file-header comment line "retrying a rejected operation is exactly the loop the closed flows forbid". Add: "a single correction to a value the refusal itself lists is not that loop".

- [ ] **Step 4: Run the assistant suites, including the locked ones**

Run: `pnpm vitest run lib/ai components/ai`
Expected: PASS. `phase-2-absence.test.ts` and `model-visible-tools.test.ts` need no change, because no tool name, arm or schema shape changed here. If either fails, change it only with a `CHANGED DELIBERATELY (2026-09-24, plan assistant-self-correction)` comment that gives the reason.

- [ ] **Step 5: Commit**

```bash
git add web/lib/ai/assistant/scenario-context.ts web/lib/ai/assistant/scenario-context.test.ts web/components/ai/use-context-tools.ts web/components/ai/use-proposal-tools.ts web/components/ai/proposal-tool-boundary.test.tsx
git commit -m "fix(assistant): read ids before proposing; retry once on a listed correction"
```

---

### Task 4: Schema refusals say what each field expected (b1a, part 1)

**Files:**
- Modify: `web/components/ai/tool-payload.ts`
- Create: `web/components/ai/tool-payload.test.ts`
- Modify (locked): `web/components/ai/tool-payload-boundary.test.tsx`

**Interfaces:**
- Produces: `malformedPayloadRefusal(error: z.ZodError): string` keeps its signature. `parseToolPayload` is unchanged.
- Refusal shape: `Those arguments are not a valid call to this tool (fix: <path>: <expectation>; …). Nothing was read, changed or opened. If you can see how to correct it from what the user already said, call this tool again once with the corrected arguments. Otherwise tell the user you could not do that and ask them for what is missing. Never use a different tool to approximate it.`

zod 4.4.3 issue shapes, checked against the installed package:
- `invalid_type {expected}`: the default message says `received undefined`, so it is not used.
- `invalid_value {values}`
- `invalid_format {format:"regex", message}`: the message is ours, for example `a date must be written YYYY-MM-DD`.
- `too_big {maximum, origin}` / `too_small {minimum, origin}`
- `unrecognized_keys {keys}`: the keys are the model's own, so they are not used.
- `invalid_union {note:"No matching discriminator"}`, with a path ending in `type`.

- [ ] **Step 1: Write the failing unit tests**

`web/components/ai/tool-payload.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseToolPayload } from "./tool-payload";

const schema = z.object({
  operations: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          type: z.enum(["add_shift_type"]),
          startTime: z.string().regex(/^\d{2}:\d{2}$/, "a time must be written HH:MM, e.g. 08:00"),
          restMinutes: z.number(),
        }),
        z.strictObject({ type: z.enum(["remove_rule"]), ruleKind: z.enum(["counts", "requirements"]) }),
      ]),
    )
    .max(2),
});

function refusal(raw: unknown): string {
  const result = parseToolPayload(schema, raw);
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal;
}

describe("the schema refusal", () => {
  it("names the field and the expected format, and invites one corrected call", () => {
    const text = refusal({ operations: [{ type: "add_shift_type", startTime: "0800", restMinutes: 0 }] });
    expect(text).toContain("not a valid call to this tool");
    expect(text).toContain("operations.0.startTime: a time must be written HH:MM, e.g. 08:00");
    expect(text).toContain("call this tool again once");
    expect(text).not.toContain("0800");
  });

  it("says the limit and to split when there are too many operations", () => {
    const op = { type: "remove_rule", ruleKind: "counts" };
    expect(refusal({ operations: [op, op, op] })).toContain("operations: at most 2 items");
  });

  it("names the allowed values of an enum", () => {
    const text = refusal({ operations: [{ type: "remove_rule", ruleKind: "payroll" }] });
    expect(text).toContain('operations.0.ruleKind: must be one of "counts", "requirements"');
    expect(text).not.toContain("payroll");
  });

  it("never says 'undefined' for a missing field, and never echoes an unknown key", () => {
    const missing = refusal({});
    expect(missing).toContain("operations: expected array");
    expect(missing).not.toContain("undefined");
    const extra = refusal({
      operations: [{ type: "remove_rule", ruleKind: "counts", secretField: 1 }],
    });
    expect(extra).toContain("remove the fields this does not take");
    expect(extra).not.toContain("secretField");
  });

  it("says an unknown operation type is not one of the supported forms", () => {
    const text = refusal({ operations: [{ type: "replace_everything" }] });
    expect(text).toContain("operations.0.type:");
    expect(text).not.toContain("replace_everything");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run components/ai/tool-payload.test.ts`
Expected: FAIL. Today's refusal has `(check: …)` and no expectations.

- [ ] **Step 3: Implement in `tool-payload.ts`**

Replace `namedFields` and `malformedPayloadRefusal`. Keep `NAMED_FIELD_LIMIT`, `MAX_SEGMENT_LENGTH` and `parseToolPayload`:

```ts
/** Longest schema-authored format message worth repeating. */
const MAX_FORMAT_MESSAGE = 120;

/** How many allowed enum values a hint lists. */
const LISTED_VALUES = 10;

type Issue = z.ZodError["issues"][number];

/** A declared field path, or `arguments` for the payload as a whole. */
function fieldPath(issue: Issue): string {
  const path = issue.path
    .filter(
      (segment): segment is string | number =>
        typeof segment === "number" ||
        (typeof segment === "string" && segment.length <= MAX_SEGMENT_LENGTH),
    )
    .join(".");
  return path.length > 0 ? path : "arguments";
}

function unit(origin: string): string {
  if (origin === "array") return " items";
  if (origin === "string") return " characters";
  return "";
}

/**
 * What the schema expected, in words taken from the SCHEMA only.
 *
 * Zod's default messages are not used. They name the received type ("received
 * undefined") and quote unrecognised keys, and both are the payload talking. The one
 * exception is `invalid_format`: every regex in the shipped schemas carries a message
 * this repo wrote (e.g. "a date must be written YYYY-MM-DD"), and that is exactly the
 * correction the model needs.
 */
function expectation(issue: Issue): string {
  switch (issue.code) {
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "invalid_value":
      return `must be one of ${issue.values
        .slice(0, LISTED_VALUES)
        .map((value) => JSON.stringify(value))
        .join(", ")}`;
    case "invalid_format":
      return issue.message.slice(0, MAX_FORMAT_MESSAGE);
    case "too_big":
      return (
        `at most ${String(issue.maximum)}${unit(issue.origin)}` +
        (issue.origin === "array" ? " -- split the rest into another call" : "")
      );
    case "too_small":
      return `at least ${String(issue.minimum)}${unit(issue.origin)}`;
    case "unrecognized_keys":
      return "remove the fields this does not take";
    case "invalid_union":
      return "is not one of the supported forms; use one the tool lists";
    default:
      return "is not valid";
  }
}

/** One `path: expectation` per distinct problem, bounded. */
function fixes(error: z.ZodError): string[] {
  const seen = new Set<string>();
  for (const issue of error.issues) seen.add(`${fieldPath(issue)}: ${expectation(issue)}`);
  return [...seen].slice(0, NAMED_FIELD_LIMIT);
}

/**
 * The ONE thing every handler says about a payload it cannot accept.
 *
 * A REFUSAL IS A TOOL RESULT, NOT A THROW. A thrown handler is converted by the locked
 * core into `Error: <message>` and fed back as the tool result anyway -- so throwing
 * neither stops the turn nor hides anything, it just makes an internal message the
 * model's evidence.
 *
 * ONE CORRECTED RETRY (2026-09-24, nursing-sheduler-b1a). This used to say "do not
 * retry", so a model that wrote 0800 for 08:00, or sent 26 operations, told the user it
 * had failed at something it could fix itself. Naming the expected form makes the
 * correction a certainty rather than a guess, so one retry is allowed and the rest
 * still goes back to the user.
 *
 * Bounded on purpose: declared field paths and schema-derived expectations only. No
 * values, no arguments, no transcript text, no model output, no provider detail, no
 * key, no raw error.
 */
export function malformedPayloadRefusal(error: z.ZodError): string {
  const list = fixes(error);
  return (
    "Those arguments are not a valid call to this tool" +
    (list.length > 0 ? ` (fix: ${list.join("; ")})` : "") +
    ". Nothing was read, changed or opened. If you can see how to correct it from what " +
    "the user already said, call this tool again once with the corrected arguments. " +
    "Otherwise tell the user you could not do that and ask them for what is missing. " +
    "Never use a different tool to approximate it."
  );
}
```

If `issue.origin` does not typecheck on `too_big` / `too_small` (it is a string union in zod 4), keep `unit(origin: string)` as it is. Update the "Zod's messages are deliberately not used" line in the file header to point at `expectation`.

- [ ] **Step 4: Run the unit test**

Run: `pnpm vitest run components/ai/tool-payload.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a deliberate case to the locked boundary test**

In `tool-payload-boundary.test.tsx`, add inside `describe("malformed payloads, for every parameterized tool in the registry", ...)`, after the loop:

```ts
  // CHANGED DELIBERATELY (2026-09-24, plan assistant-self-correction): the shared refusal
  // now names what each field expected and allows ONE corrected retry, so a model that
  // wrote a date or a time in the wrong form can fix it itself. `expectBoundedRefusal`
  // above still pins the non-echoing, no-effect half.
  it("names the expected form and invites one corrected call, still echoing nothing", async () => {
    const result = await callTool("get_schedule_section", '{"domain":"payroll"}');
    expectBoundedRefusal(result, ["payroll"]);
    expect(result).toContain('domain: must be one of "dates", "staff", "shifts", "rules", "requests"');
    expect(result).toContain("call this tool again once");
    expect(result).not.toContain("Do not retry");
  });
```

- [ ] **Step 6: Run the whole AI component suite**

Run: `pnpm vitest run components/ai lib/ai`
Expected: PASS. Every existing `expectBoundedRefusal` case still holds: the text keeps both required phrases and contains no `undefined` or `Error:`.

- [ ] **Step 7: Commit**

```bash
git add web/components/ai/tool-payload.ts web/components/ai/tool-payload.test.ts web/components/ai/tool-payload-boundary.test.tsx
git commit -m "fix(assistant): schema refusals name the expected form and allow one retry"
```

---

### Task 5: Clock fields checked by the host, so the refusal names the shift (b1a, part 2)

**Files:**
- Modify: `web/lib/proposal/commands.ts:321-324` (`clockSchema`) and the two `startTime` / `endTime` uses
- Modify: `web/lib/proposal/operations.ts` (`applyAddShiftType`)
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`

**Interfaces:**
- Consumes: `validateWorkingTimeDraft` and `paidMinutesFor` (both already imported in `operations.ts`). A malformed clock makes `paidMinutesFor` return `null`, and `validateWorkingTimeDraft` returns `Clock time must be on the 30-minute grid, e.g. '09:00' or '13:30'.`
- Produces: the wire type of `add_shift_type.startTime` / `endTime` stays `string`. `AssistantCommandV1` is unchanged.

- [ ] **Step 1: Write the failing tests**

In `operations.test.ts`, inside `describe("add_shift_type / add_shift_group", ...)`:

```ts
  it("refuses a time not written HH:MM, naming the shift and an example", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("am1", "0800", "15:00"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid_value");
    expect(result.rejection.message).toContain('Shift "am1"');
    expect(result.rejection.message).toContain("09:00");
  });

  it("refuses a blank time rather than creating a shift with no hours", () => {
    for (const [start, end] of [["", "15:00"], ["08:00", "  "]]) {
      const result = applyAssistantCommand(proposalScenario(), shift("am1", start, end));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.message).toContain("needs both a start and an end time");
    }
  });
```

In `commands.test.ts`, in `"refuses shift-setup payloads the model must fix itself"`, delete the `// Time not converted to HH:MM.` entry, then add:

```ts
  it("leaves the clock format to the host, so its refusal can name the shift", () => {
    // CHANGED DELIBERATELY (2026-09-24, plan assistant-self-correction): "0800" used to be
    // a schema refusal the model was told not to retry. It now reaches `applyAddShiftType`,
    // whose refusal names the shift and gives an example (operations.test.ts).
    const result = parseAssistantCommands([
      { type: "add_shift_type", code: "am1", name: "", startTime: "0800", endTime: "15:00", restMinutes: 0 },
    ]);
    expect(result.ok).toBe(true);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: the new `commands.test.ts` case FAILS (the schema still refuses `0800`). The blank-time case FAILS (a blank time is accepted today as "no hours"). The `0800` operations case can already pass. That is correct: it pins behaviour that is now reachable.

- [ ] **Step 3: Implement**

In `commands.ts`, replace `clockSchema`:

```ts
/**
 * A clock is a plain string on the wire. The format, the 30-minute grid and the span
 * rules are all the Shifts page's (`validateWorkingTimeDraft`, applied in
 * `operations.ts`), whose refusal names the shift and gives an example. A regex here
 * refused "0800" before the host could say which shift it was.
 */
const clockSchema = z.string();
```

Keep both `.describe(...)` texts on `startTime` / `endTime` unchanged. They already say `HH:MM` and `0800 -> 08:00`.

In `operations.ts` `applyAddShiftType`, after the numbers-only code check and before `restMinutes`:

```ts
  // With the wire regex gone, a blank clock would read as "no working time" to the
  // validator (it treats blanks as absent). This arm always states hours, so refuse.
  if (!command.startTime.trim() || !command.endTime.trim()) {
    return reject(
      index,
      "invalid_value",
      `Shift "${idCheck.id}": needs both a start and an end time, written HH:MM, e.g. 08:00.`,
    );
  }
```

- [ ] **Step 4: Run the proposal suite and the wire-conversion lock**

Run: `pnpm vitest run lib/proposal lib/ai/runtime/model-visible-tools.test.ts components/ai`
Expected: PASS. `model-visible-tools.test.ts` asserts arm names and conversion, not a `pattern`, so it needs no change. If it does, change it deliberately with a dated reason.

- [ ] **Step 5: Commit**

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.ts web/lib/proposal/operations.test.ts
git commit -m "fix(assistant): host checks shift clock format so the refusal names the shift"
```

---

### Task 6: Staffing wording says exact counts, and skill mix is a twin shift (ao3)

**Files:**
- Modify: `web/components/guided-rules/mappers.ts:65-69` (`requirementsMapper.summary`)
- Test: `web/components/guided-rules/mappers.test.ts`
- Modify: `web/components/ai/use-help-tools.ts:59`, `web/components/shell/nav-config.ts:166`, `web/components/home/home-guided.tsx:84`
- Modify: `web/lib/capability/help-content.ts:124-128` (staffing `nurseFacingSummary`), then regenerate `web/lib/capability/registry.generated.ts`
- Modify: `web/lib/capability/guidance.test.ts:20-24`
- Modify: `docs/superpowers/plans/2026-09-24-assistant-rule-ops.md:15`

**Interfaces:** none. Text only, plus one pure summary function.

- [ ] **Step 1: Write the failing mapper tests**

In `mappers.test.ts`, inside `describe("requirementsMapper", ...)` (the `supported` fixture is `D`, 2 people, no dates):

```ts
  it("summarises an exact head count, not a minimum", () => {
    expect(requirementsMapper.summary(supported)).toBe("Exactly 2 people on D on every date.");
    expect(requirementsMapper.summary({ ...supported, requiredNumPeople: 1 })).toBe(
      "Exactly 1 person on D on every date.",
    );
  });

  it("summarises a preferred count as a range", () => {
    expect(requirementsMapper.summary({ ...supported, preferredNumPeople: 3 })).toBe(
      "Between 2 and 3 people on D on every date.",
    );
  });

  it("says who may work it when qualified people are named, and nothing for ALL", () => {
    expect(requirementsMapper.summary({ ...supported, qualifiedPeople: ["RN"] })).toBe(
      "Exactly 2 people on D on every date. Only RN may work it.",
    );
    expect(requirementsMapper.summary({ ...supported, qualifiedPeople: ["ALL"] })).toBe(
      "Exactly 2 people on D on every date.",
    );
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run components/guided-rules/mappers.test.ts`
Expected: FAIL. Today's summary is `Needs 2 people for D on every date.`

- [ ] **Step 3: Implement the summary**

In `mappers.ts`, add `RESERVED_SHIFT_TYPE` to the `@/lib/scenario` import. When the file has no such import, add one. Replace `summary`:

```ts
  summary(card) {
    const shiftLabel = summarizeRequirementRefs(card.shiftType);
    const dateLabel = card.date === undefined ? "every date" : summarizeRequirementRefs(card.date);
    // EXACT unless a preferred count exists: the solver pins `required` with `==`, and
    // with a preferred count it becomes the floor of a range (preference_types.py:185-193).
    const n = card.requiredNumPeople;
    const count =
      card.preferredNumPeople !== undefined && card.preferredNumPeople !== n
        ? `Between ${n} and ${card.preferredNumPeople} people`
        : `Exactly ${n === 1 ? "1 person" : `${n} people`}`;
    // Naming qualified people BANS everyone else from the shift, so say so.
    const qualified = [card.qualifiedPeople ?? []].flat();
    const only =
      qualified.length > 0 && !qualified.includes(RESERVED_SHIFT_TYPE.all)
        ? ` Only ${summarizeRequirementRefs(qualified)} may work it.`
        : "";
    return `${count} on ${shiftLabel} on ${dateLabel}.${only}`;
  },
```

Run: `pnpm vitest run components/guided-rules`
Expected: PASS. If a Guided screen test asserts the old `Needs …` text, update it to the new sentence.

- [ ] **Step 4: Fix the remaining text**

- `use-help-tools.ts:59`: `"'no day shift straight after a night shift' or 'three nurses on every night shift'."`
- `nav-config.ts:166`: `blurb: "Nurses per shift & who may work it",`
- `home-guided.tsx:84`: `desc: "Pick plain-English rules for staffing levels and shift patterns.",`
- `help-content.ts`, staffing `nurseFacingSummary`. Keep the word `skill-mix`, which `commands.test.ts:44` asserts:

```ts
    nurseFacingSummary:
      "How many people a shift needs: exactly that number, or a range when a preferred number " +
      "is set. Naming who is qualified means nobody else may work that shift at all. A skill " +
      "mix, such as one senior on every night, is set up as its own twin shift (for example " +
      "N+ beside N) with its own requirement naming who is qualified. The assistant cannot " +
      "set up a skill-mix rule yet; explain this and point the user to the Shift types and " +
      "Staffing requirements screens.",
```

  Leave `concepts` as they are. `minimum staffing` is how users phrase it, and `guidance.ts` matches on it.
- `guidance.test.ts:20-24`:

```ts
  it("matches staffing requirements for a head-count policy", () => {
    const result = suggestRuleCandidates("exactly three people on every night shift", context());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.map((c) => c.capabilityId)).toContain("staffing-requirements");
  });
```

- `docs/superpowers/plans/2026-09-24-assistant-rule-ops.md:15`: at the end of the skill-mix bullet, append: ` (Later finding, 2026-09-24: the ward expresses skill mix with a reserved twin shift such as \`night+\` plus its own requirement; see \`core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml\`.)`

- [ ] **Step 5: Regenerate the capability manifest and run the affected suites**

Run: `pnpm capability:generate && pnpm vitest run lib/capability lib/proposal/commands.test.ts components/shell components/home components/guided-rules`
Expected: `registry.generated.ts` is rewritten, and all suites PASS. Check with `git diff --stat web/lib/capability/registry.generated.ts` that only the hash and length fields moved.

- [ ] **Step 6: Full gates**

Run: `pnpm typecheck && pnpm exec oxlint && pnpm exec ast-grep scan && pnpm vitest run`
Expected: all green. If `grep -rn "Needs [0-9]\|Min nurses\|two seniors on every night" web --include='*.ts*' | grep -v node_modules` finds anything, fix it.

- [ ] **Step 7: Commit**

```bash
git add web/components/guided-rules/mappers.ts web/components/guided-rules/mappers.test.ts web/components/ai/use-help-tools.ts web/components/shell/nav-config.ts web/components/home/home-guided.tsx web/lib/capability/help-content.ts web/lib/capability/registry.generated.ts web/lib/capability/guidance.test.ts docs/superpowers/plans/2026-09-24-assistant-rule-ops.md
git commit -m "fix(rules): staffing text says exact counts; skill mix is a twin shift"
```

---

## Decisions

- **"Everyone" on succession and count rules is refused with a way forward. It is not mapped to `ALL`.** Those pickers never offer the synthetic `ALL`. See `buildPeopleTransferOptions` in `successions-model.ts` and `counts-model.ts`. `rulePeopleSchema` already tells the model so. To accept it is to let the assistant author something the manual screen cannot. That breaks the parity rule in the `operations.ts` header. The refusal names an authored staff group that holds everyone. When no such group exists, it lists every person. Requirements already offer `["ALL"]`, so that arm needs no special case.
- **Choice lists live in operation messages. Tool names live only in the model wrapper.** `CommandRejection.message` is nurse-facing, including the Apply-time repository error, so it says `and N more` and nothing about tools. `use-proposal-tools.ts` adds "read the full list with get_schedule_section".
- **One corrected retry, enforced by wording only.** It is the same approach as every other model rule here. A host retry counter needs per-turn state across tool calls, for a loop no one has seen. When a live run loops, add one.
- **Schema hints come from issue fields, not zod messages.** The exception is `invalid_format`, whose messages are ours. This keeps the boundary test's non-echo guarantee: no `received undefined`, no unrecognised key names, no values.
- **The clock regex is removed from the wire schema.** Host validation gives a better refusal. It names the shift and gives an example. The model-facing `.describe` text already states the format.
- **Help `concepts` keep "minimum staffing".** They are matching keywords in the user's words, not claims about solver behaviour.
- **A new file `choices.ts` rather than more lines in the 1,460-line `operations.ts`.** It is pure and unit-testable on its own.

## Open questions

1. **Do we drop "use this only to re-read" from the `get_schedule_section` description?** This can add one read call per turn that names people. *Recommendation:* yes (Task 3). One cheap read is better than three guessed names and a user round trip.
2. **Does a staffing requirement's `qualifiedPeople` accept "everyone"/"Everyone" as an alias for `ALL`?** *Recommendation:* no. The refusal already lists `"ALL"` among the valid choices, and the model will pick it on retry. An alias is a second spelling to maintain.
3. **Does `LISTED_CHOICES` scale with message length instead of count, given long rule titles?** *Recommendation:* no. 20 items is readable, and titles are short in practice. When a real ward shows a problem, revisit.
4. **Do we edit the rule-ops plan doc (historical) at all?** *Recommendation:* yes, one appended parenthetical as in Task 6, because the bead names it. Do not rewrite the original reasoning.
5. **Do we now let the assistant create skill-mix twin shifts (add `N+` plus a qualified requirement)?** *Recommendation:* not in this plan. The playbook forbids creating skill-mix rules, and changing that is a product decision with its own safety review (`repair-options.ts` safety floor).

## Assumptions

- Every rule card type carries an optional `description`. `ruleChoices` reads it structurally, so a type without one still compiles.
- zod 4.4.3 issue shapes are as probed: `invalid_type.expected`, `invalid_value.values`, `too_big.maximum/origin`, `too_small.minimum/origin`, `unrecognized_keys.keys`, `invalid_union` at the discriminator path.
- `proposal-tool-boundary.test.tsx`'s captured handler goes through `parseToolPayload`, as its existing "not a valid call" case shows. So a well-formed `remove_person` reaches the host rejection path.
- `guidance.ts` ranks `staffing-requirements` in the top 4 for "exactly three people on every night shift" (shared terms: exactly, people, night, shift). If not, pick a phrase from the new summary text. Do not add concepts just to pass the test.
- No e2e spec asserts the old nav blurb, home description or Guided `Needs …` summary (grep found none).
- The model already receives the full scenario in context (`buildAssistantContext`). The fix targets the model not using it, not missing data.
