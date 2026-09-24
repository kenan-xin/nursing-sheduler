"use client";

// The assistant's live UI state, and the one place the interruption controller is
// wired to the real app (T04 store, T05 interruption).
//
// Small on purpose. Durable truth is Dexie: the settings row, the thread, the
// messages, the turns, the generation fences. This store holds only what a re-render
// needs and what has no meaning across a reload.
//
// THE TWO EPOCHS, and the distinction is load-bearing:
//
//   * `turnEpoch` is monotonic per page lifetime and advances on EVERY interruption.
//   * `authorizedTurnEpoch` is the epoch of the turn that is actually allowed to run
//     right now, or `null` when none is.
//
// A tool handler is authorised only while `turnEpoch === authorizedTurnEpoch`. Both
// are needed: comparing the live epoch against a copy taken at registration time
// reopens the gate on the next re-render (the copy updates too), while comparing it
// against the AUTHORISED epoch stays closed forever once an interruption clears the
// latter. Neither lives in Dexie because their whole job is to fence IN-FLIGHT work:
// a reload has no in-flight work, and a reloaded turn is detached at bring-up.
//
// WHY DISABLE/REMOVE/REPLACE/CLEAR ALL LIVE HERE rather than in the Settings card:
// they are interruptions first and configuration changes second. Routing them through
// this module is what stops Settings from growing its own partial cancellation path.

import { create } from "zustand";
import {
  activateProbedConfiguration,
  readAssistantSettings,
  removeAssistantKey,
  setAssistantEnabled,
} from "./settings-repo";
import {
  beginClear,
  clearOutcomes,
  finishClear,
  persistClearFacts,
  readClearOutcome,
  readClearOutcomeIds,
  resumePendingClears,
  terminalizeRecoveryFailure,
  type ClearConfigurationOutcome,
  type ClearTerminalizeResult,
  type PersistedClearOutcome,
  type ClearFacts,
  type ClearFailureReason,
  type ClearScope,
} from "./clear-repo";
import {
  beginProbeOperation,
  isProbeOperationCurrent,
  resetProbeAuthorityForTest,
  revokeProbeOperations,
  type ProbeOperation,
} from "./probe-authority";
import { readDiagnosticCanceller } from "./diagnostic-cancellation";
import { installDiagnosticCanceller } from "@/lib/ai/diagnostic/install";
import type { DiagnosticSearchRecordV1 } from "@/lib/ai/diagnostic/search-record";
import { detachStaleTurns, readUnsettledTurns, setTurnState } from "./history-repo";
import {
  emptyInterruptionProgress,
  interrupt,
  realSettlementWindow,
  type InterruptionDeps,
  type InterruptionProgress,
  type InterruptionRequest,
  type InterruptionResult,
} from "./interruption";
import {
  recordLifecycleEvent,
  resetLifecycleLog,
  type AssistantSettlement,
  type InterruptionPhase,
  type InterruptionTrigger,
} from "./lifecycle";
import {
  emptyAssistantSettings,
  isAssistantReady,
  type AssistantModelSource,
  type AssistantSettingsV1,
} from "./records";
import {
  peekRuntimeInstanceId,
  readActiveRunHandle,
  requestRuntimeStop,
  setActiveRunHandle,
} from "./runtime-stop";
import type { SendRefusal } from "./send-gate";
import type { RosterChangeRequest } from "@/lib/roster/change-request";
import type { RosterChangeView } from "./roster-context";

/** The schedule proposal a roster card applies with it, and which record it changes. */
export interface LinkedScheduleChange {
  proposalId: string;
  assumptionIds: string[];
  /** "leave": a leave move or MC leave. "staff": a borrowed temporary nurse. */
  record: "leave" | "staff";
}

/** An interruption that has not finished settling. Non-null blocks every send. */
export interface ActiveInterruption {
  trigger: InterruptionTrigger;
  phase: InterruptionPhase;
}

/**
 * How the last turn ended, kept so the panel can state it truthfully.
 *
 * `trigger` is `null` when nothing interrupted it -- a transport failure ends a turn
 * without any user action, and attributing it to Stop would misreport what happened.
 */
export interface LastSettlement {
  trigger: InterruptionTrigger | null;
  settlement: AssistantSettlement;
}

/**
 * A bounded, secret-safe reason a Clear did not complete.
 *
 * DEFINED BY THE REPOSITORY, because the durable record carries it and the parser that
 * reads that record has to own the vocabulary. Re-exported here so callers that think
 * in terms of the store's result type do not have to know where it lives.
 */
export type { ClearFailureReason };

/**
 * The first-class result of ONE Clear invocation, returned by `clearAll`/`clearHistory`.
 *
 * ALWAYS present — never `null`, never a rejected promise. Each call mints its own
 * `requestId` so repeated/queued calls can be distinguished even when the store's
 * reactive `clearResult` changes later. The bridge serializes THIS object directly;
 * Settings explicitly awaits and settles the promise that carries it.
 */
export type ClearActionResult = ClearFacts;

/**
 * The reactive store projection of the most recent clear outcome, carried so the
 * Settings card can render an actionable notice. Set from `ClearActionResult` by the
 * clear actions; `null` after a successful clear or on first load with no persisted
 * outcome.
 */
