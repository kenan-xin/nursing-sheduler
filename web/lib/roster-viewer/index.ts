// Roster viewer domain (F4) — read-only derivation of coverage, tallies,
// provenance, date-span labels, and the shift start-time ramp.
//
// This module owns NO roster document state: it consumes F3's immutable
// `RosterDocument` and the F1 storage reads, and produces pure derivations the
// viewer renders. Editing, import/export, and Clear are F5's. The capture
// orchestration that produces a loadable candidate is F2's.
//
// The contracts this module enforces (tech plan → Coverage & tallies; core
// flows → Flow 4):
//
//   • COVERAGE IS EXECUTABLE. A shift is `available` iff F3's baseline rule
//     found exactly one unique simple requirement; zero/multiple/scoped/grouped/
//     qualified/coefficient cases are `unavailable` and never show a fabricated
//     number. "Short" = staffed < required. Recomputed live on edits.
//   • TALLIES ARE INFORMATIONAL. Per-nurse shift-type counts + OFF/leave days.
//     No red/error semantics, no fairness column, no hours metric.
//   • PROVENANCE IS FROZEN. Solver status + score are labeled "as solved" and
//     never recomputed after edits. "edited since solve" is derived from the
//     overlay, never independently mutable.
//   • THE RAMP IS FIXED. Eight entries by start time; mornings warm, nights
//     cool. Leave is neutral; rest is a bare dot. Literal hexes, not tokens.
//   • UNKNOWN IS NOT HEALTHY. An `unavailable` lane is the absence of evidence,
//     so summaries scope their claim to what was checkable and day health has a
//     distinct `unknown` state. Nothing turns "we could not check" into "fine".

export { SHIFT_RAMP, assignShiftRamp, type ShiftRampEntry } from "./shift-ramp";

export {
  computeCoverage,
  dayHealth,
  summariseCoverage,
  type CoverageGrid,
  type CoverageSummary,
  type DayCoverage,
  type ShiftCoverage,
} from "./coverage";

export { computeTallies, type NurseTally, type Tallies } from "./tallies";

export { dateLabel, dateTitle, isNewMonth, isNewYear, rosterSpanTitle } from "./date-span";

export { buildProvenanceView, type ProvenanceView } from "./provenance";

export {
  localCalendarDate,
  parseLens,
  readViewPreference,
  resolveFocusedDay,
  todayIndex,
  writeViewPreference,
  ROSTER_VIEW_PREFERENCE_KEY,
  type RosterLensName,
  type RosterViewPreference,
} from "./view-preference";
