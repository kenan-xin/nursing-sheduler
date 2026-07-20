// Saved-state and normalized-import adapters into the shared uncredited-leave
// detector (qq0.23b, tech-plan §2). Both adapters snapshot the same scenario
// shape into `LeaveGuardInput`; neither implements policy — that lives entirely
// in `./detector`.

import { findUncreditedLeaveFindings, type UncreditedLeaveFinding } from "./detector";
import type {
  CountCard,
  CountCardBody,
  IsoDate,
  ImportCard,
  UiDateGroup,
  UiPeopleGroup,
  UiPerson,
  UiRequestCell,
  UiShiftType,
  UiShiftTypeGroup,
} from "../types";

/** The scenario entities shared by the saved-state and import snapshots. */
interface LeaveGuardScenarioSnapshot {
  staff: readonly UiPerson[];
  staffGroups: readonly UiPeopleGroup[];
  shifts: readonly UiShiftType[];
  shiftGroups: readonly UiShiftTypeGroup[];
  rangeStart: IsoDate;
  rangeEnd: IsoDate;
  dateGroups: readonly UiDateGroup[];
  reqData: readonly UiRequestCell[];
}

/** A saved-state snapshot: ordered, identified count cards from `cardsByKind.counts`. */
export interface SavedLeaveGuardSnapshot extends LeaveGuardScenarioSnapshot {
  counts: readonly CountCard[];
}

/** A normalized-import snapshot: keyless count bodies with no store-assigned identity. */
export interface ImportLeaveGuardSnapshot extends LeaveGuardScenarioSnapshot {
  counts: readonly ImportCard<CountCardBody>[];
}

/**
 * Evaluate a saved-state snapshot and immediately join every finding to the `uid`
 * at the same index in the same count snapshot — `isEnabled = !card.disabled`, per
 * tech-plan §2. The returned map exists only for this evaluation; callers must
 * never persist a `countIndex` or rejoin one after the counts array reorders —
 * call this again against the current snapshot instead.
 */
export function findSavedUncreditedLeaveFindings(
  snapshot: SavedLeaveGuardSnapshot,
): ReadonlyMap<string, UncreditedLeaveFinding> {
  const findings = findUncreditedLeaveFindings({
    staff: snapshot.staff,
    staffGroups: snapshot.staffGroups,
    shifts: snapshot.shifts,
    shiftGroups: snapshot.shiftGroups,
    rangeStart: snapshot.rangeStart,
    rangeEnd: snapshot.rangeEnd,
    dateGroups: snapshot.dateGroups,
    reqData: snapshot.reqData,
    counts: snapshot.counts.map((card) => ({ body: card, isEnabled: !card.disabled })),
  });

  const byUid = new Map<string, UncreditedLeaveFinding>();
  for (const finding of findings) {
    byUid.set(snapshot.counts[finding.countIndex].uid, finding);
  }
  return byUid;
}

/**
 * Evaluate a keyless normalized-import snapshot. Imported cards carry no `uid` and
 * no `disabled` flag, so every count is treated as enabled (`isEnabled = true`,
 * per tech-plan §2); the caller formats findings against the same input snapshot
 * by `countIndex` rather than by identity.
 */
export function findImportUncreditedLeaveFindings(
  snapshot: ImportLeaveGuardSnapshot,
): readonly UncreditedLeaveFinding[] {
  return findUncreditedLeaveFindings({
    staff: snapshot.staff,
    staffGroups: snapshot.staffGroups,
    shifts: snapshot.shifts,
    shiftGroups: snapshot.shiftGroups,
    rangeStart: snapshot.rangeStart,
    rangeEnd: snapshot.rangeEnd,
    dateGroups: snapshot.dateGroups,
    reqData: snapshot.reqData,
    counts: snapshot.counts.map((body) => ({ body, isEnabled: true })),
  });
}
