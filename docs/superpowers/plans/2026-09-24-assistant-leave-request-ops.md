# Assistant: Leave and Request Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app schedule assistant propose leave, day-off requests and shift requests over a date range, and clear them. The target is one person or one staff group. The code path is the quick paint of the Requests & Leave page. The Preview uses plain words. When a change removes leave, the Preview asks the existing "has Ana agreed?" question.

**Architecture:** Four new arms in `web/lib/proposal/commands.ts`: `add_leave`, `set_off_request`, `set_shift_request`, `clear_requests`. Each arm is one quick-paint gesture on the Requests page: select LEAVE, OFF, a shift or nothing, then drag over the dates. The pure fold of that gesture is `foldGesture`, private in `web/lib/store/paint.ts`. It moves to the store-free module `web/lib/store/paint-fold.ts` as `foldPaintIntents`. The caller supplies the uid minter. The page passes `crypto.randomUUID`. The assistant passes a deterministic minter, so Preview and Apply produce the same document. There is no new confirmation mechanism. `deriveAssumptions` (`web/lib/proposal/assumptions.ts`) compares the before and after documents. It already adds a `leave_cancelled` question for each leave pin that is gone. Thus `clear_requests` gets the same real-world confirmation as `move_leave` with no new code. So does `set_off_request` over a leave day.

**Tech Stack:** Next.js 16 (`web/`), TypeScript, zod v4, vitest 4, zustand v5 (hot store, tests only), CopilotKit 1.66.2 (tool schema transport), oxlint, ast-grep.