export interface ClearResult {
  status: "deleted" | "incomplete" | "failed";
  /**
   * The scope the notice belongs to, or `null` when a storage failure left even that
   * unknown.
   *
   * `null` IS NOT A SCOPE, it is the absence of one, and the Settings card renders it
   * as a non-destructive storage notice with no action. Defaulting an unknown scope to
   * `all` would offer to delete everything on the strength of a failed read -- a wider
   * deletion than the user ever authorized.
   */
  scope: ClearScope | null;
  scenarioId: string | null;
  reason?: ClearFailureReason;
  /**
   * What the failed invocation proved about the stored configuration.
   *
   * The Clear-all warning reads THIS, not the scope: "Your API key was removed" is a
   * claim about what happened, and a global clear that failed before its fence
   * committed removed nothing.
   */
  configurationOutcome: ClearConfigurationOutcome;
  /**
   * The operation identity this notice belongs to, or `null` when the failure was so
   * early that no durable record exists.
   *
   * CARRIED SO THE RETRY IS CAUSAL. The Settings retry hands it back as
   * `retryOfOperationId`, which is what lets the succeeding invocation retire exactly
   * the tombstone the user was looking at -- and nothing newer.
   */
  operationId: string | null;
}

/** One question on the option card. */
export interface ChoiceQuestion {
  question: string;
  options: readonly { label: string; detail: string }[];
  multiple: boolean;
}

/**
 * What `offer_choices` asks the user to pick from: one question, plus up to three
 * more shown one at a time on the same card and answered in one message.
 */
export interface ChoiceOffer extends ChoiceQuestion {
  moreQuestions?: readonly ChoiceQuestion[];
}

export interface AssistantUiState {
  /** False until the durable settings row has been read at least once. */
  hydrated: boolean;
  settings: AssistantSettingsV1;
  panelOpen: boolean;
  /** Monotonic per page lifetime; see the module note. */
  turnEpoch: number;
  /** The epoch a live turn is authorised under, or `null`. See the module note. */
  authorizedTurnEpoch: number | null;
  /**
   * The epoch of a turn being PREPARED -- claimed, not yet authorised to run.
   *
   * Preparation is live work even though no run exists yet: it holds a durable
   * `preparing` turn row and it is about to contact the provider. Without this the
   * ownership watch would ignore a takeover, a lease loss or a scenario switch that
   * landed mid-preparation (it only fires when there is something to interrupt), and
   * the prepared send would then launch under authority the user had already revoked.
   */
  preparingTurnEpoch: number | null;
  activeTurnId: string | null;
  streaming: boolean;
  interruption: ActiveInterruption | null;
  lastSettlement: LastSettlement | null;
  /** The most recent refused send, so the panel can explain the refusal. */
  lastRefusal: SendRefusal | null;
  /**
   * The proposal whose host Preview is currently live, and the turn epoch it was
   * prepared under.
   *
   * IN MEMORY ON PURPOSE, and the epoch with it. The proposal ROW is durable, but a
   * live Preview is in-flight work: a reload has none, and restoring one would hand
   * a live Apply control to a page lifetime that never saw the conversation it came
   * from -- the same reason a reloaded turn is detached rather than resumed. The
   * epoch is what makes an interruption or takeover show "this was stopped, prepare
   * it again" instead of a live Apply button.
   */
  activeProposal: { proposalId: string; turnEpoch: number } | null;
  /**
   * The live diagnostic search snapshot, stamped with the turn that authorised it
   * (T10). Same shape of authority as `activeProposal`, for the same reason: the
   * card must read as "this was stopped" after an interruption rather than as live
   * work, and a page lifetime cannot inherit a search's in-flight polling.
   *
   * The RECORD itself is held, not just its id, because the orchestrator publishes
   * a new snapshot on every durable write — which is what lets the card follow a
   * running search without polling IndexedDB.
   */
  activeDiagnostic: { search: DiagnosticSearchRecordV1; turnEpoch: number } | null;
  /**
   * The live "Run the optimiser?" card, stamped with the turn that asked for it.
   *
   * Same authority rule as `activeProposal`: after an interruption the card renders
   * as stopped with no Run control, rather than as a live action for a conversation
   * the user already stopped. In memory only; a reload has no live card.
   */
  activeRunRequest: { turnEpoch: number } | null;
  /**
   * The live "Swap shifts?" card from `prepare_roster_swap`, stamped with the turn that
   * asked for it. Same authority rule as `activeRunRequest`: after an interruption it
   * renders as stopped with no Apply control. In memory only.
   */
  activeRosterChange: {
    /** Changes on every show, so the card resets its agreement tick. */
    id: number;
    /** The roster cells, or null for a schedule-only change (step 3, C1). */
    request: RosterChangeRequest | null;
    view: RosterChangeView;
    /** The linked schedule proposal (leave move, MC leave, borrowed person) applied with it. */
    linked: LinkedScheduleChange | null;
    turnEpoch: number;
  } | null;
  /**
   * Apply is running on the roster card (up to the Roster screen's 15 s window). While
   * true, no other card may replace it, so its outcome always has a place to land.
   */
  rosterChangeApplying: boolean;
  /**
   * The last roster card Apply that did not finish, in plain words. Kept outside the
   * card so it survives the card being stopped or cleared; the user dismisses it.
   */
  rosterChangeNotice: string | null;
  /**
   * The live option card from `offer_choices`. One at a time: a newer offer replaces
   * it, and any send closes it. `id` changes on every offer so the card resets its
   * own checkbox and Other state. Stamped with the turn that offered it, like
   * `activeRunRequest`, so settlement can tell this turn's card from an older one.
   * In memory only.
   */
  activeChoices: (ChoiceOffer & { id: number; turnEpoch: number }) | null;
  /**
   * Interruptions requested but not yet settled, incremented SYNCHRONOUSLY at the
   * request.
   *
   * The controller's own work starts a microtask later (it is serialised, and the
   * clear triggers fence durably before closing the gate), so `interruption` alone
   * would be null for a closure that has already been asked for. Counting requests
   * is what lets a send refuse in the same tick the user pressed the control.
   */
  pendingInterruptions: number;
  /**
   * The result of the most recent Clear all / Clear history, carried so the Settings
   * card can show an actionable notice when deletion did not complete. `null` when no
   * clear has run this page lifetime, or after a successful Clear all resets it.
   */
  clearResult: ClearResult | null;
}

