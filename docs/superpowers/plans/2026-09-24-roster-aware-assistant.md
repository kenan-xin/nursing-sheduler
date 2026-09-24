# Roster-Aware Assistant: Read the Roster, Suggest Swaps, Apply on Click — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant reads the saved roster. It suggests swap partners that keep every hard rule and staffing requirement the roster was solved under. It shows the swap on a host card. The user presses **Apply to roster**, and the Roster screen applies it as one ordinary hand edit.

**Architecture:** There are three new model-visible tools in `web/components/ai/use-roster-tools.ts`: `get_roster`, `find_swap_partners` and `prepare_roster_swap`. They read `rosterStorage` (working row + candidate pointer). The rules come from the roster's own `submission` through a new pure checker, `web/lib/roster-viewer/rule-check.ts`. That checker mirrors `core/nurse_scheduling/preference_types.py`. The swap search is in `web/lib/roster-viewer/swap.ts`. `prepare_roster_swap` only shows a card. The card's **Apply** opens `/roster` and puts a request into `web/lib/roster/change-request.ts`, an AI-free zustand seam like `lib/optimize/run-request.ts`. `WorkingRosterPanel` takes the request. It re-verifies every "before" cell and applies the cells through `useRosterEditing`'s new `applyCells`. That is one normalisation, one undo step and one autosave revision. The assistant never writes a roster table.

**Cover ladder (amended twice on 2026-09-24, Singapore practice; see the spec's "Cover ladder" for sources and [UNCERTAIN] marks):** when nobody can take a shift, `find_swap_partners` walks four steps and returns only the lowest step with an option. Step 1 is swap, move, or cover by a nurse with spare capacity under her count rules. Step 2 asks an off or on-leave nurse to come in, as a request with a pay-back: `overtime`, or off-in-lieu (a cross-date `trade`). Step 3 asks for a temporary nurse (`prepare_borrowed_cover`, `source`: relief pool via the nursing supervisor first, then another ward or an agency), and tells the user to let the nurse manager know. Step 4 is the last resort: run the shift one short, only after `noTemporaryNurse`, with the nurse manager's sign-off, and never when it drops a qualified (NIC-capable) nurse or leaves nobody. The user's six rungs are merged to four: part-timers go into step 1 by ranking, and relief pool, other ward and agency share one borrow mechanism. A sick or emergency trigger (`reason: "sick_or_emergency"`) puts the person on LEAVE and runs the same ladder. When a change also touches the schedule (a leave move, the MC in the leave record, a borrowed person), the card carries a *linked proposal* built from shipped ops (`move_leave`, `add_leave`, `add_person`, `set_off_request`, `set_shift_request`). Apply runs a short sequence: check the roster, apply the proposal, apply the roster, and undo the proposal's receipt if the roster refuses. Step 2 and step 3 cards need an agreement tick before Apply. Step 3's roster row needs a roster schema change (roster-file/2). That is outlined as Phase C2 (Task 12). This plan ships C1: staff change plus the MC cells, and her row after the next run.

**Tech Stack:** Next.js 16 (`web/`), React 19, TypeScript, zustand 5 and zod 4. Tests use vitest 4 and Testing Library. Also CopilotKit 1.66.2, oxlint and ast-grep.

**Spec:** `docs/superpowers/specs/2026-09-24-roster-aware-assistant.md` (bead `nursing-sheduler-73z`).

## Global Constraints

- The model never changes the roster. Only the user's click on the card's **Apply to roster** does. That click goes into `useRosterEditing` on the Roster screen and nowhere else.
- Files under `web/lib/roster/**`, `web/lib/roster-viewer/**` and `web/components/roster-viewer/**` must not import `@/lib/ai*` or `@/components/ai*` (oxlint "AI IS OPTIONAL", `.oxlintrc.json:81-94`). The assistant can import them.
- `lib/roster-viewer/*` imports roster leaves directly (`@/lib/roster/types`, `@/lib/roster/day-state`, `@/lib/roster/context`), never the `@/lib/roster` barrel (ESM cycle, see `tallies.ts:14-15`).
- Model-visible schemas: no `.nullable()`, no `z.literal`, no `.regex` (`model-visible-tools.ts` header). The host checks dates against `context.calendar`.
- Every handler re-checks `assertTurnAuthority(token, signal)` after each await. It stamps the card from `token.turnEpoch` (`use-proposal-tools.ts:144-160`).
- `PROPOSAL_OPERATIONS` / `ASSISTANT_COMMAND_TYPES` stay unchanged. `roster-viewer.supportedCommands` stays `[]`. `ASSISTANT_WRITE_TABLES` stays roster-free.
- No backend (`core/`) change. No new dependency. No `pnpm install` or `pnpm build`.
- Tests: `cd web && pnpm vitest run <path>`. Gates: `pnpm typecheck` and `pnpm run lint`.
- User copy: plain ward English, British spelling, dates as "8 Oct". Tool names use snake_case.
- Do not commit (bead instruction). Report changed files at the end.
- Linked proposals use only shipped `AssistantCommandV1` arms. `PROPOSAL_OPERATIONS` stays unchanged. The compensating undo uses `assistantProposalCommands.undoReceipt`, never `scenarioCommands.undo` (`lib/ai/independence.test.ts`). A linked proposal is never published as `activeProposal`. "Not now" cancels it.
- `move_leave` takes span-formatted date ids. Map ISO to an id with `generateDateItems({start: scenario.rangeStart, end: scenario.rangeEnd})` over the LIVE scenario. The `add_leave` / `set_*_request` ops take ISO dates.

## Review Focus

1. **A swap that breaks a hard rule.** Expected: `prepare_roster_swap` shows no card. It returns the host's reasons. (Test: Task 8, `refuses a rule-breaking swap and shows no card`.)
2. **The roster changed after the card appeared.** Expected: Apply does nothing to the roster, and `get_roster.lastChange` says it was out of date. (Tests: Task 3, `refuses when a before cell changed`; Task 8, `reports the last change outcome`.)
3. **A pre-existing violation elsewhere in the roster.** Expected: it does not block an unrelated swap. (Test: Task 4, `blames only the window a change creates`.)
4. **History at the roster start.** Expected: a night in `history` followed by a morning on day 0 counts as N→AM. (Test: Task 4, `reads history across the roster start`.)
5. **A newer run not loaded.** Expected: the swap tools refuse and ask for Load. `get_roster` flags it. (Test: Task 8, `refuses to swap while a newer run waits`.)
6. **A stopped turn.** Expected: the card shows as stopped with no Apply button. (Test: Task 9, `shows a stopped card with no Apply control`.)
7. **A request nobody takes.** Expected: it expires after 15 s and never applies later. (Test: Task 2, `expires rather than applying on a later visit`.)
8. **Ladder order.** Expected: step 2 appears only when step 1 is empty, and step 3 only when both are empty. `prepare_borrowed_cover` refuses while a lower step has options. (Tests: Task 5A, `returns only the lowest step with an option`; Task 8A, `refuses to borrow while a lower step has options`.)
9. **A leave trade reads as a broken leave pin.** Expected: `leaveMoves` suppresses the pin at `from` and requires it at `to`. (Test: Task 4, `lets a traded leave day move`.)
10. **The roster refuses after the leave move was applied.** Expected: the receipt is undone and the card says nothing changed. If the undo is refused, it says so plainly. (Tests: Task 9A.)
11. **Apply without agreement.** Expected: Apply stays disabled until ticked. The tick records the proposal's confirmations, so the durable gate also refuses. (Test: Task 9A, `keeps Apply off until the agreement is ticked`.)
12. **Run one short too early, or dropping the NIC.** Expected: refused below step 4, refused when a qualified equation loses anyone, and refused at zero. (Tests: Task 5C, `never offers it when it drops the senior who can be in charge` and `never runs a shift with nobody`; Task 8A Step 4b.)
13. **Request wording.** Expected: step 2 cards say "agreed to come in ... for overtime pay" or "... instead (off-in-lieu)", never an order. The guidance forbids blaming the nurse on MC. (Tests: Task 5C views; review the guidance strings.)

---

## File Structure

- Modify `web/lib/roster/editing.ts` and `web/lib/roster/index.ts`: `applyCellBatchToSession`.
- Create `web/lib/roster/change-request.ts`: the request seam.
- Modify `web/components/roster-viewer/use-roster-editing.ts`: `applyCells`.
- Create `web/components/roster-viewer/use-roster-change-request.ts`: `applyRosterChange` (pure) + `useRosterChangeRequest`.
- Modify `web/components/roster-viewer/working-roster-panel.tsx`: mount the consumer.
- Create `web/lib/roster-viewer/rule-check.ts`: rule model + evaluation.
- Create `web/lib/roster-viewer/swap.ts`: `planSwap`, `findSwapPartners`, `findPersonIdx`, `givingProblem`.
- Create `web/lib/roster-viewer/swap-fixtures.ts`: the Priya fixture (test-only, not in the barrel).
- Create `web/lib/ai/assistant/roster-context.ts`: `readRosterForAssistant`, `summarizeRoster`, `buildRosterChangeView`, `describeRosterChangeOutcome`.
- Modify `web/lib/ai/assistant/store.ts`: `activeRosterChange`.
- Create `web/components/ai/use-roster-tools.ts`: the three tools.
- Modify `web/components/ai/use-context-tools.ts` and `web/components/ai/model-visible-tools.ts`: register them.
- Create `web/components/ai/roster-change-card.tsx`. Modify `web/components/ai/assistant-conversation.tsx`.
- Modify `web/lib/ai/assistant/scenario-context.ts`, `web/lib/capability/help-content.ts` (+ regenerate `registry.generated.ts`) and `docs/ai-assistant.md`.
- Amendment files: `lib/roster-viewer/swap.ts` gains `planSickCover`, `findSickCovers`, `planTrade`, `findTrades`, `borrowNeeds` and `findCoverLadder` (Tasks 5A/5B). `swap-fixtures.ts` gains the Asha and borrow fixtures. `lib/ai/assistant/roster-context.ts` gains `buildTradeView`, `buildSickView`, `buildBorrowView` and `tradeAgreement`. `components/ai/linked-apply.ts` (new) holds `applyLinkedChange`. `components/ai/use-assistant-proposals.ts` exports `describeApplyFailure`.
- New tests: `lib/roster/change-request.test.ts`, `components/ai/linked-apply.test.ts`, `components/roster-viewer/use-roster-change-request.test.tsx`, `lib/roster-viewer/rule-check.test.ts`, `lib/roster-viewer/swap.test.ts`, `lib/ai/assistant/roster-context.test.ts`, `components/ai/use-roster-tools.test.tsx`, `components/ai/roster-change-card.test.tsx`.
- Changed tests: `lib/roster/editing.test.ts`, `components/roster-viewer/use-roster-editing.test.tsx`, `lib/ai/phase-2-absence.test.ts` (locked), `lib/capability/tools.test.ts` (locked), `lib/ai/runtime/model-visible-tools.test.ts` (locked), `lib/ai/assistant/scenario-context.test.ts`, `components/ai/assistant-activity.test.tsx`.

---

### Task 1: Batch cell edit as one undo step

**Files:**
- Modify: `web/lib/roster/editing.ts`, `web/lib/roster/index.ts`
- Test: `web/lib/roster/editing.test.ts`

**Interfaces:**
- Produces: `applyCellBatchToSession(session: EditSession, cells: readonly RosterEdit[], bounds: OverlayBounds): NormalizeResult & { readonly session: EditSession }`

- [ ] **Step 1: Write the failing test.** Append to `web/lib/roster/editing.test.ts` (it already has `SHIFT_D`, `SHIFT_N` and `BOUNDS`). Add `applyCellBatchToSession` to the existing `./editing` import.

```ts
describe("applyCellBatchToSession", () => {
  it("sets several cells as ONE edit with ONE undo step", () => {
    const start = emptyEditSession([]);
    const result = applyCellBatchToSession(
      start,
      [
        { personIdx: 0, dateIdx: 0, day: SHIFT_N },
        { personIdx: 1, dateIdx: 0, day: SHIFT_D },
      ],
      BOUNDS,
    );
    expect(result.ok).toBe(true);
    expect(result.session.edits).toEqual<RosterEdit[]>([
      { personIdx: 0, dateIdx: 0, day: SHIFT_N },
      { personIdx: 1, dateIdx: 0, day: SHIFT_D },
    ]);
    expect(canUndoSession(result.session)).toBe(true);
    expect(undoSessionEdit(result.session).edits).toEqual([]);
  });

  it("rejects the whole batch when one cell is outside the grid", () => {
    const start = emptyEditSession([]);
    const result = applyCellBatchToSession(
      start,
      [
        { personIdx: 0, dateIdx: 0, day: SHIFT_N },
        { personIdx: 9, dateIdx: 0, day: SHIFT_D },
      ],
      BOUNDS,
    );
    expect(result.ok).toBe(false);
    expect(result.session).toBe(start);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `cd web && pnpm vitest run lib/roster/editing.test.ts`. Expected: FAIL, `applyCellBatchToSession` is not exported.

- [ ] **Step 3: Implement.** In `web/lib/roster/editing.ts`, add this after `applyCellSwapToSession`:

```ts
/**
 * Set several cells as ONE edit: one normalization, one undo step, one autosave
 * revision. The assistant's swap uses it: it exchanges several same-date cells
 * between two people, and a swap must never be half-applied or need two undos.
 * Any bad cell rejects the whole batch and leaves the session unchanged.
 */
export function applyCellBatchToSession(
  session: EditSession,
  cells: readonly RosterEdit[],
  bounds: OverlayBounds,
): NormalizeResult & { readonly session: EditSession } {
  // Rebuilt as exact three-field records: `normalizeRosterEdits` rejects extra keys.
  const result = normalizeWith(
    session.edits,
    cells.map(({ personIdx, dateIdx, day }) => ({ personIdx, dateIdx, day })),
    bounds,
    true,
  );
  if (!result.ok) return { ok: false, reason: result.reason, session };
  return { ok: true, edits: result.edits, session: advanceSession(session, result.edits) };
}
```

In `web/lib/roster/index.ts`, add `applyCellBatchToSession,` to the `./editing` export block.

- [ ] **Step 4: Run it and see it pass.** Run: `cd web && pnpm vitest run lib/roster/editing.test.ts`. Expected: PASS.

---

### Task 2: The roster change request seam

**Files:**
- Create: `web/lib/roster/change-request.ts`
- Test: `web/lib/roster/change-request.test.ts`

**Interfaces:**
- Produces:
  - `ROSTER_CHANGE_TTL_MS = 15_000`
  - `interface RosterCellChange { personIdx: number; dateIdx: number; before: RosterDayState; after: RosterDayState }`
  - `interface RosterChangeRequest { solvedBaselineId: string; cells: readonly RosterCellChange[] }`
  - `type RosterChangeOutcome = "applied" | "roster-changed" | "rejected" | "expired"`
  - `useRosterChangeStore`, `requestRosterChange(request, now?)`, `takeRosterChangeRequest(now?)`, `reportRosterChange(outcome)` and `readRosterChangeOutcome(now?)`

- [ ] **Step 1: Write the failing test.** Create `web/lib/roster/change-request.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  ROSTER_CHANGE_TTL_MS,
  readRosterChangeOutcome,
  reportRosterChange,
  requestRosterChange,
  takeRosterChangeRequest,
  useRosterChangeStore,
  type RosterChangeRequest,
} from "./change-request";

const REQUEST: RosterChangeRequest = {
  solvedBaselineId: "b".repeat(64),
  cells: [
    { personIdx: 0, dateIdx: 1, before: { kind: "shift", shiftId: "N" }, after: { kind: "off" } },
  ],
};

beforeEach(() => useRosterChangeStore.setState({ pending: null, last: null }));

describe("the roster change request seam", () => {
  it("hands a fresh request to the Roster screen exactly once", () => {
    requestRosterChange(REQUEST, 1_000);
    expect(takeRosterChangeRequest(2_000)).toEqual(REQUEST);
    expect(takeRosterChangeRequest(2_001)).toBeNull();
  });

  it("expires rather than applying on a later visit", () => {
    requestRosterChange(REQUEST, 1_000);
    expect(takeRosterChangeRequest(1_000 + ROSTER_CHANGE_TTL_MS + 1)).toBeNull();
    expect(useRosterChangeStore.getState().last).toBe("expired");
  });

  it("reports a request nobody took as expired when read late", () => {
    requestRosterChange(REQUEST, 1_000);
    expect(readRosterChangeOutcome(1_000 + ROSTER_CHANGE_TTL_MS + 1)).toBe("expired");
    expect(useRosterChangeStore.getState().pending).toBeNull();
  });

  it("records what the screen did, and a new request clears it", () => {
    reportRosterChange("applied");
    expect(readRosterChangeOutcome()).toBe("applied");
    requestRosterChange(REQUEST);
    expect(useRosterChangeStore.getState().last).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `cd web && pnpm vitest run lib/roster/change-request.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** Create `web/lib/roster/change-request.ts`:

```ts
// The one seam through which something OUTSIDE the Roster screen can ask it to change
// cells (bead nursing-sheduler-73z).
//
// The assistant's swap card calls `requestRosterChange` after the user presses Apply.
// The Roster screen takes the request, re-checks every "before" cell against the
// roster it shows, and applies the cells through its own edit session: one undo step,
// one autosave revision, the same export. So an assistant swap IS a hand edit.
//
// It lives here, not in lib/ai, because roster code may never import assistant code
// (`.oxlintrc.json`, "AI IS OPTIONAL"). The assistant imports this; this imports
// nothing of the assistant's. Not re-exported from the barrel (zustand stays out of
// the document domain's public surface).

import { create } from "zustand";
import type { RosterDayState } from "./types";

// ponytail: fixed TTL, same as RUN_REQUEST_TTL_MS. A request the screen did not take in
// time is dropped so it can never change the roster on a later visit.
export const ROSTER_CHANGE_TTL_MS = 15_000;

/** One cell: what the card showed it holding, and what it becomes. */
export interface RosterCellChange {
  readonly personIdx: number;
  readonly dateIdx: number;
  readonly before: RosterDayState;
  readonly after: RosterDayState;
}

export interface RosterChangeRequest {
  /** The roster the change was prepared on. */
  readonly solvedBaselineId: string;
  readonly cells: readonly RosterCellChange[];
}

/** `roster-changed`: a before cell or the roster itself changed since the card. */
export type RosterChangeOutcome = "applied" | "roster-changed" | "rejected" | "expired";

export interface RosterChangeState {
  pending: (RosterChangeRequest & { requestedAt: number }) | null;
  last: RosterChangeOutcome | null;
}

export const useRosterChangeStore = create<RosterChangeState>()(() => ({
  pending: null,
  last: null,
}));

export function requestRosterChange(request: RosterChangeRequest, now: number = Date.now()): void {
  useRosterChangeStore.setState({ pending: { ...request, requestedAt: now }, last: null });
}

/** Consume the pending request. Returns it only while it is still fresh. */
export function takeRosterChangeRequest(now: number = Date.now()): RosterChangeRequest | null {
  const { pending } = useRosterChangeStore.getState();
  if (pending === null) return null;
  if (now - pending.requestedAt > ROSTER_CHANGE_TTL_MS) {
    useRosterChangeStore.setState({ pending: null, last: "expired" });
    return null;
  }
  useRosterChangeStore.setState({ pending: null });
  return { solvedBaselineId: pending.solvedBaselineId, cells: pending.cells };
}

export function reportRosterChange(outcome: RosterChangeOutcome): void {
  useRosterChangeStore.setState({ last: outcome });
}

/** What happened to the last request, expiring one nobody took in time. */
export function readRosterChangeOutcome(now: number = Date.now()): RosterChangeOutcome | null {
  const { pending, last } = useRosterChangeStore.getState();
  if (pending !== null && now - pending.requestedAt > ROSTER_CHANGE_TTL_MS) {
    useRosterChangeStore.setState({ pending: null, last: "expired" });
    return "expired";
  }
  return last;
}
```

- [ ] **Step 4: Run it and see it pass.** Run: `cd web && pnpm vitest run lib/roster/change-request.test.ts`. Expected: PASS.

- [ ] **Step 5 (amendment): `requestStillMatches` and `awaitRosterChangeOutcome`.** The linked Apply (Task 9A) checks the roster before it touches the schedule, then waits for the Roster screen's answer. Append to the test file:

```ts
import { vi } from "vitest";
import { fixtureRosterDocument, withEdits } from "./test-fixtures";
import { awaitRosterChangeOutcome, requestStillMatches } from "./change-request";

describe("requestStillMatches", () => {
  it("is true only while every before cell and the baseline still hold", async () => {
    const document = await fixtureRosterDocument();
    const request = {
      solvedBaselineId: document.provenance.solvedBaselineId,
      cells: [{ personIdx: 0, dateIdx: 0, before: { kind: "shift", shiftId: "D" } as const, after: { kind: "off" } as const }],
    };
    expect(requestStillMatches(document, request)).toBe(true);
    expect(requestStillMatches(withEdits(document, [{ personIdx: 0, dateIdx: 0, day: { kind: "off" } }]), request)).toBe(false);
    expect(requestStillMatches(document, { ...request, solvedBaselineId: "0".repeat(64) })).toBe(false);
  });
});

describe("awaitRosterChangeOutcome", () => {
  it("resolves with what the Roster screen reported", async () => {
    requestRosterChange(REQUEST);
    const outcome = awaitRosterChangeOutcome();
    reportRosterChange("applied");
    await expect(outcome).resolves.toBe("applied");
  });

  it("resolves expired when nobody took the request", async () => {
    vi.useFakeTimers();
    requestRosterChange(REQUEST, Date.now());
    const outcome = awaitRosterChangeOutcome();
    vi.advanceTimersByTime(ROSTER_CHANGE_TTL_MS + 100);
    await expect(outcome).resolves.toBe("expired");
    vi.useRealTimers();
  });
});
```

Append to `change-request.ts` (and add `import { dayStatesEqual } from "./day-state"; import { deriveCurrentDays } from "./overlay";` and `RosterDocument` to the type import):

```ts
/** Whether the roster still holds every cell the request was prepared against. */
export function requestStillMatches(document: RosterDocument, request: RosterChangeRequest): boolean {
  if (document.provenance.solvedBaselineId !== request.solvedBaselineId) return false;
  const current = deriveCurrentDays(document.solvedDays, document.edits);
  return request.cells.every((cell) => {
    const now = current[cell.personIdx]?.[cell.dateIdx];
    return now !== undefined && dayStatesEqual(now, cell.before);
  });
}

/** What the Roster screen did with the request just made. `expired` when nobody took it in time. */
export function awaitRosterChangeOutcome(timeoutMs: number = ROSTER_CHANGE_TTL_MS): Promise<RosterChangeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: RosterChangeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = useRosterChangeStore.subscribe((state) => {
      if (state.last !== null) finish(state.last);
    });
    const timer = setTimeout(() => finish(readRosterChangeOutcome() ?? "expired"), timeoutMs + 50);
  });
}
```

Run: `cd web && pnpm vitest run lib/roster/change-request.test.ts`. Expected: PASS.

---

### Task 3: The Roster screen applies a request through its own edit session

**Files:**
- Modify: `web/components/roster-viewer/use-roster-editing.ts`, `web/components/roster-viewer/working-roster-panel.tsx`
- Create: `web/components/roster-viewer/use-roster-change-request.ts`
- Test: `web/components/roster-viewer/use-roster-change-request.test.tsx`, `web/components/roster-viewer/use-roster-editing.test.tsx`

**Interfaces:**
- Consumes: Task 1 `applyCellBatchToSession`, and Task 2's seam.
- Produces:
  - `RosterEditingState.applyCells(cells: readonly RosterEdit[]): boolean`
  - `applyRosterChange(document: RosterDocument, request: RosterChangeRequest, applyCells: (cells: readonly RosterEdit[]) => boolean): RosterChangeOutcome`
  - `useRosterChangeRequest(editing: Pick<RosterEditingState, "ready" | "editedDocument" | "applyCells">): void`

- [ ] **Step 1: Write the failing tests.** Create `web/components/roster-viewer/use-roster-change-request.test.tsx`:

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument, withEdits } from "@/lib/roster/test-fixtures";
import {
  requestRosterChange,
  useRosterChangeStore,
  type RosterChangeRequest,
} from "@/lib/roster/change-request";
import { applyRosterChange, useRosterChangeRequest } from "./use-roster-change-request";

const D = { kind: "shift", shiftId: "D" } as const;
const N = { kind: "shift", shiftId: "N" } as const;

// Fixture grid (test-fixtures.ts): P0 = [D, OFF, N, LEAVE], P1 = [N, D, OFF, D].
function swapDayZero(document: RosterDocument): RosterChangeRequest {
  return {
    solvedBaselineId: document.provenance.solvedBaselineId,
    cells: [
      { personIdx: 0, dateIdx: 0, before: D, after: N },
      { personIdx: 1, dateIdx: 0, before: N, after: D },
    ],
  };
}

beforeEach(() => useRosterChangeStore.setState({ pending: null, last: null }));

describe("applyRosterChange", () => {
  it("applies every cell as one batch when the roster still matches", async () => {
    const document = await fixtureRosterDocument();
    const applyCells = vi.fn(() => true);
    expect(applyRosterChange(document, swapDayZero(document), applyCells)).toBe("applied");
    expect(applyCells).toHaveBeenCalledWith([
      { personIdx: 0, dateIdx: 0, day: N },
      { personIdx: 1, dateIdx: 0, day: D },
    ]);
  });

  it("refuses a request prepared on a different roster", async () => {
    const document = await fixtureRosterDocument();
    const applyCells = vi.fn(() => true);
    const request = { ...swapDayZero(document), solvedBaselineId: "0".repeat(64) };
    expect(applyRosterChange(document, request, applyCells)).toBe("roster-changed");
    expect(applyCells).not.toHaveBeenCalled();
  });

  it("refuses when a before cell changed", async () => {
    const document = await fixtureRosterDocument();
    const edited = withEdits(document, [{ personIdx: 0, dateIdx: 0, day: { kind: "off" } }]);
    const applyCells = vi.fn(() => true);
    expect(applyRosterChange(edited, swapDayZero(document), applyCells)).toBe("roster-changed");
    expect(applyCells).not.toHaveBeenCalled();
  });

  it("reports a batch the edit session rejected", async () => {
    const document = await fixtureRosterDocument();
    expect(applyRosterChange(document, swapDayZero(document), () => false)).toBe("rejected");
  });
});

describe("useRosterChangeRequest", () => {
  it("waits for the edit session to be ready, then applies once", async () => {
    const document = await fixtureRosterDocument();
    const applyCells = vi.fn(() => true);
    requestRosterChange(swapDayZero(document));
    const { rerender } = renderHook(
      ({ ready }) => useRosterChangeRequest({ ready, editedDocument: document, applyCells }),
      { initialProps: { ready: false } },
    );
    expect(applyCells).not.toHaveBeenCalled();
    expect(useRosterChangeStore.getState().pending).not.toBeNull();

    rerender({ ready: true });
    expect(applyCells).toHaveBeenCalledTimes(1);
    expect(useRosterChangeStore.getState()).toMatchObject({ pending: null, last: "applied" });
  });
});
```

Append this to `web/components/roster-viewer/use-roster-editing.test.tsx`. Copy the render setup from the file's existing tests: `seedWorking()`, `renderHook(() => useRosterEditing(...))`, and wait for `ready`.

```tsx
describe("applyCells", () => {
  it("applies a batch as one undo step", async () => {
    const { document, revision } = await seedWorking();
    const { result } = renderHook(() =>
      useRosterEditing({ document, revision, reload: async () => {} }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    let applied = false;
    act(() => {
      applied = result.current.applyCells([
        { personIdx: 0, dateIdx: 0, day: { kind: "shift", shiftId: "N" } },
        { personIdx: 1, dateIdx: 0, day: { kind: "shift", shiftId: "D" } },
      ]);
    });
    expect(applied).toBe(true);
    expect(result.current.editedDocument.edits).toHaveLength(2);
    act(() => result.current.undo());
    expect(result.current.editedDocument.edits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `cd web && pnpm vitest run components/roster-viewer/use-roster-change-request.test.tsx components/roster-viewer/use-roster-editing.test.tsx`. Expected: FAIL (the module is missing and `applyCells` is not a function).

- [ ] **Step 3: Implement `applyCells`.** In `web/components/roster-viewer/use-roster-editing.ts`:
  - Add `applyCellBatchToSession` to the `@/lib/roster` import, and `type RosterEdit` to the type import.
  - Add this to `RosterEditingState` after `swapCells`:

```ts
  /**
   * Set several cells as ONE edit (one undo step, one autosave revision). False when
   * the batch is rejected; nothing changes then. The assistant's swap card uses it via
   * `useRosterChangeRequest`.
   */
  applyCells(cells: readonly RosterEdit[]): boolean;
```

  - Add this after the `swapCells` callback:

```ts
  const applyCells = useCallback(
    (cells: readonly RosterEdit[]): boolean => {
      const result = applyCellBatchToSession(sessionRef.current, cells, bounds);
      if (!result.ok) return false;
      commit(result.session);
      return true;
    },
    [bounds, commit],
  );
```

  - Add `applyCells,` to the returned object after `swapCells,`.

- [ ] **Step 4: Implement the consumer.** Create `web/components/roster-viewer/use-roster-change-request.ts`:

```ts
"use client";

// The Roster screen's side of `lib/roster/change-request.ts` (bead nursing-sheduler-73z).
//
// A change asked for from outside (the assistant's swap card, after the user pressed
// Apply) is applied HERE, through the screen's own edit session, and only when every
// cell still holds what the card showed. Anything else is refused and reported: a
// swap prepared on yesterday's roster must never land on today's.

import { useEffect } from "react";
import type { RosterDocument, RosterEdit } from "@/lib/roster";
import {
  requestStillMatches,
  reportRosterChange,
  takeRosterChangeRequest,
  useRosterChangeStore,
  type RosterChangeOutcome,
  type RosterChangeRequest,
} from "@/lib/roster/change-request";
import type { RosterEditingState } from "./use-roster-editing";

/** Verify the request against the roster on screen, then apply it as one batch. Pure. */
export function applyRosterChange(
  document: RosterDocument,
  request: RosterChangeRequest,
  applyCells: (cells: readonly RosterEdit[]) => boolean,
): RosterChangeOutcome {
  // One authority for "does the roster still match", shared with the linked Apply.
  if (!requestStillMatches(document, request)) return "roster-changed";
  const cells = request.cells.map(({ personIdx, dateIdx, after }) => ({
    personIdx,
    dateIdx,
    day: after,
  }));
  return applyCells(cells) ? "applied" : "rejected";
}

/** Take a pending request once the edit session can save it, and apply it. */
export function useRosterChangeRequest(
  editing: Pick<RosterEditingState, "ready" | "editedDocument" | "applyCells">,
): void {
  const pending = useRosterChangeStore((state) => state.pending);
  const { ready, editedDocument, applyCells } = editing;
  useEffect(() => {
    // Not ready: leave it pending. The TTL, not this effect, decides when it dies.
    if (pending === null || !ready) return;
    const request = takeRosterChangeRequest();
    if (request === null) return;
    reportRosterChange(applyRosterChange(editedDocument, request, applyCells));
  }, [pending, ready, editedDocument, applyCells]);
}
```

- [ ] **Step 5: Mount it.** In `web/components/roster-viewer/working-roster-panel.tsx`, add `import { useRosterChangeRequest } from "./use-roster-change-request";`. Directly after `const editing = useRosterEditing({ document, revision, reload });`, add:

```tsx
    // A change the user approved elsewhere (the assistant's swap card) lands here,
    // through this panel's own edit session, or not at all.
    useRosterChangeRequest(editing);
```

- [ ] **Step 6: Run them and see them pass.** Run: `cd web && pnpm vitest run components/roster-viewer lib/roster`. Expected: PASS.

---

### Task 4: The hand-change rule check

**Files:**
- Create: `web/lib/roster-viewer/rule-check.ts`
- Test: `web/lib/roster-viewer/rule-check.test.ts`

**Interfaces:**
- Consumes: `buildEquations`, `buildAssignmentIndex` and `evaluateRequirementCell` from `./requirements`; `buildScenarioResolutionContext`, `OFF_SID` and `LEAVE_SID` from `@/lib/scenario`; `parseSubmissionDocument` from `@/lib/roster/context`.
- Produces:
  - `interface RuleIssue { key: string; hard: boolean; severity: number; message: string }`
  - `interface RuleModel { …; unchecked: readonly string[] }`
  - `buildRuleModel(document: CanonicalScenarioDocument): RuleModel`
  - `deriveRuleModel(submission: Pick<RosterSubmission, "canonicalYaml">): RuleModel | null`
  - `interface CheckScope { people: readonly number[]; dates: readonly number[] }`
  - `listIssues(model, context: RosterContext, grid: RosterDayGrid, scope): RuleIssue[]`
  - `checkRosterChange(model, context, before, after, scope): { hard: RuleIssue[]; soft: RuleIssue[]; unchecked: readonly string[] }`
  - `plainDate(iso: string): string` ("2026-10-08" → "8 Oct") and `dayCode(day: RosterDayState): string`

- [ ] **Step 1: Write the failing test.** Create `web/lib/roster-viewer/rule-check.test.ts`:

```ts
// Hand-change rule check tests (bead nursing-sheduler-73z). Each family pins one way
// `core/nurse_scheduling/preference_types.py` reads it, plus the "only new issues
// blame a change" rule.

import { describe, expect, it } from "vitest";
import { PREFERENCE_TYPE, type CanonicalPreference, type CanonicalScenarioDocument } from "@/lib/scenario";
import type { RosterContext, RosterDayState } from "@/lib/roster/types";
import { fixtureSubmission } from "@/lib/roster/test-fixtures";
import { buildRuleModel, checkRosterChange, deriveRuleModel, plainDate } from "./rule-check";

const DATES = ["2026-10-07", "2026-10-08", "2026-10-09"];
const s = (id: string): RosterDayState => ({ kind: "shift", shiftId: id });
const OFF: RosterDayState = { kind: "off" };
const LEAVE: RosterDayState = { kind: "leave" };
const SCOPE = { people: [0, 1, 2], dates: [0, 1, 2] };

function doc(preferences: CanonicalPreference[], history?: string[]): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: DATES[0], endDate: DATES[2] } },
    people: {
      items: [{ id: "Ana", ...(history ? { history } : {}) }, { id: "Ben" }, { id: "Cy" }],
      groups: [{ id: "Nights", members: ["Ana", "Ben"] }],
    },
    shiftTypes: {
      items: ["AM", "N"].map((id) => ({ id, startTime: "08:00", endTime: "16:00", durationMinutes: 480 })),
    },
    preferences: [{ type: PREFERENCE_TYPE.maxOneShiftPerDay }, ...preferences],
  };
}

