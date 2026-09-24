# Assistant: Rule Operations (requirements, sequences, counts, remove) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app assistant propose new rules and edits to existing rules for the three most used rule families: staffing requirements, shift sequences and shift counts. It can also propose to delete a rule of any family. Every change goes through `prepare_scenario_change` → Preview → the user's Apply, and runs the same save functions and validators as the rule editor screens.

**Architecture:** Add seven arms to the command union in `web/lib/proposal/commands.ts`: `add_/edit_succession_rule`, `add_/edit_count_rule`, `add_/edit_staffing_requirement`, and `remove_rule`. In `web/lib/proposal/operations.ts` each arm fills the editor's own flat form draft (`SuccessionFormState`, `CountFormState`, `RequirementFormState`). It then runs that editor's own validator (`validateSuccessionForm`, `validateCountForm`, `validateRequirementForm`) and builder (`buildSuccessionCard`, `buildCountCard`, `applyRequirementPatch`). Refs are checked against the pickers' own option builders, because a person can only pick what a picker offers. Those model files are React-free except for three value imports from `"use client"` field files. Task 1 moves those pure helpers into sibling `.ts` files, so `lib/proposal` can import the models and still pull in no React. A new test enforces this. The Preview renders the three families as plain sentences.

**Tech Stack:** Next.js 16 (`web/`), TypeScript, zod v4, vitest 4, CopilotKit 1.66.2 (tool schema transport), oxlint, ast-grep.

**Spec:** `docs/ai-assistant.md`, section "Product decision (2026-09-23)", and the rule-ops brief of 2026-09-24. The brief requires that these examples can be expressed and are tested:

- "no day shift straight after a night shift" → `add_succession_rule` (Task 2)
- "at most 5 night shifts per nurse per month" → `add_count_rule` (Task 3)
- "at least 2 RNs on every night shift" and "every day needs at least one senior nurse on" are "at least k from a group" skill-mix rules. A single `add_staffing_requirement` does NOT express them (`qualifiedPeople` bans everyone outside the named group from the shift, rather than reserving k slots within a larger shift); see follow-up bead for skill mix (nursing-sheduler-2ti). (Later finding, 2026-09-24: the ward expresses skill mix with a reserved twin shift such as `night+` plus its own requirement; see `core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml`.)
- `"Ana and Ben should not work the same night"` → affinity. **Out of scope** here. It goes to the follow-up plan (see Follow-ups).

**Scope decision:** Five families take more than 8 tasks, so this plan covers staffing requirements, successions and counts for create and edit. Those are the three that the brief's examples use most and that `help-content.ts` names as the main rule records. Remove is here for **all five** families, because the UI's delete is the same filter-by-uid in every editor (`current.filter((card) => card.uid !== uid)` in each `use-*.ts`). One arm for all five kinds costs one function. Affinities and coverings, create and edit, are the follow-up plan `2026-09-2x-assistant-rule-ops-affinities-coverings`.

**Arm design (decided):** One arm per family per action. There is no shared rule-card save path. Each editor has its own form state, validator and builder (checked in `use-successions.ts`, `use-counts.ts` and `use-requirements.ts`). A mega-arm needs optional per-family fields, and those are forbidden. Edit arms **replace every field the arm carries** (all fields required). The model reads the current values from context and sends them back with its change. Fields the arm does not carry keep their stored values, because the draft starts from the editor's own `*ToForm(card)` loader: requirement `preferredNumPeople`/`weight`/coefficients, count coefficients, and the `disabled`/`applied` markers. That is the manual Edit flow: the loader fills the form, the user changes some fields, and Save rebuilds the card.

**Weight is text, typed as on the Weight box.** JSON cannot carry `Infinity`, but a hard rule is `±Infinity`. The Weight box is a text input parsed by `parseWeightInput` (`"infinity"`, `"-infinity"`, `"-50"`, `"1k"`, ...). The arms take `weight: string`, and the host runs the same `parseWeightInput` and the same validator, so parity holds at the keystroke level.

## Global Constraints

- The only assistant mutation path is `prepare_scenario_change`. The user approves the change in the Preview, and only the host applies.
- Every arm field is required: no `.optional()` or `.nullable()` (`model-visible-tools.test.ts` asserts that the advertised properties equal `required`).
- Each discriminant is a one-member `z.enum([...])`, not `z.literal` (comment in `commands.ts` above `assistantCommandSchema`).
- New arms go at the END of both `AssistantCommandV1`/`ASSISTANT_COMMAND_TYPES` and the zod union, in this order: `add_succession_rule`, `edit_succession_rule`, `add_count_rule`, `edit_count_rule`, `add_staffing_requirement`, `edit_staffing_requirement`, `remove_rule`. The wire test compares ordered lists.
- Field schemas that more than one arm uses are built by a function call per arm (for example `successionFields()`), never shared instances. This keeps each arm's JSON Schema inline.
- `lib/proposal` imports no React. After Task 1, `web/lib/proposal/react-free.test.ts` enforces this. Do not import any `.tsx` file, `use-*.ts` hook, `commit-cards.ts` or `components/guided-rules/*` from `lib/proposal`. `import type` from a `.tsx` is allowed, because it is erased.
- Validation is reused, never copied: the editors' own `validate*Form`, `build*Card`/`applyRequirementPatch`, `parseWeightInput`, and the pickers' `build*Options`/`buildDateScope*` builders. The only restated logic is the 4-line `disabled`/`applied` carry-forward that `use-successions.ts`/`use-counts.ts` `update` apply (Task 6 pins it).
- A rejection message starts with the rule's name: `Shift sequence rule "<title>": `, `Shift count rule "<title>": ` or `Staffing requirement "<title>": `. For an empty title it starts with `The new <label>: `. Validator messages are the editor's own verbatim text followed by `.`.
- New rule uids are deterministic, `proposalDigest([kind, liveUidsOfKind, command])`. Apply re-derives the document (`repository.ts` calls `applyAssistantCommands` again), so the card that Apply writes is the card that the Preview showed.
- Dates: exactly one scope chip id, or one or more in-range ISO dates `YYYY-MM-DD`. A scope chip id is `ALL`, `WEEKDAY`, `WEEKEND`, `MONDAY`…`SUNDAY`, or an authored date group id. This is what `DateScopeField` can emit. Card-editor dates are full ISO (`DateScopeItem.id`), not the request-matrix `DD` ids.
- People for sequences and counts: person ids and staff group ids only. Those pickers offer no `ALL` (`buildPeopleTransferOptions`), so the assistant does not either. Requirements' qualified people also accept `ALL` (`buildQualifiedPeopleTransferOptions`).
- Tests: `cd web && pnpm vitest run <path>`. Gates: `pnpm typecheck`, and lint as `pnpm lint:oxlint && pnpm lint:ast-grep` (the script `lint` is `oxlint && ast-grep scan`). Do not run `pnpm install` or `pnpm build`.
- `test_feasibility_candidates` embeds the same union and so accepts the new arms. This is harmless: a diagnostic candidate is a copied schedule.
- The repo default is "do not commit unless asked". A commit step needs commit authority in the session.

## Review Focus

1. **Editing a hard rule.** The model sees hard weights as `.inf`/`-.inf` in context. It sees them as `null` from `get_schedule_section`, because `JSON.stringify(Infinity)` gives `null`. If it sends `".inf"` as the weight, it must get a refusal that names the rule and says what the Weight box accepts. It must not get a silently softened rule. (Test: Task 2, `refuses a weight the Weight box would not accept`.)
2. **Dates written as roster-day ids.** The request matrix uses `"02"`. If the model sends that for a rule, it must get a refusal that says to write `YYYY-MM-DD`. The same request with `"2026-04-02"` must work. (Test: Task 2, `refuses a matrix day id and accepts the ISO date`.)
3. **"Every nurse" on a sequence or count.** The model can send `people: ["ALL"]`. The host must refuse it with a message that tells the model to name each person or a staff group. The screen offers no `ALL`. (Test: Task 2, `refuses ALL as people, naming it`.)
4. **The same rule twice in one change.** The two cards get different uids, and both appear as asked-for rows in the Preview. A second run of the same batch gives the same uids. (Tests: Task 2, `gives two identical new rules different ids, the same on every run`. Task 7, `lists every new rule as asked-for`.)
5. **Edits must not lose what the arm cannot see.** An edit must keep a switched-off rule switched off. It must keep count coefficients, and a requirement's preferred count and weight. An edit that changes nothing must be refused. (Tests: Task 2 `edit keeps the rule off`, Task 3 `edit keeps coefficients and the off marker`, Task 4 `edit keeps the preferred count and its weight`, Task 2 `refuses an edit that changes nothing`.)

---

## File Structure

- Create `web/components/card-editor/weight-value.ts`, `coefficient-model.ts` and `expression-model.ts`. Each holds the pure half of its field file, moved verbatim.
- Modify `web/components/card-editor/weight-field.tsx`, `coefficient-fields.tsx` and `expression-field.tsx`: delete the moved code, then import it back and re-export it (no importer changes).
- Modify `web/components/{requirements/requirements-model,successions/successions-model,counts/counts-model}.ts`: point the three value imports at the new `.ts` files.
- Modify `web/components/requirements/requirement-patch.ts`: the `add` patch takes an optional `uid` (the UI passes none, so its behaviour does not change).
- Create `web/lib/proposal/react-free.test.ts`: the guard test.
- Modify `web/lib/proposal/commands.ts` (7 arms), `operations.ts` (rule helpers and 7 transforms), and `diff.ts` (plain-sentence rule rendering, and `directKeys` for new or edited rules).
- Modify `web/lib/proposal/test-support.ts`: add the `ruleWardScenario()` fixture.
- Modify `web/lib/capability/help-content.ts`, then regenerate `registry.generated.ts`.
- Tests: `commands.test.ts`, `operations.test.ts`, `operations.parity.test.ts`, `diff.test.ts`, `web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`.

---

### Task 1: Make the rule models React-free (the guard test first)

`operations.ts`'s header explains why rule arms used to restate predicates: the models reach `"use client"` field files. The only runtime imports that reach React are `isValidWeightValue`/`isWeightNonPositive` (weight-field), the coefficient helpers (coefficient-fields) and the expression helpers (expression-field). Moving those pure functions out, unchanged, lets `lib/proposal` call the real validators.

**Files:**
- Create: `web/lib/proposal/react-free.test.ts`
- Create: `web/components/card-editor/weight-value.ts`, `web/components/card-editor/coefficient-model.ts`, `web/components/card-editor/expression-model.ts`
- Modify: `web/components/card-editor/weight-field.tsx:23-73`, `web/components/card-editor/coefficient-fields.tsx:24-216`, `web/components/card-editor/expression-field.tsx:17-93`
- Modify: `web/components/requirements/requirements-model.ts:35-45`, `web/components/successions/successions-model.ts:22-24`, `web/components/counts/counts-model.ts:34-52`

**Interfaces:**
- Consumes: nothing new.
- Produces: `@/components/card-editor/weight-value` exports `WeightFieldValue`, `parseWeightInput`, `isValidWeightValue`, `isWeightNonPositive` and `formatWeight`. `@/components/card-editor/coefficient-model` exports every coefficient type and function listed in Step 4. `@/components/card-editor/expression-model` exports `ExpressionOp`, `EXPRESSION_OPS`, `SUPPORTED_EXPRESSIONS`, `isSupportedExpression`, `isSquaredExpression`, `substituteTarget`, `ExpressionTargetValue` and `ExpressionFieldValue`. The three rule models and `requirement-patch.ts` load with no React.

- [ ] **Step 1: Write the guard test**

Create `web/lib/proposal/react-free.test.ts`:

