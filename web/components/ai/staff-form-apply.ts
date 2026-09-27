// Apply a proposal's temporary covers through the Staff form, in view (d582 Task 17,
// spec §7, the iwo rule).
//
// The Apply opens Staff and hands the form the proposal's cover edits. The form fills
// its fields, validates them like a hand edit and presses its own Save, and that Save
// runs `commit`: the proposal's ONE durable Apply. So a linked proposal (a cover plus
// the asking nurse's leave) stays one transaction with one receipt and one Undo, and
// nothing is written when the form refuses.
//
// A leaf: both the Preview's controller and the linked roster Apply use it, so it
// imports neither.

import type { AssistantCommandV1 } from "@/lib/proposal";
import { proposalBasisBlock } from "@/lib/proposal";
import type { AssistantProposalV1 } from "@/lib/store";
import type {
  CoverCommit,
  CoverEditOutcome,
  CoverEditRequest,
  CoverEditRun,
} from "@/lib/scenario/cover-edit-request";

export type StaffFormProposal = Pick<
  AssistantProposalV1,
  "scenarioId" | "baseDocumentRevision" | "baseCommitId" | "status" | "commands"
>;

export interface StaffFormDeps {
  /** The persisted document the proposal must still match. */
  readBasis(): Promise<{
    scenarioId: string;
    documentRevision: number;
    topCommitId: string | null;
  } | null>;
  /** Opens a screen. False when it could not be opened or the user cancelled. */
  navigate(capabilityId: string): Promise<boolean>;
  requestCoverEdit(run: CoverEditRun): void;
  awaitCoverEditOutcome(): Promise<CoverEditOutcome>;
}

export const STALE_MESSAGE =
  "Nothing was changed: the schedule changed after this was prepared. Ask again.";
const NOT_OPENED = "Nothing was changed: the Staff screen could not be opened.";

/** The cover edits a proposal makes, in command order, as the store will write them. */
export function coverEditsOf(commands: readonly AssistantCommandV1[]): CoverEditRequest[] {
  return commands.flatMap((command): CoverEditRequest[] => {
    if (command.type === "add_temporary_cover") {
      const { name, date, shiftType, groups } = command;
      return [
        {
          kind: "add",
          entry: { name: name.trim(), date, shiftType, groups: [...new Set(groups)] },
        },
      ];
    }
    if (command.type === "remove_temporary_cover") {
      const { name, date, shiftType } = command;
      return [{ kind: "remove", name: name.trim(), date, shiftType }];
    }
    return [];
  });
}

/**
 * Hand the proposal's covers to the Staff form. Resolves `null` once the form's Save
 * ran `commit` (the caller reads what its own commit returned), or the refusal to
 * show when it never ran: a stale proposal, a screen that did not open, or a form
 * that refused the edit (the reason is then on the form).
 */
export async function applyThroughStaffForm(
  proposal: StaffFormProposal,
  commit: CoverCommit,
  deps: StaffFormDeps,
): Promise<string | null> {
  const basis = await deps.readBasis();
  if (
    proposal.status === "applied" ||
    proposal.status === "cancelled" ||
    basis === null ||
    proposalBasisBlock(proposal, basis) !== null
  ) {
    return STALE_MESSAGE;
  }
  const commitRan = { value: false };
  let outcome: CoverEditOutcome;
  try {
    if (!(await deps.navigate("staff-list"))) return NOT_OPENED;
    deps.requestCoverEdit({
      edits: coverEditsOf(proposal.commands),
      commit: () => {
        commitRan.value = true;
        return commit();
      },
    });
    outcome = await deps.awaitCoverEditOutcome();
  } catch {
    return commitRan.value ? null : NOT_OPENED;
  }
  if (commitRan.value) return null;
  return outcome === "expired"
    ? "Nothing was changed: the Staff screen did not open in time."
    : "Nothing was changed: the Staff screen did not save the temporary cover. The reason is shown there.";
}
