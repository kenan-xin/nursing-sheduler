// Delete an entity or group, then say what the cascade took with it (F10/R9).
// A delete prunes requests, leave pins, rules and date exceptions the user cannot
// see from the screen they are on; the toast names them and offers Undo.

import { toast } from "sonner";
import type { ScenarioUiState } from "@/lib/scenario";
import { scenarioCommands, type CommandOutcome } from "@/lib/store";
import {
  deleteEntity,
  deleteImpact,
  describeDeleteImpact,
  type EntityDomain,
  type EntityRef,
} from "@/lib/cascade";

/** The toast for a refused Save (T6), so every editor says the same thing. `noun`
 *  names what was being saved ("group", "nurse", "date group"). */
export function saveRefusalMessage(
  outcome: Extract<CommandOutcome, { ok: false }>,
  noun: string,
): string {
  return outcome.reason === "not-owner"
    ? "This schedule is being edited in another tab. Take over editing, then save again."
    : outcome.reason === "superseded"
      ? `This ${noun} changed elsewhere. Reopen it and try again.`
      : `This ${noun} could not be saved. Reload the page and try again.`;
}

/** Commit `deleteEntity(domain, id)` through `commit` (so the owner's stale guard
 *  still applies) and, once it lands, toast the counted impact with an Undo. The
 *  impact is counted at the queue head, against the state actually deleted from. */
export async function deleteWithSummary(
  commit: (transform: (live: ScenarioUiState) => ScenarioUiState) => Promise<CommandOutcome>,
  label: string,
  domain: EntityDomain,
  id: EntityRef,
): Promise<void> {
  let lines: string[] = [];
  const outcome = await commit((live) => {
    lines = describeDeleteImpact(deleteImpact(live, domain, id));
    return deleteEntity(live, domain, id);
  });
  if (!outcome.ok || !outcome.committed) return;
  toast(`Deleted ${label}${lines.length > 0 ? `: ${lines.join(", ")}` : ""}.`, {
    action: undoDeleteAction(outcome.documentRevision),
  });
}

/** A delete toast's Undo: reverses that delete only while it is still the latest change. */
export function undoDeleteAction(documentRevision: number) {
  return {
    label: "Undo",
    onClick: async () => {
      const undone = await scenarioCommands.undo(documentRevision);
      if (!undone.ok && undone.reason === "superseded") {
        toast("Can't undo this delete: the schedule has changed since.");
      }
    },
  };
}