**Spec:** No separate spec document. This plan implements the controller request of 2026-09-24 under the product decision in `docs/ai-assistant.md` ("Product decision (2026-09-23)": the assistant proposes anything the UI can do, and every change goes through Preview and the user's Apply). The template is `docs/superpowers/plans/2026-09-23-assistant-add-shift-types.md`. These realistic cases must be expressible and tested:

- "Ana is on annual leave 10-16 Oct".
- "Ben requests no nights next week".
- "Chris wants the long day on 20 Oct".
- The infeasibility repair: "cancel Ana's leave on 14 Oct so she can cover the night. Do it only after Ana agrees."

**Op design (decided):** Four range arms that mirror the page's quick paint, not per-date arms and not a `remove_leave` arm with a confirmation flag.

- The page has two authoring paths. The cell editor changes one person on one date (`commitCellEdit` in `use-requests.ts`). Quick paint drags one selection over many cells (`commitPaintGesture`, then `foldGesture` in `lib/store/paint.ts`). Quick paint expresses "10-16 Oct" in one gesture, and its fold is already pure. One arm is one paint selection over a date range.
- "Cancel Ana's leave on 14 Oct" is `clear_requests` on that date. This is the same as the Clear cell button, or a paint with nothing selected. The confirmation comes from the document comparison of the host, not from the command. `deriveAssumptions` finds the leave pin that is gone and adds `Has Ana agreed to give up their leave on 14?`. The proposal opens as `confirmation_required`. The repository refuses Apply until the user answers (`web/lib/repository/repository.ts`, `confirmation_missing`). The model controls a `confirmation: true` flag on a `remove_leave` arm, so the model can omit it. That is weaker. A separate `remove_leave` arm is a copy of `clear_requests` with the same confirmation.
- Dates are calendar dates (`YYYY-MM-DD`), not roster date ids. Date ids change form with the roster span (`DD`, `MM-DD`, `YYYY-MM-DD`, `web/lib/dates/date-id.ts:66-82`). Thus "14" is ambiguous in a two-month roster. The host maps ISO dates to ids with `generateDateItems`. `move_leave` keeps its date ids. A change to a released arm is out of scope.

## Global Constraints

- The only assistant mutation path is `prepare_scenario_change`. The user confirms in the Preview before a change occurs. Only the host applies.
- Every leave, day-off and shift-request change goes through `foldPaintIntents` (the extracted page fold). Do not write a second reconciliation in `operations.ts`.
- Model-facing dates are `YYYY-MM-DD` calendar dates, inclusive range `startDate`..`endDate`, fully inside the roster period. One day is `startDate === endDate`.
- `weight` is `number | "must" | "never"`. `"must"` = `Infinity`, `"never"` = `-Infinity` (JSON cannot carry infinities). For `set_shift_request`, `0` removes that shift's request, as the paint gesture does. For `set_off_request`, `0` is a plain day-off request, as the cell editor stores it.
- A shift request over a date that holds leave or a day off is skipped, as quick paint skips it (`paint.ts` precedence rule). When no date changes, the host refuses the arm. The message says that a shift request never replaces leave or a day off.
- Person ids use exact identity (`===`), as the matrix does: `7` and `"7"` are different. A staff group id is accepted, because group rows are on the page.
- A shift-request target is a shift code (`String(shift.id)`), a shift group id, or `"ALL"`. These are the paint targets of the page without `OFF` and `LEAVE` (`requests-editor.tsx:104-113`).
- New cells get a deterministic uid (`assistant-<digest>`), unique within the document. Operations stay pure and total: no `crypto.randomUUID()` in `lib/proposal`.
- `lib/proposal` imports only `@/lib/store/paint-fold` and `@/lib/store/types` from `lib/store`, never `@/lib/store` (its index pulls in the store spine). Both files are store-free and React-free.
- No leave type (annual, sick, study): the scenario model has one `leave` kind and the page has one "Paid leave" tab. The model puts the kind of leave in its summary.
- Every arm field is required. Do not use `.optional()` or `.nullable()` (`model-visible-tools.test.ts` asserts properties equal `required`). Each discriminant is a one-member `z.enum([...])`, never `z.literal` (comment in `commands.ts`).
- Add the new arms at the END of both `ASSISTANT_COMMAND_TYPES` and the `z.discriminatedUnion` array, in the same order. Sibling plans add arms at the same time. On rebase, keep every sibling arm and put these four after them in both lists.
- `test_feasibility_candidates` embeds the same union, so diagnostics can test "clear Ana's leave on the 14th" as a candidate. A feasible candidate becomes an ordinary proposal and gets the same `leave_cancelled` confirmation. Accepted and wanted.
- Tests: `cd web && pnpm vitest run <path>`. Gates: `pnpm typecheck`, `pnpm exec oxlint` and `pnpm exec ast-grep scan`. Under pnpm 11, `pnpm lint` can run eslint. Use it only when it runs oxlint. The disk is almost full. Do not run `pnpm install` or `pnpm build`.
- Out of scope (follow-ups): date-group columns (`ALL`/`WEEKDAY`/`WEEKEND`/custom groups), people history, CSV import, the bulk Clear panels, leave types.

## Review Focus

1. The model tries to put Ana on the night of the 14th while she is on leave, without clearing the leave. Expected: refused (`no_effect`), and the message says a shift request never replaces leave or a day off and to clear those dates first. Then the model proposes the clear, which carries the confirmation. (Test: Task 2, `refuses a shift request that would only land on leave`.)
2. A range that crosses a day the person already has off, for example "Ben no nights 19-25 Oct" with a day off on the 21st. Expected: the 21st is left as it is (as quick paint does) and the Preview lists only the dates that change. (Tests: Task 2 `Ben requests no nights next week`, and Task 4 `lists recorded leave and requests date by date`.)
3. A day-off request painted over a leave day destroys the leave without any command saying "leave". Expected: the Preview still asks whether the person agreed to give up that leave. (Test: Task 4, `asks when a day-off request replaces leave`.)
4. The model sends a roster date id ("14") or a date outside the roster period. Expected: "14" fails the schema with the YYYY-MM-DD message. The host refuses an out-of-period date, and the message names the roster period. (Tests: Task 2 schema `refuses leave/request payloads the model must fix itself`, and operations `refuses unknown people, bad dates and dates outside the roster`.)
5. A person whose id is the number `7` and the model sends `"7"`. Expected: refused as unknown, because the matrix keys people by exact identity. (Test: Task 2, `refuses unknown people, bad dates and dates outside the roster`.)

---

## File Structure

- Create `web/lib/store/paint-fold.ts`: `foldPaintIntents` and `MintCellUid`, moved from `paint.ts`. Store-free.
- Create `web/lib/store/paint-fold.test.ts`: unit tests for the fold with an injected minter.
- Modify `web/lib/store/paint.ts`: call `foldPaintIntents(..., () => crypto.randomUUID())`. Delete the private `foldGesture` and `isDayStateCell`.
- Modify `web/lib/proposal/commands.ts`: four arms in the type union, `ASSISTANT_COMMAND_TYPES` and the zod union. The `RequestWeight` type.
- Modify `web/lib/proposal/operations.ts`: `rosterDatesBetween`, `assistantCellUids`, `applyRequestPaint`, four `switch` cases.
- Modify `web/lib/proposal/diff.ts`: plain-words cell text. `directKeys` names the painted coordinates.
- Modify `web/lib/proposal/test-support.ts`: `octoberWard()` fixture.
- Modify `web/lib/capability/help-content.ts` and regenerate `web/lib/capability/registry.generated.ts`.
- Tests: `web/lib/proposal/commands.test.ts`, `operations.test.ts`, `operations.parity.test.ts`, `diff.test.ts`, `assumptions.test.ts`, `proposal.test.ts`, `web/lib/ai/phase-2-absence.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`.

---

### Task 1: Extract the quick-paint fold into a pure module

The assistant must run the page's own fold, but `paint.ts` imports `./commands` (the store command bus). Move the fold, unchanged except for the injected uid minter.

**Files:**
- Create: `web/lib/store/paint-fold.ts`
- Create: `web/lib/store/paint-fold.test.ts`
- Modify: `web/lib/store/paint.ts` (imports, `commitPaintGesture` body, delete `isDayStateCell` and `foldGesture`)
- Regression: `web/lib/store/paint.test.ts` (no edits)

**Interfaces:**
- Consumes: `paintCellKey`, `StagedCoordinate` from `web/lib/store/types.ts`.
- Produces:
  - `export type MintCellUid = (person: PersonRef, date: DateRef, selector: string) => string;` where `selector` is `"leave"`, `"off"` or `` `request:${shiftType}` ``.
  - `export function foldPaintIntents(reqData: readonly UiRequestCell[], staged: ReadonlyMap<string, StagedCoordinate>, mintUid: MintCellUid): UiRequestCell[]`

- [ ] **Step 1: Write the failing test**

Create `web/lib/store/paint-fold.test.ts`:

```ts
// The quick-paint reconciliation, without the store (extracted from `paint.ts`).
//
// `paint.test.ts` still proves the gesture end to end through the command bus; this
// suite pins the pure fold the assistant's leave/request arms share with the page,
// including the one seam the extraction added: new cells get their uid from the
// injected minter.

import { describe, expect, it } from "vitest";
import type { UiRequestCell } from "@/lib/scenario";
import { foldPaintIntents, type MintCellUid } from "./paint-fold";
import { paintCellKey, type StagedCoordinate } from "./types";

const mint: MintCellUid = (person, date, selector) =>
  `new:${String(person)}:${String(date)}:${selector}`;

function stage(entries: [person: string, date: string, intent: StagedCoordinate][]) {
  return new Map(entries.map(([person, date, intent]) => [paintCellKey(person, date), intent]));
}

describe("foldPaintIntents", () => {
  it("mints brand-new cells through the injected minter and keeps a prior day-state uid", () => {
    const reqData: UiRequestCell[] = [{ uid: "old-leave", kind: "leave", person: "ana", date: "02" }];
    const next = foldPaintIntents(
      reqData,
      stage([
        ["ana", "02", { mode: "day-state", dayState: { kind: "off", weight: 5 } }],
        ["ana", "03", { mode: "day-state", dayState: { kind: "leave" } }],
        ["bo", "03", { mode: "requests", deltas: new Map([["N", -5]]) }],
      ]),
      mint,
    );
    expect(next).toEqual([
      { uid: "old-leave", kind: "off", person: "ana", date: "02", weight: 5 },
      { uid: "new:ana:03:leave", kind: "leave", person: "ana", date: "03" },
      {
        uid: "new:bo:03:request:N",
        kind: "request",
        person: "bo",
        date: "03",
        shiftType: "N",
        weight: -5,
      },
    ]);
  });

  it("skips request deltas on a leave day, and weight 0 removes a request", () => {
    const reqData: UiRequestCell[] = [
      { uid: "l", kind: "leave", person: "ana", date: "02" },
      { uid: "r", kind: "request", person: "ana", date: "03", shiftType: "D", weight: 3 },
    ];
    const next = foldPaintIntents(
      reqData,
      stage([
        ["ana", "02", { mode: "requests", deltas: new Map([["N", 5]]) }],
        ["ana", "03", { mode: "requests", deltas: new Map([["D", 0]]) }],
      ]),
      mint,
    );
    expect(next).toEqual([{ uid: "l", kind: "leave", person: "ana", date: "02" }]);
  });

  it("erases a whole coordinate and leaves other coordinates verbatim", () => {
    const reqData: UiRequestCell[] = [
      { uid: "l", kind: "leave", person: "ana", date: "02" },
      { uid: "o", kind: "off", person: "bo", date: "02", weight: 1 },
    ];
    const next = foldPaintIntents(reqData, stage([["ana", "02", { mode: "erase" }]]), mint);
    expect(next).toEqual([{ uid: "o", kind: "off", person: "bo", date: "02", weight: 1 }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && pnpm vitest run lib/store/paint-fold.test.ts`
Expected: FAIL, `Failed to resolve import "./paint-fold"`.

- [ ] **Step 3: Create `web/lib/store/paint-fold.ts`**

```ts
// The quick-paint reconciliation, pure (extracted from `paint.ts`).
//
// ONE FOLD, TWO CALLERS: the Requests page's paint gesture (`commitPaintGesture`)
// and the assistant's leave/request arms (`lib/proposal/operations.ts`). It has no
// store, no React and no clock. The only non-determinism the page needs -- a fresh
// `uid` for a brand-new cell -- is injected, so the assistant can mint the SAME ids
// when it prepares a Preview and when Apply re-derives it.
//
// A coordinate's staged `mode` decides how it folds into the cells at that
// person×date:
//   • erase     → drop every cell at the coordinate.
//   • day-state → XOR replace with a single leave/off cell (drops requests),
//                 preserving an existing day-state cell's `uid` for F2 stability.
//   • requests  → additive per-selector deltas onto existing `request` cells
//                 (weight 0 removes that selector). PRECEDENCE: if the
//                 coordinate already holds a day-state, the delta is SKIPPED -- a
//                 bulk drag must not silently wipe a leave/off pin.
//
// Author-time XOR only: coexisting day-state + request cells that arrive from
// import are preserved until the user actively authors that coordinate.

import type { DateRef, PersonRef, UiRequestCell } from "@/lib/scenario";
import { paintCellKey, type StagedCoordinate } from "./types";

/** Mint a durable `uid` for a brand-new cell. `selector` is `leave`, `off` or `request:<shift>`. */
export type MintCellUid = (person: PersonRef, date: DateRef, selector: string) => string;

/** True for the day-state (`leave`/`off`) arm of a `UiRequestCell`. */
function isDayStateCell(cell: UiRequestCell): boolean {
  return cell.kind === "leave" || cell.kind === "off";
}

/** Reconcile staged per-coordinate intents against a matrix. Untouched coordinates pass through verbatim. */
export function foldPaintIntents(
  reqData: readonly UiRequestCell[],
  staged: ReadonlyMap<string, StagedCoordinate>,
  mintUid: MintCellUid,
): UiRequestCell[] {
  const byCoordinate = new Map<string, UiRequestCell[]>();
  for (const cell of reqData) {
    const key = paintCellKey(cell.person, cell.date);
    const cells = byCoordinate.get(key);
    if (cells) cells.push(cell);
    else byCoordinate.set(key, [cell]);
  }

  for (const [key, intent] of staged) {
    const [person, date] = JSON.parse(key) as [PersonRef, DateRef];
    const existing = byCoordinate.get(key) ?? [];

    if (intent.mode === "erase") {
      byCoordinate.set(key, []);
      continue;
    }

    if (intent.mode === "day-state") {
      const priorDayState = existing.find(isDayStateCell);
      const { dayState } = intent;
      const uid = priorDayState?.uid ?? mintUid(person, date, dayState.kind);
      const cell: UiRequestCell =
        dayState.kind === "leave"
          ? { kind: "leave", person, date, uid }
          : { kind: "off", person, date, weight: dayState.weight, uid };
      byCoordinate.set(key, [cell]);
      continue;
    }

    if (existing.some(isDayStateCell)) continue;

    const bySelector = new Map<string, UiRequestCell>();
    for (const cell of existing) {
      if (cell.kind === "request") bySelector.set(cell.shiftType, cell);
    }
    for (const [selector, weight] of intent.deltas) {
      if (weight === 0) {
        bySelector.delete(selector);
        continue;
      }
      const prev = bySelector.get(selector);
      bySelector.set(selector, {
        kind: "request",
        person,
        date,
        shiftType: selector,
        weight,
        uid: prev?.uid ?? mintUid(person, date, `request:${selector}`),
      });
    }
    byCoordinate.set(key, [...bySelector.values()]);
  }

  return [...byCoordinate.values()].flat();
}
```

- [ ] **Step 4: Point `paint.ts` at it**

In `web/lib/store/paint.ts`, replace the imports:

```ts
import { scenarioCommands } from "./commands";
import { foldPaintIntents } from "./paint-fold";
import type { HotStore } from "./hot-store";
import type { CommandOutcome } from "./authority";
```

Replace the last line of `commitPaintGesture`:

```ts
  // A brand-new cell gets a durable uid at creation so its Workspace identity never
  // depends on array position (T17r review P1). The fold itself lives in
  // `paint-fold.ts`, shared with the assistant's leave/request arms.
  return scenarioCommands.setReqData((current) =>
    foldPaintIntents(current.reqData, staged, () => crypto.randomUUID()),
  );
```

Delete `isDayStateCell` and `foldGesture` from `paint.ts`. Keep the header comment, and add one line to it: "The fold itself is `foldPaintIntents` in `paint-fold.ts`."

- [ ] **Step 5: Run the fold suite and the gesture suite**

Run: `cd web && pnpm vitest run lib/store/paint-fold.test.ts lib/store/paint.test.ts lib/store/hot-store.test.ts components/requests`
Expected: PASS. `paint.test.ts` is unchanged, so it proves the extraction kept the page's behaviour.

- [ ] **Step 6: Commit.** Only with commit authority (repo default: do not commit unless asked).

```bash
git add web/lib/store/paint-fold.ts web/lib/store/paint-fold.test.ts web/lib/store/paint.ts
git commit -m "refactor(requests): extract pure paint fold with injected uid minter"
```

---

### Task 2: Command arms and host operations

Arms and their `switch` cases land together: an arm without a case breaks `tsc`.

**Files:**
- Modify: `web/lib/proposal/commands.ts` (type union, `ASSISTANT_COMMAND_TYPES`, zod union, header comment)
- Modify: `web/lib/proposal/operations.ts` (imports, header comment, new helpers and arm, dispatch)
- Modify: `web/lib/proposal/test-support.ts` (new fixture)
- Test: `web/lib/proposal/commands.test.ts`, `web/lib/proposal/operations.test.ts`
- Modify (locked lists): `web/lib/ai/phase-2-absence.test.ts` (`PROPOSAL_OPERATIONS`), `web/lib/ai/runtime/model-visible-tools.test.ts` (`representative`)

**Interfaces:**
- Consumes:
  - `foldPaintIntents`, `MintCellUid` (Task 1).
  - `paintCellKey`, `StagedCoordinate` from `@/lib/store/types`.
  - `generateDateItems`, `hasCompleteRange`, `isValidIso` from `@/lib/dates`.
  - `RESERVED_SHIFT_TYPE` from `@/lib/scenario`.
  - `proposalDigest`, `stableStringify` from `./digest`.
- Produces:
  - `export type RequestWeight = number | "must" | "never";` in `commands.ts`
  - Arms: `{ type: "add_leave"; personId: PersonRef; startDate: IsoDate; endDate: IsoDate }`, `{ type: "set_off_request"; personId: PersonRef; startDate: IsoDate; endDate: IsoDate; weight: RequestWeight }`, `{ type: "set_shift_request"; personId: PersonRef; shiftType: string; startDate: IsoDate; endDate: IsoDate; weight: RequestWeight }`, `{ type: "clear_requests"; personId: PersonRef; startDate: IsoDate; endDate: IsoDate }`
  - `ASSISTANT_COMMAND_TYPES` ends with `"add_leave", "set_off_request", "set_shift_request", "clear_requests"`.
  - `export function rosterDatesBetween(state: ScenarioUiState, start: IsoDate, end: IsoDate): { ok: true; ids: DateRef[] } | { ok: false; code: CommandRejectionCode; message: string }` in `operations.ts` (Task 4 uses it).
  - `export function assistantCellUids(reqData: readonly UiRequestCell[]): MintCellUid` in `operations.ts` (Task 3 uses it).
  - `export function octoberWard(): ScenarioUiState` in `test-support.ts` (Tasks 3 and 4 use it).

- [ ] **Step 1: Add the fixture**

Append to `web/lib/proposal/test-support.ts`:

```ts
/**
 * A one-month October ward for the leave/request arms. Date ids are `DD`.
 * 2026-10-01 is a Thursday, so 19-25 Oct is Monday to Sunday ("next week").
 *
 *   • Ana already has leave on the 14th (the infeasibility-repair case);
 *   • Ben has a day off on the 21st and a Day request on the 22nd;
 *   • Chris has a Day request on the 20th.
 */
export function octoberWard(): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-10-01",
    rangeEnd: "2026-10-31",
    staff: [
      { _k: "p1", id: "Ana" },
      { _k: "p2", id: "Ben" },
      { _k: "p3", id: "Chris" },
    ],
    staffGroups: [{ _k: "pg1", id: "Seniors", members: ["Ana", "Chris"] }],
    shifts: [
      { _k: "s1", id: "D", description: "Day" },
      { _k: "s2", id: "L", description: "Long day" },
      { _k: "s3", id: "N", description: "Night" },
    ],
    shiftGroups: [{ _k: "sg1", id: "Nights", members: ["N"] }],
    reqData: [
      { uid: "ana-leave-14", person: "Ana", date: "14", kind: "leave" },
      { uid: "ben-off-21", person: "Ben", date: "21", kind: "off", weight: 5 },
      { uid: "ben-req-22", person: "Ben", date: "22", kind: "request", shiftType: "D", weight: 3 },
      { uid: "chris-req-20", person: "Chris", date: "20", kind: "request", shiftType: "D", weight: 2 },
    ],
  };
}
```

- [ ] **Step 2: Write the failing schema tests**

Append inside the existing `describe("parseAssistantCommands", ...)` in `web/lib/proposal/commands.test.ts`:

```ts
  it("accepts the leave and request arms with calendar dates", () => {
    const result = parseAssistantCommands([
      { type: "add_leave", personId: "Ana", startDate: "2026-10-10", endDate: "2026-10-16" },
      {
        type: "set_shift_request",
        personId: "Ben",
        shiftType: "N",
        startDate: "2026-10-19",
        endDate: "2026-10-25",
        weight: -5,
      },
      {
        type: "set_shift_request",
        personId: "Chris",
        shiftType: "L",
        startDate: "2026-10-20",
        endDate: "2026-10-20",
        weight: "must",
      },
      {
        type: "set_off_request",
        personId: 7,
        startDate: "2026-10-21",
        endDate: "2026-10-21",
        weight: 0,
      },
      { type: "clear_requests", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses leave/request payloads the model must fix itself", () => {
    const refused: unknown[] = [
      // A roster date id instead of a calendar date.
      [{ type: "add_leave", personId: "Ana", startDate: "14", endDate: "14" }],
      // Words instead of a date.
      [{ type: "add_leave", personId: "Ana", startDate: "10 Oct", endDate: "16 Oct" }],
      // An end date omitted.
      [{ type: "add_leave", personId: "Ana", startDate: "2026-10-10" }],
      // Infinity spelled as a string: the hard values are "must" / "never".
      [
        {
          type: "set_shift_request",
          personId: "Ben",
          shiftType: "N",
          startDate: "2026-10-19",
          endDate: "2026-10-25",
          weight: "-Infinity",
        },
      ],
      // Weight omitted: the model must say how strongly.
      [
        {
          type: "set_off_request",
          personId: "Ben",
          startDate: "2026-10-21",
          endDate: "2026-10-21",
        },
      ],
      // Content alongside targets: a leave type or note is not a field.
      [
        {
          type: "add_leave",
          personId: "Ana",
          startDate: "2026-10-10",
          endDate: "2026-10-16",
          description: "annual leave",
        },
      ],
    ];
    for (const payload of refused) {
      expect(parseAssistantCommands(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });
```

- [ ] **Step 3: Write the failing operation tests**

Change the import line of `web/lib/proposal/operations.test.ts` to `import { octoberWard, proposalScenario } from "./test-support";` and append:

```ts
describe("leave and request arms", () => {
  const leave = (personId: string | number, startDate: string, endDate = startDate) => ({
    type: "add_leave" as const,
    personId,
    startDate,
    endDate,
  });
  const off = (
    personId: string | number,
    startDate: string,
    endDate: string,
    weight: number | "must" | "never",
  ) => ({ type: "set_off_request" as const, personId, startDate, endDate, weight });
  const wants = (
    personId: string | number,
    shiftType: string,
    startDate: string,
    endDate: string,
    weight: number | "must" | "never",
  ) => ({ type: "set_shift_request" as const, personId, shiftType, startDate, endDate, weight });
  const clear = (personId: string | number, startDate: string, endDate = startDate) => ({
    type: "clear_requests" as const,
    personId,
    startDate,
    endDate,
  });
  /** The cells at one coordinate, without their uids. */
  const at = (state: ScenarioUiState, person: string, date: string) =>
    state.reqData
      .filter((cell) => cell.person === person && cell.date === date)
      .map(({ uid: _uid, ...rest }) => rest);

  it("Ana is on annual leave 10-16 Oct", () => {
    const result = applyAssistantCommand(octoberWard(), leave("Ana", "2026-10-10", "2026-10-16"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leaveDates = result.next.reqData
      .filter((cell) => cell.person === "Ana" && cell.kind === "leave")
      .map((cell) => cell.date)
      .sort();
    expect(leaveDates).toEqual(["10", "11", "12", "13", "14", "15", "16"]);
    // The leave already on the 14th is the same agreement: its identity survives.
    expect(result.next.reqData.find((c) => c.person === "Ana" && c.date === "14")?.uid).toBe(
      "ana-leave-14",
    );
    // Every cell carries a durable uid (Workspace emission refuses one without).
    expect(result.next.reqData.every((cell) => Boolean(cell.uid))).toBe(true);
  });

  it("mints the same uids every time, so Apply reproduces the Preview", () => {
    const command = leave("Ana", "2026-10-10", "2026-10-16");
    const first = applyAssistantCommand(octoberWard(), command);
    const second = applyAssistantCommand(octoberWard(), command);
    expect(first).toEqual(second);
  });

  it("Ben requests no nights next week", () => {
    const result = applyAssistantCommand(
      octoberWard(),
      wants("Ben", "N", "2026-10-19", "2026-10-25", -5),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nights = result.next.reqData.filter(
      (cell) => cell.person === "Ben" && cell.kind === "request" && cell.shiftType === "N",
    );
    // The 21st is his day off: skipped, as quick paint skips it.
    expect(nights.map((cell) => cell.date).sort()).toEqual(["19", "20", "22", "23", "24", "25"]);
    expect(nights.every((cell) => cell.kind === "request" && cell.weight === -5)).toBe(true);
    expect(at(result.next, "Ben", "21")).toEqual([
      { kind: "off", person: "Ben", date: "21", weight: 5 },
    ]);
    // His Day request on the 22nd stays alongside.
    expect(at(result.next, "Ben", "22")).toHaveLength(2);
  });

  it("Chris would like the long day on 20 Oct", () => {
    const result = applyAssistantCommand(
      octoberWard(),
      wants("Chris", "L", "2026-10-20", "2026-10-20", 5),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.next, "Chris", "20")).toEqual([
      { kind: "request", person: "Chris", date: "20", shiftType: "D", weight: 2 },
      { kind: "request", person: "Chris", date: "20", shiftType: "L", weight: 5 },
    ]);
  });

  it('maps "must" and "never" to hard pins', () => {
    const result = applyAssistantCommands(octoberWard(), [
      wants("Chris", "L", "2026-10-05", "2026-10-05", "must"),
      wants("Chris", "N", "2026-10-06", "2026-10-06", "never"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.next, "Chris", "05")[0]).toMatchObject({ weight: Infinity });
    expect(at(result.next, "Chris", "06")[0]).toMatchObject({ weight: -Infinity });
  });

  it("cancels Ana's leave on 14 Oct and puts her on the night, in one change", () => {
    const result = applyAssistantCommands(octoberWard(), [
      clear("Ana", "2026-10-14"),
      wants("Ana", "N", "2026-10-14", "2026-10-14", "must"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.next, "Ana", "14")).toEqual([
      { kind: "request", person: "Ana", date: "14", shiftType: "N", weight: Infinity },
    ]);
  });

  it("refuses a shift request that would only land on leave", () => {
    const result = applyAssistantCommand(
      octoberWard(),
      wants("Ana", "N", "2026-10-14", "2026-10-14", "must"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("no_effect");
    expect(result.rejection.message).toContain("never replaces leave or a day off");
    expect(result.rejection.message).toContain("clear those dates first");
  });

  it("removes one shift request with weight 0", () => {
    const result = applyAssistantCommand(
      octoberWard(),
      wants("Ben", "D", "2026-10-22", "2026-10-22", 0),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(at(result.next, "Ben", "22")).toEqual([]);
  });

  it("replaces leave with a day-off request, as painting OFF does", () => {
    const result = applyAssistantCommand(octoberWard(), off("Ana", "2026-10-14", "2026-10-14", 0));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(at(result.next, "Ana", "14")).toEqual([
        { kind: "off", person: "Ana", date: "14", weight: 0 },
      ]);
    }
  });

  it("accepts a staff group row, a shift group and ALL", () => {
    const result = applyAssistantCommands(octoberWard(), [
      wants("Seniors", "Nights", "2026-10-05", "2026-10-05", -3),
      wants("Ben", "ALL", "2026-10-01", "2026-10-03", 1),
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses unknown people, bad dates and dates outside the roster", () => {
    const withNumericId: ScenarioUiState = {
      ...octoberWard(),
      staff: [...octoberWard().staff, { id: 7 }],
    };
    const cases: [ScenarioUiState, Parameters<typeof applyAssistantCommand>[1], string, string][] =
      [
        [octoberWard(), leave("Dan", "2026-10-10"), "unknown_target", '"Dan"'],
        // Exact identity: the matrix never collapses 7 and "7".
        [withNumericId, leave("7", "2026-10-10"), "unknown_target", '"7"'],
        [
          octoberWard(),
          leave("Ana", "2026-10-30", "2026-11-02"),
          "unknown_target",
          "2026-10-01 to 2026-10-31",
        ],
        [octoberWard(), leave("Ana", "2026-10-16", "2026-10-10"), "invalid_value", "end date"],
        [octoberWard(), leave("Ana", "2026-10-32"), "invalid_value", "real calendar dates"],
        [
          { ...octoberWard(), rangeStart: "", rangeEnd: "" },
          leave("Ana", "2026-10-10"),
          "cascade_unavailable",
          "no roster period",
        ],
        [
          octoberWard(),
          wants("Ben", "OFF", "2026-10-19", "2026-10-19", 5),
          "invalid_value",
          "not a shift request",
        ],
        [
          octoberWard(),
          wants("Ben", "X", "2026-10-19", "2026-10-19", 5),
          "unknown_target",
          '"X"',
        ],
      ];
    for (const [state, command, code, text] of cases) {
      const result = applyAssistantCommand(state, command);
      expect(result.ok, JSON.stringify(command)).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code, JSON.stringify(command)).toBe(code);
      expect(result.rejection.message).toContain(text);
    }
    expect(applyAssistantCommand(withNumericId, leave(7, "2026-10-10")).ok).toBe(true);
  });

  it("refuses a change that would change nothing, saying why", () => {
    const again = applyAssistantCommand(octoberWard(), leave("Ana", "2026-10-14"));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.rejection.message).toContain("already on leave");
    const empty = applyAssistantCommand(octoberWard(), clear("Ana", "2026-10-01"));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.rejection.message).toContain("nothing recorded");
  });
});
```

Make sure that `operations.test.ts` has `import type { ScenarioUiState } from "@/lib/scenario";` at the top.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts`
Expected: FAIL. The new schema payloads do not parse, and the operation cases fail on the unknown arm types.

- [ ] **Step 5: Add the arms to `commands.ts`**

After the shift-arm paragraph of the header comment, add:

```ts
// `add_leave` / `set_off_request` / `set_shift_request` / `clear_requests` are the
// Requests page's quick paint (select LEAVE, OFF, a shift, or nothing, then drag over
// dates) and compile to its own fold (`foldPaintIntents`). Removing someone's leave is
// an agreement with them; `assumptions.ts` asks about it from the document diff, so no
// arm carries a confirmation flag the model could leave out.
```

Change the type import line to also bring `IsoDate` (it is already imported) and extend the union. Replace the terminating `;` of the `add_shift_group` arm:

```ts
  | { type: "add_shift_group"; groupId: string; members: string[] }
  /** Leave for one person (or staff group row) on every date from `startDate` to `endDate` -- painting LEAVE. */
  | { type: "add_leave"; personId: PersonRef; startDate: IsoDate; endDate: IsoDate }
  /** A day-off request over a date range -- painting OFF at `weight`. */
  | {
      type: "set_off_request";
      personId: PersonRef;
      startDate: IsoDate;
      endDate: IsoDate;
      weight: RequestWeight;
    }
  /** A wish for, or against, one shift (or shift group, or ALL) over a date range -- painting that shift. */
  | {
      type: "set_shift_request";
      personId: PersonRef;
      shiftType: string;
      startDate: IsoDate;
      endDate: IsoDate;
      weight: RequestWeight;
    }
  /** Remove everything recorded on those dates -- Clear cell / painting with nothing selected. */
  | { type: "clear_requests"; personId: PersonRef; startDate: IsoDate; endDate: IsoDate };

/** A request strength: a finite number, or a hard pin. JSON cannot carry an infinity, so the pins are words. */
export type RequestWeight = number | "must" | "never";
```

Extend the list:

```ts
export const ASSISTANT_COMMAND_TYPES = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
  "add_shift_type",
  "add_shift_group",
  "add_leave",
  "set_off_request",
  "set_shift_request",
  "clear_requests",
] as const satisfies readonly AssistantCommandType[];
```

After `clockSchema`, add:

```ts
const requestPersonSchema = refSchema.describe(
  "The person's id exactly as the staff list reports it, or a staff group id to record it " +
    "on that group's row.",
);
const startDateSchema = isoDateSchema.describe(
  "First calendar date, YYYY-MM-DD, inside the roster period.",
);
const endDateSchema = isoDateSchema.describe(
  "Last calendar date, YYYY-MM-DD, inclusive. The same as startDate for a single day.",
);
/** Shape only: a finite number or a hard pin. The host maps "must"/"never" to ±Infinity. */
const requestWeightSchema = z.union([z.number(), z.enum(["must", "never"])]);
```

Append at the END of the `z.discriminatedUnion("type", [...])` array:

```ts
  z.strictObject({
    type: z.enum(["add_leave"]),
    personId: requestPersonSchema,
    startDate: startDateSchema,
    endDate: endDateSchema,
  }),
  z.strictObject({
    type: z.enum(["set_off_request"]),
    personId: requestPersonSchema,
    startDate: startDateSchema,
    endDate: endDateSchema,
    weight: requestWeightSchema.describe(
      "How much they want those days off: a positive number wants them (e.g. 5), 0 is a plain " +
        'day-off request, a negative number would rather not be off. "must" makes it a hard ' +
        "rule; use it only when the user says it is not negotiable. Replaces anything already " +
        "on those dates, including leave.",
    ),
  }),
  z.strictObject({
    type: z.enum(["set_shift_request"]),
    personId: requestPersonSchema,
    shiftType: z
      .string()
      .describe('A shift code or shift group id from the schedule, or "ALL" for any shift.'),
    startDate: startDateSchema,
    endDate: endDateSchema,
    weight: requestWeightSchema.describe(
      "Positive wants that shift (e.g. 5), negative does not want it (e.g. -5); larger is " +
        'stronger. "must" / "never" make it a hard rule; use them only when the user says it ' +
        "is not negotiable. 0 removes their existing request for that shift. Dates with leave " +
        "or a day off are left as they are.",
    ),
  }),
  z
    .strictObject({
      type: z.enum(["clear_requests"]),
      personId: requestPersonSchema,
      startDate: startDateSchema,
      endDate: endDateSchema,
    })
    .describe(
      "Remove everything recorded for that person on those dates: leave, day-off and shift " +
        "requests. Removing leave makes the preview ask the user to confirm the person agreed. " +
        "To free someone on leave to cover a shift, tell the user to ask them first, and " +
        "propose this as that question, never as a decision.",
    ),