const INITIAL: AssistantUiState = {
  hydrated: false,
  // A never-read store must look OFF, not "unknown": every surface gates on
  // readiness, and defaulting to anything else would flash the assistant into
  // existence for a user who has not enabled it.
  settings: emptyAssistantSettings(new Date(0)),
  panelOpen: false,
  turnEpoch: 0,
  authorizedTurnEpoch: null,
  preparingTurnEpoch: null,
  activeTurnId: null,
  streaming: false,
  interruption: null,
  lastSettlement: null,
  lastRefusal: null,
  activeProposal: null,
  activeDiagnostic: null,
  activeRunRequest: null,
  activeRosterChange: null,
  rosterChangeApplying: false,
  rosterChangeNotice: null,
  activeChoices: null,
  pendingInterruptions: 0,
  clearResult: null,
};

export const useAssistantStore = create<AssistantUiState>()(() => ({ ...INITIAL }));

/** Whether every gate for a live assistant surface is currently satisfied. */
export function selectReady(state: AssistantUiState): boolean {
  return state.hydrated && isAssistantReady(state.settings);
}

/**
 * Whether this tab holds assistant work an interruption would have to close.
 *
 * A turn being PREPARED counts. It has no run yet, but it holds a durable turn row
 * and it is one await away from the provider -- so an ownership or identity change
 * during preparation is exactly the case that must interrupt.
 */
export function hasLiveAssistantWork(
  state: AssistantUiState = useAssistantStore.getState(),
): boolean {
  return state.activeTurnId !== null || state.preparingTurnEpoch !== null;
}

/**
 * Whether an interruption has been REQUESTED and not finished settling.
 *
 * Broader than `interruption !== null` by one tick: a request counts from the moment
 * it is made, before the controller has reached its own synchronous closure.
 */
export function isInterrupting(state: AssistantUiState = useAssistantStore.getState()): boolean {
  return state.interruption !== null || state.pendingInterruptions > 0;
}

/**
 * Whether a tool handler registered under `registeredEpoch` may still answer.
 *
 * The ONE authority on that question. Exported so every tool module -- this
 * ticket's and later ones' -- asks the same thing rather than reimplementing the
 * comparison, and so the closed-gate property is testable without a live agent.
 */
export function isTurnAuthorized(
  registeredEpoch: number,
  state: AssistantUiState = useAssistantStore.getState(),
): boolean {
  return state.authorizedTurnEpoch !== null && state.turnEpoch === registeredEpoch;
}

/**
 * Read the durable settings row into the projection, finish any interrupted clear,
 * and settle any turn stranded by a previous page lifetime.
 *
 * THE ORDER MATTERS. A clear whose deletion pass never ran (reload or crash during
 * settlement) is completed FIRST, so the stale-turn sweep afterwards cannot rewrite --
 * and therefore recreate -- a turn row belonging to data the user deleted.
 */
export async function hydrateAssistant(): Promise<AssistantSettingsV1> {
  installDiagnosticCanceller();
  // HYDRATION IS TOTAL: no repository failure may reject this promise. Every stage is
  // guarded so the mount caller (which discards the promise) always gets a hydrated
  // store with the best known settings truth and a visible retry notice when something
  // went wrong.
  const recovery = await resumePendingClears();
  const terminalizeResults: ClearTerminalizeResult[] = [];
  if (recovery.failed) {
    recordLifecycleEvent({
      trigger: null,
      phase: "settled",
      at: new Date(),
      errorClass: "storage_unavailable",
    });
    // A PENDING IDENTITY IS WORTH TERMINALIZING, but only if it is still that identity.
    // The candidate was observed before the failure; between then and now another tab
    // may have completed the operation, a newer invocation may have written a terminal
    // row at the same key, or the row may be gone. The compare-and-swap is what makes
    // this a no-op in every one of those cases instead of a stale overwrite.
    for (const candidate of recovery.candidates) {
      const result = await terminalizeRecoveryFailure(candidate).catch(
        () => "transaction_failed" as const,
      );
      terminalizeResults.push(result);
    }
  }
  try {
    await detachStaleTurns();
  } catch {
    // Stale-turn detachment is best-effort; a failure here must not block hydration.
  }
  // THE BEST KNOWN SETTINGS TRUTH SURVIVES A FAILED READ. On a first hydrate that is
  // the conservative empty/off default the store starts with; on a later one it is
  // whatever was last read successfully. Replacing a working key and model with
  // `empty` because a read failed would claim a deletion no committed Clear-all begin
  // ever performed -- and the user would be told their credential is gone while it sits
  // on disk.
  let settings = useAssistantStore.getState().settings;
  let settingsReadFailed = false;
  try {
    settings = await readAssistantSettings();
  } catch {
    settingsReadFailed = true;
  }
  // RECONSTRUCT OUTCOME STATE FROM THE DURABLE CANONICAL RECORDS. Read AFTER the
  // compare-and-swap above, so what publishes is the latest durable truth rather than
  // the report recovery was holding.
  //
  // A FAILED READ PRESERVES THE KNOWN NOTICE. Publishing `null` here would erase an
  // actionable warning the user was already looking at, on the strength of a read that
  // did not work -- the notice would vanish and the unfinished clear behind it would
  // not.
  let clearResult: ClearResult | null = useAssistantStore.getState().clearResult;
  let latestOutcome: PersistedClearOutcome | null = null;
  let outcomeReadFailed = false;
  try {
    latestOutcome = await readClearOutcome();
    clearResult = latestOutcome ? projectClearResult(latestOutcome) : null;
  } catch {
    outcomeReadFailed = true;
  }
  // A FAILURE WITH NO IDENTITY IS NOT A CLEAR-ALL. `scope: null` renders as a
  // non-destructive storage notice; it offers nothing to delete, because nothing here
  // knows what the user asked for.
  //
  // A NO-OP IS NOT A FAILURE AND MUST NOT RAISE ONE. If candidates were observed and
  // every compare-and-swap declined, the world simply moved on -- the operation was
  // consumed, completed by another tab, or replaced -- and the reread above has
  // already published whatever presently exists. Treating `recovery.failed` alone as
  // grounds for a warning is what put a scope-null storage notice on screen after a
  // perfectly ordinary consumed-row no-op.
  const casTransactionFailed = terminalizeResults.includes("transaction_failed");
  const recoveryFailedWithoutIdentity = recovery.failed && recovery.candidates.length === 0;
  if (
    !clearResult &&
    (recoveryFailedWithoutIdentity ||
      casTransactionFailed ||
      settingsReadFailed ||
      outcomeReadFailed)
  ) {
    clearResult = {
      status: "failed",
      scope: null,
      scenarioId: null,
      reason: "storage",
      configurationOutcome: "unknown",
      operationId: null,
    };
  }

  // A FAILED READ NEVER CHANGES THE CONFIGURATION PROJECTION.
  //
  // There is nothing to decide here, and that is the point. Deletion is reported by
  // exactly two causal paths, neither of which is this one:
  //
  //   * the Clear action that commits it -- `beginClear` deletes the settings row
  //     inside the transaction that commits its fence, and `runClearAction` projects
  //     `empty` from that committed fence, in the tab that performed it;
  //   * a SUCCESSFUL read here -- `readAssistantSettings` returns the off-by-default
  //     shape for an absent row, so an ordinary successful hydrate already reports a
  //     deleted configuration exactly and needs no proof at all.
  //
  // What used to live here tried to infer absence while storage was refusing to answer
  // -- from a Clear operation's currency and a wall-clock comparison. Neither can
  // exclude a settings write this tab never observed: the operation row proves only
  // itself, another tab's write is invisible until it is read, and `Date` strings from
  // two tabs are not a transaction clock. The consequence was a durable Ready
  // configuration projected as absent, which hides a working assistant.
  //
  // Preserving instead can leave a key on screen for the rest of a storage outage that
  // a Clear elsewhere has already removed. That is the safer direction and it is
  // self-correcting: the next successful read is authoritative, and a send made against
  // a credential that is gone fails and says so. The bounded storage notice below is
  // already shown meanwhile, and it claims nothing about the key.
  void settingsReadFailed;

  useAssistantStore.setState({ settings, hydrated: true, clearResult });
  return settings;
}

