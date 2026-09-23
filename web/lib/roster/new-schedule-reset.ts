// New schedule — the one start-over action (G4 closure).
//
// `New schedule` is the user's single plain-language start-over. Before this
// existed it reset only the SCENARIO, so everything the previous optimisation had
// left in this browser survived it: the working roster and every candidate and
// submission snapshot, the capture gate's in-memory state, the optimize session
// record, and the roster view metadata. The visible symptom was a fresh workspace
// that still announced `The roster for this run could not be saved … Not Found` on
// the Optimize route, because the notice is a projection of that surviving state.
//
// The fix is composition, not suppression: this runs the EXISTING verified roster
// Clear + capture-invalidation authority (`clearRosterDataAndNotify`) and the
// EXISTING scenario reset (`resetToNewScenario`). No second purge protocol is
// introduced, and no notice is special-cased or hidden — the copy disappears
// because the state behind it is genuinely gone.
//
// ORDER IS THE FAIL-CLOSED GUARANTEE. The browser-data cut runs FIRST and the
// scenario is reset only once that cut reports every sensitive surface provably
// empty. So an unverified cleanup leaves the workspace exactly as it was — a clean
// retry, not a half-reset workspace with stale roster data in it. The reverse
// order would destroy the scenario and then discover the residue, leaving nothing
// to retry from.
//
// WHY THIS LAYER. The orchestration has to sit above both halves: `@/lib/store`
// owns `resetToNewScenario` and cannot import the roster domain (roster-clear
// already depends on the store), so the composition belongs here, next to the
// Clear authority it drives.

import { resetToNewScenario, type CommandFailureReason, type CommandOutcome } from "@/lib/store";
import { clearRosterDataAndNotify, type RosterClearOutcome } from "./roster-clear";

/**
 * The one non-technical failure message. Deliberately a constant, not a string
 * built from the outcome: the reset can fail for reasons that are all internal
 * (a storage purge that could not be verified, a residue key that would not
 * clear), and naming any of them would leak exactly the protocol vocabulary the
 * product forbids. It says what did not happen and what to do.
 *
 * It says stored data "may" survive rather than "was kept": the cut is several
 * verified steps and a late one can fail after an earlier one succeeded, so the
 * only claim that is always true is about the SCENARIO, which this reset
 * genuinely leaves alone on any failure.
 */
export const NEW_SCHEDULE_FAILED_MESSAGE =
  "New schedule could not be created — some data from the previous schedule may still be stored " +
  "in this browser. Your current schedule has been kept. Try New schedule again.";

/** Which half refused, for tests and diagnostics — never shown to the user. */
export type NewScheduleFailure =
  /** The verified roster/browser-data cut did not complete. Scenario untouched. */
  | "stored-data"
  /** The cut succeeded but the scenario reset itself threw. */
  | "scenario";

export type NewScheduleResetOutcome =
  | {
      status: "reset";
      /** The Clear report behind the reset, for assertions and diagnostics. */
      storedData: RosterClearOutcome;
    }
  | {
      status: "failed";
      failure: NewScheduleFailure;
      /** Present unless the Clear itself threw before producing a report. */
      storedData: RosterClearOutcome | null;
      /**
       * INTEGRATION (T03): why the scenario half refused, when it did.
       *
       * The pre-T03 reset signalled refusal by THROWING, so this wrapper only had to
       * catch. The repository-authority reset does not throw — it RESOLVES
       * `{ ok: false, reason }`, and the commonest reason is `not-owner` (another tab
       * holds the lease). Carrying it lets the button say which of those happened
       * instead of collapsing every refusal into one message.
       */
      scenarioReason?: CommandFailureReason;
    };

/** Injectable seams. Production passes nothing and gets the live authorities. */
export interface NewScheduleResetDeps {
  /** The verified roster/browser-data cut. Defaults to the live F5 authority. */
  readonly clearStoredData?: () => Promise<RosterClearOutcome>;
  /**
   * The scenario reset. Defaults to the live T03 repository-authority reset.
   *
   * Returns a {@link CommandOutcome} rather than `void`: a refusal is a resolved
   * `ok: false`, not a throw, so a seam typed `Promise<void>` would make every
   * refused reset look like a success.
   */
  readonly resetScenario?: () => Promise<CommandOutcome>;
}

/**
 * Start over: clear the previous run's stored roster/session data, then reset the
 * scenario. Fails closed — a cut that cannot be verified leaves everything in
 * place and reports `failed`, so the caller must not claim `New schedule created`.
 */
export async function resetToNewSchedule(
  deps: NewScheduleResetDeps = {},
): Promise<NewScheduleResetOutcome> {
  const clearStoredData = deps.clearStoredData ?? (() => clearRosterDataAndNotify());

  // 1. THE VERIFIED CUT, FIRST. A throw proves nothing was verified, so it is the
  //    same fail-closed answer as a `failed` report with residue.
  let storedData: RosterClearOutcome;
  try {
    storedData = await clearStoredData();
  } catch {
    return { status: "failed", failure: "stored-data", storedData: null };
  }
  if (storedData.status !== "cleared") {
    return { status: "failed", failure: "stored-data", storedData };
  }

  // 2. THE SCENARIO RESET, only now that the browser data is provably gone.
  //
  // INTEGRATION (T03): the reset is now a repository command over the scenario
  // authority, so it takes no stores and REPORTS refusal instead of throwing. Both
  // shapes are handled — a throw and a resolved `ok: false` are the same answer here:
  // the scenario was not reset, so this must not claim it was.
  const resetScenario = deps.resetScenario ?? (() => resetToNewScenario());
  let outcome: CommandOutcome;
  try {
    outcome = await resetScenario();
  } catch {
    return { status: "failed", failure: "scenario", storedData };
  }
  if (!outcome.ok) {
    return { status: "failed", failure: "scenario", storedData, scenarioReason: outcome.reason };
  }

  return { status: "reset", storedData };
}
