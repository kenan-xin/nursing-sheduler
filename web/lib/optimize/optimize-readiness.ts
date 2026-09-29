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

import { hasUnsupportedExpression } from "@/components/card-editor/expression-model";
import { cardsReferencing } from "@/lib/cascade";
import type { ScenarioUiState } from "@/lib/scenario/types";

/** One required-data gap, rendered as "<before><link><after>" with a tab link. */
export interface OptimizeReadinessIssue {
  kind: "dates" | "people" | "shift-types" | "empty-shift-groups" | "shift-counts";
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
  "staff" | "shifts" | "shiftGroups" | "rangeStart" | "rangeEnd" | "cardsByKind"
> & { counts: readonly ReadinessCount[] };

/** The count-card fields the unsupported-expression gate reads. */
export interface ReadinessCount {
  expression: string | readonly string[];
  disabled?: boolean;
}

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

const UNSUPPORTED_EXPRESSION_ISSUE: OptimizeReadinessIssue = {
  kind: "shift-counts",
  before: "A shift count rule uses an expression that isn't supported. Edit it on the ",
  linkLabel: "Shift Counts",
  href: "/shift-counts",
  after: " page before optimising.",
};

/** The one sentence for an unsupported count expression: the import warning, the
 *  readiness banner line and the Optimize disabled reason all read exactly this. */
export const UNSUPPORTED_EXPRESSION_REASON = `${UNSUPPORTED_EXPRESSION_ISSUE.before}${UNSUPPORTED_EXPRESSION_ISSUE.linkLabel}${UNSUPPORTED_EXPRESSION_ISSUE.after}`;

/** Whether an ENABLED count uses an expression core rejects (a disabled card is
 *  dropped from the submission, so it cannot fail the run). */
export function hasBlockingUnsupportedExpression(counts: readonly ReadinessCount[]): boolean {
  return counts.some((card) => !card.disabled && hasUnsupportedExpression(card.expression));
}

/**
 * Derive the required-data readiness of a scenario. Dates are missing when either
 * range endpoint is blank; people are missing when there are no staff; shift types
 * are missing when there are neither shift types nor shift-type groups. Issues are
 * returned in the old app's priority order (dates → people → shift types), then an
 * enabled shift count with an expression core does not support (wa46).
 */
export function deriveOptimizeReadiness(source: OptimizeReadinessSource): OptimizeReadiness {
  const issues: OptimizeReadinessIssue[] = [];

  if (!source.rangeStart || !source.rangeEnd) issues.push(DATES_ISSUE);
  if (source.staff.length === 0) issues.push(PEOPLE_ISSUE);
  if (source.shifts.length === 0 && source.shiftGroups.length === 0) {
    issues.push(SHIFT_TYPES_ISSUE);
  }
  // Core rejects a rule whose shift group resolves to nothing (T3), so an enabled
  // rule naming an empty shift group would fail the run with a raw backend message.
  const emptyUsed = source.shiftGroups
    .filter(
      (group) =>
        group.members.length === 0 &&
        cardsReferencing(source.cardsByKind, "shift", group.id).some((card) => !card.disabled),
    )
    .map((group) => `“${group.id}”`);
  if (emptyUsed.length > 0) {
    issues.push({
      kind: "empty-shift-groups",
      before: `A rule uses an empty shift group (${emptyUsed.join(", ")}). Add shifts to it on the `,
      linkLabel: "Shifts",
      href: "/shift-types",
      after: " page, or take it out of the rule.",
    });
  }
  if (hasBlockingUnsupportedExpression(source.counts)) issues.push(UNSUPPORTED_EXPRESSION_ISSUE);

  return { ready: issues.length === 0, issues };
}