// ---------------------------------------------------------------------------
// The interruption seam
// ---------------------------------------------------------------------------

/**
 * Interruptions are SERIALISED. Two of them at once (Stop then Disable, a takeover
 * landing during a Clear) would race on the same turn rows and the same clear fence;
 * chaining them keeps each one's settlement a coherent story, and the second still
 * closes the gate immediately because that step is synchronous.
 */
let chain: Promise<unknown> = Promise.resolve();

/**
 * The settlement timer, replaceable in tests.
 *
 * A seam rather than fake timers at the call site: the window is armed several async
 * hops inside the controller, so a suite that installs fake timers afterwards is
 * already too late to advance the one that matters.
 */
let settlementWindow: InterruptionDeps["settlementWindow"] = realSettlementWindow;

/** Test seam: close the 15-second window on demand instead of waiting for it. */
export function setSettlementWindowForTest(
  next: InterruptionDeps["settlementWindow"] | null,
): void {
  settlementWindow = next ?? realSettlementWindow;
}

/**
 * Whether this clear actually deleted the row the visible diagnostic card describes.
 *
 * DECIDES FROM THE DELETION OUTCOME, not the fence scope. A Clear all that exhausted
 * its recapture bound refused to delete, so the durable search row remains -- and
 * dropping the card's projection anyway would put a deleted search back on screen for
 * the rest of the session, which is the mirror image of the bug this scoping fixes.
 *
 * SCOPED, because the clear is. Clear all takes every search, so a successful deletion
 * always takes the card. Clear history takes one scenario's searches -- and dismissing
 * a card belonging to a different scenario would be deleting from the user's screen
 * something still on disk.
 */
function clearRemovedActiveDiagnostic(result: InterruptionResult): boolean {
  const clear = result.clear;
  if (!clear || clear.deletion.outcome !== "deleted") return false;
  if (clear.fence.scope === "all") return true;
  const active = useAssistantStore.getState().activeDiagnostic;
  return active !== null && active.search.scenarioId === clear.fence.scenarioId;
}

/**
 * Assemble the canonical facts of one Clear invocation from what is actually known.
 *
 * THE ONLY PLACE A `ClearActionResult` IS BUILT, whether the invocation succeeded,
 * was refused, or died at any stage. Every field comes from the accumulator or from
 * the identity minted before the first await -- nothing is defaulted, and no stage
 * overwrites a fact an earlier one established.
 *
 * SCOPE AND SCENARIO COME FROM THE FENCE once there is one. Clear all is
 * `scenarioId: null` by definition; the scenario the caller happened to have selected
 * is a UI fact, not an operation fact, and letting it reach the result is how a
 * global result ends up claiming a scenario its durable row does not have.
 */