```

- [ ] **Step 6: Add the host operation to `operations.ts`**

Extend the header comment's VALIDATION PARITY section:

```ts
// The leave/request arms are one quick-paint gesture each and run the page's own
// fold (`foldPaintIntents`, `lib/store/paint-fold.ts`, store- and React-free). The
// only difference is the uid minter: the page mints random ids, the host mints
// deterministic ones so Apply reproduces the Preview exactly.
```

Change the imports:

```ts
import {
  applyRangeChange,
  generateDateItems,
  hasCompleteRange,
  isValidIso,
  type DateRange,
} from "@/lib/dates";
import {
  RESERVED_SHIFT_TYPE,
  type CardsByKind,
  type DateRef,
  type IsoDate,
  type PersonRef,
  type RequirementCard,
  type ScenarioUiState,
  type UiRequestCell,
  type Weight,
} from "@/lib/scenario";
```

and after the `shiftTypesDescriptor` import:

```ts
import { foldPaintIntents, type MintCellUid } from "@/lib/store/paint-fold";
import { paintCellKey, type StagedCoordinate } from "@/lib/store/types";
import type { AssistantCommandV1, RequestWeight } from "./commands";
import { proposalDigest, stableStringify } from "./digest";
```

(Replace the existing `import type { AssistantCommandV1 } from "./commands";`.)

Add after `withCoordinateCells`:

```ts
/**
 * The roster date ids from `start` to `end` (calendar dates, inclusive), or why not.
 * Shared with `diff.ts`, which names the same coordinates as asked-for.
 */
