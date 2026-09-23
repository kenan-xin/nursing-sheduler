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
//   • COVERAGE HAS TWO PLANES. `requirements` projects the scenario's real
//     staffing EQUATIONS from the immutable submission, mirroring the backend's
//     grouping, dates, qualification and coefficients; `coverage` reports who is
//     actually on each EXACT shift. A group minimum is never divided across its
//     members, and an exact lane carries a target only where the scenario
//     declares one for that single shift. Both recompute live on edits.
//   • TALLIES ARE INFORMATIONAL. Per-nurse shift-type counts, OFF/leave days and
//     weekend rest. No red/error semantics and no hours metric.
//   • PROVENANCE IS FROZEN. Solver status + score are labeled "as solved" and
//     never recomputed after edits. "edited since solve" is derived from the
//     overlay, never independently mutable.
//   • THE RAMP IS A 4-FAMILY CLASSIFIER. Every worked shift is assigned to one
//     of Morning/Evening/Night/Long day by its own `startTime` and duration
//     (`classifyShiftFamily`), never by its position or its id string; two ids
//     sharing a family colour is intentional. Leave is neutral; rest is a bare
//     dot. Literal hexes, not tokens.
//   • UNKNOWN IS NOT HEALTHY. An `unavailable` lane is the absence of evidence,
//     so summaries scope their claim to what was checkable and day health has a
//     distinct `unknown` state. Nothing turns "we could not check" into "fine".

export {
  assignShiftRamp,
  classifyShiftFamily,
  SHIFT_FAMILY_GLYPH,
  SHIFT_FAMILY_LABEL,
  SHIFT_FAMILY_ORDER,
  SHIFT_FAMILY_RAMP,
  SHIFT_RAMP,
  type ShiftFamily,
  type ShiftRampEntry,
} from "./shift-ramp";

export {
  computeCoverage,
  uniformShiftRequirement,
  type CoverageGrid,
  type DayCoverage,
  type ShiftCoverage,
} from "./coverage";

export {
  buildAssignmentIndex,
  buildEquations,
  computeRequirementGrid,
  deriveRequirementModel,
  evaluateRequirementCell,
  exactShiftRequirement,
  requirementDayHealth,
  summariseRequirements,
  type RequirementCell,
  type RequirementEquation,
  type RequirementGrid,
  type RequirementHealth,
  type RequirementModel,
  type RequirementSummary,
  type RosterAssignmentIndex,
} from "./requirements";

export { computeTallies, type NurseTally, type Tallies } from "./tallies";

export {
  dateLabel,
  dateTitle,
  dayOfMonth,
  isNewMonth,
  isNewYear,
  monthLabel,
  rosterSpanTitle,
} from "./date-span";

export { shiftContextLabel, shiftTimeRange } from "./shift-label";

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
