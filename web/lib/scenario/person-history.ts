// Person history is right-anchored (FR-RI-09): the last entry is the day before
// the schedule starts, and succession matching only consults suffixes of it. An
// entry the schedule can no longer explain therefore makes every OLDER entry
// unusable as well, because no suffix reaching them avoids it. Dropping the entry
// instead of blanking it would shift the remaining days, and keeping a blank would
// emit a history value the producer and core reject (`Unknown shift type ID in
// history: ''`), so the usable suffix is what survives.
//
// Two callers share this rule: the delete cascade (an id being deleted) and the
// import path (a blank slot an earlier build's deletion left behind). One
// definition, so the two can never drift.

/** The empty-history sentinel a pre-D7 shift-type delete left in place of the id. */
export const BLANK_HISTORY_ENTRY = "";

/**
 * Keep only the entries NEWER than the newest entry `isUnusable` accepts, or the
 * whole history when every entry is usable. Returns a fresh array; the input is
 * never mutated.
 */
export function truncateHistoryAfterUnusable(
  history: readonly string[],
  isUnusable: (entry: string) => boolean,
): string[] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (isUnusable(history[index])) return history.slice(index + 1);
  }
  return [...history];
}

/** Repair the blank slots an earlier build's shift-type deletion left in history. */
export function truncateHistoryAtBlankEntries(history: readonly string[]): string[] {
  return truncateHistoryAfterUnusable(history, (entry) => entry === BLANK_HISTORY_ENTRY);
}
