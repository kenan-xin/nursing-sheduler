// Which schedule's roster (plq5 P2). Each saved schedule keeps its own roster, so a
// roster flow picks its storage ONCE, when it starts, and keeps it: an autosave or a
// promotion that began on one schedule must land there even if the tab has switched
// since.

import { useAuthorityStore } from "./authority";
import { rosterStorage, type RosterStorage } from "./roster-storage";

/**
 * The roster storage of one schedule. `null` (no schedule selected: the dev fixtures
 * and tests that never bring an authority up) is the unscoped origin-wide slot.
 */
export function rosterStorageFor(scenarioId: string | null): RosterStorage {
  return scenarioId === null ? rosterStorage : rosterStorage.forScenario(scenarioId);
}

/** The roster storage of the schedule this tab has open right now. */
export function currentRosterStorage(): RosterStorage {
  return rosterStorageFor(useAuthorityStore.getState().scenarioId);
}