function contextFor(document: CanonicalScenarioDocument): RosterContext {
  return {
    people: document.people.items.map((person) => ({ id: person.id })),
    shiftTypes: document.shiftTypes.items.map((item) => ({ id: item.id })),
    calendar: DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
    baselineMinimums: document.shiftTypes.items.map((item) => ({ shiftId: item.id, unavailable: true as const })),
    leaveCreditMinutes: null,
  };
}

function check(
  preferences: CanonicalPreference[],
  before: RosterDayState[][],
  after: RosterDayState[][],
  options: { history?: string[]; scope?: { people: number[]; dates: number[] } } = {},
) {
  const document = doc(preferences, options.history);
  return checkRosterChange(buildRuleModel(document), contextFor(document), before, after, options.scope ?? SCOPE);
}

const NO_N_THEN_AM = {
  type: PREFERENCE_TYPE.shiftTypeSuccessions,
  description: "No morning after night",
  person: "ALL",
  pattern: ["N", "AM"],
  weight: -Infinity,
} as CanonicalPreference;

const idle = (): RosterDayState[] => [OFF, OFF, OFF];

describe("successions", () => {
  it("blames only the window a change creates", () => {
    const before = [[s("N"), s("AM"), OFF], [OFF, s("N"), OFF], idle()];
    const after = [[s("N"), s("AM"), OFF], [OFF, s("N"), s("AM")], idle()];
    const result = check([NO_N_THEN_AM], before, after);
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "Ben works N on 8 Oct, then AM on 9 Oct, which “No morning after night” does not allow.",
    ]);
  });

  it("reads history across the roster start", () => {
    const result = check([NO_N_THEN_AM], [idle(), idle(), idle()], [[s("AM"), OFF, OFF], idle(), idle()], {
      history: ["N"],
      scope: { people: [0], dates: [0] },
    });
    expect(result.hard).toHaveLength(1);
    expect(result.hard[0].message).toMatch(/N before the roster starts, then AM on 7 Oct/);
  });

  it("ignores a window the rule's dates do not fully cover", () => {
    const scoped = { ...NO_N_THEN_AM, date: "2026-10-09" } as CanonicalPreference;
    const result = check([scoped], [idle(), idle(), idle()], [[OFF, s("N"), s("AM")], idle(), idle()]);
    expect(result.hard).toEqual([]);
  });
});

describe("requests", () => {
  it("treats an infinite request as hard and a finite one as worth knowing", () => {
    const preferences = [
      { type: PREFERENCE_TYPE.shiftRequest, description: "Ben's study day", person: "Ben", date: "2026-10-08", shiftType: "N", weight: -Infinity },
      { type: PREFERENCE_TYPE.shiftRequest, person: "Ana", date: "2026-10-09", shiftType: "AM", weight: 1 },
    ] as CanonicalPreference[];
    const before = [[OFF, OFF, s("AM")], idle(), idle()];
    const after = [[OFF, OFF, OFF], [OFF, s("N"), OFF], idle()];
    const result = check(preferences, before, after);
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "Ben must not have N on 8 Oct (“Ben's study day”).",
    ]);
    expect(result.soft.map((issue) => issue.message)).toEqual(["Ana asked for AM on 9 Oct."]);
  });

  it("treats a LEAVE request as hard at any weight", () => {
    const leave = { type: PREFERENCE_TYPE.shiftRequest, person: "Ana", date: "2026-10-07", shiftType: "LEAVE", weight: 1 } as CanonicalPreference;
    const result = check([leave], [[LEAVE, OFF, OFF], idle(), idle()], [[s("N"), OFF, OFF], idle(), idle()]);
    expect(result.hard.map((issue) => issue.message)).toEqual(["Ana must have leave on 7 Oct (“a request”)."]);
  });
});

describe("counts", () => {
  it("enforces an infinite x <= T per person", () => {
    const cap = { type: PREFERENCE_TYPE.shiftCount, description: "Max 1 night", person: "ALL", countDates: "ALL", countShiftTypes: "N", expression: "x <= T", target: 1, weight: Infinity } as CanonicalPreference;
    const result = check([cap], [idle(), [OFF, s("N"), OFF], idle()], [idle(), [s("N"), s("N"), OFF], idle()]);
    expect(result.hard.map((issue) => issue.message)).toEqual([
      "Ben has 2 counted under “Max 1 night”, which needs at most 1.",
    ]);
  });

  it("reads -inf on |x - T|^2 as x = T", () => {
    const exact = { type: PREFERENCE_TYPE.shiftCount, person: "Ben", countDates: "ALL", countShiftTypes: "N", expression: "|x - T|^2", target: 1, weight: -Infinity } as CanonicalPreference;
    const result = check([exact], [idle(), [OFF, s("N"), OFF], idle()], [idle(), [s("N"), s("N"), OFF], idle()]);
    expect(result.hard).toHaveLength(1);
  });
});

describe("staffing requirements", () => {
  const NIGHTS_ONLY = {
    type: PREFERENCE_TYPE.shiftTypeRequirement,
    description: "One night nurse",
    shiftType: "N",
    requiredNumPeople: 1,
    qualifiedPeople: "Nights",
    weight: -1,
  } as CanonicalPreference;

  it("flags an unqualified cover and the shortfall it leaves", () => {
    const before = [idle(), [OFF, s("N"), OFF], idle()];
    const after = [idle(), idle(), [OFF, s("N"), OFF]];
    const messages = check([NIGHTS_ONLY], before, after).hard.map((issue) => issue.message);
    expect(messages).toContain("8 Oct: Cy works N, which only Nights may work.");
    expect(messages).toContain("8 Oct: “One night nurse” has 0 of the 1 needed.");
  });

  it("does not blame a change for a shortfall that was already there", () => {
    const grid = [idle(), [OFF, s("N"), OFF], idle()];
    // Day 0 and day 2 are short before and after; only day 1 changes hands.
    const after = [[OFF, s("N"), OFF], idle(), idle()];
    expect(check([NIGHTS_ONLY], grid, after).hard).toEqual([]);
  });
});

describe("what it cannot check", () => {
  it("lists a hard affinity instead of calling it fine", () => {
    const pairing = { type: PREFERENCE_TYPE.shiftAffinity, description: "Ana and Ben never together", date: "ALL", people1: ["Ana"], people2: ["Ben"], shiftTypes: ["N"], weight: -Infinity } as CanonicalPreference;
    expect(check([pairing], [idle(), idle(), idle()], [idle(), idle(), idle()]).unchecked).toEqual([
      "Ana and Ben never together",
    ]);
  });
});

describe("the submission round trip", () => {
  it("keeps hard weights through the canonical YAML", () => {
    const model = deriveRuleModel(fixtureSubmission(doc([NO_N_THEN_AM]), []));
    expect(model?.successions[0].weight).toBe(-Infinity);
  });

  it("formats a roster date the way the ward says it", () => {
    expect(plainDate("2026-10-08")).toBe("8 Oct");
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `cd web && pnpm vitest run lib/roster-viewer/rule-check.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** Create `web/lib/roster-viewer/rule-check.ts`:

```ts
// Hand-change rule check for a produced roster (bead nursing-sheduler-73z).
//
// WHY. The assistant may now propose swapping shifts on the saved roster. A swap is
// only worth offering if it keeps every HARD rule the roster was solved under, and the
// solver cannot answer that for one swap without re-solving everything. So this module
// re-reads the rules from the roster's own immutable submission and evaluates them on
// a grid, the way `./requirements` already does for staffing.
//
// IT MIRRORS THE BACKEND (`core/nurse_scheduling/preference_types.py`):
//   • weight ±Infinity is hard (`utils.add_objective`); a LEAVE request is hard at any
//     weight (`shift_request`); staffing is hard both ways (`./requirements`);
//   • successions slide over every start day, the `date` filter must cover the whole
//     window, and at day 0 the history-prefix variants apply (`shift_type_successions`);
//   • counts sum coefficient × day-state over `countDates` per person (`shift_count`).
// Hard affinities and coverings are NOT evaluated. They are listed in `unchecked`, and
// the card says so: unknown is never reported as fine.
//
// ONLY NEW ISSUES BLAME A CHANGE. A roster can already break a rule (an earlier hand
// edit). `checkRosterChange` evaluates before and after over the same scope and keeps
// only issues whose key is new or whose severity grew.

import {
  buildScenarioResolutionContext,
  LEAVE_SID,
  OFF_SID,
  PREFERENCE_TYPE,
  type CanonicalScenarioDocument,
  type DateRef,
  type PersonRef,
  type ShiftTypeGroupMember,
} from "@/lib/scenario";
// DIRECT LEAF IMPORTS, not the `@/lib/roster` barrel (see `tallies.ts`).
import { parseSubmissionDocument } from "@/lib/roster/context";
import { typedIdKey } from "@/lib/roster/day-state";
import type {
  RosterContext,
  RosterDayGrid,
  RosterDayState,
  RosterSubmission,
} from "@/lib/roster/types";
import {
  buildAssignmentIndex,
  buildEquations,
  evaluateRequirementCell,
  type RequirementEquation,
} from "./requirements";

/** One rule broken on one grid. */
export interface RuleIssue {
  /** Identity across before/after: rule, person, day, and pair or offender. */
  readonly key: string;
  readonly hard: boolean;
  /** How badly: people short or over, count distance; 1 for yes/no rules. */
  readonly severity: number;
  /** One plain sentence a nurse can read. */
  readonly message: string;
}

type IndexSet = ReadonlySet<number>;

interface SuccessionRule {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly people: IndexSet;
  readonly pattern: readonly IndexSet[];
  /** `null` = every date (the backend's `range(ctx.n_days)`). */
  readonly dates: IndexSet | null;
}

interface RequestRule {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly people: IndexSet;
  readonly dates: IndexSet;
  readonly shifts: readonly number[];
  /** The selector equals every worked shift: "works any shift" (`is_ss_equivalent_to_all`). */
  readonly anyWorked: boolean;
}

interface CountRule {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly people: IndexSet;
  readonly dates: readonly number[];
  readonly coefficients: ReadonlyMap<number, number>;
  readonly pairs: readonly { readonly expression: string; readonly target: number }[];
}

export interface RuleModel {
  readonly shiftIndex: ReadonlyMap<string, number>;
  readonly shiftCodes: readonly string[];
  /** Per person: resolved history indices, or null when absent or unreadable. */
  readonly history: readonly (readonly number[] | null)[];
  readonly equations: readonly RequirementEquation[];
  readonly successions: readonly SuccessionRule[];
  readonly requests: readonly RequestRule[];
  readonly counts: readonly CountRule[];
  /** Hard rules this module cannot evaluate, as plain labels. Never "fine". */
  readonly unchecked: readonly string[];
}

export interface CheckScope {
  readonly people: readonly number[];
  readonly dates: readonly number[];
}

const isHard = (weight: number): boolean => weight === Infinity || weight === -Infinity;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-08" → "8 Oct", the way the ward says it. */
export function plainDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

/** The code the grid shows: the shift id, OFF or LEAVE. */
export function dayCode(day: RosterDayState): string {
  if (day.kind === "shift") return String(day.shiftId);
  return day.kind === "off" ? "OFF" : "LEAVE";
}

/** Build the rule model from the canonical document the roster was solved from. */
export function buildRuleModel(document: CanonicalScenarioDocument): RuleModel {
  const items = document.shiftTypes.items;
  const resolver = buildScenarioResolutionContext({
    staff: document.people.items,
    staffGroups: document.people.groups ?? [],
    shifts: items,
    shiftGroups: document.shiftTypes.groups ?? [],
    rangeStart: document.dates.range.startDate,
    rangeEnd: document.dates.range.endDate,
    dateGroups: document.dates.groups ?? [],
  });
  const people = (selector: unknown) =>
    resolver.resolvePeople(selector as PersonRef | readonly PersonRef[]);
  const dates = (selector: unknown) => resolver.resolveDates(selector as DateRef | readonly DateRef[]);
  const shifts = (selector: unknown) =>
    resolver.resolveShiftTypes(selector as ShiftTypeGroupMember | readonly ShiftTypeGroupMember[]);

  const equations = buildEquations(document);
  const unchecked: string[] = equations
    .filter((equation) => equation.unavailable !== null)
    .map((equation) => equation.description ?? `${equation.scopeLabel} staffing`);
  const successions: SuccessionRule[] = [];
  const requests: RequestRule[] = [];
  const counts: CountRule[] = [];

  document.preferences.forEach((preference, index) => {
    const key = `preferences[${index}]`;
    switch (preference.type) {
      case PREFERENCE_TYPE.shiftTypeSuccessions: {
        const label = preference.description ?? "a shift pattern rule";
        const who = people(preference.person);
        const when = preference.date === undefined ? null : dates(preference.date);
        const pattern = preference.pattern.map((element) => shifts(element));
        if (!who.resolved || (when !== null && !when.resolved) || !pattern.every((p) => p.resolved)) {
          if (isHard(preference.weight)) unchecked.push(label);
          return;
        }
        successions.push({
          key,
          label,
          weight: preference.weight,
          people: who.values,
          pattern: pattern.map((p) => (p.resolved ? p.values : new Set<number>())),
          dates: when !== null && when.resolved ? when.values : null,
        });
        return;
      }
      case PREFERENCE_TYPE.shiftRequest: {
        const label = preference.description ?? "a request";
        const who = people(preference.person);
        const when = dates(preference.date);
        const what = shifts(preference.shiftType);
        if (!who.resolved || !when.resolved || !what.resolved) {
          // An unreadable request may be a leave pin, which is hard at any weight.
          unchecked.push(label);
          return;
        }
        const list = [...what.values];
        requests.push({
          key,
          label,
          weight: preference.weight,
          people: who.values,
          dates: when.values,
          shifts: list,
          anyWorked: list.length === items.length && list.every((s) => s >= 0),
        });
        return;
      }
      case PREFERENCE_TYPE.shiftCount: {
        const label = preference.description ?? "a shift count rule";
        const who = people(preference.person);
        const when = dates(preference.countDates);
        const what = shifts(preference.countShiftTypes);
        if (!who.resolved || !when.resolved || !what.resolved) {
          if (isHard(preference.weight)) unchecked.push(label);
          return;
        }
        const coefficients = new Map<number, number>([...what.values].map((s) => [s, 1]));
        for (const [shiftId, coefficient] of preference.countShiftTypeCoefficients ?? []) {
          const expanded = shifts(shiftId);
          if (!expanded.resolved) continue;
          for (const s of expanded.values) if (coefficients.has(s)) coefficients.set(s, coefficient);
        }
        const expressions = [preference.expression].flat();
        const targets = [preference.target].flat();
        counts.push({
          key,
          label,
          weight: preference.weight,
          people: who.values,
          dates: [...when.values],
          coefficients,
          pairs: expressions.map((expression, i) => ({ expression, target: targets[i] ?? 0 })),
        });
        return;
      }
      case PREFERENCE_TYPE.shiftAffinity:
        if (isHard(preference.weight)) {
          unchecked.push(preference.description ?? "a rule about who works together");
        }
        return;
      case PREFERENCE_TYPE.shiftTypeCovering:
        if (isHard(preference.weight)) unchecked.push(preference.description ?? "a supervision rule");
        return;
      default:
        // "at most one shift per day" is the grid's own shape; staffing is `equations`.
        return;
    }
  });

  const history = document.people.items.map((person) => {
    if (!person.history) return null;
    const resolved = person.history.map((token) => shifts(token));
    if (!resolved.every((r) => r.resolved && r.values.size === 1)) return null;
    return resolved.map((r) => (r.resolved ? [...r.values][0] : 0));
  });

  return {
    shiftIndex: new Map(items.map((item, i) => [typedIdKey(item.id), i])),
    shiftCodes: items.map((item) => String(item.id)),
    history,
    equations,
    successions,
    requests,
    counts,
    unchecked,
  };
}

/** The rule model of a roster's own submission, or null when it cannot be read. */
export function deriveRuleModel(submission: Pick<RosterSubmission, "canonicalYaml">): RuleModel | null {
  const parsed = parseSubmissionDocument(submission.canonicalYaml);
  return parsed.ok ? buildRuleModel(parsed.document) : null;
}

function cellIndex(model: RuleModel, day: RosterDayState): number {
  if (day.kind === "off") return OFF_SID;
  if (day.kind === "leave") return LEAVE_SID;
  return model.shiftIndex.get(typedIdKey(day.shiftId)) ?? Number.NaN;
}

function describeShift(model: RuleModel, s: number): string {
  if (s === OFF_SID) return "a day off";
  if (s === LEAVE_SID) return "leave";
  return model.shiftCodes[s] ?? "a shift";
}

const RELATION: Readonly<Record<string, (target: number) => string>> = {
  "x <= T": (t) => `at most ${t}`,
  "x < T": (t) => `fewer than ${t}`,
  "x >= T": (t) => `at least ${t}`,
  "x > T": (t) => `more than ${t}`,
  "x = T": (t) => `exactly ${t}`,
  "|x - T|^2": (t) => `exactly ${t}`,
};

function countHolds(expression: string, x: number, t: number): boolean {
  switch (expression) {
    case "x <= T":
      return x <= t;
    case "x < T":
      return x < t;
    case "x >= T":
      return x >= t;
    case "x > T":
      return x > t;
    default:
      return x === t; // "x = T" and "|x - T|^2"
  }
}

/** Every rule the grid breaks inside `scope`, hard and soft. */
export function listIssues(
  model: RuleModel,
  context: RosterContext,
  grid: RosterDayGrid,
  scope: CheckScope,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const inScope = new Set(scope.dates);
  const dayCount = context.calendar.length;
  const name = (p: number) => String(context.people[p]?.id ?? p);
  const day = (d: number) => plainDate(context.calendar[d].iso);
  const at = (p: number, d: number) => cellIndex(model, grid[p][d]);

  // --- successions -------------------------------------------------------------
  for (const rule of model.successions) {
    const length = rule.pattern.length;
    if (length === 0 || length > dayCount) continue;
    const covered = (start: number, span: number) => {
      for (let i = 0; i < span; i++) if (rule.dates !== null && !rule.dates.has(start + i)) return false;
      return true;
    };
    const touches = (start: number, span: number) => {
      for (let i = 0; i < span; i++) if (inScope.has(start + i)) return true;
      return false;
    };
    for (const p of scope.people) {
      if (!rule.people.has(p)) continue;
      const judge = (pattern: readonly IndexSet[], start: number, lead: string, suffix: string) => {
        let matched = 0;
        for (let i = 0; i < pattern.length; i++) if (pattern[i].has(at(p, start + i))) matched++;
        const full = matched === pattern.length;
        const cells = pattern
          .map((_set, i) => `${dayCode(grid[p][start + i])} on ${day(start + i)}`)
          .join(", then ");
        const base = { key: `${rule.key}:p${p}:d${start}${suffix}`, severity: 1 };
        if (rule.weight === -Infinity && full) {
          issues.push({ ...base, hard: true, message: `${name(p)} works ${lead}${cells}, which “${rule.label}” does not allow.` });
        } else if (rule.weight === Infinity && !full) {
          issues.push({ ...base, hard: true, message: `${name(p)} works ${lead}${cells}, which does not follow “${rule.label}”.` });
        } else if (Number.isFinite(rule.weight) && rule.weight < 0 && full) {
          issues.push({ ...base, hard: false, message: `${name(p)} works ${lead}${cells}, which “${rule.label}” tries to avoid.` });
        }
      };
      for (let start = 0; start + length <= dayCount; start++) {
        if (covered(start, length) && touches(start, length)) judge(rule.pattern, start, "", "");
      }
      // Day 0 with history: a history suffix that matches the pattern's prefix leaves
      // the rest of the pattern to be judged from day 0 (`preference_types.py:329-352`).
      // The backend checks the date filter over the FULL pattern length from day 0.
      const history = model.history[p];
      if (history === null || !covered(0, length)) continue;
      for (let k = 1; k <= Math.min(length, history.length); k++) {
        const tail = history.slice(-k);
        if (!tail.every((s, i) => rule.pattern[i].has(s))) continue;
        const rest = rule.pattern.slice(k);
        if (rest.length === 0 || !touches(0, rest.length)) continue;
        const lead = `${tail.map((s) => (s === OFF_SID ? "OFF" : describeShift(model, s))).join(", then ")} before the roster starts, then `;
        judge(rest, 0, lead, `:h${k}`);
      }
    }
  }

  // --- requests ----------------------------------------------------------------
  for (const rule of model.requests) {
    for (const p of scope.people) {
      if (!rule.people.has(p)) continue;
      for (const d of scope.dates) {
        if (!rule.dates.has(d)) continue;
        const cell = at(p, d);
        const checks = rule.anyWorked
          ? [{ id: "any", holds: cell >= 0, label: "a shift", leave: false }]
          : rule.shifts.map((s) => ({ id: String(s), holds: cell === s, label: describeShift(model, s), leave: s === LEAVE_SID }));
        for (const c of checks) {
          const must = c.leave || rule.weight === Infinity;
          const mustNot = !c.leave && rule.weight === -Infinity;
          const base = { key: `${rule.key}:p${p}:d${d}:s${c.id}`, severity: 1 };
          if (must && !c.holds) {
            issues.push({ ...base, hard: true, message: `${name(p)} must have ${c.label} on ${day(d)} (“${rule.label}”).` });
          } else if (mustNot && c.holds) {
            issues.push({ ...base, hard: true, message: `${name(p)} must not have ${c.label} on ${day(d)} (“${rule.label}”).` });
          } else if (!must && !mustNot && rule.weight > 0 && !c.holds) {
            issues.push({ ...base, hard: false, message: `${name(p)} asked for ${c.label} on ${day(d)}.` });
          } else if (!must && !mustNot && rule.weight < 0 && c.holds) {
            issues.push({ ...base, hard: false, message: `${name(p)} asked not to have ${c.label} on ${day(d)}.` });
          }
        }
      }
    }
  }

  // --- counts ------------------------------------------------------------------
  for (const rule of model.counts) {
    if (rule.weight === 0 || !rule.dates.some((d) => inScope.has(d))) continue;
    for (const p of scope.people) {
      if (!rule.people.has(p)) continue;
      let x = 0;
      for (const d of rule.dates) x += rule.coefficients.get(at(p, d)) ?? 0;
      rule.pairs.forEach(({ expression, target }, i) => {
        const relation = RELATION[expression];
        if (relation === undefined) return; // the backend rejects it; no roster exists
        const holds = countHolds(expression, x, target);
        const squared = expression === "|x - T|^2";
        let hard = false;
        let broken: boolean;
        let text: string;
        if (rule.weight === Infinity || (squared && rule.weight === -Infinity)) {
          hard = true;
          broken = !holds;
          text = `needs ${relation(target)}`;
        } else if (rule.weight === -Infinity) {
          hard = true;
          broken = holds;
          text = `must not be ${relation(target)}`;
        } else if (squared || rule.weight > 0) {
          broken = !holds;
          text = `aims for ${relation(target)}`;
        } else {
          broken = holds;
          text = `tries to avoid ${relation(target)}`;
        }
        if (!broken) return;
        issues.push({
          key: `${rule.key}:p${p}:pair${i}`,
          hard,
          severity: Math.abs(x - target) + 1,
          message: `${name(p)} has ${x} counted under “${rule.label}”, which ${text}.`,
        });
      });
    }
  }

  // --- staffing requirements ---------------------------------------------------
  const index = buildAssignmentIndex(context, grid);
  for (const equation of model.equations) {
    const label = equation.description ?? `${equation.scopeLabel} staffing`;
    for (const d of scope.dates) {
      const cell = evaluateRequirementCell(equation, index, d);
      if (cell.status !== "checked") continue;
      for (const offender of cell.offenders) {
        issues.push({
          key: `${equation.key}:d${d}:unqualified:p${offender}`,
          hard: true,
          severity: 1,
          message: `${day(d)}: ${name(offender)} works ${equation.scopeLabel}, which only ${equation.qualifiedLabel ?? "qualified staff"} may work.`,
        });
      }
      if (cell.short > 0) {
        issues.push({
          key: `${equation.key}:d${d}:short`,
          hard: true,
          severity: cell.short,
          message: `${day(d)}: “${label}” has ${cell.units} of the ${cell.required} needed.`,
        });
      }
      if (cell.over > 0) {
        issues.push({
          key: `${equation.key}:d${d}:over`,
          hard: true,
          severity: cell.over,
          message: `${day(d)}: “${label}” has ${cell.units}, more than the ${cell.preferred ?? cell.required} allowed.`,
        });
      }
    }
  }
  return issues;
}

export interface ChangeCheck {
  readonly hard: readonly RuleIssue[];
  readonly soft: readonly RuleIssue[];
  readonly unchecked: readonly string[];
}

/** The issues a change INTRODUCES: a new key, or a key whose severity grew. */
export function checkRosterChange(
  model: RuleModel,
  context: RosterContext,
  before: RosterDayGrid,
  after: RosterDayGrid,
  scope: CheckScope,
): ChangeCheck {
  const had = new Map(listIssues(model, context, before, scope).map((i) => [i.key, i.severity]));
  const introduced = listIssues(model, context, after, scope).filter(
    (issue) => issue.severity > (had.get(issue.key) ?? 0),
  );
  return {
    hard: introduced.filter((issue) => issue.hard),
    soft: introduced.filter((issue) => !issue.hard),
    unchecked: model.unchecked,
  };
}
```

- [ ] **Step 4: Run it and see it pass.** Run: `cd web && pnpm vitest run lib/roster-viewer/rule-check.test.ts`. Expected: PASS. If `fixtureSubmission` rejects the document, compare it with `fixtureCanonicalDocument()` (for example `qualifiedPeople`/`date` shape) and adjust the test document, not the module.

- [ ] **Step 5 (amendment): leave that moves with a trade.** A step 2 trade moves the partner's leave pin from a given date to a later one. Evaluated as is, the roster's own LEAVE request would read as broken on the given date. So the check takes `leaveMoves`, and applies them to the AFTER grid only.

In `rule-check.test.ts`, extend `check`'s `options` with `leaveMoves?: LeaveMove[]` (import `type LeaveMove`) and pass `{ leaveMoves: options.leaveMoves }` as the sixth argument of `checkRosterChange`. Then add:

```ts
describe("leave that moves with a trade", () => {
  const leave = { type: PREFERENCE_TYPE.shiftRequest, person: "Ana", date: "2026-10-07", shiftType: "LEAVE", weight: 1 } as CanonicalPreference;
  const moves = [{ personIdx: 0, from: 0, to: 2 }];

  it("lets a traded leave day move", () => {
    const result = check([leave], [[LEAVE, OFF, OFF], idle(), idle()], [[s("N"), OFF, LEAVE], idle(), idle()], { leaveMoves: moves });
    expect(result.hard).toEqual([]);
  });

  it("still requires the leave on the day it moved to", () => {
    const result = check([leave], [[LEAVE, OFF, OFF], idle(), idle()], [[s("N"), OFF, OFF], idle(), idle()], { leaveMoves: moves });
    expect(result.hard.map((issue) => issue.message)).toEqual(["Ana must have leave on 9 Oct (moved from 7 Oct)."]);
  });
});
```

In `rule-check.ts`:

```ts
/** A leave day a trade moves: the pin on `from` now means `to` (after the change only). */
export interface LeaveMove {
  readonly personIdx: number;
  readonly from: number;
  readonly to: number;
}

export interface CheckOptions {
  readonly leaveMoves?: readonly LeaveMove[];
}
```

- `listIssues(model, context, grid, scope, options: CheckOptions = {})`. At its top: `const movedFrom = new Set((options.leaveMoves ?? []).map((m) => `${m.personIdx}:${m.from}`));`
- In the request loop, as the first line inside `for (const c of checks)`: `if (c.leave && movedFrom.has(`${p}:${d}`)) continue;`
- After the request loop:

```ts
  for (const move of options.leaveMoves ?? []) {
    if (!scope.people.includes(move.personIdx)) continue;
    if (grid[move.personIdx][move.to].kind === "leave") continue;
    issues.push({
      key: `leave-move:p${move.personIdx}:d${move.to}`,
      hard: true,
      severity: 1,
      message: `${name(move.personIdx)} must have leave on ${day(move.to)} (moved from ${day(move.from)}).`,
    });
  }
```

- `checkRosterChange(model, context, before, after, scope, options: CheckOptions = {})`. Evaluate `before` with no options and `after` with `options`.

Run: `cd web && pnpm vitest run lib/roster-viewer/rule-check.test.ts`. Expected: PASS.

---

### Task 5: Swap planner and partner search

**Files:**
- Create: `web/lib/roster-viewer/swap.ts`, `web/lib/roster-viewer/swap-fixtures.ts`
- Test: `web/lib/roster-viewer/swap.test.ts`

**Interfaces:**
- Consumes: Task 4 `checkRosterChange`, `dayCode`, `plainDate` and `RuleModel`; Task 2 `RosterCellChange`.
- Produces:
  - `interface SwapContext { context: RosterContext; days: RosterDayGrid; model: RuleModel }`
  - `type SwapPlan = { ok: true; kind: "exchange" | "cover"; cells: readonly RosterCellChange[]; soft: readonly RuleIssue[]; unchecked: readonly string[] } | { ok: false; reasons: readonly string[] }`
  - `findPersonIdx(context, name): number` (−1 when unknown or ambiguous), `findDateIdx(context, iso): number` and `personName(context, idx): string`
  - `givingProblem(ctx, personIdx, dateIdxs): string | null`
  - `planSwap(ctx, personIdx, partnerIdx, dateIdxs): SwapPlan`
  - `findSwapPartners(ctx, personIdx, dateIdxs, limit = 5): { candidates: SwapCandidate[]; ruledOut: { partnerIdx: number; reason: string }[] }`

- [ ] **Step 1: Write the fixture.** Create `web/lib/roster-viewer/swap-fixtures.ts`:

```ts
// The Priya fixture (bead nursing-sheduler-73z): the live case, small enough to reason
// about by hand. Test-only; not exported from the barrel.
//
//            7 Oct  8 Oct  9 Oct  10 Oct  11 Oct
// SN-Priya   AM     N      N      OFF     OFF
// SN-Ana     N      OFF    OFF    AM      OFF   → takes N on 9, AM on 10: N then AM
// SN-Ben     OFF    OFF    OFF    N       N     → takes both: 4 nights, cap is 3
// SN-Cara    OFF    OFF    OFF    OFF     OFF   → cover: valid, 2 worked days after
// SSN-Dev    PM     PM     PM     PM      PM    → not in Nights: cannot work N
// SN-Eve     OFF    PM     PM     OFF     PM    → exchange: valid, 3 worked days after

import { PREFERENCE_TYPE, type CanonicalScenarioDocument } from "@/lib/scenario";
import type { RosterContext, RosterDayState, RosterDocument } from "@/lib/roster/types";
import { fixtureSubmission } from "@/lib/roster/test-fixtures";

export const PRIYA_DATES = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
export const PRIYA_PEOPLE = ["SN-Priya", "SN-Ana", "SN-Ben", "SN-Cara", "SSN-Dev", "SN-Eve"];

const AM: RosterDayState = { kind: "shift", shiftId: "AM" };
const PM: RosterDayState = { kind: "shift", shiftId: "PM" };
const N: RosterDayState = { kind: "shift", shiftId: "N" };
const OFF: RosterDayState = { kind: "off" };

export function priyaDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: PRIYA_DATES[0], endDate: PRIYA_DATES[4] } },
    people: {
      items: PRIYA_PEOPLE.map((id) => ({ id })),
      groups: [{ id: "Nights", members: PRIYA_PEOPLE.filter((id) => id.startsWith("SN-")) }],
    },
    shiftTypes: {
      items: [
        { id: "AM", startTime: "07:00", endTime: "15:00", durationMinutes: 480 },
        { id: "PM", startTime: "13:00", endTime: "21:00", durationMinutes: 480 },
        { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
      ],
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      { type: PREFERENCE_TYPE.shiftTypeRequirement, description: "One night nurse", shiftType: "N", requiredNumPeople: 1, qualifiedPeople: "Nights", weight: -1 },
      { type: PREFERENCE_TYPE.shiftTypeSuccessions, description: "No morning after night", person: "ALL", pattern: ["N", "AM"], weight: -Infinity },
      { type: PREFERENCE_TYPE.shiftCount, description: "Max 3 nights", person: "ALL", countDates: "ALL", countShiftTypes: "N", expression: "x <= T", target: 3, weight: Infinity },
    ],
  };
}

/** Rows follow PRIYA_PEOPLE; columns follow PRIYA_DATES. */
export function priyaGrid(): RosterDayState[][] {
  return [
    [AM, N, N, OFF, OFF],
    [N, OFF, OFF, AM, OFF],
    [OFF, OFF, OFF, N, N],
    [OFF, OFF, OFF, OFF, OFF],
    [PM, PM, PM, PM, PM],
    [OFF, PM, PM, OFF, PM],
  ];
}

export function priyaContext(): RosterContext {
  return {
    people: PRIYA_PEOPLE.map((id) => ({ id })),
    shiftTypes: [
      { id: "AM", description: "Morning", startTime: "07:00", endTime: "15:00" },
      { id: "PM", description: "Afternoon", startTime: "13:00", endTime: "21:00" },
      { id: "N", description: "Night", startTime: "21:00", endTime: "07:00" },
    ],
    calendar: PRIYA_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
    baselineMinimums: ["AM", "PM", "N"].map((shiftId) => ({ shiftId, unavailable: true as const })),
    leaveCreditMinutes: null,
  };
}

/**
 * A working-roster document for tool tests. Assembled by hand: the tools read only
 * `context`, `solvedDays`, `edits`, `submission` and `provenance`, and the real
 * assembly path is covered by `lib/roster`'s own suite.
 */
export function priyaRosterDocument(): RosterDocument {
  return {
    schemaVersion: "roster-file/1",
    provenance: { solverStatus: "OPTIMAL", score: 0, solvedBaselineId: "a".repeat(64), appBuild: "test" },
    submission: fixtureSubmission(priyaDocument(), []),
    context: priyaContext(),
    solvedDays: priyaGrid(),
    edits: [],
    coordinateMap: { peopleRows: [], dateColumns: [], firstPeopleRow: 1, leadingCols: 1, historyCols: 0, prettify: false },
    frozenXlsx: new Blob([]),
  };
}
```

- [ ] **Step 2: Write the failing test.** Create `web/lib/roster-viewer/swap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRuleModel } from "./rule-check";
import { findPersonIdx, findSwapPartners, givingProblem, planSwap, type SwapContext } from "./swap";
import { priyaContext, priyaDocument, priyaGrid } from "./swap-fixtures";

