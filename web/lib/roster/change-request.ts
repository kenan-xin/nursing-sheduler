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
import { rosterAxisContext, rosterCurrentDays, withBorrowedRows } from "./borrowed";
import { dayStatesEqual, typedIdKey } from "./day-state";
import type { RosterBorrowedRow, RosterDayState, RosterDocument } from "./types";

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
  /**
   * Temporary nurses to add as borrowed rows in the same revision (bead g1p). They
   * join the axis after the rows already there, and `cells` may address them, with
   * `before` read from the row as added.
   */
  readonly addPeople?: readonly RosterBorrowedRow[];
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
  return {
    solvedBaselineId: pending.solvedBaselineId,
    cells: pending.cells,
    ...(pending.addPeople ? { addPeople: pending.addPeople } : {}),
  };
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

/** Whether the roster still holds every cell the request was prepared against. */
export function requestStillMatches(
  document: RosterDocument,
  request: RosterChangeRequest,
): boolean {
  if (document.provenance.solvedBaselineId !== request.solvedBaselineId) return false;
  const added = request.addPeople ?? [];
  // Someone of that name already on the roster: the card is stale (applied twice?).
  const onRoster = new Set(rosterAxisContext(document).people.map((p) => typedIdKey(p.id)));
  if (added.some((row) => onRoster.has(typedIdKey(row.id)))) return false;
  const current = rosterCurrentDays(withBorrowedRows(document, added));
  return request.cells.every((cell) => {
    const now = current[cell.personIdx]?.[cell.dateIdx];
    return now !== undefined && dayStatesEqual(now, cell.before);
  });
}

/** What the Roster screen did with the request just made. `expired` when nobody took it in time. */
export function awaitRosterChangeOutcome(
  timeoutMs: number = ROSTER_CHANGE_TTL_MS,
): Promise<RosterChangeOutcome> {
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
