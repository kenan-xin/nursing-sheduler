// Borrowed rows (roster-file/2, bead g1p): a temporary nurse on a solved roster.
//
// A borrowed row extends the person axis after the submitted people. Everything that
// reads the roster by person index reads THIS axis: `rosterAxisContext` for the
// people, `rosterCurrentDays` for the cells. `rosterBaseDays` is what the overlay is
// normalized against, so a borrowed cell edit is an ordinary edit (one undo step, one
// autosave revision) and "set it back" clears it, as for a solved cell.

import { checkExactFields } from "./container";
import { parseSubmissionDocument } from "./context";
import { isRosterDayState, isTypedId, typedIdKey } from "./day-state";
import { freezeDayState } from "./immutable";
import { deriveCurrentDays } from "./overlay";
import type {
  RosterBorrowedRow,
  RosterContext,
  RosterContextPerson,
  RosterDayGrid,
  RosterDocument,
  RosterSubmission,
} from "./types";

/** Solved rows then borrowed rows: the base every overlay entry is measured against. */
export function rosterBaseDays(
  document: Pick<RosterDocument, "solvedDays" | "borrowed">,
): RosterDayGrid {
  return document.borrowed.length === 0
    ? document.solvedDays
    : [...document.solvedDays, ...document.borrowed.map((row) => row.days)];
}

/** The current assignments on the whole axis: base plus overlay. */
export function rosterCurrentDays(
  document: Pick<RosterDocument, "solvedDays" | "borrowed" | "edits">,
): RosterDayGrid {
  return deriveCurrentDays(rosterBaseDays(document), document.edits);
}

/** The context with borrowed people appended to `people`: the roster's full person axis. */
export function rosterAxisContext(
  document: Pick<RosterDocument, "context" | "borrowed">,
): RosterContext {
  if (document.borrowed.length === 0) return document.context;
  const borrowed = document.borrowed.map(
    ({ id, description }): RosterContextPerson =>
      description === undefined ? { id, temporary: true } : { id, description, temporary: true },
  );
  return { ...document.context, people: [...document.context.people, ...borrowed] };
}

/** The document with extra borrowed rows appended. Validation is the caller's. */
export function withBorrowedRows(
  document: RosterDocument,
  rows: readonly RosterBorrowedRow[],
): RosterDocument {
  return rows.length === 0 ? document : { ...document, borrowed: [...document.borrowed, ...rows] };
}

/**
 * The staff-group ids the roster's OWN scenario declares, or `null` when its
 * submission cannot be read (bead nursing-sheduler-6yn).
 *
 * A borrowed row's `groups` must be a subset of these. The staffing model
 * (`lib/roster-viewer/requirements.ts`, `withBorrowedPeople`) adds her to exactly
 * the groups the SUBMITTED scenario has, so an id it does not carry is silently
 * ignored: she is counted nowhere and reads as unqualified, while her row and her
 * shifts look ordinary. Group ids survive the Optimize submission's people-only
 * anonymization (`people: true, groups: false`), so the submission is the
 * authority — not the live scenario, which may have moved on since the solve.
 */
export function scenarioStaffGroupIds(
  submission: Pick<RosterSubmission, "canonicalYaml">,
): ReadonlySet<string> | null {
  const parsed = parseSubmissionDocument(submission.canonicalYaml);
  if (!parsed.ok) return null;
  return new Set((parsed.document.people.groups ?? []).map((group) => String(group.id)));
}

const ROW_FIELDS = ["id", "groups", "days"] as const;

/** Validate `borrowed` against the document's axes. Returns fresh frozen rows. */
export function checkBorrowedRows(
  value: unknown,
  axes: {
    people: readonly RosterContextPerson[];
    dateCount: number;
    shiftIds: ReadonlySet<string>;
  },
): { ok: true; borrowed: readonly RosterBorrowedRow[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: "borrowed is not an array" };
  const taken = new Set(axes.people.map((person) => typedIdKey(person.id)));
  const rows: RosterBorrowedRow[] = [];
  for (let index = 0; index < value.length; index++) {
    const label = `borrowed[${index}]`;
    const entry: unknown = value[index];
    const hasDescription = typeof entry === "object" && entry !== null && "description" in entry;
    const shape = checkExactFields(
      entry,
      hasDescription ? [...ROW_FIELDS, "description"] : ROW_FIELDS,
      label,
    );
    if (!shape.ok) return shape;
    const { id, description, groups, days } = shape.record;
    if (!isTypedId(id)) return { ok: false, reason: `${label}.id is not a usable typed id` };
    if (taken.has(typedIdKey(id))) {
      return { ok: false, reason: `${label}.id ${String(id)} is already on the roster` };
    }
    taken.add(typedIdKey(id));
    if (hasDescription && typeof description !== "string") {
      return { ok: false, reason: `${label}.description is not a string` };
    }
    if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string" && g.length > 0)) {
      return { ok: false, reason: `${label}.groups is not a list of group ids` };
    }
    if (!Array.isArray(days) || days.length !== axes.dateCount) {
      const count = Array.isArray(days) ? days.length : 0;
      return { ok: false, reason: `${label} has ${count} days for ${axes.dateCount} dates` };
    }
    for (let dateIdx = 0; dateIdx < days.length; dateIdx++) {
      const day: unknown = days[dateIdx];
      if (!isRosterDayState(day)) {
        return { ok: false, reason: `${label}.days[${dateIdx}] is not exactly one day-state` };
      }
      if (day.kind === "shift" && !axes.shiftIds.has(typedIdKey(day.shiftId))) {
        return {
          ok: false,
          reason: `${label}.days[${dateIdx}] names unknown shift type ${String(day.shiftId)}`,
        };
      }
    }
    rows.push(
      Object.freeze({
        id,
        ...(hasDescription ? { description: description as string } : {}),
        groups: Object.freeze([...(groups as string[])]),
        days: Object.freeze((days as RosterBorrowedRow["days"]).map(freezeDayState)),
      }),
    );
  }
  return { ok: true, borrowed: Object.freeze(rows) };
}