const ctx: SwapContext = { context: priyaContext(), days: priyaGrid(), model: buildRuleModel(priyaDocument()) };
const [PRIYA, ANA, BEN, CARA, DEV, EVE] = [0, 1, 2, 3, 4, 5];
const NIGHTS = [1, 2]; // 8 and 9 Oct

describe("finding people by the name a nurse types", () => {
  it("matches exactly, then a unique part of the name", () => {
    expect(findPersonIdx(ctx.context, "SN-Priya")).toBe(PRIYA);
    expect(findPersonIdx(ctx.context, "priya")).toBe(PRIYA);
    expect(findPersonIdx(ctx.context, "SN")).toBe(-1); // ambiguous
    expect(findPersonIdx(ctx.context, "Zed")).toBe(-1);
  });
});

describe("planSwap", () => {
  it("plans a cover as four cells and calls it a cover", () => {
    const plan = planSwap(ctx, PRIYA, CARA, NIGHTS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.kind).toBe("cover");
    expect(plan.cells).toEqual([
      { personIdx: PRIYA, dateIdx: 1, before: { kind: "shift", shiftId: "N" }, after: { kind: "off" } },
      { personIdx: CARA, dateIdx: 1, before: { kind: "off" }, after: { kind: "shift", shiftId: "N" } },
      { personIdx: PRIYA, dateIdx: 2, before: { kind: "shift", shiftId: "N" }, after: { kind: "off" } },
      { personIdx: CARA, dateIdx: 2, before: { kind: "off" }, after: { kind: "shift", shiftId: "N" } },
    ]);
  });

  it("refuses a night followed by a morning", () => {
    const plan = planSwap(ctx, PRIYA, ANA, NIGHTS);
    expect(plan).toEqual({
      ok: false,
      reasons: ["SN-Ana works N on 9 Oct, then AM on 10 Oct, which “No morning after night” does not allow."],
    });
  });

  it("refuses a partner the night cap rules out", () => {
    const plan = planSwap(ctx, PRIYA, BEN, NIGHTS);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons[0]).toBe("SN-Ben has 4 counted under “Max 3 nights”, which needs at most 3.");
  });

  it("refuses a partner outside the qualified group", () => {
    const plan = planSwap(ctx, PRIYA, DEV, NIGHTS);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons[0]).toBe("8 Oct: SSN-Dev works N, which only Nights may work.");
  });

  it("refuses a partner who already holds the same shift", () => {
    const plan = planSwap(ctx, DEV, EVE, [1]);
    expect(plan).toEqual({ ok: false, reasons: ["SN-Eve already works PM on 8 Oct."] });
  });

  it("says when the person is not working on a date at all", () => {
    expect(givingProblem(ctx, PRIYA, [3])).toBe("SN-Priya is not working on 10 Oct (day off).");
  });
});

describe("findSwapPartners", () => {
  it("ranks valid partners by fairness and explains who is ruled out", () => {
    const search = findSwapPartners(ctx, PRIYA, NIGHTS);
    expect(search.candidates.map((c) => c.partnerIdx)).toEqual([CARA, EVE]);
    expect(search.candidates[1].plan.kind).toBe("exchange");
    expect(search.ruledOut.map((r) => r.partnerIdx)).toEqual([ANA, BEN, DEV]);
  });
});
```

- [ ] **Step 3: Run it and see it fail.** Run: `cd web && pnpm vitest run lib/roster-viewer/swap.test.ts`. Expected: FAIL, `./swap` does not exist.

- [ ] **Step 4: Implement.** Create `web/lib/roster-viewer/swap.ts`:

```ts
// Planning a shift swap on a produced roster (bead nursing-sheduler-73z).
//
// A swap exchanges two people's day-states on the same dates. It is only offered when
// it introduces no hard issue (`./rule-check`). Leave never moves. When every partner
// cell was OFF, it is a "cover": the person gives the shifts away and has those days
// off, which a hard minimum-shifts count still catches.
//
// Pure, React-free and assistant-free: the assistant's tools call it, and the Roster
// screen can later use it to suggest swaps by hand.

import { dayStatesEqual, typedIdKey } from "@/lib/roster/day-state";
import type { RosterCellChange } from "@/lib/roster/change-request";
import type { RosterContext, RosterDayGrid, RosterDayState } from "@/lib/roster/types";
import { checkRosterChange, dayCode, plainDate, type RuleIssue, type RuleModel } from "./rule-check";

export interface SwapContext {
  readonly context: RosterContext;
  /** The CURRENT assignments (solved + edits). */
  readonly days: RosterDayGrid;
  readonly model: RuleModel;
}

export type SwapPlan =
  | {
      readonly ok: true;
      readonly kind: "exchange" | "cover";
      readonly cells: readonly RosterCellChange[];
      readonly soft: readonly RuleIssue[];
      readonly unchecked: readonly string[];
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

export interface SwapCandidate {
  readonly partnerIdx: number;
  readonly plan: Extract<SwapPlan, { ok: true }>;
  /** How many of the handed-over shift codes the partner holds afterwards. */
  readonly sameShiftsAfter: number;
  readonly workedDaysAfter: number;
}

export const personName = (context: RosterContext, idx: number): string =>
  String(context.people[idx]?.id ?? idx);

/** Exact name, else a unique case-insensitive part of one. −1 when unknown or ambiguous. */
export function findPersonIdx(context: RosterContext, name: string): number {
  const wanted = name.trim();
  const exact = context.people.findIndex((person) => String(person.id) === wanted);
  if (exact >= 0) return exact;
  const lower = wanted.toLowerCase();
  const loose = context.people.flatMap((person, idx) =>
    String(person.id).toLowerCase().includes(lower) ? [idx] : [],
  );
  return lower.length > 0 && loose.length === 1 ? loose[0] : -1;
}

export const findDateIdx = (context: RosterContext, iso: string): number =>
  context.calendar.findIndex((day) => day.iso === iso.trim());

/** Why `personIdx` cannot give up these dates at all, whoever takes them. */
export function givingProblem(ctx: SwapContext, personIdx: number, dateIdxs: readonly number[]): string | null {
  for (const d of dateIdxs) {
    const cell = ctx.days[personIdx][d];
    if (cell.kind !== "shift") {
      const why = cell.kind === "leave" ? "on leave" : "day off";
      return `${personName(ctx.context, personIdx)} is not working on ${plainDate(ctx.context.calendar[d].iso)} (${why}).`;
    }
  }
  return null;
}

export function planSwap(
  ctx: SwapContext,
  personIdx: number,
  partnerIdx: number,
  dateIdxs: readonly number[],
): SwapPlan {
  const partner = personName(ctx.context, partnerIdx);
  if (partnerIdx === personIdx) {
    return { ok: false, reasons: [`${partner} cannot swap with themselves.`] };
  }
  const giving = givingProblem(ctx, personIdx, dateIdxs);
  if (giving !== null) return { ok: false, reasons: [giving] };

  const cells: RosterCellChange[] = [];
  for (const d of dateIdxs) {
    const date = plainDate(ctx.context.calendar[d].iso);
    const mine = ctx.days[personIdx][d];
    const theirs = ctx.days[partnerIdx][d];
    if (theirs.kind === "leave") return { ok: false, reasons: [`${partner} is on leave on ${date}.`] };
    if (dayStatesEqual(mine, theirs)) {
      return { ok: false, reasons: [`${partner} already works ${dayCode(theirs)} on ${date}.`] };
    }
    cells.push(
      { personIdx, dateIdx: d, before: mine, after: theirs },
      { personIdx: partnerIdx, dateIdx: d, before: theirs, after: mine },
    );
  }

  const after: RosterDayState[][] = ctx.days.map((row) => [...row]);
  for (const cell of cells) after[cell.personIdx][cell.dateIdx] = cell.after;
  const check = checkRosterChange(ctx.model, ctx.context, ctx.days, after, {
    people: [personIdx, partnerIdx],
    dates: dateIdxs,
  });
  if (check.hard.length > 0) return { ok: false, reasons: check.hard.map((issue) => issue.message) };
  const kind = dateIdxs.every((d) => ctx.days[partnerIdx][d].kind === "off") ? "cover" : "exchange";
  return { ok: true, kind, cells, soft: check.soft, unchecked: check.unchecked };
}

export function findSwapPartners(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  limit = 5,
): { candidates: SwapCandidate[]; ruledOut: { partnerIdx: number; reason: string }[] } {
  const handedOver = new Set(
    dateIdxs.flatMap((d) => {
      const cell = ctx.days[personIdx][d];
      return cell.kind === "shift" ? [typedIdKey(cell.shiftId)] : [];
    }),
  );
  const candidates: SwapCandidate[] = [];
  const ruledOut: { partnerIdx: number; reason: string }[] = [];
  ctx.context.people.forEach((_person, partnerIdx) => {
    if (partnerIdx === personIdx) return;
    const plan = planSwap(ctx, personIdx, partnerIdx, dateIdxs);
    if (!plan.ok) {
      ruledOut.push({ partnerIdx, reason: plan.reasons[0] });
      return;
    }
    const row = ctx.days[partnerIdx].map(
      (cell, d) => plan.cells.find((c) => c.personIdx === partnerIdx && c.dateIdx === d)?.after ?? cell,
    );
    candidates.push({
      partnerIdx,
      plan,
      sameShiftsAfter: row.filter((c) => c.kind === "shift" && handedOver.has(typedIdKey(c.shiftId))).length,
      workedDaysAfter: row.filter((c) => c.kind === "shift").length,
    });
  });
  // ponytail: fairness = fewest soft issues (the ward's own fairness counts and requests),
  // then fewest of the handed-over shifts, then fewest worked days, then roster order.
  // Ask ward managers before weighting it further (spec, open question 8).
  candidates.sort(
    (a, b) =>
      a.plan.soft.length - b.plan.soft.length ||
      a.sameShiftsAfter - b.sameShiftsAfter ||
      a.workedDaysAfter - b.workedDaysAfter ||
      a.partnerIdx - b.partnerIdx,
  );
  return { candidates: candidates.slice(0, limit), ruledOut };
}
```

- [ ] **Step 5: Run it and see it pass.** Run: `cd web && pnpm vitest run lib/roster-viewer`. Expected: PASS (the existing roster-viewer suites are unaffected).

---

### Task 5A (amendment): Sick or emergency leave, and the escalation ladder

**Files:**
- Modify: `web/lib/roster-viewer/swap.ts`, `web/lib/roster-viewer/swap-fixtures.ts`
- Test: `web/lib/roster-viewer/swap.test.ts`

**Interfaces:**
- Produces:
  - `type CoverReason = "swap" | "sick_or_emergency"`
  - `SwapPlan`'s ok arm widens: `kind: "exchange" | "cover" | "move" | "record"` plus `uncovered: readonly string[]` (empty except for `record`)
  - `planSickCover(ctx, personIdx, partnerIdx: number | null, dateIdxs): SwapPlan`
  - `findSickCovers(ctx, personIdx, dateIdxs, limit = 5)`, with the same result shape as `findSwapPartners`
  - `borrowNeeds(ctx, personIdx, dateIdxs): { dateIdx: number; shift: string; skillGroup: string | null }[]`
  - `findCoverLadder(ctx, personIdx, dateIdxs, reason): CoverLadder` with `step: 1 | 2 | 3`, `candidates`, `trades` (Task 5B), `borrow` and `ruledOut`
- In Task 5's `planSwap`, add `uncovered: []` to its ok return.

- [ ] **Step 1: Write the borrow fixture.** Append to `swap-fixtures.ts`:

```ts
// The borrow fixture: nobody on the ward can take Priya's night on 8 Oct.
//            7 Oct  8 Oct  9 Oct
// SN-Priya   OFF    N      OFF
// SSN-Dev    AM     AM     AM     → not in Nights: cannot move to N
export const BORROW_DATES = ["2026-10-07", "2026-10-08", "2026-10-09"];

export function borrowDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: BORROW_DATES[0], endDate: BORROW_DATES[2] } },
    people: { items: [{ id: "SN-Priya" }, { id: "SSN-Dev" }], groups: [{ id: "Nights", members: ["SN-Priya"] }] },
    shiftTypes: {
      items: [
        { id: "AM", startTime: "07:00", endTime: "15:00", durationMinutes: 480 },
        { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
      ],
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      { type: PREFERENCE_TYPE.shiftTypeRequirement, description: "One night nurse", shiftType: "N", date: "2026-10-08", requiredNumPeople: 1, qualifiedPeople: "Nights", weight: -1 },
    ],
  };
}

export function borrowGrid(): RosterDayState[][] {
  return [
    [OFF, N, OFF],
    [AM, AM, AM],
  ];
}

export function borrowContext(): RosterContext {
  return {
    people: [{ id: "SN-Priya" }, { id: "SSN-Dev" }],
    shiftTypes: [{ id: "AM", description: "Morning" }, { id: "N", description: "Night" }],
    calendar: BORROW_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
    baselineMinimums: ["AM", "N"].map((shiftId) => ({ shiftId, unavailable: true as const })),
    leaveCreditMinutes: null,
  };
}

export function borrowRosterDocument(): RosterDocument {
  return { ...priyaRosterDocument(), submission: fixtureSubmission(borrowDocument(), []), context: borrowContext(), solvedDays: borrowGrid() };
}
```

- [ ] **Step 2: Write the failing tests.** Append to `swap.test.ts` (import the new names and the borrow fixture):

```ts
describe("sick or emergency leave (step 1)", () => {
  it("puts the person on leave and finds a cover or a move", () => {
    const ladder = findCoverLadder(ctx, PRIYA, [1], "sick_or_emergency");
    expect(ladder.step).toBe(1);
    expect(ladder.candidates.slice(0, 2).map((c) => [c.partnerIdx, c.plan.kind])).toEqual([
      [CARA, "cover"],
      [EVE, "move"],
    ]);
    const cover = planSickCover(ctx, PRIYA, CARA, [1]);
    expect(cover.ok && cover.cells[0]).toEqual({ personIdx: PRIYA, dateIdx: 1, before: { kind: "shift", shiftId: "N" }, after: { kind: "leave" } });
  });

  it("records the MC alone and states the gap instead of refusing", () => {
    const plan = planSickCover(ctx, PRIYA, null, [1]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.kind).toBe("record");
    expect(plan.uncovered).toEqual(["8 Oct: “One night nurse” has 0 of the 1 needed."]);
  });
});

