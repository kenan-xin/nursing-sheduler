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