function assembleClearFacts(input: {
  requestId: string;
  operationId: string;
  scope: ClearScope;
  requestedScenarioId: string | null;
  progress: InterruptionProgress;
  /** Set when the invocation threw; the classified reason for it. */
  failureReason?: ClearFailureReason;
}): ClearActionResult {
  const { progress } = input;
  const fence = progress.fence;
  const scope = fence?.scope ?? input.scope;
  // A global clear has no scenario, at any stage. A scoped one keeps the identity it
  // was invoked with even before the fence exists.
  const scenarioId = fence ? fence.scenarioId : scope === "all" ? null : input.requestedScenarioId;
  const deletionOutcome = progress.deletion?.outcome ?? null;

  const status: ClearActionResult["status"] = input.failureReason
    ? deletionOutcome === "deleted"
      ? // THE DELETION COMMITTED and only post-processing failed. Reporting this as
        // failed would invite a retry against data written after the deletion, so the
        // committed truth wins and the cleanup failure is a log fact, not a user action.
        "deleted"
      : "failed"
    : deletionOutcome === "deleted"
      ? "deleted"
      : "incomplete";

  const reason: ClearFailureReason | null =
    status === "deleted"
      ? null
      : (input.failureReason ?? (scope === "all" ? "recapture_exhausted" : "superseded"));

  return {
    requestId: input.requestId,
    operationId: input.operationId,
    scope,
    scenarioId,
    status,
    reason,
    settlement: progress.settlement,
    deletionOutcome,
    // THE CONFIGURATION FACT IS SET AT THE TRANSITION BOUNDARY, and the boundary is
    // the fence: `beginClear` deletes the settings row inside the transaction that
    // commits it. A history clear never touches configuration; a global clear that
    // never got a fence never deleted anything. Neither is inferred from the scope the
    // user asked for.
    configurationOutcome: scope === "history" ? "retained" : fence ? "deleted" : "retained",
  };
}

/** Project the reactive `clearResult` from any canonical fact record. */
function projectClearResult(facts: {
  status: ClearActionResult["status"];
  scope: ClearScope;
  scenarioId: string | null;
  reason: ClearFailureReason | null;
  configurationOutcome: ClearConfigurationOutcome;
  operationId: string;
}): ClearResult | null {
  if (facts.status === "deleted") return null;
  return {
    status: facts.status,
    scope: facts.scope,
    scenarioId: facts.scenarioId,
    reason: facts.reason ?? undefined,
    configurationOutcome: facts.configurationOutcome,
    operationId: facts.operationId,
  };
}

function closeGate(trigger: InterruptionTrigger): number {
  const turnEpoch = useAssistantStore.getState().turnEpoch + 1;
  useAssistantStore.setState({
    turnEpoch,
    // Dropping this is what closes tool handlers permanently rather than until the
    // next re-render. See the module note on the two epochs.
    authorizedTurnEpoch: null,
    // A send still preparing under the old epoch is no longer live work here. Its own
    // final authorization notices the epoch moved and quarantines the prepared turn.
    preparingTurnEpoch: null,
    interruption: { trigger, phase: "closing" },
    lastRefusal: null,
  });
  return turnEpoch;
}

/**
 * Release one pending-interruption slot, keeping the gate visibly closed while
 * another request is still queued.
 */
function releaseInterruptionSlot(settled: InterruptionResult | null): void {
  useAssistantStore.setState((state) => {
    const pendingInterruptions = Math.max(0, state.pendingInterruptions - 1);
    return {
      pendingInterruptions,
      // Clearing this while another interruption is still queued would open a window
      // in which a send could pass a gate that has already been asked to close.
      interruption: pendingInterruptions > 0 ? state.interruption : null,
      ...(settled
        ? {
            lastSettlement: { trigger: settled.trigger, settlement: settled.settlement },
            activeTurnId: null,
            preparingTurnEpoch: null,
            streaming: false,
            authorizedTurnEpoch: null,
          }
        : {}),
    };
  });
}

async function runInterruption(
  request: InterruptionRequest,
  /**
   * Filled stage by stage by the controller. A clear invocation owns one of these and
   * reads it after a throw, so a failure in the deletion transaction reports the real
   * settlement class the controller had already computed rather than a fabricated one.
   */
  progress: InterruptionProgress = emptyInterruptionProgress(),
  /** Minted before any I/O; carried into `beginClear` so the row is this invocation's. */
  clearIdentity?: { operationId: string; requestId: string },
): Promise<InterruptionResult> {
  let result: InterruptionResult;
  try {
    result = await interrupt(
      request,
      {
        now: () => new Date(),
        closeGate,
        publishPhase: (phase, trigger) => {
          useAssistantStore.setState({ interruption: { trigger, phase } });
        },
        readUnsettledTurns: (scope) => readUnsettledTurns(scope),
        setTurnState: (turnId, input) => setTurnState(turnId, input),
        abortLocalRun: () => {
          const handle = readActiveRunHandle();
          if (!handle) return null;
          handle.abort();
          setActiveRunHandle(null);
          return handle;
        },
        requestRuntimeStop: ({ threadId, signal }) =>
          requestRuntimeStop({
            threadId,
            runtimeInstanceId: peekRuntimeInstanceId(),
            signal,
          }),
        cancelDiagnostics: (input) => readDiagnosticCanceller().cancelOwnedJobs(input),
        beginClear: (scope, scenarioId) => beginClear(scope, scenarioId, clearIdentity),
        finishClear: (fence) => finishClear(fence),
        settlementWindow: (ms, signal) => settlementWindow(ms, signal),
      },
      progress,
    );
  } catch (error) {
    releaseInterruptionSlot(null);
    // THE PROGRESS OBJECT ALREADY HOLDS whatever the controller established, so a clear
    // invocation reads its real facts from there. Rethrow: a caller that wants those
    // facts owns the accumulator, and inventing a result here is what previously
    // replaced a known settlement with `run_failed`.
    throw error;
  }

  if (request.trigger === "disable" || clearRemovedActiveDiagnostic(result)) {
    useAssistantStore.setState({ activeDiagnostic: null });
  }

  releaseInterruptionSlot(result);
  return result;
}