describe("the escalation ladder", () => {
  it("returns only the lowest step with an option", () => {
    expect(findCoverLadder(ctx, PRIYA, NIGHTS, "swap").step).toBe(1);
    const borrow = { context: borrowContext(), days: borrowGrid(), model: buildRuleModel(borrowDocument()) };
    const ladder = findCoverLadder(borrow, 0, [1], "sick_or_emergency");
    expect(ladder.step).toBe(3);
    expect(ladder.candidates).toEqual([]);
    expect(ladder.trades).toEqual([]);
    expect(ladder.borrow).toEqual([{ dateIdx: 1, shift: "N", skillGroup: "Nights" }]);
  });
});
```

(Task 5B adds the step 2 case with the Asha fixture.)

- [ ] **Step 3: Run them and see them fail.** Run: `cd web && pnpm vitest run lib/roster-viewer/swap.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement.** In `swap.ts`, widen `SwapPlan`'s ok arm to `kind: "exchange" | "cover" | "move" | "record"; ...; readonly uncovered: readonly string[]` and add `uncovered: []` in `planSwap`. Then append:

```ts
export type CoverReason = "swap" | "sick_or_emergency";

const LEAVE: RosterDayState = { kind: "leave" };
const OFF: RosterDayState = { kind: "off" };

/**
 * Sick or emergency leave: the person goes on LEAVE on the dates and takes nothing back.
 * A partner who was OFF covers; a partner on another shift that day moves (her old shift
 * loses her, so staffing must still hold). `partnerIdx` null records the absence alone:
 * the new shortfall is stated as `uncovered`, never a refusal, because the absence is a fact.
 */
export function planSickCover(
  ctx: SwapContext,
  personIdx: number,
  partnerIdx: number | null,
  dateIdxs: readonly number[],
): SwapPlan {
  const giving = givingProblem(ctx, personIdx, dateIdxs);
  if (giving !== null) return { ok: false, reasons: [giving] };
  if (partnerIdx === personIdx) return { ok: false, reasons: ["Pick someone else to cover."] };
  const cells: RosterCellChange[] = [];
  for (const d of dateIdxs) {
    const mine = ctx.days[personIdx][d];
    cells.push({ personIdx, dateIdx: d, before: mine, after: LEAVE });
    if (partnerIdx === null) continue;
    const theirs = ctx.days[partnerIdx][d];
    const date = plainDate(ctx.context.calendar[d].iso);
    if (theirs.kind === "leave") {
      return { ok: false, reasons: [`${personName(ctx.context, partnerIdx)} is on leave on ${date}.`] };
    }
    if (dayStatesEqual(mine, theirs)) {
      return { ok: false, reasons: [`${personName(ctx.context, partnerIdx)} already works ${dayCode(theirs)} on ${date}.`] };
    }
    cells.push({ personIdx: partnerIdx, dateIdx: d, before: theirs, after: mine });
  }
  const after: RosterDayState[][] = ctx.days.map((row) => [...row]);
  for (const cell of cells) after[cell.personIdx][cell.dateIdx] = cell.after;
  const people = partnerIdx === null ? [personIdx] : [personIdx, partnerIdx];
  const check = checkRosterChange(ctx.model, ctx.context, ctx.days, after, { people, dates: dateIdxs });
  if (partnerIdx === null) {
    return { ok: true, kind: "record", cells, soft: check.soft, unchecked: check.unchecked, uncovered: check.hard.map((i) => i.message) };
  }
  if (check.hard.length > 0) return { ok: false, reasons: check.hard.map((issue) => issue.message) };
  const kind = dateIdxs.every((d) => ctx.days[partnerIdx][d].kind === "off") ? "cover" : "move";
  return { ok: true, kind, cells, soft: check.soft, unchecked: check.unchecked, uncovered: [] };
}
```

Refactor `findSwapPartners` so its loop and ranking take a planner argument, then add `findSickCovers`:

```ts
function rankPartners(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  plan: (partnerIdx: number) => SwapPlan,
  limit: number,
): { candidates: SwapCandidate[]; ruledOut: { partnerIdx: number; reason: string }[] } {
  // (the body of Task 5's findSwapPartners, with `planSwap(ctx, personIdx, partnerIdx, dateIdxs)`
  //  replaced by `plan(partnerIdx)`)
}

export const findSwapPartners = (ctx: SwapContext, personIdx: number, dateIdxs: readonly number[], limit = 5) =>
  rankPartners(ctx, personIdx, dateIdxs, (q) => planSwap(ctx, personIdx, q, dateIdxs), limit);

export const findSickCovers = (ctx: SwapContext, personIdx: number, dateIdxs: readonly number[], limit = 5) =>
  rankPartners(ctx, personIdx, dateIdxs, (q) => planSickCover(ctx, personIdx, q, dateIdxs), limit);

/** Step 3: what a borrowed nurse must cover, and the skill group a requirement demands there. */
export function borrowNeeds(ctx: SwapContext, personIdx: number, dateIdxs: readonly number[]) {
  return dateIdxs.flatMap((dateIdx) => {
    const cell = ctx.days[personIdx][dateIdx];
    if (cell.kind !== "shift") return [];
    const shiftIdx = ctx.model.shiftIndex.get(typedIdKey(cell.shiftId));
    const scoped = ctx.model.equations.find(
      (equation) =>
        equation.unavailable === null &&
        equation.qualifiedLabel !== null &&
        shiftIdx !== undefined &&
        equation.shiftIndices.includes(shiftIdx) &&
        equation.dateIndices.has(dateIdx),
    );
    return [{ dateIdx, shift: String(cell.shiftId), skillGroup: scoped?.qualifiedLabel ?? null }];
  });
}

export interface CoverLadder {
  readonly step: 1 | 2 | 3;
  readonly candidates: readonly SwapCandidate[];
  readonly trades: readonly TradeCandidate[];
  readonly borrow: readonly { dateIdx: number; shift: string; skillGroup: string | null }[];
  readonly ruledOut: readonly { partnerIdx: number; reason: string }[];
}

/**
 * The ward's escalation ladder: 1 swap/cover/move, 2 a trade with someone off or on
 * leave, 3 borrow. Only the lowest step with an option is returned, so the assistant
 * cannot skip a step. Step 3 has no candidates: the user names the borrowed nurse.
 */
export function findCoverLadder(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  reason: CoverReason,
): CoverLadder {
  const step1 =
    reason === "swap" ? findSwapPartners(ctx, personIdx, dateIdxs) : findSickCovers(ctx, personIdx, dateIdxs);
  const empty = { candidates: [], trades: [], borrow: [], ruledOut: step1.ruledOut };
  if (step1.candidates.length > 0) return { ...empty, step: 1, candidates: step1.candidates };
  const trades = findTrades(ctx, personIdx, dateIdxs, reason);
  if (trades.length > 0) return { ...empty, step: 2, trades };
  return { ...empty, step: 3, borrow: borrowNeeds(ctx, personIdx, dateIdxs) };
}
```

- [ ] **Step 5: Run the tests.** They pass after Task 5B adds `findTrades` and `TradeCandidate`. Implement 5B before you run: `cd web && pnpm vitest run lib/roster-viewer/swap.test.ts`.

---

### Task 5B (amendment): Step 2, cross-date trades with a nurse who is off or on leave

**Files:**
- Modify: `web/lib/roster-viewer/swap.ts`, `web/lib/roster-viewer/swap-fixtures.ts`
- Test: `web/lib/roster-viewer/swap.test.ts`

**Interfaces:**
- Consumes: Task 4 Step 5 `LeaveMove` and `checkRosterChange(..., { leaveMoves })`.
- Produces:
  - `type TradeVariant = "person-covers" | "partner-off"`
  - `interface TradePlan { ok: true; kind: "trade"; variant; dateIdxs; laterDateIdxs; cells; leaveMoves; soft; unchecked }`
  - `planTrade(ctx, personIdx, partnerIdx, dateIdxs, laterDateIdxs, variant, reason = "swap"): TradePlan | { ok: false; reasons }`
  - `interface TradeCandidate { partnerIdx: number; plan: TradePlan }` and `findTrades(ctx, personIdx, dateIdxs, reason, limit = 3): TradeCandidate[]`

- [ ] **Step 1: Write the Priya/Asha fixture.** Append to `swap-fixtures.ts`:

```ts
// The Priya/Asha fixture (step 2): nobody can swap or cover Priya's nights on 8-9 Oct.
//            7   8   9   10  11  12  13  14 Oct
// SN-Priya   AM  N   N   OFF OFF OFF OFF OFF
// SN-Asha    OFF LV  LV  OFF AM  AM  OFF OFF  → on leave 8-9: trade, leave moves to 11-12, Priya works her AMs
// SN-Ben     N   OFF OFF AM  OFF N   N   N    → cover: N 7-9 then AM on 10 (and 6 nights)
// SN-Cy      OFF OFF OFF N   N   OFF OFF OFF  → cover: 4 nights in a row. Trade: off 10-11, Priya works his Ns
// SSN-Dev    OFF AM  AM  OFF OFF OFF AM  AM   → not in Nights
export const ASHA_DATES = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
export const ASHA_PEOPLE = ["SN-Priya", "SN-Asha", "SN-Ben", "SN-Cy", "SSN-Dev"];
const LV: RosterDayState = { kind: "leave" };

export function ashaDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: ASHA_DATES[0], endDate: ASHA_DATES[7] } },
    people: {
      items: ASHA_PEOPLE.map((id) => ({ id })),
      groups: [{ id: "Nights", members: ASHA_PEOPLE.filter((id) => id.startsWith("SN-")) }],
    },
    shiftTypes: {
      items: [
        { id: "AM", startTime: "07:00", endTime: "15:00", durationMinutes: 480 },
        { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
      ],
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      { type: PREFERENCE_TYPE.shiftTypeRequirement, description: "One night nurse", shiftType: "N", requiredNumPeople: 1, qualifiedPeople: "Nights", weight: -1 },
      { type: PREFERENCE_TYPE.shiftTypeRequirement, description: "One morning nurse", shiftType: "AM", requiredNumPeople: 1, weight: -1 },
      { type: PREFERENCE_TYPE.shiftTypeSuccessions, description: "No morning after night", person: "ALL", pattern: ["N", "AM"], weight: -Infinity },
      { type: PREFERENCE_TYPE.shiftTypeSuccessions, description: "No four nights in a row", person: "ALL", pattern: ["N", "N", "N", "N"], weight: -Infinity },
      { type: PREFERENCE_TYPE.shiftCount, description: "Max 4 nights", person: "ALL", countDates: "ALL", countShiftTypes: "N", expression: "x <= T", target: 4, weight: Infinity },
      { type: PREFERENCE_TYPE.shiftRequest, description: "Asha's annual leave", person: "SN-Asha", date: ["2026-10-08", "2026-10-09"], shiftType: "LEAVE", weight: 1 },
    ],
  };
}

export function ashaGrid(): RosterDayState[][] {
  return [
    [AM, N, N, OFF, OFF, OFF, OFF, OFF],
    [OFF, LV, LV, OFF, AM, AM, OFF, OFF],
    [N, OFF, OFF, AM, OFF, N, N, N],
    [OFF, OFF, OFF, N, N, OFF, OFF, OFF],
    [OFF, AM, AM, OFF, OFF, OFF, AM, AM],
  ];
}

export function ashaContext(): RosterContext {
  return {
    people: ASHA_PEOPLE.map((id) => ({ id })),
    shiftTypes: [{ id: "AM", description: "Morning" }, { id: "N", description: "Night" }],
    calendar: ASHA_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
    baselineMinimums: ["AM", "N"].map((shiftId) => ({ shiftId, unavailable: true as const })),
    leaveCreditMinutes: null,
  };
}

export function ashaRosterDocument(): RosterDocument {
  return { ...priyaRosterDocument(), submission: fixtureSubmission(ashaDocument(), []), context: ashaContext(), solvedDays: ashaGrid() };
}
```

- [ ] **Step 2: Write the failing tests.** Append to `swap.test.ts`:

```ts
describe("step 2: trades with someone off or on leave", () => {
  const asha = { context: ashaContext(), days: ashaGrid(), model: buildRuleModel(ashaDocument()) };
  const [P, ASHA_IDX, BEN_IDX, CY_IDX] = [0, 1, 2, 3];

  it("offers trades only after step 1 is empty, off trades first", () => {
    const ladder = findCoverLadder(asha, P, [1, 2], "swap");
    expect(ladder.step).toBe(2);
    expect(ladder.ruledOut.find((r) => r.partnerIdx === ASHA_IDX)?.reason).toBe("SN-Asha is on leave on 8 Oct.");
    expect(ladder.trades.map((t) => [t.partnerIdx, t.plan.laterDateIdxs])).toEqual([
      [CY_IDX, [3, 4]],
      [ASHA_IDX, [4, 5]],
    ]);
  });

  it("moves Asha's leave to the later dates and has Priya work her mornings", () => {
    const plan = planTrade(asha, P, ASHA_IDX, [1, 2], [4, 5], "person-covers");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.leaveMoves).toEqual([
      { personIdx: ASHA_IDX, from: 1, to: 4 },
      { personIdx: ASHA_IDX, from: 2, to: 5 },
    ]);
    expect(plan.cells.slice(0, 4)).toEqual([
      { personIdx: P, dateIdx: 1, before: { kind: "shift", shiftId: "N" }, after: { kind: "off" } },
      { personIdx: ASHA_IDX, dateIdx: 1, before: { kind: "leave" }, after: { kind: "shift", shiftId: "N" } },
      { personIdx: ASHA_IDX, dateIdx: 4, before: { kind: "shift", shiftId: "AM" }, after: { kind: "leave" } },
      { personIdx: P, dateIdx: 4, before: { kind: "off" }, after: { kind: "shift", shiftId: "AM" } },
    ]);
  });

  it("checks the later dates too: nobody covering Asha's mornings breaks staffing", () => {
    const plan = planTrade(asha, P, ASHA_IDX, [1, 2], [4, 5], "partner-off");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons).toContain("11 Oct: “One morning nurse” has 0 of the 1 needed.");
  });

  it("checks the day after the moved shifts", () => {
    // Ben is off on 8-9 Oct, but N on 7-9 is followed by his AM on 10 Oct, whatever later dates he gives.
    expect(findTrades(asha, P, [1, 2], "swap").some((t) => t.partnerIdx === BEN_IDX)).toBe(false);
  });

  it("never lets a sick nurse cover later shifts", () => {
    const plan = planTrade(asha, P, ASHA_IDX, [1, 2], [4, 5], "person-covers", "sick_or_emergency");
    expect(plan.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and see it fail.** Run: `cd web && pnpm vitest run lib/roster-viewer/swap.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement.** Append to `swap.ts` (add `type LeaveMove` to the `./rule-check` import):

```ts
export type TradeVariant = "person-covers" | "partner-off";

export interface TradePlan {
  readonly ok: true;
  readonly kind: "trade";
  readonly variant: TradeVariant;
  readonly dateIdxs: readonly number[];
  readonly laterDateIdxs: readonly number[];
  readonly cells: readonly RosterCellChange[];
  readonly leaveMoves: readonly LeaveMove[];
  readonly soft: readonly RuleIssue[];
  readonly unchecked: readonly string[];
}

export interface TradeCandidate {
  readonly partnerIdx: number;
  readonly plan: TradePlan;
}

/**
 * Step 2: a nurse who is OFF or on LEAVE on the given dates works them, and her off or
 * leave moves to later dates she now works (paired in order). `person-covers`: the
 * person works those later shifts. `partner-off`: nobody does, and staffing must still
 * hold. Every affected date, now and later, goes through the same check. Succession
 * windows that touch a changed date are in scope, which covers the day after each
 * moved shift.
 */
export function planTrade(
  ctx: SwapContext,
  personIdx: number,
  partnerIdx: number,
  dateIdxs: readonly number[],
  laterDateIdxs: readonly number[],
  variant: TradeVariant,
  reason: CoverReason = "swap",
): TradePlan | { readonly ok: false; readonly reasons: readonly string[] } {
  const person = personName(ctx.context, personIdx);
  const partner = personName(ctx.context, partnerIdx);
  const fail = (reason: string) => ({ ok: false as const, reasons: [reason] });
  const date = (d: number) => plainDate(ctx.context.calendar[d].iso);
  if (partnerIdx === personIdx) return fail(`${partner} cannot trade with themselves.`);
  if (reason === "sick_or_emergency" && variant === "person-covers") {
    return fail(`${person} is on sick leave, so she cannot work later shifts in return.`);
  }
  if (laterDateIdxs.length !== dateIdxs.length) return fail("A trade needs one later date for each date given up.");
  const giving = givingProblem(ctx, personIdx, dateIdxs);
  if (giving !== null) return fail(giving);
  const last = Math.max(...dateIdxs);

  const cells: RosterCellChange[] = [];
  const leaveMoves: LeaveMove[] = [];
  for (let i = 0; i < dateIdxs.length; i++) {
    const g = dateIdxs[i];
    const l = laterDateIdxs[i];
    if (l <= last) return fail(`The later dates must come after ${date(last)}.`);
    const partnerOnG = ctx.days[partnerIdx][g];
    const partnerOnL = ctx.days[partnerIdx][l];
    const personOnG = ctx.days[personIdx][g];
    if (partnerOnG.kind === "shift") return fail(`${partner} is working on ${date(g)}.`);
    if (partnerOnL.kind !== "shift") return fail(`${partner} is not working on ${date(l)}, so there is nothing to trade back.`);
    cells.push(
      { personIdx, dateIdx: g, before: personOnG, after: reason === "swap" ? OFF : LEAVE },
      { personIdx: partnerIdx, dateIdx: g, before: partnerOnG, after: personOnG },
      { personIdx: partnerIdx, dateIdx: l, before: partnerOnL, after: partnerOnG },
    );
    if (variant === "person-covers") {
      const personOnL = ctx.days[personIdx][l];
      if (personOnL.kind !== "off") return fail(`${person} is working on ${date(l)}, so she cannot cover it.`);
      cells.push({ personIdx, dateIdx: l, before: personOnL, after: partnerOnL });
    }
    if (partnerOnG.kind === "leave") leaveMoves.push({ personIdx: partnerIdx, from: g, to: l });
  }

  const after: RosterDayState[][] = ctx.days.map((row) => [...row]);
  for (const cell of cells) after[cell.personIdx][cell.dateIdx] = cell.after;
  const check = checkRosterChange(
    ctx.model,
    ctx.context,
    ctx.days,
    after,
    { people: [personIdx, partnerIdx], dates: [...dateIdxs, ...laterDateIdxs] },
    { leaveMoves },
  );
  if (check.hard.length > 0) return { ok: false, reasons: check.hard.map((issue) => issue.message) };
  return { ok: true, kind: "trade", variant, dateIdxs, laterDateIdxs, cells, leaveMoves, soft: check.soft, unchecked: check.unchecked };
}

export function findTrades(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  reason: CoverReason,
  limit = 3,
): TradeCandidate[] {
  const k = dateIdxs.length;
  const last = Math.max(...dateIdxs);
  const dayCount = ctx.context.calendar.length;
  const variants: TradeVariant[] = reason === "swap" ? ["person-covers", "partner-off"] : ["partner-off"];
  const found: TradeCandidate[] = [];
  ctx.context.people.forEach((_person, partnerIdx) => {
    if (partnerIdx === personIdx) return;
    if (!dateIdxs.every((d) => ctx.days[partnerIdx][d].kind !== "shift")) return;
    let kept = 0;
    // ponytail: runs of consecutive later days only, two per partner. Widen when wards ask.
    for (let start = last + 1; start + k <= dayCount && kept < 2; start++) {
      const later = Array.from({ length: k }, (_unused, i) => start + i);
      if (!later.every((d) => ctx.days[partnerIdx][d].kind === "shift")) continue;
      for (const variant of variants) {
        const plan = planTrade(ctx, personIdx, partnerIdx, dateIdxs, later, variant, reason);
        if (plan.ok) {
          found.push({ partnerIdx, plan });
          kept++;
          break;
        }
      }
    }
  });
  // ponytail: OFF trades first (no leave record changes), then fewer soft issues, then
  // the earliest later dates, then roster order.
  found.sort(
    (a, b) =>
      a.plan.leaveMoves.length - b.plan.leaveMoves.length ||
      a.plan.soft.length - b.plan.soft.length ||
      a.plan.laterDateIdxs[0] - b.plan.laterDateIdxs[0] ||
      a.partnerIdx - b.partnerIdx,
  );
  return found.slice(0, limit);
}
```

- [ ] **Step 5: Run it and see it pass.** Run: `cd web && pnpm vitest run lib/roster-viewer`. Expected: PASS (Tasks 5, 5A and 5B together).

---

### Task 5C (amendment 2): The Singapore four-step ladder: spare capacity, overtime, temporary nurse, run one short

This supersedes the three-step `findCoverLadder` of Task 5A. The spec's "Cover ladder" has the evidence and the merges. Steps: **1** swap, move, or cover by a nurse with spare capacity. **2** ask an off or on-leave nurse to come in (`overtime` or off-in-lieu `trade`). **3** temporary nurse (relief pool, then other ward or agency). **4** run one short, only with `noTemporaryNurse` and the nurse manager's sign-off, never dropping a qualified (NIC-capable) nurse.

**Order:** do Steps 1–5 (rule-check, fixtures, swap tests, ladder) now. Do the `roster-context.test.ts` cases of Step 3 and Steps 6–7 right after Task 6 Step 5, because they extend the views Task 6 creates.

**Files:**
- Modify: `web/lib/roster-viewer/rule-check.ts`, `web/lib/roster-viewer/swap.ts`, `web/lib/roster-viewer/swap-fixtures.ts`, `web/lib/ai/assistant/roster-context.ts`
- Test: `web/lib/roster-viewer/swap.test.ts`, `web/lib/ai/assistant/roster-context.test.ts`

**Interfaces:**
- `RuleIssue.staffing?: { part: "short" | "over" | "unqualified"; qualified: boolean; required: number; units: number; dateIdx: number; label: string; qualifiedLabel: string | null; scope: string }`
- `countHeadroom(model, grid, personIdx): boolean`
- `findCoverLadder(ctx, personIdx, dateIdxs, reason, options?: { noTemporaryNurse?: boolean }): CoverLadder` with `step: 1 | 2 | 3 | 4`, plus `overtime: SwapCandidate[]` and `short: ShortShiftPlan | null`
- `planShortShift(ctx, personIdx, dateIdxs, reason): ShortShiftPlan`
- Views: `buildOvertimeView`, `buildShortView`. `buildBorrowView` gains a `source` label.

- [ ] **Step 1: Issue metadata and spare capacity (rule-check).** In `listIssues`'s staffing loop, attach to each pushed issue:

```ts
const meta = (part: "short" | "over" | "unqualified") => ({
  part,
  qualified: equation.qualifiedPeople !== null,
  required: cell.required,
  units: cell.units,
  dateIdx: d,
  label,
  qualifiedLabel: equation.qualifiedLabel,
  scope: equation.scopeLabel,
});
// offenders: { ..., staffing: meta("unqualified") }, short: { ..., staffing: meta("short") }, over: { ..., staffing: meta("over") }
```

Then add:

```ts
/**
 * Spare capacity: some count rule for this person has them below its target now. A
 * proxy for "part-timer, or a nurse with hours to spare" (the canonical person has no
 * part-time flag). No count rules means no known capacity. [UNCERTAIN] as ward practice.
 */
export function countHeadroom(model: RuleModel, grid: RosterDayGrid, personIdx: number): boolean {
  return model.counts.some((rule) => {
    if (!rule.people.has(personIdx)) return false;
    let x = 0;
    for (const d of rule.dates) x += rule.coefficients.get(cellIndex(model, grid[personIdx][d])) ?? 0;
    return rule.pairs.some(({ target }) => x < target);
  });
}
```

- [ ] **Step 2: Fixtures.** Append to `swap-fixtures.ts`:

```ts
// Overtime (step 2): like the borrow fixture, plus SN-Kai, off all period and under no count
// rule, so he has no known spare capacity. His cover is an overtime request.
export function overtimeDocument(): CanonicalScenarioDocument {
  const base = borrowDocument();
  return {
    ...base,
    people: { items: [...base.people.items, { id: "SN-Kai" }], groups: [{ id: "Nights", members: ["SN-Priya", "SN-Kai"] }] },
  };
}
export const overtimeGrid = (): RosterDayState[][] => [...borrowGrid(), [OFF, OFF, OFF]];
export const overtimeContext = (): RosterContext => ({
  ...borrowContext(),
  people: [{ id: "SN-Priya" }, { id: "SSN-Dev" }, { id: "SN-Kai" }],
});

// Run one short (step 4): night on 8 Oct needs 2 across N and N+, and N+ is the senior
// (NIC) slot. Dropping Priya (N) leaves 1 with the senior: allowed with sign-off.
// Dropping Lee (N+) drops the senior: never offered.
//            7 Oct  8 Oct  9 Oct
// SN-Priya   OFF    N      OFF
// SSN-Lee    OFF    N+     OFF
export function shortDocument(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    dates: { range: { startDate: BORROW_DATES[0], endDate: BORROW_DATES[2] } },
    people: { items: [{ id: "SN-Priya" }, { id: "SSN-Lee" }], groups: [{ id: "Seniors", members: ["SSN-Lee"] }] },
    shiftTypes: {
      items: [
        { id: "N", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
        { id: "N+", startTime: "21:00", endTime: "07:00", durationMinutes: 600 },
      ],
      groups: [{ id: "AllNights", members: ["N", "N+"] }],
    },
    preferences: [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      { type: PREFERENCE_TYPE.shiftTypeRequirement, description: "Two night nurses", shiftType: "AllNights", date: "2026-10-08", requiredNumPeople: 2, weight: -1 },
      { type: PREFERENCE_TYPE.shiftTypeRequirement, description: "Senior (NIC) on nights", shiftType: "N+", date: "2026-10-08", requiredNumPeople: 1, qualifiedPeople: "Seniors", weight: -1 },
    ],
  };
}
export const shortGrid = (): RosterDayState[][] => [
  [OFF, N, OFF],
  [OFF, { kind: "shift", shiftId: "N+" }, OFF],
];
export const shortContext = (): RosterContext => ({
  people: [{ id: "SN-Priya" }, { id: "SSN-Lee" }],
  shiftTypes: [{ id: "N", description: "Night" }, { id: "N+", description: "Night (senior)" }],
  calendar: BORROW_DATES.map((iso) => ({ iso, weekday: "Wed", weekend: false, holiday: false })),
  baselineMinimums: ["N", "N+"].map((shiftId) => ({ shiftId, unavailable: true as const })),
  leaveCreditMinutes: null,
});
export function shortRosterDocument(): RosterDocument {
  return { ...priyaRosterDocument(), submission: fixtureSubmission(shortDocument(), []), context: shortContext(), solvedDays: shortGrid() };
}
```

- [ ] **Step 3: Write the failing tests.** Append to `swap.test.ts`:

```ts
describe("the Singapore four-step ladder", () => {
  const build = (context: RosterContext, days: RosterDayState[][], document: CanonicalScenarioDocument) => ({
    context,
    days,
    model: buildRuleModel(document),
  });

  it("counts an off nurse under a count target as spare capacity (step 1)", () => {
    expect(countHeadroom(ctx.model, ctx.days, CARA)).toBe(true);
    const ladder = findCoverLadder(ctx, PRIYA, [1], "sick_or_emergency");
    expect(ladder.step).toBe(1);
    expect(ladder.candidates[0]).toMatchObject({ partnerIdx: CARA, plan: { kind: "cover" } });
  });

  it("turns a cover with no known capacity into an overtime request (step 2)", () => {
    const overtime = build(overtimeContext(), overtimeGrid(), overtimeDocument());
    expect(countHeadroom(overtime.model, overtime.days, 2)).toBe(false);
    const ladder = findCoverLadder(overtime, 0, [1], "sick_or_emergency");
    expect(ladder.step).toBe(2);
    expect(ladder.overtime.map((c) => c.partnerIdx)).toEqual([2]);
  });

  it("stays on step 3 until the user says no temporary nurse is available", () => {
    const borrow = build(borrowContext(), borrowGrid(), borrowDocument());
    expect(findCoverLadder(borrow, 0, [1], "sick_or_emergency").step).toBe(3);
    expect(findCoverLadder(borrow, 0, [1], "sick_or_emergency", { noTemporaryNurse: true }).step).toBe(4);
  });

  it("offers run one short when the senior (NIC) stays on the shift", () => {
    const short = build(shortContext(), shortGrid(), shortDocument());
    const ladder = findCoverLadder(short, 0, [1], "sick_or_emergency", { noTemporaryNurse: true });
    expect(ladder.step).toBe(4);
    expect(ladder.short).toMatchObject({
      ok: true,
      shortfalls: [{ dateIdx: 1, label: "Two night nurses", from: 2, to: 1 }],
    });
  });

  it("never offers it when it drops the senior who can be in charge", () => {
    const short = build(shortContext(), shortGrid(), shortDocument());
    const plan = planShortShift(short, 1, [1], "sick_or_emergency");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons[0]).toMatch(/no Seniors nurse on N\+ on 8 Oct/);
  });

  it("never runs a shift with nobody", () => {
    const borrow = build(borrowContext(), borrowGrid(), borrowDocument());
    const plan = planShortShift(borrow, 0, [1], "sick_or_emergency");
    expect(plan.ok).toBe(false);
  });
});
```