```ts
// lib/proposal MUST NOT REACH REACT. The durable repository and the diagnostic
// orchestrator import it (see the header of `operations.ts`), so a React import
// anywhere in these graphs drags the component tree into the scenario path. Each
// mocked specifier throws on load, so any module that reaches React fails its import
// here, whether it is a direct or a transitive import.

import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => {
  throw new Error("React was imported");
});
vi.mock("react/jsx-runtime", () => {
  throw new Error("React was imported");
});
vi.mock("react/jsx-dev-runtime", () => {
  throw new Error("React was imported");
});

describe("the assistant's host layer reaches no React", () => {
  it.each([
    ["operations", () => import("./operations")],
    ["diff", () => import("./diff")],
    ["commands", () => import("./commands")],
    ["successions model", () => import("@/components/successions/successions-model")],
    ["counts model", () => import("@/components/counts/counts-model")],
    ["requirements model", () => import("@/components/requirements/requirements-model")],
    ["requirement patch", () => import("@/components/requirements/requirement-patch")],
  ])("%s", async (_name, load) => {
    await expect(load()).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to check that the models fail and the proposal files pass**

Run: `cd web && pnpm vitest run lib/proposal/react-free.test.ts`
Expected: `operations`, `diff` and `commands` PASS. The three models and `requirement patch` FAIL with "React was imported". If `operations` fails, stop and report: the existing shift arms' imports reach React, so the premise of this plan is wrong.

- [ ] **Step 3: Move the weight helpers**

Create `web/components/card-editor/weight-value.ts`. It starts with this header, followed by lines 23-73 of `weight-field.tsx`, verbatim. Those lines run from `/** A weight field's value` through the closing `}` of `formatWeight`.

```ts
// The weight dial's pure contract (parse / validate / format), moved verbatim out of
// `weight-field.tsx` so React-free callers -- the rule models and the assistant's host
// operations in `lib/proposal` -- can share it. `weight-field.tsx` re-exports every name,
// so none of its importers change.

```

In `weight-field.tsx`, delete lines 23-73. Below the existing imports, add:

```ts
import { formatWeight, parseWeightInput, type WeightFieldValue } from "./weight-value";

export {
  formatWeight,
  isValidWeightValue,
  isWeightNonPositive,
  parseWeightInput,
  type WeightFieldValue,
} from "./weight-value";
```

- [ ] **Step 4: Move the coefficient helpers**

Create `web/components/card-editor/coefficient-model.ts`. It starts with this header, followed by lines 24-216 of `coefficient-fields.tsx`, verbatim. Those lines run from the `/**` above `CoefficientMemberId` through the closing `}` of `validateCoefficientPairs`.

```ts
// The coefficient sub-editor's pure contract (eligibility, sync, validation), moved
// verbatim out of `coefficient-fields.tsx` so React-free callers can share it. The
// component file re-exports every name.

```

In `coefficient-fields.tsx`, delete lines 24-216. Below the existing imports, add:

```ts
import {
  coefficientValueFor,
  eligibleCoefficientIds,
  parseCoefficientInput,
  updateCoefficientPair,
  type CoefficientDomain,
  type CoefficientPair,
} from "./coefficient-model";

export {
  coefficientEntryOrder,
  coefficientIntegerErrorMessage,
  coefficientOverlapMessage,
  coefficientValueFor,
  eligibleCoefficientIds,
  parseCoefficientInput,
  sortIdsByEntryOrder,
  syncCoefficientPairs,
  updateCoefficientPair,
  validateCoefficientPairs,
  type CoefficientDomain,
  type CoefficientDraftValue,
  type CoefficientEntity,
  type CoefficientGroup,
  type CoefficientMemberId,
  type CoefficientPair,
  type CoefficientValidation,
} from "./coefficient-model";
```

If `tsc` reports another name that the component body uses, add it to the first import. Do not add it to the moved file.

- [ ] **Step 5: Move the expression helpers**

Create `web/components/card-editor/expression-model.ts`. It starts with this header, followed by lines 17-93 of `expression-field.tsx`, verbatim. Those lines run from `export interface ExpressionOp` through the closing `}` of `ExpressionFieldValue`.

```ts
// The six count expressions and their pure helpers, moved verbatim out of
// `expression-field.tsx` so React-free callers can share them. The component file
// re-exports every name.

```

In `expression-field.tsx`, delete lines 17-93. Below the existing imports, add:

```ts
import {
  EXPRESSION_OPS,
  isSquaredExpression,
  type ExpressionFieldValue,
  type ExpressionTargetValue,
} from "./expression-model";

export {
  EXPRESSION_OPS,
  SUPPORTED_EXPRESSIONS,
  isSquaredExpression,
  isSupportedExpression,
  substituteTarget,
  type ExpressionFieldValue,
  type ExpressionOp,
  type ExpressionTargetValue,
} from "./expression-model";
```

- [ ] **Step 6: Point the three models at the pure files**

In `requirements-model.ts`, `successions-model.ts` and `counts-model.ts`, change only the module specifiers of the value imports:

- `"@/components/card-editor/coefficient-fields"` → `"@/components/card-editor/coefficient-model"`
- `"@/components/card-editor/weight-field"` → `"@/components/card-editor/weight-value"`
- `"@/components/card-editor/expression-field"` → `"@/components/card-editor/expression-model"`

Leave the `import type` lines from `transfer-list` and `date-scope-field` as they are.

- [ ] **Step 7: Run the guard test and the neighbouring suites to check they pass**

Run: `cd web && pnpm vitest run lib/proposal/react-free.test.ts components/card-editor components/requirements components/successions components/counts components/guided-rules`
Expected: PASS. If a model still fails the guard test, read the error's import chain and fix that specifier. Do not mock around it.

- [ ] **Step 8: Typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm lint:oxlint && pnpm lint:ast-grep`
Expected: no errors. If `ast-grep`'s `test-capability-acquisition` rule flags the dynamic `import("./operations")` calls, read the rule. It targets `node:` specifiers only. Report the flag rather than disable the rule.

- [ ] **Step 9: Commit**

```bash
git add web/components/card-editor web/components/requirements/requirements-model.ts web/components/successions/successions-model.ts web/components/counts/counts-model.ts web/lib/proposal/react-free.test.ts
git commit -m "refactor(rules): React-free weight/coefficient/expression helpers + lib/proposal guard"
```

---

### Task 2: Shift sequence arms (`add_succession_rule`, `edit_succession_rule`) and the shared rule helpers

**Files:**
- Modify: `web/lib/proposal/commands.ts` (type union, `ASSISTANT_COMMAND_TYPES`, schema field helpers, zod union)
- Modify: `web/lib/proposal/operations.ts` (header comment, imports, rule helpers, two transforms, `switch`)
- Modify: `web/lib/proposal/test-support.ts` (add `ruleWardScenario`)
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`
- Modify (locked lists): `web/lib/ai/phase-2-absence.test.ts` (`PROPOSAL_OPERATIONS`), `web/lib/ai/runtime/model-visible-tools.test.ts` (`representative`)

**Interfaces:**
- Consumes: Task 1's `parseWeightInput` (`@/components/card-editor/weight-value`). From `successions-model`: `buildSuccessionCard`, `buildPatternShiftTypeOptions`, `buildPeopleTransferOptions`, `buildDateScopeAutoScopes`, `buildDateScopeDateGroups`, `buildDateScopeDateItems`, `isEditableSuccessionCard`, `validateSuccessionForm` and `SuccessionFormState`. `proposalDigest` and `stableStringify` from `./digest`.
- Produces:
  - Arms `{ type: "add_succession_rule"; description: string; people: PersonRef[]; pattern: string[]; dates: string[]; weight: string }` and `{ type: "edit_succession_rule"; ruleId: string; description: string; people: PersonRef[]; pattern: string[]; dates: string[]; weight: string }`.
  - Helpers in `operations.ts` that Tasks 3-5 reuse: `firstUnoffered`, `dateScopeRejection`, `firstFormError`, `ruleName`, `newRuleUid`, `keepMarkers`, `withCards`, the type `DateScopeBuilders`, and a rule-helpers comment block.
  - Schema helpers in `commands.ts` that Tasks 3-5 reuse: `ruleIdSchema()`, `ruleDescriptionSchema()`, `rulePeopleSchema()`, `ruleDatesSchema()` and `ruleWeightSchema()`.
  - `ruleWardScenario(): ScenarioUiState` in `test-support.ts`. It has staff `ana`, `ben` and `cai`, and staff groups `RN` = [ana, ben] and `Senior` = [cai]. It has the shift group `Working shifts` = [Day, Night]. Its rules are succession `suc-nd`, count `cnt-nights` and the two requirements from `proposalScenario()`.

- [ ] **Step 1: Add the fixture**

Append to `web/lib/proposal/test-support.ts`:

```ts
/**
 * The ward the rule examples need: RN and Senior staff groups, a "Working shifts" group
 * spanning every worked shift, and one editable rule of each card-editor family. The
 * request matrix is emptied so no cell names a person who is not on this staff list.
 */
