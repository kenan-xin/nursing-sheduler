// A new period from a past schedule (plq5 P3): "based on my September schedule, create
// November". One pure transform the assistant's Preview and the Apply both run, so the
// schedule the user reviewed is the one Apply creates (Apply compares digests).
//
// Copied as-is: people, groups, shift types, rules and the export layout. Moved: the
// roster period, through the SAME `set_roster_range` arm the assistant's ordinary range
// change uses (and so `applyRangeChange`, the Dates screen's own cascade), with the
// Singapore holidays imported for the new range. Not carried: requests, leave and
// temporary cover, which belong to the month they were made for. Replaced: every
// person's rest history, taken from the past roster's last days when the new period
// starts the day after that roster ends.

import {
  isoToUtcMs,
  SINGAPORE_NONWORKDAY_GROUP_ID,
  SINGAPORE_PH_GROUP_ID,
  SINGAPORE_WORKDAY_GROUP_ID,
} from "@/lib/dates";
import { deriveCurrentDays } from "@/lib/roster/overlay";
import type { RosterDayState, RosterDocument } from "@/lib/roster/types";
import { truncateHistoryAfterUnusable } from "@/lib/scenario/person-history";
import type { ScenarioUiState, UiPerson } from "@/lib/scenario";
import { diffScenarioDocuments, type ProposalDiffEntry } from "./diff";
import { proposalDigest } from "./digest";
import { applyAssistantCommand } from "./operations";

/** History is carried for at least this many days (user decision 2026-09-30). */
export const MIN_HISTORY_DAYS = 7;

/** What of the past roster the derivation reads. */
export type PastRoster = Pick<RosterDocument, "context" | "solvedDays" | "edits">;

/** Why history was or was not carried. */
export type HistoryStatus = "carried" | "no-roster" | "gap";

export interface NewPeriodPlan {
  scenario: ScenarioUiState;
  /** What the move to the new dates dropped or narrowed (rules, date groups, overrides). */
  dropped: ProposalDiffEntry[];
  /** Requests (leave included) and temporary covers left behind with the past schedule. */
  notCarried: { requests: number; leave: number; covers: number };
  history: {
    status: HistoryStatus;
    /** Days of history taken per person: the longest rule look-back, at least 7. */
    days: number;
    /** People who got any history. */
    people: number;
    /** The past roster's last day, or `null` with no roster. */
    rosterEnd: string | null;
  };
  /** Identity of `scenario`: Apply refuses when re-deriving gives another one. */
  digest: string;
}

export type NewPeriodResult = { ok: true; plan: NewPeriodPlan } | { ok: false; message: string };

/**
 * The longest look-back any rule needs. Only a shift-sequence rule reads history, and
 * the solver matches up to its whole pattern against it (`preference_types.py`).
 */
export function historyDaysFor(scenario: Pick<ScenarioUiState, "cardsByKind">): number {
  return Math.max(
    MIN_HISTORY_DAYS,
    ...scenario.cardsByKind.successions.map((card) => card.pattern.length),
  );
}

/** The day after `iso`. */
export function nextDay(iso: string): string {
  return new Date(isoToUtcMs(iso) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Not a drop: the range itself, and the holiday import that rebuilds its own groups for
 * the new dates (the card says that in its own line).
 */
const MOVED = new Set([
  "dates:range",
  "dates:holiday-import",
  ...[SINGAPORE_WORKDAY_GROUP_ID, SINGAPORE_NONWORKDAY_GROUP_ID, SINGAPORE_PH_GROUP_ID].map(
    (id) => `dategroup:${id}`,
  ),
]);

/** A roster day as a history entry: the only tokens the core takes besides shift ids. */
function historyCode(day: RosterDayState): string {
  if (day.kind === "shift") return String(day.shiftId);
  return day.kind === "off" ? "OFF" : "LEAVE";
}

function withHistory(person: UiPerson, history: string[]): UiPerson {
  const { history: _past, ...rest } = person;
  return history.length > 0 ? { ...rest, history } : rest;
}

export function deriveNewPeriod(
  past: ScenarioUiState,
  roster: PastRoster | null,
  range: { start: string; end: string },
): NewPeriodResult {
  // The past schedule's own history describes the days before ITS start: never reused.
  const base: ScenarioUiState = {
    ...past,
    staff: past.staff.map((person) => withHistory(person, [])),
    reqData: [],
    temporaryCover: [],
  };
  const moved = applyAssistantCommand(base, {
    type: "set_roster_range",
    start: range.start,
    end: range.end,
    importPublicHolidays: true,
  });
  if (!moved.ok) return { ok: false, message: moved.rejection.message };

  const days = historyDaysFor(moved.next);
  const rosterEnd = roster?.context.calendar.at(-1)?.iso ?? null;
  const status: HistoryStatus =
    roster === null || rosterEnd === null
      ? "no-roster"
      : nextDay(rosterEnd) === range.start
        ? "carried"
        : "gap";

  let staff = moved.next.staff;
  let people = 0;
  if (status === "carried" && roster) {
    const current = deriveCurrentDays(roster.solvedDays, roster.edits);
    const rowOf = new Map(roster.context.people.map((person, idx) => [String(person.id), idx]));
    const shiftIds = new Set(moved.next.shifts.map((shift) => String(shift.id)));
    const unusable = (entry: string) =>
      entry !== "OFF" && entry !== "LEAVE" && !shiftIds.has(entry);
    staff = staff.map((person) => {
      const row = rowOf.get(String(person.id));
      if (row === undefined || !current[row]) return person;
      const tail = current[row].slice(-days).map(historyCode);
      const history = truncateHistoryAfterUnusable(tail, unusable);
      if (history.length > 0) people += 1;
      return withHistory(person, history);
    });
  }

  const scenario = { ...moved.next, staff };
  return {
    ok: true,
    plan: {
      scenario,
      dropped: diffScenarioDocuments(base, moved.next).filter((entry) => !MOVED.has(entry.key)),
      notCarried: {
        requests: past.reqData.filter((cell) => cell.kind !== "leave").length,
        leave: past.reqData.filter((cell) => cell.kind === "leave").length,
        covers: past.temporaryCover.length,
      },
      history: { status, days, people, rosterEnd },
      digest: proposalDigest(scenario),
    },
  };
}
