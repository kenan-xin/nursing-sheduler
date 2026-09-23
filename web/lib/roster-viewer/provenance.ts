// Solve provenance (F4) — "as solved", never recomputed.
//
// The banner shows the solver status (Optimal / Feasible) and score, always
// labeled "as solved", plus an "edited since solve" indicator once the roster
// diverges from its solved baseline. Coverage counts and tallies always reflect
// the CURRENT (possibly edited) roster; the solver score is NEVER recomputed
// after manual edits (Core Flows Flow 4). An imported or manually-built roster
// with no solve shows no score.

import type { RosterProvenance } from "@/lib/roster/types";

/** The derived provenance view the banner renders. */
export interface ProvenanceView {
  /** OPTIMAL or FEASIBLE, uppercased for display. */
  solverStatus: string;
  /** The solver score, formatted as a string, or null when absent. */
  score: string | null;
  /** Whether the roster has diverged from its solved baseline. */
  editedSinceSolve: boolean;
}

/**
 * Build the provenance view from the document's provenance and its edited-since
 * flag. Pure — the caller derives `editedSinceSolve` from the overlay.
 */
export function buildProvenanceView(
  provenance: RosterProvenance,
  editedSinceSolve: boolean,
): ProvenanceView {
  return {
    solverStatus: provenance.solverStatus.toUpperCase(),
    score: Number.isFinite(provenance.score) ? String(provenance.score) : null,
    editedSinceSolve,
  };
}