/**
 * THE entry point for every interruption, with the two seams a Clear invocation needs.
 *
 * The pending count is bumped SYNCHRONOUSLY, before anything is queued: the
 * controller's own closure is one microtask away at best (and, for the clear triggers,
 * a durable fence away), so this is what makes "an interruption has been asked for"
 * true to every gate in the same tick the user asked for it.
 */
function queueInterruption(
  request: InterruptionRequest,
  progress?: InterruptionProgress,
  clearIdentity?: { operationId: string; requestId: string },
): Promise<InterruptionResult> {
  useAssistantStore.setState((state) => ({
    pendingInterruptions: state.pendingInterruptions + 1,
    // An interruption already in progress keeps its own phase: it is the truthful
    // thing to show, and the queued one publishes its own when it starts.
    interruption: state.interruption ?? { trigger: request.trigger, phase: "closing" },
  }));
  const next = chain.then(() => runInterruption(request, progress, clearIdentity));
  chain = next.catch(() => {});
  return next;
}

/**
 * Run ONE Clear invocation end to end and return its canonical facts.
 *
 * The single path for both scopes. Identity is minted before any I/O; the predecessor
 * set is captured before the fence; the accumulator carries every stage's facts across
 * a later failure; and the terminal record is written under the invocation's own
 * operation id. The direct return value, the durable row and the reactive projection
 * are therefore three views of one fact record rather than three reconstructions.
 */
async function runClearAction(input: {
  scope: ClearScope;
  threadId: string | null;
  /** The scenario the caller asked about. Ignored for `all`, which is global. */
  scenarioId: string | null;
  retryOfOperationId?: string | null;
}): Promise<ClearActionResult> {
  const scope = input.scope;
  const trigger = scope === "all" ? "clear_all" : "clear_history";
  // BEFORE ANY I/O. A failure inside `beginClear` itself still has these.
  const requestId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const scenarioId = scope === "all" ? null : input.scenarioId;

  // Captured before the fence, so the set is genuinely this invocation's predecessors.
  const predecessors = new Set(
    scope === "history" ? await readClearOutcomeIds("history", scenarioId).catch(() => []) : [],
  );
  if (input.retryOfOperationId) predecessors.add(input.retryOfOperationId);

  const progress = emptyInterruptionProgress();
  let failureReason: ClearFailureReason | undefined;
  try {
    await queueInterruption(
      { trigger, threadId: input.threadId, scenarioId: input.scenarioId },
      progress,
      { operationId, requestId },
    );
  } catch {
    // Bounded and enumerated. The stage that failed is visible in the accumulator.
    failureReason = "storage";
  }

  const facts = assembleClearFacts({
    requestId,
    operationId,
    scope,
    requestedScenarioId: scenarioId,
    progress,
    failureReason,
  });

  if (facts.status === "deleted") {
    // Retire ONLY the tombstones captured before this invocation fenced. A later or
    // queued call's outcome is not in that set, so it survives untouched. A failure
    // here is a cleanup failure over a COMMITTED deletion: it must not turn the
    // reported status back into something the user would retry.
    await clearOutcomes(scope, scenarioId, {
      predecessorStartedAt: new Date().toISOString(),
      predecessorOperationIds: [...predecessors],
    }).catch(() => {
      recordLifecycleEvent({
        trigger,
        phase: "cleared",
        at: new Date(),
        errorClass: "storage_unavailable",
      });
    });
  } else {
    // The terminal record carries THE SAME facts the caller is about to be handed.
    await persistClearFacts({ ...facts, status: facts.status }).catch(() => null);
  }

  if (scope === "all") {
    // THE CONFIGURATION ROW IS GONE IF, AND ONLY IF, THE BEGIN FENCE COMMITTED --
    // `beginClear` deletes it inside that transaction, before any cancellation starts.
    // The committed fence is the proof, and the only proof, this projection needs.
    // Without it (a failure before or inside begin) the credential is still on disk,
    // and projecting `empty` would tell the user it had been deleted when it had not.
    const state = useAssistantStore.getState();
    useAssistantStore.setState({
      settings: progress.fence ? emptyAssistantSettings(new Date()) : state.settings,
      panelOpen: progress.fence ? false : state.panelOpen,
      lastRefusal: null,
    });
  }

  useAssistantStore.setState({ clearResult: projectClearResult(facts) });
  if (facts.status !== "deleted") {
    recordLifecycleEvent({
      trigger,
      phase: "settled",
      at: new Date(),
      errorClass: facts.status === "failed" ? "storage_unavailable" : "clear_incomplete",
    });
  }
  return facts;
}

