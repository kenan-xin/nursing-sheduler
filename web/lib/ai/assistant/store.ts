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
import { readDiagnosticCanceller } from "./diagnostic-cancellation";
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
  activeTurnId: string | null;
  streaming: boolean;
  interruption: ActiveInterruption | null;
  lastSettlement: LastSettlement | null;
  /** The most recent refused send, so the panel can explain the refusal. */
  lastRefusal: SendRefusal | null;
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
  activeTurnId: null,
  streaming: false,
  interruption: null,
  lastSettlement: null,
  lastRefusal: null,
};

export const useAssistantStore = create<AssistantUiState>()(() => ({ ...INITIAL }));

/** Whether every gate for a live assistant surface is currently satisfied. */
export function selectReady(state: AssistantUiState): boolean {
  return state.hydrated && isAssistantReady(state.settings);
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
    interruption: { trigger, phase: "closing" },
    lastRefusal: null,
  });
  return turnEpoch;
}

async function runInterruption(request: InterruptionRequest): Promise<InterruptionResult> {
  const result = await interrupt(request, {
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

  useAssistantStore.setState({
    interruption: null,
    lastSettlement: { trigger: result.trigger, settlement: result.settlement },
    activeTurnId: null,
    streaming: false,
    authorizedTurnEpoch: null,
  });
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
  ): Promise<void> {
    await assistantActions.interrupt({ trigger: "replace_configuration", ...scope });
    const settings = await activateProbedConfiguration(draft);
    useAssistantStore.setState({ settings });
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

  /** Claim the next turn epoch. Callers must use the returned value, not read it. */
  nextTurnEpoch(): number {
    const turnEpoch = useAssistantStore.getState().turnEpoch + 1;
    useAssistantStore.setState({ turnEpoch, authorizedTurnEpoch: null });
    return turnEpoch;
  },

  /** Authorise the turn that is about to run under `turnEpoch`. */
  beginTurn(turnId: string, turnEpoch: number): void {
    useAssistantStore.setState({
      activeTurnId: turnId,
      authorizedTurnEpoch: turnEpoch,
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
      streaming: false,
      lastSettlement: settlement === "completed" ? null : { trigger: null, settlement },
    });
  },

  refuse(reason: SendRefusal): void {
    useAssistantStore.setState({ lastRefusal: reason });
  },

  /** Test seam: return the store to its never-hydrated state. */
  resetForTest(): void {
    useAssistantStore.setState({ ...INITIAL });
    chain = Promise.resolve();
    settlementWindow = realSettlementWindow;
    setActiveRunHandle(null);
  },
} as const;
