// What the assistant reads and shows for "based on my September schedule, create
// November" (plq5 P3). Pure: the tools and the card render these, and the tests pin
// the wording. The derivation itself is the host's (`lib/proposal/new-period.ts`).

import { deriveCurrentDays } from "@/lib/roster/overlay";
import { dayCode } from "@/lib/roster-viewer/rule-check";
import { personName } from "@/lib/roster-viewer/swap";
import { proposalDigest, type NewPeriodPlan, type PastRoster } from "@/lib/proposal";
import { schedulePeriod, type ScenarioUiState } from "@/lib/scenario";

/**
 * The model's handle on a schedule: short, opaque and stable across page loads, so a
 * ref from earlier in the conversation still names the same schedule. Never the id.
 */
export function scheduleRef(scenarioId: string): string {
  return `sch-${proposalDigest(scenarioId).slice(0, 8)}`;
}

/** Days of each person's roster tail the summary shows. */
const TAIL_DAYS = 7;

export interface PastRosterSummary {
  period: { start: string; end: string };
  rows: { person: string; totals: Record<string, number>; lastDays: string[] }[];
}

/** Each person's shift totals and last 7 days, hand edits applied. */
export function summarizePastRoster(roster: PastRoster): PastRosterSummary {
  const days = deriveCurrentDays(roster.solvedDays, roster.edits);
  const isos = roster.context.calendar.map((day) => day.iso);
  return {
    period: { start: isos[0] ?? "", end: isos.at(-1) ?? "" },
    rows: roster.context.people.map((_person, idx) => {
      const codes = (days[idx] ?? []).map(dayCode);
      const totals: Record<string, number> = {};
      for (const code of codes) totals[code] = (totals[code] ?? 0) + 1;
      return {
        person: personName(roster.context, idx),
        totals,
        lastDays: codes.slice(-TAIL_DAYS),
      };
    }),
  };
}

/** The card's sentences. Counts and names only; the user reviews, then presses Create. */
export interface NewPeriodView {
  sourceName: string;
  newName: string;
  copied: string;
  holidays: string;
  history: string;
  /** `null` when the past schedule had no requests, leave or covers. */
  notCarried: string | null;
  /** One line per rule, date group or date exception the move dropped or narrowed. */
  dropped: string[];
  outcome: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildNewPeriodView(
  source: { name: string; scenario: ScenarioUiState },
  plan: NewPeriodPlan,
  newName: string,
): NewPeriodView {
  const next = plan.scenario;
  const rules = Object.values(next.cardsByKind).reduce((sum, cards) => sum + cards.length, 0);
  const newPeriod = schedulePeriod(next.rangeStart, next.rangeEnd);
  const pastPeriod = schedulePeriod(source.scenario.rangeStart, source.scenario.rangeEnd);
  const { history, notCarried } = plan;
  const left = [
    notCarried.requests > 0 ? plural(notCarried.requests, "request") : null,
    notCarried.leave > 0 ? plural(notCarried.leave, "leave day") : null,
    notCarried.covers > 0 ? plural(notCarried.covers, "temporary cover") : null,
  ].filter((part): part is string => part !== null);
  return {
    sourceName: source.name,
    newName,
    copied:
      `Copies ${plural(next.staff.length, "person", "people")}, ` +
      `${plural(next.shifts.length, "shift type")} and ${plural(rules, "rule")} ` +
      `from “${source.name}”, for ${newPeriod}.`,
    holidays: `Singapore public holidays are marked for ${newPeriod}.`,
    history:
      history.status === "carried"
        ? `Rest history: the last ${history.days} days of ${pastPeriod}'s roster, for ` +
          `${plural(history.people, "person", "people")}.`
        : history.status === "gap"
          ? `${newPeriod} does not follow straight after ${pastPeriod}, so no rest history was carried.`
          : `“${source.name}” has no saved roster, so no rest history was carried.`,
    notCarried:
      left.length > 0
        ? `Not copied: ${left.join(", ")}. Add them for ${newPeriod} if they still apply.`
        : null,
    dropped: plan.dropped.map(
      (entry) => `${entry.label}: ${entry.before ?? "none"} → ${entry.after ?? "removed"}`,
    ),
    outcome:
      `Creates “${newName}” and opens it. “${source.name}” is kept, with this ` +
      `conversation; the chat moves to “${newName}” and starts fresh.`,
  };
}