export function ruleWardScenario(): ScenarioUiState {
  const base = proposalScenario();
  return {
    ...base,
    staff: [
      { _k: "p1", id: "ana" },
      { _k: "p2", id: "ben" },
      { _k: "p3", id: "cai" },
    ],
    staffGroups: [
      { _k: "pg1", id: "RN", members: ["ana", "ben"] },
      { _k: "pg2", id: "Senior", members: ["cai"] },
    ],
    shiftGroups: [{ _k: "sg1", id: "Working shifts", members: ["Day", "Night"] }],
    reqData: [],
    cardsByKind: {
      ...base.cardsByKind,
      successions: [
        {
          uid: "suc-nd",
          description: "No day after night",
          person: ["ana", "ben"],
          pattern: ["Night", "Day"],
          date: ["ALL"],
          weight: Number.NEGATIVE_INFINITY,
        },
      ],
      counts: [
        {
          uid: "cnt-nights",
          description: "Night cap",
          person: ["ana"],
          countDates: ["ALL"],
          countShiftTypes: ["Night"],
          expression: "x <= T",
          target: 6,
          weight: Number.POSITIVE_INFINITY,
        },
      ],
    },
  };
}
```

- [ ] **Step 2: Write the failing schema tests**

Append inside the existing `describe` in `web/lib/proposal/commands.test.ts`:

```ts
  it("accepts the shift-sequence arms with the weight typed as text", () => {
    const fields = {
      description: "No day shift straight after a night shift",
      people: ["ana", "ben", 7],
      pattern: ["Night", "Day"],
      dates: ["ALL"],
      weight: "-infinity",
    };
    const result = parseAssistantCommands([
      { type: "add_succession_rule", ...fields },
      { type: "edit_succession_rule", ruleId: "suc-nd", ...fields },
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses shift-sequence payloads the model must fix itself", () => {
    const add = {
      type: "add_succession_rule",
      description: "",
      people: ["ana"],
      pattern: ["Night", "Day"],
      dates: ["ALL"],
      weight: "-1",
    };
    const refused: unknown[] = [
      // Weight as a number: a hard rule could never be sent, so text is the contract.
      [{ ...add, weight: -1 }],
      // Description omitted: the model sends "" when there is none.
      [{ ...add, description: undefined }],
      // A card body smuggled alongside the targets.
      [{ ...add, uid: "mine" }],
      // Edit without the rule it edits.
      [{ ...add, type: "edit_succession_rule" }],
      // Edit with an empty id.
      [{ ...add, type: "edit_succession_rule", ruleId: "" }],
    ];
    for (const payload of refused) {
      expect(parseAssistantCommands(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });
```

- [ ] **Step 3: Write the failing operation tests**

In `web/lib/proposal/operations.test.ts`, change the fixture import to `import { proposalScenario, ruleWardScenario } from "./test-support";`, then append:

```ts
describe("add_succession_rule / edit_succession_rule", () => {
  const noDayAfterNight = {
    type: "add_succession_rule" as const,
    description: "No day shift straight after a night shift",
    people: ["ana", "ben", "cai"] as (string | number)[],
    pattern: ["Night", "Day"],
    dates: ["ALL"],
    weight: "-infinity",
  };
  // Defaults restate `suc-nd` exactly, so `edit()` with no overrides changes nothing.
  const edit = (overrides: Partial<Omit<typeof noDayAfterNight, "type">> = {}) => ({
    ...noDayAfterNight,
    type: "edit_succession_rule" as const,
    ruleId: "suc-nd",
    description: "No day after night",
    people: ["ana", "ben"] as (string | number)[],
    ...overrides,
  });

  it("expresses 'no day shift straight after a night shift' as a hard rule", () => {
    const result = applyAssistantCommand(ruleWardScenario(), noDayAfterNight);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.next.cardsByKind.successions.at(-1);
    expect(created).toEqual({
      uid: expect.any(String),
      description: "No day shift straight after a night shift",
      person: ["ana", "ben", "cai"],
      pattern: ["Night", "Day"],
      date: ["ALL"],
      weight: Number.NEGATIVE_INFINITY,
    });
    expect(created?.uid).not.toBe("suc-nd");
  });

  it("accepts a staff group, a soft weight and specific dates", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...noDayAfterNight,
      people: ["RN"],
      weight: "-50",
      dates: ["2026-04-06", "2026-04-07"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.cardsByKind.successions.at(-1)).toMatchObject({
        person: ["RN"],
        date: ["2026-04-06", "2026-04-07"],
        weight: -50,
      });
    }
  });

  it("gives two identical new rules different ids, the same on every run", () => {
    const first = applyAssistantCommands(ruleWardScenario(), [noDayAfterNight, noDayAfterNight]);
    const again = applyAssistantCommands(ruleWardScenario(), [noDayAfterNight, noDayAfterNight]);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    const [, a, b] = first.next.cardsByKind.successions.map((card) => card.uid);
    expect(a).not.toBe(b);
    // Apply re-derives the document; it must write the ids the Preview showed.
    expect(again.next).toEqual(first.next);
  });

  it("refuses ALL as people, naming it", () => {
    const result = applyAssistantCommand(ruleWardScenario(), { ...noDayAfterNight, people: ["ALL"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("unknown_target");
    expect(result.rejection.message).toContain(
      'Shift sequence rule "No day shift straight after a night shift"',
    );
    expect(result.rejection.message).toContain('"ALL"');
    expect(result.rejection.message).toContain("Name each person");
  });

  it("refuses a shift that does not exist", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...noDayAfterNight,
      pattern: ["Night", "Evening"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.message).toContain('"Evening"');
  });

  it("refuses a matrix day id and accepts the ISO date", () => {
    const refused = applyAssistantCommand(ruleWardScenario(), { ...noDayAfterNight, dates: ["02"] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.rejection.code).toBe("unknown_target");
      expect(refused.rejection.message).toContain("YYYY-MM-DD");
    }
    const accepted = applyAssistantCommand(ruleWardScenario(), {
      ...noDayAfterNight,
      dates: ["2026-04-02"],
    });
    expect(accepted.ok).toBe(true);
  });

  it("refuses a scope chip mixed with other dates, as the Dates field cannot hold it", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...noDayAfterNight,
      dates: ["WEEKEND", "2026-04-06"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid_value");
    expect(result.rejection.message).toContain("must be the only date entry");
  });

  it("refuses what the form refuses, in the form's words", () => {
    const result = applyAssistantCommand(ruleWardScenario(), { ...noDayAfterNight, pattern: ["Night"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid_value");
    expect(result.rejection.message).toContain(
      "At least 2 shift types must be selected for a succession pattern",
    );
  });

  it("refuses a weight the Weight box would not accept", () => {
    // `.inf` is how the context document spells a hard weight; the box does not accept it.
    for (const weight of ["hard", ".inf", ""]) {
      const result = applyAssistantCommand(ruleWardScenario(), edit({ weight }));
      expect(result.ok, weight).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.message).toContain('Shift sequence rule "No day after night"');
      expect(result.rejection.message).toContain(
        "Weight must be a valid number, Infinity, or -Infinity",
      );
    }
  });

  it("edit keeps the rule's id and keeps a switched-off rule off", () => {
    const state = ruleWardScenario();
    state.cardsByKind.successions[0] = { ...state.cardsByKind.successions[0], disabled: true };
    const result = applyAssistantCommand(state, edit({ weight: "-50" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.cardsByKind.successions).toEqual([
      {
        uid: "suc-nd",
        description: "No day after night",
        person: ["ana", "ben"],
        pattern: ["Night", "Day"],
        date: ["ALL"],
        weight: -50,
        disabled: true,
      },
    ]);
  });

  it("refuses an edit that changes nothing", () => {
    const result = applyAssistantCommand(ruleWardScenario(), edit());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("no_effect");
  });

  it("refuses to edit a rule that is gone", () => {
    const result = applyAssistantCommand(ruleWardScenario(), edit({ ruleId: "nope" } as never));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("unknown_target");
  });

  it("refuses to edit a pattern the screen shows as read-only", () => {
    const state = ruleWardScenario();
    state.cardsByKind.successions[0] = {
      ...state.cardsByKind.successions[0],
      pattern: [["Night", "Day"], "OFF"],
    };
    const result = applyAssistantCommand(state, edit({ weight: "-5" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("unsupported_shape");
  });
});
```

- [ ] **Step 4: Run the tests to check they fail**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: FAIL. The new arms do not parse, and `add_succession_rule` is not a known command.

- [ ] **Step 5: Add the arms to `commands.ts`**

`PersonRef` is already imported. Extend the type union after the `add_shift_group` arm (replace its terminating semicolon):

```ts
  | { type: "add_shift_group"; groupId: string; members: string[] }
  /**
   * Add one shift sequence rule -- the Shift sequences screen's Add form. `weight` is
   * the text the Weight box would hold ("-infinity" = never, "-50" = discourage).
   */
  | {
      type: "add_succession_rule";
      description: string;
      people: PersonRef[];
      pattern: string[];
      dates: string[];
      weight: string;
    }
  /** Replace every field of one shift sequence rule -- that screen's Edit form. */
  | {
      type: "edit_succession_rule";
      ruleId: string;
      description: string;
      people: PersonRef[];
      pattern: string[];
      dates: string[];
      weight: string;
    };
```

Append to `ASSISTANT_COMMAND_TYPES`, after `"add_shift_group",`:

```ts
  "add_succession_rule",
  "edit_succession_rule",
```

Add the field helpers after `clockSchema`:

```ts
// RULE FIELDS are built per arm (a call, not a shared constant) so every arm's JSON
// Schema is emitted inline rather than as a reference the transport would have to
// resolve.

function ruleIdSchema() {
  return z
    .string()
    .min(1)
    .describe('The rule\'s stable id (its "uid"), as reported by get_schedule_section("rules").');
}

function ruleDescriptionSchema() {
  return z
    .string()
    .describe(
      "A short plain title in the ward's words, e.g. \"No day shift straight after a night " +
        'shift". Use "" only when there is nothing to go on.',
    );
}

function rulePeopleSchema() {
  return z
    .array(refSchema)
    .describe(
      "Who the rule is for: person ids and staff group ids exactly as in the schedule. " +
        '"ALL" is not accepted here -- for every nurse, list each person or use a staff ' +
        "group that holds everyone.",
    );
}

function ruleDatesSchema() {
  return z
    .array(z.string())
    .describe(
      'Which dates. EITHER exactly one of "ALL", "WEEKDAY", "WEEKEND", a weekday name such ' +
        'as "MONDAY", or an existing date group id -- OR one or more roster dates written ' +
        "YYYY-MM-DD. Never mix the two kinds.",
    );
}

function ruleWeightSchema() {
  return z
    .string()
    .describe(
      'How strongly, written as you would type it in the Weight box: "-infinity" = must ' +
        'never happen (hard rule), "infinity" = must always hold (hard rule), a negative ' +
        'number such as "-50" discourages, a positive number such as "10" encourages. ' +
        "The schedule shows hard weights as .inf / -.inf: send them as infinity / " +
        "-infinity. Ask the user whether a new rule is a must or a preference when they " +
        "did not say.",
    );
}

function successionFields() {
  return {
    description: ruleDescriptionSchema(),
    people: rulePeopleSchema(),
    pattern: z
      .array(z.string())
      .describe(
        "The shifts in order on consecutive days, at least two, e.g. [\"Night\", \"Day\"] " +
          "for a day shift straight after a night. Shift codes, shift group ids, OFF, " +
          "LEAVE or ALL.",
      ),
    dates: ruleDatesSchema(),
    weight: ruleWeightSchema(),
  };
}
```

Append at the END of the `z.discriminatedUnion("type", [...])` array:

```ts
  z.strictObject({ type: z.enum(["add_succession_rule"]), ...successionFields() }),
  z.strictObject({
    type: z.enum(["edit_succession_rule"]),
    ruleId: ruleIdSchema(),
    ...successionFields(),
  }),
```

Add to the header comment, after the shift-arms paragraph:

```ts
// The rule arms (`add_/edit_succession_rule`, and the count, requirement and remove
// arms after them) widen the set the same way: each one fills the rule editor's own
// form draft and runs that editor's own validator and builder in `operations.ts`.
```

- [ ] **Step 6: Add the rule helpers and succession transforms to `operations.ts`**

Replace the header's "VALIDATION PARITY" paragraph's sentence that begins "The rule arms restate their predicates" and ends "...keep its restated list honest." with:

```ts
// The toggle and head-count arms restate the Guided Rules predicates rather than
// importing `components/guided-rules/mutations`, which reaches the Guided row UI;
// `operations.parity.test.ts` keeps that restatement honest. The create/edit rule
// arms need no restatement: they call each Advanced editor's own model
// (`successions-model`, `counts-model`, `requirements-model`, `requirement-patch`),
// which is React-free -- `react-free.test.ts` holds that line.
```

Add imports after the `shiftTypesDescriptor` import:

```ts
import { parseWeightInput } from "@/components/card-editor/weight-value";
import {
  buildDateScopeAutoScopes as successionAutoScopes,
  buildDateScopeDateGroups as successionDateGroups,
  buildDateScopeDateItems as successionDateItems,
  buildPatternShiftTypeOptions,
  buildPeopleTransferOptions as successionPeopleOptions,
  buildSuccessionCard,
  isEditableSuccessionCard,
  validateSuccessionForm,
  type SuccessionFormState,
} from "@/components/successions/successions-model";
import { proposalDigest, stableStringify } from "./digest";
```

Append to the "Rule helpers" section, after `withRule`:

```ts
/** "Shift sequence rule "Night cap"", or "The new shift sequence rule" when untitled. */
function ruleName(kind: RuleKind, title: string | undefined): string {
  const label = RULE_LABEL[kind];
  const trimmed = title?.trim();
  return trimmed ? `${label[0].toUpperCase()}${label.slice(1)} "${trimmed}"` : `The new ${label}`;
}

/**
 * A new card's uid. Deterministic, so Apply's re-derivation writes the card the Preview
 * showed; the live uids are part of the input, so asking twice for the same rule --
 * in one change or two -- yields two different ids.
 */
function newRuleUid(state: ScenarioUiState, kind: RuleKind, command: AssistantCommandV1): string {
  return proposalDigest([kind, state.cardsByKind[kind].map((card) => card.uid), command]);
}

/**
 * Carry `disabled`/`applied` onto a rebuilt card -- the edit-save rule every editor's
 * `update` applies (`use-successions.ts`, `use-counts.ts`, `requirement-patch.ts`): an
 * edit never re-enables a rule the user switched off.
 */
function keepMarkers<TCard extends { disabled?: boolean; applied?: boolean }>(
  source: TCard,
  rebuilt: TCard,
): TCard {
  const markers: { disabled?: true; applied?: true } = {};
  if (source.disabled) markers.disabled = true;
  if (source.applied) markers.applied = true;
  return markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
}

/** Replace one kind's whole card list. */
function withCards(
  state: ScenarioUiState,
  kind: RuleKind,
  cards: readonly { uid: string }[],
): ScenarioUiState {
  return { ...state, cardsByKind: { ...state.cardsByKind, [kind]: cards } as CardsByKind };
}

/** One entry a picker offers; a disabled entry cannot be picked. */
interface PickerOption {
  value: unknown;
  disabled?: boolean;
}

/**
 * The first picked ref the manual screen's own picker does not offer. Exact identity,
 * as the pickers compare (`sameEntityId`): person `7` and person `"7"` are different.
 */
function firstUnoffered<T>(picked: readonly T[], offered: readonly PickerOption[]): T | undefined {
  return picked.find(
    (ref) => !offered.some((option) => !option.disabled && Object.is(option.value, ref)),
  );
}

/** One editor's Dates-field option builders (each model exports its own three). */
interface DateScopeBuilders {
  auto: (state: ScenarioUiState) => readonly { id: string }[];
  groups: (state: ScenarioUiState) => readonly { id: string }[];
  items: (state: ScenarioUiState) => readonly { id: string }[];
}

/**
 * What a `DateScopeField` can hold: ONE scope chip (ALL, WEEKDAY, WEEKEND, a weekday, or
 * an authored date group), or in-range dates written YYYY-MM-DD. An empty list is left
 * to the form's own validator, which owns that message.
 */
function dateScopeRejection(
  state: ScenarioUiState,
  dates: readonly string[],
  builders: DateScopeBuilders,
): { code: CommandRejectionCode; message: string } | undefined {
  if (dates.length === 0) return undefined;
  const chips = [...builders.auto(state), ...builders.groups(state)].map((option) => option.id);
  if (dates.length === 1 && chips.includes(dates[0])) return undefined;
  const inRange = new Set(builders.items(state).map((item) => item.id));
  const outside = dates.find((date) => !inRange.has(date));
  if (outside === undefined) return undefined;
  if (chips.includes(outside)) {
    return {
      code: "invalid_value",
      message: `"${outside}" stands for a whole set of dates, so it must be the only date entry`,
    };
  }
  return {
    code: "unknown_target",
    message:
      `"${outside}" is not a roster date (write dates as YYYY-MM-DD inside the roster ` +
      "period), a date group, or one of ALL, WEEKDAY, WEEKEND or a weekday name such as MONDAY",
  };
}

/** The first message a form validator reported, in the validator's own field order. */
function firstFormError(errors: object): string | undefined {
  return Object.values(errors).find((value): value is string => typeof value === "string");
}

// --- Shift sequences --------------------------------------------------------

type SuccessionFields = Omit<
  Extract<AssistantCommandV1, { type: "add_succession_rule" }>,
  "type"
>;

const SUCCESSION_DATES: DateScopeBuilders = {
  auto: successionAutoScopes,
  groups: successionDateGroups,
  items: successionDateItems,
};

/** The draft the Shift sequences form holds once the user has entered these values. */
function successionDraft(fields: SuccessionFields): SuccessionFormState {
  return {
    description: fields.description,
    person: [...fields.people],
    pattern: [...fields.pattern],
    date: [...fields.dates],
    weight: parseWeightInput(fields.weight),
  };
}

/** Everything the form checks before Save, plus what its pickers make impossible to pick. */
function successionRejection(
  state: ScenarioUiState,
  fields: SuccessionFields,
  name: string,
  index: number,
): OperationResult | undefined {
  const people = successionPeopleOptions(state);
  const person = firstUnoffered(fields.people, [...people.items, ...people.groups]);
  if (person !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no person or staff group "${person}". Name each person, or an existing staff group.`,
    );
  }
  const shifts = buildPatternShiftTypeOptions(state);
  const shift = firstUnoffered(fields.pattern, [...shifts.items, ...shifts.groups]);
  if (shift !== undefined) {
    return reject(index, "unknown_target", `${name}: there is no shift or shift group "${shift}".`);
  }
  const dates = dateScopeRejection(state, fields.dates, SUCCESSION_DATES);
  if (dates) return reject(index, dates.code, `${name}: ${dates.message}.`);
  const error = firstFormError(validateSuccessionForm(successionDraft(fields)));
  if (error) return reject(index, "invalid_value", `${name}: ${error}.`);
  return undefined;
}

function applyAddSuccessionRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_succession_rule" }>,
  index: number,
): OperationResult {
  const refused = successionRejection(
    state,
    command,
    ruleName("successions", command.description),
    index,
  );
  if (refused) return refused;
  // `use-successions.ts` `add`: append `buildSuccessionCard(form)`.
  const card = buildSuccessionCard(
    successionDraft(command),
    newRuleUid(state, "successions", command),
  );
  return {
    ok: true,
    next: withCards(state, "successions", [...state.cardsByKind.successions, card]),
  };
}

function applyEditSuccessionRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_succession_rule" }>,
  index: number,
): OperationResult {
  const source = state.cardsByKind.successions.find((card) => card.uid === command.ruleId);
  if (!source) {
    return reject(index, "unknown_target", "That shift sequence rule is not in this schedule any more.");
  }
  const name = ruleName("successions", source.description?.trim() || source.uid);
  // The screen opens no form for such a card (`isEditableSuccessionCard` guards `openEdit`).
  if (!isEditableSuccessionCard(source)) {
    return reject(
      index,
      "unsupported_shape",
      `${name}: one step of its pattern allows several shifts, so it has to be edited on the Shift sequences screen.`,
    );
  }
  const refused = successionRejection(state, command, name, index);
  if (refused) return refused;
  const next = keepMarkers(source, buildSuccessionCard(successionDraft(command), source.uid));
  if (stableStringify(next) === stableStringify(source)) {
    return reject(index, "no_effect", `${name} already says exactly that.`);
  }
  return {
    ok: true,
    next: withCards(
      state,
      "successions",
      state.cardsByKind.successions.map((card) => (card.uid === source.uid ? next : card)),
    ),
  };
}
```

Add two cases to the `switch` in `applyAssistantCommand`, after `add_shift_group`:

```ts
    case "add_succession_rule":
      return applyAddSuccessionRule(state, command, index);
    case "edit_succession_rule":
      return applyEditSuccessionRule(state, command, index);
```

- [ ] **Step 7: Update the two locked lists, consciously**

In `web/lib/ai/phase-2-absence.test.ts`, add the following above `PROPOSAL_OPERATIONS`, directly under the 2026-09-23 comment. Then append the two names to the list.

```ts
// WIDENED DELIBERATELY (2026-09-24, plan assistant-rule-ops): creating and editing
// rules is Phase-1 scenario authoring. Each arm fills a rule editor's own form draft
// and runs its own validator/builder; none acts on a produced roster.
```

```ts
  "add_succession_rule",
  "edit_succession_rule",
```

In `web/lib/ai/runtime/model-visible-tools.test.ts`, add to `representative` after `add_shift_group`:

```ts
      add_succession_rule: {
        type: "add_succession_rule",
        description: "No day shift straight after a night shift",
        people: ["ana", "ben"],
        pattern: ["Night", "Day"],
        dates: ["ALL"],
        weight: "-infinity",
      },
      edit_succession_rule: {
        type: "edit_succession_rule",
        ruleId: "s1",
        description: "No day shift straight after a night shift",
        people: ["ana", "ben"],
        pattern: ["Night", "Day"],
        dates: ["ALL"],
        weight: "-50",
      },
```

- [ ] **Step 8: Run the tests to check they pass**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/phase-2-absence.test.ts lib/ai/runtime/model-visible-tools.test.ts`
Expected: PASS. If the wire test fails on `people`, read the recorded wire JSON. The array items must be the union `string | number` (the same converter case as `move_leave`'s `personId`). Read the failure before you change the schema.

- [ ] **Step 9: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/operations.ts web/lib/proposal/test-support.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.test.ts web/lib/ai/phase-2-absence.test.ts web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): add/edit shift sequence rule proposal ops"
```

---

### Task 3: Shift count arms (`add_count_rule`, `edit_count_rule`)

**Files:**
- Modify: `web/lib/proposal/commands.ts`, `web/lib/proposal/operations.ts`
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`
- Modify (locked lists): `web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`

**Interfaces:**
- Consumes: Task 2's operation helpers (`ruleName`, `newRuleUid`, `keepMarkers`, `withCards`, `firstUnoffered`, `dateScopeRejection`, `firstFormError`, `DateScopeBuilders`). Task 2's schema helpers (`ruleDescriptionSchema()`, `rulePeopleSchema()`, `ruleDatesSchema()`, `ruleWeightSchema()`, `ruleIdSchema()`). From `counts-model`: `buildCountCard`, `buildCountShiftTypeDomain`, `buildCountShiftTypeTransferOptions`, `buildPeopleTransferOptions`, `buildDateScope*`, `countToForm`, `emptyCountForm`, `isEditableCountCard`, `validateCountForm` and `CountFormState`.
- Produces:
  - `export const COUNT_EXPRESSIONS = ["x <= T", "x >= T", "x = T", "x < T", "x > T", "|x - T|^2"] as const` in `commands.ts`.
  - Arms `{ type: "add_count_rule"; description: string; people: PersonRef[]; shiftTypes: string[]; dates: string[]; expression: (typeof COUNT_EXPRESSIONS)[number]; target: number; weight: string }` and `edit_count_rule`, which has the same fields plus `ruleId: string`.

- [ ] **Step 1: Write the failing schema tests**

Append inside the `describe` in `commands.test.ts`. Add `import { SUPPORTED_EXPRESSIONS } from "@/components/card-editor/expression-model";` and add `COUNT_EXPRESSIONS` to the `./commands` import:

```ts
  it("offers exactly the Shift counts screen's six expressions", () => {
    expect([...COUNT_EXPRESSIONS].sort()).toEqual([...SUPPORTED_EXPRESSIONS].sort());
  });

  it("accepts the shift-count arms and refuses an expression the screen does not offer", () => {
    const fields = {
      description: "At most 5 night shifts per nurse per month",
      people: ["ana"],
      shiftTypes: ["Night"],
      dates: ["ALL"],
      expression: "x <= T",
      target: 5,
      weight: "infinity",
    };
    expect(
      parseAssistantCommands([
        { type: "add_count_rule", ...fields },
        { type: "edit_count_rule", ruleId: "cnt-nights", ...fields },
      ]).ok,
    ).toBe(true);
    for (const expression of ["x <= 5", "x ≤ T", "at most"]) {
      expect(
        parseAssistantCommands([{ type: "add_count_rule", ...fields, expression }]).ok,
        expression,
      ).toBe(false);
    }
  });
```

- [ ] **Step 2: Write the failing operation tests**

Append to `operations.test.ts`:

```ts
describe("add_count_rule / edit_count_rule", () => {
  const nightCap = {
    type: "add_count_rule" as const,
    description: "At most 5 night shifts per nurse per month",
    people: ["ana", "ben", "cai"] as (string | number)[],
    shiftTypes: ["Night"],
    dates: ["ALL"],
    expression: "x <= T" as const,
    target: 5,
    weight: "infinity",
  };
  // Defaults restate `cnt-nights` exactly.
  const edit = (overrides: Partial<Omit<typeof nightCap, "type">> = {}) => ({
    ...nightCap,
    type: "edit_count_rule" as const,
    ruleId: "cnt-nights",
    description: "Night cap",
    people: ["ana"] as (string | number)[],
    target: 6,
    ...overrides,
  });

  it("expresses 'at most 5 night shifts per nurse per month' as a hard rule", () => {
    const result = applyAssistantCommand(ruleWardScenario(), nightCap);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.cardsByKind.counts.at(-1)).toEqual({
      uid: expect.any(String),
      description: "At most 5 night shifts per nurse per month",
      person: ["ana", "ben", "cai"],
      countDates: ["ALL"],
      countShiftTypes: ["Night"],
      expression: "x <= T",
      target: 5,
      weight: Number.POSITIVE_INFINITY,
    });
  });

  it("stores the counted shifts in the Shifts page order, as the screen does", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...nightCap,
      shiftTypes: ["Night", "Day"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.cardsByKind.counts.at(-1)?.countShiftTypes).toEqual(["Day", "Night"]);
  });

  it("accepts OFF and a shift group, as the screen's picker offers them", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...nightCap,
      description: "At least 8 days off",
      shiftTypes: ["OFF"],
      expression: "x >= T",
      target: 8,
    });
    expect(result.ok).toBe(true);
    const group = applyAssistantCommand(ruleWardScenario(), { ...nightCap, shiftTypes: ["Working shifts"] });
    expect(group.ok).toBe(true);
  });

  it("refuses 'close to target' with a hard weight, in the screen's words", () => {
    const result = applyAssistantCommand(ruleWardScenario(), {
      ...nightCap,
      expression: "|x - T|^2",
      weight: "infinity",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain(
      'Shift count rule "At most 5 night shifts per nurse per month"',
    );
    expect(result.rejection.message).toContain("Weight must be non-positive");
  });

  it("refuses a target that is not a whole number of zero or more", () => {
    for (const target of [2.5, -1]) {
      const result = applyAssistantCommand(ruleWardScenario(), { ...nightCap, target });
      expect(result.ok, String(target)).toBe(false);
      if (!result.ok) expect(result.rejection.message).toContain("Target must be a non-negative integer");
    }
  });

  it("edit keeps coefficients and the off marker", () => {
    const state = ruleWardScenario();
    state.cardsByKind.counts[0] = {
      ...state.cardsByKind.counts[0],
      countShiftTypeCoefficients: [["Night", 2]],
      disabled: true,
    };
    const result = applyAssistantCommand(state, edit({ target: 4 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.cardsByKind.counts[0]).toEqual({ ...state.cardsByKind.counts[0], target: 4 });
    }
  });

  it("refuses to edit a contracted-hours count", () => {
    const state = ruleWardScenario();
    state.cardsByKind.counts = [
      {
        uid: "cnt-hours",
        description: "Contract",
        person: ["ana"],
        countDates: ["ALL"],
        countShiftTypes: ["Day"],
        expression: ["x >= T", "x <= T"],
        target: [10, 12],
        weight: -1,
        tag: "contracted_hours",
        policy: "range",
      },
    ];
    const result = applyAssistantCommand(state, edit({ ruleId: "cnt-hours" } as never));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("unsupported_shape");
  });

  it("refuses an edit that changes nothing", () => {
    const result = applyAssistantCommand(ruleWardScenario(), edit());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("no_effect");
  });
});
```

- [ ] **Step 3: Run the tests to check they fail**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: FAIL. `COUNT_EXPRESSIONS` is undefined, and the count arms are unknown.

- [ ] **Step 4: Add the arms to `commands.ts`**

Above `AssistantCommandV1`, add:

```ts
/** The Shift counts screen's six expressions (`expression-model.ts` `SUPPORTED_EXPRESSIONS`). */
export const COUNT_EXPRESSIONS = ["x <= T", "x >= T", "x = T", "x < T", "x > T", "|x - T|^2"] as const;
```

Extend the union after `edit_succession_rule` (replace its terminating semicolon):

```ts
  /** Add one shift count rule -- the Shift counts screen's Add form (ordinary counts only). */
  | {
      type: "add_count_rule";
      description: string;
      people: PersonRef[];
      shiftTypes: string[];
      dates: string[];
      expression: (typeof COUNT_EXPRESSIONS)[number];
      target: number;
      weight: string;
    }
  /** Replace every field of one ordinary shift count rule -- that screen's Edit form. */
  | {
      type: "edit_count_rule";
      ruleId: string;
      description: string;
      people: PersonRef[];
      shiftTypes: string[];
      dates: string[];
      expression: (typeof COUNT_EXPRESSIONS)[number];
      target: number;
      weight: string;
    };
```

Append `"add_count_rule", "edit_count_rule",` to `ASSISTANT_COMMAND_TYPES`. After `successionFields`, add:

```ts
function countFields() {
  return {
    description: ruleDescriptionSchema(),
    people: rulePeopleSchema(),
    shiftTypes: z
      .array(z.string())
      .describe(
        "The shifts to count, per person: shift codes, shift group ids, OFF, LEAVE or ALL.",
      ),
    dates: ruleDatesSchema(),
    expression: z
      .enum(COUNT_EXPRESSIONS)
      .describe(
        'How each person\'s count x relates to the target T: "x <= T" at most, "x >= T" at ' +
          'least, "x = T" exactly, "x < T" fewer than, "x > T" more than, "|x - T|^2" as ' +
          'close to T as possible (needs a weight of 0 or less, never "infinity").',
      ),
    target: z.number().describe("The target T, a whole number of zero or more, e.g. 5."),
    weight: ruleWeightSchema(),
  };
}
```

Append to the zod union:

```ts
  z.strictObject({ type: z.enum(["add_count_rule"]), ...countFields() }),
  z.strictObject({ type: z.enum(["edit_count_rule"]), ruleId: ruleIdSchema(), ...countFields() }),
```

- [ ] **Step 5: Add the count transforms to `operations.ts`**

Add the import:

```ts
import {
  buildCountCard,
  buildCountShiftTypeDomain,
  buildCountShiftTypeTransferOptions,
  buildDateScopeAutoScopes as countAutoScopes,
  buildDateScopeDateGroups as countDateGroups,
  buildDateScopeDateItems as countDateItems,
  buildPeopleTransferOptions as countPeopleOptions,
  countToForm,
  emptyCountForm,
  isEditableCountCard,
  validateCountForm,
  type CountFormState,
} from "@/components/counts/counts-model";
```

After the shift-sequence transforms, add:

```ts
// --- Shift counts -------------------------------------------------------------

type CountFields = Omit<Extract<AssistantCommandV1, { type: "add_count_rule" }>, "type">;

const COUNT_DATES: DateScopeBuilders = {
  auto: countAutoScopes,
  groups: countDateGroups,
  items: countDateItems,
};

/**
 * The draft the Shift counts form holds once the user has entered these values, on top
 * of `base`: a fresh form for Add, the loaded card (`countToForm`) for Edit -- so an
 * edit keeps the coefficients the arm does not carry, exactly as the form does.
 */
function countDraft(fields: CountFields, base: CountFormState): CountFormState {
  return {
    ...base,
    description: fields.description,
    person: [...fields.people],
    countDates: [...fields.dates],
    countShiftTypes: [...fields.shiftTypes],
    expression: fields.expression,
    target: fields.target,
    weight: parseWeightInput(fields.weight),
  };
}

function countRejection(
  state: ScenarioUiState,
  fields: CountFields,
  draft: CountFormState,
  name: string,
  index: number,
): OperationResult | undefined {
  const people = countPeopleOptions(state);
  const person = firstUnoffered(fields.people, [...people.items, ...people.groups]);
  if (person !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no person or staff group "${person}". Name each person, or an existing staff group.`,
    );
  }
  const shifts = buildCountShiftTypeTransferOptions(state);
  const shift = firstUnoffered(fields.shiftTypes, [...shifts.items, ...shifts.groups]);
  if (shift !== undefined) {
    return reject(index, "unknown_target", `${name}: there is no shift or shift group "${shift}".`);
  }
  const dates = dateScopeRejection(state, fields.dates, COUNT_DATES);
  if (dates) return reject(index, dates.code, `${name}: ${dates.message}.`);
  const error = firstFormError(validateCountForm(draft, buildCountShiftTypeDomain(state)));
  if (error) return reject(index, "invalid_value", `${name}: ${error}.`);
  return undefined;
}

function applyAddCountRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_count_rule" }>,
  index: number,
): OperationResult {
  const draft = countDraft(command, emptyCountForm());
  const refused = countRejection(state, command, draft, ruleName("counts", command.description), index);
  if (refused) return refused;
  // `use-counts.ts` `add`: append `buildCountCard(form, domain)`.
  const card = buildCountCard(draft, buildCountShiftTypeDomain(state), newRuleUid(state, "counts", command));
  return { ok: true, next: withCards(state, "counts", [...state.cardsByKind.counts, card]) };
}

function applyEditCountRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_count_rule" }>,
  index: number,
): OperationResult {
  const source = state.cardsByKind.counts.find((card) => card.uid === command.ruleId);
  if (!source) {
    return reject(index, "unknown_target", "That shift count rule is not in this schedule any more.");
  }
  const name = ruleName("counts", source.description?.trim() || source.uid);
  if (!isEditableCountCard(source)) {
    return reject(
      index,
      "unsupported_shape",
      `${name}: it is a contracted-hours or list-shaped count, so it has to be edited on the Shift counts screen.`,
    );
  }
  const domain = buildCountShiftTypeDomain(state);
  const draft = countDraft(command, countToForm(source, domain));
  const refused = countRejection(state, command, draft, name, index);
  if (refused) return refused;
  const next = keepMarkers(source, buildCountCard(draft, domain, source.uid));
  if (stableStringify(next) === stableStringify(source)) {
    return reject(index, "no_effect", `${name} already says exactly that.`);
  }
  return {
    ok: true,
    next: withCards(
      state,
      "counts",
      state.cardsByKind.counts.map((card) => (card.uid === source.uid ? next : card)),
    ),
  };
}
```

Add the cases:

```ts
    case "add_count_rule":
      return applyAddCountRule(state, command, index);
    case "edit_count_rule":
      return applyEditCountRule(state, command, index);
```

- [ ] **Step 6: Update the locked lists**

Append `"add_count_rule", "edit_count_rule",` to `PROPOSAL_OPERATIONS`. The 2026-09-24 comment already covers them. Add to `representative`:

```ts
      add_count_rule: {
        type: "add_count_rule",
        description: "At most 5 night shifts per nurse per month",
        people: ["ana", "ben"],
        shiftTypes: ["Night"],
        dates: ["ALL"],
        expression: "x <= T",
        target: 5,
        weight: "infinity",
      },
      edit_count_rule: {
        type: "edit_count_rule",
        ruleId: "c1",
        description: "Night cap",
        people: ["ana"],
        shiftTypes: ["Night"],
        dates: ["ALL"],
        expression: "x <= T",
        target: 4,
        weight: "infinity",
      },
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/phase-2-absence.test.ts lib/ai/runtime/model-visible-tools.test.ts && pnpm typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 8: Commit**

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/operations.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.test.ts web/lib/ai/phase-2-absence.test.ts web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): add/edit shift count rule proposal ops"
```

---

### Task 4: Staffing requirement arms (`add_staffing_requirement`, `edit_staffing_requirement`)

The requirement arms call `applyRequirementPatch`, which is the exact function the Staffing requirements screen commits (`use-requirements.ts` `add`/`update`). The only change to UI code is an optional `uid` on the `add` patch, so the assistant can pass its deterministic id. The UI passes none, so `buildRequirementCard`'s default `crypto.randomUUID()` still applies there.

**Files:**
- Modify: `web/components/requirements/requirement-patch.ts:8-10, 28-29`
- Modify: `web/lib/proposal/commands.ts`, `web/lib/proposal/operations.ts`
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`, `web/components/requirements/requirement-patch.test.ts`
- Modify (locked lists): `web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers and schema helpers. From `requirements-model`: `buildQualifiedPeopleTransferOptions`, `buildRequirementShiftTypeDomain`, `buildRequirementShiftTypeOptions`, `buildDateScope*`, `emptyRequirementForm`, `requirementToForm`, `validateRequirementForm` and `RequirementFormState`. `applyRequirementPatch` from `@/components/requirements/requirement-patch`.
- Produces:
  - `RequirementPatch` add arm `{ type: "add"; form: RequirementFormState; uid?: string }`.
  - Arms `{ type: "add_staffing_requirement"; description: string; shiftType: string; qualifiedPeople: PersonRef[]; dates: string[]; requiredNumPeople: number }` and `edit_staffing_requirement`, which has the same fields plus `ruleId: string`.

- [ ] **Step 1: Write the failing patch test**

Append inside the existing `describe` in `web/components/requirements/requirement-patch.test.ts`. If that file's imports lack them, add `applyRequirementPatch` and `emptyRequirementForm`, plus `createEmptyScenarioUiState` from `@/lib/scenario`.

```ts
  it("uses a supplied uid for an add, and mints one when none is given", () => {
    const state = { ...createEmptyScenarioUiState(), shifts: [{ id: "Day" }] };
    const form = { ...emptyRequirementForm(), shiftType: ["Day"], qualifiedPeople: ["ALL"], date: ["ALL"] };
    const given = applyRequirementPatch(state, { type: "add", form, uid: "fixed" });
    expect(given.cardsByKind.requirements.at(-1)?.uid).toBe("fixed");
    const minted = applyRequirementPatch(state, { type: "add", form });
    expect(minted.cardsByKind.requirements.at(-1)?.uid).toMatch(/^[0-9a-f-]{36}$/);
  });
```

- [ ] **Step 2: Write the failing schema and operation tests**

Append inside the `describe` in `commands.test.ts`:

```ts
  it("accepts the staffing-requirement arms and refuses a shift list", () => {
    const fields = {
      description: "At least 2 RNs on every night shift",
      shiftType: "Night",
      qualifiedPeople: ["RN"],
      dates: ["ALL"],
      requiredNumPeople: 2,
    };
    expect(
      parseAssistantCommands([
        { type: "add_staffing_requirement", ...fields },
        { type: "edit_staffing_requirement", ruleId: "req-day", ...fields },
      ]).ok,
    ).toBe(true);
    // One shift or group per requirement, as the screen's single-select holds.
    expect(
      parseAssistantCommands([{ type: "add_staffing_requirement", ...fields, shiftType: ["Night"] }]).ok,
    ).toBe(false);
  });
```

Append to `operations.test.ts`:

```ts
describe("add_staffing_requirement / edit_staffing_requirement", () => {
  const twoRNs = {
    type: "add_staffing_requirement" as const,
    description: "At least 2 RNs on every night shift",
    shiftType: "Night",
    qualifiedPeople: ["RN"] as (string | number)[],
    dates: ["ALL"],
    requiredNumPeople: 2,
  };
  const seniorEveryDay = {
    ...twoRNs,
    description: "Every day needs at least one senior nurse on",
    shiftType: "Working shifts",
    qualifiedPeople: ["Senior"] as (string | number)[],
    requiredNumPeople: 1,
  };
  const edit = (overrides: Partial<Omit<typeof twoRNs, "type">> = {}) => ({
    ...twoRNs,
    type: "edit_staffing_requirement" as const,
    ruleId: "req-day",
    description: "Day cover",
    shiftType: "Day",
    qualifiedPeople: ["ALL"] as (string | number)[],
    ...overrides,
  });

  it("expresses 'at least 2 RNs on every night shift'", () => {
    const result = applyAssistantCommand(ruleWardScenario(), twoRNs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.cardsByKind.requirements.at(-1)).toEqual({
      uid: expect.any(String),
      description: "At least 2 RNs on every night shift",
      shiftType: ["Night"],
      requiredNumPeople: 2,
      qualifiedPeople: ["RN"],
      date: ["ALL"],
      // No preferred count: the screen stamps the inert weight -1.
      weight: -1,
    });
  });

  it("expresses 'every day needs at least one senior nurse on' over the working-shifts group", () => {
    const result = applyAssistantCommand(ruleWardScenario(), seniorEveryDay);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.cardsByKind.requirements.at(-1)).toMatchObject({
        shiftType: ["Working shifts"],
        qualifiedPeople: ["Senior"],
        requiredNumPeople: 1,
      });
    }
  });

  it("accepts ALL as the qualified people, as the screen offers it", () => {
    expect(applyAssistantCommand(ruleWardScenario(), { ...twoRNs, qualifiedPeople: ["ALL"] }).ok).toBe(true);
  });

  it("refuses a day state or ALL as the staffed shift, naming it", () => {
    for (const shiftType of ["OFF", "ALL"]) {
      const result = applyAssistantCommand(ruleWardScenario(), { ...twoRNs, shiftType });
      expect(result.ok, shiftType).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code).toBe("unknown_target");
      expect(result.rejection.message).toContain(`"${shiftType}"`);
    }
  });

  it("refuses a negative head count in the screen's words", () => {
    const result = applyAssistantCommand(ruleWardScenario(), { ...twoRNs, requiredNumPeople: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.message).toContain(
        'Staffing requirement "At least 2 RNs on every night shift"',
      );
      expect(result.rejection.message).toContain("Required number of people must be at least 0");
    }
  });

  it("edit keeps the preferred count and its weight", () => {
    const state = ruleWardScenario();
    state.cardsByKind.requirements[0] = {
      ...state.cardsByKind.requirements[0],
      preferredNumPeople: 3,
      weight: -50,
    };
    const result = applyAssistantCommand(state, edit({ qualifiedPeople: ["RN"] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.cardsByKind.requirements[0]).toMatchObject({
        uid: "req-day",
        qualifiedPeople: ["RN"],
        preferredNumPeople: 3,
        weight: -50,
      });
    }
  });

  it("edit refuses a head count above the preferred count, as the screen does", () => {
    const state = ruleWardScenario();
    state.cardsByKind.requirements[0] = {
      ...state.cardsByKind.requirements[0],
      preferredNumPeople: 3,
      weight: -50,
    };
    const result = applyAssistantCommand(state, edit({ requiredNumPeople: 4 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.message).toContain(
        "Preferred number of people must be greater than required number of people",
      );
    }
  });

  it("edit may narrow a multi-shift requirement to one shift, as the screen's single-select does", () => {
    const result = applyAssistantCommand(
      ruleWardScenario(),
      edit({ ruleId: "req-multi", description: "Day or Night cover", shiftType: "Night" } as never),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.cardsByKind.requirements[1]).toMatchObject({ uid: "req-multi", shiftType: ["Night"] });
    }
  });

  it("refuses to edit a requirement that is gone", () => {
    const result = applyAssistantCommand(ruleWardScenario(), edit({ ruleId: "nope" } as never));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("unknown_target");
  });
});
```

- [ ] **Step 3: Run the tests to check they fail**

Run: `cd web && pnpm vitest run components/requirements/requirement-patch.test.ts lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: FAIL. The patch ignores `uid`, and the requirement arms are unknown.

- [ ] **Step 4: Let the add patch take a uid**

In `requirement-patch.ts`:

```ts
export type RequirementPatch =
  | { type: "add"; form: RequirementFormState; uid?: string }
  | { type: "update"; uid: string; form: RequirementFormState };
```

and in the `add` branch:

```ts
    nextRequirements = [...requirements, buildRequirementCard(patch.form, domain, patch.uid)];
```

`patch.uid` is `undefined` for every UI call, so the default parameter (`crypto.randomUUID()`) still applies.

- [ ] **Step 5: Add the arms to `commands.ts`**

Extend the union after `edit_count_rule`:

```ts
  /** Add one staffing requirement -- the Staffing requirements screen's Add form, no preferred count. */
  | {
      type: "add_staffing_requirement";
      description: string;
      shiftType: string;
      qualifiedPeople: PersonRef[];
      dates: string[];
      requiredNumPeople: number;
    }
  /**
   * Replace these fields of one staffing requirement -- that screen's Edit form. Its
   * preferred count, weight and coefficients are kept as stored.
   */
  | {
      type: "edit_staffing_requirement";
      ruleId: string;
      description: string;
      shiftType: string;
      qualifiedPeople: PersonRef[];
      dates: string[];
      requiredNumPeople: number;
    };
```

Append `"add_staffing_requirement", "edit_staffing_requirement",` to `ASSISTANT_COMMAND_TYPES`. After `countFields`, add:

```ts
function requirementFields() {
  return {
    description: ruleDescriptionSchema(),
    shiftType: z
      .string()
      .describe(
        "ONE shift code or shift group id to staff. To cover every worked shift of a day, " +
          "use a shift group that holds them all. OFF, LEAVE and ALL cannot be staffed.",
      ),
    qualifiedPeople: z
      .array(refSchema)
      .describe(
        'Who counts towards the number: person ids, staff group ids, or ["ALL"] for anyone.',
      ),
    dates: ruleDatesSchema(),
    requiredNumPeople: z
      .number()
      .describe("The minimum number of those people on that shift, e.g. 2. A hard rule."),
  };
}
```

Append to the zod union:

```ts
  z.strictObject({ type: z.enum(["add_staffing_requirement"]), ...requirementFields() }),
  z.strictObject({
    type: z.enum(["edit_staffing_requirement"]),
    ruleId: ruleIdSchema(),
    ...requirementFields(),
  }),
```

- [ ] **Step 6: Add the requirement transforms to `operations.ts`**

Add imports:

```ts
import {
  buildDateScopeAutoScopes as requirementAutoScopes,
  buildDateScopeDateGroups as requirementDateGroups,
  buildDateScopeDateItems as requirementDateItems,
  buildQualifiedPeopleTransferOptions,
  buildRequirementShiftTypeDomain,
  buildRequirementShiftTypeOptions,
  emptyRequirementForm,
  requirementToForm,
  validateRequirementForm,
  type RequirementFormState,
} from "@/components/requirements/requirements-model";
import { applyRequirementPatch } from "@/components/requirements/requirement-patch";
```

After the count transforms, add:

```ts
// --- Staffing requirements -----------------------------------------------------

type RequirementFields = Omit<
  Extract<AssistantCommandV1, { type: "add_staffing_requirement" }>,
  "type"
>;

const REQUIREMENT_DATES: DateScopeBuilders = {
  auto: requirementAutoScopes,
  groups: requirementDateGroups,
  items: requirementDateItems,
};

/** The Staffing requirements form after the user entered these values, over `base`. */
function requirementDraft(fields: RequirementFields, base: RequirementFormState): RequirementFormState {
  return {
    ...base,
    description: fields.description,
    shiftType: [fields.shiftType],
    requiredNumPeople: fields.requiredNumPeople,
    qualifiedPeople: [...fields.qualifiedPeople],
    date: [...fields.dates],
  };
}

function requirementRejection(
  state: ScenarioUiState,
  fields: RequirementFields,
  draft: RequirementFormState,
  name: string,
  index: number,
): OperationResult | undefined {
  const shifts = buildRequirementShiftTypeOptions(state);
  if (firstUnoffered([fields.shiftType], [...shifts.items, ...shifts.groups]) !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: "${fields.shiftType}" is not a shift or shift group that can be staffed. Use a shift code, or a group made only of shifts.`,
    );
  }
  const people = buildQualifiedPeopleTransferOptions(state);
  const person = firstUnoffered(fields.qualifiedPeople, [...people.items, ...people.groups]);
  if (person !== undefined) {
    return reject(index, "unknown_target", `${name}: there is no person or staff group "${person}".`);
  }
  const dates = dateScopeRejection(state, fields.dates, REQUIREMENT_DATES);
  if (dates) return reject(index, dates.code, `${name}: ${dates.message}.`);
  const error = firstFormError(validateRequirementForm(draft, buildRequirementShiftTypeDomain(state)));
  if (error) return reject(index, "invalid_value", `${name}: ${error}.`);
  return undefined;
}

function applyAddStaffingRequirement(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_staffing_requirement" }>,
  index: number,
): OperationResult {
  const draft = requirementDraft(command, emptyRequirementForm());
  const refused = requirementRejection(
    state,
    command,
    draft,
    ruleName("requirements", command.description),
    index,
  );
  if (refused) return refused;
  return {
    ok: true,
    next: applyRequirementPatch(state, {
      type: "add",
      form: draft,
      uid: newRuleUid(state, "requirements", command),
    }),
  };
}

function applyEditStaffingRequirement(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_staffing_requirement" }>,
  index: number,
): OperationResult {
  const source = state.cardsByKind.requirements.find((card) => card.uid === command.ruleId);
  if (!source) {
    return reject(index, "unknown_target", "That staffing requirement is not in this schedule any more.");
  }
  const name = ruleName("requirements", source.description?.trim() || source.uid);
  const draft = requirementDraft(command, requirementToForm(source, buildRequirementShiftTypeDomain(state)));
  const refused = requirementRejection(state, command, draft, name, index);
  if (refused) return refused;
  // `applyRequirementPatch` update keeps the uid and the disabled/applied markers itself.
  const next = applyRequirementPatch(state, { type: "update", uid: source.uid, form: draft });
  const after = next.cardsByKind.requirements.find((card) => card.uid === source.uid);
  if (stableStringify(after) === stableStringify(source)) {
    return reject(index, "no_effect", `${name} already says exactly that.`);
  }
  return { ok: true, next };
}
```

Add the cases:

```ts
    case "add_staffing_requirement":
      return applyAddStaffingRequirement(state, command, index);
    case "edit_staffing_requirement":
      return applyEditStaffingRequirement(state, command, index);
```

- [ ] **Step 7: Update the locked lists**

Append `"add_staffing_requirement", "edit_staffing_requirement",` to `PROPOSAL_OPERATIONS`. Add to `representative`:

```ts
      add_staffing_requirement: {
        type: "add_staffing_requirement",
        description: "At least 2 RNs on every night shift",
        shiftType: "Night",
        qualifiedPeople: ["RN"],
        dates: ["ALL"],
        requiredNumPeople: 2,
      },
      edit_staffing_requirement: {
        type: "edit_staffing_requirement",
        ruleId: "r1",
        description: "At least 2 RNs on every night shift",
        shiftType: "Night",
        qualifiedPeople: ["RN"],
        dates: ["WEEKEND"],
        requiredNumPeople: 3,
      },
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `cd web && pnpm vitest run components/requirements lib/proposal lib/ai/phase-2-absence.test.ts lib/ai/runtime/model-visible-tools.test.ts && pnpm typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 9: Commit**

```bash
git add web/components/requirements/requirement-patch.ts web/components/requirements/requirement-patch.test.ts web/lib/proposal/commands.ts web/lib/proposal/operations.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.test.ts web/lib/ai/phase-2-absence.test.ts web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): add/edit staffing requirement proposal ops"
```

---

### Task 5: `remove_rule` (every family)

**Files:**
- Modify: `web/lib/proposal/commands.ts`, `web/lib/proposal/operations.ts`
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`
- Modify (locked lists): `web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`

**Interfaces:**
- Consumes: `RULE_KINDS`, `ruleIdSchema()`, `findRule`, `RULE_LABEL`, `withCards`.
- Produces: the arm `{ type: "remove_rule"; ruleKind: (typeof RULE_KINDS)[number]; ruleId: string }`.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe` in `commands.test.ts`:

```ts
  it("accepts remove_rule for every rule family and refuses an unknown family", () => {
    for (const ruleKind of RULE_KINDS) {
      expect(parseAssistantCommands([{ type: "remove_rule", ruleKind, ruleId: "x" }]).ok, ruleKind).toBe(true);
    }
    expect(parseAssistantCommands([{ type: "remove_rule", ruleKind: "rosters", ruleId: "x" }]).ok).toBe(false);
  });
```

Add `RULE_KINDS` to that file's `./commands` import. Then append to `operations.test.ts`:

```ts
describe("remove_rule", () => {
  it("removes exactly that rule, leaving its neighbours in order", () => {
    const state = ruleWardScenario();
    const result = applyAssistantCommand(state, { type: "remove_rule", ruleKind: "requirements", ruleId: "req-day" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.cardsByKind.requirements.map((card) => card.uid)).toEqual(["req-multi"]);
      expect(result.next.cardsByKind.successions).toBe(state.cardsByKind.successions);
    }
  });

  it("removes a rule the same change just added", () => {
    const add = {
      type: "add_succession_rule" as const,
      description: "Temp",
      people: ["ana"],
      pattern: ["Night", "Day"],
      dates: ["ALL"],
      weight: "-1",
    };
    const added = applyAssistantCommand(ruleWardScenario(), add);
    if (!added.ok) throw new Error("fixture should apply");
    const uid = added.next.cardsByKind.successions.at(-1)!.uid;
    const result = applyAssistantCommands(ruleWardScenario(), [
      add,
      { type: "remove_rule", ruleKind: "successions", ruleId: uid },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toEqual(ruleWardScenario());
  });

  it("refuses a rule that is not there, naming the family", () => {
    const result = applyAssistantCommand(ruleWardScenario(), { type: "remove_rule", ruleKind: "counts", ruleId: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("unknown_target");
    expect(result.rejection.message).toContain("shift count rule");
  });
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: FAIL. `remove_rule` is unknown.

- [ ] **Step 3: Implement**

In `commands.ts`, extend the union after `edit_staffing_requirement`:

```ts
  /** Delete one rule of any family -- every rule screen's Delete. */
  | { type: "remove_rule"; ruleKind: (typeof RULE_KINDS)[number]; ruleId: string };
```

Append `"remove_rule",` to `ASSISTANT_COMMAND_TYPES`. Append to the zod union:

```ts
  z.strictObject({
    type: z.enum(["remove_rule"]),
    ruleKind: z.enum(RULE_KINDS).describe("Which rule family the rule belongs to."),
    ruleId: ruleIdSchema(),
  }),
```

Update the `RULE_KINDS` doc comment to: `/** The five rule families -- targets of \`set_rule_enabled\` and \`remove_rule\`. */`

In `operations.ts`, after the requirement transforms:

```ts
// --- Remove (every family) -----------------------------------------------------

function applyRemoveRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "remove_rule" }>,
  index: number,
): OperationResult {
  if (!findRule(state, command.ruleKind, command.ruleId)) {
    return reject(
      index,
      "unknown_target",
      `That ${RULE_LABEL[command.ruleKind]} is not in this schedule any more.`,
    );
  }
  // Every editor's `remove`: `current.filter((card) => card.uid !== uid)`.
  const cards = state.cardsByKind[command.ruleKind] as readonly { uid: string }[];
  return {
    ok: true,
    next: withCards(state, command.ruleKind, cards.filter((card) => card.uid !== command.ruleId)),
  };
}
```

Add the case:

```ts
    case "remove_rule":
      return applyRemoveRule(state, command, index);
```

- [ ] **Step 4: Update the locked lists**

Append `"remove_rule",` to `PROPOSAL_OPERATIONS`. `PHASE_2_VERBS` does not match "remove", and the 2026-09-24 comment covers it. Add to `representative`:

```ts
      remove_rule: { type: "remove_rule", ruleKind: "affinities", ruleId: "a1" },
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/phase-2-absence.test.ts lib/ai/runtime/model-visible-tools.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/operations.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.test.ts web/lib/ai/phase-2-absence.test.ts web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): remove_rule proposal op for every rule family"
```

---

### Task 6: Manual-vs-assistant parity for the rule arms

These are characterisation tests, so they pass on the first run. Step 3's mutations prove that they catch drift.

**Files:**
- Test: `web/lib/proposal/operations.parity.test.ts` (append to it. The file already runs under jsdom.)

**Interfaces:**
- Consumes: the real manual functions. Sequences: `validateSuccessionForm`, `buildSuccessionCard`. Counts: `validateCountForm`, `buildCountCard`, `buildCountShiftTypeDomain`, `countToForm`, `emptyCountForm`. Requirements: `validateRequirementForm`, `buildRequirementShiftTypeDomain`, `emptyRequirementForm`, `requirementToForm`, `applyRequirementPatch`. Weight: `parseWeightInput`. Also the Task 2-5 arms and `ruleWardScenario`.
- Produces: nothing new.

- [ ] **Step 1: Write the parity tests**

Add the imports to `operations.parity.test.ts`:

```ts
import type { CountCard, PersonRef, SuccessionCard } from "@/lib/scenario";
import { parseWeightInput } from "@/components/card-editor/weight-value";
import {
  buildSuccessionCard,
  validateSuccessionForm,
  type SuccessionFormState,
} from "@/components/successions/successions-model";
import {
  buildCountCard,
  buildCountShiftTypeDomain,
  countToForm,
  emptyCountForm,
  validateCountForm,
  type CountFormState,
} from "@/components/counts/counts-model";
import {
  buildRequirementShiftTypeDomain,
  emptyRequirementForm,
  requirementToForm,
  validateRequirementForm,
} from "@/components/requirements/requirements-model";
import { applyRequirementPatch } from "@/components/requirements/requirement-patch";
import { ruleWardScenario } from "./test-support";
```

(Merge the `./test-support` import with the existing `proposalScenario` import.)

Append:

```ts
// The editors' edit-save marker rule, restated from `use-successions.ts` / `use-counts.ts`
// `update` -- the one piece of the manual Save that lives in a hook, not a model.
function carryMarkers<T extends { disabled?: boolean; applied?: boolean }>(source: T, rebuilt: T): T {
  const markers: { disabled?: true; applied?: true } = {};
  if (source.disabled) markers.disabled = true;
  if (source.applied) markers.applied = true;
  return markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
}

const valid = (errors: object) => Object.keys(errors).length === 0;

describe("succession arms are the Shift sequences form's Save", () => {
  const rows: { people: PersonRef[]; pattern: string[]; dates: string[]; weight: string }[] = [
    { people: ["ana", "ben", "cai"], pattern: ["Night", "Day"], dates: ["ALL"], weight: "-infinity" },
    { people: ["RN"], pattern: ["Night", "OFF", "Day"], dates: ["WEEKEND"], weight: "-50" },
    { people: ["ana"], pattern: ["Day", "Day"], dates: ["2026-04-06", "2026-04-07"], weight: "1k" },
    { people: ["ana"], pattern: ["Night"], dates: ["ALL"], weight: "-1" }, // one step
    { people: [], pattern: ["Night", "Day"], dates: ["ALL"], weight: "-1" }, // nobody
    { people: ["ana"], pattern: ["Night", "Day"], dates: [], weight: "-1" }, // no dates
    { people: ["ana"], pattern: ["Night", "Day"], dates: ["ALL"], weight: "strong" }, // bad weight
  ];
  const form = (row: (typeof rows)[number], description: string): SuccessionFormState => ({
    description,
    person: row.people,
    pattern: row.pattern,
    date: row.dates,
    weight: parseWeightInput(row.weight),
  });

  it("add: accepts and refuses what the form does, and appends the same card", () => {
    const state = ruleWardScenario();
    for (const [i, row] of rows.entries()) {
      const draft = form(row, `row ${i}`);
      const assistant = applyAssistantCommand(state, {
        type: "add_succession_rule",
        description: `row ${i}`,
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateSuccessionForm(draft)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.successions.at(-1)!.uid;
      // `use-successions.ts` add: append `buildSuccessionCard(form)`.
      expect(assistant.next).toEqual({
        ...state,
        cardsByKind: {
          ...state.cardsByKind,
          successions: [...state.cardsByKind.successions, buildSuccessionCard(draft, uid)],
        },
      });
    }
  });

  it("edit: rebuilds the card in place and keeps a switched-off rule off", () => {
    const state = ruleWardScenario();
    const source: SuccessionCard = { ...state.cardsByKind.successions[0], disabled: true };
    state.cardsByKind.successions = [source];
    for (const [i, row] of rows.entries()) {
      const draft = form(row, "No day after night");
      const assistant = applyAssistantCommand(state, {
        type: "edit_succession_rule",
        ruleId: "suc-nd",
        description: "No day after night",
        ...row,
      });
      const manual = carryMarkers(source, buildSuccessionCard(draft, "suc-nd"));
      const changes = JSON.stringify(manual) !== JSON.stringify(source);
      expect(assistant.ok, `row ${i}`).toBe(valid(validateSuccessionForm(draft)) && changes);
      if (assistant.ok) expect(assistant.next.cardsByKind.successions).toEqual([manual]);
    }
  });
});

describe("count arms are the Shift counts form's Save", () => {
  const rows: {
    shiftTypes: string[];
    expression: "x <= T" | "x >= T" | "|x - T|^2";
    target: number;
    weight: string;
  }[] = [
    { shiftTypes: ["Night"], expression: "x <= T", target: 5, weight: "infinity" },
    { shiftTypes: ["Working shifts", "OFF"], expression: "x >= T", target: 3, weight: "10" },
    { shiftTypes: ["Night"], expression: "|x - T|^2", target: 8, weight: "-10" },
    { shiftTypes: ["Night"], expression: "|x - T|^2", target: 8, weight: "infinity" }, // squared + hard
    { shiftTypes: ["Night"], expression: "x <= T", target: 2.5, weight: "-1" }, // not whole
    { shiftTypes: [], expression: "x <= T", target: 5, weight: "-1" }, // nothing counted
  ];
  const draftOn = (base: CountFormState, row: (typeof rows)[number], description: string) => ({
    ...base,
    description,
    person: ["ana"] as PersonRef[],
    countDates: ["ALL"],
    countShiftTypes: row.shiftTypes,
    expression: row.expression,
    target: row.target,
    weight: parseWeightInput(row.weight),
  });

  it("add: accepts and refuses what the form does, and appends the same card", () => {
    const state = ruleWardScenario();
    const domain = buildCountShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const draft = draftOn(emptyCountForm(), row, `row ${i}`);
      const assistant = applyAssistantCommand(state, {
        type: "add_count_rule",
        description: `row ${i}`,
        people: ["ana"],
        dates: ["ALL"],
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateCountForm(draft, domain)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.counts.at(-1)!.uid;
      expect(assistant.next.cardsByKind.counts).toEqual([
        ...state.cardsByKind.counts,
        buildCountCard(draft, domain, uid),
      ]);
    }
  });

  it("edit: starts from the loaded card, so coefficients and markers survive", () => {
    const state = ruleWardScenario();
    const source = {
      ...state.cardsByKind.counts[0],
      countShiftTypeCoefficients: [["Night", 2]],
      applied: true,
    } as CountCard;
    state.cardsByKind.counts = [source];
    const domain = buildCountShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const draft = draftOn(countToForm(source, domain), row, "Night cap");
      const assistant = applyAssistantCommand(state, {
        type: "edit_count_rule",
        ruleId: "cnt-nights",
        description: "Night cap",
        people: ["ana"],
        dates: ["ALL"],
        ...row,
      });
      const ok = valid(validateCountForm(draft, domain));
      const manual = ok ? carryMarkers(source, buildCountCard(draft, domain, "cnt-nights")) : null;
      const changes = manual !== null && JSON.stringify(manual) !== JSON.stringify(source);
      expect(assistant.ok, `row ${i}`).toBe(ok && changes);
      if (assistant.ok) expect(assistant.next.cardsByKind.counts).toEqual([manual]);
    }
  });
});

describe("requirement arms are the Staffing requirements screen's commit", () => {
  const rows: { shiftType: string; qualifiedPeople: PersonRef[]; dates: string[]; requiredNumPeople: number }[] = [
    { shiftType: "Night", qualifiedPeople: ["RN"], dates: ["ALL"], requiredNumPeople: 2 },
    { shiftType: "Working shifts", qualifiedPeople: ["Senior"], dates: ["ALL"], requiredNumPeople: 1 },
    { shiftType: "Day", qualifiedPeople: ["ALL"], dates: ["WEEKDAY"], requiredNumPeople: 0 },
    { shiftType: "Day", qualifiedPeople: ["RN"], dates: ["ALL"], requiredNumPeople: -1 }, // negative
    { shiftType: "Day", qualifiedPeople: [], dates: ["ALL"], requiredNumPeople: 1 }, // nobody
    { shiftType: "Day", qualifiedPeople: ["RN"], dates: ["ALL"], requiredNumPeople: 4 }, // above preferred (edit)
  ];

  it("add: accepts and refuses what the form does, and commits the same document", () => {
    const state = ruleWardScenario();
    const domain = buildRequirementShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const form = {
        ...emptyRequirementForm(),
        description: `row ${i}`,
        shiftType: [row.shiftType],
        requiredNumPeople: row.requiredNumPeople,
        qualifiedPeople: row.qualifiedPeople,
        date: row.dates,
      };
      const assistant = applyAssistantCommand(state, {
        type: "add_staffing_requirement",
        description: `row ${i}`,
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateRequirementForm(form, domain)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.requirements.at(-1)!.uid;
      expect(assistant.next).toEqual(applyRequirementPatch(state, { type: "add", form, uid }));
    }
  });

  it("edit: starts from the loaded card and commits the same document", () => {
    const state = ruleWardScenario();
    state.cardsByKind.requirements[0] = {
      ...state.cardsByKind.requirements[0],
      preferredNumPeople: 3,
      weight: -50,
      disabled: true,
    };
    const source = state.cardsByKind.requirements[0];
    const domain = buildRequirementShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const form = {
        ...requirementToForm(source, domain),
        description: "Day cover",
        shiftType: [row.shiftType],
        requiredNumPeople: row.requiredNumPeople,
        qualifiedPeople: row.qualifiedPeople,
        date: row.dates,
      };
      const assistant = applyAssistantCommand(state, {
        type: "edit_staffing_requirement",
        ruleId: "req-day",
        description: "Day cover",
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateRequirementForm(form, domain)));
      if (assistant.ok) {
        expect(assistant.next).toEqual(applyRequirementPatch(state, { type: "update", uid: "req-day", form }));
      }
    }
  });
});

describe("remove_rule is every editor's Delete", () => {
  it("produces the list each editor's remove transform produces", () => {
    const state = ruleWardScenario();
    for (const [ruleKind, ruleId] of [
      ["requirements", "req-multi"],
      ["successions", "suc-nd"],
      ["counts", "cnt-nights"],
    ] as const) {
      const assistant = applyAssistantCommand(state, { type: "remove_rule", ruleKind, ruleId });
      expect(assistant.ok, ruleKind).toBe(true);
      if (assistant.ok) {
        const cards = state.cardsByKind[ruleKind] as readonly { uid: string }[];
        expect(assistant.next.cardsByKind[ruleKind]).toEqual(cards.filter((card) => card.uid !== ruleId));
      }
    }
  });
});
```

- [ ] **Step 2: Run to check they pass**

Run: `cd web && pnpm vitest run lib/proposal/operations.parity.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation checks (do not commit these)**

Make each change below in `operations.ts`, run the parity suite, check that the named case FAILS, then revert:

1. In `applyEditSuccessionRule`, replace `keepMarkers(source, buildSuccessionCard(...))` with the bare `buildSuccessionCard(...)`. The succession `edit` case must fail.
2. In `applyEditCountRule`, replace `countToForm(source, domain)` with `emptyCountForm()`. The count `edit` case must fail, because the coefficients are lost.
3. In `successionDraft`, replace `parseWeightInput(fields.weight)` with `Number(fields.weight)`. The succession `add` case must fail on `"1k"` and `"-infinity"`.

If a mutation leaves every case passing, the parity assertion is vacuous. Fix the test before you continue.

- [ ] **Step 4: Commit**

```bash
git add web/lib/proposal/operations.parity.test.ts
git commit -m "test(assistant): rule op parity with the rule editors' Save"
```

---

### Task 7: The Preview states each rule in plain words and lists new rules as asked-for

Today `ruleBody` renders `On · {json}`, and `directKeys` names no created rule. So a new rule shows as a JSON "consequence". This task makes three changes:

- Requirement, sequence and count cards render as one sentence a ward manager can read.
- Every rule that an `add_*` arm created is a direct entry.
- Edited and removed rules are named by their `ruleId`.

Pairing and supervision cards keep the opaque rendering until the follow-up plan.

**Files:**
- Modify: `web/lib/proposal/diff.ts` (imports, rule rendering helpers, `ruleBody`, `directKeys`, `deriveProposalDiff`)
- Test: `web/lib/proposal/diff.test.ts`

**Interfaces:**
- Consumes: `EXPRESSION_OPS` and `substituteTarget` from `@/components/card-editor/expression-model` (Task 1). The Task 2-5 arms.
- Produces: `directKeys(commands, before, after)`, which is private. `after` text formats:
  - requirement: `On · “<title>” · At least <n> <person|people>[ from <who>] on <shift>, <dates>[; ideally <p> (<strength>)]`
  - sequence: `On · “<title>” · <A> → <B> on consecutive days for <people>, <dates>: <strength>`
  - count: `On · “<title>” · <At most 5> <shifts> shifts for each of <people>, across <dates>: <strength>`
  - When the description is empty, the title part is left out. `<strength>` is one of `must always hold`, `must never happen`, `encouraged (weight N)`, `discouraged (weight N)` or `no effect (weight 0)`. `<dates>` turns `ALL` into `every date`, `WEEKEND` into `weekends` and `MONDAY` into `Mondays`. Other refs stay as they are.

- [ ] **Step 1: Write the failing test**

Append inside `describe("deriveProposalDiff", ...)` in `diff.test.ts`. Change the fixture import to `import { proposalScenario, ruleWardScenario } from "./test-support";`.

```ts
  it("lists every new rule as asked-for and states each in plain words", () => {
    const before = ruleWardScenario();
    const nightAfter = {
      type: "add_succession_rule" as const,
      description: "No day shift straight after a night shift",
      people: ["ana", "ben", "cai"],
      pattern: ["Night", "Day"],
      dates: ["ALL"],
      weight: "-infinity",
    };
    const commands = [
      nightAfter,
      nightAfter,
      {
        type: "add_count_rule" as const,
        description: "At most 5 night shifts per nurse per month",
        people: ["ana", "ben", "cai"],
        shiftTypes: ["Night"],
        dates: ["ALL"],
        expression: "x <= T" as const,
        target: 5,
        weight: "infinity",
      },
      {
        type: "add_staffing_requirement" as const,
        description: "At least 2 RNs on every night shift",
        shiftType: "Night",
        qualifiedPeople: ["RN"],
        dates: ["ALL"],
        requiredNumPeople: 2,
      },
      {
        type: "edit_count_rule" as const,
        ruleId: "cnt-nights",
        description: "Night cap",
        people: ["ana"],
        shiftTypes: ["Night"],
        dates: ["WEEKEND"],
        expression: "x <= T" as const,
        target: 4,
        weight: "-50",
      },
      { type: "remove_rule" as const, ruleKind: "requirements" as const, ruleId: "req-multi" },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture should apply: ${applied.rejection.message}`);

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.cascade).toEqual([]);
    expect(diff.direct).toHaveLength(6);

    const after = (key: string) => diff.direct.find((entry) => entry.key === key);
    const newSequences = diff.direct.filter(
      (entry) => entry.key.startsWith("rule:successions:") && entry.kind === "created",
    );
    expect(newSequences).toHaveLength(2);
    expect(newSequences[0].after).toBe(
      "On · “No day shift straight after a night shift” · Night → Day on consecutive days " +
        "for ana, ben, cai, every date: must never happen",
    );
    expect(diff.direct.find((entry) => entry.key.startsWith("rule:counts:") && entry.kind === "created")?.after).toBe(
      "On · “At most 5 night shifts per nurse per month” · At most 5 Night shifts for each " +
        "of ana, ben, cai, across every date: must always hold",
    );
    expect(
      diff.direct.find((entry) => entry.key.startsWith("rule:requirements:") && entry.kind === "created")?.after,
    ).toBe("On · “At least 2 RNs on every night shift” · At least 2 people from RN on Night, every date");

    const edited = after("rule:counts:cnt-nights");
    expect(edited?.kind).toBe("changed");
    expect(edited?.before).toBe(
      "On · “Night cap” · At most 6 Night shifts for each of ana, across every date: must always hold",
    );
    expect(edited?.after).toBe(
      "On · “Night cap” · At most 4 Night shifts for each of ana, across weekends: discouraged (weight -50)",
    );

    const removed = after("rule:requirements:req-multi");
    expect(removed?.kind).toBe("removed");
    expect(removed?.before).toBe("On · “Day or Night cover” · At least 3 people on Day + Night, every date");
    expect(diff.needsReview).toEqual([]);
  });
```

- [ ] **Step 2: Run to check it fails**

Run: `cd web && pnpm vitest run lib/proposal/diff.test.ts`
Expected: FAIL. The new rules are in `cascade`, and `after` is `On · {json}`.

- [ ] **Step 3: Implement**

Change the imports at the top of `diff.ts`:

```ts
import type {
  CardsByKind,
  CountCard,
  RequirementCard,
  ScenarioUiState,
  SuccessionCard,
  UiRequestCell,
  UiShiftType,
} from "@/lib/scenario";
import { EXPRESSION_OPS, substituteTarget } from "@/components/card-editor/expression-model";
```

Replace `ruleBody` with:

```ts
const DATE_SCOPE_WORDS: Record<string, string> = {
  ALL: "every date",
  WEEKDAY: "weekdays",
  WEEKEND: "weekends",
  MONDAY: "Mondays",
  TUESDAY: "Tuesdays",
  WEDNESDAY: "Wednesdays",
  THURSDAY: "Thursdays",
  FRIDAY: "Fridays",
  SATURDAY: "Saturdays",
  SUNDAY: "Sundays",
};

function flattenRefs(refs: unknown): unknown[] {
  if (refs == null) return [];
  return Array.isArray(refs) ? refs.flatMap(flattenRefs) : [refs];
}

function renderDates(refs: unknown): string {
  const list = flattenRefs(refs);
  if (list.length === 0) return "every date";
  return list.map((ref) => DATE_SCOPE_WORDS[String(ref).toUpperCase()] ?? String(ref)).join(", ");
}

/** `everyone` when the refs are empty or ALL (the backend's null-as-all). */
function renderPeople(refs: unknown, everyone: string): string {
  const list = flattenRefs(refs);
  if (list.length === 0 || list.some((ref) => String(ref).toUpperCase() === "ALL")) return everyone;
  return list.map(String).join(", ");
}

function renderStrength(weight: number): string {
  if (weight === Infinity) return "must always hold";
  if (weight === -Infinity) return "must never happen";
  if (weight > 0) return `encouraged (weight ${weight})`;
  if (weight < 0) return `discouraged (weight ${weight})`;
  return "no effect (weight 0)";
}

function describeRequirement(card: RequirementCard): string {
  const n = card.requiredNumPeople;
  const who = renderPeople(card.qualifiedPeople, "");
  const shifts = flattenRefs(card.shiftType).map(String).join(" + ");
  const ideal =
    card.preferredNumPeople != null
      ? `; ideally ${card.preferredNumPeople} (${renderStrength(card.weight)})`
      : "";
  return `At least ${n} ${n === 1 ? "person" : "people"}${who ? ` from ${who}` : ""} on ${shifts}, ${renderDates(card.date)}${ideal}`;
}

function describeSuccession(card: SuccessionCard): string {
  const positions = Array.isArray(card.pattern) ? card.pattern : [card.pattern];
  const pattern = positions
    .map((position) => (Array.isArray(position) ? position.map(String).join(" or ") : String(position)))
    .join(" → ");
  return `${pattern} on consecutive days for ${renderPeople(card.person, "everyone")}, ${renderDates(card.date)}: ${renderStrength(card.weight)}`;
}

/** `null` for a list-shaped or contracted-hours count: no single sentence says it honestly. */
function describeCount(card: CountCard): string | null {
  if (typeof card.expression !== "string" || typeof card.target !== "number") return null;
  const op = EXPRESSION_OPS.find((candidate) => candidate.value === card.expression);
  if (!op) return null;
  const amount = op.title.includes("T")
    ? substituteTarget(op.title, card.target)
    : `${op.title} ${card.target}`;
  const shifts = flattenRefs(card.countShiftTypes).map(String).join(" + ");
  return `${amount} ${shifts} shifts for each of ${renderPeople(card.person, "everyone")}, across ${renderDates(card.countDates)}: ${renderStrength(card.weight)}`;
}

/** The plain sentence for the families the assistant authors; `null` keeps the opaque form. */
function describeRule(kind: keyof CardsByKind, card: Record<string, unknown>): string | null {
  switch (kind) {
    case "requirements":
      return describeRequirement(card as unknown as RequirementCard);
    case "successions":
      return describeSuccession(card as unknown as SuccessionCard);
    case "counts":
      return describeCount(card as unknown as CountCard);
    default:
      // Pairing and supervision: plain wording arrives with their authoring arms.
      return null;
  }
}

/**
 * A rule's rendered body, markers excluded -- `disabled` is reported as on/off instead.
 * The title is part of the body so a rename alone is still a visible change. The
 * sentence omits coefficients; an assistant edit can only change those by changing the
 * counted shifts, which the sentence does show.
 */
function ruleBody(card: Record<string, unknown>, kind: keyof CardsByKind): string {
  const { uid: _uid, disabled, applied: _applied, ...rest } = card;
  const plain = describeRule(kind, card);
  if (plain === null) return `${disabled ? "Off" : "On"} · ${stableStringify(rest)}`;
  const title = typeof card.description === "string" ? card.description.trim() : "";
  return `${disabled ? "Off" : "On"} · ${title ? `“${title}” · ` : ""}${plain}`;
}
```

In `diffScenarioDocuments`, change the rule `render` line to pass the kind:

```ts
        render: (card) => ruleBody(card as unknown as Record<string, unknown>, kind),
```

Replace `directKeys`'s signature and add the rule cases:

```ts
function directKeys(
  commands: readonly AssistantCommandV1[],
  before: ScenarioUiState,
  after: ScenarioUiState,
): Set<string> {
  const keys = new Set<string>();
  // A new card's uid is minted by the host, so the command cannot name it; every card
  // of that kind the change created is what the user asked for (no cascade creates a
  // rule card).
  const created = (kind: keyof CardsByKind) => {
    const had = new Set((before.cardsByKind[kind] as readonly AnyRuleCard[]).map((c) => c.uid));
    for (const card of after.cardsByKind[kind] as readonly AnyRuleCard[]) {
      if (!had.has(card.uid)) keys.add(`rule:${kind}:${card.uid}`);
    }
  };
  for (const command of commands) {
    switch (command.type) {
```

Keep every existing case unchanged. Then add, after `add_shift_group`:

```ts
      case "add_succession_rule":
        created("successions");
        break;
      case "add_count_rule":
        created("counts");
        break;
      case "add_staffing_requirement":
        created("requirements");
        break;
      case "edit_succession_rule":
        keys.add(`rule:successions:${command.ruleId}`);
        break;
      case "edit_count_rule":
        keys.add(`rule:counts:${command.ruleId}`);
        break;
      case "edit_staffing_requirement":
        keys.add(`rule:requirements:${command.ruleId}`);
        break;
      case "remove_rule":
        keys.add(`rule:${command.ruleKind}:${command.ruleId}`);
        break;
```

In `deriveProposalDiff`, change `const named = directKeys(commands);` to:

```ts
  const named = directKeys(commands, before, after);
```

- [ ] **Step 4: Run to check it passes, plus the suites that render diffs**

Run: `cd web && pnpm vitest run lib/proposal components/ai/assistant-proposal.test.tsx lib/store/assistant-proposal.test.ts lib/repository/assistant-apply.test.ts`
Expected: PASS. An existing assertion can pin `On · {"…"}` for a requirement change made by `set_rule_enabled` or `set_staffing_requirement_people`. If so, update it to the sentence form and say so in the commit message. Do not revert the new text. A string mismatch in the new test is most likely spacing around `·`, or `×`/curly quotes. Fix the implementation to match the test, because the test text is the product copy.

- [ ] **Step 5: Commit**

```bash
git add web/lib/proposal/diff.ts web/lib/proposal/diff.test.ts
git commit -m "feat(assistant): preview states rules in plain words, new rules as asked-for"
```

---

### Task 8: Help content, then the whole-branch gates

**Files:**
- Modify: `web/lib/capability/help-content.ts` (`ai-assistant-conversation` `nurseFacingSummary`)
- Regenerate: `web/lib/capability/registry.generated.ts`
- Test: `web/lib/capability/registry.generated.test.ts` (the existing stale-manifest gate, no edits)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a new manifest hash.

- [ ] **Step 1: Update the help content**

```ts
    nurseFacingSummary:
      "Once it is on, the assistant can read the set-up you have open, explain how the app " +
      "works, and suggest which rule expresses a policy you describe. It can also prepare " +
      "changes — the roster period, adding, editing, switching off or deleting staffing " +
      "requirements, shift sequence rules and shift count rules, deleting any rule, moving " +
      "leave, and adding new shifts and shift groups — which you review and apply yourself. " +
      "It cannot change the roster on its own, it cannot yet create pairing or supervision " +
      "rules, and it cannot edit or delete existing shifts. It is not a source of " +
      "employment, legal or clinical-safety authority.",
```

- [ ] **Step 2: Run the manifest gate to check it fails**

Run: `cd web && pnpm vitest run lib/capability/registry.generated.test.ts`
Expected: FAIL (the manifest is stale).

- [ ] **Step 3: Regenerate**

Run: `cd web && pnpm capability:generate`
Expected: only `manifestSha256` and `canonicalByteLength` change in `registry.generated.ts`. Inspect the diff.

- [ ] **Step 4: Run the suites that embed the union or the registry**

Run: `cd web && pnpm vitest run lib/proposal lib/ai lib/capability lib/repository/assistant-apply.test.ts lib/store/assistant-proposal.test.ts components/ai components/card-editor components/requirements components/successions components/counts components/guided-rules`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd web && pnpm typecheck && pnpm lint:oxlint && pnpm lint:ast-grep`
Expected: no errors. If `import/no-cycle` fires, trace the reported cycle. No `components/*-model.ts` imports `lib/proposal`, so a cycle means a new import was added in the wrong direction. Report it rather than suppress it.

- [ ] **Step 6: Manual smoke (optional, needs a dev server and an AI key)**

On `/rules`, ask: "No day shift straight after a night shift for everyone, and at most 5 nights per nurse this month." Expected: one Preview with two asked-for rows in plain words ("Night → Day on consecutive days for …: must never happen" and "At most 5 Night shifts for each of …: must always hold"). Nothing changes until you press Apply. After Apply, the rules appear on the Shift sequences and Shift counts screens and can be opened with Edit.

- [ ] **Step 7: Commit**

```bash
git add web/lib/capability/help-content.ts web/lib/capability/registry.generated.ts
git commit -m "docs(help): assistant can propose rule changes"
```

---

## Self-Review

- **Spec coverage.** Create and edit for requirements (Task 4), successions (Task 2) and counts (Task 3), through the editors' own validators and builders. Delete for all five families (Task 5). Task 2 tests "no day after night" and Task 3 tests "at most 5 nights". Task 4 tests "2 RNs every night" and "senior every day" over a shift group. Each appears again in the Task 7 preview test or the Task 6 parity rows. "Ana and Ben" is moved to the follow-up plan, with the reason stated. Parity: Task 6. Plain-words preview: Task 7. Locked lists with dated reasons: Tasks 2-5. Help text: Task 8. React-free import: Task 1 guard.
- **Placeholder scan.** No TBD. The code moves in Task 1 give exact line ranges, which are copied verbatim.
- **Type consistency.** Sequence fields are `description`, `people`, `pattern`, `dates` and `weight`. Count fields add `shiftTypes`, `expression` and `target`. Requirement fields are `shiftType`, `qualifiedPeople` and `requiredNumPeople`. Edits add `ruleId`, and remove uses `ruleKind` and `ruleId`. Commands, operations, tests, the wire representatives and the diff test use the same names. Task 2 defines the helpers, and Tasks 3-5 use them unchanged: `ruleName`, `newRuleUid`, `keepMarkers`, `withCards`, `firstUnoffered`, `dateScopeRejection`, `firstFormError` and `DateScopeBuilders`.
- **Review Focus.** Each of the five lines has a named test in Task 2, 3, 4 or 7.

## Decisions

1. Scope: requirements, successions and counts get create and edit. Remove covers all five families. Affinities and coverings get their own plan.
2. One arm per family per action. Edit arms replace the fields they carry, and everything else comes from the editor's own loader.
3. Weight is a string parsed by the Weight box's own `parseWeightInput`.
4. The pure halves of three field files move to `.ts` siblings (re-exported, no importer changes). This lets `lib/proposal` call the real validators, and a guard test enforces it.
5. New uids are deterministic digests. `applyRequirementPatch`'s `add` gets an optional `uid`, which the UI does not pass.
6. Dates and people follow what the pickers offer: no mixed date scopes, no `ALL` people for sequences and counts, and ISO dates only.
7. The requirement arms carry no preferred count, weight or coefficients. Edits keep the stored ones.

## Follow-ups

- **Plan `2026-09-2x-assistant-rule-ops-affinities-coverings`:** `add_/edit_affinity_rule` and `add_/edit_covering_rule`, with plain-words preview for both. They use the same pattern over `affinities-model.ts` and `coverings-model.ts`. Point `affinities-model`'s `weight-field` import at `weight-value`. It must make `"Ana and Ben should not work the same night"` expressible and tested (affinity `people1: ["ana"]`, `people2: ["ben"]`, `shiftTypes: ["Night"]`, negative weight).
- `get_schedule_section("rules")` returns `null` for `±Infinity` weights, because `readSection` uses `JSON.stringify`. The fix is to reuse `stringifyScenario`'s replacer in `use-context-tools.ts` `readSection`. This is a separate one-file change.
- Preferred head count, weight and shift coefficients on the requirement arms, and coefficients on the count arms.
- Contracted-hours counts (`contracted-model.ts`) and the list-shaped fallbacks.

## Open Questions

1. **Weight as text or as a strength enum (`must`/`never`/`avoid`/`prefer`)?** Recommended: text. It uses the UI's own parser for exact parity, and it keeps every weight the UI allows. An enum adds a second vocabulary to keep in step with the Weight box.
2. **Accept `people: ["ALL"]` for sequences and counts by expanding it to every person?** Recommended: no. The screens cannot express it. An expanded list stops covering new staff. Refuse it with a hint, as the plan does.
3. **Make edit arms partial patches, so the model sends only the changed field?** Recommended: no. All fields required is a transport constraint (no optional properties). Full replacement from values the model already has in context is explicit, and the Preview shows the before and after.
4. **Fix the `get_schedule_section` infinity-to-`null` problem in this plan?** Recommended: no. Keep it as the separate follow-up above. The context document already carries `.inf`, and Review Focus 1's test makes a wrong weight fail loudly rather than weaken a rule.
5. **Delete for all five families now, or only for these three?** Recommended: all five. Each editor's delete is the same filter-by-uid. The plain-words gap for a removed pairing or supervision rule is cosmetic (it shows the opaque body) until the follow-up plan.

## Assumptions

- The `ASSISTANT_AUTHORITY_STATEMENT` is already operation-agnostic (checked in `scenario-context.ts`), so this plan does not depend on it.
- The model reads rule uids from `get_schedule_section("rules")`, which returns `cardsByKind` with `uid` (checked in `use-context-tools.ts` `readSection`).
- `@/lib/rules`, `@/lib/dates`, `@/lib/scenario` and `@/components/entity-editor/core` are React-free. Task 1 Step 2 checks this before anything else changes.
- `DateScopeField` emits one chip id alone, or ISO dates (checked in `date-scope-field.tsx` `activeScope`/`textToRefs`). The sequence, count and requirement forms all pass `allValue={["ALL"]}`, or require a non-empty date list.
- Count weight semantics: `x <= T` with `+infinity` means the count must hold. A sequence with `-infinity` means the pattern must never occur (`core/nurse_scheduling/preference_types.py` `shift_count` and `shift_type_successions` add `weight * satisfied`).
- 25 operations per change is enough for a rule set-up conversation.
