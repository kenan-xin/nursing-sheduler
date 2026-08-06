// The versioned scenario command union the repository can apply, plus the pure
// application function.
//
// SCOPE. T02 ships exactly the commands the existing live mutation surface needs,
// so T03's cutover has a target for every path it must retire: the generic patch
// (`mutateScenario`), the atomic matrix write (`setReqData`), the full-slice
// replacement (New/Load), and the metadata-only backup record (`recordBackup`).
// The richer domain union in the tech plan (`update_staffing_requirement`,
// `set_rule_enabled`, ...) is derived from supported host operations and belongs
// to the tickets that own those operations — inventing approximations here would
// authorize commands no validated host path can honour.
//
// The metadata/content split is a PROPERTY OF THE COMMAND, not of the caller:
// `record_backup` changes no scenario content, so it must advance `recordRevision`
// alone and leave every content-bound proposal valid.

import type { ScenarioUiState, UiRequestCell } from "@/lib/scenario";
import { pickScenario } from "@/lib/store/fingerprint";
import type { ScenarioSnapshot } from "./types";

export type ScenarioCommandV1 =
  /** One tracked editor mutation — the generic patch primitive. */
  | { type: "patch_scenario"; patch: Partial<ScenarioUiState> }
  /** Overwrite the person×date matrix in one write (the paint-gesture commit). */
  | { type: "set_req_data"; reqData: UiRequestCell[] }
  /** Replace the whole slice — a Load/replace into the CURRENT identity. */
  | { type: "replace_scenario"; scenario: ScenarioUiState; backupFingerprint?: string | null }
  /** Metadata only: record the emitted Workspace backup. Never a content change. */
  | { type: "record_backup"; backupFingerprint: string | null };

/** Whether a command changes scenario CONTENT (and so advances `documentRevision`). */
export function isContentCommand(command: ScenarioCommandV1): boolean {
  return command.type !== "record_backup";
}

/**
 * Apply a command to a persisted snapshot, returning the next snapshot. Pure: it
 * neither reads nor writes storage, so the repository can apply it against the
 * snapshot it just read INSIDE the transaction rather than against whatever the
 * caller happened to be looking at.
 *
 * The scenario slice is projected through `pickScenario` so a patch carrying
 * foreign keys cannot smuggle them into the durable envelope — the same allowlist
 * the persist partializer and the fingerprint already agree on.
 */
export function applyScenarioCommand(
  snapshot: ScenarioSnapshot,
  command: ScenarioCommandV1,
): ScenarioSnapshot {
  switch (command.type) {
    case "patch_scenario":
      return {
        scenario: pickScenario({ ...snapshot.scenario, ...command.patch }),
        backupFingerprint: snapshot.backupFingerprint,
      };
    case "set_req_data":
      return {
        scenario: pickScenario({ ...snapshot.scenario, reqData: command.reqData }),
        backupFingerprint: snapshot.backupFingerprint,
      };
    case "replace_scenario":
      return {
        scenario: pickScenario(command.scenario),
        backupFingerprint: command.backupFingerprint ?? null,
      };
    case "record_backup":
      return {
        scenario: snapshot.scenario,
        backupFingerprint: command.backupFingerprint,
      };
  }
}