Append to `roster-context.test.ts`:

```ts
it("frames an overtime cover as a request with its pay-back", () => {
  const ctx = { context: overtimeContext(), days: overtimeGrid(), model: buildRuleModel(overtimeDocument()) };
  const plan = planSickCover(ctx, 0, 2, [1]);
  if (!plan.ok) throw new Error(plan.reasons.join(" "));
  const view = buildOvertimeView(ctx.context, 0, 2, plan, "sick_or_emergency", "Priya is on MC.");
  expect(view.heading).toBe("Ask SN-Kai to come in?");
  expect(view.agreement).toBe("SN-Kai agreed to come in on 8 Oct for overtime pay.");
});

it("asks for the nurse manager's sign-off to run one short", () => {
  const ctx = { context: shortContext(), days: shortGrid(), model: buildRuleModel(shortDocument()) };
  const plan = planShortShift(ctx, 0, [1], "sick_or_emergency");
  if (!plan.ok) throw new Error(plan.reasons.join(" "));
  const view = buildShortView(ctx.context, 0, plan, "No one is available.");
  expect(view.stepLabel).toBe("Step 4 · Last resort: run one short");
  expect(view.agreement).toBe("My nurse manager has agreed it is safe to run “Two night nurses” on 8 Oct with 1 instead of 2.");
});
```

- [ ] **Step 4: Run them and see them fail.** Run: `cd web && pnpm vitest run lib/roster-viewer/swap.test.ts lib/ai/assistant/roster-context.test.ts`. Expected: FAIL.

- [ ] **Step 5: Implement the ladder (swap.ts).** Import `countHeadroom` and `type RuleIssue`. Replace `CoverLadder` and `findCoverLadder` from Task 5A with:

```ts
export type ShortShiftPlan =
  | {
      readonly ok: true;
      readonly kind: "short";
      readonly cells: readonly RosterCellChange[];
      readonly shortfalls: readonly { dateIdx: number; label: string; from: number; to: number }[];
      readonly soft: readonly RuleIssue[];
      readonly unchecked: readonly string[];
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Step 4, the last resort: leave the shift one short. Mirrors `run_one_short` and the
 * safety floor in `lib/ai/assistant/repair-options.ts`: never to zero, and never below
 * the skill mix. Here that means every NEW hard issue must be a shortfall of exactly one,
 * on a staffing equation with no qualified group (a qualified group is the senior or NIC
 * slot), whose requirement is 2 or more. Anything else is refused and never offered.
 */
export function planShortShift(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  reason: CoverReason,
): ShortShiftPlan {
  const giving = givingProblem(ctx, personIdx, dateIdxs);
  if (giving !== null) return { ok: false, reasons: [giving] };
  const cells: RosterCellChange[] = dateIdxs.map((d) => ({
    personIdx,
    dateIdx: d,
    before: ctx.days[personIdx][d],
    after: reason === "swap" ? OFF : LEAVE,
  }));
  const after: RosterDayState[][] = ctx.days.map((row) => [...row]);
  for (const cell of cells) after[cell.personIdx][cell.dateIdx] = cell.after;
  const check = checkRosterChange(ctx.model, ctx.context, ctx.days, after, { people: [personIdx], dates: dateIdxs });
  const talk = "The app will not offer it. Please talk to your nurse manager or the nursing supervisor.";
  const senior = check.hard.find((i) => i.staffing?.qualified);
  if (senior?.staffing) {
    const s = senior.staffing;
    return {
      ok: false,
      reasons: [
        `Running it short would leave no ${s.qualifiedLabel} nurse on ${s.scope} on ${plainDate(ctx.context.calendar[s.dateIdx].iso)}, and a nurse who can be in charge must stay. ${talk}`,
      ],
    };
  }
  const unsafe = check.hard.find(
    (i) => i.staffing?.part !== "short" || i.severity !== 1 || (i.staffing?.required ?? 0) < 2,
  );
  if (unsafe) {
    const why = unsafe.staffing?.part === "short" ? "would leave the shift too thin" : "breaks another rule";
    return { ok: false, reasons: [`Running it short ${why}: ${unsafe.message} ${talk}`] };
  }
  return {
    ok: true,
    kind: "short",
    cells,
    shortfalls: check.hard.map((i) => ({
      dateIdx: i.staffing!.dateIdx,
      label: i.staffing!.label,
      from: i.staffing!.required,
      to: i.staffing!.required - 1,
    })),
    soft: check.soft,
    unchecked: check.unchecked,
  };
}

export interface CoverLadder {
  readonly step: 1 | 2 | 3 | 4;
  readonly candidates: readonly SwapCandidate[];
  readonly overtime: readonly SwapCandidate[];
  readonly trades: readonly TradeCandidate[];
  readonly borrow: readonly { dateIdx: number; shift: string; skillGroup: string | null }[];
  readonly short: ShortShiftPlan | null;
  readonly ruledOut: readonly { partnerIdx: number; reason: string }[];
}

/**
 * The four-step cover ladder (spec "Cover ladder"). Only the lowest step with an option
 * comes back, so the assistant cannot skip one. Step 4 needs `noTemporaryNurse`: only the
 * user knows whether the relief pool, other wards and agencies said no.
 */
export function findCoverLadder(
  ctx: SwapContext,
  personIdx: number,
  dateIdxs: readonly number[],
  reason: CoverReason,
  options: { noTemporaryNurse?: boolean } = {},
): CoverLadder {
  const found =
    reason === "swap" ? findSwapPartners(ctx, personIdx, dateIdxs, 50) : findSickCovers(ctx, personIdx, dateIdxs, 50);
  // A cover by someone with no known spare capacity is an overtime REQUEST (step 2).
  const isOvertime = (c: SwapCandidate) => c.plan.kind === "cover" && !countHeadroom(ctx.model, ctx.days, c.partnerIdx);
  const base = { candidates: [], overtime: [], trades: [], borrow: [], short: null, ruledOut: found.ruledOut };
  const step1 = found.candidates.filter((c) => !isOvertime(c)).slice(0, 5);
  if (step1.length > 0) return { ...base, step: 1, candidates: step1 };
  const overtime = found.candidates.filter(isOvertime).slice(0, 3);
  const trades = findTrades(ctx, personIdx, dateIdxs, reason);
  if (overtime.length > 0 || trades.length > 0) return { ...base, step: 2, overtime, trades };
  const borrow = borrowNeeds(ctx, personIdx, dateIdxs);
  if (!options.noTemporaryNurse) return { ...base, step: 3, borrow };
  return { ...base, step: 4, borrow, short: planShortShift(ctx, personIdx, dateIdxs, reason) };
}
```

- [ ] **Step 6: Implement the views (roster-context.ts).** Import `planShortShift`'s `type ShortShiftPlan` and `type CoverReason`. Then:

```ts
export function buildOvertimeView(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number,
  plan: Extract<SwapPlan, { ok: true }>,
  reason: CoverReason,
  summary: string,
): RosterChangeView {
  const partner = personName(context, partnerIdx);
  const dates = [...new Set(plan.cells.filter((c) => c.personIdx === partnerIdx).map((c) => c.dateIdx))];
  return {
    heading: `Ask ${partner} to come in?`,
    stepLabel: STEP_LABEL[2],
    title: `${partner} covers ${personName(context, personIdx)}, ${span(context, dates)}`,
    summary,
    rows: rowsOf(context, plan.cells),
    leaveRows: [],
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
    notes: [
      "This is a request: overtime pay or the rest-day rate applies.",
      ...(reason === "sick_or_emergency" ? ["The leave also goes into the leave record, so a new run knows."] : []),
    ],
    agreement: `${partner} agreed to come in on ${span(context, dates)} for overtime pay.`,
  };
}

export function buildShortView(
  context: RosterContext,
  personIdx: number,
  plan: Extract<ShortShiftPlan, { ok: true }>,
  summary: string,
): RosterChangeView {
  const lines = plan.shortfalls.map(
    (s) => `“${s.label}” on ${plainDate(context.calendar[s.dateIdx].iso)} with ${s.to} instead of ${s.from}`,
  );
  return {
    heading: `Run ${lines.length === 1 ? "the shift" : "these shifts"} one short?`,
    stepLabel: STEP_LABEL[4],
    title: `${personName(context, personIdx)} off; ${lines.join("; ")}`,
    summary,
    rows: rowsOf(context, plan.cells),
    leaveRows: [],
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
    notes: ["Only with your nurse manager's sign-off. A senior nurse who can be in charge stays on this shift."],
    agreement: `My nurse manager has agreed it is safe to run ${lines.join("; ")}.`,
  };
}
```

Change `buildBorrowView`'s signature to `(name, source: "relief_pool" | "other_ward" | "agency", groups, needs, question, summary)`. Use `const from = { relief_pool: "relief pool", other_ward: "another ward", agency: "agency" }[source];`. Set the title to `${name} (${from}): ...` and the first note to `Adds ${name} (${from}) as temporary staff, ...`. Append the note `"Please let your nurse manager know."`.

- [ ] **Step 7: Run them and see them pass.** Run: `cd web && pnpm vitest run lib/roster-viewer lib/ai/assistant/roster-context.test.ts`. Expected: PASS, including Tasks 5A and 5B. 5A's "step 1" sick case still holds, because Cara has headroom under "Max 3 nights".

---

### Task 6: What the assistant reads about the roster

**Files:**
- Create: `web/lib/ai/assistant/roster-context.ts`
- Test: `web/lib/ai/assistant/roster-context.test.ts`

**Interfaces:**
- Consumes: `rosterStorage`, `isWorkingRosterFromCandidate` and `type RosterStorage` from `@/lib/store`; Tasks 2, 4 and 5.
- Produces:
  - `type AssistantRosterRead = { status: "ready"; document: RosterDocument; newerRunWaiting: boolean } | { status: "none"; newerRunWaiting: boolean } | { status: "unavailable" }`
  - `readRosterForAssistant(storage?: Pick<RosterStorage, "readWorking" | "readCurrentCandidate">): Promise<AssistantRosterRead>`
  - `summarizeRoster(document, filter: { fromDate?: string; toDate?: string; people?: readonly string[] }, newerRunWaiting: boolean): RosterSummary | string`
  - `interface RosterChangeView { title: string; summary: string; rows: { person: string; date: string; now: string; after: string }[]; worthKnowing: string[]; notChecked: string[] }`
  - `buildRosterChangeView(context, personIdx, partnerIdx, plan, summary): RosterChangeView`
  - `describeRosterChangeOutcome(outcome: RosterChangeOutcome | null): string | undefined`

- [ ] **Step 1: Write the failing test.** Create `web/lib/ai/assistant/roster-context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRuleModel } from "@/lib/roster-viewer/rule-check";
import { planSwap } from "@/lib/roster-viewer/swap";
import { priyaContext, priyaDocument, priyaGrid, priyaRosterDocument } from "@/lib/roster-viewer/swap-fixtures";
import { buildRosterChangeView, readRosterForAssistant, summarizeRoster } from "./roster-context";

const row = { document: priyaRosterDocument(), revision: 1, candidateSource: { jobId: "job-1", candidateVersion: 1 } };
const pointer = { jobId: "job-1", candidateVersion: 1, submissionOrdinal: 1 };

describe("readRosterForAssistant", () => {
  it("reads the working roster and sees no newer run when it came from the latest one", async () => {
    const read = await readRosterForAssistant({ readWorking: async () => row as never, readCurrentCandidate: async () => pointer });
    expect(read).toMatchObject({ status: "ready", newerRunWaiting: false });
  });

  it("flags a newer run that has not been loaded", async () => {
    const read = await readRosterForAssistant({
      readWorking: async () => row as never,
      readCurrentCandidate: async () => ({ ...pointer, jobId: "job-2" }),
    });
    expect(read).toMatchObject({ status: "ready", newerRunWaiting: true });
  });

  it("says unavailable, not empty, when storage cannot be read", async () => {
    const read = await readRosterForAssistant({
      readWorking: async () => {
        throw new Error("no IndexedDB");
      },
      readCurrentCandidate: async () => null,
    });
    expect(read).toEqual({ status: "unavailable" });
  });
});

describe("summarizeRoster", () => {
  it("gives one row of codes per person for the asked range", () => {
    const summary = summarizeRoster(priyaRosterDocument(), { fromDate: "2026-10-08", toDate: "2026-10-09", people: ["Priya"] }, false);
    if (typeof summary === "string") throw new Error(summary);
    expect(summary.dates).toEqual(["2026-10-08", "2026-10-09"]);
    expect(summary.rows).toEqual([{ person: "SN-Priya", days: ["N", "N"] }]);
    expect(summary.rulesBrokenNow).toEqual([]);
  });

  it("refuses an unknown name and lists who is on the roster", () => {
    expect(summarizeRoster(priyaRosterDocument(), { people: ["Zed"] }, false)).toMatch(/Not on this roster: Zed.*SN-Priya/);
  });
});

describe("buildRosterChangeView", () => {
  it("shows every changed cell in the ward's words", () => {
    const ctx = { context: priyaContext(), days: priyaGrid(), model: buildRuleModel(priyaDocument()) };
    const plan = planSwap(ctx, 0, 5, [1, 2]);
    if (!plan.ok) throw new Error(plan.reasons.join(" "));
    const view = buildRosterChangeView(ctx.context, 0, 5, plan, "Priya needs those nights off.");
    expect(view.title).toBe("SN-Priya and SN-Eve, 8 Oct and 9 Oct");
    expect(view.rows[0]).toEqual({ person: "SN-Priya", date: "8 Oct", now: "N", after: "PM" });
    expect(view.rows).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `cd web && pnpm vitest run lib/ai/assistant/roster-context.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** Create `web/lib/ai/assistant/roster-context.ts`:

```ts
// What the assistant may read about the saved roster (bead nursing-sheduler-73z).
//
// A READ OF THE SAME ROWS THE ROSTER SCREEN READS (`useWorkingRoster`): the working
// roster, plus whether a newer run's roster is waiting to be Loaded. Nothing here
// writes; a swap reaches the roster only through the Roster screen's own edit session
// (`lib/roster/change-request.ts`).

import { deriveCurrentDays, type RosterContext, type RosterDocument } from "@/lib/roster";
import type { RosterChangeOutcome } from "@/lib/roster/change-request";
import { dayCode, deriveRuleModel, listIssues, plainDate } from "@/lib/roster-viewer/rule-check";
import { shiftTimeRange } from "@/lib/roster-viewer/shift-label";
import { findPersonIdx, personName, type SwapPlan } from "@/lib/roster-viewer/swap";
import { isWorkingRosterFromCandidate, rosterStorage, type RosterStorage } from "@/lib/store";

export type AssistantRosterRead =
  | { status: "ready"; document: RosterDocument; newerRunWaiting: boolean }
  | { status: "none"; newerRunWaiting: boolean }
  | { status: "unavailable" };

export async function readRosterForAssistant(
  storage: Pick<RosterStorage, "readWorking" | "readCurrentCandidate"> = rosterStorage,
): Promise<AssistantRosterRead> {
  try {
    const [working, pointer] = await Promise.all([
      storage.readWorking<RosterDocument>(),
      storage.readCurrentCandidate(),
    ]);
    if (working === null) return { status: "none", newerRunWaiting: pointer !== null };
    // The same rule as the Roster screen's Load offer (`roster-section.tsx:88-115`).
    const newerRunWaiting =
      pointer !== null && !isWorkingRosterFromCandidate(working.candidateSource ?? undefined, pointer);
    return { status: "ready", document: working.document, newerRunWaiting };
  } catch {
    return { status: "unavailable" };
  }
}

export interface RosterSummary {
  status: "ready";
  newerRunWaiting: boolean;
  changedByHand: boolean;
  solvedAs: "optimal" | "feasible";
  period: { start: string; end: string };
  shiftTypes: { code: string; name: string; time: string }[];
  dates: string[];
  rows: { person: string; days: string[] }[];
  rulesBrokenNow: string[];
  lastChange?: string;
  guidance: string;
}

const ROSTER_GUIDANCE =
  "Each row lists one person's day for each date: a shift code from shiftTypes, OFF for a " +
  "day off, or LEAVE. Answer questions about who works when from this; never ask the user. " +
  "To change who works a shift, use find_swap_partners, then prepare_roster_swap.";

export function summarizeRoster(
  document: RosterDocument,
  filter: { fromDate?: string; toDate?: string; people?: readonly string[] },
  newerRunWaiting: boolean,
): RosterSummary | string {
  const { context } = document;
  const isos = context.calendar.map((day) => day.iso);
  const first = isos[0];
  const last = isos[isos.length - 1];
  const from = filter.fromDate ?? first;
  const to = filter.toDate ?? last;
  const dateIdxs = isos.flatMap((iso, idx) => (iso >= from && iso <= to ? [idx] : []));
  if (dateIdxs.length === 0) {
    return `No roster dates fall in that range. This roster runs from ${first} to ${last}.`;
  }
  let people = context.people.map((_person, idx) => idx);
  if (filter.people && filter.people.length > 0) {
    const found = filter.people.map((name) => findPersonIdx(context, name));
    const missing = filter.people.filter((_name, i) => found[i] < 0);
    if (missing.length > 0) {
      const everyone = context.people.map((person) => String(person.id)).join(", ");
      return `Not on this roster: ${missing.join(", ")}. People on it: ${everyone}.`;
    }
    people = [...new Set(found)];
  }
  const days = deriveCurrentDays(document.solvedDays, document.edits);
  const model = deriveRuleModel(document.submission);
  // ponytail: the whole range goes back in one answer; a ward period is about 4-6 weeks.
  const rulesBrokenNow =
    model === null
      ? []
      : listIssues(model, context, days, { people: context.people.map((_p, i) => i), dates: dateIdxs })
          .filter((issue) => issue.hard)
          .slice(0, 20)
          .map((issue) => issue.message);
  return {
    status: "ready",
    newerRunWaiting,
    changedByHand: document.edits.length > 0,
    solvedAs: document.provenance.solverStatus === "OPTIMAL" ? "optimal" : "feasible",
    period: { start: first, end: last },
    shiftTypes: context.shiftTypes.map((shift) => ({
      code: String(shift.id),
      name: shift.description ?? String(shift.id),
      time: shiftTimeRange(shift) ?? "",
    })),
    dates: dateIdxs.map((d) => isos[d]),
    rows: people.map((p) => ({ person: personName(context, p), days: dateIdxs.map((d) => dayCode(days[p][d])) })),
    rulesBrokenNow,
    guidance: newerRunWaiting
      ? `${ROSTER_GUIDANCE} A newer roster from the last run is waiting: tell the user to press Load on the Roster screen if they mean that one.`
      : ROSTER_GUIDANCE,
  };
}

export interface RosterChangeView {
  /** "Swap shifts?", "Trade shifts?", "Cover SN-Priya's sick leave?", "Borrow a nurse?" */
  heading: string;
  /** "Step 1 · Swap or cover within the ward" and so on: the ladder step, said plainly. */
  stepLabel: string;
  title: string;
  /** The model's reason. Shown as its reasoning, never as an instruction. */
  summary: string;
  rows: { person: string; date: string; now: string; after: string }[];
  /** One line per moved leave: "SN-Asha's leave: 8–9 Oct → 11–12 Oct". */
  leaveRows: string[];
  worthKnowing: string[];
  notChecked: string[];
  /** Plain lines under the table ("Night on 8 Oct is still uncovered."). */
  notes: string[];
  /** The real-world agreement to tick before Apply, or null when none is needed. */
  agreement: string | null;
}

export const STEP_LABEL = {
  1: "Step 1 · Swap or cover within the ward",
  2: "Step 2 · Ask someone off or on leave to come in",
  3: "Step 3 · Ask for a temporary nurse",
  4: "Step 4 · Last resort: run one short",
} as const;

function joinDates(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function buildRosterChangeView(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number,
  plan: Extract<SwapPlan, { ok: true }>,
  summary: string,
): RosterChangeView {
  const dates = [...new Set(plan.cells.map((cell) => cell.dateIdx))].map((d) =>
    plainDate(context.calendar[d].iso),
  );
  return {
    heading: "Swap shifts?",
    stepLabel: STEP_LABEL[1],
    leaveRows: [],
    notes: [],
    agreement: null,
    title: `${personName(context, personIdx)} and ${personName(context, partnerIdx)}, ${joinDates(dates)}`,
    summary,
    rows: plan.cells.map((cell) => ({
      person: personName(context, cell.personIdx),
      date: plainDate(context.calendar[cell.dateIdx].iso),
      now: dayCode(cell.before),
      after: dayCode(cell.after),
    })),
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
  };
}

/** The last swap's fate, in words the model can pass on. Absent when there is none. */
export function describeRosterChangeOutcome(outcome: RosterChangeOutcome | null): string | undefined {
  switch (outcome) {
    case "applied":
      return "The last swap the user applied is on the roster.";
    case "roster-changed":
      return "The last swap was NOT applied: the roster changed after it was prepared. Offer to prepare it again.";
    case "rejected":
      return "The last swap was NOT applied: the Roster screen refused it. Suggest making it by hand there.";
    case "expired":
      return "The last swap was NOT applied: the Roster screen did not open in time. The user can press Apply again after asking you to prepare it again.";
    default:
      return undefined;
  }
}
```

- [ ] **Step 4: Run it and see it pass.** Run: `cd web && pnpm vitest run lib/ai/assistant/roster-context.test.ts`. Expected: PASS.

- [ ] **Step 5 (amendment): trade, sick and borrow views.** Append to the test file (import the Asha and borrow fixtures and `planTrade` / `planSickCover`):

```ts
describe("ladder views", () => {
  it("says the Asha agreement in one plain sentence", () => {
    const ctx = { context: ashaContext(), days: ashaGrid(), model: buildRuleModel(ashaDocument()) };
    const plan = planTrade(ctx, 0, 1, [1, 2], [4, 5], "person-covers");
    if (!plan.ok) throw new Error(plan.reasons.join(" "));
    const view = buildTradeView(ctx.context, 0, 1, plan, "Priya needs those nights off.");
    expect(view.stepLabel).toBe("Step 2 · Ask someone off or on leave to come in");
    expect(view.agreement).toBe(
      "SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead, and SN-Priya agreed to work 11–12 Oct.",
    );
    expect(view.leaveRows).toEqual(["SN-Asha's leave: 8–9 Oct → 11–12 Oct"]);
    expect(view.notes).toContain("This changes the roster and the leave record together.");
  });

  it("states the gap when only the MC is recorded", () => {
    const ctx = { context: priyaContext(), days: priyaGrid(), model: buildRuleModel(priyaDocument()) };
    const plan = planSickCover(ctx, 0, null, [1]);
    if (!plan.ok) throw new Error("record should never refuse");
    const view = buildSickView(ctx.context, 0, null, plan, "MC.");
    expect(view.heading).toBe("Cover SN-Priya's MC?");
    expect(view.notes).toContain("Still uncovered: 8 Oct: “One night nurse” has 0 of the 1 needed.");
  });
});
```

Append to `roster-context.ts` (import `calendarSpan` from `@/lib/proposal/assumptions`, plus `type TradePlan` from `@/lib/roster-viewer/swap`):

```ts
/** "8–9 Oct" for a run of days, "8 Oct and 10 Oct" otherwise. */
function span(context: RosterContext, dateIdxs: readonly number[]): string {
  const sorted = [...dateIdxs].sort((a, b) => a - b);
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  const iso = (d: number) => context.calendar[d].iso;
  return consecutive
    ? calendarSpan(iso(sorted[0]), iso(sorted[sorted.length - 1]))
    : joinDates(sorted.map((d) => plainDate(iso(d))));
}

const rowsOf = (context: RosterContext, cells: Extract<SwapPlan, { ok: true }>["cells"]) =>
  cells.map((cell) => ({
    person: personName(context, cell.personIdx),
    date: plainDate(context.calendar[cell.dateIdx].iso),
    now: dayCode(cell.before),
    after: dayCode(cell.after),
  }));

/** The one sentence the user ticks before a trade can apply. */
export function tradeAgreement(context: RosterContext, personIdx: number, partnerIdx: number, plan: TradePlan): string {
  const person = personName(context, personIdx);
  const partner = personName(context, partnerIdx);
  const given = span(context, plan.dateIdxs);
  const later = span(context, plan.laterDateIdxs);
  const moved = plan.leaveMoves.length;
  const away =
    moved === plan.dateIdxs.length
      ? `take leave on ${later} instead`
      : moved === 0
        ? `have ${later} off instead (off-in-lieu)`
        : `move her leave and days off to ${later}`;
  const cover = plan.variant === "person-covers" ? `, and ${person} agreed to work ${later}` : "";
  return `${partner} agreed to come in on ${given} and ${away}${cover}.`;
}

export function buildTradeView(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number,
  plan: TradePlan,
  summary: string,
): RosterChangeView {
  const partner = personName(context, partnerIdx);
  const moves = plan.leaveMoves;
  return {
    heading: `Ask ${partner} to come in?`,
    stepLabel: STEP_LABEL[2],
    title: `${personName(context, personIdx)} and ${partner}: ${span(context, plan.dateIdxs)} for ${span(context, plan.laterDateIdxs)}`,
    summary,
    rows: rowsOf(context, plan.cells),
    leaveRows:
      moves.length === 0
        ? []
        : [`${partner}'s leave: ${span(context, moves.map((m) => m.from))} → ${span(context, moves.map((m) => m.to))}`],
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
    notes: moves.length > 0 ? ["This changes the roster and the leave record together."] : [],
    agreement: tradeAgreement(context, personIdx, partnerIdx, plan),
  };
}

export function buildSickView(
  context: RosterContext,
  personIdx: number,
  partnerIdx: number | null,
  plan: Extract<SwapPlan, { ok: true }>,
  summary: string,
): RosterChangeView {
  const person = personName(context, personIdx);
  const dates = [...new Set(plan.cells.filter((c) => c.personIdx === personIdx).map((c) => c.dateIdx))];
  return {
    heading: `Cover ${person}'s MC?`,
    stepLabel: STEP_LABEL[1],
    title:
      partnerIdx === null
        ? `${person} on leave ${span(context, dates)}`
        : `${person} on leave ${span(context, dates)}; ${personName(context, partnerIdx)} covers`,
    summary,
    rows: rowsOf(context, plan.cells),
    leaveRows: [],
    worthKnowing: plan.soft.map((issue) => issue.message),
    notChecked: [...plan.unchecked],
    notes: [
      "The leave also goes into the leave record, so a new run knows.",
      ...plan.uncovered.map((message) => `Still uncovered: ${message}`),
    ],
    agreement: null,
  };
}