export function rosterDatesBetween(
  state: ScenarioUiState,
  start: IsoDate,
  end: IsoDate,
): { ok: true; ids: DateRef[] } | { ok: false; code: CommandRejectionCode; message: string } {
  const range: DateRange = { start: state.rangeStart, end: state.rangeEnd };
  if (!hasCompleteRange(range)) {
    return {
      ok: false,
      code: "cascade_unavailable",
      message: "This schedule has no roster period yet, so leave and request dates cannot be checked.",
    };
  }
  if (!isValidIso(start) || !isValidIso(end)) {
    return { ok: false, code: "invalid_value", message: "Those are not real calendar dates." };
  }
  if (end < start) {
    return {
      ok: false,
      code: "invalid_value",
      message: "The end date must be on or after the start date.",
    };
  }
  if (start < range.start || end > range.end) {
    const asked = start === end ? start : `${start} to ${end}`;
    return {
      ok: false,
      code: "unknown_target",
      message: `${asked} is not inside the roster period (${range.start} to ${range.end}).`,
    };
  }
  // ISO strings compare correctly as text.
  const ids = generateDateItems(range)
    .filter((item) => item.iso >= start && item.iso <= end)
    .map((item) => item.id);
  return { ok: true, ids };
}

/**
 * The host's uid minter for new request cells: deterministic, so preparing and
 * applying the same change produce the same document, and unique within `reqData`
 * (a moved leave keeps its old uid, so a digest of the coordinate alone could clash).
 */
