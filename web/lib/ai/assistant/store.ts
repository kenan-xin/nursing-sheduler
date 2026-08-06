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
import { beginClear, finishClear, resumePendingClears } from "./clear-repo";
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
  interrupt,
  realSettlementWindow,
  type InterruptionDeps,
  type InterruptionRequest,
  type InterruptionResult,
} from "./interruption";
import {
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
   * Interruptions requested but not yet settled, incremented SYNCHRONOUSLY at the
   * request.
   *
   * The controller's own work starts a microtask later (it is serialised, and the
   * clear triggers fence durably before closing the gate), so `interruption` alone
   * would be null for a closure that has already been asked for. Counting requests
   * is what lets a send refuse in the same tick the user pressed the control.
   */
  pendingInterruptions: number;
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
  pendingInterruptions: 0,
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
  // T10's real cancellation ownership replaces the no-op default (T05 shipped the
  // contract and a stub). Installed at bring-up rather than at panel mount: an
  // interruption trigger — a takeover, a scenario switch, Clear — must be able to
  // cancel a running diagnostic even if the panel was closed while it ran.
  installDiagnosticCanceller();
  await resumePendingClears();
  await detachStaleTurns();
  const settings = await readAssistantSettings();
  useAssistantStore.setState({ settings, hydrated: true });
  // The runtime instance id is deliberately NOT probed here. `/info` is same-origin
  // and keyless, but it is still a request an off-by-default feature must not make on
  // an ordinary page load -- so it is read lazily on the first explicit send, where it
  // is also the first moment anything needs it.
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

async function runInterruption(request: InterruptionRequest): Promise<InterruptionResult> {
  let result: InterruptionResult;
  try {
    result = await interrupt(request, {
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
          // The instance the runtime reported at handshake. Unknown (`null`) omits the
          // header, and an unknown instance detaches rather than being guessed at.
          runtimeInstanceId: peekRuntimeInstanceId(),
          signal,
        }),
      cancelDiagnostics: (input) => readDiagnosticCanceller().cancelOwnedJobs(input),
      beginClear: (scope, scenarioId) => beginClear(scope, scenarioId),
      finishClear: (fence) => finishClear(fence),
      settlementWindow: (ms, signal) => settlementWindow(ms, signal),
    });
  } catch (error) {
    // A storage failure is not an expected condition, so it keeps propagating -- but
    // the slot must be released either way, or the gate would stay shut forever.
    releaseInterruptionSlot(null);
    throw error;
  }

  releaseInterruptionSlot(result);
  return result;
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
    // Counted SYNCHRONOUSLY, before anything is queued. The controller's own closure
    // is one microtask away at best (and, for the clear triggers, a durable fence
    // away), so this is what makes "an interruption has been asked for" true to every
    // gate in the same tick the user asked for it.
    useAssistantStore.setState((state) => ({
      pendingInterruptions: state.pendingInterruptions + 1,
      // An interruption already in progress keeps its own phase: it is the truthful
      // thing to show, and the queued one publishes its own when it starts.
      interruption: state.interruption ?? { trigger: request.trigger, phase: "closing" },
    }));
    const next = chain.then(() => runInterruption(request));
    chain = next.catch(() => {});
    return next;
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

  /** Clear one scenario's conversation. Key, preferences and other scenarios survive. */
  async clearHistory(scope: {
    threadId: string | null;
    scenarioId: string;
  }): Promise<InterruptionResult> {
    return assistantActions.interrupt({ trigger: "clear_history", ...scope });
  },

  /** Clear every local AI setting, credential and conversation. Scenario/roster survive. */
  async clearAll(
    scope: { threadId: string | null; scenarioId: string | null } = {
      threadId: null,
      scenarioId: null,
    },
  ): Promise<InterruptionResult> {
    revokeProbeOperations();
    const result = await assistantActions.interrupt({ trigger: "clear_all", ...scope });
    // The configuration row is gone, so the projection must agree immediately rather
    // than waiting for the next hydration to notice.
    useAssistantStore.setState({
      settings: emptyAssistantSettings(new Date()),
      panelOpen: false,
      lastRefusal: null,
    });
    resetLifecycleLog();
    return result;
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

  /** Settle a turn that ended on its own -- completion or transport failure. */
  endTurn(settlement: AssistantSettlement): void {
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

  /** Test seam: return the store to its never-hydrated state. */
  resetForTest(): void {
    useAssistantStore.setState({ ...INITIAL });
    chain = Promise.resolve();
    settlementWindow = realSettlementWindow;
    setActiveRunHandle(null);
    resetProbeAuthorityForTest();
  },
} as const;
