// The one seam through which something OUTSIDE the Staff screen can ask its
// "Temporary cover" form to make an edit (d582, spec §7, the iwo rule).
//
// The assistant's Apply opens Staff and calls `requestCoverEdit`. The form takes the
// request, fills its fields in view, validates them with the same `validateCover` a
// hand edit uses, and presses its own Save. That Save runs `commit`: the caller's one
// write (for the assistant, the proposal's durable Apply). So the user watches the
// edit happen on the form, and nothing is written when the form refuses.
//
// Modelled on `lib/roster/change-request.ts`. It lives in lib/scenario, not lib/ai,
// because scheduling code may never import assistant code; this imports nothing of
// the assistant's. Not re-exported from the barrel (zustand stays out of it).

import { create } from "zustand";
import type { UiTemporaryCover } from "./types";

// ponytail: fixed TTL, same as ROSTER_CHANGE_TTL_MS.
export const COVER_EDIT_TTL_MS = 15_000;

export type CoverEditRequest =
  | { kind: "add"; entry: UiTemporaryCover }
  | { kind: "remove"; name: string; date: string; shiftType: string };

export type CoverEditOutcome = "applied" | "rejected" | "expired";

/** The write the form's Save performs. A refusal's message is shown in the editor. */
export type CoverCommit = () => Promise<{ ok: true } | { ok: false; message: string }>;

export interface CoverEditRun {
  readonly edits: readonly CoverEditRequest[];
  readonly commit: CoverCommit;
}

export interface CoverEditState {
  pending: (CoverEditRun & { requestedAt: number }) | null;
  /** The form took the last request: from here only the form settles it, never a timer. */
  taken: boolean;
  last: CoverEditOutcome | null;
}

export const useCoverEditStore = create<CoverEditState>()(() => ({
  pending: null,
  taken: false,
  last: null,
}));

export function requestCoverEdit(run: CoverEditRun, now: number = Date.now()): void {
  useCoverEditStore.setState({ pending: { ...run, requestedAt: now }, taken: false, last: null });
}

/** Consume the pending request. Returns it only while it is still fresh. */
export function takeCoverEditRequest(now: number = Date.now()): CoverEditRun | null {
  const { pending } = useCoverEditStore.getState();
  if (pending === null) return null;
  if (now - pending.requestedAt > COVER_EDIT_TTL_MS) {
    useCoverEditStore.setState({ pending: null, last: "expired" });
    return null;
  }
  useCoverEditStore.setState({ pending: null, taken: true });
  return { edits: pending.edits, commit: pending.commit };
}

export function reportCoverEdit(outcome: CoverEditOutcome): void {
  useCoverEditStore.setState({ last: outcome });
}

/** What the Staff form did with the request just made. `expired` when nobody took it in time. */
export function awaitCoverEditOutcome(
  timeoutMs: number = COVER_EDIT_TTL_MS,
): Promise<CoverEditOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: CoverEditOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = useCoverEditStore.subscribe((state) => {
      if (state.last !== null) finish(state.last);
    });
    const timer = setTimeout(() => {
      // Taken: the form is filling or saving, and it always reports. Waiting on is
      // what keeps a slow Save from being called "expired" after it wrote.
      if (useCoverEditStore.getState().taken) return;
      useCoverEditStore.setState({ pending: null, last: "expired" });
    }, timeoutMs + 50);
  });
}