export const assistantActions = {
  openPanel(): void {
    useAssistantStore.setState({ panelOpen: true, lastRefusal: null });
  },

  closePanel(): void {
    useAssistantStore.setState({ panelOpen: false });
  },

  togglePanel(): void {
    const open = useAssistantStore.getState().panelOpen;
    useAssistantStore.setState({ panelOpen: !open, lastRefusal: null });
  },

  /**
   * THE entry point for every interruption. Stop, ownership loss, scenario switch and
   * the Settings actions below all come through here.
   */
  interrupt(request: InterruptionRequest): Promise<InterruptionResult> {
    return queueInterruption(request);
  },

  /**
   * Turn AI off. NON-DESTRUCTIVE: key, model preference, history and the generation
   * fences all survive.
   *
   * Interrupt BEFORE persisting the switch. Persisting first would unmount the whole
   * assistant surface (readiness is derived from the row) and take the panel's honest
   * "Stopping…" state down with it, leaving the user with no evidence that anything
   * was settled. The flow's wording is explicit that the panel hides AFTER local
   * detachment.
   */
  async setEnabled(
    enabled: boolean,
    scope: { threadId: string | null; scenarioId: string | null } = {
      threadId: null,
      scenarioId: null,
    },
  ): Promise<void> {
    if (!enabled) {
      // Before the interruption's first await: a probe still in flight must not be
      // able to activate a configuration into an app the user has just turned off.
      revokeProbeOperations();
      await assistantActions.interrupt({ trigger: "disable", ...scope });
    }
    const settings = await setAssistantEnabled(enabled);
    useAssistantStore.setState({
      settings,
      ...(enabled ? {} : { panelOpen: false, lastRefusal: null }),
    });
  },

  /**
   * Promote a probe-passed draft. Interrupts first: active work belongs to the
   * PREVIOUS configuration, and the flow requires it aborted before the new one is
   * activated. Same-scenario history is retained, and each turn already records the
   * model it used.
   */
  async activate(
    draft: {
      apiKey: string;
      modelId: string;
      modelSource: AssistantModelSource;
    },
    scope: { threadId: string | null; scenarioId: string | null } = {
      threadId: null,
      scenarioId: null,
    },
    operation?: ProbeOperation,
  ): Promise<boolean> {
    await assistantActions.interrupt({ trigger: "replace_configuration", ...scope });
    const settings = await activateProbedConfiguration(draft, {
      // Compared inside the write transaction. Remove key, Clear all, Disable and a
      // newer replacement all revoke the operation synchronously, so a probe that
      // succeeds after one of them cannot write the captured credential back.
      authorize: operation ? () => isProbeOperationCurrent(operation) : undefined,
    });
    if (!settings) return false;
    useAssistantStore.setState({ settings });
    return true;
  },

  /**
   * Claim a revocable identity for a Settings probe.
   *
   * A REPLACEMENT interrupts the previous configuration's live work BEFORE the new
   * pair is tested. That order is the settled one: the work in flight belongs to a
   * configuration the user has already decided to change, and testing first would
   * leave it running against the old key while the new one is being probed.
   *
   * The operation is minted before the interruption so that anything landing during
   * it -- Remove key, Clear all, Disable -- revokes THIS probe rather than an earlier
   * one, and the caller's post-await check catches it.
   */
  async beginProbe(
    options: { replaces: boolean },
    scope: { threadId: string | null; scenarioId: string | null } = {
      threadId: null,
      scenarioId: null,
    },
  ): Promise<ProbeOperation> {
    const operation = beginProbeOperation();
    if (options.replaces) {
      await assistantActions.interrupt({ trigger: "replace_configuration", ...scope });
    }
    return operation;
  },

  /**
   * Delete the credential, then interrupt.
   *
   * This order is required, not incidental: the contract is "delete the browser key
   * immediately", and the runtime's info/connect/stop routes are keyless by design
   * (T01) so settlement never needs the credential it just destroyed.
   */
  async removeKey(
    scope: { threadId: string | null; scenarioId: string | null } = {
      threadId: null,
      scenarioId: null,
    },
  ): Promise<void> {
    // Synchronously, ahead of the deletion itself: a probe that completes after this
    // point must not be able to re-persist the credential being removed.
    revokeProbeOperations();
    const settings = await removeAssistantKey();
    useAssistantStore.setState({ settings });
    await assistantActions.interrupt({ trigger: "remove_key", ...scope });
    useAssistantStore.setState({ panelOpen: false });
  },

  /**
   * Clear one scenario's conversation. Key, preferences and other scenarios survive.
   *
   * `retryOfOperationId` is the tombstone the user is retrying FROM -- the identity the
   * Settings notice was rendered from. It is unioned into the predecessor set captured
   * here so a success retires the notice the user acted on, and only that one. A retry
   * cannot widen scope: the scenario comes from the caller's captured identity, never
   * from the current selection.
   */
  async clearHistory(
    scope: {
      threadId: string | null;
      scenarioId: string;
    },
    options: { retryOfOperationId?: string | null } = {},
  ): Promise<ClearActionResult> {
    return runClearAction({
      scope: "history",
      threadId: scope.threadId,
      scenarioId: scope.scenarioId,
      retryOfOperationId: options.retryOfOperationId,
    });
  },

  /** Clear every local AI setting, credential and conversation. Scenario/roster survive. */
  async clearAll(
    scope: { threadId: string | null; scenarioId: string | null } = {
      threadId: null,
      scenarioId: null,
    },
  ): Promise<ClearActionResult> {
    // Synchronously, before the first await: a probe still in flight must not be able
    // to write the captured credential back into a row this clear is about to delete.
    revokeProbeOperations();
    const facts = await runClearAction({
      scope: "all",
      threadId: scope.threadId,
      scenarioId: scope.scenarioId,
    });
    if (facts.status === "deleted") resetLifecycleLog();
    return facts;
  },

  /**
   * Claim the next turn epoch and publish the claim as live PREPARING work.
   *
   * Callers must use the returned value and never re-read it: the point of the claim
   * is to hold one epoch across the whole preparation, and a later read would follow
   * whatever superseded it.
   */
  nextTurnEpoch(): number {
    const turnEpoch = useAssistantStore.getState().turnEpoch + 1;
    useAssistantStore.setState({
      turnEpoch,
      authorizedTurnEpoch: null,
      preparingTurnEpoch: turnEpoch,
    });
    return turnEpoch;
  },

  /**
   * Give up a claimed epoch whose send was refused before it ever ran.
   *
   * Scoped to the claim: an interruption or a newer claim has already replaced
   * `preparingTurnEpoch`, and clearing that one here would forget work that is still
   * live.
   */
  abandonPreparing(turnEpoch: number): void {
    useAssistantStore.setState((state) =>
      state.preparingTurnEpoch === turnEpoch ? { preparingTurnEpoch: null } : {},
    );
  },

  /** Authorise the turn that is about to run under `turnEpoch`. */
  beginTurn(turnId: string, turnEpoch: number): void {
    useAssistantStore.setState({
      activeTurnId: turnId,
      authorizedTurnEpoch: turnEpoch,
      preparingTurnEpoch: null,
      streaming: true,
      lastSettlement: null,
      lastRefusal: null,
    });
  },

  /**
   * Settle a turn that ended on its own -- completion or transport failure.
   *
   * `turnId` makes this STRICT compare-and-clear: the caller must be the turn the
   * store currently calls active, and `null` is not a match.
   *
   * A turn whose cleanup runs after a newer turn became the live one must not blank
   * that newer turn's activity, epoch or streaming flag. Treating a `null` active id
   * as "nobody owns it, go ahead" reopened exactly that gap: an already-settled turn
   * would publish its ending into the cleared gap, so the last settlement a user saw
   * belonged to a turn that finished long ago.
   */
  endTurn(settlement: AssistantSettlement, turnId?: string): void {
    if (turnId !== undefined && useAssistantStore.getState().activeTurnId !== turnId) return;
    useAssistantStore.setState({
      activeTurnId: null,
      authorizedTurnEpoch: null,
      preparingTurnEpoch: null,
      streaming: false,
      lastSettlement: settlement === "completed" ? null : { trigger: null, settlement },
    });
  },

  refuse(reason: SendRefusal): void {
    useAssistantStore.setState({ lastRefusal: reason });
  },

  /**
   * Publish the host Preview for a proposal the current turn just prepared.
   *
   * Stamped with the turn epoch that authorised it, so a later interruption or
   * takeover makes the card truthfully unavailable rather than silently still live.
   */
  showProposal(proposalId: string, turnEpoch: number): void {
    useAssistantStore.setState({ activeProposal: { proposalId, turnEpoch } });
  },

  /** Dismiss the live Preview — Cancel, or a change that has been applied. */
  clearProposal(): void {
    useAssistantStore.setState({ activeProposal: null });
  },

  /**
   * Publish the current state of a diagnostic search (T10).
   *
   * Called on every durable write the search makes, so the card follows a running
   * search live. Stamped with the authorising turn epoch for the same reason
   * `showProposal` is: after an interruption the card must say the search was
   * stopped, not keep animating as though it were still running.
   */
  publishDiagnostic(search: DiagnosticSearchRecordV1, turnEpoch: number): void {
    useAssistantStore.setState({ activeDiagnostic: { search, turnEpoch } });
  },

  /** Dismiss the diagnostic card. */
  clearDiagnostic(): void {
    useAssistantStore.setState({ activeDiagnostic: null });
  },

  /** Show the host confirm card for an optimiser run the current turn asked for. */
  showRunRequest(turnEpoch: number): void {
    useAssistantStore.setState({ activeRunRequest: { turnEpoch } });
  },

  /** Dismiss the run card: Run was pressed, or the user said not now. */
  clearRunRequest(): void {
    useAssistantStore.setState({ activeRunRequest: null });
  },

  /**
   * Show the swap card for the change the current turn prepared, replacing any earlier
   * one. Refused (false) while an Apply on the current card is still running.
   */
  showRosterChange(
    change: {
      request: RosterChangeRequest | null;
      view: RosterChangeView;
      linked?: LinkedScheduleChange | null;
    },
    turnEpoch: number,
  ): boolean {
    const { activeRosterChange: previous, rosterChangeApplying } = useAssistantStore.getState();
    if (rosterChangeApplying) return false;
    useAssistantStore.setState({
      activeRosterChange: {
        ...change,
        linked: change.linked ?? null,
        id: (previous?.id ?? 0) + 1,
        turnEpoch,
      },
    });
    return true;
  },

  /** Dismiss the swap card: Apply was pressed, or the user said not now. */
  clearRosterChange(): void {
    useAssistantStore.setState({ activeRosterChange: null });
  },

  setRosterChangeApplying(applying: boolean): void {
    useAssistantStore.setState({ rosterChangeApplying: applying });
  },

  setRosterChangeNotice(notice: string | null): void {
    useAssistantStore.setState({ rosterChangeNotice: notice });
  },

  /** Show the option card for `offer_choices`, replacing any earlier one. */
  showChoices(offer: ChoiceOffer, turnEpoch: number): void {
    const previous = useAssistantStore.getState().activeChoices;
    useAssistantStore.setState({
      activeChoices: { ...offer, id: (previous?.id ?? 0) + 1, turnEpoch },
    });
  },

  /** Close the option card: the user sent something. */
  clearChoices(): void {
    useAssistantStore.setState({ activeChoices: null });
  },

  /** Test seam: return the store to its never-hydrated state. */
  resetForTest(): void {
    useAssistantStore.setState({ ...INITIAL });
    chain = Promise.resolve();
    settlementWindow = realSettlementWindow;
    setActiveRunHandle(null);
    resetProbeAuthorityForTest();
  },
} as const;

/**
 * Whether this turn left a card waiting for the user -- the option card or the run card.
 *
 * Such a card IS the turn's reply: its answer arrives as the user's next message, so a
 * turn that ends on it with no text has not failed. Read from the card actually shown,
 * not the tool called: a tool that refused and showed nothing gave the user nothing.
 */
export function turnAwaitsUserOnCard(turnEpoch: number): boolean {
  const { activeChoices, activeRunRequest, activeRosterChange } = useAssistantStore.getState();
  return (
    activeChoices?.turnEpoch === turnEpoch ||
    activeRunRequest?.turnEpoch === turnEpoch ||
    activeRosterChange?.turnEpoch === turnEpoch
  );
}
