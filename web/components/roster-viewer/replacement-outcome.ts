// Shared plain-language copy for a refused roster replacement (F5 / G3).
//
// Two surfaces branch on the SAME F1/F3 outcome union: the loaded-roster
// coordinator in `WorkingRosterPanel`, and the empty-state document actions on
// `RosterSection`. Naming the refusal in one place is what keeps them from
// drifting into telling the user different things about the same storage answer.
//
// This owns NO storage authority — the outcome is produced by `@/lib/roster`'s
// promotion/import primitives; this only turns it into a sentence.

import type { RosterImportOutcome, WorkingPromotionOutcome } from "@/lib/roster";

/** Which action the user asked for, for the two copy variants that differ. */
export type ReplacementKind = "load" | "import";

/** Every outcome either replacement path can produce. */
export type ReplacementOutcome = WorkingPromotionOutcome | RosterImportOutcome;

/** The non-success outcomes. Passing `promoted` here is a caller mistake. */
export type ReplacementFailure = Exclude<ReplacementOutcome, { status: "promoted" }>;

/**
 * The plain-language reason a replacement did not happen.
 *
 * Every branch is fail-closed reporting, never a euphemism: a rejection carries
 * F3's own decode/validation reason, and the catch-all still says the action did
 * not happen rather than falling silent.
 */
export function describeReplacementFailure(
  outcome: ReplacementFailure,
  kind: ReplacementKind,
): string {
  switch (outcome.status) {
    case "import-rejected":
    case "rejected":
      return outcome.reason;
    case "source-missing":
      return "The saved roster is no longer available.";
    case "version-conflict":
      return "A newer result replaced this one. Review the newer result instead.";
    case "working-conflict":
      return "The roster changed while replacing it. Try again.";
    default:
      return kind === "load"
        ? "The roster could not be loaded. Try again."
        : "The roster file could not be imported. Try again.";
  }
}

/** The copy shown when Clear could not remove everything it promises to remove. */
export const ROSTER_CLEAR_PARTIAL_MESSAGE =
  "Some stored data could not be cleared. Try again, or clear this site's data in your browser settings.";