/** Step 3, C1: the schedule change only. `question` is the proposal's lending-ward question. */
export function buildBorrowView(
  name: string,
  groups: readonly string[],
  needs: readonly { date: string; shift: string }[],
  question: string | null,
  summary: string,
): RosterChangeView {
  const qualified = groups.length > 0 ? `, and qualified as ${groups.join(", ")}` : "";
  return {
    heading: "Ask for a temporary nurse?",
    stepLabel: STEP_LABEL[3],
    title: `${name} from another ward: ${needs.map((n) => `${n.shift} on ${n.date}`).join(", ")}`,
    summary,
    rows: [],
    leaveRows: [],
    worthKnowing: [],
    notChecked: [],
    notes: [
      `Adds ${name} as temporary staff, off on every other date${qualified}.`,
      `${name}'s roster row appears after the next run.`,
    ],
    agreement: question,
  };
}
```

Run: `cd web && pnpm vitest run lib/ai/assistant/roster-context.test.ts`. Expected: PASS.

---

### Task 7: The assistant store holds the live swap card

**Files:**
- Modify: `web/lib/ai/assistant/store.ts`
- Test: covered by Tasks 8 and 9 (`activeRosterChange` assertions).

**Interfaces:**
- Produces: `AssistantUiState.activeRosterChange: { request: RosterChangeRequest; view: RosterChangeView; turnEpoch: number } | null`, `assistantActions.showRosterChange(change, turnEpoch)`, `assistantActions.clearRosterChange()`. `turnAwaitsUserOnCard` also counts this card.

- [ ] **Step 1: Implement.** In `web/lib/ai/assistant/store.ts`:
  - Imports: `import type { RosterChangeRequest } from "@/lib/roster/change-request";` and `import type { RosterChangeView } from "./roster-context";` (type-only, so there is no runtime cycle).
  - In `AssistantUiState`, after `activeRunRequest`:

```ts
  /**
   * The live "Swap shifts?" card from `prepare_roster_swap`, stamped with the turn that
   * asked for it. Same authority rule as `activeRunRequest`: after an interruption it
   * renders as stopped with no Apply control. In memory only.
   */
  activeRosterChange: {
    /** Changes on every show, so the card resets its agreement tick. */
    id: number;
    /** The roster cells, or null for a schedule-only change (step 3, C1). */
    request: RosterChangeRequest | null;
    view: RosterChangeView;
    /** The linked schedule proposal (leave move, MC leave, borrowed person) applied with it. */
    linked: { proposalId: string; assumptionIds: string[] } | null;
    turnEpoch: number;
  } | null;
```

  - In `INITIAL`: `activeRosterChange: null,`.
  - In `assistantActions`, after `clearRunRequest`:

```ts
  /** Show the swap card for the change the current turn prepared, replacing any earlier one. */
  showRosterChange(
    change: {
      request: RosterChangeRequest | null;
      view: RosterChangeView;
      linked?: { proposalId: string; assumptionIds: string[] } | null;
    },
    turnEpoch: number,
  ): void {
    const previous = useAssistantStore.getState().activeRosterChange;
    useAssistantStore.setState({
      activeRosterChange: { ...change, linked: change.linked ?? null, id: (previous?.id ?? 0) + 1, turnEpoch },
    });
  },

  /** Dismiss the swap card: Apply was pressed, or the user said not now. */
  clearRosterChange(): void {
    useAssistantStore.setState({ activeRosterChange: null });
  },
```

  - In `turnAwaitsUserOnCard`:

```ts
  const { activeChoices, activeRunRequest, activeRosterChange } = useAssistantStore.getState();
  return (
    activeChoices?.turnEpoch === turnEpoch ||
    activeRunRequest?.turnEpoch === turnEpoch ||
    activeRosterChange?.turnEpoch === turnEpoch
  );
```

- [ ] **Step 2: Typecheck.** Run: `cd web && pnpm typecheck`. Expected: no errors.

---

### Task 8: The three roster tools, registration and the locked lists

**Files:**
- Create: `web/components/ai/use-roster-tools.ts`
- Modify: `web/components/ai/use-context-tools.ts`, `web/components/ai/model-visible-tools.ts`
- Modify (locked): `web/lib/ai/phase-2-absence.test.ts`, `web/lib/capability/tools.test.ts`, `web/lib/ai/runtime/model-visible-tools.test.ts`
- Test: `web/components/ai/use-roster-tools.test.tsx`

**Interfaces:**
- Produces: `rosterReadParameters`, `swapPartnerParameters` and `swapPrepareParameters` (zod), and `useRosterTools(agentId: string, turnEpoch: number): void`.

- [ ] **Step 1: Write the failing test.** Create `web/components/ai/use-roster-tools.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useRosterChangeStore } from "@/lib/roster/change-request";
import { priyaRosterDocument } from "@/lib/roster-viewer/swap-fixtures";
import { useRosterTools } from "./use-roster-tools";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

interface CapturedTool {
  name: string;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}
const captured: CapturedTool[] = [];
vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (definition: CapturedTool) => {
    if (!captured.some((tool) => tool.name === definition.name)) captured.push(definition);
  },
  useCopilotKit: () => ({ copilotkit: {} }),
}));

const fixture = vi.hoisted(() => ({ working: null as unknown, pointer: null as unknown }));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    rosterStorage: {
      ...actual.rosterStorage,
      readWorking: async () => fixture.working,
      readCurrentCandidate: async () => fixture.pointer,
    },
  };
});

const TURN = 5;
let boundTurn: TestTurnHandle;

function Host() {
  useRosterTools("scheduler:thread-1", TURN);
  return null;
}
const tool = (name: string) => {
  const found = captured.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool "${name}" was never registered`);
  return found;
};

beforeEach(() => {
  captured.length = 0;
  fixture.working = { document: priyaRosterDocument(), revision: 1, candidateSource: { jobId: "job-1", candidateVersion: 1 } };
  fixture.pointer = { jobId: "job-1", candidateVersion: 1, submissionOrdinal: 1 };
  useAssistantStore.setState({ turnEpoch: TURN });
  useRosterChangeStore.setState({ pending: null, last: null });
  boundTurn = bindTurnForTest({ turnEpoch: TURN });
  render(<Host />);
});

afterEach(() => {
  boundTurn.release();
  cleanup();
  assistantActions.resetForTest();
});

const PRIYA_NIGHTS = { person: "SN-Priya", dates: ["2026-10-08", "2026-10-09"], reason: "swap" };

describe("the roster tools", () => {
  it("registers exactly the three tools", () => {
    expect(captured.map((t) => t.name).sort()).toEqual(["find_swap_partners", "get_roster", "prepare_roster_swap"]);
  });
});

describe("get_roster", () => {
  it("reads who works what", async () => {
    const answer = (await tool("get_roster").handler({ people: ["Priya"] }, {})) as { rows: unknown };
    expect(answer.rows).toEqual([{ person: "SN-Priya", days: ["AM", "N", "N", "OFF", "OFF"] }]);
  });

  it("says there is no roster yet and how to get one", async () => {
    fixture.working = null;
    fixture.pointer = null;
    expect(await tool("get_roster").handler({}, {})).toMatch(/no saved roster.*request_optimize_run/i);
  });

  it("reports the last change outcome", async () => {
    useRosterChangeStore.setState({ pending: null, last: "roster-changed" });
    const answer = (await tool("get_roster").handler({}, {})) as { lastChange?: string };
    expect(answer.lastChange).toMatch(/NOT applied/);
  });
});

describe("find_swap_partners", () => {
  it("ranks who can take Priya's nights and says who cannot", async () => {
    const answer = (await tool("find_swap_partners").handler(PRIYA_NIGHTS, {})) as {
      candidates: { partner: string; kind: string }[];
      ruledOutExamples: { partner: string; reason: string }[];
    };
    expect(answer.candidates.map((c) => [c.partner, c.kind])).toEqual([
      ["SN-Cara", "cover"],
      ["SN-Eve", "exchange"],
    ]);
    expect(answer.ruledOutExamples[0]).toEqual({
      partner: "SN-Ana",
      reason: "SN-Ana works N on 9 Oct, then AM on 10 Oct, which “No morning after night” does not allow.",
    });
  });

  it("refuses a date outside the roster", async () => {
    expect(await tool("find_swap_partners").handler({ person: "SN-Priya", dates: ["2026-11-01"], reason: "swap" }, {})).toMatch(
      /outside this roster/,
    );
  });

  it("refuses to swap while a newer run waits", async () => {
    fixture.pointer = { jobId: "job-2", candidateVersion: 1, submissionOrdinal: 2 };
    expect(await tool("find_swap_partners").handler(PRIYA_NIGHTS, {})).toMatch(/press Load/);
  });
});

describe("prepare_roster_swap", () => {
  it("refuses a rule-breaking swap and shows no card", async () => {
    const answer = await tool("prepare_roster_swap").handler({ ...PRIYA_NIGHTS, partner: "SN-Ana", summary: "Swap." }, {});
    expect(answer).toMatch(/No morning after night/);
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
  });

  it("shows a card stamped with the turn and changes nothing", async () => {
    const answer = await tool("prepare_roster_swap").handler(
      { ...PRIYA_NIGHTS, partner: "SN-Cara", summary: "Priya needs those nights off." },
      {},
    );
    expect(answer).toMatch(/Nothing has changed/);
    const card = useAssistantStore.getState().activeRosterChange;
    expect(card?.turnEpoch).toBe(TURN);
    expect(card?.request.cells).toHaveLength(4);
    expect(card?.request.solvedBaselineId).toBe("a".repeat(64));
    expect(useRosterChangeStore.getState().pending).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `cd web && pnpm vitest run components/ai/use-roster-tools.test.tsx`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.** Create `web/components/ai/use-roster-tools.ts`:

```tsx
"use client";

// The assistant's roster tools (bead nursing-sheduler-73z, plan 2026-09-24-roster-aware-assistant).
//
// READ, SUGGEST, OFFER. `get_roster` reads the saved roster. `find_swap_partners` asks
// the HOST who can take someone's shifts without breaking a hard rule the roster was
// solved under. `prepare_roster_swap` shows a card with the exact cells. Only the
// user's Apply click changes the roster, through the Roster screen's own edit session
// (`lib/roster/change-request.ts`): one undo step, one autosave, the same export.
// No handler writes a roster, a scenario or a proposal row.

import { z } from "zod";
import { useModelVisibleTool } from "./register-model-visible-tool";
import { assistantActions } from "@/lib/ai/assistant/store";
import {
  buildRosterChangeView,
  describeRosterChangeOutcome,
  readRosterForAssistant,
  summarizeRoster,
  type AssistantRosterRead,
} from "@/lib/ai/assistant/roster-context";
import { deriveCurrentDays } from "@/lib/roster";
import { readRosterChangeOutcome } from "@/lib/roster/change-request";
import { dayCode, deriveRuleModel } from "@/lib/roster-viewer/rule-check";
import {
  findDateIdx,
  findPersonIdx,
  findSwapPartners,
  givingProblem,
  personName,
  planSwap,
  type SwapContext,
} from "@/lib/roster-viewer/swap";
import { assertTurnAuthority, SUPERSEDED } from "./turn-authority";

const DATE_HELP = "A roster date as YYYY-MM-DD.";

export const rosterReadParameters = z.object({
  fromDate: z.string().optional().describe(`${DATE_HELP} Omit to start at the roster's first day.`),
  toDate: z.string().optional().describe(`${DATE_HELP} Omit to end at the roster's last day.`),
  people: z
    .array(z.string().min(1))
    .max(40)
    .optional()
    .describe("Only these people, by the name the roster shows. Omit for everyone."),
});

const REASON = z
  .enum(["swap", "sick_or_emergency"])
  .describe(
    "swap: the person wants to change these shifts. sick_or_emergency: the person is on sick, " +
      "MC or emergency leave on these dates; they go on leave and take nothing back.",
  );

export const swapPartnerParameters = z.object({
  person: z.string().min(1).describe("The person who needs to give up shifts, as the roster names them."),
  dates: z.array(z.string()).min(1).max(7).describe(`The dates they need to give up. ${DATE_HELP}`),
  reason: REASON,
});

export const swapPrepareParameters = swapPartnerParameters.extend({
  partner: z
    .string()
    .optional()
    .describe("Who takes the shifts, as the roster names them. Omit only to record sick leave with no cover."),
  laterDates: z
    .array(z.string())
    .max(7)
    .optional()
    .describe(`Step 2 trades only: the later dates from find_swap_partners, in the same order. ${DATE_HELP}`),
  summary: z
    .string()
    .min(1)
    .describe("Why, in one plain sentence a ward manager understands. Shown as your reasoning."),
});

const NO_ROSTER =
  "There is no saved roster yet. If the user wants one, offer a run with request_optimize_run.";
const UNREADABLE =
  "The saved roster cannot be read in this browser right now, and nothing was changed. Tell the " +
  "user, and suggest they open the Roster screen.";
const LOAD_FIRST =
  "A newer roster from the last optimiser run is waiting to be loaded, so no swap was prepared. " +
  "Ask the user to open the Roster screen and press Load first, so the swap is made on the roster they mean.";

type Resolved =
  | { ok: true; ctx: SwapContext; personIdx: number; dateIdxs: number[]; baselineId: string }
  | { ok: false; message: string };

function resolveSwap(read: AssistantRosterRead, person: string, dates: readonly string[]): Resolved {
  if (read.status === "unavailable") return { ok: false, message: UNREADABLE };
  if (read.status === "none") return { ok: false, message: read.newerRunWaiting ? LOAD_FIRST : NO_ROSTER };
  if (read.newerRunWaiting) return { ok: false, message: LOAD_FIRST };
  const { document } = read;
  const model = deriveRuleModel(document.submission);
  if (model === null) {
    return {
      ok: false,
      message:
        "The rules this roster was made with cannot be read, so no swap can be checked. The user can " +
        "still change it by hand on the Roster screen.",
    };
  }
  const { context } = document;
  const personIdx = findPersonIdx(context, person);
  if (personIdx < 0) {
    const everyone = context.people.map((p) => String(p.id)).join(", ");
    return { ok: false, message: `No one called "${person}" is on this roster. People on it: ${everyone}.` };
  }
  const dateIdxs = [...new Set(dates.map((iso) => findDateIdx(context, iso)))].sort((a, b) => a - b);
  if (dateIdxs.some((d) => d < 0)) {
    const isos = context.calendar.map((day) => day.iso);
    return {
      ok: false,
      message: `Some of those dates are outside this roster, which runs from ${isos[0]} to ${isos[isos.length - 1]}.`,
    };
  }
  return {
    ok: true,
    ctx: { context, days: deriveCurrentDays(document.solvedDays, document.edits), model },
    personIdx,
    dateIdxs,
    baselineId: document.provenance.solvedBaselineId,
  };
}

export function useRosterTools(agentId: string, turnEpoch: number): void {
  useModelVisibleTool(
    {
      name: "get_roster",
      agentId,
      description:
        "Read the saved roster: who works which shift, day off or leave on each date, and any hard " +
        "rule it breaks now. Use it for any question about who works when, before suggesting a " +
        "swap, and after the user applies one. Never ask the user who works which shift.",
      parameters: rosterReadParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return late;
        if (read.status === "unavailable") return UNREADABLE;
        if (read.status === "none") return read.newerRunWaiting ? LOAD_FIRST : NO_ROSTER;
        const summary = summarizeRoster(read.document, args, read.newerRunWaiting);
        if (typeof summary === "string") return summary;
        const lastChange = describeRosterChangeOutcome(readRosterChangeOutcome());
        return lastChange === undefined ? summary : { ...summary, lastChange };
      },
    },
    [agentId, turnEpoch],
  );

  useModelVisibleTool(
    {
      name: "find_swap_partners",
      agentId,
      description:
        "Find who can take one person's shifts on some dates without breaking any hard rule the " +
        "roster was made with (staffing, skill mix, rest between shifts, requests, leave, shift " +
        "counts). Returns the best partners first and why others are ruled out. Changes nothing.",
      parameters: swapPartnerParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return late;
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return resolved.message;
        const { ctx, personIdx, dateIdxs } = resolved;
        const giving = givingProblem(ctx, personIdx, dateIdxs);
        if (giving !== null) return `${giving} Ask the user which dates they mean.`;
        const search = findSwapPartners(ctx, personIdx, dateIdxs);
        const iso = (d: number) => ctx.context.calendar[d].iso;
        return {
          person: personName(ctx.context, personIdx),
          giving: dateIdxs.map((d) => ({ date: iso(d), shift: dayCode(ctx.days[personIdx][d]) })),
          candidates: search.candidates.map((candidate) => ({
            partner: personName(ctx.context, candidate.partnerIdx),
            kind: candidate.plan.kind,
            partnerHasNow: dateIdxs.map((d) => ({ date: iso(d), shift: dayCode(ctx.days[candidate.partnerIdx][d]) })),
            worthKnowing: candidate.plan.soft.map((issue) => issue.message),
            notChecked: [...candidate.plan.unchecked],
          })),
          ruledOutCount: search.ruledOut.length,
          ruledOutExamples: search.ruledOut.slice(0, 5).map((entry) => ({
            partner: personName(ctx.context, entry.partnerIdx),
            reason: entry.reason,
          })),
          guidance:
            search.candidates.length > 0
              ? "If the user asked you to just do it, call prepare_roster_swap with the first " +
                "candidate. Otherwise offer at most three with offer_choices, best first. Say " +
                "'cover' when the partner is off, because the person then has those days off."
              : "No one can take these shifts without breaking a rule. Say so plainly with one or " +
                "two of the reasons, and suggest one date instead, or a new optimiser run.",
        };
      },
    },
    [agentId, turnEpoch],
  );

  useModelVisibleTool(
    {
      name: "prepare_roster_swap",
      agentId,
      description:
        "Prepare a shift swap between two people on the saved roster for the user to review. This " +
        "does NOT change the roster: the app checks every hard rule and shows a card with the exact " +
        "shifts and an Apply button only the user can press. Use a partner from find_swap_partners.",
      parameters: swapPrepareParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return late;
        if (token === null) return SUPERSEDED;
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return resolved.message;
        const { ctx, personIdx, dateIdxs, baselineId } = resolved;
        // (Task 8A replaces this handler with the ladder-aware one.)
        if (args.partner === undefined) return "Name who takes the shifts.";
        const partnerIdx = findPersonIdx(ctx.context, args.partner);
        if (partnerIdx < 0) {
          return `No one called "${args.partner}" is on this roster. Use a partner from find_swap_partners.`;
        }
        const plan = planSwap(ctx, personIdx, partnerIdx, dateIdxs);
        if (!plan.ok) {
          return (
            `That swap breaks a rule, so no card was shown: ${plan.reasons.join(" ")} ` +
            "Use find_swap_partners to see who can take these shifts, and explain this to the user in plain words."
          );
        }
        assistantActions.showRosterChange(
          {
            request: { solvedBaselineId: baselineId, cells: plan.cells },
            view: buildRosterChangeView(ctx.context, personIdx, partnerIdx, plan, args.summary),
          },
          token.turnEpoch,
        );
        return (
          "The user now sees a card with the exact swap and every rule it was checked against. " +
          "Nothing has changed yet; only the user can apply it, on the card. Do not say the roster " +
          "has changed. In one short sentence, say who swaps which shifts and that they can undo it " +
          "on the Roster screen. Then wait."
        );
      },
    },
    [agentId, turnEpoch],
  );
}
```

- [ ] **Step 4: Register.** In `web/components/ai/use-context-tools.ts`, add `import { useRosterTools } from "./use-roster-tools";`. After `useOptimizeTools(agentId, turnEpoch);`, add:

```ts
  // The roster family (plan 2026-09-24-roster-aware-assistant): read the saved roster,
  // find swap partners, and show a swap card. None writes; the user's Apply on the card
  // goes through the Roster screen's own edit session.
  useRosterTools(agentId, turnEpoch);
```

In `web/components/ai/model-visible-tools.ts`, add the import and three entries:

```ts
import { rosterReadParameters, swapPartnerParameters, swapPrepareParameters } from "./use-roster-tools";
// …inside MODEL_VISIBLE_TOOL_SCHEMAS, after offer_choices:
  // CHANGED DELIBERATELY (2026-09-24, bead 73z): the roster family. Two reads and a
  // card; the roster changes only on the user's Apply, through the Roster screen.
  get_roster: rosterReadParameters,
  find_swap_partners: swapPartnerParameters,
  prepare_roster_swap: swapPrepareParameters,
```

- [ ] **Step 5: Update the locked lists.** In `web/lib/ai/phase-2-absence.test.ts`:
  - Append to `MODEL_VISIBLE_TOOLS`:

```ts
  // WIDENED DELIBERATELY (2026-09-24, plan roster-aware-assistant, bead 73z): roster edits
  // are the next lifted family. get_roster and find_swap_partners only read.
  // prepare_roster_swap only shows a host card. The roster changes on the user's Apply
  // click, through the Roster screen's own edit session (lib/roster/change-request.ts),
  // so no assistant transaction touches a roster table (asserted below, unchanged).
  "get_roster",
  "find_swap_partners",
  "prepare_roster_swap",
```

  - Replace `PHASE_2_VERBS` and its comment:

```ts
/**
 * Vocabulary that would only appear in a name if minimal-change REPAIR had started.
 * `set_roster_range` is deliberately NOT caught: it sets the scenario's period.
 *
 * NARROWED DELIBERATELY (2026-09-24, plan roster-aware-assistant): `swap` left this list
 * when user-applied roster swaps became a lifted family. A tool that re-optimises,
 * repairs or reassigns on its own is still caught.
 */
const PHASE_2_VERBS = /repair|reassign|minimal[_-]?change|disrupt|shortage|re[_-]?optimi/i;
```

  In `web/lib/capability/tools.test.ts`, add to `NOT_REGISTRY_GOVERNED`:

```ts
  get_roster: "Roster read: reads the saved roster the Roster screen shows",
  find_swap_partners: "Roster read: host-checked swap suggestions, writes nothing",
  prepare_roster_swap: "Roster swap: shows a host card; the USER applies it on the Roster screen",
```

  In `web/lib/ai/runtime/model-visible-tools.test.ts`, inside `describe("the command arms the provider is actually shown", …)`, add:

```ts
  it("puts the roster tools on the wire with plain string fields", () => {
    const partners = child(child(wire.get("find_swap_partners"), "parameters"), "properties");
    expect(child(partners, "person").type).toBe("string");
    expect(child(child(partners, "dates"), "items").type).toBe("string");
    const prepare = child(child(wire.get("prepare_roster_swap"), "parameters"), "properties");
    expect(Object.keys(prepare).sort()).toEqual(["dates", "laterDates", "partner", "person", "reason", "summary"]);
    expect(child(partners, "reason").enum).toEqual(["swap", "sick_or_emergency"]);
    const borrow = child(child(wire.get("prepare_borrowed_cover"), "parameters"), "properties");
    expect(Object.keys(borrow).sort()).toEqual(["dates", "groups", "name", "person", "reason", "summary"]);
    const read = child(child(wire.get("get_roster"), "parameters"), "properties");
    expect(child(child(read, "people"), "items").type).toBe("string");
  });
```

  (`child` and `wire` are the helpers that file already uses for `get_schedule_section`. Match their exact names there.)

- [ ] **Step 6: Run the tests.** Run: `cd web && pnpm vitest run components/ai/use-roster-tools.test.tsx lib/ai/phase-2-absence.test.ts lib/capability/tools.test.ts lib/ai/runtime/model-visible-tools.test.ts components/ai/session-real-core.test.tsx`. Expected: PASS. `session-real-core` enumerates the mounted registry against the same constants, so it picks up the three tools.

---

### Task 8A (amendment): The ladder, trades, sick leave and borrowing in the tools

**Files:**
- Modify: `web/components/ai/use-roster-tools.ts`, `web/components/ai/model-visible-tools.ts`
- Modify (locked): `web/lib/ai/phase-2-absence.test.ts`, `web/lib/capability/tools.test.ts`
- Test: `web/components/ai/use-roster-tools.test.tsx`

**Interfaces:**
- Consumes: Task 5A `findCoverLadder`, `planSickCover`, `borrowNeeds`; Task 5B `planTrade`; Task 6 Step 5 views; Task 7 `linked`.
- Produces: `borrowParameters` (zod), the fourth tool `prepare_borrowed_cover`, and ladder-aware `find_swap_partners` / `prepare_roster_swap` handlers.

- [ ] **Step 1: Write the failing tests.** In `use-roster-tools.test.tsx`:
  - Extend the `@/lib/store` mock with `pickScenario: () => fixture.scenario` and `assistantProposalCommands: { ...actual.assistantProposalCommands, prepare: fixture.prepare }`. Add `scenario: null as unknown, prepare: vi.fn()` to `fixture`. In `beforeEach`: `fixture.scenario = { rangeStart: "2026-10-07", rangeEnd: "2026-10-14" }` and `fixture.prepare.mockReset().mockResolvedValue({ ok: true, proposal: { proposalId: "p-1", assumptions: [{ assumptionId: "a-1", type: "leave_moved", question: "Has SN-Asha agreed to move their leave?" }] } })`.
  - Change "registers exactly the three tools" to four names, adding `"prepare_borrowed_cover"`.
  - Add:

```tsx
import { generateDateItems } from "@/lib/dates/date-id";
import { ashaRosterDocument, borrowRosterDocument } from "@/lib/roster-viewer/swap-fixtures";

const useAsha = () => {
  fixture.working = { document: ashaRosterDocument(), revision: 1, candidateSource: { jobId: "job-1", candidateVersion: 1 } };
};
const useBorrow = () => {
  fixture.working = { document: borrowRosterDocument(), revision: 1, candidateSource: { jobId: "job-1", candidateVersion: 1 } };
  fixture.scenario = { rangeStart: "2026-10-07", rangeEnd: "2026-10-09" };
};
const idFor = (iso: string) =>
  generateDateItems({ start: "2026-10-07", end: "2026-10-14" }).find((item) => item.iso === iso)?.id;

