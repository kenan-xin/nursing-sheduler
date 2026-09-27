// Applying a roster change and its linked schedule change together, or not at all
// (plan 2026-09-24-roster-aware-assistant, Task 9A).
//
// Two stores, no shared transaction: the schedule (repository, durable receipts with
// Undo) and the roster (its own IndexedDB row, written by the Roster screen). So this
// is a short sequence that undoes itself: check the roster, apply the schedule, apply
// the roster, and undo the schedule's receipt if the roster refuses. The schedule goes
// first because it has the strictest gates (lease, revision, agreement) and a durable
// Undo. The one case it cannot undo is said plainly, never hidden.
//
// A schedule half that books or cancels a temporary cover (d582 Task 17) is applied
// on the Staff screen, in view: the Temporary cover form fills and its Save runs the
// proposal's one durable Apply (`staff-form-apply.ts`). Then the other screens the
// proposal touches are walked in the Apply notice's order (Requests for the asking
// nurse's leave), and only then the Roster screen.

import type { RosterDocument } from "@/lib/roster";
import type { ProposalDiff } from "@/lib/proposal";
import { planChangeHighlight } from "@/lib/change-highlight/plan";
import { showChangeHighlight } from "@/lib/change-highlight/store";
import { awaitCoverEditOutcome, requestCoverEdit } from "@/lib/scenario/cover-edit-request";
import {
  awaitRosterChangeOutcome,
  requestRosterChange,
  requestStillMatches,
  type RosterChangeOutcome,
  type RosterChangeRequest,
} from "@/lib/roster/change-request";
import { readRosterForAssistant } from "@/lib/ai/assistant/roster-context";
import type { LinkedScheduleChange } from "@/lib/ai/assistant/store";
import { assistantProposalCommands } from "@/lib/store";
import { describeApplyFailure } from "./use-assistant-proposals";
import { readCapabilityContext } from "./capability-context";
import {
  applyThroughStaffForm,
  coverEditsOf,
  type StaffFormDeps,
  type StaffFormProposal,
} from "./staff-form-apply";

export type LinkedProposal = StaffFormProposal & { diff: ProposalDiff };

type Applied = { ok: true; receiptId: string } | { ok: false; reason: string };

export interface LinkedApplyDeps extends StaffFormDeps {
  readRoster(): Promise<RosterDocument | null>;
  readProposal(proposalId: string): Promise<LinkedProposal | null>;
  applyProposal(proposalId: string): Promise<Applied>;
  undoReceipt(receiptId: string): Promise<boolean>;
  requestRosterChange(request: RosterChangeRequest): void;
  awaitRosterChangeOutcome(): Promise<RosterChangeOutcome>;
}

/** The record the linked proposal changes, and what to undo when the roster refuses. */
const RECORD: Record<LinkedScheduleChange["record"], { name: string; undo: string }> = {
  leave: { name: "leave record", undo: "the leave change" },
  staff: { name: "temporary cover", undo: "the temporary cover" },
};

const WHY: Record<Exclude<RosterChangeOutcome, "applied">, string> = {
  "roster-changed": "the roster changed at the last moment",
  rejected: "the Roster screen refused the change",
  expired: "the Roster screen did not open in time",
};

export async function applyLinkedChange(
  change: {
    request: RosterChangeRequest | null;
    linked: Pick<LinkedScheduleChange, "proposalId" | "record"> | null;
  },
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
  let applied: { receiptId: string; record: { name: string; undo: string } } | null = null;
  if (change.linked !== null) {
    const { proposalId } = change.linked;
    const proposal = await deps.readProposal(proposalId);
    let result: Applied | null;
    if (proposal !== null && coverEditsOf(proposal.commands).length > 0) {
      const box: { result: Applied | null } = { result: null };
      const refused = await applyThroughStaffForm(
        proposal,
        async () => {
          box.result = await deps.applyProposal(proposalId);
          return box.result.ok
            ? { ok: true }
            : { ok: false, message: describeApplyFailure(box.result.reason) };
        },
        deps,
      );
      if (refused !== null) return { ok: false, message: refused };
      result = box.result;
      if (result?.ok) await walkOtherScreens(proposal.diff, deps);
    } else {
      result = await deps.applyProposal(proposalId);
    }
    if (result === null) return { ok: false, message: describeApplyFailure("unknown") };
    if (!result.ok) return { ok: false, message: describeApplyFailure(result.reason) };
    applied = { receiptId: result.receiptId, record: RECORD[change.linked.record] };
  }
  if (change.request === null) return { ok: true };
  // 3. The roster half, through the Roster screen's own edit session.
  const undo = async (why: string) => {
    if (applied === null) return { ok: false as const, message: `Nothing was changed: ${why}.` };
    // A thrown undo is a refused one: the schedule half is still applied either way.
    const undone = await deps.undoReceipt(applied.receiptId).catch(() => false);
    const { name, undo: what } = applied.record;
    return undone
      ? {
          ok: false as const,
          message: `Nothing was changed: ${why}. The ${name} was put back too.`,
        }
      : {
          ok: false as const,
          message: `The ${name} was changed, but the roster was not: ${why}. Undo ${what} from the change list, or ask me again.`,
        };
  };
  let outcome: RosterChangeOutcome;
  try {
    if (!(await deps.navigate("roster-viewer"))) {
      return undo("the Roster screen could not be opened");
    }
    deps.requestRosterChange(change.request);
    outcome = await deps.awaitRosterChangeOutcome();
  } catch {
    return undo("the Roster screen could not be opened");
  }
  return outcome === "applied" ? { ok: true } : undo(WHY[outcome]);
}

/**
 * After Staff, show the proposal's other screens (Requests for the leave) in the
 * Apply notice's order (`planChangeHighlight`), outlining their rows. Display only: the change is already saved, so a
 * screen that does not open is skipped, not undone.
 */
async function walkOtherScreens(diff: ProposalDiff, deps: LinkedApplyDeps): Promise<void> {
  const plan = planChangeHighlight(diff, readCapabilityContext().mode);
  const screens = [plan.primary, ...plan.others].filter(
    (screen): screen is NonNullable<typeof screen> =>
      screen !== null && screen.capabilityId !== "staff-list",
  );
  for (const screen of screens) {
    if (await deps.navigate(screen.capabilityId).catch(() => false)) {
      showChangeHighlight(screen.keys);
    }
  }
}

/** The production wiring. `navigate` comes from the card's `useCapabilityNavigation`. */
export function linkedApplyDeps(
  navigate: (capabilityId: string) => Promise<boolean>,
): LinkedApplyDeps {
  return {
    readRoster: async () => {
      const read = await readRosterForAssistant();
      return read.status === "ready" ? read.document : null;
    },
    readProposal: (proposalId) => assistantProposalCommands.read(proposalId),
    readBasis: () => assistantProposalCommands.readScenarioBasis(),
    requestCoverEdit: (run) => requestCoverEdit(run),
    awaitCoverEditOutcome: () => awaitCoverEditOutcome(),
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
