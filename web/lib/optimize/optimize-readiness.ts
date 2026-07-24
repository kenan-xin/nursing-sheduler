// T16e — required-data readiness for the Optimize & Export screen.
//
// A pure projection of the durable scenario state into the old application's
// required-data gate: a run needs a roster date range, at least one person, and
// at least one shift type (or shift-type group). This mirrors the old page's
// `isDateDataMissing` / `isPeopleDataMissing` / `isShiftTypeDataMissing` flags and
// their exact tab-link copy, so the screen can block submission and point the user
// at the right editor before any request is sent. The controller's `submit()`
// still runs the authoritative strict-projection gate; this only surfaces the
// missing-data reasons early.

import type { ScenarioUiState } from "@/lib/scenario/types";

/** One required-data gap, rendered as "<before><link><after>" with a tab link. */
export interface OptimizeReadinessIssue {
  kind: "dates" | "people" | "shift-types";
  before: string;
  linkLabel: string;
  href: string;
  after: string;
}

export interface OptimizeReadiness {
  /** True only when every required-data gap is filled. */
  ready: boolean;
  issues: OptimizeReadinessIssue[];
}

/** The scenario fields the readiness gate reads (kept narrow for testability). */
export type OptimizeReadinessSource = Pick<
  ScenarioUiState,
  "staff" | "shifts" | "shiftGroups" | "rangeStart" | "rangeEnd"
>;

const DATES_ISSUE: OptimizeReadinessIssue = {
  kind: "dates",
  before: "Please set up your dates first by visiting the ",
  linkLabel: "Dates",
  href: "/dates",
  after: " tab.",
};

const PEOPLE_ISSUE: OptimizeReadinessIssue = {
  kind: "people",
  before: "Please set up your people first by visiting the ",
  // Label matches the nav destination name (NAV-1 override: People→Staff). Route unchanged.
  linkLabel: "Staff",
  href: "/people",
  after: " tab.",
};

const SHIFT_TYPES_ISSUE: OptimizeReadinessIssue = {
  kind: "shift-types",
  before: "Please set up your shift types first by visiting the ",
  // Label matches the nav destination name (NAV-1 override: Shift Types→Shifts). Route unchanged.
  linkLabel: "Shifts",
  href: "/shift-types",
  after: " tab.",
};

/**
 * Derive the required-data readiness of a scenario. Dates are missing when either
 * range endpoint is blank; people are missing when there are no staff; shift types
 * are missing when there are neither shift types nor shift-type groups. Issues are
 * returned in the old app's priority order (dates → people → shift types).
 */
export function deriveOptimizeReadiness(source: OptimizeReadinessSource): OptimizeReadiness {
  const issues: OptimizeReadinessIssue[] = [];

  if (!source.rangeStart || !source.rangeEnd) issues.push(DATES_ISSUE);
  if (source.staff.length === 0) issues.push(PEOPLE_ISSUE);
  if (source.shifts.length === 0 && source.shiftGroups.length === 0) {
    issues.push(SHIFT_TYPES_ISSUE);
  }

  return { ready: issues.length === 0, issues };
}