describe("the escalation ladder in the tools", () => {
  it("says step 1 when a swap or cover exists", async () => {
    const answer = (await tool("find_swap_partners").handler(PRIYA_NIGHTS, {})) as { step: number; stepLabel: string };
    expect(answer.step).toBe(1);
    expect(answer.stepLabel).toBe("Step 1 · Swap or cover within the ward");
  });

  it("offers step 2 trades with concrete later dates only when step 1 is empty", async () => {
    useAsha();
    const answer = (await tool("find_swap_partners").handler(PRIYA_NIGHTS, {})) as {
      step: number;
      candidates: unknown[];
      trades: { partner: string; laterDates: string[]; movesLeave: boolean; agreement: string }[];
    };
    expect(answer.step).toBe(2);
    expect(answer.candidates).toEqual([]);
    expect(answer.trades.map((t) => [t.partner, t.laterDates, t.movesLeave])).toEqual([
      ["SN-Cy", ["2026-10-10", "2026-10-11"], false],
      ["SN-Asha", ["2026-10-11", "2026-10-12"], true],
    ]);
  });

  it("prepares the Asha trade as roster cells plus a linked leave move", async () => {
    useAsha();
    const answer = await tool("prepare_roster_swap").handler(
      { ...PRIYA_NIGHTS, partner: "SN-Asha", laterDates: ["2026-10-11", "2026-10-12"], summary: "Priya needs those nights off." },
      {},
    );
    expect(answer).toMatch(/Nothing has changed/);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.prepare.mock.calls[0][0].commands).toEqual([
      { type: "move_leave", personId: "SN-Asha", fromDate: idFor("2026-10-08"), toDate: idFor("2026-10-11") },
      { type: "move_leave", personId: "SN-Asha", fromDate: idFor("2026-10-09"), toDate: idFor("2026-10-12") },
    ]);
    const card = useAssistantStore.getState().activeRosterChange;
    expect(card?.linked).toEqual({ proposalId: "p-1", assumptionIds: ["a-1"] });
    expect(card?.view.agreement).toMatch(/^SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead/);
    expect(useAssistantStore.getState().activeProposal).toBeNull();
  });

  it("records sick leave in the roster and the leave record together", async () => {
    const answer = await tool("prepare_roster_swap").handler(
      { person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency", partner: "SN-Cara", summary: "Priya is on MC." },
      {},
    );
    expect(answer).toMatch(/Nothing has changed/);
    expect(fixture.prepare.mock.calls[0][0].commands).toEqual([
      { type: "add_leave", personId: "SN-Priya", startDate: "2026-10-08", endDate: "2026-10-08" },
    ]);
    expect(useAssistantStore.getState().activeRosterChange?.request?.cells[0].after).toEqual({ kind: "leave" });
  });

  it("refuses to borrow while a lower step has options", async () => {
    const answer = await tool("prepare_borrowed_cover").handler(
      { person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency", name: "Mei", source: "relief_pool", groups: [], summary: "Borrow." },
      {},
    );
    expect(answer).toMatch(/Step 1 still has options/);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("prepares step 3 with shipped ops and the skill group the night needs", async () => {
    useBorrow();
    const found = (await tool("find_swap_partners").handler(
      { person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency" },
      {},
    )) as { step: number; temporary: { needs: unknown[]; skillGroups: string[] } };
    expect(found.step).toBe(3);
    expect(found.temporary.skillGroups).toEqual(["Nights"]);
    fixture.prepare.mockResolvedValueOnce({
      ok: true,
      proposal: { proposalId: "p-2", assumptions: [{ assumptionId: "b-1", type: "borrowed_staff_arranged", question: "Has the lending ward or agency confirmed Mei for 8 Oct, qualified as Nights?" }] },
    });
    await tool("prepare_borrowed_cover").handler(
      { person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency", name: "Mei", source: "relief_pool", groups: [], summary: "Borrow from Ward 6." },
      {},
    );
    expect(fixture.prepare.mock.calls[0][0].commands).toEqual([
      { type: "add_person", name: "Mei", groups: ["Nights"], temporary: true },
      { type: "set_off_request", personId: "Mei", startDate: "2026-10-07", endDate: "2026-10-07", weight: "must" },
      { type: "set_off_request", personId: "Mei", startDate: "2026-10-09", endDate: "2026-10-09", weight: "must" },
      { type: "set_shift_request", personId: "Mei", shiftType: "N", startDate: "2026-10-08", endDate: "2026-10-08", weight: "must" },
      { type: "add_leave", personId: "SN-Priya", startDate: "2026-10-08", endDate: "2026-10-08" },
    ]);
    const card = useAssistantStore.getState().activeRosterChange;
    expect(card?.view.agreement).toBe("Has the lending ward or agency confirmed Mei for 8 Oct, qualified as Nights?");
    expect(card?.request?.cells).toEqual([
      { personIdx: 0, dateIdx: 1, before: { kind: "shift", shiftId: "N" }, after: { kind: "leave" } },
    ]);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `cd web && pnpm vitest run components/ai/use-roster-tools.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `use-roster-tools.ts`, add these imports: `findCoverLadder`, `planSickCover`, `planTrade`, `type CoverReason`; `buildTradeView`, `buildSickView`, `buildBorrowView`, `STEP_LABEL`; `assistantProposalCommands`, `pickScenario`, `useScenarioStore` from `@/lib/store`; `useAssistantStore`; `capabilityRegistryStamp` from `@/lib/capability/registry`; `generateDateItems` from `@/lib/dates/date-id`; `type AssistantCommandV1` from `@/lib/proposal`. Then add:

```ts
export const borrowParameters = z.object({
  person: z.string().min(1).describe("Whose shifts are uncovered, as the roster names them."),
  dates: z.array(z.string()).min(1).max(7).describe(`The uncovered dates. ${DATE_HELP}`),
  reason: REASON,
  name: z.string().min(1).describe("The borrowed nurse's name, exactly as the user gave it. Never invent one."),
  groups: z.array(z.string()).max(5).describe("Staff groups she belongs to. The app adds the skill group the shift needs."),
  summary: z.string().min(1).describe("Why, in one plain sentence. Shown as your reasoning."),
});

type Linked = { proposalId: string; assumptionIds: string[]; questions: string[] };

/**
 * Prepare the schedule half of a roster change as a LINKED proposal: validated by the
 * same host transforms as any Preview, but shown on the roster card instead of as a
 * separate Preview, and applied with the roster cells or not at all (Task 9A).
 */
async function prepareLinked(
  commands: AssistantCommandV1[],
  summary: string,
): Promise<{ ok: true; linked: Linked } | { ok: false; message: string }> {
  const outcome = await assistantProposalCommands.prepare({
    proposalId: crypto.randomUUID(),
    threadId: null,
    turnId: useAssistantStore.getState().activeTurnId,
    registryStamp: capabilityRegistryStamp(),
    commands,
    rationale: summary,
    evidence: [{ kind: "user_statement", label: "Asked to cover a shift", reference: null }],
    outcome: "untested",
  });
  if (outcome.ok) {
    return {
      ok: true,
      linked: {
        proposalId: outcome.proposal.proposalId,
        assumptionIds: outcome.proposal.assumptions.map((a) => a.assumptionId),
        questions: outcome.proposal.assumptions.map((a) => a.question),
      },
    };
  }
  if (outcome.reason === "rejected") {
    return { ok: false, message: `The schedule could not take that change, so no card was shown: ${outcome.rejection.message}` };
  }
  if (outcome.reason === "not-owner") {
    return { ok: false, message: "This schedule is being edited in another tab, so nothing was prepared. Tell the user they can take over editing in this tab." };
  }
  return { ok: false, message: "The app could not prepare that change right now, and nothing was altered." };
}

/** `move_leave` takes the LIVE schedule's span-formatted date id, not an ISO date. */
function liveDateId(iso: string): string | null {
  const scenario = pickScenario(useScenarioStore.getState());
  return generateDateItems({ start: scenario.rangeStart, end: scenario.rangeEnd }).find((item) => item.iso === iso)?.id ?? null;
}

/** One `add_leave` per date: the MC goes into the leave record so a new run knows. */
const addLeave = (personId: PersonRef, isos: readonly string[]): AssistantCommandV1[] =>
  isos.map((iso): AssistantCommandV1 => ({ type: "add_leave", personId, startDate: iso, endDate: iso }));

const CARD_SHOWN =
  "The user now sees a card with the exact change and every rule it was checked against. " +
  "Nothing has changed yet; only the user can apply it, on the card. Do not say the roster " +
  "has changed. In one short sentence, say which step this is and who does what. Then wait.";
```

(Import `type PersonRef` from `@/lib/scenario`.)

Replace the `find_swap_partners` handler body after `givingProblem`:

```ts
        const ladder = findCoverLadder(ctx, personIdx, dateIdxs, args.reason);
        const iso = (d: number) => ctx.context.calendar[d].iso;
        const common = {
          step: ladder.step,
          stepLabel: STEP_LABEL[ladder.step],
          person: personName(ctx.context, personIdx),
          giving: dateIdxs.map((d) => ({ date: iso(d), shift: dayCode(ctx.days[personIdx][d]) })),
          ruledOutCount: ladder.ruledOut.length,
          ruledOutExamples: ladder.ruledOut.slice(0, 5).map((e) => ({ partner: personName(ctx.context, e.partnerIdx), reason: e.reason })),
        };
        if (ladder.step === 1) {
          return {
            ...common,
            candidates: ladder.candidates.map((c) => ({
              partner: personName(ctx.context, c.partnerIdx),
              kind: c.plan.kind,
              partnerHasNow: dateIdxs.map((d) => ({ date: iso(d), shift: dayCode(ctx.days[c.partnerIdx][d]) })),
              worthKnowing: c.plan.soft.map((i) => i.message),
              notChecked: [...c.plan.unchecked],
            })),
            trades: [],
            guidance:
              "Step 1. If the user asked you to just do it, call prepare_roster_swap with the first " +
              "candidate. Otherwise offer at most three with offer_choices, best first.",
          };
        }
        if (ladder.step === 2) {
          return {
            ...common,
            candidates: [],
            trades: ladder.trades.map((t) => ({
              partner: personName(ctx.context, t.partnerIdx),
              kind: "trade",
              variant: t.plan.variant,
              laterDates: t.plan.laterDateIdxs.map(iso),
              movesLeave: t.plan.leaveMoves.length > 0,
              later: t.plan.laterDateIdxs.map((d) => ({
                date: iso(d),
                partnerHasNow: dayCode(ctx.days[t.partnerIdx][d]),
                personGets: t.plan.variant === "person-covers" ? dayCode(ctx.days[t.partnerIdx][d]) : "nothing",
              })),
              agreement: tradeAgreement(ctx.context, personIdx, t.partnerIdx, t.plan),
              worthKnowing: t.plan.soft.map((i) => i.message),
              notChecked: [...t.plan.unchecked],
            })),
            guidance:
              "Step 2: nobody can swap or cover. Tell the user this is step 2: ask someone who is " +
              "off or on leave. Offer at most two trades with offer_choices, in plain words (\"Ask " +
              "Asha to work 8-9 Oct and take her leave on 11-12 Oct instead\"). Say it needs her " +
              "agreement. When the user picks one, call prepare_roster_swap with its laterDates.",
          };
        }
        const needs = ladder.borrow.map((n) => ({ date: iso(n.dateIdx), shift: n.shift }));
        const skillGroups = [...new Set(ladder.borrow.flatMap((n) => (n.skillGroup ? [n.skillGroup] : [])))];
        return {
          ...common,
          candidates: [],
          trades: [],
          temporary: { needs, skillGroups, sources: ["relief_pool", "other_ward", "agency"] },
          guidance:
            "Step 3: nobody on the ward can take this. Tell the user this is step 3: ask another " +
            "ward for a nurse. Ask for her name (and grade if it matters), then call " +
            "prepare_borrowed_cover. Never make up a name." +
            (args.reason === "sick_or_emergency"
              ? " If they only want the absence recorded, call prepare_roster_swap without a partner."
              : ""),
        };
```

Replace the `prepare_roster_swap` handler body after `resolveSwap` succeeds:

```ts
        const { ctx, personIdx, dateIdxs, baselineId } = resolved;
        const personId = ctx.context.people[personIdx].id;
        const isos = dateIdxs.map((d) => ctx.context.calendar[d].iso);
        const partnerIdx = args.partner === undefined ? null : findPersonIdx(ctx.context, args.partner);
        if (partnerIdx === -1) return `No one called "${args.partner}" is on this roster. Use a partner from find_swap_partners.`;
        if (partnerIdx === null && args.reason !== "sick_or_emergency") return "Name who takes the shifts.";

        const show = async (cells: RosterCellChange[], view: RosterChangeView, commands: AssistantCommandV1[]) => {
          let linked: Linked | null = null;
          if (commands.length > 0) {
            const prepared = await prepareLinked(commands, args.summary);
            const late = assertTurnAuthority(token, signal);
            if (late) return late;
            if (!prepared.ok) return prepared.message;
            linked = prepared.linked;
          }
          assistantActions.showRosterChange(
            {
              request: { solvedBaselineId: baselineId, cells },
              view,
              linked: linked && { proposalId: linked.proposalId, assumptionIds: linked.assumptionIds },
            },
            token.turnEpoch,
          );
          return CARD_SHOWN;
        };
        const sickLeave = args.reason === "sick_or_emergency" ? addLeave(personId, isos) : [];

        // Step 2: a trade with later dates.
        if (args.laterDates && args.laterDates.length > 0 && partnerIdx !== null) {
          const later = args.laterDates.map((iso) => findDateIdx(ctx.context, iso));
          if (later.some((d) => d < 0)) return "Some of those later dates are outside this roster.";
          const variants: TradeVariant[] = args.reason === "swap" ? ["person-covers", "partner-off"] : ["partner-off"];
          let plan: ReturnType<typeof planTrade> = { ok: false, reasons: ["No trade fits those dates."] };
          for (const variant of variants) {
            plan = planTrade(ctx, personIdx, partnerIdx, dateIdxs, later, variant, args.reason);
            if (plan.ok) break;
          }
          if (!plan.ok) return `That trade breaks a rule, so no card was shown: ${plan.reasons.join(" ")}`;
          const moves: AssistantCommandV1[] = [];
          for (const move of plan.leaveMoves) {
            const fromDate = liveDateId(ctx.context.calendar[move.from].iso);
            const toDate = liveDateId(ctx.context.calendar[move.to].iso);
            if (fromDate === null || toDate === null) {
              return "Those dates are outside the schedule's period, so the leave cannot be moved. No card was shown.";
            }
            moves.push({ type: "move_leave", personId: ctx.context.people[move.personIdx].id, fromDate, toDate });
          }
          return show([...plan.cells], buildTradeView(ctx.context, personIdx, partnerIdx, plan, args.summary), [...moves, ...sickLeave]);
        }

        // Step 1 with sick leave, or the MC recorded alone.
        if (args.reason === "sick_or_emergency") {
          const plan = planSickCover(ctx, personIdx, partnerIdx, dateIdxs);
          if (!plan.ok) return `That cover breaks a rule, so no card was shown: ${plan.reasons.join(" ")}`;
          return show([...plan.cells], buildSickView(ctx.context, personIdx, partnerIdx, plan, args.summary), sickLeave);
        }

        // Step 1 swap: unchanged from Task 8 (planSwap, buildRosterChangeView, no linked proposal).
        const plan = planSwap(ctx, personIdx, partnerIdx as number, dateIdxs);
        if (!plan.ok) {
          return `That swap breaks a rule, so no card was shown: ${plan.reasons.join(" ")} Use find_swap_partners to see who can take these shifts.`;
        }
        return show([...plan.cells], buildRosterChangeView(ctx.context, personIdx, partnerIdx as number, plan, args.summary), []);
```

(Type `show`'s return as `Promise<string>`, and keep the `token === null` guard before it. Import `type RosterCellChange` from `@/lib/roster/change-request`, `type RosterChangeView` and `tradeAgreement` from roster-context, and `type TradeVariant`.)

Add the fourth tool, registered after `prepare_roster_swap`:

```ts
  useModelVisibleTool(
    {
      name: "prepare_borrowed_cover",
      agentId,
      description:
        "Step 3 only, when find_swap_partners says step 3: prepare adding a temporary nurse " +
        "borrowed from another ward to cover the uncovered shifts. Use the name the user gave. " +
        "This does NOT change anything: the user sees a card with the lending-ward question and " +
        "an Apply button only they can press.",
      parameters: borrowParameters,
      handler: async (args, { token, signal }) => {
        const read = await readRosterForAssistant();
        const late = assertTurnAuthority(token, signal);
        if (late) return late;
        if (token === null) return SUPERSEDED;
        const resolved = resolveSwap(read, args.person, args.dates);
        if (!resolved.ok) return resolved.message;
        const { ctx, personIdx, dateIdxs, baselineId } = resolved;
        const giving = givingProblem(ctx, personIdx, dateIdxs);
        if (giving !== null) return giving;
        const ladder = findCoverLadder(ctx, personIdx, dateIdxs, args.reason);
        if (ladder.step !== 3) {
          return `Step ${ladder.step} still has options, so no nurse should be borrowed yet. Call find_swap_partners and offer those first.`;
        }
        const name = args.name.trim();
        const skill = ladder.borrow.flatMap((n) => (n.skillGroup ? [n.skillGroup] : []));
        const groups = [...new Set([...args.groups, ...skill])];
        const needDates = new Set(ladder.borrow.map((n) => ctx.context.calendar[n.dateIdx].iso));
        const isos = ctx.context.calendar.map((day) => day.iso);
        const commands: AssistantCommandV1[] = [
          { type: "add_person", name, groups, temporary: true },
          // ponytail: one "must be off" per other date; merge into runs if proposals get long.
          ...isos
            .filter((iso) => !needDates.has(iso))
            .map((iso) => ({ type: "set_off_request", personId: name, startDate: iso, endDate: iso, weight: "must" }) as AssistantCommandV1),
          ...ladder.borrow.map(
            (n) =>
              ({
                type: "set_shift_request",
                personId: name,
                shiftType: n.shift,
                startDate: ctx.context.calendar[n.dateIdx].iso,
                endDate: ctx.context.calendar[n.dateIdx].iso,
                weight: "must",
              }) as AssistantCommandV1,
          ),
          ...(args.reason === "sick_or_emergency"
            ? addLeave(ctx.context.people[personIdx].id, dateIdxs.map((d) => isos[d]))
            : []),
        ];
        const prepared = await prepareLinked(commands, args.summary);
        const lateAgain = assertTurnAuthority(token, signal);
        if (lateAgain) return lateAgain;
        if (!prepared.ok) return prepared.message;
        // C1: the roster only records the absence (sick reason). Her row needs roster-file/2 (Task 12).
        const cells =
          args.reason === "sick_or_emergency"
            ? dateIdxs.map((d) => ({ personIdx, dateIdx: d, before: ctx.days[personIdx][d], after: { kind: "leave" } as const }))
            : [];
        const needs = ladder.borrow.map((n) => ({ date: plainDate(ctx.context.calendar[n.dateIdx].iso), shift: n.shift }));
        assistantActions.showRosterChange(
          {
            request: cells.length > 0 ? { solvedBaselineId: baselineId, cells } : null,
            view: buildBorrowView(name, args.source, groups, needs, prepared.linked.questions[0] ?? null, args.summary),
            linked: { proposalId: prepared.linked.proposalId, assumptionIds: prepared.linked.assumptionIds },
          },
          token.turnEpoch,
        );
        return (
          `${CARD_SHOWN} Tell the user ${name}'s roster row appears after the next optimiser run; ` +
          "offer request_optimize_run once they have applied it."
        );
      },
    },
    [agentId, turnEpoch],
  );
```

(Import `plainDate` from rule-check.)

- [ ] **Step 4: Register and lock.** Add `prepare_borrowed_cover: borrowParameters` to `MODEL_VISIBLE_TOOL_SCHEMAS`. Add `"prepare_borrowed_cover"` to `MODEL_VISIBLE_TOOLS` in `phase-2-absence.test.ts`, under the same WIDENED comment, with the extra line: "prepare_borrowed_cover shows a card; the borrowed person is added by the shipped add_person arm on the user's Apply." Add `prepare_borrowed_cover: "Borrowed cover: shows a host card; the USER applies the staff change"` to `NOT_REGISTRY_GOVERNED` in `tools.test.ts`. `PROPOSAL_OPERATIONS` does not change.

- [ ] **Step 4b (amendment 2): the four-step ladder in the tools.** This follows Task 5C.
  - Schemas: add `noTemporaryNurse: z.boolean().optional().describe("true ONLY after the user says the relief pool, other wards and agencies have nobody.")` to `swapPartnerParameters` (so `swapPrepareParameters` inherits it). Add `source: z.enum(["relief_pool", "other_ward", "agency"]).describe("Where the temporary nurse comes from. Ask the nursing supervisor for the relief pool first.")` to `borrowParameters`. The model-visible test's key lists gain `noTemporaryNurse` (both swap tools) and `source` (borrow).
  - `find_swap_partners`: call `findCoverLadder(ctx, personIdx, dateIdxs, args.reason, { noTemporaryNurse: args.noTemporaryNurse })`.
    - Step 2 returns `overtime` next to `trades`, each entry `{ partner, kind: "overtime", payBack: "overtime", agreement: `${partner} agreed to come in on ${dates} for overtime pay.`, worthKnowing, notChecked }`. Each trade gains `payBack: "off-in-lieu"`. The guidance becomes: "Step 2: nobody can swap or cover without extra hours. Ask as a REQUEST, never an order, and name the pay-back: overtime pay, or off-in-lieu (her off or leave moves to the later dates). Offer overtime and off-day trades before leave trades, at most three with offer_choices. Never blame the nurse who is on MC."
    - Step 3 returns `temporary: { needs, skillGroups, sources: ["relief_pool", "other_ward", "agency"] }` (renamed from `borrow`). The guidance says: "Step 3: ask the nursing supervisor for a nurse from the relief pool first; if none, another ward or an agency. Tell the user to let their nurse manager know. Ask for the nurse's name and where she comes from, then call prepare_borrowed_cover. If they have nobody, call find_swap_partners again with noTemporaryNurse true."
    - Step 4 returns `short: plan.ok ? { allowed: true, shifts: plan.shortfalls.map((s) => ({ date, shift: s.label, from: s.from, to: s.to })) } : { allowed: false, refusal: plan.reasons[0] }`. The guidance says: "Step 4, last resort: only with the nurse manager's sign-off. If allowed, offer to run it one short with prepare_roster_swap (no partner, noTemporaryNurse true). If refused, say so plainly and suggest talking to the nurse manager or the nursing supervisor. Never suggest this before steps 1-3."
  - `prepare_roster_swap`:
    - With a partner and a step-1 plan whose `kind === "cover"` and `!countHeadroom(ctx.model, ctx.days, partnerIdx)`: build `buildOvertimeView` (step 2, agreement tick). Otherwise use the Task 8A views.
    - Without a partner: compute `ladder = findCoverLadder(..., { noTemporaryNurse: args.noTemporaryNurse })`. When `ladder.step === 4 && ladder.short?.ok`: build `buildShortView` (sign-off tick). The cells are `ladder.short.cells`, with the `add_leave` linked commands for the sick reason. Otherwise, for the sick reason, keep the "record the MC" path (`buildSickView`, gap stated, plus "Keep looking for cover." in its notes). For the swap reason, refuse: `Step ${ladder.step} still has options. Leaving the shift short is only for when steps 1-3 find nobody, and needs the nurse manager's sign-off.`
  - `prepare_borrowed_cover`: require `ladder.step === 3` (it already refuses below). Pass `args.source` into `buildBorrowView`. Put the source in the linked proposal's rationale: `${args.summary} (${from})`.
  - Tests to add in `use-roster-tools.test.tsx` (the fixtures come from Task 5C):

```tsx
it("asks an off nurse with no spare capacity to come in for overtime (step 2)", async () => {
  fixture.working = { document: { ...borrowRosterDocument(), submission: fixtureSubmission(overtimeDocument(), []), context: overtimeContext(), solvedDays: overtimeGrid() }, revision: 1, candidateSource: { jobId: "job-1", candidateVersion: 1 } };
  fixture.scenario = { rangeStart: "2026-10-07", rangeEnd: "2026-10-09" };
  const found = (await tool("find_swap_partners").handler({ person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency" }, {})) as {
    step: number;
    overtime: { partner: string; payBack: string }[];
  };
  expect(found.step).toBe(2);
  expect(found.overtime).toEqual([expect.objectContaining({ partner: "SN-Kai", payBack: "overtime" })]);
  await tool("prepare_roster_swap").handler({ person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency", partner: "SN-Kai", summary: "Priya is on MC." }, {});
  expect(useAssistantStore.getState().activeRosterChange?.view.agreement).toBe("SN-Kai agreed to come in on 8 Oct for overtime pay.");
});

it("offers run one short only at step 4, with the nurse manager's sign-off", async () => {
  fixture.working = { document: shortRosterDocument(), revision: 1, candidateSource: { jobId: "job-1", candidateVersion: 1 } };
  const early = await tool("prepare_roster_swap").handler({ person: "SN-Priya", dates: ["2026-10-08"], reason: "swap", summary: "Short." }, {});
  expect(early).toMatch(/Step 3 still has options/);
  await tool("prepare_roster_swap").handler(
    { person: "SN-Priya", dates: ["2026-10-08"], reason: "swap", noTemporaryNurse: true, summary: "Nobody is available." },
    {},
  );
  const card = useAssistantStore.getState().activeRosterChange;
  expect(card?.view.stepLabel).toBe("Step 4 · Last resort: run one short");
  expect(card?.view.agreement).toMatch(/^My nurse manager has agreed it is safe/);
});

it("refuses to run short when it drops the senior who can be in charge", async () => {
  fixture.working = { document: shortRosterDocument(), revision: 1, candidateSource: { jobId: "job-1", candidateVersion: 1 } };
  const found = (await tool("find_swap_partners").handler(
    { person: "SSN-Lee", dates: ["2026-10-08"], reason: "sick_or_emergency", noTemporaryNurse: true },
    {},
  )) as { step: number; short: { allowed: boolean; refusal?: string } };
  expect(found.step).toBe(4);
  expect(found.short.allowed).toBe(false);
  expect(found.short.refusal).toMatch(/nurse who can be in charge must stay/);
});
```

- [ ] **Step 5: Run the tests.** Run Task 8 Step 6's command, plus `components/ai/use-roster-tools.test.tsx`. Expected: PASS.

---

### Task 9: The swap card and activity labels

**Files:**
- Create: `web/components/ai/roster-change-card.tsx`
- Modify: `web/components/ai/assistant-conversation.tsx`
- Test: `web/components/ai/roster-change-card.test.tsx`, `web/components/ai/assistant-activity.test.tsx`

- [ ] **Step 1: Write the failing test.** Create `web/components/ai/roster-change-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useRosterChangeStore } from "@/lib/roster/change-request";
import { RosterChangeCard } from "./roster-change-card";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("./use-capability-navigation", () => ({ useCapabilityNavigation: () => navigate }));

const TURN = 4;
const CHANGE = {
  request: {
    solvedBaselineId: "a".repeat(64),
    cells: [{ personIdx: 0, dateIdx: 1, before: { kind: "shift", shiftId: "N" } as const, after: { kind: "off" } as const }],
  },
  view: {
    heading: "Swap shifts?",
    stepLabel: "Step 1 · Swap or cover within the ward",
    leaveRows: [],
    notes: [],
    agreement: null,
    title: "SN-Priya and SN-Cara, 8 Oct",
    summary: "Priya needs that night off.",
    rows: [
      { person: "SN-Priya", date: "8 Oct", now: "N", after: "OFF" },
      { person: "SN-Cara", date: "8 Oct", now: "OFF", after: "N" },
    ],
    worthKnowing: ["SN-Cara asked not to have N on 8 Oct."],
    notChecked: [],
  },
};

beforeEach(() => {
  navigate.mockReset();
  navigate.mockResolvedValue({ status: "focused" });
  useAssistantStore.setState({ turnEpoch: TURN });
  useRosterChangeStore.setState({ pending: null, last: null });
});
afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
});

describe("RosterChangeCard", () => {
  it("renders nothing when no swap was prepared", () => {
    const { container } = render(<RosterChangeCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows every changed cell and the soft notes", () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    render(<RosterChangeCard />);
    expect(screen.getByText("SN-Priya and SN-Cara, 8 Oct")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + two cells
    expect(screen.getByText("SN-Cara asked not to have N on 8 Oct.")).toBeInTheDocument();
  });

  it("opens the Roster screen, hands it the request, and goes away on Apply", async () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    render(<RosterChangeCard />);
    await userEvent.click(screen.getByTestId("roster-change-apply"));
    await waitFor(() => expect(useRosterChangeStore.getState().pending).not.toBeNull());
    expect(navigate).toHaveBeenCalledWith("roster-viewer");
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
  });

  it("shows a stopped card with no Apply control", () => {
    assistantActions.showRosterChange(CHANGE, TURN - 1);
    render(<RosterChangeCard />);
    expect(screen.queryByTestId("roster-change-apply")).toBeNull();
    expect(screen.getByText(/This offer has ended/)).toBeInTheDocument();
  });
});
```

In `web/components/ai/assistant-activity.test.tsx`, copy its existing `get_optimize_result` case and add one for `find_swap_partners`. It expects the text `Looking for who can swap…`.

- [ ] **Step 2: Run them and see them fail.** Run: `cd web && pnpm vitest run components/ai/roster-change-card.test.tsx components/ai/assistant-activity.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement the card.** Create `web/components/ai/roster-change-card.tsx`:

```tsx
"use client";

// The host card behind `prepare_roster_swap` (bead nursing-sheduler-73z).
//
// A SIBLING OF THE TRANSCRIPT, like the Run card: Apply is host state and the model
// cannot press it. Apply opens the Roster screen, then hands the exact cells to it
// (`lib/roster/change-request.ts`). That screen re-checks every cell and applies them
// as one hand edit. A card from a stopped turn renders as stopped, with no Apply.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import { requestRosterChange } from "@/lib/roster/change-request";
import { useCapabilityNavigation } from "./use-capability-navigation";

export function RosterChangeCard() {
  const active = useAssistantStore((state) => state.activeRosterChange);
  const liveEpoch = useAssistantStore((state) => state.turnEpoch);
  const navigate = useCapabilityNavigation();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);

  if (active === null) return null;
  const stopped = active.turnEpoch !== liveEpoch;
  const { view } = active;

  const onApply = async () => {
    setOpening(true);
    setFailed(false);
    try {
      // The user's click is its own authority. An unsaved draft still gets the usual confirm.
      const outcome = await navigate("roster-viewer");
      if (outcome.status === CAPABILITY_UNAVAILABLE) {
        if (outcome.reason !== "navigation_cancelled") setFailed(true);
        return;
      }
      requestRosterChange(active.request);
      assistantActions.clearRosterChange();
    } finally {
      setOpening(false);
    }
  };

  return (
    <Surface
      level="surface"
      geometry="card"
      className="m-3 flex shrink-0 flex-col gap-3 p-4"
      data-testid="assistant-roster-change"
      data-status={stopped ? "stopped" : "live"}
      aria-label="Swap shifts"
    >
      <header className="flex flex-col gap-1">
        <h3 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">Swap shifts?</h3>
        <p className="text-meta text-ink2">{view.title}</p>
      </header>
      {stopped ? (
        <p className="text-meta text-ink2">This offer has ended. Ask again if you still want the swap.</p>
      ) : (
        <>
          <table className="w-full text-meta">
            <thead>
              <tr className="text-left text-ink2">
                <th className="font-medium">Nurse</th>
                <th className="font-medium">Date</th>
                <th className="font-medium">Now</th>
                <th className="font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={`${row.person}-${row.date}`}>
                  <td>{row.person}</td>
                  <td>{row.date}</td>
                  <td>{row.now}</td>
                  <td className="font-semibold">{row.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-meta text-ink2">
            Checked against the rules this roster was made with: staffing, rest between shifts,
            requests and shift counts.
          </p>
          {view.worthKnowing.length > 0 ? (
            <div className="text-meta">
              <p className="font-medium">Worth knowing:</p>
              <ul className="list-disc pl-5 text-ink2">
                {view.worthKnowing.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.notChecked.length > 0 ? (
            <div className="text-meta" data-testid="roster-change-not-checked">
              <p className="font-medium">Not checked:</p>
              <ul className="list-disc pl-5 text-ink2">
                {view.notChecked.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
              <p className="text-ink2">Look at these on the Roster screen before you publish.</p>
            </div>
          ) : null}
          {failed ? (
            <p className="text-meta text-errorink" role="status" data-testid="roster-change-failed">
              The Roster screen could not be opened. Open it yourself and make the swap there.
            </p>
          ) : null}
          <footer className="flex flex-wrap items-center gap-2 border-t border-line2 pt-3">
            <Button data-testid="roster-change-apply" disabled={opening} onClick={() => void onApply()}>
              {opening ? "Opening…" : "Apply to roster"}
            </Button>
            <Button variant="ghost" data-testid="roster-change-dismiss" onClick={() => assistantActions.clearRosterChange()}>
              Not now
            </Button>
            <span className="text-meta text-ink2">You can undo it on the Roster screen.</span>
          </footer>
        </>
      )}
    </Surface>
  );
}
```

- [ ] **Step 4: Mount it and label the tools.** In `web/components/ai/assistant-conversation.tsx`:
  - `import { RosterChangeCard } from "./roster-change-card";`
  - Render `<RosterChangeCard />` directly after `<OptimizeRunRequestCard />` (`:194`).
  - Add to `TOOL_ACTIVITY`:

```ts
  get_roster: "Reading the roster…",
  find_swap_partners: "Looking for who can swap…",
  prepare_roster_swap: "Preparing a swap…",
```

- [ ] **Step 5: Run them and see them pass.** Run: `cd web && pnpm vitest run components/ai`. Expected: PASS.

---

### Task 9A (amendment): The agreement tick, and applying two stores together

**Files:**
- Create: `web/components/ai/linked-apply.ts`
- Modify: `web/components/ai/roster-change-card.tsx`, `web/components/ai/use-assistant-proposals.ts` (export `describeApplyFailure`), `web/components/ai/assistant-conversation.tsx`
- Test: `web/components/ai/linked-apply.test.ts`, `web/components/ai/roster-change-card.test.tsx`

**Interfaces:**
- Produces:
  - `interface LinkedApplyDeps { readRoster; applyProposal; undoReceipt; navigate; requestRosterChange; awaitRosterChangeOutcome }`
  - `applyLinkedChange(change: { request: RosterChangeRequest | null; linked: { proposalId: string } | null }, deps?: LinkedApplyDeps): Promise<{ ok: true } | { ok: false; message: string }>`

- [ ] **Step 1: Write the failing tests.** Create `web/components/ai/linked-apply.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { priyaRosterDocument } from "@/lib/roster-viewer/swap-fixtures";
import { applyLinkedChange, type LinkedApplyDeps } from "./linked-apply";

const document = priyaRosterDocument();
const REQUEST = {
  solvedBaselineId: document.provenance.solvedBaselineId,
  cells: [{ personIdx: 0, dateIdx: 1, before: { kind: "shift", shiftId: "N" } as const, after: { kind: "off" } as const }],
};
const CHANGE = { request: REQUEST, linked: { proposalId: "p-1" } };

function deps(overrides: Partial<LinkedApplyDeps> = {}) {
  const calls: string[] = [];
  const d: LinkedApplyDeps = {
    readRoster: vi.fn(async () => { calls.push("readRoster"); return document; }),
    applyProposal: vi.fn(async () => { calls.push("applyProposal"); return { ok: true as const, receiptId: "r-1" }; }),
    undoReceipt: vi.fn(async () => { calls.push("undoReceipt"); return true; }),
    navigate: vi.fn(async () => { calls.push("navigate"); return true; }),
    requestRosterChange: vi.fn(() => { calls.push("requestRosterChange"); }),
    awaitRosterChangeOutcome: vi.fn(async () => { calls.push("await"); return "applied" as const; }),
    ...overrides,
  };
  return { d, calls };
}

describe("applyLinkedChange", () => {
  it("checks the roster, applies the schedule, then the roster", async () => {
    const { d, calls } = deps();
    await expect(applyLinkedChange(CHANGE, d)).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["readRoster", "applyProposal", "navigate", "requestRosterChange", "await"]);
  });

  it("touches nothing when the roster changed since the card", async () => {
    const { d } = deps({ readRoster: async () => ({ ...document, edits: [{ personIdx: 0, dateIdx: 1, day: { kind: "off" } }] }) });
    const result = await applyLinkedChange(CHANGE, d);
    expect(result).toEqual({ ok: false, message: "Nothing was changed: the roster changed after this was prepared. Ask again." });
    expect(d.applyProposal).not.toHaveBeenCalled();
  });

  it("stops before the roster when the schedule refuses", async () => {
    const { d } = deps({ applyProposal: async () => ({ ok: false as const, reason: "confirmation-missing" }) });
    const result = await applyLinkedChange(CHANGE, d);
    expect(result.ok).toBe(false);
    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("undoes the leave move when the roster refuses", async () => {
    const { d } = deps({ awaitRosterChangeOutcome: async () => "roster-changed" as const });
    const result = await applyLinkedChange(CHANGE, d);
    expect(d.undoReceipt).toHaveBeenCalledWith("r-1");
    expect(result).toEqual({ ok: false, message: "Nothing was changed: the roster changed at the last moment. The leave record was put back too." });
  });

  it("says so plainly when that undo is refused", async () => {
    const { d } = deps({ awaitRosterChangeOutcome: async () => "expired" as const, undoReceipt: async () => false });
    const result = await applyLinkedChange(CHANGE, d);
    expect(result).toEqual({
      ok: false,
      message:
        "The leave record was changed, but the roster was not: the Roster screen did not open in time. Undo the leave change from the change list, or ask me again.",
    });
  });
});
```

In `roster-change-card.test.tsx`, add:

```tsx
const confirm = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, assistantProposalCommands: { ...actual.assistantProposalCommands, confirm, withdrawConfirmation: vi.fn(), cancel: vi.fn() } };
});

it("keeps Apply off until the agreement is ticked", async () => {
  assistantActions.showRosterChange(
    {
      ...CHANGE,
      view: { ...CHANGE.view, heading: "Ask SN-Asha to come in?", stepLabel: "Step 2 · Ask someone off or on leave to come in", agreement: "SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead." },
      linked: { proposalId: "p-1", assumptionIds: ["a-1"] },
    },
    TURN,
  );
  render(<RosterChangeCard />);
  expect(screen.getByTestId("roster-change-apply")).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: /SN-Asha agreed/ }));
  await waitFor(() => expect(screen.getByTestId("roster-change-apply")).toBeEnabled());
  expect(confirm).toHaveBeenCalledWith({ proposalId: "p-1", assumptionId: "a-1" });
  expect(screen.getByText("Step 2 · Ask someone off or on leave to come in")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `cd web && pnpm vitest run components/ai/linked-apply.test.ts components/ai/roster-change-card.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement `linked-apply.ts`.**

```ts
// Applying a roster change and its linked schedule change together, or not at all
// (plan 2026-09-24-roster-aware-assistant, Task 9A).
//
// Two stores, no shared transaction: the schedule (repository, durable receipts with
// Undo) and the roster (its own IndexedDB row, written by the Roster screen). So this
// is a short sequence that undoes itself: check the roster, apply the schedule, apply
// the roster, and undo the schedule's receipt if the roster refuses. The schedule goes
// first because it has the strictest gates (lease, revision, agreement) and a durable
// Undo. The one case it cannot undo is said plainly, never hidden.

import type { RosterDocument } from "@/lib/roster";
import {
  awaitRosterChangeOutcome,
  requestRosterChange,
  requestStillMatches,
  type RosterChangeOutcome,
  type RosterChangeRequest,
} from "@/lib/roster/change-request";
import { readRosterForAssistant } from "@/lib/ai/assistant/roster-context";
import { assistantProposalCommands } from "@/lib/store";
import { describeApplyFailure } from "./use-assistant-proposals";

export interface LinkedApplyDeps {
  readRoster(): Promise<RosterDocument | null>;
  applyProposal(proposalId: string): Promise<{ ok: true; receiptId: string } | { ok: false; reason: string }>;
  undoReceipt(receiptId: string): Promise<boolean>;
  /** Opens the Roster screen. False when it could not be opened or the user cancelled. */
  navigate(): Promise<boolean>;
  requestRosterChange(request: RosterChangeRequest): void;
  awaitRosterChangeOutcome(): Promise<RosterChangeOutcome>;
}

const WHY: Record<Exclude<RosterChangeOutcome, "applied">, string> = {
  "roster-changed": "the roster changed at the last moment",
  rejected: "the Roster screen refused the change",
  expired: "the Roster screen did not open in time",
};

export async function applyLinkedChange(
  change: { request: RosterChangeRequest | null; linked: { proposalId: string } | null },
  deps: LinkedApplyDeps,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // 1. Nothing is touched unless the roster still holds every before cell.
  if (change.request !== null) {
    const roster = await deps.readRoster();
    if (roster === null || !requestStillMatches(roster, change.request)) {
      return { ok: false, message: "Nothing was changed: the roster changed after this was prepared. Ask again." };
    }
  }
  // 2. The schedule half. Its own transaction re-checks lease, revision and agreement.
  let receiptId: string | null = null;
  if (change.linked !== null) {
    const applied = await deps.applyProposal(change.linked.proposalId);
    if (!applied.ok) return { ok: false, message: describeApplyFailure(applied.reason) };
    receiptId = applied.receiptId;
  }
  if (change.request === null) return { ok: true };
  // 3. The roster half, through the Roster screen's own edit session.
  const undo = async (why: string) => {
    if (receiptId === null) return { ok: false as const, message: `Nothing was changed: ${why}.` };
    return (await deps.undoReceipt(receiptId))
      ? { ok: false as const, message: `Nothing was changed: ${why}. The leave record was put back too.` }
      : {
          ok: false as const,
          message: `The leave record was changed, but the roster was not: ${why}. Undo the leave change from the change list, or ask me again.`,
        };
  };
  if (!(await deps.navigate())) return undo("the Roster screen could not be opened");
  deps.requestRosterChange(change.request);
  const outcome = await deps.awaitRosterChangeOutcome();
  return outcome === "applied" ? { ok: true } : undo(WHY[outcome]);
}

/** The production wiring. `navigate` comes from the card's `useCapabilityNavigation`. */
export function linkedApplyDeps(navigate: () => Promise<boolean>): LinkedApplyDeps {
  return {
    readRoster: async () => {
      const read = await readRosterForAssistant();
      return read.status === "ready" ? read.document : null;
    },
    applyProposal: async (proposalId) => {
      const result = await assistantProposalCommands.apply({ proposalId, receiptId: crypto.randomUUID() });
      return result.ok ? { ok: true, receiptId: result.receipt.receiptId } : { ok: false, reason: result.reason };
    },
    undoReceipt: async (receiptId) => (await assistantProposalCommands.undoReceipt(receiptId)).ok,
    navigate,
    requestRosterChange,
    awaitRosterChangeOutcome: () => awaitRosterChangeOutcome(),
  };
}
```

Check the `CommandOutcome` shape in `lib/store/authority.ts` before relying on `.ok`, and adjust that one line if the field is named differently. In `use-assistant-proposals.ts`, change `function describeApplyFailure` to `export function describeApplyFailure`.

- [ ] **Step 4: Update the card.** In `roster-change-card.tsx`:
  - Split it into `RosterChangeCard` (it reads `active`, returns null when there is none, and renders `<RosterChangeBody key={active.id} active={active} stopped={...} />`) and `RosterChangeBody`, which holds `agreed`, `opening` and `message` state. The key resets the tick for every new card.
  - Header: render `view.stepLabel` as a small label above `view.heading`, in place of the fixed "Swap shifts?".
  - After the table: render `view.leaveRows` as plain lines, then `view.notes`. Keep the check line only when `view.rows.length > 0`, and render the table only when rows exist.
  - When `view.agreement !== null`, render:

```tsx
<label className="flex items-start gap-2 text-meta">
  <input
    type="checkbox"
    checked={agreed}
    onChange={(event) => void onAgree(event.target.checked)}
    data-testid="roster-change-agree"
  />
  <span>{view.agreement}</span>
</label>
```

    with:

```ts
const onAgree = async (checked: boolean) => {
  setAgreed(checked);
  // Recorded on the linked proposal too, so its own Apply gate agrees with the tick.
  for (const assumptionId of active.linked?.assumptionIds ?? []) {
    const input = { proposalId: active.linked!.proposalId, assumptionId };
    await (checked ? assistantProposalCommands.confirm(input) : assistantProposalCommands.withdrawConfirmation(input));
  }
};
```

  - Apply is disabled when `opening || (view.agreement !== null && !agreed)`.
  - `onApply`: when `active.linked === null && active.request !== null`, keep Task 9's path unchanged. Otherwise:

```ts
const result = await applyLinkedChange(
  active,
  linkedApplyDeps(async () => {
    const outcome = await navigate("roster-viewer");
    return outcome.status !== CAPABILITY_UNAVAILABLE;
  }),
);
if (result.ok) assistantActions.clearRosterChange();
else setMessage(result.message);
```

    Render `message` as `<p role="status" className="text-meta text-errorink">`.
  - "Not now": `if (active.linked) void assistantProposalCommands.cancel(active.linked.proposalId);` then `assistantActions.clearRosterChange()`. No orphan proposal stays applicable.
- In `assistant-conversation.tsx`, add `prepare_borrowed_cover: "Preparing a borrowed nurse…",` to `TOOL_ACTIVITY`.

- [ ] **Step 5: Run them and see them pass.** Run: `cd web && pnpm vitest run components/ai`. Expected: PASS.

---

### Task 10: Model instruction, help content, manifest, docs

**Files:**
- Modify: `web/lib/ai/assistant/scenario-context.ts`, `web/lib/ai/assistant/scenario-context.test.ts`, `web/lib/capability/help-content.ts`, `docs/ai-assistant.md`
- Regenerate: `web/lib/capability/registry.generated.ts`

- [ ] **Step 1: Write the failing test.** Add this to `web/lib/ai/assistant/scenario-context.test.ts`:

```ts
  it("tells the model to read the roster and to swap only through the card", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/get_roster/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/find_swap_partners.*prepare_roster_swap/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/never ask the user who works/i);
  });

  it("tells the model to follow the ward's escalation ladder and name the step", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/step 1.*step 2.*step 3.*step 4/i);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/overtime pay, or off-in-lieu/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/nurse manager's sign-off/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/prepare_borrowed_cover/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/sick_or_emergency/);
  });
```

- [ ] **Step 2: Run it and see it fail.** Run: `cd web && pnpm vitest run lib/ai/assistant/scenario-context.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `ASSISTANT_AUTHORITY_STATEMENT` (`scenario-context.ts:100-121`), add this directly after the `request_optimize_run` line:

```ts
  "You can read the saved roster with get_roster; never ask the user who works which shift. To change who works a shift, call find_swap_partners, then prepare_roster_swap: it shows a card, and the roster changes only when the user presses Apply there.",
  "To cover a shift (a swap request, or MC, sick or emergency leave with reason sick_or_emergency), follow the step find_swap_partners returns and say it in plain words: step 1 swap or cover within the ward; step 2 ask someone who is off or on leave to come in, as a request that names the pay-back (overtime pay, or off-in-lieu); step 3 ask the nursing supervisor for the relief pool, then another ward or an agency, with prepare_borrowed_cover, and remind the user to let their nurse manager know; step 4, only when the user says no temporary nurse is available, run the shift one short with the nurse manager's sign-off, never dropping the nurse in charge (NIC). Never skip a step, never blame the nurse on MC.",
```

In `help-content.ts`, extend `roster-viewer.nurseFacingSummary` (`:264-266`) with this sentence:

```ts
      " The assistant can read this roster, suggest who can swap a shift without breaking the " +
      "rules it was made with, and prepare the swap; it changes only when you press Apply on its " +
      "card, and you can undo it here.",
```

Regenerate: `cd web && pnpm capability:generate`. Expected: `lib/capability/registry.generated.ts` gets a new `manifestSha256`.

In `docs/ai-assistant.md`:
  - Table: find the row that ends "Repair a produced roster (that is a later phase, and is not built)". Put these two rows in its place:

```md
| Hand a tested repair to the normal Preview → confirm → Apply flow | Re-optimise or repair a produced roster on its own |
| Read the saved roster, suggest who can swap a shift, and show the swap on a card | Change the roster without your Apply click |
```

  - After the "(2026-09-24) Solver runs lifted." paragraph, add:

```md
**(2026-09-24) Roster swaps lifted.** The assistant can read the saved roster and suggest
who can take someone's shifts. It checks every hard rule the roster was made with:
staffing and skill mix, rest between shifts written as shift-pattern rules, requests and
leave, and shift counts. It cannot check hard "work together" or supervision rules, and
it says so on the card. The swap happens only when you press **Apply to roster**. It is
then an ordinary edit on the Roster screen: one Undo reverts it, and the export includes it.

When nobody can take a shift, the assistant follows a four-step cover ladder and says
which step it is on: (1) swap or cover within the ward; (2) ask a nurse who is off or on
leave if she can come in, for overtime pay or off-in-lieu (she must agree, and you tick
that on the card); (3) ask the nursing supervisor for a relief-pool nurse, or another ward
or an agency, added as temporary staff (let your nurse manager know); (4) last resort, with
your nurse manager's sign-off: run the shift one short, never without a nurse who can be
in charge. For "Priya is
on MC on 8 Oct" it marks her on leave and runs the same ladder. When a change also
changes the schedule (a leave move, the MC, a borrowed nurse), the card applies both
together or neither. A borrowed nurse joins the roster on screen after the next run.
```

- [ ] **Step 4: Run the tests.** Run: `cd web && pnpm vitest run lib/ai lib/capability`. Expected: PASS.

---

### Task 11: Whole-branch gates

- [ ] **Step 1:** `cd web && pnpm typecheck`. Expected: no errors.
- [ ] **Step 2:** `cd web && pnpm run lint`. Expected: clean. A `no-restricted-imports` hit in `lib/roster*` or `components/roster-viewer` means an AI import slipped in. Move it to the assistant side.
- [ ] **Step 3:** `cd web && pnpm vitest run lib/roster lib/roster-viewer components/roster-viewer lib/ai components/ai lib/capability`. Expected: PASS.
- [ ] **Step 4 (manual, real browser):** Load a scenario with a `-inf` `[N, AM]` succession and a qualified night requirement. Run the optimiser, and on the chat ask "X needs to change her night shifts on <d1> and <d2>, who can swap with her? do it for me now". Expected: a card appears. Apply opens `/roster` with the swap. Undo reverts it. The XLSX download shows the swapped cells.
- [ ] **Step 4b (manual, the ladder):** load the Asha fixture shape (leave pin on 8–9 Oct, no valid swap). Ask for Priya's nights. Expected: "Step 2", the Asha trade, and Apply off until ticked. After Apply, `/roster` shows the trade and the Requests screen shows Asha's leave on 11–12 Oct. Then edit a cell on `/roster` between Prepare and Apply. Expected: "Nothing was changed", and the leave is unchanged. Then say "Priya is on MC on 8 Oct" on the borrow shape. Expected: "Step 3", then a borrow card after you give a name.
- [ ] **Step 5:** `bd update nursing-sheduler-73z --notes "…"` with the changed files. File beads for Task 12 (roster-file/2) and the follow-ups. Do not commit.

---

### Task 12 (Phase C2, its own plan): Borrowed rows in the roster document (roster-file/2)

This is not implemented here. It is sized and scoped so that step 3 can put the borrowed nurse on the roster in the same Apply as the staff change. **Write its own writing-plans document before starting.** The surface is wide.

**Why it is needed.** `validateRosterDocument` re-derives `context` from `submission` and requires an exact match. `solvedDays` covers exactly `context.people`. A person added after the run has no row, and none can be added without a schema change (`lib/roster/types.ts` header, `lib/roster/validate.ts:15-18`).

**Shape.**
- `ROSTER_DOCUMENT_SCHEMA_VERSION = "roster-file/2"`. `RosterDocument.borrowed: readonly { id: PersonId; description?: string; days: readonly RosterDayState[] }[]`, and the row axis index is `context.people.length + i`. `ROSTER_DOCUMENT_FIELDS` gains `"borrowed"`.
- A migration in `ROSTER_FILE_MIGRATIONS` for roster-file/1 adds `borrowed: []`. `validate.ts` checks unique ids not in `context.people`, `days.length === calendar.length`, and shift ids that resolve.
- An overlay decision: borrowed rows are edited in place (no baseline) or through `edits` with `OverlayBounds` extended to them. Recommend in place: they have no solved value.
- `RosterChangeRequest.addPeople?: { id; days }[]`. `useRosterEditing` gains `addBorrowedRows`, in one autosave revision with the cells.
- Consumers to extend: `deriveCurrentDays` callers, `buildAssignmentIndex`, `computeTallies`, `roster-grid.tsx`, `roster-coverage.tsx`, `roster-day.tsx`, `roster-edit-bar.tsx`, `edited-xlsx.ts` (append a styled row after `coordinateMap.peopleRows`; needs investigation), and `file.ts` encode/decode.
- The step 3 card then renders the cell table and drops the "appears after the next run" note. `prepare_borrowed_cover` sends `addPeople`, and `applyLinkedChange` is unchanged.
- Locked tests: the roster-schema suites (`schema-version.test.ts`, `validate.test.ts`, `f5-proof-matrix.test.ts`) and the edited-XLSX suite.

---

## Decisions

- **Approach A (host-checked roster edit) over B (pins + re-run) and C (read-only).** B re-solves the whole roster, adds one-off pins to the scenario, and cannot keep other assignments. C fails "do it for me now". C is Tasks 1–8 without the card. When Task 9 slips, C ships first.
- **A card and seam like `request_optimize_run`, not `PreparedProposalV1`.** Proposals are bound to scenario revision, commit, lease and idempotency. A roster overlay has its own CAS autosave. Forcing it into the proposal union breaks "every arm compiles to a scenario primitive".
- **The roster's own submission is the rule authority.** It is what the roster was solved under, and `./requirements` already reads it.
- **Tool names keep `swap`.** The Phase-2 regex is narrowed openly instead of renaming around it.
- **The ladder lives in the host, not the prompt.** `find_swap_partners` returns only the lowest step with an option, and `prepare_borrowed_cover` refuses below step 3. The model cannot skip a step even if it wants to.
- **A leave move is a linked proposal, not a new command arm.** The shipped `move_leave`, `add_leave`, `add_person` and `set_*_request` ops carry the schedule half. `deriveAssumptions` supplies the real-world questions, and the durable Apply gate enforces them. The card ticks them.
- **Apply order is schedule first, roster second, undo on failure.** The schedule has the strict gates and a durable receipt with Undo. The roster's session undo is single-level and runs after navigation.
- **Four steps, not six.** Part-timers and spare capacity rank into step 1. Relief pool, other ward and agency share one borrow mechanism with a `source` label. Skill-mix downgrade is out of v1 (spec open question 18).
- **Step 3 ships as C1.** A roster document cannot hold a person outside its submission. So the borrowed nurse joins the schedule now, and the roster after a run or after C2 (Task 12).

## Open questions (with recommended answers)

1. Hard affinity/covering: block or note? **Note** ("Not checked"), and allow Apply.
2. The rules to use: the roster's or the current scenario's? **The roster's.** Add a "scenario changed since this run" note later.
3. Cross-date trades? **In v1 for step 2** (a nurse off or on leave). Trades between two working nurses stay out.
4. Is a cover a swap? **Yes**, labelled `cover`.
5. Does a newer unloaded run block? **Yes**, with Load guidance.
6. A follow-up message after Apply? **Follow-up bead** (`use-assistant-follow-ups.ts` pattern).
7. A solver-verified check? **Only if** the differential test shows drift.
8. Fairness order? **v1 as coded.** Confirm with a ward manager.
9. A leave nurse gives up her leave with no later date (`clear_requests`, `leave_cancelled`)? **Not in v1.**
10. Move OFF requests along with OFF days? **Not in v1.** A hard one is refused by the check.
11. Step 3 roster row: roster-file/2 now, or C1 first? **C1 first**, then Task 12 as its own plan.
12. Step 3 before C2: offer a re-run on the borrow card? **Yes, as a second option**, with "this replaces hand edits".
13. An MC always goes into the leave record? **Yes.** It needs no tick.
14. Record an MC with no cover? **Yes**, and state the uncovered shift.
15. Step 2 later dates: consecutive runs only? **Yes for v1** (`ponytail:`). Ask wards whether split dates or "same weekday next week" matter.
16. Does step 1 `cover` need a tick? **No** for a spare-capacity cover. Without spare capacity it is step 2 `overtime`, with a tick.
17. "Nurse manager" or "nurse clinician (NC)" in sign-off lines? **"Nurse manager" in v1**, as one constant.
18. Skill-mix downgrade in step 4? **Not in v1.** Revisit with the skill-mix rules.
19. Record the temporary nurse's source on the staff record? **Not in v1** (no `add_person` field). Show it in the card title and rationale.
20. Tell the nurse manager from step 2 (the research's suggestion)? **From step 3 in v1**, as the user asked.
21. Is "under any count target" too generous for spare capacity? **Accept for v1.** Ask a ward whether only contracted-hours targets count.
22. The lending-ward question says "lending ward or agency". Does it read wrong for the relief pool? **Yes, slightly.** Recommend a one-line wording change in `assumptions.ts` ("lending ward, relief pool or agency") with its test, as a follow-up bead.

## Assumptions

- `context.people[].id` are the names nurses type (for example `SN-Priya`).
- `useCapabilityNavigation("roster-viewer")` reaches `/roster` the same way `generate-roster` reaches the Optimise screen.
- `rosterStorage` rows carry `candidateSource` (as `useWorkingRoster` reads it).
- The runtime converter accepts `z.string().optional()` and arrays of strings (as `evidenceSchema.reference` and `offer_choices` do today). Task 8 Step 6 verifies it.

## Follow-ups (file as beads)

- Differential test: rule-check verdicts against the Python solver on pinned rosters (`pnpm test:differential`).
- Flag new hard issues on hand edits in the Roster grid, with the same `checkRosterChange`.
- A follow-up message after a roster Apply.
- Trades between two working nurses.
- Task 12: roster-file/2 borrowed rows (its own plan).
- The `leave_cancelled` give-up variant for step 2, and OFF-request moves.