export function assistantCellUids(reqData: readonly UiRequestCell[]): MintCellUid {
  const used = new Set(reqData.flatMap((cell) => (cell.uid ? [cell.uid] : [])));
  return (person, date, selector) => {
    for (let n = 0; ; n += 1) {
      const uid = `assistant-${proposalDigest({ person, date, selector, n })}`;
      if (!used.has(uid)) {
        used.add(uid);
        return uid;
      }
    }
  };
}
```

Insert before `/** Validate and apply exactly one command against \`state\`. */`:

```ts
type RequestPaintCommand = Extract<
  AssistantCommandV1,
  { type: "add_leave" | "set_off_request" | "set_shift_request" | "clear_requests" }
>;

function toWeight(weight: RequestWeight): Weight {
  if (weight === "must") return Infinity;
  if (weight === "never") return -Infinity;
  return weight;
}

const NOTHING_TO_CHANGE: Record<RequestPaintCommand["type"], (who: string) => string> = {
  add_leave: (who) => `${who} is already on leave on every one of those dates.`,
  set_off_request: (who) => `${who} already has that day-off request on every one of those dates.`,
  set_shift_request: (who) =>
    `Nothing would change: ${who} already has that request, or has leave or a day off, on ` +
    "every one of those dates. A shift request never replaces leave or a day off, so clear " +
    "those dates first.",
  clear_requests: (who) => `${who} has nothing recorded on those dates.`,
};

/** The one paint selection this command is, or the refusal. */
function paintIntent(
  state: ScenarioUiState,
  command: RequestPaintCommand,
  index: number,
): { ok: true; intent: StagedCoordinate } | { ok: false; refusal: OperationResult } {
  switch (command.type) {
    case "add_leave":
      return { ok: true, intent: { mode: "day-state", dayState: { kind: "leave" } } };
    case "set_off_request":
      return {
        ok: true,
        intent: { mode: "day-state", dayState: { kind: "off", weight: toWeight(command.weight) } },
      };
    case "clear_requests":
      return { ok: true, intent: { mode: "erase" } };
    case "set_shift_request": {
      const { shiftType } = command;
      if (shiftType === RESERVED_SHIFT_TYPE.off || shiftType === RESERVED_SHIFT_TYPE.leave) {
        return {
          ok: false,
          refusal: reject(
            index,
            "invalid_value",
            "A day off or leave is not a shift request; record it as a day off or as leave instead.",
          ),
        };
      }
      // The page's paint targets minus OFF/LEAVE (`requests-editor.tsx`, `paintTargets`).
      const selectable = [
        ...state.shifts.map((shift) => String(shift.id)),
        ...state.shiftGroups.map((group) => group.id),
        RESERVED_SHIFT_TYPE.all,
      ];
      if (!selectable.includes(shiftType)) {
        return {
          ok: false,
          refusal: reject(index, "unknown_target", `There is no shift or shift group "${shiftType}".`),
        };
      }
      return {
        ok: true,
        intent: { mode: "requests", deltas: new Map([[shiftType, toWeight(command.weight)]]) },
      };
    }
  }
}

function applyRequestPaint(
  state: ScenarioUiState,
  command: RequestPaintCommand,
  index: number,
): OperationResult {
  const who = String(command.personId);
  // The matrix rows: people and staff groups, exact identity.
  const isRow =
    state.staff.some((person) => person.id === command.personId) ||
    state.staffGroups.some((group) => group.id === command.personId);
  if (!isRow) {
    return reject(index, "unknown_target", `There is no person or staff group "${who}" on this schedule.`);
  }
  const span = rosterDatesBetween(state, command.startDate, command.endDate);
  if (!span.ok) return reject(index, span.code, span.message);
  const selection = paintIntent(state, command, index);
  if (!selection.ok) return selection.refusal;

  // Staged in date order, exactly as a drag across those cells stages them.
  const staged = new Map(
    span.ids.map((date) => [paintCellKey(command.personId, date), selection.intent] as const),
  );
  const reqData = foldPaintIntents(state.reqData, staged, assistantCellUids(state.reqData));

  // The fold regroups the matrix, so compare only the painted coordinates, order-free.
  const dates = new Set(span.ids);
  const painted = (cells: readonly UiRequestCell[]) =>
    cells
      .filter((cell) => cell.person === command.personId && dates.has(cell.date))
      .map(stableStringify)
      .sort()
      .join("\n");
  if (painted(reqData) === painted(state.reqData)) {
    return reject(index, "no_effect", NOTHING_TO_CHANGE[command.type](who));
  }
  return { ok: true, next: { ...state, reqData } };
}
```

Add to the `switch` in `applyAssistantCommand`:

```ts
    case "add_shift_group":
      return applyAddShiftGroup(state, command, index);
    case "add_leave":
    case "set_off_request":
    case "set_shift_request":
    case "clear_requests":
      return applyRequestPaint(state, command, index);
