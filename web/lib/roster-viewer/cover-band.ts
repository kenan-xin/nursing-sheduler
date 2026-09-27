// The roster's "Temporary cover" band rows (d582, spec §4 "Display rows").
//
// A cover is never a solver person, so she is never on the person axis: no
// `personIdx`, no edits, no rule check, no tallies, no swaps. The band is a
// DISPLAY plane below the staff rows — one row per cover name, her shift chip on
// her dates and nothing at all anywhere else (not even the rest `·`).
//
// The rows are the union of what the solve counted (`RosterDocument.cover.entries`,
// roster-file/2) and what the scenario holds RIGHT NOW, so the band states the
// same disagreement the coverage numbers do:
//
//   • in both                      → `solved`
//   • live only                    → `not-optimized` (the roster has not planned
//                                    around her yet)
//   • counted only (no longer live) → `removed` (the roster still carries her
//                                    until the next run)
//
// One name with slots in both directions resolves to `not-optimized`: nothing is
// struck through that the roster actually still carries, and the invitation is
// the same one — run Optimize again.

import type { RosterCalendarDay, RosterCoverEntry } from "@/lib/roster/types";
import type { ShiftTypeId, UiTemporaryCover } from "@/lib/scenario";

/** How a band row stands against the roster it is shown on. */
export type CoverBandStatus = "solved" | "not-optimized" | "removed";

/** One row of the band. */
export interface CoverBandRow {
  /** The cover name, verbatim — the row's identity and its only label. */
  readonly name: string;
  /** Parallel to the calendar: her shift id on her dates, `null` everywhere else. */
  readonly cells: readonly (ShiftTypeId | null)[];
  readonly status: CoverBandStatus;
}

/** One (name, date) slot, with where it was seen. */
interface CoverSlot {
  readonly iso: string;
  shiftId: string;
  inEntry: boolean;
  inLive: boolean;
}

/**
 * Build the band rows from the solved cover entries, the live scenario covers and
 * the roster calendar. Pure: no document state is read or written.
 *
 * A name may hold at most one cover per date (the Staff form refuses a second),
 * so a slot is keyed by `(name, date)`; if a hand-edited scenario ever held two,
 * the scenario's own value wins — it is the truth right now.
 */
export function coverBandRows(
  entries: readonly RosterCoverEntry[],
  live: readonly UiTemporaryCover[],
  calendar: readonly RosterCalendarDay[],
): CoverBandRow[] {
  const byName = new Map<string, Map<string, CoverSlot>>();

  const add = (name: string, iso: string, shiftId: string, from: "entry" | "live"): void => {
    const slots = byName.get(name) ?? new Map<string, CoverSlot>();
    byName.set(name, slots);
    const existing = slots.get(iso);
    if (existing === undefined) {
      slots.set(iso, { iso, shiftId, inEntry: from === "entry", inLive: from === "live" });
      return;
    }
    if (from === "live") {
      existing.shiftId = shiftId;
      existing.inLive = true;
    } else {
      existing.inEntry = true;
    }
  };

  for (const item of entries) add(item.name, item.iso, String(item.shiftId), "entry");
  for (const cover of live) add(cover.name, cover.date, String(cover.shiftType), "live");

  const dateIndex = new Map(calendar.map((day, dateIdx) => [day.iso, dateIdx]));

  return [...byName.entries()]
    .map(([name, slots]) => {
      const list = [...slots.values()];
      const cells: (ShiftTypeId | null)[] = calendar.map(() => null);
      for (const slot of list) {
        const dateIdx = dateIndex.get(slot.iso);
        if (dateIdx !== undefined) cells[dateIdx] = slot.shiftId;
      }
      // A slot outside the roster's own period has no column to sit in. Her row
      // is still shown: hiding a cover the scenario holds would be a silent lie.
      const liveOnly = list.some((slot) => slot.inLive && !slot.inEntry);
      const entryOnly = list.some((slot) => slot.inEntry && !slot.inLive);
      const status: CoverBandStatus = liveOnly ? "not-optimized" : entryOnly ? "removed" : "solved";
      return { name, cells, status, firstIso: list.map((slot) => slot.iso).sort()[0] };
    })
    .sort((left, right) =>
      left.firstIso < right.firstIso
        ? -1
        : left.firstIso > right.firstIso
          ? 1
          : left.name.localeCompare(right.name),
    )
    .map(({ name, cells, status }) => ({ name, cells, status }));
}
