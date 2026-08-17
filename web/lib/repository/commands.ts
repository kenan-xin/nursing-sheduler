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

/**
 * The discriminants of {@link ScenarioCommandV1}, as a VALUE.
 *
 * `lib/capability` restates this list so a help answer can say truthfully which write
 * paths a screen has. That restatement used to be kept honest by reading this file as
 * source text, because the authority boundary forbids `lib/capability` importing the
 * repository. The list is now exported instead, and the two type predicates below make
 * it exhaustive in both directions: add an arm to the union without adding it here (or
 * the reverse) and `tsc --noEmit` fails, before any test runs.
 */
export const SCENARIO_COMMAND_TYPES_V1 = [
  "patch_scenario",
  "set_req_data",
  "replace_scenario",
  "record_backup",
] as const;

/** Compile error unless every union arm is listed above. */
type _EveryArmIsListed =
  ScenarioCommandV1["type"] extends (typeof SCENARIO_COMMAND_TYPES_V1)[number]
    ? true
    : [
        "missing from SCENARIO_COMMAND_TYPES_V1",
        Exclude<ScenarioCommandV1["type"], (typeof SCENARIO_COMMAND_TYPES_V1)[number]>,
      ];
/** Compile error unless every listed name is a real union arm. */
type _EveryListedIsAnArm =
  (typeof SCENARIO_COMMAND_TYPES_V1)[number] extends ScenarioCommandV1["type"]
    ? true
    : [
        "not a command",
        Exclude<(typeof SCENARIO_COMMAND_TYPES_V1)[number], ScenarioCommandV1["type"]>,
      ];
const _exhaustive: [_EveryArmIsListed, _EveryListedIsAnArm] = [true, true];
void _exhaustive;

/** Whether a command changes scenario CONTENT (and so advances `documentRevision`). */
export function isContentCommand(command: ScenarioCommandV1): boolean {
  return command.type !== "record_backup";
}

/** Deep structural equality over JSON-shaped scenario data (±Infinity included). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => key in right && sameValue(left[key], right[key]));
  }
  return false;
}

/**
 * Whether a CONTENT command's result is semantically identical to what is already
 * committed — in which case it must not spend a revision or an Undo entry.
 *
 * Scoped to the arms that genuinely need it. `set_req_data` and `replace_scenario`
 * hand over freshly-built object graphs (a paint fold, a Clear, a re-imported
 * document), so their "nothing changed" case is invisible to a reference test; the
 * only honest answer is a value comparison of the field each one writes.
 * `patch_scenario` is left alone here because the command bus already refuses an
 * unchanged patch by per-key reference, which is both cheaper and the exact rule the
 * editor transforms are written against.
 */
export function isSemanticNoOpCommand(
  before: ScenarioSnapshot,
  after: ScenarioSnapshot,
  command: ScenarioCommandV1,
): boolean {
  switch (command.type) {
    case "set_req_data":
      return sameValue(before.scenario.reqData, after.scenario.reqData);
    case "replace_scenario":
      return (
        before.backupFingerprint === after.backupFingerprint &&
        sameValue(before.scenario, after.scenario)
      );
    default:
      return false;
  }
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