```

- [ ] **Step 7: Update the two locked lists, consciously**

In `web/lib/ai/phase-2-absence.test.ts`, replace the comment above `PROPOSAL_OPERATIONS` and the constant:

```ts
// WIDENED DELIBERATELY (2026-09-23, plan assistant-add-shift-types): shift setup is
// Phase-1 scenario authoring, not roster repair, and both arms compile to the Shifts
// page's own primitives. A Phase-2 verb here would still be caught by PHASE_2_VERBS.
// WIDENED AGAIN (2026-09-24, plan assistant-leave-request-ops): leave, day-off and
// shift requests are scenario INPUTS on the Requests page, compiled to its own paint
// fold; none edits a produced roster.
const PROPOSAL_OPERATIONS = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
  "add_shift_type",
  "add_shift_group",
  "add_leave",
  "set_off_request",
  "set_shift_request",
  "clear_requests",
] as const;
```

In `web/lib/ai/runtime/model-visible-tools.test.ts`, add to the `representative` map after `add_shift_group`:

```ts
      add_leave: {
        type: "add_leave",
        personId: "Ana",
        startDate: "2026-10-10",
        endDate: "2026-10-16",
      },
      set_off_request: {
        type: "set_off_request",
        personId: 7,
        startDate: "2026-10-21",
        endDate: "2026-10-21",
        weight: 5,
      },
      set_shift_request: {
        type: "set_shift_request",
        personId: "Ben",
        shiftType: "N",
        startDate: "2026-10-19",
        endDate: "2026-10-25",
        weight: "never",
      },
      clear_requests: {
        type: "clear_requests",
        personId: "Ana",
        startDate: "2026-10-14",
        endDate: "2026-10-14",
      },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts lib/proposal/operations.test.ts lib/ai/phase-2-absence.test.ts lib/ai/runtime/model-visible-tools.test.ts`
Expected: PASS. If `model-visible-tools.test.ts` fails on `weight`, read the wire JSON first. It must arrive as `anyOf: [{ type: "number" }, { type: "string", enum: ["must", "never"] }]`. The CopilotKit 1.66.2 converter supports unions of primitives (refer to `use-proposal-tools.ts:31-43`). If the converter drops or rejects it, STOP and report. The fallback design is in Open Questions 4. Do not change the schema on your own.

- [ ] **Step 9: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors. (`diff.ts`'s `directKeys` switch has no return, so it compiles before Task 4.)

- [ ] **Step 10: Commit.** Only with commit authority.

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/operations.ts web/lib/proposal/test-support.ts web/lib/proposal/commands.test.ts web/lib/proposal/operations.test.ts web/lib/ai/phase-2-absence.test.ts web/lib/ai/runtime/model-visible-tools.test.ts
git commit -m "feat(assistant): leave, day-off and shift request proposal ops"
```

---

### Task 3: Manual-vs-assistant parity

Characterisation tests over the real page code: the quick-paint intent reducer (`computeQuickPaintCellIntent`), the real hot store's staging calls, and the shared fold. They pass on the first run. The mutation check in Step 3 proves that they find a defect.

**Files:**
- Test: `web/lib/proposal/operations.parity.test.ts` (append)

**Interfaces:**
- Consumes: `computeQuickPaintCellIntent` from `@/components/requests/requests-gestures`. `createHotStore` from `@/lib/store/hot-store`. `foldPaintIntents` (Task 1). `assistantCellUids`, `applyAssistantCommand` and `octoberWard` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the parity test**

Add imports at the top of `web/lib/proposal/operations.parity.test.ts`:

```ts
import type { DateRef, PersonRef } from "@/lib/scenario";
import { computeQuickPaintCellIntent } from "@/components/requests/requests-gestures";
import { createHotStore } from "@/lib/store/hot-store";
import { foldPaintIntents } from "@/lib/store/paint-fold";
import { assistantCellUids } from "./operations";
import { octoberWard } from "./test-support";
```

(Merge `assistantCellUids` into the existing `./operations` import and `octoberWard` into the existing `./test-support` import.)

Append:

