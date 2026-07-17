"use client";

// Scenario summary selectors (T08 Home rebuild). One place derives every
// dashboard/navigation number from the real durable scenario store, so the
// Guided Home stat strip, the six status-aware workflow cards, the progress
// meter, and the sidebar row counts all agree and never drift.
//
// DL10: there is NO per-person role/seniority field. The prototype's "5 Seniors"
// tile is backed here by a people-GROUP metric — the distinct membership of any
// staff group whose id/description reads as "senior" — which is fully
// backend-representable (people groups project to `people.groups`) and revives no
// `Person.seniority` field. When no such group exists the count is simply 0.
//
// Readiness models PREREQUISITES only (the five setup steps). Step completion for
// the sixth step (Generate) is NOT a scenario-store fact — a roster is only "done"
// once an optimize run has actually produced output — so it is intentionally
// absent here and resolved from run state at the card layer (home-guided.tsx).
// Dates counts as a prerequisite only when the committed range is genuinely valid
// (well-formed ISO, start <= end), reusing the canonical T10 range check — never
// merely "non-empty".

import { useMemo } from "react";
import { useScenarioStore } from "@/lib/store";
import { hasCompleteRange, rangeDayCount } from "@/lib/dates";
import { isValidIso } from "@/lib/dates/date-id";
import type { NavCountKey } from "@/components/shell/nav-config";
import type { ScenarioUiState } from "@/lib/scenario";

/** The scenario fields the summary is derived from (the rest is irrelevant here). */
type SummaryInput = Pick<
  ScenarioUiState,
  | "staff"
  | "staffGroups"
  | "shifts"
  | "reqData"
  | "cardsByKind"
  | "exportLayout"
  | "rangeStart"
  | "rangeEnd"
>;

/** Per-step readiness for the five SETUP prerequisites (Generate is not here). */
export interface StepReadiness {
  dates: boolean;
  people: boolean;
  shiftTypes: boolean;
  rules: boolean;
  requests: boolean;
}

export interface ScenarioSummary {
  peopleCount: number;
  staffGroupsCount: number;
  seniorsCount: number;
  shiftTypesCount: number;
  shiftRequestsCount: number;
  rulesTotal: number;
  ruleCounts: {
    requirements: number;
    successions: number;
    shiftCounts: number;
    affinities: number;
    coverings: number;
  };
  exportRulesCount: number;
  /** Inclusive day span of the range, 0 when the range is invalid/unset. */
  durationDays: number;
  /** e.g. "February 2026", derived from a valid range start; `null` otherwise. */
  rosterMonthLabel: string | null;
  /** Per-step readiness for the five setup prerequisites. */
  ready: StepReadiness;
  /** Whether all five setup prerequisites are satisfied (Generate is ready to run). */
  prerequisitesMet: boolean;
}

/** Long month + year for a valid range start (`"February 2026"`), else `null`. */
function rosterMonthLabel(rangeStart: string): string | null {
  if (!isValidIso(rangeStart)) return null;
  return new Date(`${rangeStart}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Distinct people referenced by any staff group whose id/description reads "senior". */
function seniorsGroupCount(state: SummaryInput): number {
  const senior = /senior/i;
  const members = new Set<string>();
  for (const group of state.staffGroups) {
    if (senior.test(String(group.id)) || (group.description && senior.test(group.description))) {
      for (const member of group.members) members.add(String(member));
    }
  }
  return members.size;
}

/** Derive the full summary from a durable scenario slice. Pure. */
export function computeScenarioSummary(state: SummaryInput): ScenarioSummary {
  const cards = state.cardsByKind;
  const ruleCounts = {
    requirements: cards.requirements.length,
    successions: cards.successions.length,
    shiftCounts: cards.counts.length,
    affinities: cards.affinities.length,
    coverings: cards.coverings.length,
  };
  const rulesTotal =
    ruleCounts.requirements +
    ruleCounts.successions +
    ruleCounts.shiftCounts +
    ruleCounts.affinities +
    ruleCounts.coverings;
  const exportRulesCount =
    state.exportLayout.formatting.length +
    state.exportLayout.extraColumns.length +
    state.exportLayout.extraRows.length;

  // Dates is a prerequisite only when the committed range is genuinely valid
  // (canonical T10 check) — a reversed/malformed/non-empty-but-invalid range does
  // NOT count as done.
  const range = { start: state.rangeStart, end: state.rangeEnd };
  const ready: StepReadiness = {
    dates: hasCompleteRange(range),
    people: state.staff.length > 0,
    shiftTypes: state.shifts.length > 0,
    rules: rulesTotal > 0,
    requests: state.reqData.length > 0,
  };
  const prerequisitesMet =
    ready.dates && ready.people && ready.shiftTypes && ready.rules && ready.requests;

  return {
    peopleCount: state.staff.length,
    staffGroupsCount: state.staffGroups.length,
    seniorsCount: seniorsGroupCount(state),
    shiftTypesCount: state.shifts.length,
    shiftRequestsCount: state.reqData.length,
    rulesTotal,
    ruleCounts,
    exportRulesCount,
    durationDays: rangeDayCount(range),
    rosterMonthLabel: rosterMonthLabel(state.rangeStart),
    ready,
    prerequisitesMet,
  };
}

// Reactive summary hook. Each field is selected individually so its reference is
// stable across unrelated store writes (a fresh-object selector would loop under
// zustand v5's Object.is comparison); the summary is memoized on those refs.
export function useScenarioSummary(): ScenarioSummary {
  const staff = useScenarioStore((s) => s.staff);
  const staffGroups = useScenarioStore((s) => s.staffGroups);
  const shifts = useScenarioStore((s) => s.shifts);
  const reqData = useScenarioStore((s) => s.reqData);
  const cardsByKind = useScenarioStore((s) => s.cardsByKind);
  const exportLayout = useScenarioStore((s) => s.exportLayout);
  const rangeStart = useScenarioStore((s) => s.rangeStart);
  const rangeEnd = useScenarioStore((s) => s.rangeEnd);
  return useMemo(
    () =>
      computeScenarioSummary({
        staff,
        staffGroups,
        shifts,
        reqData,
        cardsByKind,
        exportLayout,
        rangeStart,
        rangeEnd,
      }),
    [staff, staffGroups, shifts, reqData, cardsByKind, exportLayout, rangeStart, rangeEnd],
  );
}

/** Resolve a nav row's live count badge value from the summary (0 hides the badge). */
export function navCountFor(summary: ScenarioSummary, key: NavCountKey): number {
  switch (key) {
    case "people":
      return summary.peopleCount;
    case "shiftTypes":
      return summary.shiftTypesCount;
    case "shiftRequests":
      return summary.shiftRequestsCount;
    case "requirements":
      return summary.ruleCounts.requirements;
    case "successions":
      return summary.ruleCounts.successions;
    case "shiftCounts":
      return summary.ruleCounts.shiftCounts;
    case "affinities":
      return summary.ruleCounts.affinities;
    case "coverings":
      return summary.ruleCounts.coverings;
    case "exportRules":
      return summary.exportRulesCount;
  }
}
