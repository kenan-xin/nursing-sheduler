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
  applyProposal(
    proposalId: string,
  ): Promise<{ ok: true; receiptId: string } | { ok: false; reason: string }>;
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
      return {
        ok: false,
        message: "Nothing was changed: the roster changed after this was prepared. Ask again.",
      };
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
      ? {
          ok: false as const,
          message: `Nothing was changed: ${why}. The leave record was put back too.`,
        }
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
      const result = await assistantProposalCommands.apply({
        proposalId,
        receiptId: crypto.randomUUID(),
      });
      return result.ok
        ? { ok: true, receiptId: result.receipt.receiptId }
        : { ok: false, reason: result.reason };
    },
    undoReceipt: async (receiptId) => (await assistantProposalCommands.undoReceipt(receiptId)).ok,
    navigate,
    requestRosterChange: (request) => requestRosterChange(request),
    awaitRosterChangeOutcome: () => awaitRosterChangeOutcome(),
  };
}