```ts
describe("leave and request arms are the Requests page's quick paint", () => {
  /**
   * One real paint drag: the page's intent reducer per crossed cell, staged through
   * the real hot store, folded by the shared fold. The dispatch below restates the
   * private `stageCellIntent` in `use-requests.ts` (four calls, no logic of its own).
   * The minter is the host's, so the two documents can be compared exactly.
   */
  function manualPaint(
    state: ScenarioUiState,
    person: PersonRef,
    dates: DateRef[],
    selectedIds: string[],
    weight: number,
  ) {
    const hot = createHotStore();
    hot.getState().beginPaint();
    for (const date of dates) {
      const intent = computeQuickPaintCellIntent(selectedIds, weight);
      if (!intent) continue;
      if (intent.mode === "erase") hot.getState().stagePaintErase(person, date);
      else if (intent.mode === "day-state") {
        hot.getState().stagePaintDayState(person, date, intent.dayState);
      } else {
        for (const [selector, w] of intent.deltas) {
          hot.getState().stagePaintRequestDelta(person, date, selector, w);
        }
      }
    }
    const staged = hot.getState().paint;
    if (!staged) throw new Error("paint gesture did not open");
    return foldPaintIntents(state.reqData, staged, assistantCellUids(state.reqData));
  }

  const days = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => String(from + i).padStart(2, "0"));
  const iso = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;

  // [assistant command, the paint selection a user would make, its weight, dates dragged]
  const matrix: [Parameters<typeof applyAssistantCommand>[1], string[], number, DateRef[]][] = [
    [
      { type: "add_leave", personId: "Ana", startDate: iso(10), endDate: iso(16) },
      ["LEAVE"],
      0,
      days(10, 16),
    ],
    [
      { type: "set_off_request", personId: "Ben", startDate: iso(21), endDate: iso(23), weight: -5 },
      ["OFF"],
      -5,
      days(21, 23),
    ],
    [
      { type: "set_off_request", personId: "Ana", startDate: iso(14), endDate: iso(14), weight: "must" },
      ["OFF"],
      Infinity,
      days(14, 14),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Ben",
        shiftType: "N",
        startDate: iso(19),
        endDate: iso(25),
        weight: -5,
      },
      ["N"],
      -5,
      days(19, 25),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Ben",
        shiftType: "D",
        startDate: iso(22),
        endDate: iso(22),
        weight: 0,
      },
      ["D"],
      0,
      days(22, 22),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Chris",
        shiftType: "L",
        startDate: iso(20),
        endDate: iso(20),
        weight: "never",
      },
      ["L"],
      -Infinity,
      days(20, 20),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Seniors",
        shiftType: "Nights",
        startDate: iso(5),
        endDate: iso(5),
        weight: 3,
      },
      ["Nights"],
      3,
      days(5, 5),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Ana",
        shiftType: "ALL",
        startDate: iso(1),
        endDate: iso(3),
        weight: 1,
      },
      ["ALL"],
      1,
      days(1, 3),
    ],
    [
      { type: "clear_requests", personId: "Ben", startDate: iso(21), endDate: iso(22) },
      [],
      0,
      days(21, 22),
    ],
  ];

  it("produces the same matrix as the paint gesture, cell for cell and uid for uid", () => {
    const state = octoberWard();
    for (const [command, selectedIds, weight, dates] of matrix) {
      const assistant = applyAssistantCommand(state, command);
      expect(assistant.ok, JSON.stringify(command)).toBe(true);
      if (!assistant.ok) continue;
      const personId = (command as { personId: PersonRef }).personId;
      expect(assistant.next.reqData, JSON.stringify(command)).toEqual(
        manualPaint(state, personId, dates, selectedIds, weight),
      );
    }
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd web && pnpm vitest run lib/proposal/operations.parity.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation check (do not commit this)**

In `applyRequestPaint`, change `span.ids.map(...)` to `span.ids.slice(1).map(...)`. Run the parity suite: the multi-date rows must FAIL. Revert. Then in `toWeight`, return `1e6` for `"must"`: the `"must"` row must FAIL. Revert. If no row fails, the assertion is vacuous. Fix the test before you continue.

- [ ] **Step 4: Commit.** Only with commit authority.

```bash
git add web/lib/proposal/operations.parity.test.ts
git commit -m "test(assistant): leave/request op parity with quick paint"
```

---

### Task 4: Preview in plain words, with the confirmation

**Files:**
- Modify: `web/lib/proposal/diff.ts`: the import, `describeCell`, delete `renderWeight`, the `directKeys` signature and cases, and its call in `deriveProposalDiff`.
- Test: `web/lib/proposal/diff.test.ts` (append, and change one existing assertion), `web/lib/proposal/assumptions.test.ts` (append), `web/lib/proposal/proposal.test.ts` (append).

**Interfaces:**
- Consumes: `rosterDatesBetween` and `octoberWard` (Task 2).
- Produces: request-cell text `On leave`. `Wants <shift> (weight n)`, `Would rather not work <shift> (weight -n)`, `Must work <shift>`, `Must not work <shift>`. `Wants the day off (weight n)`, `Would rather not be off (weight -n)`, `Must have the day off`, `Must not have the day off`. Diff keys `cell:<stable person>|<stable date id>` for every painted date that changed.

- [ ] **Step 1: Write the failing tests**

In `web/lib/proposal/diff.test.ts`, change the import to `import { octoberWard, proposalScenario } from "./test-support";`, change the existing assertion `expect(destination?.after).toBe("Leave");` to `expect(destination?.after).toBe("On leave");`, and append inside `describe("deriveProposalDiff", ...)`:

```ts
  it("lists recorded leave and requests date by date, in plain words, as asked-for", () => {
    const before = octoberWard();
    const commands = [
      { type: "add_leave" as const, personId: "Ana", startDate: "2026-10-10", endDate: "2026-10-16" },
      {
        type: "set_shift_request" as const,
        personId: "Ben",
        shiftType: "N",
        startDate: "2026-10-19",
        endDate: "2026-10-25",
        weight: -5,
      },
      {
        type: "set_shift_request" as const,
        personId: "Chris",
        shiftType: "L",
        startDate: "2026-10-20",
        endDate: "2026-10-20",
        weight: 5,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture should apply: ${applied.rejection.message}`);

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.cascade).toEqual([]);
    // Ana's 14th was already leave and Ben's 21st is a day off: neither changes, neither is listed.
    expect(diff.direct.map((entry) => entry.key).sort()).toEqual([
      'cell:"Ana"|"10"',
      'cell:"Ana"|"11"',
      'cell:"Ana"|"12"',
      'cell:"Ana"|"13"',
      'cell:"Ana"|"15"',
      'cell:"Ana"|"16"',
      'cell:"Ben"|"19"',
      'cell:"Ben"|"20"',
      'cell:"Ben"|"22"',
      'cell:"Ben"|"23"',
      'cell:"Ben"|"24"',
      'cell:"Ben"|"25"',
      'cell:"Chris"|"20"',
    ]);
    const entry = (key: string) => diff.direct.find((candidate) => candidate.key === key);
    expect(entry('cell:"Ana"|"10"')).toMatchObject({
      label: "Ana on 10",
      before: null,
      after: "On leave",
      kind: "created",
      scope: "leave-and-requests",
    });
    expect(entry('cell:"Ben"|"22"')).toMatchObject({
      before: "Wants D (weight 3)",
      after: "Wants D (weight 3), Would rather not work N (weight -5)",
      kind: "changed",
    });
    expect(entry('cell:"Chris"|"20"')?.after).toBe("Wants D (weight 2), Wants L (weight 5)");
    expect(diff.capabilityIds).toEqual(["leave-and-requests"]);
    expect(diff.needsReview).toEqual([]);
  });

  it("shows a cancelled leave and the night it frees, as one asked-for change", () => {
    const before = octoberWard();
    const commands = [
      { type: "clear_requests" as const, personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
      {
        type: "set_shift_request" as const,
        personId: "Ana",
        shiftType: "N",
        startDate: "2026-10-14",
        endDate: "2026-10-14",
        weight: "must" as const,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.direct).toEqual([
      {
        key: 'cell:"Ana"|"14"',
        scope: "leave-and-requests",
        label: "Ana on 14",
        before: "On leave",
        after: "Must work N",
        kind: "changed",
      },
    ]);
    expect(diff.cascade).toEqual([]);
  });
```

In `web/lib/proposal/assumptions.test.ts`, add `octoberWard` to the `./test-support` import and append:

```ts
describe("leave and request arms", () => {
  function assumptionsIn(commands: Parameters<typeof applyAssistantCommands>[1]) {
    const before = octoberWard();
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture refused: ${applied.rejection.message}`);
    return deriveAssumptions(before, applied.next, commands);
  }

  it("asks whether the person agreed when a change clears their leave", () => {
    const assumptions = assumptionsIn([
      { type: "clear_requests", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
      {
        type: "set_shift_request",
        personId: "Ana",
        shiftType: "N",
        startDate: "2026-10-14",
        endDate: "2026-10-14",
        weight: "must",
      },
    ]);
    expect(assumptions).toHaveLength(1);
    expect(assumptions[0]).toMatchObject({
      type: "leave_cancelled",
      person: "Ana",
      date: "14",
      toDate: null,
      question: "Has Ana agreed to give up their leave on 14?",
    });
  });

  it("asks when a day-off request replaces leave", () => {
    const assumptions = assumptionsIn([
      { type: "set_off_request", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14", weight: 0 },
    ]);
    expect(assumptions.map((a) => [a.type, a.person, a.date])).toEqual([
      ["leave_cancelled", "Ana", "14"],
    ]);
  });

  it("asks nothing when leave is only recorded or requests change", () => {
    expect(
      assumptionsIn([
        { type: "add_leave", personId: "Ana", startDate: "2026-10-10", endDate: "2026-10-16" },
        {
          type: "set_shift_request",
          personId: "Ben",
          shiftType: "N",
          startDate: "2026-10-19",
          endDate: "2026-10-25",
          weight: -5,
        },
        { type: "clear_requests", personId: "Ben", startDate: "2026-10-21", endDate: "2026-10-22" },
      ]),
    ).toEqual([]);
  });
});
```

In `web/lib/proposal/proposal.test.ts`, add `octoberWard` to the `./test-support` import and append inside the `describe` that holds `"opens as confirmation_required when the change carries an agreement"`:

```ts
  it("opens as confirmation_required when a request change clears someone's leave", () => {
    const proposal = prepared({
      document: octoberWard(),
      commands: [
        { type: "clear_requests", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
      ],
    });
    expect(proposal.status).toBe("confirmation_required");
    expect(proposal.assumptions.map((a) => a.question)).toEqual([
      "Has Ana agreed to give up their leave on 14?",
    ]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && pnpm vitest run lib/proposal/diff.test.ts lib/proposal/assumptions.test.ts lib/proposal/proposal.test.ts`
Expected: FAIL in `diff.test.ts` only. The new entries are in `cascade`, because no command names their keys, and the text is `Leave` or `D (weight 3)`. The assumption and proposal cases already PASS. That is the point of the design: the host derives the confirmation, it is not per arm. Keep them as regression pins.

- [ ] **Step 3: Implement**

In `diff.ts`, add the import:

```ts
import { rosterDatesBetween } from "./operations";
```

Replace `describeCell` and delete `renderWeight`:

```ts
/** A request cell as a ward manager says it. */
function describeCell(cell: UiRequestCell): string {
  if (cell.kind === "leave") return "On leave";
  const [must, never, wants, avoids] =
    cell.kind === "off"
      ? ["Must have the day off", "Must not have the day off", "Wants the day off", "Would rather not be off"]
      : [
          `Must work ${cell.shiftType}`,
          `Must not work ${cell.shiftType}`,
          `Wants ${cell.shiftType}`,
          `Would rather not work ${cell.shiftType}`,
        ];
  if (cell.weight === Infinity) return must;
  if (cell.weight === -Infinity) return never;
  return cell.weight < 0 ? `${avoids} (weight ${cell.weight})` : `${wants} (weight ${cell.weight})`;
}
```

Change `directKeys` to take the after document, and add the cases:

```ts
function directKeys(
  commands: readonly AssistantCommandV1[],
  after: ScenarioUiState,
): Set<string> {
```

```ts
      case "add_leave":
      case "set_off_request":
      case "set_shift_request":
      case "clear_requests": {
        // Every painted date is asked-for, including a leave day a clear removes.
        const span = rosterDatesBetween(after, command.startDate, command.endDate);
        if (!span.ok) break;
        for (const date of span.ids) {
          keys.add(`cell:${stableStringify(command.personId)}|${stableStringify(date)}`);
        }
        break;
      }
```

In `deriveProposalDiff`, change `const named = directKeys(commands);` to `const named = directKeys(commands, after);`.

- [ ] **Step 4: Run to verify they pass, plus the suites that render diffs**

Run: `cd web && pnpm vitest run lib/proposal components/ai lib/store/assistant-proposal.test.ts lib/repository/assistant-apply.test.ts`
Expected: PASS. Another assertion can pin the old cell text (`Leave`, `Prefers off (weight …)`, `<shift> (weight …)`). Change it to the new wording and write this in the commit message. Do not revert the wording.

- [ ] **Step 5: Commit.** Only with commit authority.

```bash
git add web/lib/proposal/diff.ts web/lib/proposal/diff.test.ts web/lib/proposal/assumptions.test.ts web/lib/proposal/proposal.test.ts
git commit -m "feat(assistant): preview shows leave and requests in plain words"
```

---

### Task 5: Help content says the assistant can propose leave and requests

**Files:**
- Modify: `web/lib/capability/help-content.ts` (`leave-and-requests` and `ai-assistant-conversation` `nurseFacingSummary`)
- Regenerate: `web/lib/capability/registry.generated.ts`
- Test: `web/lib/capability/registry.generated.test.ts` (existing stale-manifest gate, no edits)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a new manifest hash in `registry.generated.ts`.

- [ ] **Step 1: Update the help content**

`leave-and-requests`:

```ts
    nurseFacingSummary:
      "Record approved leave, off-days, and each person's shift preferences on a person-by-date " +
      "grid. Approved leave is entered here as leave for those dates; the app has no separate " +
      "leave-approval workflow. The assistant can also prepare leave, day-off and shift " +
      "requests for you to review and apply, and asks you to confirm before it removes anyone's leave.",
```

`ai-assistant-conversation`:

```ts
    nurseFacingSummary:
      "Once it is on, the assistant can read the set-up you have open, explain how the app " +
      "works, and suggest which rule expresses a policy you describe. It can also prepare a few " +
      "kinds of change — the roster period, turning a rule on or off, a staffing head count, " +
      "moving leave, adding new shifts and shift groups, and recording leave, day-off and shift " +
      "requests — which you review and apply yourself. It cannot change the roster on its own, " +
      "and it cannot edit or delete existing shifts. It is not a source of employment, legal or " +
      "clinical-safety authority.",
```

If a sibling plan has already changed this sentence, keep its additions and add "recording leave, day-off and shift requests" to the same list.

- [ ] **Step 2: Run the manifest gate to verify it fails**

Run: `cd web && pnpm vitest run lib/capability/registry.generated.test.ts`
Expected: FAIL, the recomputed manifest hash does not match.

- [ ] **Step 3: Regenerate**

Run: `cd web && pnpm capability:generate`
Expected: only `manifestSha256` and `canonicalByteLength` change in `registry.generated.ts`. Check the diff.

- [ ] **Step 4: Run the affected suites**

Run: `cd web && pnpm vitest run lib/capability lib/ai/phase-2-absence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.** Only with commit authority.

```bash
git add web/lib/capability/help-content.ts web/lib/capability/registry.generated.ts
git commit -m "docs(help): assistant can propose leave and requests"
```

---

### Task 6: Whole-branch gates

**Files:** none new.

- [ ] **Step 1: Run every suite that embeds the union or the fold**

Run: `cd web && pnpm vitest run lib/proposal lib/ai lib/capability lib/store lib/repository/assistant-apply.test.ts components/ai components/requests`
Expected: PASS.

- [ ] **Step 2: Typecheck, lint, ast-grep**

Run: `cd web && pnpm typecheck && pnpm exec oxlint && pnpm exec ast-grep scan`
Expected: no errors. If oxlint flags `@/lib/store/paint-fold` or `@/lib/store/types` in `lib/proposal/operations.ts`, stop and report: no current `no-restricted-imports` entry covers `lib/store` (checked `web/.oxlintrc.json`), so a hit means the config changed.

- [ ] **Step 3: Manual smoke (optional, needs a dev server and an AI key)**

On `/shift-requests` with an October roster, ask the assistant: "Ana is on annual leave 10-16 Oct, Ben wants no nights next week, Chris wants the long day on the 20th." Expected: one Preview lists each changed date in words. There is no confirmation. Nothing changes until Apply. Then ask: "The night of the 14th is short. Can Ana cover it?" Expected: the assistant tells the user to ask Ana. Its Preview shows `Ana on 14: On leave → Must work N` and the question "Has Ana agreed to give up their leave on 14?". Apply stays disabled until the user answers.

---

## Self-Review

- **Spec coverage.**
  - Add leave: Task 2 `add_leave`, test "Ana is on annual leave 10-16 Oct".
  - Request against a shift: test "Ben requests no nights next week".
  - Request for a shift: test "Chris would like the long day on 20 Oct".
  - Day-off requests: `set_off_request`, tests and parity rows.
  - Remove: `clear_requests`, and `set_shift_request` with weight 0.
  - Infeasibility repair with agreement: Task 2 batch test, Task 4 diff, assumption and `confirmation_required` tests.
  - Same confirmation as `move_leave`: `deriveAssumptions` does not change, and it derives `leave_cancelled`. The reason is in **Op design**.
  - The page's own functions: Task 1 extraction. Task 3 parity against `computeQuickPaintCellIntent`, the real hot store and the shared fold.
  - Plain-words Preview with the confirmation: Task 4. `proposal-preview-card.tsx:117-118` shows the question.
  - Locked lists: Task 2 Step 7. Help: Task 5. Leave types: Global Constraints (the model cannot hold them).
- **Placeholder scan.** No TBD or TODO. Every code step has code.
- **Type consistency.** `foldPaintIntents(reqData, staged, mintUid)` and `MintCellUid(person, date, selector)` are the same in Tasks 1-3. `rosterDatesBetween` returns `{ ok, ids }` or `{ ok, code, message }` in Tasks 2 and 4. `assistantCellUids(reqData)` in Tasks 2 and 3. Arm fields `personId`, `startDate`, `endDate`, `weight`, `shiftType` match across schema, type, tests, wire map and parity rows. `octoberWard()` ids (Ana, Ben, Chris, Seniors, D, L, N, Nights) match every test.
- **Review Focus.** Each of the five lines names its test: four in Task 2 (items 1, 2, 4, 5), items 2 and 3 in Task 4.

## Decisions

1. **Four range arms that mirror quick paint:** `add_leave`, `set_off_request`, `set_shift_request`, `clear_requests`. One arm is one paint selection over dates. Thus "10-16 Oct" is one op, not seven, and the 25-op cap stays usable.
2. **No `remove_leave` arm and no confirmation flag.** The page removes leave with Clear cell, or with a paint that has nothing selected. That is `clear_requests`. The host derives the "only after Ana agrees" confirmation from the document diff (`leave_cancelled` in `assumptions.ts`). The same mechanism already guards leave that a range change removes. `move_leave` uses the sibling type `leave_moved` in the same pipeline. A flag that the model sets is weaker, because the model can omit it. The derivation also catches `set_off_request` over a leave day.
3. **Share the fold. Do not copy it.** Move `foldGesture` to `lib/store/paint-fold.ts` with an injected uid minter. Do not write a copy in `operations.ts` behind a parity test.
4. **Deterministic uids** (`assistant-<digest>`, with a clash check). Thus operations stay pure, and Apply produces the same document as the Preview.
5. **Calendar dates, not date ids,** for the new arms. `move_leave` keeps its date ids.
6. **Weight is `number | "must" | "never"`.** This mirrors the ∞ and -∞ buttons of the page with no JSON infinities.
7. **A shift request skips leave and day-off dates,** as paint does. The host refuses it only when no date changes.
8. **Plain-words cell text** in the Preview (`On leave`, `Wants N (weight 5)`, `Must work N`). It replaces `Leave` and `N (weight 5)`.
9. **Staff group rows are accepted,** because the matrix has them.

## Open Questions (each with a recommended answer)

1. **The user did not say how strongly. Which weight does the model send?** Recommended answer: 5 for "wants" and -5 for "does not want". The model states the weight in the proposal summary. The arm descriptions already use 5 and -5 as the example. There is no host default: the model always sends a weight.
2. **A clear over a week of leave. Is it one question per date (7 questions)?** Recommended answer: yes, for now. Each date is a separate agreement, and the existing mechanism works per date. A follow-up can group consecutive dates into one question.
3. **Does recorded leave (`add_leave`) also need a confirmation?** Recommended answer: no. The user states a fact that they know, and Apply is already the decision of the user. Only the removal of an agreement needs "has X agreed".
4. **The CopilotKit converter rejects the `weight` union on the wire. What then?** Recommended answer: replace it with `weight: number` and `hard: z.enum(["no", "must", "never"])`, where `hard` overrides `weight`. Keep every other part of the plan. Decide only after Task 2 Step 8 shows a real failure.
5. **Do the arms accept date-group columns (WEEKEND, custom groups) now?** Recommended answer: no, it is a follow-up. It needs a second date field, and the realistic cases do not use it.
6. **Sibling plans edit the same assistant summary sentence in the help content. Who wins?** Recommended answer: the plan that merges last writes a list with every family. Task 5 Step 1 says this.

## Assumptions

- The move of `foldGesture` does not change behaviour. The unchanged `paint.test.ts` is the proof (Task 1 Step 5).
- `lib/store/types.ts` has only type imports. Thus an import of it from `lib/proposal` does not pull in the store spine. Checked: its only import is `import type ... from "@/lib/scenario"`.
- Before it proposes, the model reads staff ids, shift codes and the roster period with `get_schedule_section`. If it does not, the host refusal names the unknown person, shift or date.
- The per-turn instruction already tells the model to use `prepare_scenario_change` and not to refuse (`docs/ai-assistant.md`, product decision paragraph). No prompt change is necessary.
- `proposal-preview-card.tsx` shows the `question` and `detail` of every assumption, from any source. The leave-cancel question needs no UI change (checked lines 117-118).
- Apply derives the document again through `applyAssistantCommands` and `deriveAssumptions` (`lib/repository/repository.ts`). Thus Apply refuses `clear_requests` over leave with no answer. No repository change is necessary.

## Follow-ups

- Date-group columns (`ALL` / `WEEKDAY` / `WEEKEND` / custom date groups) as request targets.
- People history (the H-n columns), CSV import, and the bulk Clear panels as assistant ops.
- Leave types (annual, sick, study) need a model change first. The page has one "Paid leave" kind.
- `deriveAssumptions` claims the source pin of a `move_leave`. A batch that moves a leave and then clears its new date asks "agreed to move", not "agreed to give up". This defect exists today, and only a combination of ops reaches it. The fix: check that the moved pin is still in `after`.
- Show assumption dates as calendar dates (for example "Wed 14 Oct"), not date ids, in questions and diff labels.
- Group consecutive leave-cancel questions into one (see Open Question 2).
